import re
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


def normalize_label_key(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9]+", "_", value.strip()).strip("_").upper()
    if not normalized:
        raise ValueError("label key cannot be empty")
    return normalized


def normalize_hex_color(value: str) -> str:
    normalized = value.strip()
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", normalized):
        raise ValueError("color must be a 6-digit hex value")
    return normalized.lower()


class PIILabelResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str
    key: str
    display_name: str
    color: str
    description: str | None
    is_active: bool
    sort_order: int
    created_at: datetime
    updated_at: datetime


class PIILabelListResponse(BaseModel):
    items: list[PIILabelResponse]


class PIILabelCreateRequest(BaseModel):
    key: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1, max_length=120)
    color: str = Field(default="#64748b", min_length=1, max_length=32)
    description: str | None = Field(default=None, max_length=1000)
    is_active: bool = True
    sort_order: int | None = Field(default=None, ge=0)

    @field_validator("key")
    @classmethod
    def normalize_key(cls, value: str) -> str:
        return normalize_label_key(value)

    @field_validator("color")
    @classmethod
    def normalize_color(cls, value: str) -> str:
        return normalize_hex_color(value)


class PIILabelUpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    color: str | None = Field(default=None, min_length=1, max_length=32)
    description: str | None = Field(default=None, max_length=1000)
    is_active: bool | None = None
    sort_order: int | None = Field(default=None, ge=0)

    @field_validator("color")
    @classmethod
    def normalize_color(cls, value: str | None) -> str | None:
        return normalize_hex_color(value) if value is not None else None
