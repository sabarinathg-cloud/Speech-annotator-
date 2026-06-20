from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.dependencies import get_db_session, require_roles
from app.models.enums import RoleEnum
from app.models.user import User
from app.schemas.user import (
    CreateUserRequest,
    ResetPasswordRequest,
    UpdateUserRequest,
    UserAdminResponse,
    UserListResponse,
)
from app.services.errors import ServiceError
from app.services.user_service import UserService

router = APIRouter(prefix="/users", tags=["users"])


def _http_error(exc: ServiceError) -> HTTPException:
    detail = {"message": exc.message}
    detail.update(exc.extra)
    return HTTPException(status_code=exc.status_code, detail=detail)


@router.get("", response_model=UserListResponse)
def list_users(
    search: str | None = Query(default=None, min_length=1, max_length=255),
    role: RoleEnum | None = Query(default=None),
    status: Literal["all", "active", "inactive"] = Query(default="all"),
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    service = UserService(db)
    is_active = None
    if status == "active":
        is_active = True
    elif status == "inactive":
        is_active = False
    return service.list_users(search=search, role=role, is_active=is_active)


@router.post("", response_model=UserAdminResponse)
def create_user(
    payload: CreateUserRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    service = UserService(db)
    try:
        return service.create_user(
            email=str(payload.email),
            full_name=payload.full_name,
            password=payload.password,
            role=payload.role,
            is_active=payload.is_active,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.patch("/{user_id}", response_model=UserAdminResponse)
def update_user(
    user_id: str,
    payload: UpdateUserRequest,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    service = UserService(db)
    try:
        return service.update_user(
            user_id=user_id,
            actor_user_id=current_user.id,
            full_name=payload.full_name,
            password=payload.password,
            role=payload.role,
            is_active=payload.is_active,
        )
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.delete("/{user_id}", response_model=UserAdminResponse)
def delete_user(
    user_id: str,
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    service = UserService(db)
    try:
        return service.deactivate_user(user_id=user_id, actor_user_id=current_user.id)
    except ServiceError as exc:
        raise _http_error(exc) from exc


@router.post("/{user_id}/reset-password", response_model=UserAdminResponse)
def reset_user_password(
    user_id: str,
    payload: ResetPasswordRequest,
    db: Session = Depends(get_db_session),
    _: User = Depends(require_roles(RoleEnum.ADMIN)),
):
    service = UserService(db)
    try:
        return service.reset_password(user_id=user_id, password=payload.password)
    except ServiceError as exc:
        raise _http_error(exc) from exc
