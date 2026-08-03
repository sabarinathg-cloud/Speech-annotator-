from datetime import date
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_organization, get_db_session, require_confidentiality_ack, require_roles
from app.models.enums import RoleEnum, TaskStatusEnum
from app.models.organization import Organization
from app.models.user import User
from app.schemas.task import (
    AudioURLResponse,
    BulkAssignmentCopyRequest,
    BulkAssignmentCopyResponse,
    BulkAutoBalanceRequest,
    BulkAutoBalanceResponse,
    BulkAssigneeRequest,
    BulkAssigneeResponse,
    BulkCallSplitRequest,
    BulkCallSplitResponse,
    BulkDueDateRequest,
    BulkStatusRequest,
    BulkTaskResponse,
    CombinedTaskUpdateRequest,
    DetectPIIRequest,
    DetectPIIResponse,
    TaskActivityResponse,
    TaskAudioGroupResponse,
    TaskAudioAlignmentResponse,
    TaskDetailResponse,
    TaskListResponse,
    TaskMaskAudioRequest,
    TaskMaskedAudioResponse,
    TaskNextResponse,
    TaskPatchResponse,
    CreateAssignmentCopyRequest,
    UpdateAudioGroupTranscriptRequest,
    UpdateAssigneeRequest,
    UpdateMetadataRequest,
    UpdateNotesRequest,
    UpdatePIIAnnotationsRequest,
    UpdateQuestionnaireAnswersRequest,
    UpdateStatusRequest,
    UpdateTranscriptRequest,
)
from app.services.errors import ServiceError
from app.services.pii_detection_service import detect_pii_ensemble
from app.services.security_audit_service import SecurityAuditService
from app.services.task_service import TaskService

router = APIRouter(prefix="/tasks", tags=["tasks"])


def _http_error(exc: ServiceError) -> HTTPException:
    detail = {"message": exc.message}
    detail.update(exc.extra)
    return HTTPException(status_code=exc.status_code, detail=detail)


@router.get("", response_model=TaskListResponse)
def list_tasks(
    status: TaskStatusEnum | None = Query(default=None),
    search: str | None = Query(default=None),
    assignee_id: str | None = Query(default=None),
    job_id: str | None = Query(default=None),
    language: str | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    return service.list_tasks(
        status=status,
        search=search,
        assignee_id=assignee_id,
        upload_job_id=job_id,
        language=language,
        date_from=date_from,
        date_to=date_to,
        page=page,
        page_size=page_size,
        current_user=current_user,
        organization=organization,
    )


@router.get("/next", response_model=TaskNextResponse)
def get_next_task(
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    return TaskNextResponse(task_id=service.get_next_task(actor=current_user, organization=organization))


@router.post("/next/claim", response_model=TaskPatchResponse)
def claim_next_task(
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ANNOTATOR, RoleEnum.REVIEWER)),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        response = service.claim_next_task(actor=current_user, organization=organization)
        if not response:
            raise HTTPException(status_code=404, detail={"message": "No unassigned tasks available"})
        return response
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/bulk-assignee", response_model=BulkAssigneeResponse)
def bulk_update_assignees(
    payload: BulkAssigneeRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.bulk_update_assignees(assignments=payload.assignments, actor=current_user, organization=organization)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/bulk-auto-balance", response_model=BulkAutoBalanceResponse)
def bulk_auto_balance_assignees(
    payload: BulkAutoBalanceRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.bulk_auto_balance_assignees(
            filters=payload.filters,
            assignee_ids=payload.assignee_ids,
            max_tasks=payload.max_tasks,
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/bulk-call-split", response_model=BulkCallSplitResponse)
def bulk_call_split_assignees(
    payload: BulkCallSplitRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.bulk_call_split_assignees(
            filters=payload.filters,
            assignee_ids=payload.assignee_ids,
            calls_per_assignee=payload.calls_per_assignee,
            call_id_column=payload.call_id_column,
            max_tasks=payload.max_tasks,
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/bulk-assignment-copies", response_model=BulkAssignmentCopyResponse)
def bulk_create_assignment_copies(
    payload: BulkAssignmentCopyRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.bulk_create_assignment_copies(
            assignments=payload.assignments,
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/bulk-due-date", response_model=BulkTaskResponse)
def bulk_update_due_dates(
    payload: BulkDueDateRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.bulk_update_due_dates(updates=payload.updates, actor=current_user, organization=organization)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/bulk-status", response_model=BulkTaskResponse)
def bulk_update_statuses(
    payload: BulkStatusRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.bulk_update_statuses(
            updates=payload.updates,
            new_status=payload.status,
            comment=payload.comment,
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/detect-pii", response_model=DetectPIIResponse)
def detect_pii(
    payload: DetectPIIRequest,
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    if current_user.role == RoleEnum.CANDIDATE:
        raise HTTPException(status_code=403, detail={"message": "Candidates cannot access annotation task APIs"})
    if not organization.pii_enabled:
        raise HTTPException(status_code=403, detail={"message": "PII detection is disabled for this organization"})
    return DetectPIIResponse(
        pii_annotations=detect_pii_ensemble(payload.transcript, include_ml=payload.include_ml)
    )


@router.get("/{task_id}", response_model=TaskDetailResponse)
def get_task(
    task_id: str,
    request: Request,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        response = service.get_task_detail(task_id, actor=current_user, organization=organization)
        SecurityAuditService(db).log_event(
            action="VIEW_TASK",
            actor=current_user,
            resource_type="task",
            resource_id=task_id,
            task_id=task_id,
            organization_id=organization.id,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={"external_id": response.external_id, "status": response.status.value},
        )
        return response
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/{task_id}", response_model=TaskPatchResponse)
def update_task(
    task_id: str,
    payload: CombinedTaskUpdateRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.save_combined_task(
            task_id=task_id,
            payload=payload,
            provided_fields=set(payload.model_fields_set),
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/{task_id}/claim", response_model=TaskPatchResponse)
def claim_task(
    task_id: str,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ANNOTATOR, RoleEnum.REVIEWER)),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.claim_task(task_id=task_id, actor=current_user, organization=organization)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/{task_id}/start", response_model=TaskPatchResponse)
def start_task(
    task_id: str,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ANNOTATOR, RoleEnum.REVIEWER)),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.start_task(task_id=task_id, actor=current_user, organization=organization)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/{task_id}/activity", response_model=TaskActivityResponse)
def get_task_activity(
    task_id: str,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.get_activity(task_id, actor=current_user, organization=organization)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/{task_id}/alignment", response_model=TaskAudioAlignmentResponse)
def generate_task_alignment(
    task_id: str,
    request: Request,
    force: bool = Query(default=False),
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        response = service.generate_alignment(task_id, actor=current_user, organization=organization, force=force)
        SecurityAuditService(db).log_event(
            action="GENERATE_ALIGNMENT",
            actor=current_user,
            resource_type="task",
            resource_id=task_id,
            task_id=task_id,
            organization_id=organization.id,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={"force": force, "word_count": len(response.words)},
        )
        return response
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/{task_id}/mask-pii-audio", response_model=TaskMaskedAudioResponse)
def mask_task_pii_audio(
    task_id: str,
    request: Request,
    payload: TaskMaskAudioRequest | None = Body(default=None),
    force: bool = Query(default=False),
    mask_mode: Literal["silence", "beep"] = Query(default="silence"),
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        response = service.generate_masked_pii_audio(
            task_id,
            actor=current_user,
            organization=organization,
            force=force,
            mask_mode=mask_mode,
            custom_intervals=payload.mask_intervals if payload else None,
        )
        SecurityAuditService(db).log_event(
            action="MASK_PII_AUDIO",
            actor=current_user,
            resource_type="audio",
            resource_id=task_id,
            task_id=task_id,
            organization_id=organization.id,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={
                "force": force,
                "mask_mode": mask_mode,
                "masked_interval_count": len(response.masked_intervals),
                "custom_intervals": bool(payload and payload.mask_intervals),
            },
        )
        return response
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/{task_id}/transcript", response_model=TaskPatchResponse)
def update_transcript(
    task_id: str,
    payload: UpdateTranscriptRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.update_transcript(
            task_id=task_id,
            version=payload.version,
            final_transcript=payload.final_transcript,
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/{task_id}/metadata", response_model=TaskPatchResponse)
def update_metadata(
    task_id: str,
    payload: UpdateMetadataRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.update_metadata(
            task_id=task_id,
            version=payload.version,
            speaker_gender=payload.speaker_gender,
            speaker_role=payload.speaker_role,
            language=payload.language,
            channel=payload.channel,
            duration_seconds=payload.duration_seconds,
            custom_metadata=payload.custom_metadata,
            provided_fields=set(payload.model_fields_set) - {"version"},
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/{task_id}/notes", response_model=TaskPatchResponse)
def update_notes(
    task_id: str,
    payload: UpdateNotesRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.update_notes(
            task_id=task_id,
            version=payload.version,
            notes=payload.notes,
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/{task_id}/status", response_model=TaskPatchResponse)
def update_status(
    task_id: str,
    payload: UpdateStatusRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.update_status(
            task_id=task_id,
            version=payload.version,
            new_status=payload.status,
            actor=current_user,
            organization=organization,
            comment=payload.comment,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/{task_id}/pii", response_model=TaskPatchResponse)
def update_pii(
    task_id: str,
    payload: UpdatePIIAnnotationsRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.update_pii_annotations(
            task_id=task_id,
            version=payload.version,
            pii_annotations=payload.pii_annotations,
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/{task_id}/questionnaire-answers", response_model=TaskPatchResponse)
def update_questionnaire_answers(
    task_id: str,
    payload: UpdateQuestionnaireAnswersRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.update_questionnaire_answers(
            task_id=task_id,
            payload=payload,
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/{task_id}/assignee", response_model=TaskPatchResponse)
def update_assignee(
    task_id: str,
    payload: UpdateAssigneeRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.update_assignee(
            task_id=task_id,
            version=payload.version,
            assignee_id=payload.assignee_id,
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/{task_id}/assignment-copy", response_model=TaskPatchResponse)
def create_assignment_copy(
    task_id: str,
    payload: CreateAssignmentCopyRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        return service.create_assignment_copy(
            task_id=task_id,
            version=payload.version,
            assignee_id=payload.assignee_id,
            actor=current_user,
            organization=organization,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/{task_id}/audio-url", response_model=AudioURLResponse)
def get_audio_url(
    task_id: str,
    request: Request,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        url, expires = service.generate_audio_url(task_id, actor=current_user, organization=organization)
        SecurityAuditService(db).log_event(
            action="GENERATE_AUDIO_URL",
            actor=current_user,
            resource_type="audio",
            resource_id=task_id,
            task_id=task_id,
            organization_id=organization.id,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={"expires_in_seconds": expires},
        )
        return AudioURLResponse(url=url, expires_in_seconds=expires)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/{task_id}/comparison-audio-url", response_model=AudioURLResponse)
def get_comparison_audio_url(
    task_id: str,
    request: Request,
    kind: Literal["original", "masked"] = Query(default="original"),
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        url, expires = service.generate_comparison_audio_url(
            task_id,
            kind=kind,
            actor=current_user,
            organization=organization,
        )
        SecurityAuditService(db).log_event(
            action="GENERATE_COMPARISON_AUDIO_URL",
            actor=current_user,
            resource_type="audio",
            resource_id=task_id,
            task_id=task_id,
            organization_id=organization.id,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={"kind": kind, "expires_in_seconds": expires},
        )
        return AudioURLResponse(url=url, expires_in_seconds=expires)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/{task_id}/audio-group", response_model=TaskAudioGroupResponse)
def get_audio_group(
    task_id: str,
    request: Request,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        response = service.get_audio_group(task_id, actor=current_user, organization=organization)
        SecurityAuditService(db).log_event(
            action="VIEW_AUDIO_GROUP",
            actor=current_user,
            resource_type="audio_group",
            resource_id=response.group_key,
            task_id=task_id,
            organization_id=organization.id,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={"chunk_count": response.chunk_count, "full_audio_available": response.full_audio_available},
        )
        return response
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/{task_id}/audio-group/full-transcript", response_model=TaskAudioGroupResponse)
def update_audio_group_full_transcript(
    task_id: str,
    payload: UpdateAudioGroupTranscriptRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    service = TaskService(db)
    try:
        response = service.save_audio_group_full_transcript(
            task_id,
            payload=payload,
            actor=current_user,
            organization=organization,
        )
        SecurityAuditService(db).log_event(
            action="SAVE_AUDIO_GROUP_FULL_TRANSCRIPT",
            actor=current_user,
            resource_type="audio_group",
            resource_id=response.group_key,
            task_id=task_id,
            organization_id=organization.id,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={
                "chunk_count": response.chunk_count,
                "review_version": response.full_transcript_review_version,
                "transcript_length": len(payload.transcript or ""),
            },
        )
        return response
    except ServiceError as exc:
        raise _http_error(exc) from exc
