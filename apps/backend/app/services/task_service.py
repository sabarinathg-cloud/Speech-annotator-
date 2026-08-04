import hashlib
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from app.models.enums import RoleEnum, TaskStatusEnum, TaskWorkflowTypeEnum
from app.models.organization import Organization
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
    BulkAutoBalanceResponse,
    BulkAssigneeError,
    BulkAssigneeItem,
    BulkAssigneeResponse,
    BulkAssigneeUpdated,
    BulkCallSplitAssignment,
    BulkCallSplitResponse,
    BulkTaskFilter,
    BulkDueDateItem,
    BulkStatusItem,
    BulkTaskError,
    BulkTaskResponse,
    BulkTaskUpdated,
    CombinedTaskUpdateRequest,
    PIIAnnotation,
    TaskActivityItem,
    TaskActivityResponse,
    TaskAudioGroupChunkResponse,
    TaskAudioGroupResponse,
    TaskAudioAlignmentResponse,
    TaskDetailResponse,
    TaskListItemResponse,
    TaskListResponse,
    TaskMaskedAudioResponse,
    TaskPatchResponse,
    UpdateAudioGroupTranscriptRequest,
    UpdateQuestionnaireAnswersRequest,
)
from app.services.audio_alignment_service import AudioAlignmentService, transcript_hash
from app.services.audio_group_service import audio_group_info, audio_group_sort_key
from app.services.errors import ServiceError
from app.services.organization_service import OrganizationService
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
MAX_AUDIO_GROUP_CHUNKS = 1000


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
        organization: Organization,
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
            organization_id=organization.id,
            page=page,
            page_size=page_size,
        )
        counts = self.task_repo.get_status_counts(assignee_id=effective_assignee_id, organization_id=organization.id)
        return TaskListResponse(
            items=[self._to_task_list_item(task, viewer=current_user) for task in items],
            page=page,
            page_size=page_size,
            total=total,
            status_counts=counts,
        )

    def get_task_detail(self, task_id: str, *, actor: User, organization: Organization) -> TaskDetailResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        return self._to_task_detail(task, viewer=actor)

    def get_next_task(self, *, actor: User, organization: Organization) -> str | None:
        if actor.role == RoleEnum.CANDIDATE:
            raise ServiceError("Candidates cannot access annotation tasks", status_code=403)
        if actor.role == RoleEnum.ADMIN:
            assignee_id = "unassigned"
        else:
            assignee_id = actor.id
        return self.task_repo.get_next_unfinished_task(assignee_id=assignee_id, organization_id=organization.id)

    def save_combined_task(
        self,
        *,
        task_id: str,
        payload: CombinedTaskUpdateRequest,
        provided_fields: set[str],
        actor: User,
        organization: Organization,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        update_fields = provided_fields - {"version", "comment"}
        if not update_fields:
            raise ServiceError("No task fields provided for update", status_code=422)
        self._guard_workflow_updates(task, update_fields)
        self._guard_feature_updates(update_fields, organization)
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
            if payload.status == TaskStatusEnum.COMPLETED:
                self._validate_questionnaire_completion(task, task.questionnaire_answers or {})
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
        organization: Organization,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        self._ensure_transcript_correction_task(task)
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
        organization: Organization,
    ) -> TaskPatchResponse:
        if not organization.metadata_enabled:
            raise ServiceError("Metadata is disabled for this organization", status_code=403)
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        self._ensure_transcript_correction_task(task)
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
        organization: Organization,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
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
        organization: Organization,
        comment: str | None = None,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        _raise_for_invalid_text(comment, "comment")
        self._ensure_version(task, version, ["status"], actor=actor)
        old_status = task.status

        self._validate_status_transition(old_status, new_status, actor)
        if new_status == TaskStatusEnum.COMPLETED:
            self._validate_questionnaire_completion(task, task.questionnaire_answers or {})

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
        organization: Organization,
    ) -> TaskPatchResponse:
        if not organization.pii_enabled:
            raise ServiceError("PII annotation is disabled for this organization", status_code=403)
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        self._ensure_transcript_correction_task(task)
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

    def update_questionnaire_answers(
        self,
        *,
        task_id: str,
        payload: UpdateQuestionnaireAnswersRequest,
        actor: User,
        organization: Organization,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        self._ensure_audio_comparison_task(task)
        _raise_for_invalid_text(payload.comment, "comment")
        self._ensure_version(task, payload.version, ["questionnaire_answers"], actor=actor)

        normalized_answers = self._normalize_questionnaire_answers(
            task,
            payload.questionnaire_answers or {},
            completing=payload.status == TaskStatusEnum.COMPLETED,
        )
        old_status = task.status
        status_changed = False
        if payload.status is not None:
            self._validate_status_transition(task.status, payload.status, actor)
            if payload.status == TaskStatusEnum.COMPLETED:
                self._validate_questionnaire_completion(task, normalized_answers)
            if task.status != payload.status:
                status_changed = True

        previous_values: dict[str, Any] = {}
        new_values: dict[str, Any] = {}
        changed_fields: dict[str, bool] = {}

        if (task.questionnaire_answers or {}) != normalized_answers:
            previous_values["questionnaire_answers"] = task.questionnaire_answers or {}
            new_values["questionnaire_answers"] = normalized_answers
            changed_fields["questionnaire_answers"] = True
            task.questionnaire_answers = normalized_answers

        if payload.status is not None and status_changed:
            previous_values["status"] = old_status.value
            new_values["status"] = payload.status.value
            changed_fields["status"] = True
            task.status = payload.status

        if not changed_fields:
            return TaskPatchResponse(task=self._to_task_detail(task, viewer=actor))

        self._mark_tagger(task, actor)
        auto_started_from = None
        if payload.status is None:
            auto_started_from = self._auto_start_task_if_needed(task, actor)
            if auto_started_from:
                previous_values["status"] = auto_started_from.value
                new_values["status"] = task.status.value
                changed_fields["status"] = True
                old_status = auto_started_from
                status_changed = True

        task = self.task_repo.save_task(task)
        if status_changed:
            self.task_repo.add_status_history(
                task_id=task.id,
                old_status=old_status,
                new_status=task.status,
                changed_by_id=actor.id,
                comment=payload.comment if payload.status is not None else AUTO_START_COMMENT,
            )
        self.task_repo.add_audit_log(
            task_id=task.id,
            actor_user_id=actor.id,
            action="UPDATE_QUESTIONNAIRE_ANSWERS",
            changed_fields=changed_fields,
            previous_values=previous_values,
            new_values={**new_values, **({"comment": payload.comment} if payload.comment else {})},
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
        organization: Organization,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        self._ensure_version(task, version, ["assignee_id"], actor=actor)

        assignee = self._get_valid_task_assignee(assignee_id, organization_id=organization.id) if assignee_id else None

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
        organization: Organization,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        self._ensure_version(task, version, ["assignee_id"], actor=actor)
        assignee = self._get_valid_task_assignee(assignee_id, organization_id=organization.id)
        if task.assignee_id == assignee.id:
            raise ServiceError("This audio is already assigned to that user", status_code=409)
        existing = self.task_repo.get_existing_parallel_assignment(
            upload_job_id=task.upload_job_id,
            file_location=task.file_location,
            assignee_id=assignee.id,
            exclude_task_id=task.id,
            organization_id=organization.id,
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
        organization: Organization,
    ) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
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

    def claim_task(self, *, task_id: str, actor: User, organization: Organization) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, organization_id=organization.id)
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

    def claim_next_task(self, *, actor: User, organization: Organization) -> TaskPatchResponse | None:
        task = self.task_repo.get_next_unassigned_task(organization_id=organization.id)
        if not task:
            return None
        return self.claim_task(task_id=task.id, actor=actor, organization=organization)

    def start_task(self, *, task_id: str, actor: User, organization: Organization) -> TaskPatchResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
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

    def bulk_update_assignees(
        self, *, assignments: list[BulkAssigneeItem], actor: User, organization: Organization
    ) -> BulkAssigneeResponse:
        updated: list[BulkAssigneeUpdated] = []
        errors: list[BulkAssigneeError] = []
        for item in assignments:
            try:
                response = self.update_assignee(
                    task_id=item.task_id,
                    version=item.version,
                    assignee_id=item.assignee_id,
                    actor=actor,
                    organization=organization,
                )
                updated.append(BulkAssigneeUpdated(task=response.task))
            except ServiceError as exc:
                errors.append(BulkAssigneeError(task_id=item.task_id, status_code=exc.status_code, message=exc.message))
        return BulkAssigneeResponse(updated=updated, errors=errors)

    def bulk_auto_balance_assignees(
        self,
        *,
        filters: BulkTaskFilter,
        assignee_ids: list[str],
        max_tasks: int,
        actor: User,
        organization: Organization,
    ) -> BulkAutoBalanceResponse:
        unique_assignee_ids = list(dict.fromkeys(assignee_ids))
        assignees = [
            self._get_valid_task_assignee(assignee_id, organization_id=organization.id)
            for assignee_id in unique_assignee_ids
        ]
        tasks, matched_count = self.task_repo.list_tasks_for_bulk_assignment(
            status=filters.status,
            search=filters.search.strip() if filters.search else None,
            assignee_id=filters.assignee_id,
            upload_job_id=filters.job_id,
            language=filters.language,
            date_from=filters.date_from,
            date_to=filters.date_to,
            organization_id=organization.id,
            limit=max_tasks,
        )
        if matched_count > max_tasks:
            raise ServiceError(
                f"{matched_count} tasks match this filter. Narrow the filter or raise the max_tasks limit.",
                status_code=422,
            )

        call_groups: dict[str, list[AnnotationTask]] = {}
        for task in tasks:
            call_key = self._call_split_key(task, call_id_column="call_id")
            call_groups.setdefault(call_key, []).append(task)

        protected_call_count = 0
        protected_task_count = 0
        now = datetime.now(timezone.utc)
        updated_count = 0
        audit_entries: list[dict[str, Any]] = []
        assignable_group_index = 0
        for call_key, call_tasks in call_groups.items():
            if self._call_group_has_work(call_tasks):
                protected_call_count += 1
                protected_task_count += len(call_tasks)
                continue
            assignee = assignees[assignable_group_index % len(assignees)]
            assignable_group_index += 1
            for task in call_tasks:
                if task.assignee_id == assignee.id:
                    continue
                previous_assignee = task.assignee
                audit_entries.append(
                    {
                        "task_id": task.id,
                        "actor_user_id": actor.id,
                        "action": "BULK_AUTO_BALANCE_ASSIGNEE",
                        "changed_fields": {"assignee_id": True},
                        "previous_values": {
                            "assignee_id": task.assignee_id,
                            "assignee_name": previous_assignee.full_name if previous_assignee else None,
                            "assignee_email": previous_assignee.email if previous_assignee else None,
                        },
                        "new_values": {
                            "assignee_id": assignee.id,
                            "assignee_name": assignee.full_name,
                            "assignee_email": assignee.email,
                            "call_id": call_key,
                        },
                    }
                )
                task.assignee_id = assignee.id
                task.version += 1
                task.last_saved_at = now
                task.updated_at = now
                updated_count += 1

        self.db.flush()
        self.task_repo.add_audit_logs(audit_entries)
        self.db.commit()
        return BulkAutoBalanceResponse(
            matched_count=matched_count,
            updated_count=updated_count,
            skipped_count=matched_count - updated_count,
            assignee_count=len(assignees),
            protected_call_count=protected_call_count,
            protected_task_count=protected_task_count,
        )

    def bulk_call_split_assignees(
        self,
        *,
        filters: BulkTaskFilter,
        assignee_ids: list[str],
        split_strategy: str,
        calls_per_assignee: int,
        call_id_column: str,
        max_tasks: int,
        actor: User,
        organization: Organization,
    ) -> BulkCallSplitResponse:
        unique_assignee_ids = list(dict.fromkeys(assignee_ids))
        assignees = [
            self._get_valid_task_assignee(assignee_id, organization_id=organization.id)
            for assignee_id in unique_assignee_ids
        ]
        normalized_call_id_column = call_id_column.strip() or "call_id"
        tasks, matched_count = self.task_repo.list_tasks_for_bulk_assignment(
            status=filters.status,
            search=filters.search.strip() if filters.search else None,
            assignee_id=filters.assignee_id,
            upload_job_id=filters.job_id,
            language=filters.language,
            date_from=filters.date_from,
            date_to=filters.date_to,
            organization_id=organization.id,
            limit=max_tasks,
        )
        if matched_count > max_tasks:
            raise ServiceError(
                f"{matched_count} tasks match this filter. Narrow the filter or raise the max_tasks limit.",
                status_code=422,
            )

        call_groups: dict[str, list[AnnotationTask]] = {}
        for task in tasks:
            call_key = self._call_split_key(task, call_id_column=normalized_call_id_column)
            call_groups.setdefault(call_key, []).append(task)

        fallback_segment_duration = self._median_known_duration_seconds(tasks)
        protected_call_count = 0
        protected_task_count = 0
        missing_duration_task_count = 0
        estimated_duration_task_count = 0
        now = datetime.now(timezone.utc)
        updated_count = 0
        audit_entries: list[dict[str, Any]] = []
        summary_by_assignee = {
            assignee.id: {
                "assignee": assignee,
                "call_count": 0,
                "task_count": 0,
                "duration_seconds": 0.0,
            }
            for assignee in assignees
        }

        assigned_call_count = 0
        if split_strategy == "duration_balance":
            assignee_load_seconds = {assignee.id: 0.0 for assignee in assignees}
            assignable_calls: list[tuple[str, list[AnnotationTask], float]] = []
            eligible_assignee_ids = set(assignee_load_seconds.keys())
            for call_key, call_tasks in call_groups.items():
                duration_seconds, missing_count, estimated_count = self._call_group_duration_seconds(
                    call_tasks,
                    fallback_segment_duration=fallback_segment_duration,
                )
                missing_duration_task_count += missing_count
                estimated_duration_task_count += estimated_count
                if self._call_group_has_work(call_tasks):
                    protected_call_count += 1
                    protected_task_count += len(call_tasks)
                    protected_assignee_id = self._protected_call_assignee_id(call_tasks, eligible_assignee_ids)
                    if protected_assignee_id:
                        assignee_load_seconds[protected_assignee_id] += duration_seconds
                    continue
                assignable_calls.append((call_key, call_tasks, duration_seconds))

            assignable_calls.sort(key=lambda item: (-item[2], item[0]))
            for call_key, call_tasks, duration_seconds in assignable_calls:
                assignee = min(
                    assignees,
                    key=lambda item: (
                        assignee_load_seconds[item.id],
                        int(summary_by_assignee[item.id]["call_count"]),
                        item.full_name.lower(),
                        item.id,
                    ),
                )
                assignee_load_seconds[assignee.id] += duration_seconds
                summary_by_assignee[assignee.id]["call_count"] += 1
                summary_by_assignee[assignee.id]["task_count"] += len(call_tasks)
                summary_by_assignee[assignee.id]["duration_seconds"] += duration_seconds
                assigned_call_count += 1
                updated_count += self._assign_call_group(
                    call_key=call_key,
                    call_tasks=call_tasks,
                    assignee=assignee,
                    actor=actor,
                    now=now,
                    audit_entries=audit_entries,
                    action="BULK_DURATION_SPLIT_ASSIGNEE",
                    extra_values={
                        "split_strategy": split_strategy,
                        "duration_seconds": round(duration_seconds, 3),
                    },
                )
        else:
            assignable_call_index = 0
            for call_key, call_tasks in call_groups.items():
                duration_seconds, missing_count, estimated_count = self._call_group_duration_seconds(
                    call_tasks,
                    fallback_segment_duration=fallback_segment_duration,
                )
                missing_duration_task_count += missing_count
                estimated_duration_task_count += estimated_count
                if self._call_group_has_work(call_tasks):
                    protected_call_count += 1
                    protected_task_count += len(call_tasks)
                    continue
                assignee = assignees[(assignable_call_index // calls_per_assignee) % len(assignees)]
                assignable_call_index += 1
                summary_by_assignee[assignee.id]["call_count"] += 1
                summary_by_assignee[assignee.id]["task_count"] += len(call_tasks)
                summary_by_assignee[assignee.id]["duration_seconds"] += duration_seconds
                assigned_call_count += 1
                updated_count += self._assign_call_group(
                    call_key=call_key,
                    call_tasks=call_tasks,
                    assignee=assignee,
                    actor=actor,
                    now=now,
                    audit_entries=audit_entries,
                    action="BULK_CALL_SPLIT_ASSIGNEE",
                    extra_values={
                        "split_strategy": split_strategy,
                        "calls_per_assignee": calls_per_assignee,
                    },
                )

        self.db.flush()
        self.task_repo.add_audit_logs(audit_entries)
        self.db.commit()

        return BulkCallSplitResponse(
            matched_count=matched_count,
            matched_call_count=len(call_groups),
            updated_count=updated_count,
            skipped_count=matched_count - updated_count,
            assignee_count=len(assignees),
            calls_per_assignee=calls_per_assignee,
            call_id_column=normalized_call_id_column,
            split_strategy=split_strategy,
            assigned_call_count=assigned_call_count,
            protected_call_count=protected_call_count,
            protected_task_count=protected_task_count,
            missing_duration_task_count=missing_duration_task_count,
            estimated_duration_task_count=estimated_duration_task_count,
            assignments=[
                BulkCallSplitAssignment(
                    assignee_id=str(assignee.id),
                    assignee_name=assignee.full_name,
                    assignee_email=assignee.email,
                    call_count=int(summary_by_assignee[assignee.id]["call_count"]),
                    task_count=int(summary_by_assignee[assignee.id]["task_count"]),
                    duration_seconds=round(float(summary_by_assignee[assignee.id]["duration_seconds"]), 3),
                )
                for assignee in assignees
            ],
        )

    def bulk_create_assignment_copies(
        self,
        *,
        assignments: list[BulkAssignmentCopyItem],
        actor: User,
        organization: Organization,
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
                    organization=organization,
                )
                created.append(BulkAssigneeUpdated(task=response.task))
            except ServiceError as exc:
                errors.append(BulkAssigneeError(task_id=item.task_id, status_code=exc.status_code, message=exc.message))
        return BulkAssignmentCopyResponse(created=created, errors=errors)

    def bulk_update_due_dates(self, *, updates: list[BulkDueDateItem], actor: User, organization: Organization) -> BulkTaskResponse:
        updated: list[BulkTaskUpdated] = []
        errors: list[BulkTaskError] = []
        for item in updates:
            try:
                response = self.update_due_date(
                    task_id=item.task_id,
                    version=item.version,
                    due_date=item.due_date,
                    actor=actor,
                    organization=organization,
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
        organization: Organization,
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
                    organization=organization,
                    comment=comment,
                )
                updated.append(BulkTaskUpdated(task=response.task))
            except ServiceError as exc:
                errors.append(BulkTaskError(task_id=item.task_id, status_code=exc.status_code, message=exc.message))
        return BulkTaskResponse(updated=updated, errors=errors)

    def get_activity(self, task_id: str, *, actor: User, organization: Organization) -> TaskActivityResponse:
        self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        items = [TaskActivityItem(**item) for item in self.task_repo.list_activity(task_id)]
        return TaskActivityResponse(items=items)

    def generate_audio_url(self, task_id: str, *, actor: User, organization: Organization) -> tuple[str, int]:
        from itsdangerous import URLSafeTimedSerializer

        from app.core.config import get_settings

        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        settings = get_settings()
        serializer = URLSafeTimedSerializer(settings.audio_signing_secret)
        token = serializer.dumps(
            {
                "task_id": task.id,
                "file_location": task.file_location,
                "actor_user_id": actor.id,
                "organization_id": organization.id,
                "masked": False,
            }
        )
        url = f"{settings.api_v1_prefix}/media/audio/{token}"
        return url, settings.audio_signing_expire_seconds

    def generate_comparison_audio_url(
        self,
        task_id: str,
        *,
        kind: str,
        actor: User,
        organization: Organization,
    ) -> tuple[str, int]:
        from itsdangerous import URLSafeTimedSerializer

        from app.core.config import get_settings

        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        self._ensure_audio_comparison_task(task)
        normalized_kind = kind.strip().lower()
        if normalized_kind == "original":
            file_location = task.file_location
        elif normalized_kind == "masked":
            file_location = task.comparison_audio_location
        else:
            raise ServiceError("Audio kind must be original or masked", status_code=422)
        if not file_location:
            raise ServiceError("Requested comparison audio is not configured", status_code=404)

        settings = get_settings()
        serializer = URLSafeTimedSerializer(settings.audio_signing_secret)
        token = serializer.dumps(
            {
                "task_id": task.id,
                "file_location": file_location,
                "actor_user_id": actor.id,
                "organization_id": organization.id,
                "comparison_kind": normalized_kind,
            }
        )
        return f"{settings.api_v1_prefix}/media/audio/{token}", settings.audio_signing_expire_seconds

    def get_audio_group(self, task_id: str, *, actor: User, organization: Organization) -> TaskAudioGroupResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        self._ensure_transcript_correction_task(task)
        group_info = audio_group_info(task.file_location)
        if not group_info:
            return self._single_chunk_group_response(
                task,
                viewer=actor,
                message="Full audio review is available for chunk folders only.",
            )

        group_tasks = self._load_audio_group_tasks(task, actor=actor, group_key=group_info.group_key)
        if not group_tasks:
            group_tasks = [task]

        chunks: list[TaskAudioGroupChunkResponse] = []
        transcript_parts: list[str] = []
        seed_parts: list[str] = []
        seed_missing_count = 0
        seed_source_counts: dict[str, int] = {}
        source_order, source_labels = self._transcript_seed_source_order(task)
        current_position = 1
        for position, group_task in enumerate(group_tasks, start=1):
            info = audio_group_info(group_task.file_location)
            text = (group_task.final_transcript or "").strip()
            if text:
                transcript_parts.append(text)
            seed_transcript, seed_source_key, seed_source_label = self._seed_transcript_for_task(
                group_task,
                source_order=source_order,
                source_labels=source_labels,
            )
            if seed_transcript:
                seed_parts.append(seed_transcript)
            else:
                seed_missing_count += 1
            seed_source_counts[seed_source_key or "missing"] = seed_source_counts.get(seed_source_key or "missing", 0) + 1
            if group_task.id == task.id:
                current_position = position
            chunks.append(
                TaskAudioGroupChunkResponse(
                    task_id=group_task.id,
                    external_id=group_task.external_id,
                    file_location=self._display_file_location(group_task.file_location, actor),
                    filename=info.filename if info else PurePosixPath(group_task.file_location).name,
                    chunk_index=info.chunk_index if info else None,
                    position=position,
                    status=group_task.status,
                    final_transcript=group_task.final_transcript,
                    has_transcript=bool(text),
                    duration_seconds=float(group_task.duration_seconds) if group_task.duration_seconds is not None else None,
                    seed_transcript=seed_transcript,
                    seed_source_key=seed_source_key,
                    seed_source_label=seed_source_label,
                )
            )

        completed_count = sum(1 for chunk in chunks if chunk.has_transcript)
        review = self._get_audio_group_review_for_task(task, actor=actor, group_key=group_info.group_key)
        seed_text = "\n".join(seed_parts)
        full_transcript_text = review.transcript if review else seed_text
        full_audio_url = None
        expires = None
        full_audio_supported = all(
            bool((info := audio_group_info(group_task.file_location)) and info.filename.lower().endswith(".wav"))
            for group_task in group_tasks
        )
        full_audio_available = len(chunks) > 1 and full_audio_supported
        message = None
        if full_audio_available:
            full_audio_url, expires = self._generate_audio_group_url(task, actor=actor, organization=organization)
        elif len(chunks) > 1:
            message = "Full audio playback can only combine WAV chunks. Use the individual audio player for Opus chunks."
        else:
            message = "Only one chunk was found for this recording."

        return TaskAudioGroupResponse(
            group_key=group_info.group_key,
            group_label=group_info.group_label,
            current_position=current_position,
            current_chunk_index=group_info.chunk_index,
            chunk_count=len(chunks),
            completed_transcript_count=completed_count,
            missing_transcript_count=len(chunks) - completed_count,
            assembled_transcript="\n".join(transcript_parts),
            full_transcript_text=full_transcript_text,
            full_transcript_source="saved_review" if review else "segment_asr_seed",
            full_transcript_review_version=review.version if review else None,
            full_transcript_review_updated_at=review.updated_at if review else None,
            full_transcript_seed_missing_count=seed_missing_count,
            full_transcript_seed_source_counts=seed_source_counts,
            full_audio_url=full_audio_url,
            expires_in_seconds=expires,
            full_audio_available=full_audio_available,
            message=message,
            chunks=chunks,
        )

    def save_audio_group_full_transcript(
        self,
        task_id: str,
        *,
        payload: UpdateAudioGroupTranscriptRequest,
        actor: User,
        organization: Organization,
    ) -> TaskAudioGroupResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        self._ensure_transcript_correction_task(task)
        group_info = audio_group_info(task.file_location)
        if not group_info:
            raise ServiceError("Full transcript review is available for chunk folders only", status_code=422)

        _raise_for_invalid_text(payload.transcript, "full transcript")
        assignee_id, assignment_scope_key = self._audio_group_review_scope(task, actor)
        group_hash = self._audio_group_hash(group_info.group_key)
        review = self.task_repo.get_audio_group_review(
            organization_id=organization.id,
            upload_job_id=task.upload_job_id,
            group_hash=group_hash,
            assignment_scope_key=assignment_scope_key,
        )

        if review:
            if payload.review_version != review.version:
                raise ServiceError(
                    "Full-call transcript changed in another session. Refresh and try again.",
                    status_code=409,
                    extra={"server_review_version": review.version},
                )
            if review.transcript != payload.transcript:
                review.transcript = payload.transcript
                review.version += 1
                review.updated_at = datetime.now(timezone.utc)
        else:
            if payload.review_version is not None:
                raise ServiceError(
                    "Full-call transcript changed in another session. Refresh and try again.",
                    status_code=409,
                    extra={"server_review_version": None},
                )
            self.task_repo.create_audio_group_review(
                organization_id=organization.id,
                upload_job_id=task.upload_job_id,
                group_key=group_info.group_key,
                group_hash=group_hash,
                assignee_id=assignee_id,
                assignment_scope_key=assignment_scope_key,
                transcript=payload.transcript,
            )

        self.db.flush()
        self.db.commit()
        return self.get_audio_group(task_id, actor=actor, organization=organization)

    def audio_group_file_locations_for_media(
        self,
        *,
        task_id: str,
        actor: User | None,
        organization_id: str,
    ) -> list[str]:
        if actor is None:
            raise ServiceError("Audio token is missing a valid user", status_code=401)
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization_id)
        self._ensure_transcript_correction_task(task)
        group_info = audio_group_info(task.file_location)
        if not group_info:
            raise ServiceError("Full audio review is available for WAV chunk folders only", status_code=422)
        group_tasks = self._load_audio_group_tasks(task, actor=actor, group_key=group_info.group_key)
        if len(group_tasks) < 2:
            raise ServiceError("Only one chunk was found for this recording", status_code=404)
        return [group_task.file_location for group_task in group_tasks]

    def generate_alignment(
        self, task_id: str, *, actor: User, organization: Organization, force: bool = False
    ) -> TaskAudioAlignmentResponse:
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        self._ensure_transcript_correction_task(task)
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
        organization: Organization,
        force: bool = False,
        mask_mode: AudioMaskMode = "silence",
        custom_intervals: list[AudioMaskInterval] | None = None,
    ) -> TaskMaskedAudioResponse:
        from itsdangerous import URLSafeTimedSerializer

        from app.core.config import get_settings

        if not organization.audio_masking_enabled:
            raise ServiceError("Audio masking is disabled for this organization", status_code=403)
        task = self._get_task_or_404(task_id, actor=actor, organization_id=organization.id)
        self._ensure_transcript_correction_task(task)
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
                "organization_id": organization.id,
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

    def _get_task_or_404(
        self, task_id: str, *, actor: User | None = None, organization_id: str | None = None
    ) -> AnnotationTask:
        task = self.task_repo.get_task(task_id, organization_id=organization_id)
        if not task:
            raise ServiceError("Task not found", status_code=404)
        if actor and actor.role == RoleEnum.CANDIDATE:
            raise ServiceError("Candidates cannot access annotation tasks", status_code=403)
        if actor and actor.role != RoleEnum.ADMIN and task.assignee_id != actor.id:
            raise ServiceError("Task is not assigned to you", status_code=403)
        return task

    def _call_group_has_work(self, tasks: list[AnnotationTask]) -> bool:
        return any(task.status != TaskStatusEnum.NOT_STARTED or task.last_tagger_id for task in tasks)

    def _task_duration_seconds(self, task: AnnotationTask) -> float | None:
        if task.duration_seconds is None:
            return None
        try:
            duration = float(task.duration_seconds)
        except (TypeError, ValueError):
            return None
        return duration if duration > 0 else None

    def _median_known_duration_seconds(self, tasks: list[AnnotationTask]) -> float:
        durations = sorted(
            duration
            for task in tasks
            if (duration := self._task_duration_seconds(task)) is not None
        )
        if not durations:
            return 60.0
        midpoint = len(durations) // 2
        if len(durations) % 2:
            return durations[midpoint]
        return (durations[midpoint - 1] + durations[midpoint]) / 2

    def _call_group_duration_seconds(
        self,
        tasks: list[AnnotationTask],
        *,
        fallback_segment_duration: float,
    ) -> tuple[float, int, int]:
        known_durations = [
            duration
            for task in tasks
            if (duration := self._task_duration_seconds(task)) is not None
        ]
        missing_count = max(0, len(tasks) - len(known_durations))
        if known_durations:
            return sum(known_durations), missing_count, 0
        estimated_duration = max(fallback_segment_duration, 0.0) * len(tasks)
        return estimated_duration, missing_count, len(tasks)

    def _protected_call_assignee_id(
        self,
        tasks: list[AnnotationTask],
        eligible_assignee_ids: set[str],
    ) -> str | None:
        assignee_counts: dict[str, int] = {}
        for task in tasks:
            for candidate_id in (task.assignee_id, task.last_tagger_id):
                if candidate_id and candidate_id in eligible_assignee_ids:
                    assignee_counts[candidate_id] = assignee_counts.get(candidate_id, 0) + 1
                    break
        if not assignee_counts:
            return None
        return sorted(assignee_counts.items(), key=lambda item: (-item[1], item[0]))[0][0]

    def _assign_call_group(
        self,
        *,
        call_key: str,
        call_tasks: list[AnnotationTask],
        assignee: User,
        actor: User,
        now: datetime,
        audit_entries: list[dict[str, Any]],
        action: str,
        extra_values: dict[str, Any],
    ) -> int:
        updated_count = 0
        for task in call_tasks:
            if task.assignee_id == assignee.id:
                continue
            previous_assignee = task.assignee
            audit_entries.append(
                {
                    "task_id": task.id,
                    "actor_user_id": actor.id,
                    "action": action,
                    "changed_fields": {"assignee_id": True},
                    "previous_values": {
                        "assignee_id": task.assignee_id,
                        "assignee_name": previous_assignee.full_name if previous_assignee else None,
                        "assignee_email": previous_assignee.email if previous_assignee else None,
                    },
                    "new_values": {
                        "assignee_id": assignee.id,
                        "assignee_name": assignee.full_name,
                        "assignee_email": assignee.email,
                        "call_id": call_key,
                        **extra_values,
                    },
                }
            )
            task.assignee_id = assignee.id
            task.version += 1
            task.last_saved_at = now
            task.updated_at = now
            updated_count += 1
        return updated_count

    def _call_split_key(self, task: AnnotationTask, *, call_id_column: str) -> str:
        row = task.original_row if isinstance(task.original_row, dict) else {}
        candidate_keys = [call_id_column, "call_id", "file_id", "source_path_abs"]
        seen_keys: set[str] = set()
        for key in candidate_keys:
            if not key or key in seen_keys:
                continue
            seen_keys.add(key)
            value = row.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text

        path_text = str(row.get("segment_audio_path_abs") or row.get("audio") or task.file_location or "").strip()
        path_group = self._path_call_split_key(path_text)
        if path_group:
            return path_group

        info = audio_group_info(task.file_location)
        if info and info.chunk_index is not None:
            return info.group_key
        return task.file_location or task.external_id

    def _path_call_split_key(self, file_location: str) -> str | None:
        if not file_location:
            return None
        prefix = ""
        path_text = file_location
        if file_location.startswith("local://"):
            prefix = "local://"
            path_text = file_location.replace("local://", "", 1)
        elif file_location.startswith("s3://"):
            parsed = urlparse(file_location)
            prefix = f"s3://{parsed.netloc}/"
            path_text = parsed.path.lstrip("/")

        path = PurePosixPath(path_text)
        parent = path.parent
        if not str(parent) or str(parent) == ".":
            return None
        info = audio_group_info(file_location)
        if not info or info.chunk_index is None:
            return None
        if parent.name.lower().startswith("channel") and str(parent.parent) and str(parent.parent) != ".":
            return f"{prefix}{parent.parent}"
        return info.group_key

    def _get_valid_task_assignee(self, assignee_id: str, *, organization_id: str) -> User:
        assignee = self.user_repo.get_by_id(assignee_id)
        if not assignee:
            raise ServiceError("Assignee user not found", status_code=404)
        if assignee.role not in {RoleEnum.ANNOTATOR, RoleEnum.REVIEWER, RoleEnum.ADMIN}:
            raise ServiceError("Assignee role is not valid for task assignment", status_code=422)
        if not OrganizationService(self.db).user_has_access(assignee, organization_id):
            raise ServiceError("Assignee does not have access to this organization", status_code=422)
        return assignee

    def _single_chunk_group_response(
        self,
        task: AnnotationTask,
        *,
        viewer: User,
        message: str,
    ) -> TaskAudioGroupResponse:
        info = audio_group_info(task.file_location)
        text = (task.final_transcript or "").strip()
        source_order, source_labels = self._transcript_seed_source_order(task)
        seed_transcript, seed_source_key, seed_source_label = self._seed_transcript_for_task(
            task,
            source_order=source_order,
            source_labels=source_labels,
        )
        return TaskAudioGroupResponse(
            group_key=info.group_key if info else None,
            group_label=info.group_label if info else None,
            current_position=1,
            current_chunk_index=info.chunk_index if info else None,
            chunk_count=1,
            completed_transcript_count=1 if text else 0,
            missing_transcript_count=0 if text else 1,
            assembled_transcript=text,
            full_transcript_text=seed_transcript,
            full_transcript_source="segment_asr_seed",
            full_transcript_review_version=None,
            full_transcript_review_updated_at=None,
            full_transcript_seed_missing_count=0 if seed_transcript else 1,
            full_transcript_seed_source_counts={seed_source_key or "missing": 1},
            full_audio_url=None,
            expires_in_seconds=None,
            full_audio_available=False,
            message=message,
            chunks=[
                TaskAudioGroupChunkResponse(
                    task_id=task.id,
                    external_id=task.external_id,
                    file_location=self._display_file_location(task.file_location, viewer),
                    filename=info.filename if info else PurePosixPath(task.file_location).name,
                    chunk_index=info.chunk_index if info else None,
                    position=1,
                    status=task.status,
                    final_transcript=task.final_transcript,
                    has_transcript=bool(text),
                    duration_seconds=float(task.duration_seconds) if task.duration_seconds is not None else None,
                    seed_transcript=seed_transcript,
                    seed_source_key=seed_source_key,
                    seed_source_label=seed_source_label,
                )
            ],
        )

    def _load_audio_group_tasks(
        self,
        task: AnnotationTask,
        *,
        actor: User,
        group_key: str,
    ) -> list[AnnotationTask]:
        info = audio_group_info(task.file_location)
        if not info:
            return [task]
        assignee_id = actor.id if actor.role != RoleEnum.ADMIN else None
        candidates = self.task_repo.list_audio_group_candidates(
            upload_job_id=task.upload_job_id,
            organization_id=task.organization_id,
            location_prefix=info.query_prefix,
            assignee_id=assignee_id,
            limit=MAX_AUDIO_GROUP_CHUNKS,
        )
        deduped: dict[str, AnnotationTask] = {}
        for candidate in candidates:
            candidate_info = audio_group_info(candidate.file_location)
            if not candidate_info or candidate_info.group_key != group_key:
                continue
            existing = deduped.get(candidate.file_location)
            if existing is None or candidate.id == task.id:
                deduped[candidate.file_location] = candidate
        if task.file_location not in deduped:
            deduped[task.file_location] = task
        return sorted(deduped.values(), key=lambda item: audio_group_sort_key(item.file_location))

    def _transcript_seed_source_order(self, task: AnnotationTask) -> tuple[list[str], dict[str, str]]:
        mapping = task.upload_job.mapping_json if task.upload_job else None
        transcript_columns = mapping.get("transcript_columns") if isinstance(mapping, dict) else None
        if not isinstance(transcript_columns, list):
            return [], {}

        ordered_keys: list[str] = []
        labels: dict[str, str] = {}
        for column in transcript_columns:
            if not isinstance(column, dict):
                continue
            source_key = str(column.get("source_key") or "").strip()
            if not source_key or source_key in labels:
                continue
            ordered_keys.append(source_key)
            source_label = str(column.get("source_label") or source_key).strip() or source_key
            labels[source_key] = source_label
        return ordered_keys, labels

    def _seed_transcript_for_task(
        self,
        task: AnnotationTask,
        *,
        source_order: list[str],
        source_labels: dict[str, str],
    ) -> tuple[str, str | None, str | None]:
        final_text = (task.final_transcript or "").strip()
        if final_text:
            return final_text, "final_transcript", "Current chunk transcript"

        variants_by_key = {
            variant.source_key: variant
            for variant in task.transcript_variants
            if (variant.transcript_text or "").strip()
        }
        for source_key in source_order:
            variant = variants_by_key.get(source_key)
            if variant:
                return (
                    variant.transcript_text.strip(),
                    variant.source_key,
                    source_labels.get(variant.source_key) or variant.source_label,
                )

        fallback_variants = sorted(
            variants_by_key.values(),
            key=lambda variant: (variant.source_key.lower(), variant.source_label.lower()),
        )
        if fallback_variants:
            variant = fallback_variants[0]
            return variant.transcript_text.strip(), variant.source_key, variant.source_label
        return "", None, None

    def _get_audio_group_review_for_task(self, task: AnnotationTask, *, actor: User, group_key: str):
        _, assignment_scope_key = self._audio_group_review_scope(task, actor)
        return self.task_repo.get_audio_group_review(
            organization_id=task.organization_id,
            upload_job_id=task.upload_job_id,
            group_hash=self._audio_group_hash(group_key),
            assignment_scope_key=assignment_scope_key,
        )

    def _audio_group_review_scope(self, task: AnnotationTask, actor: User) -> tuple[str | None, str]:
        assignee_id = task.assignee_id if actor.role == RoleEnum.ADMIN else actor.id
        return assignee_id, f"user:{assignee_id}" if assignee_id else "unassigned"

    def _audio_group_hash(self, group_key: str) -> str:
        return hashlib.sha256(group_key.encode("utf-8")).hexdigest()

    def _generate_audio_group_url(self, task: AnnotationTask, *, actor: User, organization: Organization) -> tuple[str, int]:
        from itsdangerous import URLSafeTimedSerializer

        from app.core.config import get_settings

        settings = get_settings()
        serializer = URLSafeTimedSerializer(settings.audio_signing_secret)
        token = serializer.dumps(
            {
                "task_id": task.id,
                "actor_user_id": actor.id,
                "organization_id": organization.id,
                "group_audio": True,
            }
        )
        return f"{settings.api_v1_prefix}/media/audio/{token}", settings.audio_signing_expire_seconds

    def _next_parallel_assignment_external_id(self, source_task: AnnotationTask, assignee: User) -> str:
        safe_email = "".join(char if char.isalnum() else "-" for char in assignee.email.lower()).strip("-")
        suffix = f"copy-{safe_email[:48]}-{uuid.uuid4().hex[:8]}"
        prefix_length = max(1, 255 - len(suffix) - 2)
        base = source_task.external_id[:prefix_length].rstrip(" -_")
        external_id = f"{base}__{suffix}"
        while self.task_repo.external_id_exists(
            upload_job_id=source_task.upload_job_id,
            external_id=external_id,
            organization_id=source_task.organization_id,
        ):
            suffix = f"copy-{safe_email[:48]}-{uuid.uuid4().hex[:8]}"
            prefix_length = max(1, 255 - len(suffix) - 2)
            base = source_task.external_id[:prefix_length].rstrip(" -_")
            external_id = f"{base}__{suffix}"
        return external_id

    def _to_task_detail(self, task: AnnotationTask, *, viewer: User | None = None) -> TaskDetailResponse:
        assignee_scope = viewer.id if viewer and viewer.role != RoleEnum.ADMIN else None
        prev_task_id, next_task_id = self.task_repo.get_prev_next_task_ids(
            task,
            assignee_id=assignee_scope,
            organization_id=task.organization_id,
        )
        return TaskDetailResponse(
            id=task.id,
            external_id=task.external_id,
            workflow_type=task.workflow_type,
            file_location=self._display_file_location(task.file_location, viewer),
            comparison_audio_location=self._display_file_location(task.comparison_audio_location, viewer)
            if task.comparison_audio_location
            else None,
            questionnaire_id=task.questionnaire_id,
            questionnaire_snapshot=task.questionnaire_snapshot or {},
            questionnaire_answers=task.questionnaire_answers or {},
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
            workflow_type=task.workflow_type,
            file_location=self._display_file_location(task.file_location, viewer),
            comparison_audio_location=self._display_file_location(task.comparison_audio_location, viewer)
            if task.comparison_audio_location
            else None,
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

    def _guard_workflow_updates(self, task: AnnotationTask, update_fields: set[str]) -> None:
        if task.workflow_type != TaskWorkflowTypeEnum.AUDIO_COMPARISON:
            return
        transcript_fields = {
            "final_transcript",
            "speaker_gender",
            "speaker_role",
            "language",
            "channel",
            "duration_seconds",
            "custom_metadata",
            "pii_annotations",
        }
        blocked = sorted(update_fields & transcript_fields)
        if blocked:
            raise ServiceError(
                "Transcript, metadata, and PII fields are not used for audio comparison tasks",
                status_code=422,
                extra={"fields": blocked},
            )

    def _ensure_transcript_correction_task(self, task: AnnotationTask) -> None:
        if task.workflow_type == TaskWorkflowTypeEnum.AUDIO_COMPARISON:
            raise ServiceError("This action is only available for transcript correction tasks", status_code=422)

    def _ensure_audio_comparison_task(self, task: AnnotationTask) -> None:
        if task.workflow_type != TaskWorkflowTypeEnum.AUDIO_COMPARISON:
            raise ServiceError("This action is only available for audio comparison tasks", status_code=422)

    def _questionnaire_questions(self, task: AnnotationTask) -> list[dict[str, Any]]:
        snapshot = task.questionnaire_snapshot if isinstance(task.questionnaire_snapshot, dict) else {}
        raw_questions = snapshot.get("questions") if isinstance(snapshot, dict) else []
        if not isinstance(raw_questions, list):
            return []
        questions = [question for question in raw_questions if isinstance(question, dict) and question.get("id")]
        return sorted(questions, key=lambda item: (int(item.get("sort_order", 0) or 0), str(item.get("id", ""))))

    def _normalize_questionnaire_answers(
        self,
        task: AnnotationTask,
        answers: dict[str, Any],
        *,
        completing: bool,
    ) -> dict[str, Any]:
        if not isinstance(answers, dict):
            raise ServiceError("Questionnaire answers must be an object", status_code=422)
        questions = self._questionnaire_questions(task)
        question_by_id = {str(question.get("id")): question for question in questions}
        unknown_ids = sorted(str(key) for key in answers.keys() if str(key) not in question_by_id)
        if unknown_ids:
            raise ServiceError(
                "Questionnaire contains answers for unknown questions",
                status_code=422,
                extra={"question_ids": unknown_ids},
            )

        normalized: dict[str, Any] = {}
        for question_id, question in question_by_id.items():
            if question_id not in answers:
                continue
            value = answers.get(question_id)
            field_type = str(question.get("field_type") or "")
            options = [str(option) for option in question.get("options") or []]
            if value is None or value == "":
                continue
            if field_type == "yes_no":
                if isinstance(value, bool):
                    normalized[question_id] = "yes" if value else "no"
                else:
                    text = str(value).strip().lower()
                    if text not in {"yes", "no"}:
                        raise ServiceError(f"Answer for '{question.get('label')}' must be yes or no", status_code=422)
                    normalized[question_id] = text
            elif field_type == "single_select":
                text = str(value).strip()
                if options and text not in options:
                    raise ServiceError(f"Answer for '{question.get('label')}' must be one of the configured options", status_code=422)
                normalized[question_id] = text
            elif field_type == "multi_select":
                if not isinstance(value, list):
                    raise ServiceError(f"Answer for '{question.get('label')}' must be a list", status_code=422)
                selected = [str(item).strip() for item in value if str(item).strip()]
                invalid = [item for item in selected if options and item not in options]
                if invalid:
                    raise ServiceError(
                        f"Answer for '{question.get('label')}' contains an option that is not configured",
                        status_code=422,
                    )
                normalized[question_id] = selected
            elif field_type == "number":
                try:
                    normalized[question_id] = float(value)
                except (TypeError, ValueError) as exc:
                    raise ServiceError(f"Answer for '{question.get('label')}' must be numeric", status_code=422) from exc
            elif field_type == "rating":
                try:
                    numeric = float(value)
                except (TypeError, ValueError) as exc:
                    raise ServiceError(f"Answer for '{question.get('label')}' must be numeric", status_code=422) from exc
                if not numeric.is_integer() or numeric < 1 or numeric > 5:
                    raise ServiceError(f"Answer for '{question.get('label')}' must be a whole number from 1 to 5", status_code=422)
                normalized[question_id] = int(numeric)
            elif field_type == "date":
                normalized[question_id] = str(value).strip()
            else:
                normalized[question_id] = str(value)

        if completing:
            self._validate_questionnaire_completion(task, normalized)
        return normalized

    def _validate_questionnaire_completion(self, task: AnnotationTask, answers: dict[str, Any]) -> None:
        if task.workflow_type != TaskWorkflowTypeEnum.AUDIO_COMPARISON:
            return
        questions = self._questionnaire_questions(task)
        if not questions:
            raise ServiceError("Audio comparison questionnaire has no questions", status_code=422)
        missing = [
            str(question.get("id"))
            for question in questions
            if question.get("required") and not self._answer_has_value(answers.get(str(question.get("id"))))
        ]
        if missing:
            raise ServiceError(
                "Complete all required questionnaire answers before marking this task complete",
                status_code=422,
                extra={"missing_question_ids": missing},
            )

    def _answer_has_value(self, value: Any) -> bool:
        if value is None:
            return False
        if isinstance(value, str):
            return bool(value.strip())
        if isinstance(value, list):
            return any(self._answer_has_value(item) for item in value)
        return True

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

    def _guard_feature_updates(self, update_fields: set[str], organization: Organization) -> None:
        metadata_fields = {
            "speaker_gender",
            "speaker_role",
            "language",
            "channel",
            "duration_seconds",
            "custom_metadata",
        }
        if update_fields & metadata_fields and not organization.metadata_enabled:
            raise ServiceError("Metadata is disabled for this organization", status_code=403)
        if "pii_annotations" in update_fields and not organization.pii_enabled:
            raise ServiceError("PII annotation is disabled for this organization", status_code=403)
