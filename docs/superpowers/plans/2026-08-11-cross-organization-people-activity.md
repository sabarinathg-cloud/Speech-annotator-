# Cross-Organization People Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global-admin report that totals each user's tracked work across all organizations for a selected period while preserving an organization breakdown.

**Architecture:** Keep the existing organization-scoped metrics endpoint unchanged. Add a focused SQL aggregation in `MetricsService`, expose JSON and CSV global-admin endpoints without organization resolution, and render a dedicated People Activity page using shared response types.

**Tech Stack:** FastAPI, SQLAlchemy 2, Pydantic, PostgreSQL/SQLite tests, Next.js, React, TypeScript, Tailwind, Vitest, pytest.

---

## File Map

- Modify `apps/backend/app/schemas/metrics.py`: define cross-org report response models.
- Modify `apps/backend/app/services/metrics_service.py`: aggregate activity and completed segments by user and organization.
- Modify `apps/backend/app/routers/metrics.py`: add JSON and CSV admin endpoints.
- Modify `apps/backend/tests/test_metrics_and_pii_labels.py`: verify cross-org totals, breakdowns, deduplication, dates, empty users, and authorization.
- Modify `packages/shared-types/src/index.ts`: mirror report response types.
- Modify `apps/frontend/lib/api.ts`: add global JSON/CSV report clients that omit the organization header.
- Modify `apps/frontend/__tests__/api.test.ts`: verify query strings, authorization, global scope, and blob download.
- Create `apps/frontend/app/(dashboard)/admin/people-activity/page.tsx`: render filters, totals, expandable org detail, and export.
- Modify `apps/frontend/app/(dashboard)/layout.tsx`: add the global-admin navigation entry.
- Create `apps/frontend/__tests__/people-activity.test.tsx`: verify the report behavior.
- Modify `apps/frontend/__tests__/dashboard-layout.test.tsx`: verify admin navigation.

### Task 1: Backend Cross-Organization Aggregation

**Files:**
- Modify: `apps/backend/tests/test_metrics_and_pii_labels.py`
- Modify: `apps/backend/app/schemas/metrics.py`
- Modify: `apps/backend/app/services/metrics_service.py`
- Modify: `apps/backend/app/routers/metrics.py`

- [ ] **Step 1: Write failing API tests for cross-org totals and breakdowns**

Create a second organization and membership, activity rows in both organizations, and terminal status history in both organizations. Assert that:

```python
response = client.get(
    "/api/v1/metrics/people-activity?user_id=" + seed_users["annotator"].id
    + "&date_from=2026-08-05&date_to=2026-08-11",
    headers=auth_headers["admin"],
)
assert response.status_code == 200
item = response.json()["items"][0]
assert item["overall"]["active_seconds"] == 900
assert item["overall"]["task_active_seconds"] == 720
assert item["overall"]["idle_seconds"] == 180
assert item["overall"]["completed_segments"] == 2
assert {row["organization_name"] for row in item["organizations"]} == {
    "Default Organization",
    "Second Organization",
}
```

Add a duplicate terminal transition for one task and assert it is counted once. Add an activity row outside the selected dates and assert it is excluded. Add tests that an existing user with no rows returns zero totals and that annotator access returns `403`.

- [ ] **Step 2: Run the focused backend tests and verify RED**

Run:

```bash
cd apps/backend
PYTHONPATH=$PWD .venv2/bin/python -m pytest tests/test_metrics_and_pii_labels.py -q
```

Expected: new tests fail because `/api/v1/metrics/people-activity` does not exist.

- [ ] **Step 3: Add report schemas**

Add these models to `apps/backend/app/schemas/metrics.py`:

```python
class PeopleActivitySummary(BaseModel):
    active_seconds: int
    task_active_seconds: int
    idle_seconds: int
    total_tracked_seconds: int
    completed_segments: int
    average_active_seconds_per_segment: float | None
    efficiency_segments_per_active_hour: float | None
    focus_rate: float | None
    last_activity_at: datetime | None


class PeopleActivityOrganization(PeopleActivitySummary):
    organization_id: str
    organization_name: str
    organization_slug: str


class PeopleActivityUser(BaseModel):
    user_id: str
    user_name: str
    user_email: str
    role: str
    is_active: bool
    overall: PeopleActivitySummary
    organizations: list[PeopleActivityOrganization]


class PeopleActivityResponse(BaseModel):
    generated_at: datetime
    date_from: date
    date_to: date
    items: list[PeopleActivityUser]
```

- [ ] **Step 4: Implement grouped aggregation in `MetricsService`**

Add `get_people_activity(user_id, date_from, date_to)`. Default the inclusive date range to today minus six days through today, reject reversed dates with `ServiceError(..., 422)`, and reject an unknown selected user with `404`.

Aggregate activity in SQL:

```python
select(
    UserActivityEntry.user_id,
    UserActivityEntry.organization_id,
    func.sum(UserActivityEntry.active_seconds).label("active_seconds"),
    func.sum(UserActivityEntry.idle_seconds).label("idle_seconds"),
    func.sum(case(
        (UserActivityEntry.task_id.is_not(None), UserActivityEntry.active_seconds),
        else_=0,
    )).label("task_active_seconds"),
    func.max(UserActivityEntry.ended_at).label("last_activity_at"),
).where(
    UserActivityEntry.started_at >= period_start,
    UserActivityEntry.started_at <= period_end,
).group_by(UserActivityEntry.user_id, UserActivityEntry.organization_id)
```

Aggregate completions separately using `count(distinct(TaskStatusHistory.task_id))`, grouped by `changed_by_id` and `AnnotationTask.organization_id`, filtered to terminal statuses and the same inclusive period. Merge the grouped rows by `(user_id, organization_id)`, derive overall values by summing breakdown rows, and use one helper to calculate averages, efficiency, and focus rate without zero division.

- [ ] **Step 5: Add the global-admin JSON route**

Add the imports and route to `apps/backend/app/routers/metrics.py`:

```python
@router.get("/people-activity", response_model=PeopleActivityResponse)
def get_people_activity(
    user_id: str | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return MetricsService(db).get_people_activity(
            user_id=user_id,
            date_from=date_from,
            date_to=date_to,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc
```

Do not depend on `get_current_organization` for this route.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

### Task 2: Authoritative CSV Export

**Files:**
- Modify: `apps/backend/tests/test_metrics_and_pii_labels.py`
- Modify: `apps/backend/app/routers/metrics.py`

- [ ] **Step 1: Write a failing CSV export test**

Request:

```python
response = client.get(
    "/api/v1/metrics/people-activity/export?user_id=" + seed_users["annotator"].id
    + "&date_from=2026-08-05&date_to=2026-08-11",
    headers=auth_headers["admin"],
)
assert response.status_code == 200
assert response.headers["content-type"].startswith("text/csv")
assert "attachment" in response.headers["content-disposition"]
rows = list(csv.DictReader(io.StringIO(response.text)))
assert rows[0]["scope"] == "All organizations"
assert {row["organization"] for row in rows[1:]} == {
    "Default Organization",
    "Second Organization",
}
```

- [ ] **Step 2: Run the export test and verify RED**

Expected: `404` because the export route is missing.

- [ ] **Step 3: Implement CSV generation from the JSON report object**

Add `/people-activity/export` before `/people-activity` route matching can become ambiguous. Call `get_people_activity` once, write one overall row and one row per organization using `csv.DictWriter`, and return `StreamingResponse` with filename `people-activity-<date_from>-to-<date_to>.csv`.

CSV columns:

```python
[
    "user_name", "user_email", "role", "scope", "organization",
    "active_hours", "task_active_hours", "idle_hours", "total_tracked_hours",
    "completed_segments", "average_active_minutes_per_segment",
    "efficiency_segments_per_active_hour", "focus_rate", "last_activity_at",
]
```

- [ ] **Step 4: Run the export and full metrics tests**

Run:

```bash
PYTHONPATH=$PWD .venv2/bin/python -m pytest tests/test_metrics_and_pii_labels.py -q
```

Expected: PASS.

### Task 3: Shared Types And Global API Client

**Files:**
- Modify: `packages/shared-types/src/index.ts`
- Modify: `apps/frontend/lib/api.ts`
- Modify: `apps/frontend/__tests__/api.test.ts`

- [ ] **Step 1: Write failing frontend API tests**

Assert `fetchPeopleActivity` calls:

```text
/metrics/people-activity?user_id=annotator-1&date_from=2026-08-05&date_to=2026-08-11
```

Assert the request contains `Authorization` and omits `X-Organization-ID`. Add the equivalent blob assertion for `/metrics/people-activity/export`.

- [ ] **Step 2: Run API tests and verify RED**

Run:

```bash
cd apps/frontend
npm test -- --run __tests__/api.test.ts
```

Expected: import/function failure for the missing API clients.

- [ ] **Step 3: Add shared report interfaces**

Mirror the backend schemas in `packages/shared-types/src/index.ts` using ISO strings for dates and timestamps:

```typescript
export interface PeopleActivitySummary {
  active_seconds: number;
  task_active_seconds: number;
  idle_seconds: number;
  total_tracked_seconds: number;
  completed_segments: number;
  average_active_seconds_per_segment: number | null;
  efficiency_segments_per_active_hour: number | null;
  focus_rate: number | null;
  last_activity_at: string | null;
}
```

Add `PeopleActivityOrganization`, `PeopleActivityUser`, and `PeopleActivityResponse` with the same property names as the Pydantic models.

- [ ] **Step 4: Add organization-header opt-out to request helpers**

Extend internal request options with `globalScope?: boolean`. When true, do not add `X-Organization-ID` in either JSON or blob requests. Preserve current behavior for every existing call.

- [ ] **Step 5: Implement the report clients**

Add:

```typescript
export async function fetchPeopleActivity(token: string, params: PeopleActivityParams) {
  return request<PeopleActivityResponse>(path, {}, token, true, true);
}

export async function exportPeopleActivity(token: string, params: PeopleActivityParams) {
  return requestBlob(path, token, true, true);
}
```

Build query parameters only when values are present.

- [ ] **Step 6: Run API tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 4: People Activity Admin Page

**Files:**
- Create: `apps/frontend/app/(dashboard)/admin/people-activity/page.tsx`
- Create: `apps/frontend/__tests__/people-activity.test.tsx`
- Modify: `apps/frontend/app/(dashboard)/layout.tsx`
- Modify: `apps/frontend/__tests__/dashboard-layout.test.tsx`

- [ ] **Step 1: Write failing page tests**

Mock a response where one person has two organization rows. Verify:

- The default From date is today minus six days and To is today.
- The overall active, idle, total, segments, average, efficiency, and focus values render.
- Organization rows are hidden initially and shown after clicking `Show organizations`.
- Applying a user filter passes the selected user ID.
- Clicking `Export CSV` invokes the blob client and creates a download.
- The admin header contains a `People Activity` link.

- [ ] **Step 2: Run page tests and verify RED**

Run:

```bash
npm test -- --run __tests__/people-activity.test.tsx __tests__/dashboard-layout.test.tsx
```

Expected: page/module or navigation assertion failures.

- [ ] **Step 3: Implement the page**

Use one compact admin workspace card. Place date range, user selector, Apply, and Export CSV in a single responsive toolbar. Render a dense table with columns:

```text
User | Active | Task active | Idle | Total | Segments | Avg / segment | Efficiency | Focus | Last active | Details
```

Use local helpers:

```typescript
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
```

Expanded organization rows appear immediately under their user. Keep the previously loaded report visible while a refresh is in progress and show failures in an alert above it.

- [ ] **Step 4: Add navigation**

Add this admin link after Metrics in `apps/frontend/app/(dashboard)/layout.tsx`:

```typescript
{ href: "/admin/people-activity", label: "People Activity" }
```

- [ ] **Step 5: Run page tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 5: Regression Verification

**Files:**
- No production changes expected.

- [ ] **Step 1: Run backend metrics and authorization tests**

```bash
cd apps/backend
PYTHONPATH=$PWD .venv2/bin/python -m pytest tests/test_metrics_and_pii_labels.py tests/test_organization_isolation.py -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend report, API, layout, and existing metrics tests**

```bash
cd apps/frontend
npm test -- --run __tests__/people-activity.test.tsx __tests__/admin-metrics.test.tsx __tests__/dashboard-layout.test.tsx __tests__/api.test.ts
```

Expected: PASS.

- [ ] **Step 3: Build the frontend**

```bash
npm run build
```

Expected: Next.js production build completes successfully.

- [ ] **Step 4: Review the diff and commit**

```bash
git diff --check
git status --short
git add apps/backend/app/schemas/metrics.py apps/backend/app/services/metrics_service.py apps/backend/app/routers/metrics.py apps/backend/tests/test_metrics_and_pii_labels.py packages/shared-types/src/index.ts apps/frontend/lib/api.ts apps/frontend/app/\(dashboard\)/layout.tsx apps/frontend/app/\(dashboard\)/admin/people-activity/page.tsx apps/frontend/__tests__/api.test.ts apps/frontend/__tests__/people-activity.test.tsx apps/frontend/__tests__/dashboard-layout.test.tsx docs/superpowers/plans/2026-08-11-cross-organization-people-activity.md
git commit -m "Add cross-org people activity report"
```
