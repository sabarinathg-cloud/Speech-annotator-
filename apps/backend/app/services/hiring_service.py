import json
import re
import secrets
import shutil
import uuid
import zipfile
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from typing import BinaryIO, Iterable
from urllib.parse import quote

import pandas as pd
from fastapi import UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.core.config import get_settings
from app.core.security import get_password_hash
from app.models.enums import (
    HiringAssessmentStatusEnum,
    HiringAssignmentStatusEnum,
    HiringDecisionEnum,
    HiringSubmissionValidationStatusEnum,
    RoleEnum,
)
from app.models.hiring import HiringAssessment, HiringAssessmentItem, HiringAssignment, HiringSubmission
from app.models.security import SecurityAuditEvent
from app.models.user import User
from app.schemas.hiring import (
    HiringAdminAssignmentReviewResponse,
    HiringAssessmentDetailResponse,
    HiringAssessmentItemReferenceUpdateRequest,
    HiringAssessmentItemResponse,
    HiringAssessmentListResponse,
    HiringAssessmentSummaryResponse,
    HiringAssignmentAccessUpdateRequest,
    HiringAssignmentInviteResponse,
    HiringAssignmentListResponse,
    HiringAssignmentSummaryResponse,
    HiringAuditEventListResponse,
    HiringAuditEventResponse,
    HiringCandidateAssignmentDetailResponse,
    HiringImportResponse,
    HiringMetadataField,
    HiringPIIEntry,
    HiringRankingItem,
    HiringRankingResponse,
    HiringReferenceMetrics,
    HiringRubricField,
    HiringScorecardUpdateRequest,
    HiringSubmissionResponse,
    HiringSubmissionUpdateRequest,
    HiringSubmissionValidationRequest,
    HiringTranscriptSubstitution,
    HiringPIIComparisonMismatch,
)
from app.schemas.task import PIIAnnotation
from app.services.errors import ServiceError
from app.services.security_audit_service import SecurityAuditService
from app.services.text_validation import find_invalid_annotation_text
from app.storage.audio_resolver import AudioResolver
from app.utils.excel import load_excel_as_dataframe, normalize_cell

settings = get_settings()
SUPPORTED_HIRING_AUDIO_EXTENSIONS = {".wav"}
HIRING_FOLDER_IMPORT_COMMIT_BATCH_SIZE = 50
HIRING_FOLDER_IMPORT_MAX_MESSAGES = 25


def _now() -> datetime:
    return datetime.now(UTC)


def _safe_decimal(value: float | None) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


def _score_to_float(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


class HiringService:
    def __init__(self, db: Session):
        self.db = db
        self.audio_resolver = AudioResolver()

    def list_assessments(self) -> HiringAssessmentListResponse:
        assessments = list(
            self.db.execute(
                select(HiringAssessment)
                .options(joinedload(HiringAssessment.items), joinedload(HiringAssessment.assignments))
                .order_by(HiringAssessment.created_at.desc())
            )
            .unique()
            .scalars()
            .all()
        )
        return HiringAssessmentListResponse(items=[self._assessment_summary(item) for item in assessments])

    def create_assessment(
        self,
        *,
        title: str,
        instructions: str,
        due_date: date | None,
        due_at: datetime | None,
        time_limit_minutes: int | None,
        blind_review_enabled: bool,
        metadata_schema: list[HiringMetadataField],
        pii_label_keys: list[str],
        rubric_schema: list[HiringRubricField],
        actor: User,
    ) -> HiringAssessmentDetailResponse:
        assessment = HiringAssessment(
            title=title.strip(),
            instructions=instructions or "",
            due_date=due_date or (_as_utc(due_at).date() if due_at else None),
            due_at=_as_utc(due_at) if due_at else None,
            time_limit_minutes=time_limit_minutes,
            blind_review_enabled=blind_review_enabled,
            metadata_schema=[field.model_dump() for field in metadata_schema],
            pii_label_keys=pii_label_keys,
            rubric_schema=[field.model_dump() for field in rubric_schema],
            created_by_id=actor.id,
        )
        self.db.add(assessment)
        self.db.commit()
        self.db.refresh(assessment)
        return self.get_assessment(assessment.id)

    def update_assessment(
        self,
        *,
        assessment_id: str,
        payload,
        provided_fields: set[str],
    ) -> HiringAssessmentDetailResponse:
        assessment = self._get_assessment_or_404(assessment_id)
        if "title" in provided_fields and payload.title is not None:
            assessment.title = payload.title.strip()
        if "instructions" in provided_fields:
            assessment.instructions = payload.instructions or ""
        if "status" in provided_fields and payload.status is not None:
            assessment.status = payload.status
        if "due_date" in provided_fields:
            assessment.due_date = payload.due_date
        if "due_at" in provided_fields:
            assessment.due_at = _as_utc(payload.due_at) if payload.due_at else None
            if "due_date" not in provided_fields:
                assessment.due_date = assessment.due_at.date() if assessment.due_at else None
        if "time_limit_minutes" in provided_fields:
            assessment.time_limit_minutes = payload.time_limit_minutes
        if "blind_review_enabled" in provided_fields and payload.blind_review_enabled is not None:
            assessment.blind_review_enabled = payload.blind_review_enabled
        if "metadata_schema" in provided_fields and payload.metadata_schema is not None:
            assessment.metadata_schema = [field.model_dump() for field in payload.metadata_schema]
        if "pii_label_keys" in provided_fields and payload.pii_label_keys is not None:
            assessment.pii_label_keys = payload.pii_label_keys
        if "rubric_schema" in provided_fields and payload.rubric_schema is not None:
            assessment.rubric_schema = [field.model_dump() for field in payload.rubric_schema]
        self.db.commit()
        return self.get_assessment(assessment.id)

    def update_item_reference(
        self,
        *,
        assessment_id: str,
        item_id: str,
        payload: HiringAssessmentItemReferenceUpdateRequest,
        actor: User,
    ) -> HiringAssessmentDetailResponse:
        assessment = self._get_assessment_or_404(assessment_id)
        item = next((candidate for candidate in assessment.items if candidate.id == item_id), None)
        if not item:
            raise ServiceError("Hiring assessment item not found", status_code=404)
        reference_transcript = (payload.reference_transcript or "").strip()
        item.reference_transcript = reference_transcript or None
        item.reference_pii_entries = [entry.model_dump() for entry in payload.reference_pii_entries]
        if payload.reference_metadata is not None:
            item.reference_metadata = payload.reference_metadata
        SecurityAuditService(self.db).log_event(
            action="UPDATE_HIRING_REFERENCE",
            actor=actor,
            resource_type="hiring_assessment_item",
            resource_id=item.id,
            metadata={
                "assessment_id": assessment.id,
                "reference_transcript_set": bool(item.reference_transcript),
                "reference_pii_count": len(item.reference_pii_entries or []),
            },
            commit=False,
        )
        self.db.commit()
        return self.get_assessment(assessment.id)

    def get_assessment(self, assessment_id: str) -> HiringAssessmentDetailResponse:
        assessment = self._get_assessment_or_404(assessment_id)
        return HiringAssessmentDetailResponse(
            **self._assessment_summary(assessment).model_dump(),
            items=[self._item_response(item, include_reference=True) for item in self._sorted_items(assessment.items)],
        )

    def import_uploaded_audio(self, *, assessment_id: str, files: list[UploadFile]) -> HiringImportResponse:
        assessment = self._get_assessment_or_404(assessment_id)
        imported = 0
        errors: list[str] = []
        for upload in files:
            filename = upload.filename or "upload"
            suffix = Path(filename).suffix.lower()
            try:
                if suffix == ".zip":
                    imported += self._import_zip_file(assessment, upload)
                elif suffix in SUPPORTED_HIRING_AUDIO_EXTENSIONS:
                    self._create_item_from_fileobj(
                        assessment=assessment,
                        source=filename,
                        filename=Path(filename).name,
                        fileobj=upload.file,
                    )
                    imported += 1
                else:
                    raise ServiceError(f"Unsupported hiring audio upload: {filename}", status_code=422)
            except ServiceError as exc:
                errors.append(exc.message)
        self.db.commit()
        return HiringImportResponse(imported_items=imported, skipped_items=len(errors), errors=errors)

    def import_folder(self, *, assessment_id: str, folder_path: str, recursive: bool) -> HiringImportResponse:
        assessment = self._get_assessment_or_404(assessment_id)
        return self._import_folder_items(assessment=assessment, folder_path=folder_path, recursive=recursive)

    def import_assignment_folder(self, *, assignment_id: str, folder_path: str, recursive: bool) -> HiringImportResponse:
        assignment = self._get_assignment_or_404(assignment_id)
        if assignment.status in {HiringAssignmentStatusEnum.SUBMITTED, HiringAssignmentStatusEnum.EVALUATED}:
            raise ServiceError("Submitted hiring assignments cannot receive new audio", status_code=409)
        return self._import_folder_items(
            assessment=assignment.assessment,
            folder_path=folder_path,
            recursive=recursive,
            assignment=assignment,
        )

    def _import_folder_items(
        self,
        *,
        assessment: HiringAssessment,
        folder_path: str,
        recursive: bool,
        assignment: HiringAssignment | None = None,
    ) -> HiringImportResponse:
        folder = self._resolve_allowed_import_path(folder_path)
        if not folder.is_dir():
            raise ServiceError("Hiring audio folder not found", status_code=404)

        files, skipped, errors = self._scan_hiring_folder(folder, recursive=recursive)
        if not files:
            raise ServiceError("No WAV files found in hiring audio folder", status_code=422)

        imported = 0
        existing_sources = self._existing_folder_import_sources(assessment, assignment=assignment)
        next_sort_order = self._next_item_sort_order(assessment, assignment=assignment)
        for path in sorted(files, key=lambda item: str(item)):
            try:
                resolved = self._resolve_allowed_import_path(str(path))
                resolved_source = str(resolved)
                if resolved_source in existing_sources:
                    skipped += 1
                    self._append_import_message(errors, f"Skipped duplicate WAV: {path.name}")
                    continue
                with resolved.open("rb") as source_file:
                    item = self._create_item_from_fileobj(
                        assessment=assessment,
                        source=resolved_source,
                        filename=resolved.name,
                        fileobj=source_file,
                        assignment=assignment,
                        sort_order=next_sort_order,
                    )
                    self._attach_imported_item_to_assignments(assessment=assessment, item=item, assignment=assignment)
                    existing_sources.add(resolved_source)
                    next_sort_order += 1
            except OSError as exc:
                self.db.rollback()
                raise ServiceError(
                    f"Unable to read WAV file {path.name}. Check backend filesystem permissions.",
                    status_code=403,
                ) from exc
            imported += 1
            if imported % HIRING_FOLDER_IMPORT_COMMIT_BATCH_SIZE == 0:
                self.db.commit()
        self.db.commit()
        return HiringImportResponse(imported_items=imported, skipped_items=skipped, errors=errors)

    def import_manifest(self, *, assessment_id: str, file: UploadFile) -> HiringImportResponse:
        assessment = self._get_assessment_or_404(assessment_id)
        filename = file.filename or ""
        suffix = Path(filename).suffix.lower()
        if suffix not in {".xlsx", ".xls"}:
            raise ServiceError("Only .xlsx/.xls hiring manifests are supported", status_code=422)
        content = file.file.read()
        if not content:
            raise ServiceError("Uploaded hiring manifest is empty", status_code=422)
        try:
            dataframe = load_excel_as_dataframe(content, suffix)
        except Exception as exc:
            raise ServiceError("Unable to read hiring manifest", status_code=422) from exc
        if "file_location" not in set(str(column) for column in dataframe.columns):
            raise ServiceError("Hiring manifest requires a file_location column", status_code=422)

        imported = 0
        errors: list[str] = []
        for index, row in dataframe.iterrows():
            row_data = row.to_dict()
            row_number = index + 2
            file_location = str(normalize_cell(row_data.get("file_location", ""))).strip()
            if not file_location:
                errors.append(f"Row {row_number}: file_location is required")
                continue
            try:
                self._import_manifest_row(assessment, file_location, row_data)
                imported += 1
            except (FileNotFoundError, ServiceError) as exc:
                message = exc.message if isinstance(exc, ServiceError) else "Audio file not found"
                errors.append(f"Row {row_number}: {message}")
        self.db.commit()
        return HiringImportResponse(imported_items=imported, skipped_items=len(errors), errors=errors)

    def assign_candidates(
        self,
        *,
        assessment_id: str,
        candidate_ids: list[str],
        actor: User,
    ) -> HiringAssignmentListResponse:
        assessment = self._get_assessment_or_404(assessment_id)
        created_or_existing: list[HiringAssignment] = []
        for candidate_id in candidate_ids:
            candidate = self.db.get(User, candidate_id)
            if not candidate or not candidate.is_active:
                raise ServiceError("Candidate user not found", status_code=404)
            if candidate.role != RoleEnum.CANDIDATE:
                raise ServiceError("Hiring assignments can only be given to candidate users", status_code=422)
            existing = self.db.execute(
                select(HiringAssignment).where(
                    HiringAssignment.assessment_id == assessment.id,
                    HiringAssignment.candidate_id == candidate.id,
                )
            ).scalar_one_or_none()
            assignment = existing or HiringAssignment(
                assessment_id=assessment.id,
                candidate_id=candidate.id,
                assigned_by_id=actor.id,
            )
            if not existing:
                self.db.add(assignment)
                self.db.flush()
            elif existing.access_revoked:
                existing.access_revoked = False
                existing.version += 1
            existing_item_ids = {submission.item_id for submission in assignment.submissions}
            for item in assessment.items:
                if item.assignment_id is None and item.id not in existing_item_ids:
                    submission = HiringSubmission(assignment_id=assignment.id, item_id=item.id)
                    assignment.submissions.append(submission)
                    self.db.add(submission)
            created_or_existing.append(assignment)
        self.db.commit()
        return HiringAssignmentListResponse(items=[self._assignment_summary(item) for item in created_or_existing])

    def list_assessment_assignments(self, assessment_id: str) -> HiringAssignmentListResponse:
        self._get_assessment_or_404(assessment_id)
        assignments = list(
            self.db.execute(
                select(HiringAssignment)
                .options(
                    joinedload(HiringAssignment.assessment).joinedload(HiringAssessment.items),
                    joinedload(HiringAssignment.candidate),
                    joinedload(HiringAssignment.submissions).joinedload(HiringSubmission.item),
                )
                .where(HiringAssignment.assessment_id == assessment_id)
                .order_by(HiringAssignment.assigned_at.desc())
            )
            .unique()
            .scalars()
            .all()
        )
        return HiringAssignmentListResponse(items=[self._assignment_summary(item) for item in assignments])

    def update_assignment_access(
        self,
        *,
        assignment_id: str,
        payload: HiringAssignmentAccessUpdateRequest,
        actor: User,
    ) -> HiringAssignmentSummaryResponse:
        assignment = self._get_assignment_or_404(assignment_id)
        assignment.access_revoked = payload.access_revoked
        if payload.access_revoked:
            assignment.invite_token = None
            assignment.invite_expires_at = None
        assignment.version += 1
        self._log_hiring_event(
            "REVOKE_HIRING_ACCESS" if payload.access_revoked else "RESTORE_HIRING_ACCESS",
            actor=actor,
            resource_type="hiring_assignment",
            resource_id=assignment.id,
            assignment=assignment,
            metadata={"candidate_id": assignment.candidate_id, "access_revoked": payload.access_revoked},
        )
        self.db.commit()
        return self._assignment_summary(assignment)

    def list_candidate_assignments(self, *, actor: User) -> HiringAssignmentListResponse:
        assignments = list(
            self.db.execute(
                select(HiringAssignment)
                .options(
                    joinedload(HiringAssignment.assessment).joinedload(HiringAssessment.items),
                    joinedload(HiringAssignment.candidate),
                    joinedload(HiringAssignment.submissions).joinedload(HiringSubmission.item),
                )
                .where(HiringAssignment.candidate_id == actor.id)
                .where(HiringAssignment.access_revoked.is_(False))
                .order_by(HiringAssignment.assigned_at.desc())
            )
            .unique()
            .scalars()
            .all()
        )
        return HiringAssignmentListResponse(items=[self._assignment_summary(item) for item in assignments])

    def get_candidate_assignment(self, *, assignment_id: str, actor: User) -> HiringCandidateAssignmentDetailResponse:
        assignment = self._get_candidate_assignment_or_404(assignment_id, actor)
        self._mark_assignment_opened(assignment, actor=actor)
        return self._candidate_assignment_detail(assignment, include_reference=False)

    def get_admin_assignment_review(self, assignment_id: str) -> HiringAdminAssignmentReviewResponse:
        assignment = self._get_assignment_or_404(assignment_id)
        detail = self._candidate_assignment_detail(assignment, include_reference=True)
        return HiringAdminAssignmentReviewResponse(
            **detail.model_dump(),
            candidate_id=assignment.candidate_id,
            candidate_name=self._candidate_name_for_admin(assignment),
            candidate_email=self._candidate_email_for_admin(assignment),
            transcript_score=_score_to_float(assignment.transcript_score),
            pii_score=_score_to_float(assignment.pii_score),
            metadata_score=_score_to_float(assignment.metadata_score),
            total_score=_score_to_float(assignment.total_score),
            rubric_scores=assignment.rubric_scores or {},
            evaluator_notes=assignment.evaluator_notes,
        )

    def update_submission(
        self,
        *,
        submission_id: str,
        payload: HiringSubmissionUpdateRequest,
        provided_fields: set[str],
        actor: User,
    ) -> HiringCandidateAssignmentDetailResponse:
        submission = self._get_candidate_submission_or_404(submission_id, actor)
        assignment = submission.assignment
        self._ensure_assignment_editable(assignment)
        if submission.version != payload.version:
            raise ServiceError("Submission was updated elsewhere. Reload and try again.", status_code=409)

        if "final_transcript" in provided_fields and payload.final_transcript is not None:
            message = find_invalid_annotation_text(payload.final_transcript, "transcript")
            if message:
                raise ServiceError(message, status_code=422)
            submission.final_transcript = payload.final_transcript
        if "notes" in provided_fields and payload.notes is not None:
            message = find_invalid_annotation_text(payload.notes, "notes")
            if message:
                raise ServiceError(message, status_code=422)
            submission.notes = payload.notes
        if "pii_text" in provided_fields and payload.pii_text is not None:
            message = find_invalid_annotation_text(payload.pii_text, "PII answer")
            if message:
                raise ServiceError(message, status_code=422)
            submission.pii_text = payload.pii_text
        if "pii_entries" in provided_fields and payload.pii_entries is not None:
            submission.pii_entries = [entry.model_dump() for entry in payload.pii_entries]
        if "metadata_values" in provided_fields and payload.metadata_values is not None:
            self._validate_metadata_values(assignment.assessment, payload.metadata_values, require_all=False)
            submission.metadata_values = payload.metadata_values
        if "pii_reviewed" in provided_fields and payload.pii_reviewed is not None:
            submission.pii_reviewed = payload.pii_reviewed
        if "pii_annotations" in provided_fields and payload.pii_annotations is not None:
            submission.pii_annotations = self._normalize_pii_annotations(
                payload.pii_annotations,
                transcript=submission.final_transcript,
            )

        submission.version += 1
        submission.last_saved_at = _now()
        if assignment.status == HiringAssignmentStatusEnum.ASSIGNED:
            assignment.status = HiringAssignmentStatusEnum.IN_PROGRESS
            assignment.started_at = assignment.started_at or _now()
            assignment.version += 1
        self._log_hiring_event(
            "SAVE_HIRING_SUBMISSION",
            actor=actor,
            resource_type="hiring_submission",
            resource_id=submission.id,
            assignment=assignment,
            metadata={"item_id": submission.item_id, "changed_fields": sorted(provided_fields - {"version"})},
        )
        self.db.commit()
        return self.get_candidate_assignment(assignment_id=assignment.id, actor=actor)

    def submit_assignment(self, *, assignment_id: str, actor: User) -> HiringCandidateAssignmentDetailResponse:
        assignment = self._get_candidate_assignment_or_404(assignment_id, actor)
        self._ensure_assignment_editable(assignment)
        missing = self._submission_readiness_errors(assignment)
        if missing:
            raise ServiceError("Assignment is not ready to submit", status_code=422, extra={"errors": missing})
        submitted_at = _now()
        assignment.status = HiringAssignmentStatusEnum.SUBMITTED
        assignment.submitted_at = submitted_at
        assignment.version += 1
        for submission in assignment.submissions:
            submission.submitted_at = submitted_at
            submission.version += 1
        self._log_hiring_event(
            "SUBMIT_HIRING_ASSIGNMENT",
            actor=actor,
            resource_type="hiring_assignment",
            resource_id=assignment.id,
            assignment=assignment,
            metadata={"submitted_items": len(assignment.submissions or [])},
        )
        self.db.commit()
        return self.get_candidate_assignment(assignment_id=assignment.id, actor=actor)

    def update_submission_validation(
        self,
        *,
        submission_id: str,
        payload: HiringSubmissionValidationRequest,
        actor: User,
    ) -> HiringSubmissionResponse:
        submission = self._get_submission_or_404(submission_id)
        submission.validation_status = payload.validation_status
        submission.validation_feedback = payload.validation_feedback
        submission.version += 1
        self._log_hiring_event(
            "VALIDATE_HIRING_SUBMISSION",
            actor=actor,
            resource_type="hiring_submission",
            resource_id=submission.id,
            assignment=submission.assignment,
            metadata={"item_id": submission.item_id, "validation_status": payload.validation_status.value},
        )
        self.db.commit()
        return self._submission_response(submission, include_reference_metrics=True)

    def update_scorecard(
        self,
        *,
        assignment_id: str,
        payload: HiringScorecardUpdateRequest,
        actor: User,
    ) -> HiringAdminAssignmentReviewResponse:
        assignment = self._get_assignment_or_404(assignment_id)
        rubric_scores = self._validate_rubric_scores(assignment.assessment, payload.rubric_scores)
        assignment.transcript_score = _safe_decimal(payload.transcript_score)
        assignment.pii_score = _safe_decimal(payload.pii_score)
        assignment.metadata_score = _safe_decimal(payload.metadata_score)
        assignment.rubric_scores = rubric_scores
        rubric_total = sum(float(value) for value in rubric_scores.values() if value is not None)
        total_score = payload.total_score if payload.total_score is not None else (rubric_total if rubric_scores else None)
        assignment.total_score = _safe_decimal(total_score)
        assignment.decision = payload.decision
        assignment.evaluator_notes = payload.evaluator_notes
        assignment.evaluator_id = actor.id
        assignment.evaluated_at = _now()
        assignment.status = HiringAssignmentStatusEnum.EVALUATED
        assignment.version += 1
        self._log_hiring_event(
            "SAVE_HIRING_SCORECARD",
            actor=actor,
            resource_type="hiring_assignment",
            resource_id=assignment.id,
            assignment=assignment,
            metadata={"decision": payload.decision.value, "total_score": total_score},
        )
        self.db.commit()
        return self.get_admin_assignment_review(assignment.id)

    def create_assignment_invite(
        self,
        *,
        assignment_id: str,
        actor: User,
        public_base_url: str,
        expires_in_days: int = 14,
    ) -> HiringAssignmentInviteResponse:
        assignment = self._get_assignment_or_404(assignment_id)
        if assignment.access_revoked:
            raise ServiceError("Restore assignment access before creating an invite", status_code=409)
        temporary_password = self._generate_temporary_password()
        assignment.candidate.password_hash = get_password_hash(temporary_password)
        assignment.invite_token = secrets.token_urlsafe(32)
        assignment.invite_created_at = _now()
        assignment.invite_expires_at = assignment.invite_created_at + timedelta(days=expires_in_days)
        assignment.version += 1
        login_path = f"/login?email={quote(assignment.candidate.email)}&next={quote(f'/hiring/{assignment.id}')}"
        invite_url = f"{public_base_url.rstrip('/')}{login_path}"
        self._log_hiring_event(
            "CREATE_HIRING_INVITE",
            actor=actor,
            resource_type="hiring_assignment",
            resource_id=assignment.id,
            assignment=assignment,
            metadata={"invite_expires_at": assignment.invite_expires_at},
        )
        self.db.commit()
        return HiringAssignmentInviteResponse(
            assignment_id=assignment.id,
            candidate_email=assignment.candidate.email,
            candidate_name=assignment.candidate.full_name,
            temporary_password=temporary_password,
            invite_url=invite_url,
            invite_expires_at=assignment.invite_expires_at,
        )

    def assessment_ranking(self, assessment_id: str) -> HiringRankingResponse:
        assessment = self._get_assessment_or_404(assessment_id)
        assignments = sorted(
            assessment.assignments or [],
            key=lambda assignment: (
                assignment.total_score is None,
                -(float(assignment.total_score or 0)),
                assignment.submitted_at or datetime.min.replace(tzinfo=UTC),
            ),
        )
        items = [
            HiringRankingItem(
                rank=index,
                assignment_id=assignment.id,
                candidate_id=assignment.candidate_id,
                candidate_name=self._candidate_name_for_admin(assignment),
                candidate_email=self._candidate_email_for_admin(assignment),
                candidate_label=self._candidate_label(assignment),
                candidate_identity_hidden=bool(assessment.blind_review_enabled),
                status=assignment.status,
                decision=assignment.decision,
                submitted_at=assignment.submitted_at,
                evaluated_at=assignment.evaluated_at,
                total_score=_score_to_float(assignment.total_score),
                progress_percent=self._progress_percent(assignment),
                validated_count=len(
                    [
                        submission
                        for submission in (assignment.submissions or [])
                        if submission.validation_status == HiringSubmissionValidationStatusEnum.VALIDATED
                    ]
                ),
                rejected_count=len(
                    [
                        submission
                        for submission in (assignment.submissions or [])
                        if submission.validation_status == HiringSubmissionValidationStatusEnum.REJECTED
                    ]
                ),
                item_count=len(self._assignment_items(assignment)),
                time_spent_seconds=self._time_spent_seconds(assignment),
            )
            for index, assignment in enumerate(assignments, start=1)
        ]
        return HiringRankingResponse(items=items)

    def assignment_audit_events(self, assignment_id: str) -> HiringAuditEventListResponse:
        self._get_assignment_or_404(assignment_id)
        events = list(
            self.db.execute(
                select(SecurityAuditEvent)
                .where(SecurityAuditEvent.resource_type.in_(["hiring_assignment", "hiring_submission", "hiring_audio"]))
                .order_by(SecurityAuditEvent.created_at.desc())
                .limit(500)
            )
            .scalars()
            .all()
        )
        filtered = [
            event for event in events
            if event.resource_id == assignment_id or (event.event_metadata or {}).get("assignment_id") == assignment_id
        ]
        return HiringAuditEventListResponse(items=[self._audit_event_response(event) for event in filtered])

    def candidate_download_path(self, *, assignment_id: str, item_id: str, actor: User) -> tuple[Path, str]:
        assignment = self._get_candidate_assignment_or_404(assignment_id, actor)
        self._ensure_download_allowed(assignment)
        item = next((candidate for candidate in self._assignment_items(assignment) if candidate.id == item_id), None)
        if not item:
            raise ServiceError("Hiring assessment item not found", status_code=404)
        path = Path(item.stored_path)
        if not path.is_file():
            raise ServiceError("Hiring audio file not found", status_code=404)
        return path, item.original_filename

    def candidate_zip_bytes(self, *, assignment_id: str, actor: User) -> tuple[bytes, str]:
        assignment = self._get_candidate_assignment_or_404(assignment_id, actor)
        self._ensure_download_allowed(assignment)
        output = BytesIO()
        used_names: set[str] = set()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for item in self._assignment_items(assignment):
                path = Path(item.stored_path)
                if not path.is_file():
                    continue
                archive_name = self._unique_archive_name(item.original_filename, used_names)
                archive.write(path, archive_name)
        filename = f"{assignment.assessment.title.replace(' ', '_').lower()}_{assignment.id}.zip"
        return output.getvalue(), filename

    def _get_assessment_or_404(self, assessment_id: str) -> HiringAssessment:
        assessment = (
            self.db.execute(
                select(HiringAssessment)
                .options(
                    joinedload(HiringAssessment.items),
                    joinedload(HiringAssessment.assignments)
                    .joinedload(HiringAssignment.submissions)
                    .joinedload(HiringSubmission.item),
                    joinedload(HiringAssessment.assignments).joinedload(HiringAssignment.candidate),
                )
                .where(HiringAssessment.id == assessment_id)
            )
            .unique()
            .scalar_one_or_none()
        )
        if not assessment:
            raise ServiceError("Hiring assessment not found", status_code=404)
        return assessment

    def _get_assignment_or_404(self, assignment_id: str) -> HiringAssignment:
        assignment = (
            self.db.execute(
                select(HiringAssignment)
                .options(
                    joinedload(HiringAssignment.assessment).joinedload(HiringAssessment.items),
                    joinedload(HiringAssignment.candidate),
                    joinedload(HiringAssignment.submissions).joinedload(HiringSubmission.item),
                )
                .where(HiringAssignment.id == assignment_id)
            )
            .unique()
            .scalar_one_or_none()
        )
        if not assignment:
            raise ServiceError("Hiring assignment not found", status_code=404)
        return assignment

    def _get_candidate_assignment_or_404(self, assignment_id: str, actor: User) -> HiringAssignment:
        assignment = self._get_assignment_or_404(assignment_id)
        if actor.role != RoleEnum.CANDIDATE or assignment.candidate_id != actor.id:
            raise ServiceError("Hiring assignment is not assigned to you", status_code=403)
        if assignment.access_revoked:
            raise ServiceError("Hiring assignment access has been revoked", status_code=403)
        return assignment

    def _get_submission_or_404(self, submission_id: str) -> HiringSubmission:
        submission = (
            self.db.execute(
                select(HiringSubmission)
                .options(
                    joinedload(HiringSubmission.assignment)
                    .joinedload(HiringAssignment.assessment)
                    .joinedload(HiringAssessment.items),
                    joinedload(HiringSubmission.assignment).joinedload(HiringAssignment.candidate),
                    joinedload(HiringSubmission.item),
                )
                .where(HiringSubmission.id == submission_id)
            )
            .unique()
            .scalar_one_or_none()
        )
        if not submission:
            raise ServiceError("Hiring submission not found", status_code=404)
        return submission

    def _get_candidate_submission_or_404(self, submission_id: str, actor: User) -> HiringSubmission:
        submission = self._get_submission_or_404(submission_id)
        if actor.role != RoleEnum.CANDIDATE or submission.assignment.candidate_id != actor.id:
            raise ServiceError("Hiring submission is not assigned to you", status_code=403)
        if submission.assignment.access_revoked:
            raise ServiceError("Hiring assignment access has been revoked", status_code=403)
        return submission

    def _ensure_assignment_editable(self, assignment: HiringAssignment) -> None:
        if assignment.status in {HiringAssignmentStatusEnum.SUBMITTED, HiringAssignmentStatusEnum.EVALUATED}:
            raise ServiceError("Submitted hiring assignments cannot be edited", status_code=409)
        if assignment.assessment.status != HiringAssessmentStatusEnum.ACTIVE:
            raise ServiceError("Hiring assessment is not active", status_code=409)
        deadline_at = self._submission_deadline_at(assignment)
        if deadline_at and deadline_at <= _now():
            raise ServiceError("Hiring assessment deadline has passed", status_code=409)

    def _ensure_download_allowed(self, assignment: HiringAssignment) -> None:
        self._ensure_assignment_editable(assignment)

    def _mark_assignment_opened(self, assignment: HiringAssignment, *, actor: User) -> None:
        if assignment.started_at or assignment.status in {HiringAssignmentStatusEnum.SUBMITTED, HiringAssignmentStatusEnum.EVALUATED}:
            return
        if assignment.assessment.status != HiringAssessmentStatusEnum.ACTIVE:
            return
        assessment_deadline_at = self._assessment_deadline_at(assignment.assessment)
        if assessment_deadline_at and assessment_deadline_at <= _now():
            return
        now = _now()
        assignment.started_at = now
        assignment.status = HiringAssignmentStatusEnum.IN_PROGRESS
        assignment.version += 1
        self._log_hiring_event(
            "OPEN_HIRING_ASSIGNMENT",
            actor=actor,
            resource_type="hiring_assignment",
            resource_id=assignment.id,
            assignment=assignment,
            metadata={"started_at": now},
        )
        self.db.commit()

    def _time_limit_expires_at(self, assignment: HiringAssignment) -> datetime | None:
        if not assignment.started_at or not assignment.assessment.time_limit_minutes:
            return None
        return _as_utc(assignment.started_at) + timedelta(minutes=assignment.assessment.time_limit_minutes)

    def _assessment_deadline_at(self, assessment: HiringAssessment) -> datetime | None:
        if assessment.due_at:
            return _as_utc(assessment.due_at)
        if assessment.due_date:
            return datetime.combine(assessment.due_date + timedelta(days=1), time.min, tzinfo=UTC)
        return None

    def _submission_deadline_at(self, assignment: HiringAssignment) -> datetime | None:
        deadlines = [
            item
            for item in [self._assessment_deadline_at(assignment.assessment), self._time_limit_expires_at(assignment)]
            if item is not None
        ]
        return min(deadlines) if deadlines else None

    def _seconds_remaining(self, assignment: HiringAssignment) -> int | None:
        deadline_at = self._submission_deadline_at(assignment)
        if not deadline_at:
            return None
        return max(0, int((deadline_at - _now()).total_seconds()))

    def _candidate_label(self, assignment: HiringAssignment) -> str:
        return f"Candidate {assignment.id[:8].upper()}"

    def _candidate_name_for_admin(self, assignment: HiringAssignment) -> str:
        return self._candidate_label(assignment) if assignment.assessment.blind_review_enabled else assignment.candidate.full_name

    def _candidate_email_for_admin(self, assignment: HiringAssignment) -> str:
        return "Hidden for blind review" if assignment.assessment.blind_review_enabled else assignment.candidate.email

    def _last_saved_at(self, assignment: HiringAssignment) -> datetime | None:
        saved_times = [submission.last_saved_at for submission in (assignment.submissions or []) if submission.last_saved_at]
        return max(saved_times) if saved_times else None

    def _time_spent_seconds(self, assignment: HiringAssignment) -> int | None:
        if not assignment.started_at:
            return None
        end = assignment.submitted_at or assignment.evaluated_at or _now()
        return max(0, int((_as_utc(end) - _as_utc(assignment.started_at)).total_seconds()))

    def _progress_percent(self, assignment: HiringAssignment) -> float:
        item_count = len(self._assignment_items(assignment))
        if item_count == 0:
            return 0
        ready = len(
            [
                submission
                for submission in (assignment.submissions or [])
                if submission.final_transcript.strip()
                and submission.pii_reviewed
                and not self._metadata_has_missing_required(assignment.assessment, submission.metadata_values)
            ]
        )
        return round((ready / item_count) * 100, 1)

    def _metadata_has_missing_required(self, assessment: HiringAssessment, values: dict | None) -> bool:
        values = values or {}
        fields = [HiringMetadataField.model_validate(field) for field in (assessment.metadata_schema or [])]
        return any(field.required and str(values.get(field.key) or "").strip() == "" for field in fields)

    def _validate_rubric_scores(self, assessment: HiringAssessment, values: dict[str, float | None]) -> dict[str, float | None]:
        fields = [HiringRubricField.model_validate(field) for field in (assessment.rubric_schema or [])]
        fields_by_key = {field.key: field for field in fields}
        normalized: dict[str, float | None] = {}
        for key, value in values.items():
            if key not in fields_by_key:
                raise ServiceError(f"Unknown rubric field: {key}", status_code=422)
            if value is None or value == "":
                normalized[key] = None
                continue
            score = float(value)
            if score < 0 or score > fields_by_key[key].max_score:
                raise ServiceError(f"{fields_by_key[key].label} must be between 0 and {fields_by_key[key].max_score}", status_code=422)
            normalized[key] = score
        return normalized

    def _generate_temporary_password(self) -> str:
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
        return "".join(secrets.choice(alphabet) for _ in range(12))

    def _log_hiring_event(
        self,
        action: str,
        *,
        actor: User | None,
        resource_type: str,
        resource_id: str | None,
        assignment: HiringAssignment,
        metadata: dict[str, object] | None = None,
    ) -> None:
        SecurityAuditService(self.db).log_event(
            action=action,
            actor=actor,
            resource_type=resource_type,
            resource_id=resource_id,
            metadata={
                "assessment_id": assignment.assessment_id,
                "assignment_id": assignment.id,
                **(metadata or {}),
            },
            commit=False,
        )

    def _audit_event_response(self, event: SecurityAuditEvent) -> HiringAuditEventResponse:
        return HiringAuditEventResponse(
            id=event.id,
            actor_email=event.actor_email,
            actor_role=event.actor_role,
            action=event.action,
            resource_type=event.resource_type,
            resource_id=event.resource_id,
            metadata=event.event_metadata or {},
            created_at=event.created_at,
        )

    def _submission_readiness_errors(self, assignment: HiringAssignment) -> list[str]:
        errors: list[str] = []
        assignment_items = self._assignment_items(assignment)
        required_item_ids = {item.id for item in assignment_items}
        submissions_by_item = {submission.item_id: submission for submission in assignment.submissions}
        for item in assignment_items:
            submission = submissions_by_item.get(item.id)
            if not submission:
                errors.append(f"{item.original_filename}: no submission exists")
                continue
            if not submission.final_transcript.strip():
                errors.append(f"{item.original_filename}: transcript is required")
            if not submission.pii_reviewed:
                errors.append(f"{item.original_filename}: PII review is required")
            try:
                self._validate_metadata_values(assignment.assessment, submission.metadata_values, require_all=True)
            except ServiceError as exc:
                errors.append(f"{item.original_filename}: {exc.message}")
        extra_submission_ids = {submission.item_id for submission in assignment.submissions} - required_item_ids
        if extra_submission_ids:
            errors.append("Assignment contains submissions for removed audio items")
        return errors

    def _attach_imported_item_to_assignments(
        self,
        *,
        assessment: HiringAssessment,
        item: HiringAssessmentItem,
        assignment: HiringAssignment | None = None,
    ) -> None:
        if assignment:
            submission = HiringSubmission(assignment_id=assignment.id, item_id=item.id)
            assignment.submissions.append(submission)
            self.db.add(submission)
            return
        for candidate_assignment in assessment.assignments or []:
            if candidate_assignment.status in {HiringAssignmentStatusEnum.SUBMITTED, HiringAssignmentStatusEnum.EVALUATED}:
                continue
            existing_item_ids = {submission.item_id for submission in candidate_assignment.submissions or []}
            if item.id not in existing_item_ids:
                submission = HiringSubmission(assignment_id=candidate_assignment.id, item_id=item.id)
                candidate_assignment.submissions.append(submission)
                self.db.add(submission)

    def _scan_hiring_folder(self, folder: Path, *, recursive: bool) -> tuple[list[Path], int, list[str]]:
        files: list[Path] = []
        skipped = 0
        errors: list[str] = []
        try:
            iterator = folder.rglob("*") if recursive else folder.iterdir()
            for path in iterator:
                if path.name.startswith(".") or not path.is_file():
                    continue
                if path.suffix.lower() not in SUPPORTED_HIRING_AUDIO_EXTENSIONS:
                    skipped += 1
                    self._append_import_message(errors, f"Skipped non-WAV file: {path.name}")
                    continue
                files.append(path)
        except OSError as exc:
            raise ServiceError(
                "Unable to read hiring audio folder. Check backend filesystem permissions.",
                status_code=403,
            ) from exc
        return files, skipped, errors

    def _existing_folder_import_sources(
        self,
        assessment: HiringAssessment,
        *,
        assignment: HiringAssignment | None,
    ) -> set[str]:
        assignment_id = assignment.id if assignment else None
        return {
            item.original_source
            for item in (assessment.items or [])
            if item.assignment_id == assignment_id and item.original_source
        }

    def _append_import_message(self, errors: list[str], message: str) -> None:
        if len(errors) < HIRING_FOLDER_IMPORT_MAX_MESSAGES:
            errors.append(message)

    def _assignment_items(self, assignment: HiringAssignment) -> list[HiringAssessmentItem]:
        items_by_id: dict[str, HiringAssessmentItem] = {}
        for submission in assignment.submissions or []:
            if submission.item:
                items_by_id[submission.item_id] = submission.item
        return self._sorted_items(items_by_id.values())

    def _sorted_assignment_submissions(self, assignment: HiringAssignment) -> list[HiringSubmission]:
        return sorted(
            [submission for submission in assignment.submissions or [] if submission.item],
            key=lambda submission: (submission.item.sort_order, submission.item.created_at, submission.item.id),
        )

    def _next_item_sort_order(
        self,
        assessment: HiringAssessment,
        *,
        assignment: HiringAssignment | None = None,
    ) -> int:
        if assignment:
            return len(self._assignment_items(assignment))
        return len([item for item in assessment.items or [] if item.assignment_id is None])

    def _validate_metadata_values(
        self,
        assessment: HiringAssessment,
        values: dict,
        *,
        require_all: bool,
    ) -> None:
        fields = [HiringMetadataField.model_validate(field) for field in (assessment.metadata_schema or [])]
        fields_by_key = {field.key: field for field in fields}
        for key in values.keys():
            if key not in fields_by_key:
                raise ServiceError(f"Unknown metadata field: {key}", status_code=422)
        for field in fields:
            value = values.get(field.key)
            if require_all and field.required and (value is None or str(value).strip() == ""):
                raise ServiceError(f"{field.label} is required", status_code=422)
            if value is None or str(value).strip() == "":
                continue
            if field.type == "number":
                try:
                    float(value)
                except (TypeError, ValueError) as exc:
                    raise ServiceError(f"{field.label} must be a number", status_code=422) from exc
            if field.type == "date":
                try:
                    date.fromisoformat(str(value))
                except ValueError as exc:
                    raise ServiceError(f"{field.label} must be a date", status_code=422) from exc
            if field.type == "select" and str(value) not in field.options:
                raise ServiceError(f"{field.label} must be one of: {', '.join(field.options)}", status_code=422)

    def _normalize_pii_annotations(self, annotations: list[PIIAnnotation], *, transcript: str) -> list[dict]:
        normalized = []
        for annotation in annotations:
            if annotation.end > len(transcript):
                raise ServiceError("PII annotation range is outside the transcript", status_code=422)
            value = transcript[annotation.start:annotation.end]
            normalized.append(
                annotation.model_copy(update={"value": value}).model_dump()
            )
        return normalized

    def _resolve_allowed_import_path(self, raw_path: str) -> Path:
        roots = settings.hiring_audio_import_root_list
        if not roots:
            raise ServiceError("No hiring audio import roots are configured", status_code=422)
        try:
            path = Path(raw_path).expanduser().resolve(strict=True)
        except FileNotFoundError as exc:
            raise ServiceError("Hiring audio import path not found", status_code=404) from exc
        allowed_roots = []
        for root in roots:
            try:
                allowed_roots.append(root.resolve(strict=True))
            except FileNotFoundError:
                continue
        if not any(path == root or root in path.parents for root in allowed_roots):
            raise ServiceError("Hiring audio import path is outside the configured allowlist", status_code=403)
        return path

    def _import_zip_file(self, assessment: HiringAssessment, upload: UploadFile) -> int:
        content = upload.file.read()
        imported = 0
        try:
            archive = zipfile.ZipFile(BytesIO(content))
        except zipfile.BadZipFile as exc:
            raise ServiceError("Uploaded ZIP file is not readable", status_code=422) from exc
        with archive:
            for member in archive.infolist():
                if member.is_dir():
                    continue
                path = Path(member.filename)
                if path.is_absolute() or ".." in path.parts:
                    raise ServiceError("ZIP file contains an unsafe path", status_code=422)
                if path.name.startswith("."):
                    continue
                if path.suffix.lower() not in SUPPORTED_HIRING_AUDIO_EXTENSIONS:
                    raise ServiceError("ZIP file can only contain WAV files", status_code=422)
                with archive.open(member) as source_file:
                    self._create_item_from_fileobj(
                        assessment=assessment,
                        source=f"{upload.filename}:{member.filename}",
                        filename=path.name,
                        fileobj=source_file,
                    )
                imported += 1
        return imported

    def _import_manifest_row(self, assessment: HiringAssessment, file_location: str, row: dict) -> None:
        source_filename = str(normalize_cell(row.get("filename", ""))).strip()
        if not source_filename:
            source_filename = Path(file_location).name or f"{uuid.uuid4()}.wav"
        if Path(source_filename).suffix.lower() not in SUPPORTED_HIRING_AUDIO_EXTENSIONS:
            raise ServiceError("Hiring manifest audio files must be WAV files", status_code=422)
        reference_transcript = str(normalize_cell(row.get("reference_transcript", ""))).strip() or None
        reference_metadata = {
            str(key).replace("reference_metadata_", "", 1): normalize_cell(value)
            for key, value in row.items()
            if str(key).startswith("reference_metadata_") and str(normalize_cell(value)).strip() != ""
        }
        reference_pii = []
        raw_reference_pii = str(normalize_cell(row.get("reference_pii_annotations", ""))).strip()
        if raw_reference_pii:
            try:
                parsed = json.loads(raw_reference_pii)
                reference_pii = parsed if isinstance(parsed, list) else []
            except json.JSONDecodeError as exc:
                raise ServiceError("reference_pii_annotations must be valid JSON", status_code=422) from exc
        reference_pii_entries = []
        raw_reference_pii_entries = str(normalize_cell(row.get("reference_pii_entries", ""))).strip()
        if raw_reference_pii_entries:
            try:
                parsed_entries = json.loads(raw_reference_pii_entries)
                if not isinstance(parsed_entries, list):
                    raise ServiceError("reference_pii_entries must be a JSON list", status_code=422)
                reference_pii_entries = [
                    HiringPIIEntry.model_validate(entry).model_dump()
                    for entry in parsed_entries
                ]
            except json.JSONDecodeError as exc:
                raise ServiceError("reference_pii_entries must be valid JSON", status_code=422) from exc
            except ValueError as exc:
                raise ServiceError("reference_pii_entries contains invalid PII rows", status_code=422) from exc
        location = self.audio_resolver.resolve(file_location)
        with self.audio_resolver.open_audio(location) as source_file:
            self._create_item_from_fileobj(
                assessment=assessment,
                source=file_location,
                filename=source_filename,
                fileobj=source_file,
                reference_transcript=reference_transcript,
                reference_pii_annotations=reference_pii,
                reference_pii_entries=reference_pii_entries,
                reference_metadata=reference_metadata,
                external_id=str(normalize_cell(row.get("id", ""))).strip() or None,
            )

    def _create_item_from_fileobj(
        self,
        *,
        assessment: HiringAssessment,
        source: str,
        filename: str,
        fileobj: BinaryIO,
        reference_transcript: str | None = None,
        reference_pii_annotations: list[dict] | None = None,
        reference_pii_entries: list[dict] | None = None,
        reference_metadata: dict | None = None,
        external_id: str | None = None,
        assignment: HiringAssignment | None = None,
        sort_order: int | None = None,
    ) -> HiringAssessmentItem:
        safe_filename = Path(filename).name
        if Path(safe_filename).suffix.lower() not in SUPPORTED_HIRING_AUDIO_EXTENSIONS:
            raise ServiceError("Only WAV files can be imported into hiring assessments", status_code=422)
        item_id = str(uuid.uuid4())
        destination_dir = settings.upload_path / "hiring" / "audio" / assessment.id
        destination_dir.mkdir(parents=True, exist_ok=True)
        destination = destination_dir / f"{item_id}{Path(safe_filename).suffix.lower()}"
        with destination.open("wb") as output:
            shutil.copyfileobj(fileobj, output)
        item = HiringAssessmentItem(
            id=item_id,
            assessment_id=assessment.id,
            assignment_id=assignment.id if assignment else None,
            external_id=external_id or item_id,
            original_filename=safe_filename,
            original_source=source,
            stored_path=str(destination),
            reference_transcript=reference_transcript,
            reference_pii_annotations=reference_pii_annotations or [],
            reference_pii_entries=reference_pii_entries or [],
            reference_metadata=reference_metadata or {},
            sort_order=sort_order
            if sort_order is not None
            else self._next_item_sort_order(assessment, assignment=assignment),
        )
        self.db.add(item)
        self.db.flush()
        return item

    def _assessment_summary(self, assessment: HiringAssessment) -> HiringAssessmentSummaryResponse:
        return HiringAssessmentSummaryResponse(
            id=assessment.id,
            title=assessment.title,
            instructions=assessment.instructions,
            status=assessment.status,
            due_date=assessment.due_date,
            due_at=assessment.due_at,
            time_limit_minutes=assessment.time_limit_minutes,
            blind_review_enabled=assessment.blind_review_enabled,
            metadata_schema=[
                HiringMetadataField.model_validate(field) for field in (assessment.metadata_schema or [])
            ],
            pii_label_keys=assessment.pii_label_keys or [],
            rubric_schema=[
                HiringRubricField.model_validate(field) for field in (assessment.rubric_schema or [])
            ],
            item_count=len(assessment.items or []),
            assignment_count=len(assessment.assignments or []),
            created_at=assessment.created_at,
            updated_at=assessment.updated_at,
        )

    def _item_response(self, item: HiringAssessmentItem, *, include_reference: bool) -> HiringAssessmentItemResponse:
        return HiringAssessmentItemResponse(
            id=item.id,
            external_id=item.external_id,
            assignment_id=item.assignment_id,
            original_filename=item.original_filename,
            original_source=item.original_source,
            sort_order=item.sort_order,
            created_at=item.created_at,
            reference_transcript=item.reference_transcript if include_reference else None,
            reference_pii_annotations=[
                PIIAnnotation.model_validate(annotation) for annotation in (item.reference_pii_annotations or [])
            ] if include_reference else [],
            reference_pii_entries=[
                HiringPIIEntry.model_validate(entry) for entry in (item.reference_pii_entries or [])
            ] if include_reference else [],
            reference_metadata=item.reference_metadata if include_reference else {},
        )

    def _assignment_summary(self, assignment: HiringAssignment) -> HiringAssignmentSummaryResponse:
        submissions = assignment.submissions or []
        item_count = len(self._assignment_items(assignment))
        return HiringAssignmentSummaryResponse(
            id=assignment.id,
            assessment_id=assignment.assessment_id,
            assessment_title=assignment.assessment.title,
            candidate_id=assignment.candidate_id,
            candidate_name=self._candidate_name_for_admin(assignment),
            candidate_email=self._candidate_email_for_admin(assignment),
            candidate_label=self._candidate_label(assignment),
            candidate_identity_hidden=bool(assignment.assessment.blind_review_enabled),
            status=assignment.status,
            decision=assignment.decision,
            access_revoked=assignment.access_revoked,
            due_date=assignment.assessment.due_date,
            due_at=assignment.assessment.due_at,
            item_count=item_count,
            submitted_count=len([item for item in submissions if item.submitted_at is not None]),
            validated_count=len(
                [item for item in submissions if item.validation_status == HiringSubmissionValidationStatusEnum.VALIDATED]
            ),
            rejected_count=len(
                [item for item in submissions if item.validation_status == HiringSubmissionValidationStatusEnum.REJECTED]
            ),
            assigned_at=assignment.assigned_at,
            started_at=assignment.started_at,
            submitted_at=assignment.submitted_at,
            evaluated_at=assignment.evaluated_at,
            time_limit_expires_at=self._time_limit_expires_at(assignment),
            submission_deadline_at=self._submission_deadline_at(assignment),
            seconds_remaining=self._seconds_remaining(assignment),
            last_saved_at=self._last_saved_at(assignment),
            invite_url=f"/login?email={quote(assignment.candidate.email)}&next={quote(f'/hiring/{assignment.id}')}" if assignment.invite_token else None,
            invite_expires_at=assignment.invite_expires_at,
            total_score=_score_to_float(assignment.total_score),
        )

    def _candidate_assignment_detail(
        self,
        assignment: HiringAssignment,
        *,
        include_reference: bool,
    ) -> HiringCandidateAssignmentDetailResponse:
        assignment_items = self._assignment_items(assignment)
        assessment_summary = self._assessment_summary(assignment.assessment)
        assessment_summary.item_count = len(assignment_items)
        return HiringCandidateAssignmentDetailResponse(
            id=assignment.id,
            assessment=assessment_summary,
            status=assignment.status,
            decision=assignment.decision,
            access_revoked=assignment.access_revoked,
            started_at=assignment.started_at,
            submitted_at=assignment.submitted_at,
            time_limit_expires_at=self._time_limit_expires_at(assignment),
            submission_deadline_at=self._submission_deadline_at(assignment),
            seconds_remaining=self._seconds_remaining(assignment),
            items=[self._item_response(item, include_reference=include_reference) for item in assignment_items],
            submissions=[
                self._submission_response(submission, include_reference_metrics=include_reference)
                for submission in self._sorted_assignment_submissions(assignment)
            ],
        )

    def _submission_response(
        self,
        submission: HiringSubmission,
        *,
        include_reference_metrics: bool,
    ) -> HiringSubmissionResponse:
        return HiringSubmissionResponse(
            id=submission.id,
            item_id=submission.item_id,
            version=submission.version,
            final_transcript=submission.final_transcript,
            pii_annotations=[
                PIIAnnotation.model_validate(annotation) for annotation in (submission.pii_annotations or [])
            ],
            pii_text=submission.pii_text,
            pii_entries=[
                HiringPIIEntry.model_validate(entry) for entry in (submission.pii_entries or [])
            ],
            metadata_values=submission.metadata_values or {},
            notes=submission.notes,
            pii_reviewed=submission.pii_reviewed,
            validation_status=submission.validation_status,
            validation_feedback=submission.validation_feedback,
            last_saved_at=submission.last_saved_at,
            submitted_at=submission.submitted_at,
            reference_metrics=self._reference_metrics(submission) if include_reference_metrics else None,
        )

    def _reference_metrics(self, submission: HiringSubmission) -> HiringReferenceMetrics:
        reference = submission.item.reference_transcript or ""
        reference_words = self._words(reference) if reference.strip() else []
        candidate_words = self._words(submission.final_transcript)
        if reference_words:
            distance, missing_words, extra_words, substitutions = self._word_diff(reference_words, candidate_words)
        else:
            distance, missing_words, extra_words, substitutions = 0, [], [], []
        word_error_rate = round(distance / max(len(reference_words), 1), 4) if reference_words else None
        accuracy_percent = (
            round(max(0.0, 1.0 - min(word_error_rate or 0.0, 1.0)) * 100, 1)
            if word_error_rate is not None
            else None
        )
        score_max = self._suggested_transcript_score_max(submission.assignment.assessment)
        suggested_score = (
            round(score_max * (accuracy_percent / 100), 2)
            if accuracy_percent is not None
            else None
        )
        pii_metrics = self._pii_reference_comparison(submission)
        return HiringReferenceMetrics(
            word_error_rate=word_error_rate,
            edit_distance=distance if reference_words else None,
            reference_word_count=len(reference_words),
            transcript_accuracy_percent=accuracy_percent,
            suggested_transcript_score=suggested_score,
            suggested_transcript_score_max=score_max if suggested_score is not None else None,
            transcript_missing_words=missing_words,
            transcript_extra_words=extra_words,
            transcript_substitutions=[
                HiringTranscriptSubstitution(expected=expected, actual=actual)
                for expected, actual in substitutions
            ],
            **pii_metrics,
        )

    def _sorted_items(self, items: Iterable[HiringAssessmentItem]) -> list[HiringAssessmentItem]:
        return sorted(items, key=lambda item: (item.sort_order, item.created_at, item.id))

    def _unique_archive_name(self, filename: str, used_names: set[str]) -> str:
        path = Path(filename)
        candidate = path.name
        index = 2
        while candidate in used_names:
            candidate = f"{path.stem}_{index}{path.suffix}"
            index += 1
        used_names.add(candidate)
        return candidate

    def _words(self, text: str) -> list[str]:
        return [word.strip(".,!?;:\"'()[]{}").lower() for word in text.split() if word.strip()]

    def _suggested_transcript_score_max(self, assessment: HiringAssessment) -> float:
        fields = [HiringRubricField.model_validate(field) for field in (assessment.rubric_schema or [])]
        for field in fields:
            haystack = f"{field.key} {field.label}".lower()
            if "transcript" in haystack or "accuracy" in haystack:
                return float(field.max_score)
        return 100.0

    def _pii_reference_comparison(self, submission: HiringSubmission) -> dict:
        expected_entries = self._reference_pii_entries(submission.item)
        candidate_entries = [
            HiringPIIEntry.model_validate(entry) for entry in (submission.pii_entries or [])
        ]
        expected_used: set[int] = set()
        candidate_used: set[int] = set()
        matched_count = 0
        mismatches: list[HiringPIIComparisonMismatch] = []

        for expected_index, expected in enumerate(expected_entries):
            expected_value = self._normalize_pii_value(expected.value)
            expected_type = self._normalize_pii_type(expected.type)
            for candidate_index, candidate in enumerate(candidate_entries):
                if candidate_index in candidate_used:
                    continue
                if (
                    expected_value == self._normalize_pii_value(candidate.value)
                    and expected_type == self._normalize_pii_type(candidate.type)
                ):
                    expected_used.add(expected_index)
                    candidate_used.add(candidate_index)
                    matched_count += 1
                    break

        for expected_index, expected in enumerate(expected_entries):
            if expected_index in expected_used:
                continue
            expected_value = self._normalize_pii_value(expected.value)
            for candidate_index, candidate in enumerate(candidate_entries):
                if candidate_index in candidate_used:
                    continue
                if expected_value == self._normalize_pii_value(candidate.value):
                    expected_used.add(expected_index)
                    candidate_used.add(candidate_index)
                    mismatches.append(HiringPIIComparisonMismatch(expected=expected, actual=candidate))
                    break

        return {
            "pii_expected_count": len(expected_entries),
            "pii_candidate_count": len(candidate_entries),
            "pii_matched_count": matched_count,
            "pii_missing": [
                entry for index, entry in enumerate(expected_entries) if index not in expected_used
            ],
            "pii_extra": [
                entry for index, entry in enumerate(candidate_entries) if index not in candidate_used
            ],
            "pii_type_mismatches": mismatches,
        }

    def _reference_pii_entries(self, item: HiringAssessmentItem) -> list[HiringPIIEntry]:
        if item.reference_pii_entries:
            return [HiringPIIEntry.model_validate(entry) for entry in item.reference_pii_entries]
        entries: list[HiringPIIEntry] = []
        for annotation in item.reference_pii_annotations or []:
            label = str(annotation.get("label") or "").strip()
            value = str(annotation.get("value") or "").strip()
            if label and value:
                entries.append(HiringPIIEntry(type=label, value=value))
        return entries

    def _normalize_pii_value(self, value: str) -> str:
        return re.sub(r"[^a-z0-9]+", "", value.lower())

    def _normalize_pii_type(self, value: str) -> str:
        return re.sub(r"[^a-z0-9]+", "", value.lower())

    def _word_diff(
        self,
        reference: list[str],
        candidate: list[str],
    ) -> tuple[int, list[str], list[str], list[tuple[str, str]]]:
        if not reference:
            return 0, [], candidate, []
        previous_rows = [[0] * (len(candidate) + 1) for _ in range(len(reference) + 1)]
        for reference_index in range(len(reference) + 1):
            previous_rows[reference_index][0] = reference_index
        for candidate_index in range(len(candidate) + 1):
            previous_rows[0][candidate_index] = candidate_index
        for reference_index, reference_word in enumerate(reference, start=1):
            for candidate_index, candidate_word in enumerate(candidate, start=1):
                substitution_cost = 0 if reference_word == candidate_word else 1
                previous_rows[reference_index][candidate_index] = min(
                    previous_rows[reference_index - 1][candidate_index] + 1,
                    previous_rows[reference_index][candidate_index - 1] + 1,
                    previous_rows[reference_index - 1][candidate_index - 1] + substitution_cost,
                )

        missing: list[str] = []
        extra: list[str] = []
        substitutions: list[tuple[str, str]] = []
        reference_index = len(reference)
        candidate_index = len(candidate)
        while reference_index > 0 or candidate_index > 0:
            if (
                reference_index > 0
                and candidate_index > 0
                and reference[reference_index - 1] == candidate[candidate_index - 1]
                and previous_rows[reference_index][candidate_index]
                == previous_rows[reference_index - 1][candidate_index - 1]
            ):
                reference_index -= 1
                candidate_index -= 1
            elif (
                reference_index > 0
                and candidate_index > 0
                and previous_rows[reference_index][candidate_index]
                == previous_rows[reference_index - 1][candidate_index - 1] + 1
            ):
                substitutions.append((reference[reference_index - 1], candidate[candidate_index - 1]))
                reference_index -= 1
                candidate_index -= 1
            elif (
                reference_index > 0
                and previous_rows[reference_index][candidate_index]
                == previous_rows[reference_index - 1][candidate_index] + 1
            ):
                missing.append(reference[reference_index - 1])
                reference_index -= 1
            else:
                extra.append(candidate[candidate_index - 1])
                candidate_index -= 1
        missing.reverse()
        extra.reverse()
        substitutions.reverse()
        return previous_rows[-1][-1], missing, extra, substitutions

    def _levenshtein(self, reference: list[str], candidate: list[str]) -> int:
        previous = list(range(len(candidate) + 1))
        for ref_index, ref_word in enumerate(reference, start=1):
            current = [ref_index]
            for cand_index, cand_word in enumerate(candidate, start=1):
                substitution_cost = 0 if ref_word == cand_word else 1
                current.append(
                    min(
                        previous[cand_index] + 1,
                        current[cand_index - 1] + 1,
                        previous[cand_index - 1] + substitution_cost,
                    )
                )
            previous = current
        return previous[-1]
