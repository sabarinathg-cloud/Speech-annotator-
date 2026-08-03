import re
import uuid
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models.enums import RoleEnum
from app.models.organization import Organization, OrganizationMembership, OrganizationQuestionnaire
from app.models.user import User
from app.schemas.organization import (
    DEFAULT_ORGANIZATION_INSTRUCTIONS,
    OrganizationQuestionnaireResponse,
    OrganizationQuestionnaireUpsertRequest,
    OrganizationMemberListResponse,
    OrganizationMemberResponse,
    OrganizationResponse,
    QuestionnaireQuestion,
    UserOrganizationAccess,
    normalize_slug,
)
from app.services.errors import ServiceError

DEFAULT_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000001"
DEFAULT_ORGANIZATION_SLUG = "default"


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return normalize_slug(slug or f"org-{uuid.uuid4().hex[:8]}")


def organization_access_response(organization: Organization) -> UserOrganizationAccess:
    return UserOrganizationAccess(
        id=organization.id,
        name=organization.name,
        slug=organization.slug,
        is_active=organization.is_active,
        settings={
            "metadata_enabled": organization.metadata_enabled,
            "pii_enabled": organization.pii_enabled,
            "transcript_redaction_enabled": organization.transcript_redaction_enabled,
            "audio_masking_enabled": organization.audio_masking_enabled,
            "hiring_enabled": organization.hiring_enabled,
            "instructions": organization.instructions,
        },
    )


class OrganizationService:
    def __init__(self, db: Session):
        self.db = db

    def ensure_default_organization(self) -> Organization:
        organization = self.db.get(Organization, DEFAULT_ORGANIZATION_ID)
        if organization:
            return organization
        organization = self.db.execute(
            select(Organization).where(Organization.slug == DEFAULT_ORGANIZATION_SLUG)
        ).scalar_one_or_none()
        if organization:
            return organization
        organization = Organization(
            id=DEFAULT_ORGANIZATION_ID,
            name="Default Organization",
            slug=DEFAULT_ORGANIZATION_SLUG,
            is_active=True,
            metadata_enabled=True,
            pii_enabled=True,
            transcript_redaction_enabled=True,
            audio_masking_enabled=True,
            hiring_enabled=True,
            instructions=DEFAULT_ORGANIZATION_INSTRUCTIONS,
        )
        self.db.add(organization)
        self.db.flush()
        return organization

    def ensure_default_membership(self, user: User) -> None:
        organization = self.ensure_default_organization()
        self.ensure_memberships(user.id, [organization.id])

    def organizations_for_user(self, user: User) -> list[Organization]:
        if user.role == RoleEnum.ADMIN:
            organizations = list(
                self.db.execute(select(Organization).where(Organization.is_active.is_(True)).order_by(Organization.name.asc()))
                .scalars()
                .all()
            )
            if not organizations:
                organizations = [self.ensure_default_organization()]
                self.db.flush()
            return organizations

        organizations = list(
            self.db.execute(
                select(Organization)
                .join(OrganizationMembership, OrganizationMembership.organization_id == Organization.id)
                .where(OrganizationMembership.user_id == user.id)
                .where(OrganizationMembership.is_active.is_(True))
                .where(Organization.is_active.is_(True))
                .order_by(Organization.name.asc())
            )
            .scalars()
            .all()
        )
        if organizations:
            return organizations
        self.ensure_default_membership(user)
        return [self.ensure_default_organization()]

    def organization_access_for_user(self, user: User) -> list[UserOrganizationAccess]:
        return [organization_access_response(org) for org in self.organizations_for_user(user)]

    def list_organizations(self) -> list[OrganizationResponse]:
        organizations = list(self.db.execute(select(Organization).order_by(Organization.name.asc())).scalars().all())
        return [OrganizationResponse.model_validate(org) for org in organizations]

    def create_organization(
        self,
        *,
        name: str,
        slug: str | None,
        is_active: bool,
        metadata_enabled: bool,
        pii_enabled: bool,
        transcript_redaction_enabled: bool,
        audio_masking_enabled: bool,
        hiring_enabled: bool,
        instructions: str | None,
    ) -> OrganizationResponse:
        organization = Organization(
            name=name.strip(),
            slug=normalize_slug(slug) if slug else slugify(name),
            is_active=is_active,
            metadata_enabled=metadata_enabled,
            pii_enabled=pii_enabled,
            transcript_redaction_enabled=transcript_redaction_enabled,
            audio_masking_enabled=audio_masking_enabled,
            hiring_enabled=hiring_enabled,
            instructions=instructions,
        )
        self.db.add(organization)
        try:
            self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            raise ServiceError("Organization slug already exists", status_code=409) from exc
        self.db.refresh(organization)
        return OrganizationResponse.model_validate(organization)

    def update_organization(self, organization_id: str, payload, provided_fields: set[str]) -> OrganizationResponse:
        organization = self.get_organization_or_404(organization_id)
        if "name" in provided_fields and payload.name is not None:
            organization.name = payload.name.strip()
        if "slug" in provided_fields and payload.slug is not None:
            organization.slug = normalize_slug(payload.slug)
        if "instructions" in provided_fields:
            organization.instructions = payload.instructions
        for field in [
            "is_active",
            "metadata_enabled",
            "pii_enabled",
            "transcript_redaction_enabled",
            "audio_masking_enabled",
            "hiring_enabled",
        ]:
            if field in provided_fields and getattr(payload, field) is not None:
                setattr(organization, field, getattr(payload, field))
        try:
            self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            raise ServiceError("Organization slug already exists", status_code=409) from exc
        self.db.refresh(organization)
        return OrganizationResponse.model_validate(organization)

    def get_organization_or_404(self, organization_id: str) -> Organization:
        organization = self.db.get(Organization, organization_id)
        if not organization:
            raise ServiceError("Organization not found", status_code=404)
        return organization

    def list_members(self, organization_id: str) -> OrganizationMemberListResponse:
        self.get_organization_or_404(organization_id)
        rows = list(
            self.db.execute(
                select(User, OrganizationMembership)
                .join(OrganizationMembership, OrganizationMembership.user_id == User.id)
                .where(OrganizationMembership.organization_id == organization_id)
                .order_by(User.full_name.asc())
            )
            .all()
        )
        return OrganizationMemberListResponse(
            items=[
                OrganizationMemberResponse(
                    user_id=user.id,
                    email=user.email,
                    full_name=user.full_name,
                    role=user.role.value,
                    is_active=user.is_active,
                    membership_active=membership.is_active,
                )
                for user, membership in rows
            ]
        )

    def add_member(self, organization_id: str, user_id: str) -> OrganizationMemberListResponse:
        self.get_organization_or_404(organization_id)
        user = self.db.get(User, user_id)
        if not user:
            raise ServiceError("User not found", status_code=404)
        self.ensure_memberships(user_id, [organization_id], replace=False)
        self.db.commit()
        return self.list_members(organization_id)

    def remove_member(self, organization_id: str, user_id: str) -> OrganizationMemberListResponse:
        membership = self.db.execute(
            select(OrganizationMembership)
            .where(OrganizationMembership.organization_id == organization_id)
            .where(OrganizationMembership.user_id == user_id)
        ).scalar_one_or_none()
        if membership:
            self.db.delete(membership)
            self.db.commit()
        return self.list_members(organization_id)

    def get_questionnaire(self, organization_id: str) -> OrganizationQuestionnaireResponse:
        organization = self.get_organization_or_404(organization_id)
        questionnaire = self._active_questionnaire(organization_id)
        if not questionnaire:
            return OrganizationQuestionnaireResponse(
                id=None,
                organization_id=organization.id,
                title="Audio comparison questionnaire",
                description=None,
                questions=[],
                version=1,
                is_active=True,
                created_at=None,
                updated_at=None,
            )
        return self._questionnaire_response(questionnaire)

    def upsert_questionnaire(
        self,
        *,
        organization_id: str,
        payload: OrganizationQuestionnaireUpsertRequest,
    ) -> OrganizationQuestionnaireResponse:
        organization = self.get_organization_or_404(organization_id)
        questionnaire = self._active_questionnaire(organization.id)
        question_payload = [question.model_dump() for question in payload.questions]
        if questionnaire:
            questionnaire.title = payload.title.strip()
            questionnaire.description = payload.description
            questionnaire.questions = question_payload
            questionnaire.is_active = payload.is_active
            questionnaire.version += 1
        else:
            questionnaire = OrganizationQuestionnaire(
                organization_id=organization.id,
                title=payload.title.strip(),
                description=payload.description,
                questions=question_payload,
                version=1,
                is_active=payload.is_active,
            )
            self.db.add(questionnaire)
        self.db.commit()
        self.db.refresh(questionnaire)
        return self._questionnaire_response(questionnaire)

    def active_questionnaire_snapshot(self, organization_id: str) -> tuple[OrganizationQuestionnaire, dict]:
        questionnaire = self._active_questionnaire(organization_id)
        if not questionnaire or not questionnaire.is_active or not questionnaire.questions:
            raise ServiceError("Active audio comparison questionnaire is required for this organization", status_code=422)
        response = self._questionnaire_response(questionnaire)
        return questionnaire, {
            "id": response.id,
            "organization_id": response.organization_id,
            "title": response.title,
            "description": response.description,
            "version": response.version,
            "questions": [question.model_dump() for question in response.questions],
        }

    def _active_questionnaire(self, organization_id: str) -> OrganizationQuestionnaire | None:
        return (
            self.db.execute(
                select(OrganizationQuestionnaire)
                .where(OrganizationQuestionnaire.organization_id == organization_id)
                .where(OrganizationQuestionnaire.is_active.is_(True))
                .order_by(OrganizationQuestionnaire.updated_at.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )

    def _questionnaire_response(self, questionnaire: OrganizationQuestionnaire) -> OrganizationQuestionnaireResponse:
        questions = [
            QuestionnaireQuestion.model_validate(question)
            for question in sorted(
                questionnaire.questions or [],
                key=lambda item: (
                    int(item.get("sort_order", 0)) if isinstance(item, dict) else 0,
                    str(item.get("id", "")) if isinstance(item, dict) else "",
                ),
            )
            if isinstance(question, dict)
        ]
        return OrganizationQuestionnaireResponse(
            id=questionnaire.id,
            organization_id=questionnaire.organization_id,
            title=questionnaire.title,
            description=questionnaire.description,
            questions=questions,
            version=questionnaire.version,
            is_active=questionnaire.is_active,
            created_at=questionnaire.created_at,
            updated_at=questionnaire.updated_at,
        )

    def ensure_memberships(self, user_id: str, organization_ids: Iterable[str], *, replace: bool = True) -> None:
        requested_ids = list(dict.fromkeys(str(org_id) for org_id in organization_ids if str(org_id).strip()))
        if not requested_ids:
            return
        existing_orgs = set(
            self.db.execute(select(Organization.id).where(Organization.id.in_(requested_ids))).scalars().all()
        )
        missing = [org_id for org_id in requested_ids if org_id not in existing_orgs]
        if missing:
            raise ServiceError("One or more organizations were not found", status_code=404, extra={"organization_ids": missing})
        memberships = {
            membership.organization_id: membership
            for membership in self.db.execute(
                select(OrganizationMembership)
                .where(OrganizationMembership.user_id == user_id)
                .options(selectinload(OrganizationMembership.organization))
            )
            .scalars()
            .all()
        }
        if replace:
            for organization_id, membership in memberships.items():
                if organization_id not in requested_ids:
                    membership.is_active = False
        for organization_id in requested_ids:
            membership = memberships.get(organization_id)
            if membership:
                membership.is_active = True
            else:
                self.db.add(OrganizationMembership(user_id=user_id, organization_id=organization_id, is_active=True))
        self.db.flush()

    def user_has_access(self, user: User, organization_id: str) -> bool:
        if user.role == RoleEnum.ADMIN:
            return True
        has_membership = (
            self.db.execute(
                select(OrganizationMembership.id)
                .where(OrganizationMembership.user_id == user.id)
                .where(OrganizationMembership.organization_id == organization_id)
                .where(OrganizationMembership.is_active.is_(True))
            ).scalar_one_or_none()
            is not None
        )
        if has_membership:
            return True
        has_any_membership = (
            self.db.execute(select(OrganizationMembership.id).where(OrganizationMembership.user_id == user.id))
            .scalar_one_or_none()
            is not None
        )
        if not has_any_membership and organization_id == DEFAULT_ORGANIZATION_ID:
            self.ensure_default_membership(user)
            self.db.flush()
            return True
        return False
