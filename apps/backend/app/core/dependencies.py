from collections.abc import Generator
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.device_policy import require_laptop_or_desktop_device
from app.core.security import decode_access_token
from app.models.enums import RoleEnum
from app.models.user import User
from app.services.auth_service import SESSION_REPLACED_MESSAGE

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


def get_db_session() -> Generator[Session, None, None]:
    yield from get_db()


def get_current_user(
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db_session),
) -> User:
    require_laptop_or_desktop_device(request)
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    replaced_session_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"message": SESSION_REPLACED_MESSAGE},
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = decode_access_token(token)
        if payload.get("type") != "access":
            raise credentials_exception
        user_id = payload.get("sub")
        if not user_id:
            raise credentials_exception
    except ValueError:
        raise credentials_exception

    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise credentials_exception
    session_id = payload.get("sid")
    if not session_id or not user.active_session_id or session_id != user.active_session_id:
        raise replaced_session_exception
    user.last_activity_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user)
    return user


def require_confidentiality_ack(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.confidentiality_acknowledged_for_session:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"message": "Confidentiality acknowledgement required"},
        )
    return current_user


def require_roles(*roles: RoleEnum):
    def role_dependency(current_user: User = Depends(require_confidentiality_ack)) -> User:
        if current_user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
        return current_user

    return role_dependency
