import secrets
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
    verify_password,
)
from app.models.user import User
from app.repositories.user_repository import UserRepository
from app.schemas.auth import TokenResponse, UserResponse
from app.services.errors import ServiceError
from app.services.organization_service import OrganizationService
from app.services.rate_limit_service import LoginRateLimiter
from app.services.security_audit_service import CONFIDENTIALITY_ACKNOWLEDGEMENT_VERSION, SecurityAuditService

SESSION_REPLACED_MESSAGE = "Session ended because this account signed in on another device."


class AuthService:
    def __init__(self, db: Session):
        self.db = db
        self.user_repo = UserRepository(db)
        self.rate_limiter = LoginRateLimiter()

    def login(self, email: str, password: str, client_host: str | None = None) -> TokenResponse:
        user = self.user_repo.get_by_email(email)
        if user and verify_password(password, user.password_hash):
            if not user.is_active:
                raise ServiceError("User account is inactive", status_code=403)
            now = datetime.now(timezone.utc)
            user.last_login_at = now
            user.last_activity_at = now
            user.active_session_id = secrets.token_urlsafe(32)
            user.active_session_started_at = now
            user.confidentiality_acknowledged_session_id = None
            self.db.commit()
            self.db.refresh(user)
            self.rate_limiter.reset(email, client_host)
            return self._build_token_response(user)

        if self.rate_limiter.is_blocked(email, client_host):
            raise ServiceError("Too many failed login attempts. Try again later.", status_code=429)
        self.rate_limiter.record_failure(email, client_host)
        raise ServiceError("Invalid email or password", status_code=401)

    def refresh(self, refresh_token: str) -> TokenResponse:
        try:
            payload = decode_refresh_token(refresh_token)
        except ValueError as exc:
            raise ServiceError("Invalid refresh token", status_code=401) from exc
        if payload.get("type") != "refresh":
            raise ServiceError("Invalid refresh token type", status_code=401)
        user_id = payload.get("sub")
        if not user_id:
            raise ServiceError("Invalid refresh token payload", status_code=401)
        user = self.user_repo.get_by_id(user_id)
        if not user or not user.is_active:
            raise ServiceError("User no longer available", status_code=401)
        session_id = payload.get("sid")
        if not session_id or not user.active_session_id or session_id != user.active_session_id:
            raise ServiceError(SESSION_REPLACED_MESSAGE, status_code=401)
        return self._build_token_response(user)

    def acknowledge_confidentiality(
        self,
        *,
        user: User,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> TokenResponse:
        now = datetime.now(timezone.utc)
        user.confidentiality_acknowledged_at = now
        user.confidentiality_acknowledged_version = CONFIDENTIALITY_ACKNOWLEDGEMENT_VERSION
        user.confidentiality_acknowledged_session_id = user.active_session_id
        user.last_activity_at = now
        self.db.flush()
        SecurityAuditService(self.db).log_event(
            action="ACKNOWLEDGE_CONFIDENTIALITY",
            actor=user,
            resource_type="user",
            resource_id=user.id,
            ip_address=ip_address,
            user_agent=user_agent,
            metadata={"acknowledgement_version": CONFIDENTIALITY_ACKNOWLEDGEMENT_VERSION},
            commit=False,
        )
        self.db.commit()
        self.db.refresh(user)
        return self._build_token_response(user)

    def _build_token_response(self, user: User) -> TokenResponse:
        access_token = create_access_token(user.id, user.role.value, session_id=user.active_session_id)
        refresh_token = create_refresh_token(user.id, user.role.value, session_id=user.active_session_id)
        organizations = OrganizationService(self.db).organization_access_for_user(user)
        return TokenResponse(
            access_token=access_token,
            refresh_token=refresh_token,
            user=UserResponse.model_validate(user).model_copy(
                update={
                    "organizations": organizations,
                    "default_organization_id": organizations[0].id if organizations else None,
                }
            ),
        )
