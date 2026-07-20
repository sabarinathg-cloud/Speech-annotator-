from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_organization, get_db_session, require_roles
from app.models.enums import RoleEnum
from app.models.organization import Organization
from app.models.user import User
from app.schemas.job import JobCreateResponse
from app.schemas.upload import (
    ColumnMappingRequest,
    PreviewResponse,
    UploadFileResponse,
    UploadImportResult,
    UploadValidationResult,
)
from app.services.errors import ServiceError
from app.services.job_service import JobService
from app.services.upload_service import UploadService

router = APIRouter(prefix="/uploads", tags=["uploads"])


def _http_error(exc: ServiceError) -> HTTPException:
    detail = {"message": exc.message}
    detail.update(exc.extra)
    return HTTPException(status_code=exc.status_code, detail=detail)


@router.post("", response_model=UploadFileResponse)
def upload_file(
    file: UploadFile = File(...),
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = UploadService(db)
    try:
        return service.upload_excel(file, current_user, organization)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/{upload_job_id}/preview", response_model=PreviewResponse)
def preview_upload(
    upload_job_id: str,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = UploadService(db)
    try:
        return service.preview_upload(upload_job_id, organization=organization)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/{upload_job_id}/validate", response_model=UploadValidationResult)
def validate_upload(
    upload_job_id: str,
    payload: ColumnMappingRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = UploadService(db)
    try:
        return service.validate_upload(upload_job_id, payload, organization=organization)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/{upload_job_id}/import", response_model=UploadImportResult)
def import_upload(
    upload_job_id: str,
    payload: ColumnMappingRequest | None = None,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = UploadService(db)
    try:
        return service.import_upload(upload_job_id, payload, organization=organization)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/{upload_job_id}/import/jobs", response_model=JobCreateResponse)
def enqueue_import_job(
    upload_job_id: str,
    payload: ColumnMappingRequest | None = None,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = JobService(db)
    try:
        job = service.enqueue_import_job(
            upload_job_id=upload_job_id,
            mapping=payload,
            actor=current_user,
            organization=organization,
        )
        return JobCreateResponse(job_id=job.id, status=job.status)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/{upload_job_id}/errors")
def list_errors(
    upload_job_id: str,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = UploadService(db)
    try:
        return service.list_upload_errors(upload_job_id, organization=organization)
    except ServiceError as exc:
        raise _http_error(exc) from exc
