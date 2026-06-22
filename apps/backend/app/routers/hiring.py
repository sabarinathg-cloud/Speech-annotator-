from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from app.core.dependencies import get_db_session, require_confidentiality_ack, require_roles
from app.models.enums import RoleEnum
from app.models.user import User
from app.schemas.hiring import (
    HiringAdminAssignmentReviewResponse,
    HiringAudioBucketListRequest,
    HiringAudioBucketListResponse,
    HiringAssessmentCreateRequest,
    HiringAssessmentDetailResponse,
    HiringAssessmentItemReferenceUpdateRequest,
    HiringAssessmentListResponse,
    HiringAssessmentUpdateRequest,
    HiringAssignmentAccessUpdateRequest,
    HiringAssignmentDeleteResponse,
    HiringAssignmentCreateRequest,
    HiringAssignmentInviteResponse,
    HiringAssignmentListResponse,
    HiringAssignmentSummaryResponse,
    HiringAuditEventListResponse,
    HiringCandidateAssignmentDetailResponse,
    HiringFolderImportRequest,
    HiringImportResponse,
    HiringRankingResponse,
    HiringScorecardUpdateRequest,
    HiringSubmissionResponse,
    HiringSubmissionUpdateRequest,
    HiringSubmissionValidationRequest,
)
from app.schemas.task import DetectPIIRequest, DetectPIIResponse
from app.services.errors import ServiceError
from app.services.hiring_service import HiringService
from app.services.pii_detection_service import detect_pii_ensemble
from app.services.security_audit_service import SecurityAuditService

router = APIRouter(prefix="/hiring", tags=["hiring"])


def _http_error(exc: ServiceError) -> HTTPException:
    detail = {"message": exc.message}
    detail.update(exc.extra)
    return HTTPException(status_code=exc.status_code, detail=detail)


@router.get("/assessments", response_model=HiringAssessmentListResponse)
def list_assessments(
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    return HiringService(db).list_assessments()


@router.post("/assessments", response_model=HiringAssessmentDetailResponse)
def create_assessment(
    payload: HiringAssessmentCreateRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).create_assessment(
            title=payload.title,
            instructions=payload.instructions,
            due_date=payload.due_date,
            due_at=payload.due_at,
            time_limit_minutes=payload.time_limit_minutes,
            blind_review_enabled=payload.blind_review_enabled,
            metadata_schema=payload.metadata_schema,
            pii_label_keys=payload.pii_label_keys,
            rubric_schema=payload.rubric_schema,
            actor=current_user,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/assessments/{assessment_id}", response_model=HiringAssessmentDetailResponse)
def get_assessment(
    assessment_id: str,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).get_assessment(assessment_id)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/assessments/{assessment_id}", response_model=HiringAssessmentDetailResponse)
def update_assessment(
    assessment_id: str,
    payload: HiringAssessmentUpdateRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).update_assessment(
            assessment_id=assessment_id,
            payload=payload,
            provided_fields=set(payload.model_fields_set),
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/assessments/{assessment_id}/items/{item_id}/reference", response_model=HiringAssessmentDetailResponse)
def update_item_reference(
    assessment_id: str,
    item_id: str,
    payload: HiringAssessmentItemReferenceUpdateRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).update_item_reference(
            assessment_id=assessment_id,
            item_id=item_id,
            payload=payload,
            actor=current_user,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/assessments/{assessment_id}/items/upload", response_model=HiringImportResponse)
def upload_assessment_audio(
    assessment_id: str,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).import_uploaded_audio(assessment_id=assessment_id, files=files)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/assessments/{assessment_id}/items/folder", response_model=HiringImportResponse)
def import_assessment_folder(
    assessment_id: str,
    payload: HiringFolderImportRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).import_folder(
            assessment_id=assessment_id,
            folder_path=payload.folder_path,
            recursive=payload.recursive,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/audio-buckets", response_model=HiringAudioBucketListResponse)
def list_audio_buckets(
    payload: HiringAudioBucketListRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).list_audio_buckets(root_path=payload.root_path, recursive=payload.recursive)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/assignments/{assignment_id}/items/folder", response_model=HiringImportResponse)
def import_assignment_folder(
    assignment_id: str,
    payload: HiringFolderImportRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).import_assignment_folder(
            assignment_id=assignment_id,
            folder_path=payload.folder_path,
            recursive=payload.recursive,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/assessments/{assessment_id}/items/manifest", response_model=HiringImportResponse)
def import_assessment_manifest(
    assessment_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).import_manifest(assessment_id=assessment_id, file=file)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/assessments/{assessment_id}/assignments", response_model=HiringAssignmentListResponse)
def assign_candidates(
    assessment_id: str,
    payload: HiringAssignmentCreateRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).assign_candidates(
            assessment_id=assessment_id,
            candidate_ids=payload.candidate_ids,
            actor=current_user,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/assessments/{assessment_id}/assignments", response_model=HiringAssignmentListResponse)
def list_assessment_assignments(
    assessment_id: str,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).list_assessment_assignments(assessment_id)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/assessments/{assessment_id}/ranking", response_model=HiringRankingResponse)
def get_assessment_ranking(
    assessment_id: str,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).assessment_ranking(assessment_id)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/assignments/{assignment_id}/invite", response_model=HiringAssignmentInviteResponse)
def create_assignment_invite(
    assignment_id: str,
    request: Request,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    public_base_url = request.headers.get("origin") or str(request.base_url).split("/api/", 1)[0].rstrip("/")
    try:
        return HiringService(db).create_assignment_invite(
            assignment_id=assignment_id,
            actor=current_user,
            public_base_url=public_base_url,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/assignments/{assignment_id}/review", response_model=HiringAdminAssignmentReviewResponse)
def get_assignment_review(
    assignment_id: str,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).get_admin_assignment_review(assignment_id)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/assignments/{assignment_id}/access", response_model=HiringAssignmentSummaryResponse)
def update_assignment_access(
    assignment_id: str,
    payload: HiringAssignmentAccessUpdateRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).update_assignment_access(
            assignment_id=assignment_id,
            payload=payload,
            actor=current_user,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.delete("/assignments/{assignment_id}/items", response_model=HiringAssignmentSummaryResponse)
def clear_assignment_audio(
    assignment_id: str,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).clear_assignment_audio(assignment_id=assignment_id, actor=current_user)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.delete("/assignments/{assignment_id}", response_model=HiringAssignmentDeleteResponse)
def delete_assignment(
    assignment_id: str,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).delete_assignment(assignment_id=assignment_id, actor=current_user)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/assignments/{assignment_id}/audit-events", response_model=HiringAuditEventListResponse)
def get_assignment_audit_events(
    assignment_id: str,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).assignment_audit_events(assignment_id)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/assignments/{assignment_id}/scorecard", response_model=HiringAdminAssignmentReviewResponse)
def update_assignment_scorecard(
    assignment_id: str,
    payload: HiringScorecardUpdateRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).update_scorecard(assignment_id=assignment_id, payload=payload, actor=current_user)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/submissions/{submission_id}/validation", response_model=HiringSubmissionResponse)
def update_submission_validation(
    submission_id: str,
    payload: HiringSubmissionValidationRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return HiringService(db).update_submission_validation(
            submission_id=submission_id,
            payload=payload,
            actor=current_user,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/candidate/assignments", response_model=HiringAssignmentListResponse)
def list_candidate_assignments(
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.CANDIDATE)),
):
    return HiringService(db).list_candidate_assignments(actor=current_user)


@router.get("/candidate/assignments/{assignment_id}", response_model=HiringCandidateAssignmentDetailResponse)
def get_candidate_assignment(
    assignment_id: str,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.CANDIDATE)),
):
    try:
        return HiringService(db).get_candidate_assignment(assignment_id=assignment_id, actor=current_user)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/candidate/submissions/{submission_id}", response_model=HiringCandidateAssignmentDetailResponse)
def update_candidate_submission(
    submission_id: str,
    payload: HiringSubmissionUpdateRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.CANDIDATE)),
):
    try:
        return HiringService(db).update_submission(
            submission_id=submission_id,
            payload=payload,
            provided_fields=set(payload.model_fields_set),
            actor=current_user,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/candidate/assignments/{assignment_id}/submit", response_model=HiringCandidateAssignmentDetailResponse)
def submit_candidate_assignment(
    assignment_id: str,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.CANDIDATE)),
):
    try:
        return HiringService(db).submit_assignment(assignment_id=assignment_id, actor=current_user)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/candidate/detect-pii", response_model=DetectPIIResponse)
def detect_candidate_pii(
    payload: DetectPIIRequest,
    _: User = Depends(require_roles(RoleEnum.CANDIDATE)),
):
    return DetectPIIResponse(
        pii_annotations=detect_pii_ensemble(payload.transcript, include_ml=payload.include_ml)
    )


@router.get("/candidate/assignments/{assignment_id}/items/{item_id}/download")
def download_candidate_item(
    assignment_id: str,
    item_id: str,
    request: Request,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.CANDIDATE)),
):
    try:
        path, filename = HiringService(db).candidate_download_path(
            assignment_id=assignment_id,
            item_id=item_id,
            actor=current_user,
        )
        SecurityAuditService(db).log_event(
            action="DOWNLOAD_HIRING_AUDIO",
            actor=current_user,
            resource_type="hiring_audio",
            resource_id=item_id,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={"assignment_id": assignment_id, "filename": filename},
        )
        return FileResponse(
            path,
            media_type="audio/wav",
            filename=filename,
            headers={"Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff"},
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/candidate/assignments/{assignment_id}/download-zip")
def download_candidate_zip(
    assignment_id: str,
    request: Request,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.CANDIDATE)),
):
    try:
        payload, filename = HiringService(db).candidate_zip_bytes(assignment_id=assignment_id, actor=current_user)
        SecurityAuditService(db).log_event(
            action="DOWNLOAD_HIRING_AUDIO_ZIP",
            actor=current_user,
            resource_type="hiring_assignment",
            resource_id=assignment_id,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={"assignment_id": assignment_id},
        )
        return Response(
            content=payload,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store, max-age=0",
                "X-Content-Type-Options": "nosniff",
            },
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc
