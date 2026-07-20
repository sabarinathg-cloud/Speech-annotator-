from collections.abc import Generator
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.device_policy import require_laptop_or_desktop_device
from app.core.security import decode_access_token
from app.models.enums import RoleEnum
from app.models.organization import Organization
from app.models.user import User
from app.services.organization_service import OrganizationService
from app.services.auth_service import SESSION_REPLACED_MESSAGE

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")
ORGANIZATION_HEADER = "X-Organization-ID"


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


def get_current_organization(
    db: Session = Depends(get_db_session),
    current_user: User = Depends(require_confidentiality_ack),
    organization_id: str | None = Header(default=None, alias=ORGANIZATION_HEADER),
) -> Organization:
    service = OrganizationService(db)
    if organization_id:
        organization = service.get_organization_or_404(organization_id)
        if not organization.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Organization is inactive")
        if not service.user_has_access(current_user, organization.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access to organization")
        return organization

    organizations = service.organizations_for_user(current_user)
    if len(organizations) == 1:
        return organizations[0]
    if current_user.role == RoleEnum.ADMIN and organizations:
        default = next((item for item in organizations if item.slug == "default"), None)
        return default or organizations[0]
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{ORGANIZATION_HEADER} header is required")


def require_org_feature(feature_name: str):
    def feature_dependency(organization: Organization = Depends(get_current_organization)) -> Organization:
        if not bool(getattr(organization, feature_name, False)):
            label = feature_name.replace("_enabled", "").replace("_", " ")
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"{label.title()} is disabled for this organization")
        return organization

    return feature_dependency
