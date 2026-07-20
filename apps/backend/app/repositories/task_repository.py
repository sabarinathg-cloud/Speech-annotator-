import copy
from datetime import date, datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, joinedload

from app.models.enums import TaskStatusEnum
from app.models.task import AnnotationTask, TaskAuditLog, TaskStatusHistory, TaskTranscriptVariant
from app.models.user import User


def _json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


SENSITIVE_AUDIT_FIELDS = {
    "final_transcript",
    "notes",
    "file_location",
    "original_row",
    "custom_metadata",
    "pii_annotations",
    "masked_audio_location",
    "masked_intervals",
}


def _summarize_pii_annotations(value: Any) -> dict[str, Any]:
    annotations = value if isinstance(value, list) else []
    labels = sorted({str(item.get("label")) for item in annotations if isinstance(item, dict) and item.get("label")})
    ranges = [
        {
            "label": str(item.get("label", "")),
            "start": item.get("start"),
            "end": item.get("end"),
        }
        for item in annotations
        if isinstance(item, dict)
    ]
    return {"count": len(annotations), "labels": labels, "ranges": ranges}


def _audit_safe_mapping(values: dict[str, Any]) -> dict[str, Any]:
    safe_values: dict[str, Any] = {}
    for key, value in values.items():
        if key == "pii_annotations":
            safe_values[key] = _summarize_pii_annotations(value)
        elif key in SENSITIVE_AUDIT_FIELDS:
            safe_values[key] = "[REDACTED_TEXT]"
        else:
            safe_values[key] = _json_safe(value)
    return safe_values


class TaskRepository:
    def __init__(self, db: Session):
        self.db = db

    def create_task(
        self,
        *,
        upload_job_id: str,
        external_id: str,
        file_location: str,
        final_transcript: str | None,
        notes: str | None,
        status: TaskStatusEnum,
        speaker_gender: str | None,
        speaker_role: str | None,
        language: str | None,
        channel: str | None,
        duration_seconds: Any,
        custom_metadata: dict[str, Any],
        original_row: dict[str, Any],
        due_date: date | None = None,
    ) -> AnnotationTask:
        task = AnnotationTask(
            upload_job_id=upload_job_id,
            external_id=external_id,
            file_location=file_location,
            final_transcript=final_transcript,
            notes=notes,
            status=status,
            speaker_gender=speaker_gender,
            speaker_role=speaker_role,
            language=language,
            channel=channel,
            duration_seconds=duration_seconds,
            due_date=due_date,
            custom_metadata=custom_metadata,
            original_row=original_row,
            pii_annotations=[],
            last_saved_at=datetime.now(timezone.utc),
        )
        self.db.add(task)
        self.db.flush()
        return task

    def create_parallel_assignment_copy(
        self,
        *,
        source_task: AnnotationTask,
        external_id: str,
        assignee_id: str,
    ) -> AnnotationTask:
        original_row = copy.deepcopy(source_task.original_row or {})
        original_row["parallel_assignment_source_task_id"] = source_task.id
        original_row["parallel_assignment_source_external_id"] = source_task.external_id

        task = AnnotationTask(
            upload_job_id=source_task.upload_job_id,
            external_id=external_id,
            file_location=source_task.file_location,
            final_transcript=source_task.final_transcript,
            notes=source_task.notes,
            status=TaskStatusEnum.NOT_STARTED,
            speaker_gender=source_task.speaker_gender,
            speaker_role=source_task.speaker_role,
            language=source_task.language,
            channel=source_task.channel,
            duration_seconds=source_task.duration_seconds,
            due_date=source_task.due_date,
            custom_metadata=copy.deepcopy(source_task.custom_metadata or {}),
            original_row=original_row,
            pii_annotations=[],
            alignment_words=copy.deepcopy(source_task.alignment_words or []),
            alignment_transcript_hash=source_task.alignment_transcript_hash,
            alignment_model=source_task.alignment_model,
            alignment_updated_at=source_task.alignment_updated_at,
            assignee_id=assignee_id,
            last_saved_at=datetime.now(timezone.utc),
        )
        self.db.add(task)
        self.db.flush()
        for variant in source_task.transcript_variants or []:
            self.db.add(
                TaskTranscriptVariant(
                    task_id=task.id,
                    source_key=variant.source_key,
                    source_label=variant.source_label,
                    transcript_text=variant.transcript_text,
                )
            )
        self.db.flush()
        return task

    def get_existing_parallel_assignment(
        self,
        *,
        upload_job_id: str,
        file_location: str,
        assignee_id: str,
        exclude_task_id: str,
    ) -> AnnotationTask | None:
        stmt = (
            select(AnnotationTask)
            .options(
                joinedload(AnnotationTask.transcript_variants),
                joinedload(AnnotationTask.assignee),
                joinedload(AnnotationTask.last_tagger),
            )
            .where(AnnotationTask.upload_job_id == upload_job_id)
            .where(AnnotationTask.file_location == file_location)
            .where(AnnotationTask.assignee_id == assignee_id)
            .where(AnnotationTask.id != exclude_task_id)
            .limit(1)
        )
        return self.db.execute(stmt).unique().scalar_one_or_none()

    def external_id_exists(self, *, upload_job_id: str, external_id: str) -> bool:
        stmt = (
            select(AnnotationTask.id)
            .where(AnnotationTask.upload_job_id == upload_job_id)
            .where(AnnotationTask.external_id == external_id)
            .limit(1)
        )
        return self.db.execute(stmt).scalar_one_or_none() is not None

    def add_transcript_variants(
        self,
        *,
        task_id: str,
        variants: list[dict[str, str]],
    ) -> None:
        for variant in variants:
            self.db.add(
                TaskTranscriptVariant(
                    task_id=task_id,
                    source_key=variant["source_key"],
                    source_label=variant["source_label"],
                    transcript_text=variant["transcript_text"],
                )
            )
        self.db.flush()

    def list_tasks(
        self,
        *,
        status: TaskStatusEnum | None,
        search: str | None,
        assignee_id: str | None,
        upload_job_id: str | None = None,
        language: str | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        page: int,
        page_size: int,
    ) -> tuple[list[AnnotationTask], int]:
        stmt = select(AnnotationTask).options(
            joinedload(AnnotationTask.assignee),
            joinedload(AnnotationTask.last_tagger),
        )
        count_stmt = select(func.count(AnnotationTask.id))

        filters = []
        if status:
            filters.append(AnnotationTask.status == status)
        if search:
            like_term = f"%{search}%"
            filters.append(
                or_(
                    AnnotationTask.external_id.ilike(like_term),
                    AnnotationTask.file_location.ilike(like_term),
                )
            )
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

        if filters:
            stmt = stmt.where(and_(*filters))
            count_stmt = count_stmt.where(and_(*filters))

        stmt = stmt.order_by(AnnotationTask.updated_at.desc()).offset((page - 1) * page_size).limit(page_size)

        items = list(self.db.execute(stmt).scalars().all())
        total = self.db.execute(count_stmt).scalar_one()
        return items, int(total)

    def get_status_counts(self, *, assignee_id: str | None = None) -> dict[str, int]:
        stmt = select(AnnotationTask.status, func.count(AnnotationTask.id)).group_by(AnnotationTask.status)
        if assignee_id:
            stmt = stmt.where(AnnotationTask.assignee_id == assignee_id)
        rows = self.db.execute(stmt).all()
        return {status.value: count for status, count in rows}

    def get_task(self, task_id: str) -> AnnotationTask | None:
        stmt = (
            select(AnnotationTask)
            .options(
                joinedload(AnnotationTask.transcript_variants),
                joinedload(AnnotationTask.assignee),
                joinedload(AnnotationTask.last_tagger),
            )
            .where(AnnotationTask.id == task_id)
        )
        return self.db.execute(stmt).unique().scalar_one_or_none()

    def get_prev_next_task_ids(
        self,
        task: AnnotationTask,
        *,
        assignee_id: str | None = None,
    ) -> tuple[str | None, str | None]:
        prev_filters = [AnnotationTask.created_at < task.created_at]
        next_filters = [AnnotationTask.created_at > task.created_at]
        if assignee_id:
            prev_filters.append(AnnotationTask.assignee_id == assignee_id)
            next_filters.append(AnnotationTask.assignee_id == assignee_id)
        prev_stmt = (
            select(AnnotationTask.id)
            .where(and_(*prev_filters))
            .order_by(AnnotationTask.created_at.desc())
            .limit(1)
        )
        next_stmt = (
            select(AnnotationTask.id)
            .where(and_(*next_filters))
            .order_by(AnnotationTask.created_at.asc())
            .limit(1)
        )
        prev_id = self.db.execute(prev_stmt).scalar_one_or_none()
        next_id = self.db.execute(next_stmt).scalar_one_or_none()
        return prev_id, next_id

    def get_next_unfinished_task(self, *, assignee_id: str | None = None) -> str | None:
        stmt = (
            select(AnnotationTask.id)
            .where(AnnotationTask.status != TaskStatusEnum.APPROVED)
            .order_by(AnnotationTask.updated_at.asc())
            .limit(1)
        )
        if assignee_id:
            stmt = stmt.where(AnnotationTask.assignee_id == assignee_id)
        return self.db.execute(stmt).scalar_one_or_none()

    def get_next_unassigned_task(self) -> AnnotationTask | None:
        stmt = (
            select(AnnotationTask)
            .options(
                joinedload(AnnotationTask.transcript_variants),
                joinedload(AnnotationTask.assignee),
                joinedload(AnnotationTask.last_tagger),
            )
            .where(AnnotationTask.status != TaskStatusEnum.APPROVED)
            .where(AnnotationTask.assignee_id.is_(None))
            .order_by(AnnotationTask.updated_at.asc())
            .limit(1)
        )
        return self.db.execute(stmt).unique().scalar_one_or_none()

    def list_activity(self, task_id: str) -> list[dict[str, Any]]:
        audit_stmt = (
            select(TaskAuditLog)
            .where(TaskAuditLog.task_id == task_id)
            .order_by(TaskAuditLog.created_at.asc())
        )
        status_stmt = (
            select(TaskStatusHistory)
            .where(TaskStatusHistory.task_id == task_id)
            .order_by(TaskStatusHistory.changed_at.asc())
        )
        audits = list(self.db.execute(audit_stmt).scalars().all())
        statuses = list(self.db.execute(status_stmt).scalars().all())
        actor_ids = {audit.actor_user_id for audit in audits}
        actor_ids.update(status.changed_by_id for status in statuses)
        users_by_id = {
            user.id: user
            for user in self.db.execute(select(User).where(User.id.in_(actor_ids))).scalars().all()
        } if actor_ids else {}
        items: list[dict[str, Any]] = []
        for audit in audits:
            actor = users_by_id.get(audit.actor_user_id)
            items.append(
                {
                    "id": audit.id,
                    "type": "audit",
                    "action": audit.action,
                    "actor_user_id": audit.actor_user_id,
                    "actor_email": actor.email if actor else None,
                    "actor_name": actor.full_name if actor else None,
                    "changed_at": audit.created_at,
                    "changed_fields": audit.changed_fields or {},
                    "previous_values": audit.previous_values or {},
                    "new_values": audit.new_values or {},
                }
            )
        for status in statuses:
            actor = users_by_id.get(status.changed_by_id)
            items.append(
                {
                    "id": status.id,
                    "type": "status",
                    "action": "STATUS_HISTORY",
                    "actor_user_id": status.changed_by_id,
                    "actor_email": actor.email if actor else None,
                    "actor_name": actor.full_name if actor else None,
                    "changed_at": status.changed_at,
                    "old_status": status.old_status,
                    "new_status": status.new_status,
                    "comment": status.comment,
                }
            )
        return sorted(items, key=lambda item: item["changed_at"])

    def save_task(self, task: AnnotationTask) -> AnnotationTask:
        task.version += 1
        task.last_saved_at = datetime.now(timezone.utc)
        self.db.flush()
        return task

    def add_status_history(
        self,
        *,
        task_id: str,
        old_status: TaskStatusEnum | None,
        new_status: TaskStatusEnum,
        changed_by_id: str,
        comment: str | None,
    ) -> None:
        self.db.add(
            TaskStatusHistory(
                task_id=task_id,
                old_status=old_status,
                new_status=new_status,
                changed_by_id=changed_by_id,
                comment=comment,
            )
        )
        self.db.flush()

    def add_audit_log(
        self,
        *,
        task_id: str,
        actor_user_id: str,
        action: str,
        changed_fields: dict[str, Any],
        previous_values: dict[str, Any],
        new_values: dict[str, Any],
    ) -> None:
        self.db.add(
            TaskAuditLog(
                task_id=task_id,
                actor_user_id=actor_user_id,
                action=action,
                changed_fields=_json_safe(changed_fields),
                previous_values=_audit_safe_mapping(previous_values),
                new_values=_audit_safe_mapping(new_values),
            )
        )
        self.db.flush()
