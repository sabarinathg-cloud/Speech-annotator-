# Multi-Person Activity Filter

## Goal

Allow global admins to select any combination of users on the People Activity report and view only those users' cross-organization statistics. Show both complete selected-range totals and a daily breakdown for every selected person and the selected team. An empty selection continues to mean all active users.

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

## Daily Layout Approaches

### 1. Grouped daily table (selected)

Render each date with one combined team row followed by one row for every selected person. This remains compact, exposes exact values, and scales better than a separate visualization per user.

### 2. Separate chart per person

Charts make trends easy to scan for one or two users but become tall and difficult to compare when several people are selected.

### 3. Calendar heatmap

A heatmap is useful for spotting active and inactive days but cannot clearly communicate active time, idle time, average time per segment, efficiency, and focus together.

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
- Selected-range cards show authoritative combined totals for the selected team.
- The existing per-person table continues to show each person's totals for the complete selected range.
- A grouped daily table shows one combined team row and one row per selected person for every date in the range.
- Daily rows include active time, task-linked active time, idle time, completed segments, average active time per segment, efficiency, focus rate, and last activity.
- Dates with no tracked activity or completions remain visible with zero values.

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

The response adds:

- `overall`: a `PeopleActivitySummary` for all selected people over the complete range.
- `daily`: one combined team summary for every date in the inclusive range.
- `items[].daily`: one summary per date for that user.

The activity and completion formulas remain unchanged. Their SQL queries use the selected user IDs in the existing `IN` filters and add UTC calendar-date grouping for daily results.

For each daily or range summary:

- `active_seconds`, `task_active_seconds`, `idle_seconds`, and `completed_segments` are raw sums for that scope.
- `total_tracked_seconds` is active plus idle seconds.
- `average_active_seconds_per_segment` is task-active seconds divided by completed segments.
- `efficiency_segments_per_active_hour` is completed segments divided by task-active hours.
- `focus_rate` is task-active seconds divided by active seconds.
- Derived values are null when their denominator is zero.

Combined team values are derived from combined raw sums. The backend must not average per-user averages, efficiencies, or focus rates.

Activity is assigned to the UTC date of `UserActivityEntry.started_at`. Heartbeats are short intervals, so this preserves the existing reporting boundary without splitting rows. For completions, select the earliest qualifying terminal transition for each task and user inside the requested range, then assign that completion to its UTC date. This guarantees that daily completed-segment counts add up to the selected-range completed total even when a task has repeated terminal transitions.

## Frontend Data Flow

Store staged and applied filters as arrays of user IDs. The API client appends each selected ID to `URLSearchParams` with the existing `user_id` key. Empty arrays omit the parameter.

Both report loading and CSV export receive the applied user ID array. User search affects only the dropdown's visible options and never the report request.

The frontend renders selected-range cards directly from the response `overall` summary. It renders the daily table from `daily` and `items[].daily`; it does not recalculate authoritative derived metrics in the browser.

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
- Range totals are derived from combined raw values rather than averaged user metrics.
- Daily summaries assign activity and completions to the correct inclusive UTC date.
- Every date in the requested range is returned, including zero-activity days.
- Daily completion counts remain deduplicated.

Frontend tests cover:

- Multiple people can be checked and applied.
- Empty selection sends no user IDs and means all people.
- Search filters dropdown options without requesting a report.
- Clear restores all-people behavior.
- CSV export receives the same applied IDs as the report.
- The closed control displays the correct selection summary.
- Selected-range cards use the backend combined summary.
- Daily dates show a combined team row and one row per selected person.
- Zero-activity dates remain visible.

## CSV Export

Keep the existing columns and add a `report_date` column. Emit these scopes:

- `range_total`: one combined row for all selected people over the complete range.
- `overall`: the existing complete-range row per selected person.
- `organization`: the existing per-person organization rows.
- `daily_team`: one combined row per date.
- `daily_person`: one row per selected person per date.

For combined team rows, user identity columns are empty and the scope identifies the aggregation. CSV calculations use the same backend summaries as the JSON response.

## Migration And Compatibility

No database migration is required. Existing activity records, organization breakdowns, calculations, and CSV columns are retained; `report_date` is the only additive CSV column. Existing callers that send one `user_id` continue to work.
