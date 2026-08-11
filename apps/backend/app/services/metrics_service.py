import re
import unicodedata
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session, joinedload, load_only, selectinload

from app.models.activity import UserActivityEntry
from app.models.enums import RoleEnum, TaskStatusEnum
from app.models.organization import Organization, OrganizationMembership
from app.models.security import SecurityAuditEvent
from app.models.task import AnnotationTask, TaskAuditLog, TaskStatusHistory, TaskTranscriptVariant
from app.models.user import User
from app.schemas.metrics import (
    ActivityHeartbeatRequest,
    ActivityHeartbeatResponse,
    AdminMetricsResponse,
    MaskingIntervalMetric,
    MaskingMetrics,
    MaskingTaskMetric,
    MetricsFilters,
    MetricsOverview,
    ModelBenchmarkMetric,
    ModelBenchmarkSummary,
    ModelTranscriptMetric,
    PIIMetrics,
    PeopleActivityOrganization,
    PeopleActivityResponse,
    PeopleActivitySummary,
    PeopleActivityUser,
    TaggerMetric,
    TaskSourceErrorMetric,
    UserProductivityMetric,
    WorstTaskMetric,
)
from app.services.errors import ServiceError
from app.services.organization_service import DEFAULT_ORGANIZATION_ID

LOW_CONFIDENCE_THRESHOLD = 0.8
MAX_HEARTBEAT_SECONDS = 300


def _normalize_transcript(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    metric_chars = []
    for char in normalized:
        if char.isalnum():
            metric_chars.append(char)
        elif char.isspace():
            metric_chars.append(" ")
        else:
            metric_chars.append(" ")
    return re.sub(r"\s+", " ", "".join(metric_chars)).strip()


def _word_tokens(text: str) -> list[str]:
    normalized = _normalize_transcript(text)
    return normalized.split() if normalized else []


def _edit_distance(reference: list[Any] | str, hypothesis: list[Any] | str) -> int:
    previous = list(range(len(hypothesis) + 1))
    for row_index, reference_item in enumerate(reference, start=1):
        current = [row_index] + [0] * len(hypothesis)
        for column_index, hypothesis_item in enumerate(hypothesis, start=1):
            substitution_cost = 0 if reference_item == hypothesis_item else 1
            current[column_index] = min(
                previous[column_index] + 1,
                current[column_index - 1] + 1,
                previous[column_index - 1] + substitution_cost,
            )
        previous = current
    return previous[-1]


def _rounded_rate(errors: int, total: int) -> float | None:
    if total <= 0:
        return None
    return round(errors / total, 4)


def _mean_rate(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 4)


def _safe_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _safe_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _overlap_pair_count(annotations: list[dict[str, Any]]) -> int:
    count = 0
    sorted_annotations = sorted(
        annotations,
        key=lambda item: (_safe_int(item.get("start")), _safe_int(item.get("end"))),
    )
    for index, current in enumerate(sorted_annotations):
        current_start = _safe_int(current.get("start"))
        current_end = _safe_int(current.get("end"))
        for candidate in sorted_annotations[index + 1 :]:
            candidate_start = _safe_int(candidate.get("start"))
            candidate_end = _safe_int(candidate.get("end"))
            if candidate_start >= current_end:
                break
            if current_start < candidate_end and candidate_start < current_end:
                count += 1
    return count


def _interval_start(interval: dict[str, Any]) -> float:
    return max(0.0, float(interval.get("start_seconds") or 0.0))


def _interval_end(interval: dict[str, Any]) -> float:
    return max(0.0, float(interval.get("end_seconds") or 0.0))


def _interval_id(interval: dict[str, Any]) -> str | None:
    value = interval.get("id")
    return str(value) if value not in {None, ""} else None


def _sorted_intervals(intervals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(intervals, key=lambda item: (_interval_start(item), _interval_end(item), str(item.get("text") or "")))


def _pair_mask_intervals(
    reference_intervals: list[dict[str, Any]],
    actual_intervals: list[dict[str, Any]],
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    reference_by_id = {_interval_id(item): item for item in reference_intervals if _interval_id(item)}
    actual_by_id = {_interval_id(item): item for item in actual_intervals if _interval_id(item)}
    paired_ids = [item_id for item_id in reference_by_id if item_id in actual_by_id]
    pairs = [(reference_by_id[item_id], actual_by_id[item_id]) for item_id in paired_ids]

    paired_id_set = set(paired_ids)
    unpaired_reference = [item for item in reference_intervals if _interval_id(item) not in paired_id_set]
    unpaired_actual = [item for item in actual_intervals if _interval_id(item) not in paired_id_set]
    pairs.extend(zip(_sorted_intervals(unpaired_reference), _sorted_intervals(unpaired_actual), strict=False))
    return pairs


def _merge_time_ranges(intervals: list[dict[str, Any]]) -> list[tuple[float, float]]:
    ranges = [
        (_interval_start(interval), _interval_end(interval))
        for interval in intervals
        if _interval_end(interval) > _interval_start(interval)
    ]
    if not ranges:
        return []
    ranges.sort()
    merged = [ranges[0]]
    for start, end in ranges[1:]:
        previous_start, previous_end = merged[-1]
        if start <= previous_end:
            merged[-1] = (previous_start, max(previous_end, end))
        else:
            merged.append((start, end))
    return merged


def _uncovered_duration_seconds(
    primary_intervals: list[dict[str, Any]],
    covering_intervals: list[dict[str, Any]],
) -> float:
    covering_ranges = _merge_time_ranges(covering_intervals)
    uncovered = 0.0
    for start, end in _merge_time_ranges(primary_intervals):
        cursor = start
        for cover_start, cover_end in covering_ranges:
            if cover_end <= cursor:
                continue
            if cover_start >= end:
                break
            if cover_start > cursor:
                uncovered += cover_start - cursor
            cursor = max(cursor, cover_end)
            if cursor >= end:
                break
        if cursor < end:
            uncovered += end - cursor
    return uncovered


def _interval_label(interval: dict[str, Any]) -> str:
    labels = interval.get("labels")
    if isinstance(labels, list) and labels:
        return ", ".join(str(label) for label in labels if str(label)) or "PII"
    return "PII"


def _duration_bucket(duration_seconds: Any) -> tuple[str, str]:
    if duration_seconds is None:
        return "unknown", "Unknown duration"
    duration = _safe_float(duration_seconds)
    if duration is None:
        return "unknown", "Unknown duration"
    if duration < 30:
        return "lt_30s", "< 30s"
    if duration < 60:
        return "30_60s", "30s-60s"
    if duration < 180:
        return "60_180s", "1m-3m"
    return "gte_180s", ">= 3m"


def _as_aware_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _minutes_between(start: datetime | None, end: datetime | None) -> float | None:
    start_utc = _as_aware_utc(start)
    end_utc = _as_aware_utc(end)
    if not start_utc or not end_utc or end_utc < start_utc:
        return None
    return round((end_utc - start_utc).total_seconds() / 60, 1)


def _datetime_in_window(value: datetime, start: datetime | None, end: datetime | None) -> bool:
    if start and value < start:
        return False
    if end and value > end:
        return False
    return True


def _new_model_accumulator(
    *,
    source_key: str,
    source_label: str,
    group_key: str,
    group_label: str,
) -> dict[str, Any]:
    return {
        "source_key": source_key,
        "source_label": source_label,
        "group_key": group_key,
        "group_label": group_label,
        "task_ids": set(),
        "word_errors": 0,
        "reference_words": 0,
        "character_errors": 0,
        "reference_characters": 0,
        "wer_values": [],
        "cer_values": [],
    }


def _add_model_error(
    accumulator: dict[str, Any],
    *,
    task_id: str,
    word_errors: int,
    reference_words: int,
    character_errors: int,
    reference_characters: int,
    wer: float | None,
    cer: float | None,
) -> None:
    accumulator["task_ids"].add(task_id)
    accumulator["word_errors"] += word_errors
    accumulator["reference_words"] += reference_words
    accumulator["character_errors"] += character_errors
    accumulator["reference_characters"] += reference_characters
    if wer is not None:
        accumulator["wer_values"].append(wer)
    if cer is not None:
        accumulator["cer_values"].append(cer)


def _model_benchmark_metric(rank: int, accumulator: dict[str, Any]) -> ModelBenchmarkMetric:
    average_wer = _mean_rate(accumulator["wer_values"])
    average_cer = _mean_rate(accumulator["cer_values"])
    return ModelBenchmarkMetric(
        rank=rank,
        source_key=accumulator["source_key"],
        source_label=accumulator["source_label"],
        group_key=accumulator["group_key"],
        group_label=accumulator["group_label"],
        tasks_scored=len(accumulator["task_ids"]),
        word_errors=accumulator["word_errors"],
        reference_words=accumulator["reference_words"],
        character_errors=accumulator["character_errors"],
        reference_characters=accumulator["reference_characters"],
        average_wer=average_wer,
        average_cer=average_cer,
        word_accuracy=round(1 - average_wer, 4) if average_wer is not None else None,
        character_accuracy=round(1 - average_cer, 4) if average_cer is not None else None,
    )


def _rank_model_accumulators(accumulators: list[dict[str, Any]]) -> list[ModelBenchmarkMetric]:
    def sort_rate(value: float | None) -> float:
        return value if value is not None else float("inf")

    ranked = sorted(
        accumulators,
        key=lambda item: (
            sort_rate(_mean_rate(item["wer_values"])),
            sort_rate(_mean_rate(item["cer_values"])),
            item["source_label"].lower(),
        ),
    )
    return [_model_benchmark_metric(index, item) for index, item in enumerate(ranked, start=1)]


def _rank_grouped_model_accumulators(accumulators: list[dict[str, Any]]) -> list[ModelBenchmarkMetric]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in accumulators:
        grouped[item["group_key"]].append(item)

    ranked: list[ModelBenchmarkMetric] = []
    for group_items in grouped.values():
        ranked.extend(_rank_model_accumulators(group_items))
    return sorted(ranked, key=lambda item: (item.group_label, item.rank, item.source_label.lower()))


class MetricsService:
    def __init__(self, db: Session):
        self.db = db

    def record_activity_heartbeat(
        self,
        *,
        payload: ActivityHeartbeatRequest,
        actor: User,
        organization_id: str,
    ) -> ActivityHeartbeatResponse:
        started_at = _as_aware_utc(payload.started_at)
        ended_at = _as_aware_utc(payload.ended_at)
        if not started_at or not ended_at or ended_at <= started_at:
            raise ServiceError("Heartbeat timestamps are invalid", status_code=422)

        active_seconds = max(0, min(payload.active_seconds, MAX_HEARTBEAT_SECONDS))
        idle_seconds = max(0, min(payload.idle_seconds, MAX_HEARTBEAT_SECONDS))
        reported_seconds = active_seconds + idle_seconds
        if reported_seconds <= 0:
            return ActivityHeartbeatResponse(recorded=False)

        elapsed_seconds = max(1, int(round((ended_at - started_at).total_seconds())))
        allowed_seconds = min(MAX_HEARTBEAT_SECONDS, elapsed_seconds)
        if reported_seconds > allowed_seconds:
            active_ratio = active_seconds / reported_seconds if reported_seconds else 0
            active_seconds = int(round(allowed_seconds * active_ratio))
            idle_seconds = allowed_seconds - active_seconds

        task_id = payload.task_id
        if task_id:
            task = self.db.get(AnnotationTask, task_id)
            if not task or task.organization_id != organization_id:
                raise ServiceError("Task not found in selected organization", status_code=404)
            if actor.role != RoleEnum.ADMIN and task.assignee_id != actor.id:
                raise ServiceError("Cannot track time against a task assigned to another user", status_code=403)

        self.db.add(
            UserActivityEntry(
                organization_id=organization_id,
                user_id=actor.id,
                task_id=task_id,
                route=payload.route,
                active_seconds=active_seconds,
                idle_seconds=idle_seconds,
                event_count=payload.event_count,
                started_at=started_at,
                ended_at=ended_at,
            )
        )
        if active_seconds > 0:
            actor.last_activity_at = ended_at
        self.db.commit()
        return ActivityHeartbeatResponse(recorded=True)

    def get_people_activity(
        self,
        *,
        user_id: str | None,
        date_from: date | None,
        date_to: date | None,
    ) -> PeopleActivityResponse:
        today = datetime.now(timezone.utc).date()
        resolved_date_to = date_to or today
        resolved_date_from = date_from or (resolved_date_to - timedelta(days=6))
        if resolved_date_from > resolved_date_to:
            raise ServiceError("From date must be on or before to date", status_code=422)

        user_query = select(User).order_by(User.full_name.asc(), User.email.asc())
        if user_id:
            user_query = user_query.where(User.id == user_id)
        else:
            user_query = user_query.where(User.is_active.is_(True))
        users = list(self.db.execute(user_query).scalars().all())
        if user_id and not users:
            raise ServiceError("User not found", status_code=404)

        selected_user_ids = [user.id for user in users]
        period_start = datetime.combine(resolved_date_from, datetime.min.time(), tzinfo=timezone.utc)
        period_end = datetime.combine(resolved_date_to, datetime.max.time(), tzinfo=timezone.utc)

        grouped: dict[tuple[str, str], dict[str, Any]] = {}
        organizations: dict[str, Organization] = {}
        if selected_user_ids:
            activity_rows = self.db.execute(
                select(
                    UserActivityEntry.user_id,
                    UserActivityEntry.organization_id,
                    func.coalesce(func.sum(UserActivityEntry.active_seconds), 0).label("active_seconds"),
                    func.coalesce(func.sum(UserActivityEntry.idle_seconds), 0).label("idle_seconds"),
                    func.coalesce(
                        func.sum(
                            case(
                                (UserActivityEntry.task_id.is_not(None), UserActivityEntry.active_seconds),
                                else_=0,
                            )
                        ),
                        0,
                    ).label("task_active_seconds"),
                    func.max(UserActivityEntry.ended_at).label("last_activity_at"),
                )
                .where(UserActivityEntry.user_id.in_(selected_user_ids))
                .where(UserActivityEntry.started_at >= period_start)
                .where(UserActivityEntry.started_at <= period_end)
                .group_by(UserActivityEntry.user_id, UserActivityEntry.organization_id)
            ).all()
            completion_rows = self.db.execute(
                select(
                    TaskStatusHistory.changed_by_id.label("user_id"),
                    AnnotationTask.organization_id,
                    func.count(func.distinct(TaskStatusHistory.task_id)).label("completed_segments"),
                )
                .join(AnnotationTask, AnnotationTask.id == TaskStatusHistory.task_id)
                .where(TaskStatusHistory.changed_by_id.in_(selected_user_ids))
                .where(
                    TaskStatusHistory.new_status.in_(
                        [
                            TaskStatusEnum.COMPLETED,
                            TaskStatusEnum.NEEDS_REVIEW,
                            TaskStatusEnum.REVIEWED,
                            TaskStatusEnum.APPROVED,
                        ]
                    )
                )
                .where(TaskStatusHistory.changed_at >= period_start)
                .where(TaskStatusHistory.changed_at <= period_end)
                .group_by(TaskStatusHistory.changed_by_id, AnnotationTask.organization_id)
            ).all()

            organization_ids = {
                row.organization_id for row in [*activity_rows, *completion_rows]
            }
            if organization_ids:
                organizations = {
                    organization.id: organization
                    for organization in self.db.execute(
                        select(Organization).where(Organization.id.in_(organization_ids))
                    ).scalars()
                }

            for row in activity_rows:
                grouped[(row.user_id, row.organization_id)] = {
                    "active_seconds": int(row.active_seconds or 0),
                    "task_active_seconds": int(row.task_active_seconds or 0),
                    "idle_seconds": int(row.idle_seconds or 0),
                    "completed_segments": 0,
                    "last_activity_at": _as_aware_utc(row.last_activity_at),
                }
            for row in completion_rows:
                stats = grouped.setdefault(
                    (row.user_id, row.organization_id),
                    {
                        "active_seconds": 0,
                        "task_active_seconds": 0,
                        "idle_seconds": 0,
                        "completed_segments": 0,
                        "last_activity_at": None,
                    },
                )
                stats["completed_segments"] = int(row.completed_segments or 0)

        items: list[PeopleActivityUser] = []
        for user in users:
            organization_rows: list[PeopleActivityOrganization] = []
            for (row_user_id, organization_id), stats in grouped.items():
                if row_user_id != user.id:
                    continue
                organization = organizations.get(organization_id)
                if not organization:
                    continue
                organization_rows.append(
                    PeopleActivityOrganization(
                        organization_id=organization.id,
                        organization_name=organization.name,
                        organization_slug=organization.slug,
                        **self._people_activity_summary(stats).model_dump(),
                    )
                )
            organization_rows.sort(key=lambda row: row.organization_name.lower())

            overall_stats = {
                "active_seconds": sum(row.active_seconds for row in organization_rows),
                "task_active_seconds": sum(row.task_active_seconds for row in organization_rows),
                "idle_seconds": sum(row.idle_seconds for row in organization_rows),
                "completed_segments": sum(row.completed_segments for row in organization_rows),
                "last_activity_at": max(
                    (row.last_activity_at for row in organization_rows if row.last_activity_at),
                    default=None,
                ),
            }
            items.append(
                PeopleActivityUser(
                    user_id=user.id,
                    user_name=user.full_name,
                    user_email=user.email,
                    role=user.role.value,
                    is_active=user.is_active,
                    overall=self._people_activity_summary(overall_stats),
                    organizations=organization_rows,
                )
            )

        return PeopleActivityResponse(
            generated_at=datetime.now(timezone.utc),
            date_from=resolved_date_from,
            date_to=resolved_date_to,
            items=items,
        )

    @staticmethod
    def _people_activity_summary(stats: dict[str, Any]) -> PeopleActivitySummary:
        active_seconds = int(stats.get("active_seconds") or 0)
        task_active_seconds = int(stats.get("task_active_seconds") or 0)
        idle_seconds = int(stats.get("idle_seconds") or 0)
        completed_segments = int(stats.get("completed_segments") or 0)
        return PeopleActivitySummary(
            active_seconds=active_seconds,
            task_active_seconds=task_active_seconds,
            idle_seconds=idle_seconds,
            total_tracked_seconds=active_seconds + idle_seconds,
            completed_segments=completed_segments,
            average_active_seconds_per_segment=round(task_active_seconds / completed_segments, 1)
            if task_active_seconds and completed_segments
            else None,
            efficiency_segments_per_active_hour=round(
                completed_segments / (task_active_seconds / 3600), 2
            )
            if task_active_seconds and completed_segments
            else None,
            focus_rate=round(task_active_seconds / active_seconds, 4) if active_seconds else None,
            last_activity_at=_as_aware_utc(stats.get("last_activity_at")),
        )

    def get_admin_metrics(
        self,
        *,
        status: TaskStatusEnum | None,
        assignee_id: str | None,
        upload_job_id: str | None,
        language: str | None,
        date_from: date | None,
        date_to: date | None,
        organization_id: str,
    ) -> AdminMetricsResponse:
        filters = self._build_filters(
            status=status,
            assignee_id=assignee_id,
            upload_job_id=upload_job_id,
            language=language,
            date_from=date_from,
            date_to=date_to,
            organization_id=organization_id,
        )
        tasks = self._load_tasks(filters, include_variants=False)
        comparison_tasks = self._load_tasks(
            [
                *filters,
                AnnotationTask.final_transcript.is_not(None),
                func.length(func.trim(AnnotationTask.final_transcript)) > 0,
            ],
            include_variants=True,
        )
        status_counts = Counter(task.status.value for task in tasks)

        model_accumulators: dict[str, dict[str, Any]] = {}
        language_model_accumulators: dict[tuple[str, str], dict[str, Any]] = {}
        duration_model_accumulators: dict[tuple[str, str], dict[str, Any]] = {}
        task_metrics: list[WorstTaskMetric] = []
        scored_task_ids: set[str] = set()
        scored_pairs = 0
        total_word_errors = 0
        total_reference_words = 0
        total_character_errors = 0
        total_reference_characters = 0
        pair_wer_values: list[float] = []
        pair_cer_values: list[float] = []

        for task in comparison_tasks:
            reference = task.final_transcript or ""
            reference_words = _word_tokens(reference)
            normalized_reference = _normalize_transcript(reference)
            if not reference_words and not normalized_reference:
                continue

            source_metrics: list[TaskSourceErrorMetric] = []
            for variant in task.transcript_variants:
                hypothesis = variant.transcript_text or ""
                hypothesis_words = _word_tokens(hypothesis)
                normalized_hypothesis = _normalize_transcript(hypothesis)
                word_errors = _edit_distance(reference_words, hypothesis_words)
                character_errors = _edit_distance(normalized_reference, normalized_hypothesis)
                reference_word_count = len(reference_words)
                reference_character_count = len(normalized_reference)
                wer = _rounded_rate(word_errors, reference_word_count)
                cer = _rounded_rate(character_errors, reference_character_count)

                accumulator = model_accumulators.setdefault(
                    variant.source_key,
                    _new_model_accumulator(
                        source_key=variant.source_key,
                        source_label=variant.source_label,
                        group_key="all",
                        group_label="All tasks",
                    ),
                )
                _add_model_error(
                    accumulator,
                    task_id=task.id,
                    word_errors=word_errors,
                    reference_words=reference_word_count,
                    character_errors=character_errors,
                    reference_characters=reference_character_count,
                    wer=wer,
                    cer=cer,
                )

                language_key = task.language or "unknown"
                language_accumulator = language_model_accumulators.setdefault(
                    (language_key, variant.source_key),
                    _new_model_accumulator(
                        source_key=variant.source_key,
                        source_label=variant.source_label,
                        group_key=language_key,
                        group_label=language_key,
                    ),
                )
                _add_model_error(
                    language_accumulator,
                    task_id=task.id,
                    word_errors=word_errors,
                    reference_words=reference_word_count,
                    character_errors=character_errors,
                    reference_characters=reference_character_count,
                    wer=wer,
                    cer=cer,
                )

                bucket_key, bucket_label = _duration_bucket(task.duration_seconds)
                duration_accumulator = duration_model_accumulators.setdefault(
                    (bucket_key, variant.source_key),
                    _new_model_accumulator(
                        source_key=variant.source_key,
                        source_label=variant.source_label,
                        group_key=bucket_key,
                        group_label=bucket_label,
                    ),
                )
                _add_model_error(
                    duration_accumulator,
                    task_id=task.id,
                    word_errors=word_errors,
                    reference_words=reference_word_count,
                    character_errors=character_errors,
                    reference_characters=reference_character_count,
                    wer=wer,
                    cer=cer,
                )

                scored_task_ids.add(task.id)
                scored_pairs += 1
                total_word_errors += word_errors
                total_reference_words += reference_word_count
                total_character_errors += character_errors
                total_reference_characters += reference_character_count
                if wer is not None:
                    pair_wer_values.append(wer)
                if cer is not None:
                    pair_cer_values.append(cer)
                source_metrics.append(
                    TaskSourceErrorMetric(
                        source_key=variant.source_key,
                        source_label=variant.source_label,
                        wer=wer,
                        cer=cer,
                        word_errors=word_errors,
                        reference_words=reference_word_count,
                        character_errors=character_errors,
                        reference_characters=reference_character_count,
                    )
                )

            if source_metrics:
                wers = [metric.wer for metric in source_metrics if metric.wer is not None]
                task_metrics.append(
                    WorstTaskMetric(
                        task_id=task.id,
                        external_id=task.external_id,
                        status=task.status,
                        language=task.language,
                        upload_job_id=task.upload_job_id,
                        assignee_name=task.assignee.full_name if task.assignee else None,
                        last_tagger_name=task.last_tagger.full_name if task.last_tagger else None,
                        max_wer=max(wers) if wers else None,
                        average_wer=round(sum(wers) / len(wers), 4) if wers else None,
                        source_metrics=sorted(source_metrics, key=lambda item: item.source_label),
                    )
                )

        pii_metrics = self._build_pii_metrics(tasks)
        masking_metrics, worst_masking_tasks, masking_interval_drilldowns = self._build_masking_metrics(tasks)
        tagger_metrics = self._build_tagger_metrics(tasks)
        user_metrics = self._build_user_metrics(
            tasks,
            organization_id=organization_id,
            date_from=date_from,
            date_to=date_to,
        )
        model_metrics = [
            ModelTranscriptMetric(
                source_key=item["source_key"],
                source_label=item["source_label"],
                tasks_scored=len(item["task_ids"]),
                word_errors=item["word_errors"],
                reference_words=item["reference_words"],
                character_errors=item["character_errors"],
                reference_characters=item["reference_characters"],
                average_wer=_mean_rate(item["wer_values"]),
                average_cer=_mean_rate(item["cer_values"]),
            )
            for item in model_accumulators.values()
        ]
        model_metrics.sort(key=lambda item: item.source_label.lower())
        model_ranking = _rank_model_accumulators(list(model_accumulators.values()))
        best_model = model_ranking[0] if model_ranking else None
        model_benchmarks = ModelBenchmarkSummary(
            best_model_source_key=best_model.source_key if best_model else None,
            best_model_source_label=best_model.source_label if best_model else None,
            best_model_average_wer=best_model.average_wer if best_model else None,
            ranking=model_ranking,
            by_language=_rank_grouped_model_accumulators(list(language_model_accumulators.values())),
            by_duration_bucket=_rank_grouped_model_accumulators(list(duration_model_accumulators.values())),
        )
        task_metrics.sort(key=lambda item: item.max_wer if item.max_wer is not None else -1, reverse=True)

        return AdminMetricsResponse(
            generated_at=datetime.now(timezone.utc),
            filters=MetricsFilters(
                status=status,
                assignee_id=assignee_id,
                job_id=upload_job_id,
                language=language,
                date_from=date_from,
                date_to=date_to,
            ),
            overview=MetricsOverview(
                total_tasks=len(tasks),
                scored_tasks=len(scored_task_ids),
                scored_pairs=scored_pairs,
                average_wer=_mean_rate(pair_wer_values),
                average_cer=_mean_rate(pair_cer_values),
                total_pii_annotations=pii_metrics.total_annotations,
                low_confidence_annotations=pii_metrics.low_confidence_annotations,
                overlap_warnings=pii_metrics.overlap_warnings,
            ),
            status_counts=dict(status_counts),
            model_metrics=model_metrics,
            model_benchmarks=model_benchmarks,
            pii_metrics=pii_metrics,
            masking_metrics=masking_metrics,
            tagger_metrics=tagger_metrics,
            user_metrics=user_metrics,
            worst_tasks=task_metrics[:25],
            worst_masking_tasks=worst_masking_tasks[:25],
            masking_interval_drilldowns=masking_interval_drilldowns[:50],
        )

    def _load_tasks(self, filters: list[Any], *, include_variants: bool) -> list[AnnotationTask]:
        options = [
            load_only(
                AnnotationTask.id,
                AnnotationTask.external_id,
                AnnotationTask.upload_job_id,
                AnnotationTask.final_transcript,
                AnnotationTask.status,
                AnnotationTask.language,
                AnnotationTask.duration_seconds,
                AnnotationTask.pii_annotations,
                AnnotationTask.masked_audio_location,
                AnnotationTask.masked_audio_intervals,
                AnnotationTask.masked_audio_reference_intervals,
                AnnotationTask.masked_audio_alignment_intervals,
                AnnotationTask.assignee_id,
                AnnotationTask.last_tagger_id,
                AnnotationTask.updated_at,
            ),
            joinedload(AnnotationTask.assignee).load_only(User.id, User.full_name, User.email),
            joinedload(AnnotationTask.last_tagger).load_only(User.id, User.full_name, User.email),
        ]
        if include_variants:
            options.append(
                selectinload(AnnotationTask.transcript_variants).load_only(
                    TaskTranscriptVariant.source_key,
                    TaskTranscriptVariant.source_label,
                    TaskTranscriptVariant.transcript_text,
                )
            )
        stmt = (
            select(AnnotationTask)
            .options(*options)
            .order_by(AnnotationTask.updated_at.desc())
        )
        if filters:
            stmt = stmt.where(and_(*filters))
        return list(self.db.execute(stmt).unique().scalars().all())

    def _build_filters(
        self,
        *,
        status: TaskStatusEnum | None,
        assignee_id: str | None,
        upload_job_id: str | None,
        language: str | None,
        date_from: date | None,
        date_to: date | None,
        organization_id: str | None,
    ) -> list[Any]:
        filters: list[Any] = []
        if organization_id:
            filters.append(AnnotationTask.organization_id == organization_id)
        if status:
            filters.append(AnnotationTask.status == status)
        if assignee_id:
            if assignee_id == "unassigned":
                filters.append(AnnotationTask.assignee_id.is_(None))
            else:
                filters.append(AnnotationTask.assignee_id == assignee_id)
        if upload_job_id:
            filters.append(AnnotationTask.upload_job_id == upload_job_id)
        if language:
            filters.append(AnnotationTask.language == language)
        if date_from:
            filters.append(AnnotationTask.updated_at >= datetime.combine(date_from, datetime.min.time(), tzinfo=timezone.utc))
        if date_to:
            filters.append(AnnotationTask.updated_at <= datetime.combine(date_to, datetime.max.time(), tzinfo=timezone.utc))
        return filters

    def _build_pii_metrics(self, tasks: list[AnnotationTask]) -> PIIMetrics:
        by_label: Counter[str] = Counter()
        by_source: Counter[str] = Counter()
        total = 0
        low_confidence = 0
        overlaps = 0

        for task in tasks:
            annotations = task.pii_annotations or []
            total += len(annotations)
            overlaps += _overlap_pair_count(annotations)
            for annotation in annotations:
                by_label[str(annotation.get("label") or "OTHER")] += 1
                by_source[str(annotation.get("source") or "manual")] += 1
                confidence = _safe_float(annotation.get("confidence"))
                if confidence is not None and confidence < LOW_CONFIDENCE_THRESHOLD:
                    low_confidence += 1

        return PIIMetrics(
            total_annotations=total,
            average_annotations_per_task=round(total / len(tasks), 2) if tasks else 0,
            low_confidence_annotations=low_confidence,
            overlap_warnings=overlaps,
            by_label=dict(sorted(by_label.items())),
            by_source=dict(sorted(by_source.items())),
        )

    def _build_masking_metrics(
        self,
        tasks: list[AnnotationTask],
    ) -> tuple[MaskingMetrics, list[MaskingTaskMetric], list[MaskingIntervalMetric]]:
        masked_tasks = 0
        scored_masked_tasks = 0
        unscored_masked_tasks = 0
        scored_intervals = 0
        onset_error_total_ms = 0.0
        offset_error_total_ms = 0.0
        leaked_total_ms = 0
        over_masked_total_ms = 0
        alignment_adjusted_tasks = 0
        alignment_adjusted_intervals = 0
        alignment_onset_total_ms = 0.0
        alignment_offset_total_ms = 0.0
        alignment_trimmed_total_ms = 0
        alignment_expanded_total_ms = 0
        task_metrics: list[MaskingTaskMetric] = []
        interval_metrics: list[MaskingIntervalMetric] = []

        for task in tasks:
            actual_intervals = task.masked_audio_intervals or []
            reference_intervals = task.masked_audio_reference_intervals or []
            alignment_intervals = task.masked_audio_alignment_intervals or []
            if not task.masked_audio_location and not actual_intervals:
                continue

            masked_tasks += 1
            pairs = _pair_mask_intervals(reference_intervals, actual_intervals) if reference_intervals and actual_intervals else []
            if not pairs:
                unscored_masked_tasks += 1
                continue

            scored_masked_tasks += 1
            scored_intervals += len(pairs)
            task_onset_total_ms = 0.0
            task_offset_total_ms = 0.0
            task_alignment_adjustment_ms = 0
            task_alignment_trimmed_ms = 0
            task_alignment_expanded_ms = 0
            alignment_pairs = (
                _pair_mask_intervals(reference_intervals, alignment_intervals)
                if reference_intervals and alignment_intervals
                else []
            )
            alignment_by_reference_identity = {id(reference): alignment for reference, alignment in alignment_pairs}
            alignment_by_id = {_interval_id(alignment): alignment for _, alignment in alignment_pairs if _interval_id(alignment)}
            alignment_by_reference_id = {
                _interval_id(reference): alignment
                for reference, alignment in alignment_pairs
                if _interval_id(reference)
            }
            for reference, actual in pairs:
                onset_error_ms = abs(_interval_start(actual) - _interval_start(reference)) * 1000
                offset_error_ms = abs(_interval_end(actual) - _interval_end(reference)) * 1000
                onset_error_total_ms += onset_error_ms
                offset_error_total_ms += offset_error_ms
                task_onset_total_ms += onset_error_ms
                task_offset_total_ms += offset_error_ms

                alignment = (
                    alignment_by_reference_id.get(_interval_id(reference))
                    or alignment_by_id.get(_interval_id(actual))
                    or alignment_by_reference_identity.get(id(reference))
                )
                alignment_onset_delta_ms = None
                alignment_offset_delta_ms = None
                interval_alignment_trimmed_ms = 0
                interval_alignment_expanded_ms = 0
                if alignment:
                    alignment_onset_delta_ms = int(round((_interval_start(reference) - _interval_start(alignment)) * 1000))
                    alignment_offset_delta_ms = int(round((_interval_end(reference) - _interval_end(alignment)) * 1000))
                    interval_alignment_trimmed_ms = int(round(_uncovered_duration_seconds([alignment], [reference]) * 1000))
                    interval_alignment_expanded_ms = int(round(_uncovered_duration_seconds([reference], [alignment]) * 1000))
                    interval_adjustment_ms = abs(alignment_onset_delta_ms) + abs(alignment_offset_delta_ms)
                    if interval_adjustment_ms or interval_alignment_trimmed_ms or interval_alignment_expanded_ms:
                        alignment_adjusted_intervals += 1
                        alignment_onset_total_ms += abs(alignment_onset_delta_ms)
                        alignment_offset_total_ms += abs(alignment_offset_delta_ms)
                        task_alignment_adjustment_ms += interval_adjustment_ms
                        task_alignment_trimmed_ms += interval_alignment_trimmed_ms
                        task_alignment_expanded_ms += interval_alignment_expanded_ms

                interval_leaked_ms = int(round(_uncovered_duration_seconds([reference], [actual]) * 1000))
                interval_over_masked_ms = int(round(_uncovered_duration_seconds([actual], [reference]) * 1000))
                interval_metrics.append(
                    MaskingIntervalMetric(
                        task_id=task.id,
                        external_id=task.external_id,
                        status=task.status,
                        language=task.language,
                        upload_job_id=task.upload_job_id,
                        interval_id=_interval_id(reference) or _interval_id(actual),
                        label=_interval_label(reference),
                        text=str(reference.get("text") or actual.get("text") or ""),
                        accepted_start_seconds=round(_interval_start(reference), 3),
                        accepted_end_seconds=round(_interval_end(reference), 3),
                        actual_start_seconds=round(_interval_start(actual), 3),
                        actual_end_seconds=round(_interval_end(actual), 3),
                        alignment_start_seconds=round(_interval_start(alignment), 3) if alignment else None,
                        alignment_end_seconds=round(_interval_end(alignment), 3) if alignment else None,
                        leaked_audio_duration_ms=interval_leaked_ms,
                        over_masked_duration_ms=interval_over_masked_ms,
                        alignment_onset_delta_ms=alignment_onset_delta_ms,
                        alignment_offset_delta_ms=alignment_offset_delta_ms,
                        alignment_trimmed_duration_ms=interval_alignment_trimmed_ms,
                        alignment_expanded_duration_ms=interval_alignment_expanded_ms,
                        risk_duration_ms=interval_leaked_ms + interval_over_masked_ms,
                    )
                )

            leaked_ms = int(round(_uncovered_duration_seconds(reference_intervals, actual_intervals) * 1000))
            over_masked_ms = int(round(_uncovered_duration_seconds(actual_intervals, reference_intervals) * 1000))
            leaked_total_ms += leaked_ms
            over_masked_total_ms += over_masked_ms
            alignment_trimmed_total_ms += task_alignment_trimmed_ms
            alignment_expanded_total_ms += task_alignment_expanded_ms
            if task_alignment_adjustment_ms or task_alignment_trimmed_ms or task_alignment_expanded_ms:
                alignment_adjusted_tasks += 1
            task_metrics.append(
                MaskingTaskMetric(
                    task_id=task.id,
                    external_id=task.external_id,
                    status=task.status,
                    language=task.language,
                    upload_job_id=task.upload_job_id,
                    assignee_name=task.assignee.full_name if task.assignee else None,
                    last_tagger_name=task.last_tagger.full_name if task.last_tagger else None,
                    onset_error_ms=int(round(task_onset_total_ms / len(pairs))) if pairs else None,
                    offset_error_ms=int(round(task_offset_total_ms / len(pairs))) if pairs else None,
                    leaked_audio_duration_ms=leaked_ms,
                    over_masked_duration_ms=over_masked_ms,
                    risk_duration_ms=leaked_ms + over_masked_ms,
                    scored_intervals=len(pairs),
                    alignment_adjustment_ms=task_alignment_adjustment_ms,
                    alignment_trimmed_duration_ms=task_alignment_trimmed_ms,
                    alignment_expanded_duration_ms=task_alignment_expanded_ms,
                )
            )

        task_metrics.sort(
            key=lambda item: (
                item.risk_duration_ms,
                item.alignment_adjustment_ms + item.alignment_trimmed_duration_ms + item.alignment_expanded_duration_ms,
            ),
            reverse=True,
        )
        interval_metrics.sort(
            key=lambda item: (
                item.risk_duration_ms,
                item.alignment_trimmed_duration_ms + item.alignment_expanded_duration_ms,
            ),
            reverse=True,
        )
        return (
            MaskingMetrics(
                masked_tasks=masked_tasks,
                scored_masked_tasks=scored_masked_tasks,
                scored_intervals=scored_intervals,
                average_onset_error_ms=int(round(onset_error_total_ms / scored_intervals))
                if scored_intervals
                else None,
                average_offset_error_ms=int(round(offset_error_total_ms / scored_intervals))
                if scored_intervals
                else None,
                leaked_audio_duration_ms=leaked_total_ms,
                over_masked_duration_ms=over_masked_total_ms,
                unscored_masked_tasks=unscored_masked_tasks,
                alignment_adjusted_tasks=alignment_adjusted_tasks,
                alignment_adjusted_intervals=alignment_adjusted_intervals,
                average_alignment_onset_adjustment_ms=int(round(alignment_onset_total_ms / alignment_adjusted_intervals))
                if alignment_adjusted_intervals
                else None,
                average_alignment_offset_adjustment_ms=int(round(alignment_offset_total_ms / alignment_adjusted_intervals))
                if alignment_adjusted_intervals
                else None,
                alignment_trimmed_duration_ms=alignment_trimmed_total_ms,
                alignment_expanded_duration_ms=alignment_expanded_total_ms,
            ),
            task_metrics,
            interval_metrics,
        )

    def _build_tagger_metrics(self, tasks: list[AnnotationTask]) -> list[TaggerMetric]:
        grouped: dict[str | None, dict[str, Any]] = defaultdict(
            lambda: {
                "user_id": None,
                "user_name": None,
                "user_email": None,
                "tasks_touched": 0,
                "completed_tasks": 0,
                "reviewed_tasks": 0,
                "approved_tasks": 0,
                "pii_annotations": 0,
            }
        )

        for task in tasks:
            key = task.last_tagger_id
            if not key:
                continue
            item = grouped[key]
            item["user_id"] = task.last_tagger_id
            item["user_name"] = task.last_tagger.full_name if task.last_tagger else None
            item["user_email"] = task.last_tagger.email if task.last_tagger else None
            item["tasks_touched"] += 1
            item["pii_annotations"] += len(task.pii_annotations or [])
            if task.status in {TaskStatusEnum.COMPLETED, TaskStatusEnum.NEEDS_REVIEW}:
                item["completed_tasks"] += 1
            if task.status == TaskStatusEnum.REVIEWED:
                item["reviewed_tasks"] += 1
            if task.status == TaskStatusEnum.APPROVED:
                item["approved_tasks"] += 1

        metrics = [TaggerMetric(**item) for item in grouped.values()]
        metrics.sort(key=lambda item: item.tasks_touched, reverse=True)
        return metrics

    def _build_user_metrics(
        self,
        tasks: list[AnnotationTask],
        *,
        organization_id: str,
        date_from: date | None,
        date_to: date | None,
    ) -> list[UserProductivityMetric]:
        users = list(
            self.db.execute(
                select(User)
                .join(OrganizationMembership, OrganizationMembership.user_id == User.id)
                .where(OrganizationMembership.organization_id == organization_id)
                .where(OrganizationMembership.is_active.is_(True))
                .order_by(User.full_name.asc())
            )
            .scalars()
            .all()
        )
        task_ids = [task.id for task in tasks]
        user_ids = [user.id for user in users]
        now = datetime.now(timezone.utc)

        assigned_task_counts: Counter[str] = Counter()
        open_assigned_task_counts: Counter[str] = Counter()
        touched_task_ids: dict[str, set[str]] = defaultdict(set)
        completed_task_ids: dict[str, set[str]] = defaultdict(set)
        reviewed_task_ids: dict[str, set[str]] = defaultdict(set)
        approved_task_ids: dict[str, set[str]] = defaultdict(set)
        completed_period_task_ids: dict[str, set[str]] = defaultdict(set)
        completed_today_task_ids: dict[str, set[str]] = defaultdict(set)
        pii_annotation_counts: Counter[str] = Counter()
        period_start = (
            datetime.combine(date_from, datetime.min.time(), tzinfo=timezone.utc) if date_from else None
        )
        period_end = datetime.combine(date_to, datetime.max.time(), tzinfo=timezone.utc) if date_to else None
        today_start = datetime.combine(now.date(), datetime.min.time(), tzinfo=timezone.utc)
        today_end = datetime.combine(now.date(), datetime.max.time(), tzinfo=timezone.utc)

        for task in tasks:
            if task.assignee_id:
                assigned_task_counts[task.assignee_id] += 1
                if task.status != TaskStatusEnum.APPROVED:
                    open_assigned_task_counts[task.assignee_id] += 1
            if task.last_tagger_id:
                touched_task_ids[task.last_tagger_id].add(task.id)
                pii_annotation_counts[task.last_tagger_id] += len(task.pii_annotations or [])
                if task.status in {TaskStatusEnum.COMPLETED, TaskStatusEnum.NEEDS_REVIEW}:
                    completed_task_ids[task.last_tagger_id].add(task.id)
                if task.status == TaskStatusEnum.REVIEWED:
                    reviewed_task_ids[task.last_tagger_id].add(task.id)
                if task.status == TaskStatusEnum.APPROVED:
                    approved_task_ids[task.last_tagger_id].add(task.id)

        audit_logs: list[TaskAuditLog] = []
        status_history: list[TaskStatusHistory] = []
        if task_ids:
            audit_logs = list(
                self.db.execute(
                    select(TaskAuditLog)
                    .where(TaskAuditLog.task_id.in_(task_ids))
                    .order_by(TaskAuditLog.created_at.asc())
                ).scalars().all()
            )
            status_history = list(
                self.db.execute(
                    select(TaskStatusHistory)
                    .where(TaskStatusHistory.task_id.in_(task_ids))
                    .order_by(TaskStatusHistory.changed_at.asc())
                ).scalars().all()
            )

        task_audit_counts: Counter[str] = Counter()
        activity_times: dict[tuple[str, str], list[datetime]] = defaultdict(list)
        for log in audit_logs:
            task_audit_counts[log.actor_user_id] += 1
            touched_task_ids[log.actor_user_id].add(log.task_id)
            activity_times[(log.actor_user_id, log.task_id)].append(log.created_at)

        terminal_statuses = {
            TaskStatusEnum.COMPLETED,
            TaskStatusEnum.NEEDS_REVIEW,
            TaskStatusEnum.REVIEWED,
            TaskStatusEnum.APPROVED,
        }
        for history in status_history:
            touched_task_ids[history.changed_by_id].add(history.task_id)
            activity_times[(history.changed_by_id, history.task_id)].append(history.changed_at)
            if history.new_status in {TaskStatusEnum.COMPLETED, TaskStatusEnum.NEEDS_REVIEW}:
                completed_task_ids[history.changed_by_id].add(history.task_id)
            if history.new_status == TaskStatusEnum.REVIEWED:
                reviewed_task_ids[history.changed_by_id].add(history.task_id)
            if history.new_status == TaskStatusEnum.APPROVED:
                approved_task_ids[history.changed_by_id].add(history.task_id)

            changed_at = _as_aware_utc(history.changed_at)
            if history.new_status in terminal_statuses and changed_at:
                if _datetime_in_window(changed_at, period_start, period_end):
                    completed_period_task_ids[history.changed_by_id].add(history.task_id)
                if today_start <= changed_at <= today_end:
                    completed_today_task_ids[history.changed_by_id].add(history.task_id)
        turnaround_minutes: dict[str, list[float]] = defaultdict(list)
        for history in status_history:
            if history.new_status not in terminal_statuses:
                continue
            end_time = _as_aware_utc(history.changed_at)
            if end_time is None:
                continue
            candidates = [
                _as_aware_utc(activity_time)
                for activity_time in activity_times[(history.changed_by_id, history.task_id)]
            ]
            candidates = [
                activity_time
                for activity_time in candidates
                if activity_time is not None and activity_time < end_time
            ]
            if not candidates:
                continue
            minutes = _minutes_between(min(candidates), end_time)
            if minutes is not None:
                turnaround_minutes[history.changed_by_id].append(minutes)

        security_events: list[SecurityAuditEvent] = []
        if user_ids:
            organization_filter = SecurityAuditEvent.organization_id == organization_id
            if organization_id == DEFAULT_ORGANIZATION_ID:
                organization_filter = or_(organization_filter, SecurityAuditEvent.organization_id.is_(None))
            security_events = list(
                self.db.execute(
                    select(SecurityAuditEvent)
                    .where(SecurityAuditEvent.actor_user_id.in_(user_ids))
                    .where(organization_filter)
                ).scalars().all()
            )
        security_event_counts: Counter[str] = Counter()
        high_risk_security_event_counts: Counter[str] = Counter()
        for event in security_events:
            if not event.actor_user_id:
                continue
            security_event_counts[event.actor_user_id] += 1
            if event.risk_level == "high":
                high_risk_security_event_counts[event.actor_user_id] += 1

        activity_stats: dict[str, dict[str, int]] = defaultdict(
            lambda: {"active_seconds": 0, "task_active_seconds": 0, "idle_seconds": 0}
        )
        if user_ids:
            activity_filters = [
                UserActivityEntry.organization_id == organization_id,
                UserActivityEntry.user_id.in_(user_ids),
            ]
            if period_start:
                activity_filters.append(UserActivityEntry.started_at >= period_start)
            if period_end:
                activity_filters.append(UserActivityEntry.started_at <= period_end)
            activity_rows = self.db.execute(
                select(
                    UserActivityEntry.user_id,
                    func.coalesce(func.sum(UserActivityEntry.active_seconds), 0).label("active_seconds"),
                    func.coalesce(func.sum(UserActivityEntry.idle_seconds), 0).label("idle_seconds"),
                    func.coalesce(
                        func.sum(
                            case(
                                (UserActivityEntry.task_id.is_not(None), UserActivityEntry.active_seconds),
                                else_=0,
                            )
                        ),
                        0,
                    ).label("task_active_seconds"),
                )
                .where(and_(*activity_filters))
                .group_by(UserActivityEntry.user_id)
            ).all()
            for row in activity_rows:
                activity_stats[row.user_id] = {
                    "active_seconds": int(row.active_seconds or 0),
                    "idle_seconds": int(row.idle_seconds or 0),
                    "task_active_seconds": int(row.task_active_seconds or 0),
                }

        metrics: list[UserProductivityMetric] = []
        for user in users:
            completion_values = turnaround_minutes[user.id]
            active_session_minutes = _minutes_between(user.active_session_started_at, now)
            idle_minutes = _minutes_between(user.last_activity_at, now)
            stats = activity_stats[user.id]
            active_seconds = stats["active_seconds"]
            task_active_seconds = stats["task_active_seconds"]
            idle_seconds = stats["idle_seconds"]
            total_tracked_seconds = active_seconds + idle_seconds
            completed_in_period = len(completed_period_task_ids[user.id])
            if not period_start and not period_end:
                completed_in_period = max(completed_in_period, len(completed_task_ids[user.id]))
            active_seconds_for_segment_metrics = task_active_seconds or active_seconds
            active_hours_for_efficiency = active_seconds_for_segment_metrics / 3600
            metrics.append(
                UserProductivityMetric(
                    user_id=user.id,
                    user_name=user.full_name,
                    user_email=user.email,
                    role=user.role.value,
                    is_active=user.is_active,
                    assigned_tasks=assigned_task_counts[user.id],
                    open_assigned_tasks=open_assigned_task_counts[user.id],
                    tasks_touched=len(touched_task_ids[user.id]),
                    completed_tasks=len(completed_task_ids[user.id]),
                    reviewed_tasks=len(reviewed_task_ids[user.id]),
                    approved_tasks=len(approved_task_ids[user.id]),
                    pii_annotations=pii_annotation_counts[user.id],
                    average_completion_minutes=round(sum(completion_values) / len(completion_values), 1)
                    if completion_values
                    else None,
                    completed_turnaround_count=len(completion_values),
                    task_audit_events=task_audit_counts[user.id],
                    security_events=security_event_counts[user.id],
                    high_risk_security_events=high_risk_security_event_counts[user.id],
                    last_login_at=user.last_login_at,
                    last_activity_at=user.last_activity_at,
                    active_session_started_at=user.active_session_started_at,
                    active_session_minutes=int(active_session_minutes) if active_session_minutes is not None else None,
                    idle_minutes=int(idle_minutes) if idle_minutes is not None else None,
                    tracked_active_minutes=int(round(active_seconds / 60)),
                    tracked_task_active_minutes=int(round(task_active_seconds / 60)),
                    tracked_idle_minutes=int(round(idle_seconds / 60)),
                    tracked_total_minutes=int(round(total_tracked_seconds / 60)),
                    completed_tasks_in_period=completed_in_period,
                    completed_tasks_today=len(completed_today_task_ids[user.id]),
                    average_active_minutes_per_segment=round(
                        (active_seconds_for_segment_metrics / 60) / completed_in_period,
                        1,
                    )
                    if completed_in_period and active_seconds_for_segment_metrics
                    else None,
                    efficiency_segments_per_active_hour=round(completed_in_period / active_hours_for_efficiency, 2)
                    if completed_in_period and active_hours_for_efficiency
                    else None,
                    focus_rate=round(active_seconds / total_tracked_seconds, 4) if total_tracked_seconds else None,
                )
            )

        metrics.sort(
            key=lambda item: (
                -item.tasks_touched,
                -item.open_assigned_tasks,
                item.role,
                item.user_name.lower(),
            )
        )
        return metrics
