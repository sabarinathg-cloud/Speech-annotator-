# Multi-Person Activity Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let global admins filter the People Activity report and CSV export to any selected group of users while keeping an empty selection equivalent to all active users.

**Architecture:** Preserve the existing cross-organization aggregation and make `user_id` a repeatable FastAPI query parameter. Pass a deduplicated ID list through the metrics service, serialize the same list from the frontend API client, and replace the single select with a focused accessible checkbox picker on the existing report page.

**Tech Stack:** FastAPI, SQLAlchemy 2, Pydantic, Next.js, React 19, TypeScript, Tailwind CSS, pytest, Vitest, Testing Library.

---

## File Map

- Modify `apps/backend/tests/test_metrics_and_pii_labels.py`: cover multi-user JSON filtering, unknown IDs, deduplication, all-user behavior, and CSV filtering.
- Modify `apps/backend/app/routers/metrics.py`: parse repeated `user_id` values for JSON and CSV routes.
- Modify `apps/backend/app/services/metrics_service.py`: validate and filter a list of selected user IDs.
- Modify `apps/frontend/__tests__/api.test.ts`: verify repeated query serialization for report and export.
- Modify `apps/frontend/lib/api.ts`: accept `userIds` arrays and append repeated `user_id` values.
- Modify `apps/frontend/__tests__/people-activity.test.tsx`: cover multi-selection, search, clear, apply, and export behavior.
- Create `apps/frontend/components/people-multi-select.tsx`: own the accessible searchable checkbox picker behavior.
- Modify `apps/frontend/app/(dashboard)/admin/people-activity/page.tsx`: store staged/applied ID arrays and use the new picker.

### Task 1: Backend Multi-User Filtering

**Files:**
- Test: `apps/backend/tests/test_metrics_and_pii_labels.py`
- Modify: `apps/backend/app/routers/metrics.py`
- Modify: `apps/backend/app/services/metrics_service.py`

- [ ] **Step 1: Write failing JSON API tests**

Add a test that requests two explicit users with repeated parameters and asserts both are returned once:

```python
response = client.get(
    "/api/v1/metrics/people-activity",
    headers=auth_headers["admin"],
    params=[
        ("user_id", seed_users["annotator"].id),
        ("user_id", seed_users["reviewer"].id),
        ("user_id", seed_users["annotator"].id),
        ("date_from", "2026-08-05"),
        ("date_to", "2026-08-11"),
    ],
)
assert response.status_code == 200
returned_ids = [item["user_id"] for item in response.json()["items"]]
assert len(returned_ids) == 2
assert set(returned_ids) == {
    seed_users["annotator"].id,
    seed_users["reviewer"].id,
}
```

Add a request containing one valid ID and `00000000-0000-0000-0000-000000000099`, then assert `404` and `{"detail": "One or more users were not found"}`. Keep the existing no-filter and single-user assertions as compatibility coverage.

- [ ] **Step 2: Run the focused backend test and verify RED**

Run:

```bash
cd apps/backend
PYTHONPATH=$PWD .venv2/bin/python -m pytest tests/test_metrics_and_pii_labels.py -q
```

Expected: the new multi-user assertion fails because the route and service currently retain only one `user_id`.

- [ ] **Step 3: Parse repeated query values in both routes**

Change both route parameters and service calls in `apps/backend/app/routers/metrics.py`:

```python
def get_people_activity(
    user_id: list[str] | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return MetricsService(db).get_people_activity(
            user_ids=user_id,
            date_from=date_from,
            date_to=date_to,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc
```

Apply the same `list[str] | None` parameter and `user_ids=user_id` call to `export_people_activity`.

- [ ] **Step 4: Validate and filter selected IDs in the service**

Change `get_people_activity` in `apps/backend/app/services/metrics_service.py` to accept `user_ids` and deduplicate without losing caller intent:

```python
requested_user_ids = list(dict.fromkeys(user_ids or []))
user_query = select(User).order_by(User.full_name.asc(), User.email.asc())
if requested_user_ids:
    user_query = user_query.where(User.id.in_(requested_user_ids))
else:
    user_query = user_query.where(User.is_active.is_(True))
users = list(self.db.execute(user_query).scalars().all())
if requested_user_ids and len(users) != len(requested_user_ids):
    raise ServiceError("One or more users were not found", status_code=404)
```

Keep all aggregation and calculation code unchanged after `selected_user_ids` is built from `users`.

- [ ] **Step 5: Run backend tests and verify GREEN**

Run the command from Step 2. Expected: all tests in `test_metrics_and_pii_labels.py` pass.

- [ ] **Step 6: Commit the backend change**

```bash
git add apps/backend/tests/test_metrics_and_pii_labels.py apps/backend/app/routers/metrics.py apps/backend/app/services/metrics_service.py
git commit -m "Support multi-user activity filtering"
```

### Task 2: API Client Array Serialization

**Files:**
- Test: `apps/frontend/__tests__/api.test.ts`
- Modify: `apps/frontend/lib/api.ts`

- [ ] **Step 1: Write failing API client tests**

Add tests that invoke both clients with two IDs:

```typescript
await fetchPeopleActivity("admin-token", {
  userIds: ["user-1", "user-2"],
  dateFrom: "2026-08-05",
  dateTo: "2026-08-11",
});

const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
expect(url.searchParams.getAll("user_id")).toEqual(["user-1", "user-2"]);
```

Repeat for `exportPeopleActivity`. Add an empty-array call and assert `getAll("user_id")` is empty.

- [ ] **Step 2: Run the API tests and verify RED**

Run:

```bash
cd apps/frontend
npm test -- __tests__/api.test.ts
```

Expected: TypeScript or assertions fail because the clients accept only `userId`.

- [ ] **Step 3: Update the API client contract**

Change both client parameter types to use `userIds?: string[] | null`, and update the shared query helper:

```typescript
function peopleActivityQuery(params: {
  userIds?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}): URLSearchParams {
  const query = new URLSearchParams();
  for (const userId of params.userIds ?? []) {
    if (userId) query.append("user_id", userId);
  }
  if (params.dateFrom) query.set("date_from", params.dateFrom);
  if (params.dateTo) query.set("date_to", params.dateTo);
  return query;
}
```

Do not add a new shared response type because the response schema is unchanged.

- [ ] **Step 4: Run API tests and verify GREEN**

Run the command from Step 2. Expected: all API tests pass.

- [ ] **Step 5: Commit the client change**

```bash
git add apps/frontend/__tests__/api.test.ts apps/frontend/lib/api.ts
git commit -m "Serialize multi-user activity filters"
```

### Task 3: Searchable People Picker And Report Integration

**Files:**
- Create: `apps/frontend/components/people-multi-select.tsx`
- Test: `apps/frontend/__tests__/people-activity.test.tsx`
- Modify: `apps/frontend/app/(dashboard)/admin/people-activity/page.tsx`

- [ ] **Step 1: Write failing page interaction tests**

Expand the user fixture with `user-2`. Test this flow:

```typescript
fireEvent.click(screen.getByRole("button", { name: "Choose people" }));
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
expect(screen.getByRole("button", { name: "2 people selected" })).toBeInTheDocument();
```

Also test that search hides nonmatching options without another report request, `Clear` leaves no checked users, Apply sends `userIds: []`, and export receives the currently applied IDs.

- [ ] **Step 2: Run the page test and verify RED**

Run:

```bash
cd apps/frontend
npm test -- __tests__/people-activity.test.tsx
```

Expected: the chooser button and checkboxes are absent.

- [ ] **Step 3: Create the focused picker component**

Create `PeopleMultiSelect` with this public interface:

```typescript
interface PeopleMultiSelectOption {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface PeopleMultiSelectProps {
  options: PeopleMultiSelectOption[];
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
}
```

Use a button with `aria-haspopup="listbox"` and `aria-expanded`, a dropdown panel with a labeled search input, and a checkbox row for every filtered option. Keep option order stable. `Select all` selects all available users, `Clear` emits `[]`, Escape closes the panel, and a document pointer listener closes it on outside interaction. The summary button text is `All people`, the selected person's name, or `<N> people selected`.

- [ ] **Step 4: Integrate staged and applied arrays**

Change `ActivityFilters` in the page:

```typescript
interface ActivityFilters {
  userIds: string[];
  dateFrom: string;
  dateTo: string;
}
```

Initialize `userIds: []`, replace the native select with `PeopleMultiSelect`, and pass `appliedFilters.userIds` unchanged to `fetchPeopleActivity` and `exportPeopleActivity`. Preserve the existing Apply and date validation behavior.

- [ ] **Step 5: Run focused frontend tests and verify GREEN**

Run:

```bash
cd apps/frontend
npm test -- __tests__/people-activity.test.tsx __tests__/api.test.ts
```

Expected: both test files pass.

- [ ] **Step 6: Commit the picker and page integration**

```bash
git add apps/frontend/components/people-multi-select.tsx apps/frontend/app/'(dashboard)'/admin/people-activity/page.tsx apps/frontend/__tests__/people-activity.test.tsx
git commit -m "Add multi-person activity picker"
```

### Task 4: Regression Verification

**Files:**
- Verify all files changed in Tasks 1-3.

- [ ] **Step 1: Run the complete backend suite**

```bash
cd apps/backend
PYTHONPATH=$PWD .venv2/bin/python -m pytest -q
```

Expected: all backend tests pass, with only existing documented skips.

- [ ] **Step 2: Run the complete frontend suite**

```bash
cd apps/frontend
npm test
```

Expected: all frontend tests pass.

- [ ] **Step 3: Run the production frontend build**

```bash
cd apps/frontend
npm run build
```

Expected: Next.js production build completes successfully.

- [ ] **Step 4: Inspect the final diff**

```bash
git diff HEAD~3 --check
git status --short
```

Expected: no whitespace errors and no unexpected generated files.

- [ ] **Step 5: Push the completed branch**

```bash
git push sabarinathg-cloud codex/hiring-assessment-module
```

Expected: remote branch advances to the final implementation commit.
