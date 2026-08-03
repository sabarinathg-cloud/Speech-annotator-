from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DEFAULT_ORGANIZATION_INSTRUCTIONS = """Please read these instructions before starting annotation work.

- Work only on tasks assigned to you in this organization.
- Listen to the full audio before finalizing transcript changes.
- Correct the transcript exactly as spoken, including punctuation when it is clear.
- Complete metadata or PII fields only when they are enabled for this organization.
- Do not copy, download, screenshot, or share customer audio, transcripts, PII, or metadata outside the approved workspace.
- Contact an admin if audio is missing, unclear, duplicated, or assigned incorrectly."""


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
    instructions: str | None = None


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
    instructions: str | None = Field(default=DEFAULT_ORGANIZATION_INSTRUCTIONS, max_length=6000)

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: str | None) -> str | None:
        return normalize_slug(value) if value else value

    @field_validator("instructions")
    @classmethod
    def validate_instructions(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class OrganizationUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=255)
    slug: str | None = Field(default=None, min_length=2, max_length=80)
    is_active: bool | None = None
    metadata_enabled: bool | None = None
    pii_enabled: bool | None = None
    transcript_redaction_enabled: bool | None = None
    audio_masking_enabled: bool | None = None
    hiring_enabled: bool | None = None
    instructions: str | None = Field(default=None, max_length=6000)

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: str | None) -> str | None:
        return normalize_slug(value) if value else value

    @field_validator("instructions")
    @classmethod
    def validate_instructions(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


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


QuestionnaireFieldType = Literal[
    "yes_no",
    "single_select",
    "multi_select",
    "short_text",
    "long_text",
    "number",
    "rating",
    "date",
]


class QuestionnaireQuestion(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1, max_length=500)
    field_type: QuestionnaireFieldType
    help_text: str | None = Field(default=None, max_length=1000)
    required: bool = False
    options: list[str] = Field(default_factory=list, max_length=100)
    sort_order: int = Field(default=0, ge=0, le=10000)
    scoring_key: str | None = Field(default=None, max_length=100)

    @field_validator("id")
    @classmethod
    def validate_question_id(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("question id is required")
        if any(char.isspace() for char in cleaned):
            raise ValueError("question id cannot contain spaces")
        return cleaned

    @field_validator("label")
    @classmethod
    def clean_label(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("question label is required")
        return cleaned

    @field_validator("help_text", "scoring_key")
    @classmethod
    def clean_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("options")
    @classmethod
    def clean_options(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        seen: set[str] = set()
        for option in value or []:
            text = str(option).strip()
            if not text or text in seen:
                continue
            seen.add(text)
            cleaned.append(text)
        return cleaned

    @model_validator(mode="after")
    def validate_options_for_type(self) -> "QuestionnaireQuestion":
        if self.field_type in {"single_select", "multi_select"} and not self.options:
            raise ValueError("select questions require at least one option")
        if self.field_type not in {"single_select", "multi_select"}:
            self.options = []
        return self


class OrganizationQuestionnaireUpsertRequest(BaseModel):
    title: str = Field(default="Audio comparison questionnaire", min_length=2, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    questions: list[QuestionnaireQuestion] = Field(default_factory=list, max_length=200)
    is_active: bool = True

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("questionnaire title is required")
        return cleaned

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @model_validator(mode="after")
    def validate_question_ids(self) -> "OrganizationQuestionnaireUpsertRequest":
        ids = [question.id for question in self.questions]
        if len(ids) != len(set(ids)):
            raise ValueError("question ids must be unique")
        self.questions = sorted(self.questions, key=lambda item: (item.sort_order, item.id))
        return self


class OrganizationQuestionnaireResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str | None = None
    organization_id: str
    title: str
    description: str | None = None
    questions: list[QuestionnaireQuestion] = Field(default_factory=list)
    version: int = 1
    is_active: bool = True
    created_at: datetime | None = None
    updated_at: datetime | None = None


QuestionnaireAnswer = dict[str, Any]
