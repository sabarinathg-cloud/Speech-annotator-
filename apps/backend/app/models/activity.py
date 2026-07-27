import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class UserActivityEntry(Base, TimestampMixin):
    __tablename__ = "user_activity_entries"
    __table_args__ = (
        Index("ix_user_activity_entries_organization_user_started", "organization_id", "user_id", "started_at"),
        Index("ix_user_activity_entries_organization_task_started", "organization_id", "task_id", "started_at"),
        Index("ix_user_activity_entries_started_at", "started_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    organization_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    task_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("annotation_tasks.id", ondelete="SET NULL"), nullable=True
    )
    route: Mapped[str | None] = mapped_column(Text, nullable=True)
    active_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    idle_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    event_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    organization = relationship("Organization")
    user = relationship("User")
    task = relationship("AnnotationTask")
