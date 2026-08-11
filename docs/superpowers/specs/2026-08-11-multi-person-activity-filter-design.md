# Multi-Person Activity Filter

## Goal

Allow global admins to select any combination of users on the People Activity report and view only those users' cross-organization statistics. An empty selection continues to mean all active users.

## Approaches Considered

### 1. Repeated `user_id` query parameters (selected)

Send one query parameter per selected user:

```text
?user_id=user-1&user_id=user-2
```

FastAPI parses the values as a list, the SQL query filters directly with `IN`, and a single selected value remains backward-compatible with existing clients.

### 2. Comma-separated user IDs

Send `?user_ids=user-1,user-2`. This is compact but requires custom parsing and escaping and introduces a second parameter name for behavior the API already supports.

### 3. Browser-only filtering

Load every user and hide unselected rows in the frontend. This avoids an API change but performs unnecessary cross-organization aggregation and can make the displayed report disagree with the server-generated CSV.

## User Experience

Replace the single-person select on `/admin/people-activity` with a compact searchable checkbox dropdown.

- No checked users means `All people`.
- Admins can select any number of users.
- The closed control shows `All people`, one selected name, or `<N> people selected`.
- The open control provides user search, `Select all`, and `Clear` actions.
- Selected people remain staged until the admin presses `Apply`, matching the existing date-filter behavior.
- Changing staged selections does not clear the currently displayed report.
- CSV export uses the applied selection, not un-applied checkbox changes.
- Summary cards and table rows are calculated only from the returned selected users.

The control must support keyboard navigation, expose its expanded state, and label the checkbox list for assistive technology. Clicking outside or pressing Escape closes it without changing the staged selection.

## Backend API

Update both global-admin endpoints:

- `GET /api/v1/metrics/people-activity`
- `GET /api/v1/metrics/people-activity/export`

Accept `user_id` as a repeated optional query parameter. The service accepts `user_ids: list[str] | None`.

- No IDs: include all active users, preserving current behavior.
- One or more IDs: include exactly those users, including inactive users selected explicitly.
- Deduplicate repeated IDs before querying.
- If any requested ID does not exist, return `404` rather than silently returning an incomplete report.
- Preserve deterministic user ordering by full name and email.

The activity and completion aggregation formulas remain unchanged. Their SQL queries use the selected user IDs in the existing `IN` filters.

## Frontend Data Flow

Store staged and applied filters as arrays of user IDs. The API client appends each selected ID to `URLSearchParams` with the existing `user_id` key. Empty arrays omit the parameter.

Both report loading and CSV export receive the applied user ID array. User search affects only the dropdown's visible options and never the report request.

## Error Handling

- Preserve the current report while a refreshed request fails.
- Keep the existing reversed-date validation.
- Show the existing page-level API error for unknown or unavailable users.
- If the user list refreshes and a previously selected account is no longer returned, retain its ID until the next apply so the backend can report the inconsistency explicitly.

## Tests

Backend tests cover:

- Two requested users return exactly two report items.
- A single repeated-style parameter remains supported.
- No IDs returns all active users.
- Repeated IDs are deduplicated.
- Any unknown requested ID returns `404`.
- CSV export contains only the selected users and their organization rows.

Frontend tests cover:

- Multiple people can be checked and applied.
- Empty selection sends no user IDs and means all people.
- Search filters dropdown options without requesting a report.
- Clear restores all-people behavior.
- CSV export receives the same applied IDs as the report.
- The closed control displays the correct selection summary.

## Migration And Compatibility

No database migration is required. Existing report calculations, activity records, organization breakdowns, and CSV columns remain unchanged. Existing callers that send one `user_id` continue to work.
