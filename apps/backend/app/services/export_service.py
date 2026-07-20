from io import BytesIO
from datetime import date, datetime, time, timezone
from typing import Literal

import pandas as pd
from sqlalchemy import and_, select
from sqlalchemy.orm import Session, joinedload

from app.models.enums import TaskStatusEnum
from app.models.task import AnnotationTask

DEFAULT_EXPORT_COLUMNS = [
    "final_transcript_corrected",
    "notes_corrected",
    "annotation_status",
    "corrected_speaker_gender",
    "corrected_speaker_role",
    "corrected_language",
    "corrected_channel",
    "corrected_duration_seconds",
    "assignee_email",
    "assignee_name",
    "last_tagger_email",
    "last_tagger_name",
    "updated_at",
    "last_saved_at",
    "task_id",
    "external_id",
]


class ExportService:
    def __init__(self, db: Session):
        self.db = db

    def export_tasks(
        self,
        *,
        job_id: str | None,
        export_format: Literal["csv", "xlsx"],
        status: TaskStatusEnum | None = None,
        assignee_id: str | None = None,
        language: str | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        task_ids: list[str] | None = None,
    ) -> tuple[bytes, str]:
        stmt = select(AnnotationTask).options(
            joinedload(AnnotationTask.assignee),
            joinedload(AnnotationTask.last_tagger),
        )

        filters = []
        if job_id:
            filters.append(AnnotationTask.upload_job_id == job_id)
        if status:
            filters.append(AnnotationTask.status == status)
        if assignee_id:
            if assignee_id == "unassigned":
                filters.append(AnnotationTask.assignee_id.is_(None))
            else:
                filters.append(AnnotationTask.assignee_id == assignee_id)
        if language:
            filters.append(AnnotationTask.language == language)
        if date_from:
            filters.append(AnnotationTask.updated_at >= datetime.combine(date_from, time.min, tzinfo=timezone.utc))
        if date_to:
            filters.append(AnnotationTask.updated_at <= datetime.combine(date_to, time.max, tzinfo=timezone.utc))
        if task_ids:
            filters.append(AnnotationTask.id.in_(task_ids))
        if filters:
            stmt = stmt.where(and_(*filters))

        stmt = stmt.order_by(AnnotationTask.created_at.asc())
        tasks = list(self.db.execute(stmt).unique().scalars().all())

        rows = [self._serialize_task(task) for task in tasks]
        dataframe = pd.DataFrame(rows, columns=None if rows else DEFAULT_EXPORT_COLUMNS)

        if export_format == "xlsx":
            output = BytesIO()
            with pd.ExcelWriter(output, engine="openpyxl") as writer:
                dataframe.to_excel(writer, index=False, sheet_name="annotations")
            return output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

        output = dataframe.to_csv(index=False).encode("utf-8")
        return output, "text/csv"

    def _serialize_task(self, task: AnnotationTask) -> dict:
        row = dict(task.original_row or {})
        row["final_transcript_corrected"] = task.final_transcript or ""
        row["notes_corrected"] = task.notes or ""
        row["annotation_status"] = task.status.value
        row["corrected_speaker_gender"] = task.speaker_gender or ""
        row["corrected_speaker_role"] = task.speaker_role or ""
        row["corrected_language"] = task.language or ""
        row["corrected_channel"] = task.channel or ""
        row["corrected_duration_seconds"] = (
            float(task.duration_seconds) if task.duration_seconds is not None else ""
        )
        for key, value in (task.custom_metadata or {}).items():
            row[f"corrected_custom_{key}"] = value
        row["assignee_email"] = task.assignee.email if task.assignee else ""
        row["assignee_name"] = task.assignee.full_name if task.assignee else ""
        row["last_tagger_email"] = task.last_tagger.email if task.last_tagger else ""
        row["last_tagger_name"] = task.last_tagger.full_name if task.last_tagger else ""
        row["updated_at"] = task.updated_at.isoformat()
        row["last_saved_at"] = task.last_saved_at.isoformat() if task.last_saved_at else ""
        row["task_id"] = task.id
        row["external_id"] = task.external_id
        return row
