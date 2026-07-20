import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import RoleEnum


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[RoleEnum] = mapped_column(Enum(RoleEnum, name="role_enum"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    confidentiality_acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    confidentiality_acknowledged_version: Mapped[str | None] = mapped_column(String(80), nullable=True)
    confidentiality_acknowledged_session_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    active_session_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    active_session_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    assigned_tasks = relationship("AnnotationTask", back_populates="assignee", foreign_keys="AnnotationTask.assignee_id")
    organization_memberships = relationship(
        "OrganizationMembership", back_populates="user", cascade="all, delete-orphan"
    )

    @property
    def confidentiality_acknowledged_for_session(self) -> bool:
        return bool(
            self.active_session_id
            and self.confidentiality_acknowledged_session_id
            and self.confidentiality_acknowledged_session_id == self.active_session_id
        )
