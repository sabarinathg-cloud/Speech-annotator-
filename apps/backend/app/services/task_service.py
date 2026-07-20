import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from app.models.enums import RoleEnum, TaskStatusEnum
from app.models.task import AnnotationTask
from app.models.user import User
from app.repositories.task_repository import TaskRepository
from app.repositories.user_repository import UserRepository
from app.schemas.task import (
    AudioMaskInterval,
    AudioAlignmentWord,
    AudioMaskMode,
    BulkAssignmentCopyItem,
    BulkAssignmentCopyResponse,
    BulkAssigneeError,
    BulkAssigneeItem,
    BulkAssigneeResponse,
    BulkAssigneeUpdated,
    BulkDueDateItem,
    BulkStatusItem,
    BulkTaskError,
    BulkTaskResponse,
    BulkTaskUpdated,
    CombinedTaskUpdateRequest,
    PIIAnnotation,
    TaskActivityItem,
    TaskActivityResponse,
    TaskAudioAlignmentResponse,
    TaskDetailResponse,
    TaskListItemResponse,
    TaskListResponse,
    TaskMaskedAudioResponse,
    TaskPatchResponse,
)
from app.services.audio_alignment_service import AudioAlignmentService, transcript_hash
from app.services.errors import ServiceError
from app.services.text_validation import find_invalid_annotation_text

ALLOWED_STATUS_TRANSITIONS: dict[TaskStatusEnum, set[TaskStatusEnum]] = {
    TaskStatusEnum.NOT_STARTED: {TaskStatusEnum.IN_PROGRESS},
    TaskStatusEnum.IN_PROGRESS: {TaskStatusEnum.NOT_STARTED, TaskStatusEnum.COMPLETED},
    TaskStatusEnum.COMPLETED: {TaskStatusEnum.IN_PROGRESS, TaskStatusEnum.NEEDS_REVIEW},
    TaskStatusEnum.NEEDS_REVIEW: {
        TaskStatusEnum.IN_PROGRESS,
        TaskStatusEnum.REVIEWED,
        TaskStatusEnum.APPROVED,
        TaskStatusEnum.REJECTED,
    },
    TaskStatusEnum.REVIEWED: {TaskStatusEnum.IN_PROGRESS, TaskStatusEnum.APPROVED, TaskStatusEnum.REJECTED},
    TaskStatusEnum.APPROVED: {TaskStatusEnum.IN_PROGRESS},
    TaskStatusEnum.REJECTED: {TaskStatusEnum.IN_PROGRESS},
}

AUTO_START_COMMENT = "Automatically moved to In Progress when work started"


def _raise_for_invalid_text(value: str | None, field_label: str) -> None:
    message = find_invalid_annotation_text(value, field_label)
    if message:
        raise ServiceError(message, status_code=422)


class TaskService:
    def __init__(self, db: Session):
        self.db = db
        self.task_repo = TaskRepository(db)
        self.user_repo = UserRepository(db)
        self.audio_alignment_service = AudioAlignmentService()

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
        current_user: User,
    ) -> TaskListResponse:
        if current_user.role == RoleEnum.CANDIDATE:
            raise ServiceError("Candidates cannot access annotation tasks", status_code=403)
        effective_assignee_id = assignee_id
        if current_user.role != RoleEnum.ADMIN:
            effective_assignee_id = current_user.id
        items, total = self.task_repo.list_tasks(
            status=status,
            search=search,
            assignee_id=effective_assignee_id,
            upload_job_id=upload_job_id,
            language=language,
            date_from=date_from,
            date_to=date_to,
            page=page,
            page_size=page_size,
        )
        counts = self.task_repo.get_status_counts(assignee_id=effective_assignee_id)
        return TaskListResponse(
            items=[self._to_task_list_item(task, viewer=current_user) for task in items],
            page=page,
            page_size=page_size,
            total=total,
            status_counts=counts,
        )

    def get_task_detail(self, task_id: str, *, actor: User) -> TaskDetailResponse:
        task = self._get_task_or_404(task_id, actor=actor)
        return self._to_task_detail(task, viewer=actor)

    def get_next_task(self, *, actor: User) -> str | None:
        if actor.role == RoleEnum.CANDIDATE:
            raise ServiceError("Candidates cannot access annotation tasks", status_code=403)
        assignee_id = actor.id if actor.role != RoleEnum.ADMIN else None
        return self.task_repo.get_next_unfinished_task(assignee_id=assignee_id)

    def save_combined_task(
        self,
        *,
        task_id: str,
        payload: CombinedTaskUpdateRequest,
        provided_fields: set[str],
        actor: User,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor)
        update_fields = provided_fields - {"version", "comment"}
        if not update_fields:
            raise ServiceError("No task fields provided for update", status_code=422)
        if "due_date" in update_fields and actor.role != RoleEnum.ADMIN:
            raise ServiceError("Only admins can update due dates", status_code=403)
        if "final_transcript" in update_fields:
            _raise_for_invalid_text(payload.final_transcript, "transcript")
        if "notes" in update_fields:
            _raise_for_invalid_text(payload.notes, "notes")
        if "comment" in provided_fields:
            _raise_for_invalid_text(payload.comment, "comment")
        self._ensure_version(task, payload.version, sorted(update_fields), actor=actor)

        previous_values: dict[str, Any] = {}
        new_values: dict[str, Any] = {}
        changed_fields: list[str] = []
        old_status = task.status
        status_changed = False

        simple_fields = {
            "final_transcript": payload.final_transcript,
            "notes": payload.notes,
            "speaker_gender": payload.speaker_gender,
            "speaker_role": payload.speaker_role,
            "language": payload.language,
            "channel": payload.channel,
            "duration_seconds": payload.duration_seconds,
            "due_date": payload.due_date,
            "custom_metadata": payload.custom_metadata,
        }

        for field_name, new_value in simple_fields.items():
            if field_name not in update_fields:
                continue
            old_value = getattr(task, field_name)
            if old_value != new_value:
                previous_values[field_name] = old_value
                new_values[field_name] = new_value
                setattr(task, field_name, new_value)
                changed_fields.append(field_name)
                if field_name == "final_transcript":
                    self._clear_audio_alignment(task)

        if "status" in update_fields:
            if payload.status is None:
                raise ServiceError("Status cannot be null", status_code=422)
            self._validate_status_transition(task.status, payload.status, actor)
            if task.status != payload.status:
                previous_values["status"] = task.status.value
                new_values["status"] = payload.status.value
                task.status = payload.status
                changed_fields.append("status")
                status_changed = True

        if "pii_annotations" in update_fields:
            normalized_annotations = self._normalize_pii_annotations(
                pii_annotations=payload.pii_annotations or [],
                transcript=task.final_transcript or "",
            )
            if (task.pii_annotations or []) != normalized_annotations:
                previous_values["pii_annotations"] = task.pii_annotations or []
                new_values["pii_annotations"] = normalized_annotations
                task.pii_annotations = normalized_annotations
                changed_fields.append("pii_annotations")
                self._clear_masked_audio(task)

        if not changed_fields:
            return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

        self._mark_tagger(task, actor)
        if "status" not in update_fields:
            auto_started_from = self._auto_start_task_if_needed(task, actor)
            if auto_started_from:
                previous_values["status"] = auto_started_from.value
                new_values["status"] = task.status.value
                changed_fields.append("status")
                old_status = auto_started_from
                status_changed = True
        task = self.task_repo.save_task(task)
        if status_changed:
            self.task_repo.add_status_history(
                task_id=task.id,
                old_status=old_status,
                new_status=task.status,
                changed_by_id=actor.id,
                comment=payload.comment if "status" in update_fields else AUTO_START_COMMENT,
            )
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="UPDATE_TASK",
            changed_fields={field: True for field in changed_fields},
            previous_values=previous_values,
            new_values={**new_values, **({"comment": payload.comment} if payload.comment else {})},
        )
        self.db.commit()
        return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

    def update_transcript(
        self,
        *,
        task_id: str,
        version: int,
        final_transcript: str,
        actor: User,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor)
        _raise_for_invalid_text(final_transcript, "transcript")
        self._ensure_version(task, version, ["final_transcript"], actor=actor)
        previous = {"final_transcript": task.final_transcript}
        new_values = {"final_transcript": final_transcript}
        changed_fields = {"final_transcript": True}
        task.final_transcript = final_transcript
        self._clear_audio_alignment(task)
        self._mark_tagger(task, actor)
        auto_started_from = self._auto_start_task_if_needed(task, actor)
        if auto_started_from:
            previous["status"] = auto_started_from.value
            new_values["status"] = task.status.value
            changed_fields["status"] = True
        task = self.task_repo.save_task(task)
        self._add_auto_start_history_if_needed(task, actor, auto_started_from)
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="UPDATE_TRANSCRIPT",
            changed_fields=changed_fields,
            previous_values=previous,
            new_values=new_values,
        )
        self.db.commit()
        return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

    def update_metadata(
        self,
        *,
        task_id: str,
        version: int,
        speaker_gender: str | None,
        speaker_role: str | None,
        language: str | None,
        channel: str | None,
        duration_seconds: Decimal | None,
        custom_metadata: dict[str, Any] | None,
        provided_fields: set[str] | None,
        actor: User,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor)
        changed_fields = []
        previous_values: dict[str, Any] = {}
        new_values: dict[str, Any] = {}

        payload_fields = {
            "speaker_gender": speaker_gender,
            "speaker_role": speaker_role,
            "language": language,
            "channel": channel,
            "duration_seconds": duration_seconds,
            "custom_metadata": custom_metadata,
        }

        provided = set(payload_fields.keys()) if provided_fields is None else provided_fields
        included_fields = [key for key in payload_fields if key in provided]
        if not included_fields:
            raise ServiceError("No metadata fields provided for update", status_code=422)
        self._ensure_version(task, version, included_fields, actor=actor)

        for field_name, new_value in payload_fields.items():
            if field_name not in provided:
                continue
            old_value = getattr(task, field_name)
            if old_value != new_value:
                previous_values[field_name] = old_value
                new_values[field_name] = new_value
                setattr(task, field_name, new_value)
                changed_fields.append(field_name)

        if not changed_fields:
            return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

        self._mark_tagger(task, actor)
        auto_started_from = self._auto_start_task_if_needed(task, actor)
        if auto_started_from:
            previous_values["status"] = auto_started_from.value
            new_values["status"] = task.status.value
            changed_fields.append("status")
        task = self.task_repo.save_task(task)
        self._add_auto_start_history_if_needed(task, actor, auto_started_from)
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="UPDATE_METADATA",
            changed_fields={field: True for field in changed_fields},
            previous_values=previous_values,
            new_values=new_values,
        )
        self.db.commit()
        return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

    def update_notes(
        self,
        *,
        task_id: str,
        version: int,
        notes: str | None,
        actor: User,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor)
        _raise_for_invalid_text(notes, "notes")
        self._ensure_version(task, version, ["notes"], actor=actor)
        previous = {"notes": task.notes}
        new_values = {"notes": notes}
        changed_fields = {"notes": True}
        task.notes = notes
        self._mark_tagger(task, actor)
        auto_started_from = self._auto_start_task_if_needed(task, actor)
        if auto_started_from:
            previous["status"] = auto_started_from.value
            new_values["status"] = task.status.value
            changed_fields["status"] = True
        task = self.task_repo.save_task(task)
        self._add_auto_start_history_if_needed(task, actor, auto_started_from)
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="UPDATE_NOTES",
            changed_fields=changed_fields,
            previous_values=previous,
            new_values=new_values,
        )
        self.db.commit()
        return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

    def update_status(
        self,
        *,
        task_id: str,
        version: int,
        new_status: TaskStatusEnum,
        actor: User,
        comment: str | None = None,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor)
        _raise_for_invalid_text(comment, "comment")
        self._ensure_version(task, version, ["status"], actor=actor)
        old_status = task.status

        self._validate_status_transition(old_status, new_status, actor)

        task.status = new_status
        self._mark_tagger(task, actor)
        task = self.task_repo.save_task(task)
        self.task_repo.add_status_history(
            task_id=task.id,
            old_status=old_status,
            new_status=new_status,
            changed_by_id=actor.id,
            comment=comment,
        )
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="UPDATE_STATUS",
            changed_fields={"status": True},
            previous_values={"status": old_status.value},
            new_values={"status": new_status.value, "comment": comment},
        )
        self.db.commit()
        return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

    def update_pii_annotations(
        self,
        *,
        task_id: str,
        version: int,
        pii_annotations: list[PIIAnnotation],
        actor: User,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor)
        self._ensure_version(task, version, ["pii_annotations"], actor=actor)

        normalized_annotations = self._normalize_pii_annotations(
            pii_annotations=pii_annotations,
            transcript=task.final_transcript or "",
        )
        previous = {"pii_annotations": task.pii_annotations or []}

        if previous["pii_annotations"] == normalized_annotations:
            return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

        task.pii_annotations = normalized_annotations
        self._clear_masked_audio(task)
        self._mark_tagger(task, actor)
        new_values = {"pii_annotations": normalized_annotations}
        changed_fields = {"pii_annotations": True}
        auto_started_from = self._auto_start_task_if_needed(task, actor)
        if auto_started_from:
            previous["status"] = auto_started_from.value
            new_values["status"] = task.status.value
            changed_fields["status"] = True
        task = self.task_repo.save_task(task)
        self._add_auto_start_history_if_needed(task, actor, auto_started_from)
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="UPDATE_PII_ANNOTATIONS",
            changed_fields=changed_fields,
            previous_values=previous,
            new_values=new_values,
        )
        self.db.commit()
        return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

    def update_assignee(
        self,
        *,
        task_id: str,
        version: int,
        assignee_id: str | None,
        actor: User,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor)
        self._ensure_version(task, version, ["assignee_id"], actor=actor)

        assignee = self._get_valid_task_assignee(assignee_id) if assignee_id else None

        if task.assignee_id == assignee_id:
            return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

        previous_values = {
            "assignee_id": task.assignee_id,
            "assignee_name": task.assignee.full_name if task.assignee else None,
            "assignee_email": task.assignee.email if task.assignee else None,
        }
        task.assignee_id = assignee_id
        task = self.task_repo.save_task(task)
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="UPDATE_ASSIGNEE",
            changed_fields={"assignee_id": True},
            previous_values=previous_values,
            new_values={
                "assignee_id": assignee.id if assignee else None,
                "assignee_name": assignee.full_name if assignee else None,
                "assignee_email": assignee.email if assignee else None,
            },
        )
        self.db.commit()
        return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

    def create_assignment_copy(
        self,
        *,
        task_id: str,
        version: int,
        assignee_id: str,
        actor: User,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor)
        self._ensure_version(task, version, ["assignee_id"], actor=actor)
        assignee = self._get_valid_task_assignee(assignee_id)
        if task.assignee_id == assignee.id:
            raise ServiceError("This audio is already assigned to that user", status_code=409)
        existing = self.task_repo.get_existing_parallel_assignment(
            upload_job_id=task.upload_job_id,
            file_location=task.file_location,
            assignee_id=assignee.id,
            exclude_task_id=task.id,
        )
        if existing:
            raise ServiceError("This audio is already assigned to that user", status_code=409)

        copied_task = self.task_repo.create_parallel_assignment_copy(
            source_task=task,
            external_id=self._next_parallel_assignment_external_id(task, assignee),
            assignee_id=assignee.id,
        )
        self.task_repo.add_audit_log(
            task_id=copied_task.id,
            actor_user_id=actor.id,
            action="CREATE_PARALLEL_ASSIGNMENT",
            changed_fields={"assignee_id": True, "source_task_id": True, "file_location": True},
            previous_values={},
            new_values={
                "source_task_id": task.id,
                "source_external_id": task.external_id,
                "assignee_id": assignee.id,
                "assignee_name": assignee.full_name,
                "assignee_email": assignee.email,
                "file_location": task.file_location,
            },
        )
        self.db.commit()
        return TaskPatchResponse(task=self._to_task_detail(copied_task, viewer=actor))

    def update_due_date(
        self,
        *,
        task_id: str,
        version: int,
        due_date: date | None,
        actor: User,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor)
        self._ensure_version(task, version, ["due_date"], actor=actor)
        if task.due_date == due_date:
            return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

        previous_values = {"due_date": task.due_date}
        task.due_date = due_date
        task = self.task_repo.save_task(task)
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="UPDATE_DUE_DATE",
            changed_fields={"due_date": True},
            previous_values=previous_values,
            new_values={"due_date": due_date},
        )
        self.db.commit()
        return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

    def claim_task(self, *, task_id: str, actor: User) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id)
        if task.assignee_id:
            raise ServiceError("Task is already assigned", status_code=409)
        task.assignee_id = actor.id
        auto_started_from = self._auto_start_task_if_needed(task, actor)
        task = self.task_repo.save_task(task)
        self._add_auto_start_history_if_needed(task, actor, auto_started_from)
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="CLAIM_TASK",
            changed_fields={
                "assignee_id": True,
                **({"status": True} if auto_started_from else {}),
            },
            previous_values={
                "assignee_id": None,
                **({"status": auto_started_from.value} if auto_started_from else {}),
            },
            new_values={
                "assignee_id": actor.id,
                "assignee_name": actor.full_name,
                "assignee_email": actor.email,
                **({"status": task.status.value} if auto_started_from else {}),
            },
        )
        self.db.commit()
        return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

    def claim_next_task(self, *, actor: User) -> TaskPatchResponse | None:
        task = self.task_repo.get_next_unassigned_task()
        if not task:
            return None
        return self.claim_task(task_id=task.id, actor=actor)

    def start_task(self, *, task_id: str, actor: User) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id)
        if task.status == TaskStatusEnum.APPROVED:
            raise ServiceError("Approved tasks cannot be started", status_code=409)
        if task.assignee_id != actor.id:
            raise ServiceError("Task is not assigned to you", status_code=403)

        changed_fields: dict[str, bool] = {}
        previous_values: dict[str, Any] = {}
        new_values: dict[str, Any] = {}

        auto_started_from = self._auto_start_task_if_needed(task, actor)
        if auto_started_from:
            changed_fields["status"] = True
            previous_values["status"] = auto_started_from.value
            new_values["status"] = task.status.value

        if not changed_fields:
            return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

        task = self.task_repo.save_task(task)
        self._add_auto_start_history_if_needed(task, actor, auto_started_from)
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="START_TASK",
            changed_fields=changed_fields,
            previous_values=previous_values,
            new_values=new_values,
        )
        self.db.commit()
        return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

    def bulk_update_assignees(self, *, assignments: list[BulkAssigneeItem], actor: User) -> BulkAssigneeResponse:
        updated: list[BulkAssigneeUpdated] = []
        errors: list[BulkAssigneeError] = []
        for item in assignments:
            try:
                response = self.update_assignee(
                    task_id=item.task_id,
                    version=item.version,
                    assignee_id=item.assignee_id,
                    actor=actor,
                )
                updated.append(BulkAssigneeUpdated(task=response.task))
            except ServiceError as exc:
                errors.append(BulkAssigneeError(task_id=item.task_id, status_code=exc.status_code, message=exc.message))
        return BulkAssigneeResponse(updated=updated, errors=errors)

    def bulk_create_assignment_copies(
        self,
        *,
        assignments: list[BulkAssignmentCopyItem],
        actor: User,
    ) -> BulkAssignmentCopyResponse:
        created: list[BulkAssigneeUpdated] = []
        errors: list[BulkAssigneeError] = []
        for item in assignments:
            try:
                response = self.create_assignment_copy(
                    task_id=item.task_id,
                    version=item.version,
                    assignee_id=item.assignee_id,
                    actor=actor,
                )
                created.append(BulkAssigneeUpdated(task=response.task))
            except ServiceError as exc:
                errors.append(BulkAssigneeError(task_id=item.task_id, status_code=exc.status_code, message=exc.message))
        return BulkAssignmentCopyResponse(created=created, errors=errors)

    def bulk_update_due_dates(self, *, updates: list[BulkDueDateItem], actor: User) -> BulkTaskResponse:
        updated: list[BulkTaskUpdated] = []
        errors: list[BulkTaskError] = []
        for item in updates:
            try:
                response = self.update_due_date(
                    task_id=item.task_id,
                    version=item.version,
                    due_date=item.due_date,
                    actor=actor,
                )
                updated.append(BulkTaskUpdated(task=response.task))
            except ServiceError as exc:
                errors.append(BulkTaskError(task_id=item.task_id, status_code=exc.status_code, message=exc.message))
        return BulkTaskResponse(updated=updated, errors=errors)

    def bulk_update_statuses(
        self,
        *,
        updates: list[BulkStatusItem],
        new_status: TaskStatusEnum,
        actor: User,
        comment: str | None = None,
    ) -> BulkTaskResponse:
        updated: list[BulkTaskUpdated] = []
        errors: list[BulkTaskError] = []
        for item in updates:
            try:
                response = self.update_status(
                    task_id=item.task_id,
                    version=item.version,
                    new_status=new_status,
                    actor=actor,
                    comment=comment,
                )
                updated.append(BulkTaskUpdated(task=response.task))
            except ServiceError as exc:
                errors.append(BulkTaskError(task_id=item.task_id, status_code=exc.status_code, message=exc.message))
        return BulkTaskResponse(updated=updated, errors=errors)

    def get_activity(self, task_id: str, *, actor: User) -> TaskActivityResponse:
        self._get_task_or_404(task_id, actor=actor)
        items = [TaskActivityItem(**item) for item in self.task_repo.list_activity(task_id)]
        return TaskActivityResponse(items=items)

    def generate_audio_url(self, task_id: str, *, actor: User) -> tuple[str, int]:
        from itsdangerous import URLSafeTimedSerializer

        from app.core.config import get_settings

        task = self._get_task_or_404(task_id, actor=actor)
        settings = get_settings()
        serializer = URLSafeTimedSerializer(settings.audio_signing_secret)
        token = serializer.dumps(
            {
                "task_id": task.id,
                "file_location": task.file_location,
                "actor_user_id": actor.id,
                "masked": False,
            }
        )
        url = f"{settings.api_v1_prefix}/media/audio/{token}"
        return url, settings.audio_signing_expire_seconds

    def generate_alignment(self, task_id: str, *, actor: User, force: bool = False) -> TaskAudioAlignmentResponse:
        task = self._get_task_or_404(task_id, actor=actor)
        words = self.audio_alignment_service.align_task_audio(task, force=force)
        self.db.flush()
        self.db.commit()
        return TaskAudioAlignmentResponse(
            task_id=task.id,
            transcript_hash=task.alignment_transcript_hash or transcript_hash(task.final_transcript or ""),
            model=task.alignment_model or "unknown",
            words=[AudioAlignmentWord(**word) for word in words],
            generated_at=task.alignment_updated_at or datetime.now(timezone.utc),
        )

    def generate_masked_pii_audio(
        self,
        task_id: str,
        *,
        actor: User,
        force: bool = False,
        mask_mode: AudioMaskMode = "silence",
        custom_intervals: list[AudioMaskInterval] | None = None,
    ) -> TaskMaskedAudioResponse:
        from itsdangerous import URLSafeTimedSerializer

        from app.core.config import get_settings

        task = self._get_task_or_404(task_id, actor=actor)
        masked_audio_location, intervals = self.audio_alignment_service.build_pii_masked_audio(
            task,
            force=force,
            mask_mode=mask_mode,
            custom_intervals=[interval.model_dump(exclude_none=True) for interval in custom_intervals]
            if custom_intervals
            else None,
        )
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="MASK_PII_AUDIO",
            changed_fields={"masked_audio_location": True},
            previous_values={},
            new_values={
                "masked_audio_location": masked_audio_location,
                "masked_intervals": intervals,
                "mask_mode": mask_mode,
                "custom_intervals": bool(custom_intervals),
            },
        )
        self.db.flush()
        self.db.commit()

        settings = get_settings()
        serializer = URLSafeTimedSerializer(settings.audio_signing_secret)
        token = serializer.dumps(
            {
                "task_id": task.id,
                "file_location": masked_audio_location,
                "actor_user_id": actor.id,
                "masked": True,
            }
        )
        url = f"{settings.api_v1_prefix}/media/audio/{token}"
        return TaskMaskedAudioResponse(
            task_id=task.id,
            masked_audio_url=url,
            mask_mode=mask_mode,
            expires_in_seconds=settings.audio_signing_expire_seconds,
            masked_intervals=[AudioMaskInterval(**interval) for interval in intervals],
            accepted_intervals=[
                AudioMaskInterval(**interval) for interval in (task.masked_audio_reference_intervals or [])
            ],
            alignment_intervals=[
                AudioMaskInterval(**interval) for interval in (task.masked_audio_alignment_intervals or [])
            ],
            words=[AudioAlignmentWord(**word) for word in task.alignment_words],
            generated_at=task.masked_audio_updated_at or datetime.now(timezone.utc),
        )

    def _get_task_or_404(self, task_id: str, *, actor: User | None = None) -> AnnotationTask:
        task = self.task_repo.get_task(task_id)
        if not task:
            raise ServiceError("Task not found", status_code=404)
        if actor and actor.role == RoleEnum.CANDIDATE:
            raise ServiceError("Candidates cannot access annotation tasks", status_code=403)
        if actor and actor.role != RoleEnum.ADMIN and task.assignee_id != actor.id:
            raise ServiceError("Task is not assigned to you", status_code=403)
        return task

    def _get_valid_task_assignee(self, assignee_id: str) -> User:
        assignee = self.user_repo.get_by_id(assignee_id)
        if not assignee:
            raise ServiceError("Assignee user not found", status_code=404)
        if assignee.role not in {RoleEnum.ANNOTATOR, RoleEnum.REVIEWER, RoleEnum.ADMIN}:
            raise ServiceError("Assignee role is not valid for task assignment", status_code=422)
        return assignee

    def _next_parallel_assignment_external_id(self, source_task: AnnotationTask, assignee: User) -> str:
        safe_email = "".join(char if char.isalnum() else "-" for char in assignee.email.lower()).strip("-")
        suffix = f"copy-{safe_email[:48]}-{uuid.uuid4().hex[:8]}"
        prefix_length = max(1, 255 - len(suffix) - 2)
        base = source_task.external_id[:prefix_length].rstrip(" -_")
        external_id = f"{base}__{suffix}"
        while self.task_repo.external_id_exists(upload_job_id=source_task.upload_job_id, external_id=external_id):
            suffix = f"copy-{safe_email[:48]}-{uuid.uuid4().hex[:8]}"
            prefix_length = max(1, 255 - len(suffix) - 2)
            base = source_task.external_id[:prefix_length].rstrip(" -_")
            external_id = f"{base}__{suffix}"
        return external_id

    def _to_task_detail(self, task: AnnotationTask, *, viewer: User | None = None) -> TaskDetailResponse:
        assignee_scope = viewer.id if viewer and viewer.role != RoleEnum.ADMIN else None
        prev_task_id, next_task_id = self.task_repo.get_prev_next_task_ids(task, assignee_id=assignee_scope)
        return TaskDetailResponse(
            id=task.id,
            external_id=task.external_id,
            file_location=self._display_file_location(task.file_location, viewer),
            final_transcript=task.final_transcript,
            notes=task.notes,
            status=task.status,
            speaker_gender=task.speaker_gender,
            speaker_role=task.speaker_role,
            language=task.language,
            channel=task.channel,
            duration_seconds=task.duration_seconds,
            custom_metadata=task.custom_metadata or {},
            original_row=task.original_row or {},
            pii_annotations=task.pii_annotations or [],
            assignee_id=task.assignee_id,
            assignee_name=task.assignee.full_name if task.assignee else None,
            assignee_email=task.assignee.email if task.assignee else None,
            last_tagger_id=task.last_tagger_id,
            last_tagger_name=task.last_tagger.full_name if task.last_tagger else None,
            last_tagger_email=task.last_tagger.email if task.last_tagger else None,
            version=task.version,
            created_at=task.created_at,
            updated_at=task.updated_at,
            last_saved_at=task.last_saved_at,
            due_date=task.due_date,
            transcript_variants=task.transcript_variants,
            alignment_words=task.alignment_words or [],
            alignment_model=task.alignment_model,
            alignment_updated_at=task.alignment_updated_at,
            masked_audio_available=bool(task.masked_audio_location),
            masked_audio_updated_at=task.masked_audio_updated_at,
            masked_audio_intervals=task.masked_audio_intervals or [],
            masked_audio_reference_intervals=task.masked_audio_reference_intervals or [],
            masked_audio_alignment_intervals=task.masked_audio_alignment_intervals or [],
            masked_audio_mode=task.masked_audio_mode,
            prev_task_id=prev_task_id,
            next_task_id=next_task_id,
        )

    def _to_task_list_item(self, task: AnnotationTask, *, viewer: User | None = None) -> TaskListItemResponse:
        return TaskListItemResponse(
            id=task.id,
            external_id=task.external_id,
            file_location=self._display_file_location(task.file_location, viewer),
            status=task.status,
            assignee_id=task.assignee_id,
            assignee_name=task.assignee.full_name if task.assignee else None,
            assignee_email=task.assignee.email if task.assignee else None,
            last_tagger_id=task.last_tagger_id,
            last_tagger_name=task.last_tagger.full_name if task.last_tagger else None,
            last_tagger_email=task.last_tagger.email if task.last_tagger else None,
            updated_at=task.updated_at,
            last_saved_at=task.last_saved_at,
            due_date=task.due_date,
            language=task.language,
            speaker_role=task.speaker_role,
            version=task.version,
        )

    def _normalize_pii_annotations(
        self,
        *,
        pii_annotations: list[PIIAnnotation],
        transcript: str,
    ) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        transcript_length = len(transcript)

        for annotation in pii_annotations:
            if annotation.end > transcript_length:
                raise ServiceError(
                    "PII annotation range exceeds transcript length",
                    status_code=422,
                )
            extracted_value = transcript[annotation.start : annotation.end]
            if not extracted_value.strip():
                raise ServiceError(
                    "PII annotation value cannot be empty",
                    status_code=422,
                )

            normalized.append(
                {
                    "id": annotation.id,
                    "label": annotation.label,
                    "start": annotation.start,
                    "end": annotation.end,
                    "value": extracted_value,
                    "source": annotation.source,
                    "confidence": annotation.confidence,
                }
            )

        normalized.sort(key=lambda item: (item["start"], item["end"], item["id"]))
        return normalized

    def _display_file_location(self, file_location: str, viewer: User | None) -> str:
        if viewer is None or viewer.role == RoleEnum.ADMIN:
            return file_location
        parsed = urlparse(file_location)
        candidate = parsed.path or file_location
        basename = PurePosixPath(candidate).name
        return basename or "Audio source hidden"

    def _ensure_version(
        self,
        task: AnnotationTask,
        version: int,
        conflicting_fields: list[str],
        *,
        actor: User | None = None,
    ) -> None:
        if task.version != version:
            server_task = self._to_task_detail(task, viewer=actor)
            raise ServiceError(
                "Conflict detected. The task has been updated by another user.",
                status_code=409,
                extra={
                    "conflicting_fields": conflicting_fields,
                    "server_task": server_task.model_dump(mode="json"),
                },
            )

    def _validate_status_transition(
        self,
        old_status: TaskStatusEnum,
        new_status: TaskStatusEnum,
        actor: User,
    ) -> None:
        if new_status == old_status:
            return
        if actor.role == RoleEnum.ADMIN:
            return
        allowed = ALLOWED_STATUS_TRANSITIONS.get(old_status, set())
        if new_status not in allowed:
            raise ServiceError(
                f"Invalid status transition from '{old_status.value}' to '{new_status.value}'",
                status_code=422,
            )
        if (
            new_status == TaskStatusEnum.IN_PROGRESS
            and old_status in {
                TaskStatusEnum.NEEDS_REVIEW,
                TaskStatusEnum.REVIEWED,
                TaskStatusEnum.APPROVED,
                TaskStatusEnum.REJECTED,
            }
            and actor.role not in {RoleEnum.ADMIN, RoleEnum.REVIEWER}
        ):
            raise ServiceError(
                "Only reviewer/admin can move reviewed tasks back to In Progress",
                status_code=403,
            )
        if new_status in {TaskStatusEnum.REVIEWED, TaskStatusEnum.APPROVED, TaskStatusEnum.REJECTED} and actor.role not in {
            RoleEnum.ADMIN,
            RoleEnum.REVIEWER,
        }:
            raise ServiceError("Only reviewer/admin can make review decisions", status_code=403)

    def _auto_start_task_if_needed(self, task: AnnotationTask, actor: User) -> TaskStatusEnum | None:
        if task.status != TaskStatusEnum.NOT_STARTED:
            return None
        if actor.role not in {RoleEnum.ANNOTATOR, RoleEnum.REVIEWER}:
            return None
        old_status = task.status
        task.status = TaskStatusEnum.IN_PROGRESS
        return old_status

    def _add_auto_start_history_if_needed(
        self,
        task: AnnotationTask,
        actor: User,
        old_status: TaskStatusEnum | None,
    ) -> None:
        if not old_status:
            return
        self.task_repo.add_status_history(
            task_id=task.id,
            old_status=old_status,
            new_status=task.status,
            changed_by_id=actor.id,
            comment=AUTO_START_COMMENT,
        )

    def _mark_tagger(self, task: AnnotationTask, actor: User) -> None:
        task.last_tagger_id = actor.id

    def _clear_audio_alignment(self, task: AnnotationTask) -> None:
        task.alignment_words = []
        task.alignment_transcript_hash = None
        task.alignment_model = None
        task.alignment_updated_at = None
        self._clear_masked_audio(task)

    def _clear_masked_audio(self, task: AnnotationTask) -> None:
        task.masked_audio_location = None
        task.masked_audio_pii_hash = None
        task.masked_audio_updated_at = None
        task.masked_audio_intervals = []
        task.masked_audio_reference_intervals = []
        task.masked_audio_alignment_intervals = []
        task.masked_audio_mode = None
