from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.models.enums import RoleEnum
from app.schemas.organization import UserOrganizationAccess


class UserAdminResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: EmailStr
    full_name: str
    role: RoleEnum
    is_active: bool
    last_login_at: datetime | None = None
    last_activity_at: datetime | None = None
    assigned_task_count: int = 0
    open_assigned_task_count: int = 0
    completed_task_count: int = 0
    approved_task_count: int = 0
    assignment_load: Literal["none", "light", "normal", "heavy"] = "none"
    organizations: list[UserOrganizationAccess] = []
    created_at: datetime
    updated_at: datetime


class UserListResponse(BaseModel):
    items: list[UserAdminResponse]


class CreateUserRequest(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=255)
    role: RoleEnum
    password: str = Field(min_length=8, max_length=128)
    is_active: bool = True
    organization_ids: list[str] | None = None


class UpdateUserRequest(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=255)
    role: RoleEnum | None = None
    password: str | None = Field(default=None, min_length=8, max_length=128)
    is_active: bool | None = None
    organization_ids: list[str] | None = None

    @model_validator(mode="after")
    def validate_non_empty_update(self) -> "UpdateUserRequest":
        if (
            self.full_name is None
            and self.role is None
            and self.password is None
            and self.is_active is None
            and self.organization_ids is None
        ):
            raise ValueError("At least one field must be provided")
        return self


class ResetPasswordRequest(BaseModel):
    password: str = Field(min_length=8, max_length=128)
