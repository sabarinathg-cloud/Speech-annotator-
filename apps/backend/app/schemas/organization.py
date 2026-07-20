from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


def normalize_slug(value: str) -> str:
    slug = value.strip().lower().replace("_", "-")
    slug = "-".join(part for part in slug.split("-") if part)
    if not slug or any(not (char.isalnum() or char == "-") for char in slug):
        raise ValueError("slug must contain only letters, numbers, and hyphens")
    return slug


class OrganizationSettings(BaseModel):
    metadata_enabled: bool
    pii_enabled: bool
    transcript_redaction_enabled: bool
    audio_masking_enabled: bool
    hiring_enabled: bool


class OrganizationResponse(OrganizationSettings):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    slug: str
    is_active: bool
    created_at: datetime
    updated_at: datetime


class UserOrganizationAccess(BaseModel):
    id: str
    name: str
    slug: str
    is_active: bool
    settings: OrganizationSettings


class OrganizationListResponse(BaseModel):
    items: list[OrganizationResponse]


class OrganizationCreateRequest(BaseModel):
    name: str = Field(min_length=2, max_length=255)
    slug: str | None = Field(default=None, min_length=2, max_length=80)
    is_active: bool = True
    metadata_enabled: bool = False
    pii_enabled: bool = False
    transcript_redaction_enabled: bool = False
    audio_masking_enabled: bool = False
    hiring_enabled: bool = False

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: str | None) -> str | None:
        return normalize_slug(value) if value else value


class OrganizationUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=255)
    slug: str | None = Field(default=None, min_length=2, max_length=80)
    is_active: bool | None = None
    metadata_enabled: bool | None = None
    pii_enabled: bool | None = None
    transcript_redaction_enabled: bool | None = None
    audio_masking_enabled: bool | None = None
    hiring_enabled: bool | None = None

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: str | None) -> str | None:
        return normalize_slug(value) if value else value


class OrganizationMemberResponse(BaseModel):
    user_id: str
    email: str
    full_name: str
    role: str
    is_active: bool
    membership_active: bool


class OrganizationMemberListResponse(BaseModel):
    items: list[OrganizationMemberResponse]


class OrganizationMemberAddRequest(BaseModel):
    user_id: str = Field(min_length=1)
