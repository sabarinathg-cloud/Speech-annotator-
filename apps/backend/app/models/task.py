import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import TaskStatusEnum


def enum_values(enum_cls):
    return [item.value for item in enum_cls]


class AnnotationTask(Base, TimestampMixin):
    __tablename__ = "annotation_tasks"
    __table_args__ = (
        UniqueConstraint("upload_job_id", "external_id", name="uq_annotation_tasks_upload_external"),
        Index("ix_annotation_tasks_organization_id", "organization_id"),
        Index("ix_annotation_tasks_status", "status"),
        Index("ix_annotation_tasks_assignee_id", "assignee_id"),
        Index("ix_annotation_tasks_last_tagger_id", "last_tagger_id"),
        Index("ix_annotation_tasks_updated_at", "updated_at"),
        Index("ix_annotation_tasks_custom_metadata_gin", "custom_metadata", postgresql_using="gin"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    organization_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        default="00000000-0000-0000-0000-000000000001",
        nullable=False,
    )
    external_id: Mapped[str] = mapped_column(String(255), nullable=False)
    upload_job_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("upload_jobs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    file_location: Mapped[str] = mapped_column(Text, nullable=False)
    final_transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[TaskStatusEnum] = mapped_column(
        Enum(TaskStatusEnum, name="task_status_enum", values_callable=enum_values),
        default=TaskStatusEnum.NOT_STARTED,
        nullable=False,
    )

    speaker_gender: Mapped[str | None] = mapped_column(String(50), nullable=True)
    speaker_role: Mapped[str | None] = mapped_column(String(100), nullable=True)
    language: Mapped[str | None] = mapped_column(String(100), nullable=True)
    channel: Mapped[str | None] = mapped_column(String(100), nullable=True)
    duration_seconds: Mapped[Decimal | None] = mapped_column(Numeric(10, 3), nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)

    custom_metadata: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    original_row: Mapped[dict] = mapped_column(JSON, nullable=False)
    pii_annotations: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    alignment_words: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    alignment_transcript_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    alignment_model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    alignment_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    masked_audio_location: Mapped[str | None] = mapped_column(Text, nullable=True)
    masked_audio_pii_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    masked_audio_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    masked_audio_intervals: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    masked_audio_reference_intervals: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    masked_audio_alignment_intervals: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    masked_audio_mode: Mapped[str | None] = mapped_column(String(20), nullable=True)

    assignee_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    last_tagger_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    version: Mapped[int] = mapped_column(default=1, nullable=False)
    last_saved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    organization = relationship("Organization")
    upload_job = relationship("UploadJob", back_populates="tasks")
    assignee = relationship("User", back_populates="assigned_tasks", foreign_keys=[assignee_id])
    last_tagger = relationship("User", foreign_keys=[last_tagger_id])
    transcript_variants = relationship(
        "TaskTranscriptVariant", back_populates="task", cascade="all, delete-orphan"
    )
    status_history = relationship("TaskStatusHistory", back_populates="task", cascade="all, delete-orphan")
    audit_logs = relationship("TaskAuditLog", back_populates="task", cascade="all, delete-orphan")


class TaskTranscriptVariant(Base):
    __tablename__ = "task_transcript_variants"
    __table_args__ = (
        UniqueConstraint("task_id", "source_key", name="uq_task_transcript_variant_task_source"),
        Index("ix_task_transcript_variants_task_id", "task_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    task_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("annotation_tasks.id", ondelete="CASCADE"), nullable=False
    )
    source_key: Mapped[str] = mapped_column(String(100), nullable=False)
    source_label: Mapped[str] = mapped_column(String(150), nullable=False)
    transcript_text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    task = relationship("AnnotationTask", back_populates="transcript_variants")


class TaskAudioGroupReview(Base, TimestampMixin):
    __tablename__ = "task_audio_group_reviews"
    __table_args__ = (
        UniqueConstraint(
            "organization_id",
            "upload_job_id",
            "group_hash",
            "assignment_scope_key",
            name="uq_task_audio_group_reviews_scope",
        ),
        Index("ix_task_audio_group_reviews_organization_id", "organization_id"),
        Index("ix_task_audio_group_reviews_upload_job_id", "upload_job_id"),
        Index("ix_task_audio_group_reviews_assignee_id", "assignee_id"),
        Index("ix_task_audio_group_reviews_group_hash", "group_hash"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    organization_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        nullable=False,
    )
    upload_job_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("upload_jobs.id", ondelete="CASCADE"),
        nullable=False,
    )
    group_key: Mapped[str] = mapped_column(Text, nullable=False)
    group_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    assignee_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    assignment_scope_key: Mapped[str] = mapped_column(String(80), nullable=False)
    transcript: Mapped[str] = mapped_column(Text, default="", nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    organization = relationship("Organization")
    upload_job = relationship("UploadJob")
    assignee = relationship("User")


class TaskStatusHistory(Base):
    __tablename__ = "task_status_history"
    __table_args__ = (Index("ix_task_status_history_task_id", "task_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    task_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("annotation_tasks.id", ondelete="CASCADE"), nullable=False
    )
    old_status: Mapped[TaskStatusEnum | None] = mapped_column(
        Enum(TaskStatusEnum, name="task_status_enum", values_callable=enum_values),
        nullable=True,
    )
    new_status: Mapped[TaskStatusEnum] = mapped_column(
        Enum(TaskStatusEnum, name="task_status_enum", values_callable=enum_values),
        nullable=False,
    )
    changed_by_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    task = relationship("AnnotationTask", back_populates="status_history")


class TaskAuditLog(Base):
    __tablename__ = "task_audit_logs"
    __table_args__ = (Index("ix_task_audit_logs_task_id", "task_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    task_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("annotation_tasks.id", ondelete="CASCADE"), nullable=False
    )
    actor_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    changed_fields: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    previous_values: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    new_values: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    task = relationship("AnnotationTask", back_populates="audit_logs")
