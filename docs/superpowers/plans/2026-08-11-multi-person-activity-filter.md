# Multi-Person Activity Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let global admins select multiple people, see authoritative selected-range and per-day productivity totals for the team and each person, and export the same filtered data.

**Architecture:** Extend the existing cross-organization People Activity endpoint with repeated `user_id` query parameters and backend-generated range/daily summaries. Keep aggregation in `MetricsService`, mirror the response in shared types, and replace the native single select with a focused accessible multi-person picker on the existing page.

**Tech Stack:** FastAPI, SQLAlchemy 2, Pydantic, PostgreSQL/SQLite tests, Next.js 15, React 19, TypeScript, Tailwind CSS, pytest, Vitest, Testing Library.

---

## File Map

- Modify `apps/backend/app/schemas/metrics.py`: add dated summary fields and combined report totals.
- Modify `apps/backend/app/services/metrics_service.py`: select multiple users, aggregate by UTC date, deduplicate completions, and derive team totals.
- Modify `apps/backend/app/routers/metrics.py`: parse repeated IDs and add team/daily CSV rows.
- Modify `apps/backend/tests/test_metrics_and_pii_labels.py`: verify filtering, zero days, daily attribution, deduplication, and export.
- Modify `packages/shared-types/src/index.ts`: mirror the expanded People Activity response.
- Modify `apps/frontend/lib/api.ts`: append repeated user IDs for JSON and CSV requests.
- Modify `apps/frontend/__tests__/api.test.ts`: verify repeated parameters and all-people omission.
- Create `apps/frontend/components/people-multi-select.tsx`: own searchable checkbox selection and accessibility behavior.
- Modify `apps/frontend/app/(dashboard)/admin/people-activity/page.tsx`: use staged multi-selection and render backend totals/daily rows.
- Modify `apps/frontend/__tests__/people-activity.test.tsx`: verify selection, filtering, daily totals, zero days, and export parity.

### Task 1: Backend Multi-User Contract

**Files:**
- Test: `apps/backend/tests/test_metrics_and_pii_labels.py`
- Modify: `apps/backend/app/routers/metrics.py:71-102`
- Modify: `apps/backend/app/services/metrics_service.py:390-412`

- [ ] **Step 1: Write failing tests for multiple, duplicate, and unknown user IDs**

Add a test that requests two repeated query parameters and checks exact users:

```python
response = client.get(
    "/api/v1/metrics/people-activity",
    headers=auth_headers["admin"],
    params=[
        ("user_id", seed_users["annotator"].id),
        ("user_id", seed_users["reviewer"].id),
        ("date_from", "2026-08-05"),
        ("date_to", "2026-08-11"),
    ],
)
assert response.status_code == 200
assert {item["user_id"] for item in response.json()["items"]} == {
    seed_users["annotator"].id,
    seed_users["reviewer"].id,
}
```

Request the annotator ID twice and assert one row. Request one valid ID plus `missing-user` and assert `404` with `User not found: missing-user`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd apps/backend
PYTHONPATH=$PWD .venv2/bin/python -m pytest tests/test_metrics_and_pii_labels.py -k "people_activity" -q
```

Expected: the repeated-ID test fails because the route and service accept only one string.

- [ ] **Step 3: Parse repeated IDs and validate them in the service**

Change both route parameters to:

```python
user_id: list[str] | None = Query(default=None),
```

Pass `user_ids=user_id` to the service. Change the service signature to:

```python
def get_people_activity(
    self,
    *,
    user_ids: list[str] | None,
    date_from: date | None,
    date_to: date | None,
) -> PeopleActivityResponse:
```

Resolve users with deterministic deduplication and complete validation:

```python
requested_user_ids = list(dict.fromkeys(user_ids or []))
user_query = select(User).order_by(User.full_name.asc(), User.email.asc())
if requested_user_ids:
    user_query = user_query.where(User.id.in_(requested_user_ids))
else:
    user_query = user_query.where(User.is_active.is_(True))
users = list(self.db.execute(user_query).scalars().all())
found_ids = {user.id for user in users}
missing_ids = [user_id for user_id in requested_user_ids if user_id not in found_ids]
if missing_ids:
    raise ServiceError(f"User not found: {missing_ids[0]}", status_code=404)
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: all People Activity tests pass.

- [ ] **Step 5: Commit the contract change**

```bash
git add apps/backend/app/routers/metrics.py apps/backend/app/services/metrics_service.py apps/backend/tests/test_metrics_and_pii_labels.py
git commit -m "Support multi-user activity filters"
```

### Task 2: Daily And Selected-Range Aggregation

**Files:**
- Test: `apps/backend/tests/test_metrics_and_pii_labels.py`
- Modify: `apps/backend/app/schemas/metrics.py:197-235`
- Modify: `apps/backend/app/services/metrics_service.py:390-565`

- [ ] **Step 1: Write failing daily aggregation tests**

Create activity entries for two users on two dates, leave one date empty, and add repeated terminal transitions for one task. Assert:

```python
payload = response.json()
assert payload["overall"]["active_seconds"] == 1500
assert payload["overall"]["completed_segments"] == 3
assert [row["date"] for row in payload["daily"]] == [
    "2026-08-09",
    "2026-08-10",
    "2026-08-11",
]
assert payload["daily"][0]["active_seconds"] == 0
assert payload["daily"][0]["completed_segments"] == 0
assert sum(row["completed_segments"] for row in payload["daily"]) == 3
annotator = next(item for item in payload["items"] if item["user_id"] == seed_users["annotator"].id)
assert len(annotator["daily"]) == 3
assert sum(row["completed_segments"] for row in annotator["daily"]) == annotator["overall"]["completed_segments"]
```

Use raw totals that prove `payload["overall"]["efficiency_segments_per_active_hour"]` is derived from combined task-active seconds rather than averaging user efficiencies.

- [ ] **Step 2: Run the daily test and verify RED**

Run:

```bash
cd apps/backend
PYTHONPATH=$PWD .venv2/bin/python -m pytest tests/test_metrics_and_pii_labels.py -k "people_activity" -q
```

Expected: response validation/assertions fail because `overall`, `daily`, and `items[].daily` do not exist.

- [ ] **Step 3: Add dated response schemas**

Add:

```python
class PeopleActivityDaily(PeopleActivitySummary):
    date: date


class PeopleActivityUser(BaseModel):
    user_id: str
    user_name: str
    user_email: str
    role: str
    is_active: bool
    overall: PeopleActivitySummary
    daily: list[PeopleActivityDaily]
    organizations: list[PeopleActivityOrganization]


class PeopleActivityResponse(BaseModel):
    generated_at: datetime
    date_from: date
    date_to: date
    overall: PeopleActivitySummary
    daily: list[PeopleActivityDaily]
    items: list[PeopleActivityUser]
```

Import `PeopleActivityDaily` in `metrics_service.py`.

- [ ] **Step 4: Aggregate activity by user, organization, and UTC date**

Add `func.date(UserActivityEntry.started_at).label("activity_date")` to the activity query and group by that expression. Normalize returned database values with:

```python
def _as_date(value: Any) -> date:
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))
```

Store raw stats by `(user_id, organization_id, activity_date)` and derive organization totals by summing daily raw values.

- [ ] **Step 5: Attribute each completion once to its earliest day**

Build a subquery limited to the selected range:

```python
first_completions = (
    select(
        TaskStatusHistory.changed_by_id.label("user_id"),
        TaskStatusHistory.task_id.label("task_id"),
        func.min(TaskStatusHistory.changed_at).label("first_completed_at"),
    )
    .where(TaskStatusHistory.changed_by_id.in_(selected_user_ids))
    .where(TaskStatusHistory.new_status.in_(terminal_statuses))
    .where(TaskStatusHistory.changed_at >= period_start)
    .where(TaskStatusHistory.changed_at <= period_end)
    .group_by(TaskStatusHistory.changed_by_id, TaskStatusHistory.task_id)
    .subquery()
)
```

Join it to `AnnotationTask`, group by user, organization, and `func.date(first_completions.c.first_completed_at)`, and merge counts into the dated raw stats. This ensures daily completion sums equal range completion totals.

- [ ] **Step 6: Fill zero days and derive user/team summaries**

Create the inclusive dates once:

```python
report_dates = [
    resolved_date_from + timedelta(days=offset)
    for offset in range((resolved_date_to - resolved_date_from).days + 1)
]
```

For every user and date, call `_people_activity_summary` with stored raw stats or an empty dict, wrap it in `PeopleActivityDaily(date=report_date, ...)`, and attach it to the user. Compute response `daily` by summing raw user-day values for each date. Compute response `overall` by summing raw user-range values and deriving ratios once through `_people_activity_summary`.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all People Activity tests pass.

- [ ] **Step 8: Commit daily aggregation**

```bash
git add apps/backend/app/schemas/metrics.py apps/backend/app/services/metrics_service.py apps/backend/tests/test_metrics_and_pii_labels.py
git commit -m "Add daily people activity totals"
```

### Task 3: Filtered Daily CSV Export

**Files:**
- Test: `apps/backend/tests/test_metrics_and_pii_labels.py`
- Modify: `apps/backend/app/routers/metrics.py:89-180`

- [ ] **Step 1: Write a failing CSV scope test**

Request two users and assert the export contains only those users plus team rows:

```python
rows = list(csv.DictReader(io.StringIO(export_response.text)))
assert "report_date" in rows[0]
assert [row["scope"] for row in rows].count("range_total") == 1
assert [row["scope"] for row in rows].count("overall") == 2
assert [row["scope"] for row in rows].count("daily_team") == 3
assert [row["scope"] for row in rows].count("daily_person") == 6
assert {
    row["user_id"] for row in rows if row["scope"] in {"overall", "daily_person"}
} == {seed_users["annotator"].id, seed_users["reviewer"].id}
```

- [ ] **Step 2: Run the CSV test and verify RED**

Run the focused backend command. Expected: the new scopes and `report_date` are absent.

- [ ] **Step 3: Emit authoritative team and daily rows**

Add `report_date` to `fieldnames`. Write `range_total` first with blank user and organization identity, preserve existing `overall` and `organization` rows, then emit `daily_team` and `daily_person` rows. Extend `_people_activity_csv_row` with optional identity arguments so every row is generated from a backend summary object rather than recalculated values.

- [ ] **Step 4: Run focused and full backend tests**

Run:

```bash
cd apps/backend
PYTHONPATH=$PWD .venv2/bin/python -m pytest tests/test_metrics_and_pii_labels.py -q
PYTHONPATH=$PWD .venv2/bin/python -m pytest -q
```

Expected: focused and full backend suites pass.

- [ ] **Step 5: Commit CSV support**

```bash
git add apps/backend/app/routers/metrics.py apps/backend/tests/test_metrics_and_pii_labels.py
git commit -m "Export daily people activity rows"
```

### Task 4: Shared Types And Repeated Query Parameters

**Files:**
- Test: `apps/frontend/__tests__/api.test.ts`
- Modify: `packages/shared-types/src/index.ts:740-772`
- Modify: `apps/frontend/lib/api.ts:828-875`

- [ ] **Step 1: Write a failing API client test**

Call both clients with `userIds: ["user-1", "user-2"]` and assert:

```typescript
expect(url.searchParams.getAll("user_id")).toEqual(["user-1", "user-2"]);
```

Call with `userIds: []` and assert `url.searchParams.has("user_id")` is false.

- [ ] **Step 2: Run the API test and verify RED**

Run:

```bash
cd apps/frontend
npm test -- __tests__/api.test.ts
```

Expected: TypeScript/test failure because the client accepts only `userId`.

- [ ] **Step 3: Expand shared response types**

Add:

```typescript
export interface PeopleActivityDaily extends PeopleActivitySummary {
  date: string;
}

export interface PeopleActivityUser {
  user_id: string;
  user_name: string;
  user_email: string;
  role: Role;
  is_active: boolean;
  overall: PeopleActivitySummary;
  daily: PeopleActivityDaily[];
  organizations: PeopleActivityOrganization[];
}

export interface PeopleActivityResponse {
  generated_at: string;
  date_from: string;
  date_to: string;
  overall: PeopleActivitySummary;
  daily: PeopleActivityDaily[];
  items: PeopleActivityUser[];
}
```

- [ ] **Step 4: Append every selected user ID**

Change JSON/export params to `userIds?: string[] | null` and query construction to:

```typescript
for (const userId of params.userIds ?? []) {
  query.append("user_id", userId);
}
```

- [ ] **Step 5: Run the API test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 6: Commit types and client changes**

```bash
git add packages/shared-types/src/index.ts apps/frontend/lib/api.ts apps/frontend/__tests__/api.test.ts
git commit -m "Send multi-user activity queries"
```

### Task 5: Accessible Multi-Person Picker

**Files:**
- Create: `apps/frontend/components/people-multi-select.tsx`
- Test: `apps/frontend/__tests__/people-activity.test.tsx`
- Modify: `apps/frontend/app/(dashboard)/admin/people-activity/page.tsx:9-235`

- [ ] **Step 1: Expand the frontend fixture and write failing interaction tests**

Add a second user to `fetchUsers`, include both users in the activity response, then assert:

```typescript
fireEvent.click(screen.getByRole("button", { name: "People: All people" }));
fireEvent.change(screen.getByRole("searchbox", { name: "Search people" }), {
  target: { value: "Annotator" },
});
fireEvent.click(screen.getByRole("checkbox", { name: "Annotator One" }));
fireEvent.click(screen.getByRole("checkbox", { name: "Reviewer Two" }));
fireEvent.click(screen.getByRole("button", { name: "Apply" }));
await waitFor(() =>
  expect(fetchPeopleActivity).toHaveBeenLastCalledWith("admin-token", {
    userIds: ["user-1", "user-2"],
    dateFrom: "2026-08-05",
    dateTo: "2026-08-11",
  })
);
expect(screen.getByRole("button", { name: "People: 2 people selected" })).toBeInTheDocument();
```

Also test `Clear` followed by `Apply` sends `userIds: []`, and changing search alone does not call `fetchPeopleActivity`.

- [ ] **Step 2: Run the page test and verify RED**

Run:

```bash
cd apps/frontend
npm test -- __tests__/people-activity.test.tsx
```

Expected: the People button, searchbox, and checkboxes do not exist.

- [ ] **Step 3: Create the focused picker component**

Implement props:

```typescript
interface PeopleMultiSelectProps {
  users: AdminUser[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}
```

Use a button with `aria-haspopup="listbox"`, `aria-expanded`, and summary text. Render a positioned panel with a search input, `Select all`, `Clear`, and checkboxes. Deduplicate selections, preserve user-list ordering, close on Escape/outside click, and keep the panel compact enough for laptop screens.

- [ ] **Step 4: Wire staged arrays into the page**

Change filters to:

```typescript
interface ActivityFilters {
  userIds: string[];
  dateFrom: string;
  dateTo: string;
}
```

Initialize `userIds: []`, replace the native select with `PeopleMultiSelect`, and pass `appliedFilters.userIds` to both `fetchPeopleActivity` and `exportPeopleActivity`. Copy arrays when applying:

```typescript
setAppliedFilters({ ...filters, userIds: [...filters.userIds] });
```

- [ ] **Step 5: Run the page test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 6: Commit the picker**

```bash
git add apps/frontend/components/people-multi-select.tsx 'apps/frontend/app/(dashboard)/admin/people-activity/page.tsx' apps/frontend/__tests__/people-activity.test.tsx
git commit -m "Add multi-person activity picker"
```

### Task 6: Range Totals And Daily Table

**Files:**
- Test: `apps/frontend/__tests__/people-activity.test.tsx`
- Modify: `apps/frontend/app/(dashboard)/admin/people-activity/page.tsx:63-340`

- [ ] **Step 1: Write failing rendering tests for backend totals and daily rows**

Expand the response fixture with `overall`, three `daily` team rows, and three `daily` rows per user. Assert exact combined totals, the empty date, and each person:

```typescript
expect(screen.getByText("Selected range total")).toBeInTheDocument();
expect(screen.getByText("Daily activity")).toBeInTheDocument();
expect(screen.getByRole("row", { name: /Aug 9, 2026 Team total 0s 0s 0s 0/ })).toBeInTheDocument();
expect(screen.getByRole("row", { name: /Aug 10, 2026 Annotator One/ })).toBeInTheDocument();
expect(screen.getByRole("row", { name: /Aug 10, 2026 Reviewer Two/ })).toBeInTheDocument();
```

- [ ] **Step 2: Run the rendering test and verify RED**

Run the focused page test. Expected: range label and daily table are absent.

- [ ] **Step 3: Render authoritative selected-range cards**

Remove client-side summation of metric values. Use `report.overall` for active, task time, idle, completed, average, efficiency, and focus. Keep `report.items.length` as the people count. Use compact cards with stable dimensions and wrap them responsively without oversized vertical spacing.

- [ ] **Step 4: Render the grouped daily table**

For every `report.daily` row, render a visually distinct `Team total` row followed by the matching `item.daily` entry for each selected user. Reuse `MetricCells`, add a date/person label column, and keep horizontal scrolling limited to the table container. Use `date.toLocaleDateString` with a UTC-safe parse (`new Date(`${value}T00:00:00Z`)`).

- [ ] **Step 5: Run focused frontend tests and verify GREEN**

Run:

```bash
cd apps/frontend
npm test -- __tests__/people-activity.test.tsx __tests__/api.test.ts
```

Expected: both files pass.

- [ ] **Step 6: Commit the report UI**

```bash
git add 'apps/frontend/app/(dashboard)/admin/people-activity/page.tsx' apps/frontend/__tests__/people-activity.test.tsx
git commit -m "Show daily people activity statistics"
```

### Task 7: Full Verification

**Files:**
- Verify all files changed in Tasks 1-6.

- [ ] **Step 1: Run backend tests**

```bash
cd apps/backend
PYTHONPATH=$PWD .venv2/bin/python -m pytest -q
```

Expected: all backend tests pass, with only existing documented skips.

- [ ] **Step 2: Run frontend tests**

```bash
cd apps/frontend
npm test
```

Expected: all frontend tests pass.

- [ ] **Step 3: Run the production build**

```bash
cd apps/frontend
npm run build
```

Expected: Next.js production build completes successfully.

- [ ] **Step 4: Review the final diff**

```bash
git diff --check
git status --short
git log --oneline -8
```

Expected: no whitespace errors, only intended files changed, and implementation commits are present.
