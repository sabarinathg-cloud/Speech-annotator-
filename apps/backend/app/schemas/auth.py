from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr

from app.models.enums import RoleEnum
from app.schemas.organization import UserOrganizationAccess


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: EmailStr
    full_name: str
    role: RoleEnum
    confidentiality_acknowledged_at: datetime | None = None
    confidentiality_acknowledged_version: str | None = None
    confidentiality_acknowledged_for_session: bool = False
    organizations: list[UserOrganizationAccess] = []
    default_organization_id: str | None = None


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse
