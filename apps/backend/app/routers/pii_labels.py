from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.dependencies import get_db_session, require_confidentiality_ack, require_roles
from app.models.enums import RoleEnum
from app.models.user import User
from app.schemas.pii_label import PIILabelCreateRequest, PIILabelListResponse, PIILabelResponse, PIILabelUpdateRequest
from app.services.pii_label_service import PIILabelService

router = APIRouter(prefix="/pii-labels", tags=["pii-labels"])


@router.get("", response_model=PIILabelListResponse)
def list_active_pii_labels(
    db: Session = Depends(get_db_session),
    _: User = Depends(require_confidentiality_ack),
):
    service = PIILabelService(db)
    return PIILabelListResponse(items=service.list_active_labels())


@router.get("/admin", response_model=PIILabelListResponse)
def list_admin_pii_labels(
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    service = PIILabelService(db)
    return PIILabelListResponse(items=service.list_admin_labels())


@router.post("", response_model=PIILabelResponse)
def create_pii_label(
    payload: PIILabelCreateRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    service = PIILabelService(db)
    return service.create_label(
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
):
    service = PIILabelService(db)
    return service.update_label(
        label_id=label_id,
        display_name=payload.display_name,
        color=payload.color,
        description=payload.description,
        is_active=payload.is_active,
        sort_order=payload.sort_order,
        provided_fields=set(payload.model_fields_set),
    )
