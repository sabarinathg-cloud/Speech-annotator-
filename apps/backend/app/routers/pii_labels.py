from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_organization, get_db_session, require_confidentiality_ack, require_roles
from app.models.enums import RoleEnum
from app.models.organization import Organization
from app.models.user import User
from app.schemas.pii_label import PIILabelCreateRequest, PIILabelListResponse, PIILabelResponse, PIILabelUpdateRequest
from app.services.pii_label_service import PIILabelService

router = APIRouter(prefix="/pii-labels", tags=["pii-labels"])


@router.get("", response_model=PIILabelListResponse)
def list_active_pii_labels(
    db: Session = Depends(get_db_session),
    _: User = Depends(require_confidentiality_ack),
    organization: Organization = Depends(get_current_organization),
):
    if not organization.pii_enabled:
        return PIILabelListResponse(items=[])
    service = PIILabelService(db)
    return PIILabelListResponse(items=service.list_active_labels(organization_id=organization.id))


@router.get("/admin", response_model=PIILabelListResponse)
def list_admin_pii_labels(
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    service = PIILabelService(db)
    return PIILabelListResponse(items=service.list_admin_labels(organization_id=organization.id))


@router.post("", response_model=PIILabelResponse)
def create_pii_label(
    payload: PIILabelCreateRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    if not organization.pii_enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="PII labels are disabled for this organization")
    service = PIILabelService(db)
    return service.create_label(
        organization_id=organization.id,
        key=payload.key,
        display_name=payload.display_name,
        color=payload.color,
        description=payload.description,
        is_active=payload.is_active,
        sort_order=payload.sort_order,
    )


@router.patch("/{label_id}", response_model=PIILabelResponse)
def update_pii_label(
    label_id: str,
    payload: PIILabelUpdateRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
    organization: Organization = Depends(get_current_organization),
):
    if not organization.pii_enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="PII labels are disabled for this organization")
    service = PIILabelService(db)
    return service.update_label(
        label_id=label_id,
        organization_id=organization.id,
        display_name=payload.display_name,
        color=payload.color,
        description=payload.description,
        is_active=payload.is_active,
        sort_order=payload.sort_order,
        provided_fields=set(payload.model_fields_set),
    )
