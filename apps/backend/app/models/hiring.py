import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
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
from app.models.enums import (
    HiringAssessmentStatusEnum,
    HiringAssignmentStatusEnum,
    HiringDecisionEnum,
    HiringSubmissionValidationStatusEnum,
)
from app.models.task import enum_values


class HiringAssessment(Base, TimestampMixin):
    __tablename__ = "hiring_assessments"
    __table_args__ = (
        Index("ix_hiring_assessments_status", "status"),
        Index("ix_hiring_assessments_created_by_id", "created_by_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    instructions: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[HiringAssessmentStatusEnum] = mapped_column(
        Enum(
            HiringAssessmentStatusEnum,
            name="hiring_assessment_status_enum",
            values_callable=enum_values,
        ),
        default=HiringAssessmentStatusEnum.DRAFT,
        nullable=False,
    )
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    time_limit_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    blind_review_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    metadata_schema: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    pii_label_keys: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    rubric_schema: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    created_by_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )

    created_by = relationship("User", foreign_keys=[created_by_id])
    items = relationship("HiringAssessmentItem", back_populates="assessment", cascade="all, delete-orphan")
    assignments = relationship("HiringAssignment", back_populates="assessment", cascade="all, delete-orphan")


class HiringAssessmentItem(Base, TimestampMixin):
    __tablename__ = "hiring_assessment_items"
    __table_args__ = (
        Index("ix_hiring_assessment_items_assessment_id", "assessment_id"),
        Index("ix_hiring_assessment_items_assignment_id", "assignment_id"),
        UniqueConstraint("assessment_id", "external_id", name="uq_hiring_items_assessment_external"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    assessment_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("hiring_assessments.id", ondelete="CASCADE"), nullable=False
    )
    assignment_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("hiring_assignments.id", ondelete="CASCADE"), nullable=True
    )
    external_id: Mapped[str] = mapped_column(String(255), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    original_source: Mapped[str] = mapped_column(Text, nullable=False)
    stored_path: Mapped[str] = mapped_column(Text, nullable=False)
    reference_transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    reference_pii_annotations: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    reference_pii_entries: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    reference_metadata: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    assessment = relationship("HiringAssessment", back_populates="items")
    assignment = relationship("HiringAssignment", back_populates="items")
    submissions = relationship("HiringSubmission", back_populates="item", cascade="all, delete-orphan")


class HiringAssignment(Base, TimestampMixin):
    __tablename__ = "hiring_assignments"
    __table_args__ = (
        UniqueConstraint("assessment_id", "candidate_id", name="uq_hiring_assignments_assessment_candidate"),
        Index("ix_hiring_assignments_assessment_id", "assessment_id"),
        Index("ix_hiring_assignments_candidate_id", "candidate_id"),
        Index("ix_hiring_assignments_status", "status"),
        Index("ix_hiring_assignments_invite_token", "invite_token"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    assessment_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("hiring_assessments.id", ondelete="CASCADE"), nullable=False
    )
    candidate_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    assigned_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    evaluator_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[HiringAssignmentStatusEnum] = mapped_column(
        Enum(
            HiringAssignmentStatusEnum,
            name="hiring_assignment_status_enum",
            values_callable=enum_values,
        ),
        default=HiringAssignmentStatusEnum.ASSIGNED,
        nullable=False,
    )
    decision: Mapped[HiringDecisionEnum] = mapped_column(
        Enum(HiringDecisionEnum, name="hiring_decision_enum", values_callable=enum_values),
        default=HiringDecisionEnum.PENDING,
        nullable=False,
    )
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    evaluated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    invite_token: Mapped[str | None] = mapped_column(String(120), unique=True, nullable=True)
    invite_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    invite_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    access_revoked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    transcript_score: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)
    pii_score: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)
    metadata_score: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)
    total_score: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)
    rubric_scores: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    evaluator_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    version: Mapped[int] = mapped_column(default=1, nullable=False)

    assessment = relationship("HiringAssessment", back_populates="assignments")
    candidate = relationship("User", foreign_keys=[candidate_id])
    assigned_by = relationship("User", foreign_keys=[assigned_by_id])
    evaluator = relationship("User", foreign_keys=[evaluator_id])
    submissions = relationship("HiringSubmission", back_populates="assignment", cascade="all, delete-orphan")
    items = relationship("HiringAssessmentItem", back_populates="assignment", cascade="all, delete-orphan")


class HiringSubmission(Base, TimestampMixin):
    __tablename__ = "hiring_submissions"
    __table_args__ = (
        UniqueConstraint("assignment_id", "item_id", name="uq_hiring_submissions_assignment_item"),
        Index("ix_hiring_submissions_assignment_id", "assignment_id"),
        Index("ix_hiring_submissions_item_id", "item_id"),
        Index("ix_hiring_submissions_validation_status", "validation_status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    assignment_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("hiring_assignments.id", ondelete="CASCADE"), nullable=False
    )
    item_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("hiring_assessment_items.id", ondelete="CASCADE"), nullable=False
    )
    final_transcript: Mapped[str] = mapped_column(Text, default="", nullable=False)
    pii_annotations: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    pii_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    pii_entries: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    metadata_values: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    pii_reviewed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    validation_status: Mapped[HiringSubmissionValidationStatusEnum] = mapped_column(
        Enum(
            HiringSubmissionValidationStatusEnum,
            name="hiring_submission_validation_status_enum",
            values_callable=enum_values,
        ),
        default=HiringSubmissionValidationStatusEnum.PENDING,
        nullable=False,
    )
    validation_feedback: Mapped[str | None] = mapped_column(Text, nullable=True)
    version: Mapped[int] = mapped_column(default=1, nullable=False)
    last_saved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    assignment = relationship("HiringAssignment", back_populates="submissions")
    item = relationship("HiringAssessmentItem", back_populates="submissions")
