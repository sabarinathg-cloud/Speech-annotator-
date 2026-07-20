import uuid

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class PIILabel(Base, TimestampMixin):
    __tablename__ = "pii_labels"
    __table_args__ = (
        UniqueConstraint("organization_id", "key", name="uq_pii_labels_organization_key"),
        Index("ix_pii_labels_organization_id", "organization_id"),
        Index("ix_pii_labels_is_active", "is_active"),
        Index("ix_pii_labels_sort_order", "sort_order"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    organization_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        default="00000000-0000-0000-0000-000000000001",
        nullable=False,
    )
    key: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    color: Mapped[str] = mapped_column(String(32), default="#64748b", nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
