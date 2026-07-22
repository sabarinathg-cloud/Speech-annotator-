from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, get_db_session
from app.core.device_policy import require_laptop_or_desktop_device
from app.models.user import User
from app.schemas.auth import (
    ChangePasswordRequest,
    ChangePasswordResponse,
    LoginRequest,
    RefreshRequest,
    TokenResponse,
    UserResponse,
)
from app.services.auth_service import AuthService
from app.services.errors import ServiceError
from app.services.organization_service import OrganizationService

router = APIRouter(prefix="/auth", tags=["auth"])


def _http_error(exc: ServiceError) -> HTTPException:
    detail = {"message": exc.message}
    detail.update(exc.extra)
    return HTTPException(status_code=exc.status_code, detail=detail)


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db_session)):
    require_laptop_or_desktop_device(request)
    service = AuthService(db)
    try:
        return service.login(payload.email, payload.password, request.client.host if request.client else None)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest, request: Request, db: Session = Depends(get_db_session)):
    require_laptop_or_desktop_device(request)
    service = AuthService(db)
    try:
        return service.refresh(payload.refresh_token)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.get("/me", response_model=UserResponse)
def me(current_user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    organizations = OrganizationService(db).organization_access_for_user(current_user)
    return UserResponse.model_validate(current_user).model_copy(
        update={
            "organizations": organizations,
            "default_organization_id": organizations[0].id if organizations else None,
        }
    )


@router.post("/confidentiality-acknowledgement", response_model=TokenResponse)
def acknowledge_confidentiality(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
):
    service = AuthService(db)
    return service.acknowledge_confidentiality(
        user=current_user,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )


@router.post("/change-password", response_model=ChangePasswordResponse)
def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
):
    service = AuthService(db)
    try:
        return service.change_password(
            user=current_user,
            current_password=payload.current_password,
            new_password=payload.new_password,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc
