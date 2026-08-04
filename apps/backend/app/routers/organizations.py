from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.dependencies import get_db_session, require_roles
from app.models.enums import RoleEnum
from app.models.user import User
from app.schemas.organization import (
    OrganizationCreateRequest,
    OrganizationDeleteResponse,
    OrganizationListResponse,
    OrganizationMemberAddRequest,
    OrganizationMemberListResponse,
    OrganizationQuestionnaireResponse,
    OrganizationQuestionnaireUpsertRequest,
    OrganizationResponse,
    OrganizationUpdateRequest,
)
from app.services.errors import ServiceError
from app.services.organization_service import OrganizationService

router = APIRouter(prefix="/organizations", tags=["organizations"])


def _http_error(exc: ServiceError) -> HTTPException:
    detail = {"message": exc.message}
    detail.update(exc.extra)
    return HTTPException(status_code=exc.status_code, detail=detail)


@router.get("", response_model=OrganizationListResponse)
def list_organizations(
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    return OrganizationListResponse(items=OrganizationService(db).list_organizations())


@router.post("", response_model=OrganizationResponse)
def create_organization(
    payload: OrganizationCreateRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return OrganizationService(db).create_organization(
            name=payload.name,
            slug=payload.slug,
            is_active=payload.is_active,
            metadata_enabled=payload.metadata_enabled,
            pii_enabled=payload.pii_enabled,
            transcript_redaction_enabled=payload.transcript_redaction_enabled,
            audio_masking_enabled=payload.audio_masking_enabled,
            hiring_enabled=payload.hiring_enabled,
            instructions=payload.instructions,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/{organization_id}", response_model=OrganizationResponse)
def update_organization(
    organization_id: str,
    payload: OrganizationUpdateRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return OrganizationService(db).update_organization(
            organization_id=organization_id,
            payload=payload,
            provided_fields=set(payload.model_fields_set),
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.delete("/{organization_id}", response_model=OrganizationDeleteResponse)
def delete_organization(
    organization_id: str,
    confirm_slug: str = Query(min_length=1),
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return OrganizationService(db).delete_organization(
            organization_id=organization_id,
            confirm_slug=confirm_slug,
            actor=current_user,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/{organization_id}/members", response_model=OrganizationMemberListResponse)
def list_members(
    organization_id: str,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return OrganizationService(db).list_members(organization_id)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/{organization_id}/members", response_model=OrganizationMemberListResponse)
def add_member(
    organization_id: str,
    payload: OrganizationMemberAddRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return OrganizationService(db).add_member(organization_id=organization_id, user_id=payload.user_id)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.delete("/{organization_id}/members/{user_id}", response_model=OrganizationMemberListResponse)
def remove_member(
    organization_id: str,
    user_id: str,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return OrganizationService(db).remove_member(organization_id=organization_id, user_id=user_id)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/{organization_id}/questionnaire", response_model=OrganizationQuestionnaireResponse)
def get_questionnaire(
    organization_id: str,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return OrganizationService(db).get_questionnaire(organization_id)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.put("/{organization_id}/questionnaire", response_model=OrganizationQuestionnaireResponse)
def upsert_questionnaire(
    organization_id: str,
    payload: OrganizationQuestionnaireUpsertRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    try:
        return OrganizationService(db).upsert_questionnaire(organization_id=organization_id, payload=payload)
    except ServiceError as exc:
        raise _http_error(exc) from exc
