import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import UploadJobStatusEnum


class UploadFile(Base, TimestampMixin):
    __tablename__ = "upload_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    original_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    stored_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    uploaded_by_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )

    jobs = relationship("UploadJob", back_populates="upload_file")


class UploadJob(Base, TimestampMixin):
    __tablename__ = "upload_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    upload_file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("upload_files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[UploadJobStatusEnum] = mapped_column(
        Enum(UploadJobStatusEnum, name="upload_job_status_enum"),
        default=UploadJobStatusEnum.UPLOADED,
        nullable=False,
    )
    mapping_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    preview_row_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    imported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    upload_file = relationship("UploadFile", back_populates="jobs")
    errors = relationship("UploadJobError", back_populates="upload_job", cascade="all, delete-orphan")
    tasks = relationship("AnnotationTask", back_populates="upload_job")


class UploadJobError(Base):
    __tablename__ = "upload_job_errors"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    upload_job_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("upload_jobs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    row_number: Mapped[int] = mapped_column(Integer, nullable=False)
    field_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error_message: Mapped[str] = mapped_column(Text, nullable=False)
    raw_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    upload_job = relationship("UploadJob", back_populates="errors")
