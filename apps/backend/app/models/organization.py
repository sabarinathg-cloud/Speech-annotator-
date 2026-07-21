import uuid

from sqlalchemy import Boolean, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class Organization(Base, TimestampMixin):
    __tablename__ = "organizations"
    __table_args__ = (
        UniqueConstraint("slug", name="uq_organizations_slug"),
        Index("ix_organizations_status", "is_active"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(80), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    metadata_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    pii_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    transcript_redaction_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    audio_masking_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    hiring_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    instructions: Mapped[str | None] = mapped_column(Text, nullable=True)

    memberships = relationship("OrganizationMembership", back_populates="organization", cascade="all, delete-orphan")


class OrganizationMembership(Base, TimestampMixin):
    __tablename__ = "organization_memberships"
    __table_args__ = (
        UniqueConstraint("organization_id", "user_id", name="uq_organization_memberships_org_user"),
        Index("ix_organization_memberships_organization_id", "organization_id"),
        Index("ix_organization_memberships_user_id", "user_id"),
        Index("ix_organization_memberships_is_active", "is_active"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    organization_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    organization = relationship("Organization", back_populates="memberships")
    user = relationship("User", back_populates="organization_memberships")
