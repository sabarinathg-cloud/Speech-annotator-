import uuid
import re
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal

from fastapi import UploadFile
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.enums import TaskStatusEnum, UploadJobStatusEnum
from app.models.organization import Organization
from app.models.user import User
from app.repositories.task_repository import TaskRepository
from app.repositories.upload_repository import UploadRepository
from app.schemas.upload import (
    ColumnMappingRequest,
    PreviewResponse,
    RowValidationError,
    UploadFileResponse,
    UploadImportResult,
    UploadValidationResult,
    ValidationGateResult,
)
from app.services.errors import ServiceError
from app.storage.audio_resolver import AudioResolver
from app.utils.excel import dataframe_preview, load_excel_as_dataframe, normalize_cell

settings = get_settings()
ALLOWED_CORE_METADATA_FIELDS = {"speaker_gender", "speaker_role", "language", "channel", "duration_seconds"}
AUDIO_VALIDATION_SAMPLE_SIZE = 12
AUDIO_VALIDATION_FAIL_RATIO = 0.5
MIN_ROWS_WITH_ANY_TRANSCRIPT_RATIO = 0.8
SUPPORTED_AUDIO_EXTENSIONS = {".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav", ".webm"}
GateStatus = Literal["pass", "warning", "fail"]


@dataclass
class QuickValidationGate:
    gate_key: str
    status: GateStatus
    message: str
    checked_count: int | None = None
    failed_count: int | None = None


@dataclass
class ValidationArtifacts:
    valid_row_indexes: list[int]
    errors: list[dict[str, Any]]
    transcript_sources: list[str]
    custom_metadata_columns: list[str]
    gates: list[QuickValidationGate]
    import_allowed: bool


class UploadService:
    def __init__(self, db: Session):
        self.db = db
        self.upload_repo = UploadRepository(db)
        self.task_repo = TaskRepository(db)
        self.audio_resolver = AudioResolver()

    def upload_excel(self, file: UploadFile, current_user: User, organization: Organization) -> UploadFileResponse:
        if not file.filename:
            raise ServiceError("File name is required")
        suffix = Path(file.filename).suffix.lower()
        if suffix not in {".xlsx", ".xls"}:
            raise ServiceError("Only .xlsx/.xls files are supported", status_code=422)

        content = file.file.read()
        if not content:
            raise ServiceError("Uploaded file is empty", status_code=422)

        stored_name = f"{uuid.uuid4()}{suffix}"
        destination = settings.upload_path / stored_name
        destination.write_bytes(content)

        upload_file = self.upload_repo.create_upload_file(
            organization_id=organization.id,
            original_filename=file.filename,
            stored_path=str(destination),
            content_type=file.content_type,
            uploaded_by_id=current_user.id,
        )
        upload_job = self.upload_repo.create_upload_job(
            organization_id=organization.id,
            upload_file_id=upload_file.id,
            created_by_id=current_user.id,
        )
        self.db.commit()
        return UploadFileResponse(
            id=upload_file.id,
            upload_job_id=upload_job.id,
            organization_id=organization.id,
            filename=upload_file.original_filename,
            status=upload_job.status,
        )

    def preview_upload(self, upload_job_id: str, *, organization: Organization) -> PreviewResponse:
        job = self.upload_repo.get_upload_job(upload_job_id, organization_id=organization.id)
        if not job:
            raise ServiceError("Upload job not found", status_code=404)
        df = self._load_job_dataframe(job)
        columns, sample_rows, row_count = dataframe_preview(df, limit=25)
        self.upload_repo.update_upload_job(job, preview_row_count=row_count)
        self.db.commit()
        return PreviewResponse(
            upload_job_id=upload_job_id,
            organization_id=organization.id,
            columns=columns,
            sample_rows=sample_rows,
            row_count=row_count,
        )

    def validate_upload(
        self,
        upload_job_id: str,
        mapping: ColumnMappingRequest,
        *,
        organization: Organization,
    ) -> UploadValidationResult:
        job = self.upload_repo.get_upload_job(upload_job_id, organization_id=organization.id)
        if not job:
            raise ServiceError("Upload job not found", status_code=404)
        self._validate_mapping_features(mapping, organization)
        df = self._load_job_dataframe(job)
        validation = self._validate_dataframe(df, mapping)

        self.upload_repo.clear_job_errors(upload_job_id)
        self.upload_repo.add_job_errors(upload_job_id, validation.errors)
        status = (
            UploadJobStatusEnum.VALIDATED
            if not validation.errors and validation.import_allowed
            else UploadJobStatusEnum.VALIDATION_FAILED
        )
        self.upload_repo.update_upload_job(
            job,
            status=status,
            mapping_json=mapping.model_dump(),
            validated=True,
            preview_row_count=len(df.index),
        )
        self.db.commit()
        return UploadValidationResult(
            upload_job_id=upload_job_id,
            organization_id=organization.id,
            status=status,
            valid_rows=len(validation.valid_row_indexes),
            invalid_rows=len({error["row_number"] for error in validation.errors}),
            total_rows=len(df.index),
            transcript_sources=validation.transcript_sources,
            custom_metadata_columns=validation.custom_metadata_columns,
            import_allowed=validation.import_allowed,
            gates=[ValidationGateResult(**gate.__dict__) for gate in validation.gates],
            errors=[RowValidationError(**error) for error in validation.errors],
        )

    def import_upload(
        self,
        upload_job_id: str,
        mapping: ColumnMappingRequest | None = None,
        *,
        organization: Organization,
    ) -> UploadImportResult:
        job = self.upload_repo.get_upload_job(upload_job_id, organization_id=organization.id)
        if not job:
            raise ServiceError("Upload job not found", status_code=404)
        if not mapping:
            if not job.mapping_json:
                raise ServiceError("Mapping is required before import", status_code=422)
            mapping = ColumnMappingRequest.model_validate(job.mapping_json)
        self._validate_mapping_features(mapping, organization)

        df = self._load_job_dataframe(job)
        validation = self._validate_dataframe(df, mapping)

        if not validation.import_allowed:
            failed_gates = [gate for gate in validation.gates if gate.status == "fail"]
            gate_errors = [
                {
                    "row_number": 1,
                    "field_name": "validation_gate",
                    "error_message": gate.message,
                    "raw_value": gate.gate_key,
                }
                for gate in failed_gates
            ]
            all_errors = [*validation.errors, *gate_errors]
            self.upload_repo.clear_job_errors(upload_job_id)
            self.upload_repo.add_job_errors(upload_job_id, all_errors)
            self.upload_repo.update_upload_job(
                job,
                status=UploadJobStatusEnum.IMPORT_FAILED,
                mapping_json=mapping.model_dump(),
                validated=True,
                imported=False,
                preview_row_count=len(df.index),
            )
            self.db.commit()
            raise ServiceError(
                "Import blocked by validation gates",
                status_code=422,
                extra={
                    "failed_gates": [gate.__dict__ for gate in failed_gates],
                },
            )

        all_errors = list(validation.errors)
        imported = 0
        skipped = 0

        self.upload_repo.clear_job_errors(upload_job_id)

        for idx in validation.valid_row_indexes:
            row = df.iloc[idx].to_dict()
            row_number = idx + 2
            try:
                with self.db.begin_nested():
                    self._import_single_row(
                        upload_job_id,
                        row,
                        mapping,
                        actor_user_id=job.created_by_id,
                        organization_id=job.organization_id,
                        metadata_enabled=organization.metadata_enabled,
                    )
                imported += 1
            except IntegrityError:
                skipped += 1
                all_errors.append(
                    {
                        "row_number": row_number,
                        "field_name": "id",
                        "error_message": "Duplicate task id for this upload job",
                        "raw_value": str(normalize_cell(row.get(mapping.id_column))),
                    }
                )
            except ServiceError as exc:
                skipped += 1
                all_errors.append(
                    {
                        "row_number": row_number,
                        "field_name": None,
                        "error_message": exc.message,
                        "raw_value": None,
                    }
                )

        self.upload_repo.add_job_errors(upload_job_id, all_errors)
        status = UploadJobStatusEnum.IMPORTED if imported > 0 else UploadJobStatusEnum.IMPORT_FAILED
        self.upload_repo.update_upload_job(
            job,
            status=status,
            mapping_json=mapping.model_dump(),
            imported=True,
            validated=True,
            preview_row_count=len(df.index),
        )
        self.db.commit()
        return UploadImportResult(
            upload_job_id=upload_job_id,
            organization_id=organization.id,
            imported_tasks=imported,
            skipped_rows=len({error["row_number"] for error in all_errors}),
            status=status,
        )

    def list_upload_errors(self, upload_job_id: str, *, organization: Organization) -> list[RowValidationError]:
        job = self.upload_repo.get_upload_job(upload_job_id, organization_id=organization.id)
        if not job:
            raise ServiceError("Upload job not found", status_code=404)
        errors = self.upload_repo.list_job_errors(upload_job_id)
        return [RowValidationError.model_validate(error, from_attributes=True) for error in errors]

    def _load_job_dataframe(self, job) -> Any:
        file_path = Path(job.upload_file.stored_path)
        try:
            return load_excel_as_dataframe(file_path.read_bytes(), file_path.suffix.lower())
        except Exception as exc:
            raise ServiceError("Unable to read Excel file", status_code=422) from exc

    def _validate_dataframe(self, df, mapping: ColumnMappingRequest) -> ValidationArtifacts:
        columns = set(str(col) for col in df.columns.tolist())
        missing_columns = []

        required_columns = [mapping.id_column, mapping.file_location_column]
        required_columns.extend([item.column_name for item in mapping.transcript_columns])
        optional_columns = [
            mapping.final_transcript_column,
            mapping.notes_column,
            mapping.status_column,
            *mapping.core_metadata_columns.values(),
        ]
        for col in required_columns + [c for c in optional_columns if c]:
            if col and col not in columns:
                missing_columns.append(col)

        if missing_columns:
            raise ServiceError(
                "Mapped columns not found in file",
                status_code=422,
                extra={"missing_columns": sorted(set(missing_columns))},
            )

        invalid_core = set(mapping.core_metadata_columns.keys()) - ALLOWED_CORE_METADATA_FIELDS
        if invalid_core:
            raise ServiceError(
                "Unsupported core metadata fields in mapping",
                status_code=422,
                extra={"invalid_fields": sorted(invalid_core)},
            )

        transcript_sources = [item.source_key for item in mapping.transcript_columns]
        mapped_columns = set(required_columns)
        mapped_columns.update(c for c in optional_columns if c)

        if mapping.custom_metadata_columns is not None:
            custom_metadata_columns = list(mapping.custom_metadata_columns)
            missing_columns.extend(col for col in custom_metadata_columns if col not in columns)
        else:
            custom_metadata_columns = [col for col in columns if col not in mapped_columns]

        if missing_columns:
            raise ServiceError(
                "Mapped columns not found in file",
                status_code=422,
                extra={"missing_columns": sorted(set(missing_columns))},
            )

        errors: list[dict[str, Any]] = []
        valid_indexes: list[int] = []
        seen_ids: set[str] = set()
        duplicate_id_count = 0
        non_empty_transcript_by_source: dict[str, int] = {item.source_key: 0 for item in mapping.transcript_columns}
        rows_with_any_transcript = 0
        rows_with_final_transcript = 0
        language_values: list[str] = []
        duration_samples: list[tuple[str, Decimal]] = []
        audio_locations_for_sampling: list[str] = []

        for idx, row in df.iterrows():
            row_number = idx + 2
            row_obj = row.to_dict()
            row_errors = []

            external_id = str(normalize_cell(row_obj.get(mapping.id_column, ""))).strip()
            file_location = str(normalize_cell(row_obj.get(mapping.file_location_column, ""))).strip()
            if not external_id:
                row_errors.append(("id", "ID is required", ""))
            if not file_location:
                row_errors.append(("file_location", "file_location is required", ""))
            else:
                audio_locations_for_sampling.append(file_location)
            if external_id:
                if external_id in seen_ids:
                    duplicate_id_count += 1
                    row_errors.append(("id", "Duplicate ID in uploaded file", external_id))
                else:
                    seen_ids.add(external_id)

            if mapping.final_transcript_column:
                final_transcript_value = str(normalize_cell(row_obj.get(mapping.final_transcript_column, ""))).strip()
                if final_transcript_value:
                    rows_with_final_transcript += 1

            transcript_values = []
            for transcript_map in mapping.transcript_columns:
                value = str(normalize_cell(row_obj.get(transcript_map.column_name, ""))).strip()
                transcript_values.append(value)
                if value:
                    non_empty_transcript_by_source[transcript_map.source_key] += 1
            if any(transcript_values):
                rows_with_any_transcript += 1
            else:
                row_errors.append(("transcript", "At least one transcript value is required", ""))

            if mapping.status_column:
                raw_status = str(normalize_cell(row_obj.get(mapping.status_column, ""))).strip()
                if raw_status and raw_status not in {status.value for status in TaskStatusEnum}:
                    row_errors.append(("status", "Invalid annotation status", raw_status))

            duration_column = mapping.core_metadata_columns.get("duration_seconds")
            if duration_column:
                raw_duration = str(normalize_cell(row_obj.get(duration_column, ""))).strip()
                if raw_duration:
                    try:
                        parsed_duration = Decimal(raw_duration)
                        if file_location:
                            duration_samples.append((file_location, parsed_duration))
                    except InvalidOperation:
                        row_errors.append(("duration_seconds", "Duration must be numeric", raw_duration))

            language_column = mapping.core_metadata_columns.get("language")
            if language_column:
                raw_language = str(normalize_cell(row_obj.get(language_column, ""))).strip()
                if raw_language:
                    language_values.append(raw_language)

            if row_errors:
                for field_name, message, raw in row_errors:
                    errors.append(
                        {
                            "row_number": row_number,
                            "field_name": field_name,
                            "error_message": message,
                            "raw_value": raw,
                        }
                    )
            else:
                valid_indexes.append(idx)

        gates = self._evaluate_quick_validation_gates(
            row_count=len(df.index),
            mapping=mapping,
            non_empty_transcript_by_source=non_empty_transcript_by_source,
            rows_with_any_transcript=rows_with_any_transcript,
            duplicate_id_count=duplicate_id_count,
            rows_with_final_transcript=rows_with_final_transcript,
            language_values=language_values,
            audio_locations=audio_locations_for_sampling,
            duration_samples=duration_samples,
        )
        import_allowed = not any(gate.status == "fail" for gate in gates)

        return ValidationArtifacts(
            valid_row_indexes=valid_indexes,
            errors=errors,
            transcript_sources=transcript_sources,
            custom_metadata_columns=custom_metadata_columns,
            gates=gates,
            import_allowed=import_allowed,
        )

    def _validate_mapping_features(self, mapping: ColumnMappingRequest, organization: Organization) -> None:
        uses_metadata = bool(mapping.core_metadata_columns) or bool(mapping.custom_metadata_columns)
        if uses_metadata and not organization.metadata_enabled:
            raise ServiceError("Metadata import is disabled for this organization", status_code=403)

    def _evaluate_quick_validation_gates(
        self,
        *,
        row_count: int,
        mapping: ColumnMappingRequest,
        non_empty_transcript_by_source: dict[str, int],
        rows_with_any_transcript: int,
        duplicate_id_count: int,
        rows_with_final_transcript: int,
        language_values: list[str],
        audio_locations: list[str],
        duration_samples: list[tuple[str, Decimal]],
    ) -> list[QuickValidationGate]:
        gates: list[QuickValidationGate] = []

        empty_sources = [
            transcript_map.source_key
            for transcript_map in mapping.transcript_columns
            if non_empty_transcript_by_source.get(transcript_map.source_key, 0) == 0
        ]
        gates.append(
            QuickValidationGate(
                gate_key="transcript_columns_have_content",
                status=(
                    "fail"
                    if empty_sources
                    else "pass"
                ),
                message=(
                    f"Mapped transcript columns with no content: {', '.join(empty_sources)}."
                    if empty_sources
                    else "Each mapped transcript source has at least one non-empty transcript value."
                ),
                checked_count=len(mapping.transcript_columns),
                failed_count=len(empty_sources),
            )
        )

        gates.append(self._evaluate_duplicate_id_gate(row_count, duplicate_id_count))
        transcript_ratio = (rows_with_any_transcript / row_count) if row_count else 0.0
        transcript_ratio_percentage = round(transcript_ratio * 100, 1)
        ratio_status: GateStatus = (
            "fail"
            if transcript_ratio < 0.5
            else "warning"
            if transcript_ratio < MIN_ROWS_WITH_ANY_TRANSCRIPT_RATIO
            else "pass"
        )
        gates.append(
            QuickValidationGate(
                gate_key="rows_have_any_transcript",
                status=ratio_status,
                message=(
                    f"{rows_with_any_transcript}/{row_count} rows have at least one transcript ({transcript_ratio_percentage}%)."
                ),
                checked_count=row_count,
                failed_count=row_count - rows_with_any_transcript,
            )
        )

        gates.append(self._evaluate_final_transcript_gate(row_count, mapping, rows_with_final_transcript))
        gates.append(self._evaluate_language_format_gate(language_values))
        gates.append(self._evaluate_audio_extension_gate(audio_locations))
        gates.append(self._evaluate_audio_location_gate(audio_locations))
        gates.append(self._evaluate_duration_match_gate(duration_samples))
        return gates

    def _evaluate_duplicate_id_gate(self, row_count: int, duplicate_id_count: int) -> QuickValidationGate:
        return QuickValidationGate(
            gate_key="duplicate_ids",
            status="warning" if duplicate_id_count else "pass",
            message=(
                f"{duplicate_id_count} duplicate ID row(s) will be rejected before import."
                if duplicate_id_count
                else "No duplicate IDs were found in the uploaded file."
            ),
            checked_count=row_count,
            failed_count=duplicate_id_count,
        )

    def _evaluate_final_transcript_gate(
        self,
        row_count: int,
        mapping: ColumnMappingRequest,
        rows_with_final_transcript: int,
    ) -> QuickValidationGate:
        if not mapping.final_transcript_column:
            return QuickValidationGate(
                gate_key="final_transcript_coverage",
                status="warning",
                message="No final transcript column is mapped; tasks will start with blank corrected transcripts.",
                checked_count=row_count,
                failed_count=row_count,
            )
        coverage = rows_with_final_transcript / row_count if row_count else 0.0
        return QuickValidationGate(
            gate_key="final_transcript_coverage",
            status="warning" if coverage < 0.5 else "pass",
            message=f"{rows_with_final_transcript}/{row_count} rows include a seeded final transcript ({round(coverage * 100, 1)}%).",
            checked_count=row_count,
            failed_count=row_count - rows_with_final_transcript,
        )

    def _evaluate_language_format_gate(self, language_values: list[str]) -> QuickValidationGate:
        if not language_values:
            return QuickValidationGate(
                gate_key="language_format",
                status="warning",
                message="No language values were available to validate.",
                checked_count=0,
                failed_count=0,
            )
        invalid = [
            value
            for value in language_values
            if not re.match(r"^[a-z]{2}(-[A-Z]{2})?$", value)
        ]
        return QuickValidationGate(
            gate_key="language_format",
            status="warning" if invalid else "pass",
            message=(
                f"{len(invalid)} language value(s) do not match formats like en or en-US."
                if invalid
                else "Language values match expected tags like en or en-US."
            ),
            checked_count=len(language_values),
            failed_count=len(invalid),
        )

    def _evaluate_audio_extension_gate(self, audio_locations: list[str]) -> QuickValidationGate:
        sampled_locations = list(dict.fromkeys(audio_locations))[:AUDIO_VALIDATION_SAMPLE_SIZE]
        unsupported = [
            location
            for location in sampled_locations
            if self._audio_extension(location) and self._audio_extension(location) not in SUPPORTED_AUDIO_EXTENSIONS
        ]
        unknown = [
            location
            for location in sampled_locations
            if not self._audio_extension(location)
        ]
        checked_count = len(sampled_locations)
        failed_count = len(unsupported)
        failure_ratio = failed_count / checked_count if checked_count else 0.0
        status: GateStatus = "fail" if failure_ratio >= AUDIO_VALIDATION_FAIL_RATIO else "warning" if failed_count or unknown else "pass"
        return QuickValidationGate(
            gate_key="audio_extension_support",
            status=status,
            message=(
                f"{failed_count} sampled audio file(s) use unsupported extensions. {len(unknown)} have no detectable extension."
                if status != "pass"
                else "Sampled audio file extensions are supported."
            ),
            checked_count=checked_count,
            failed_count=failed_count,
        )

    def _evaluate_duration_match_gate(self, duration_samples: list[tuple[str, Decimal]]) -> QuickValidationGate:
        if not duration_samples:
            return QuickValidationGate(
                gate_key="duration_matches_audio",
                status="warning",
                message="No mapped duration values with readable local WAV audio were available to compare.",
                checked_count=0,
                failed_count=0,
            )

        checked_count = 0
        failed_count = 0
        skipped_count = 0
        for location, expected_duration in duration_samples[:AUDIO_VALIDATION_SAMPLE_SIZE]:
            actual_duration = self._probe_local_wav_duration(location)
            if actual_duration is None:
                skipped_count += 1
                continue
            checked_count += 1
            expected = float(expected_duration)
            tolerance = max(1.0, expected * 0.1)
            if abs(actual_duration - expected) > tolerance:
                failed_count += 1

        if checked_count == 0:
            return QuickValidationGate(
                gate_key="duration_matches_audio",
                status="warning",
                message=f"Skipped duration comparison for {skipped_count} sampled row(s); only readable local WAV files are checked.",
                checked_count=0,
                failed_count=0,
            )
        return QuickValidationGate(
            gate_key="duration_matches_audio",
            status="warning" if failed_count else "pass",
            message=(
                f"{failed_count}/{checked_count} checked duration value(s) differ from audio duration beyond tolerance."
                if failed_count
                else f"{checked_count} checked duration value(s) match local WAV audio duration."
            ),
            checked_count=checked_count,
            failed_count=failed_count,
        )

    def _audio_extension(self, file_location: str) -> str:
        resolved = self.audio_resolver.resolve(file_location)
        source = resolved.key if resolved.scheme == "s3" else resolved.local_path
        return Path(source or "").suffix.lower()

    def _probe_local_wav_duration(self, file_location: str) -> float | None:
        resolved = self.audio_resolver.resolve(file_location)
        if resolved.scheme != "local" or not resolved.local_path:
            return None
        path = Path(resolved.local_path).expanduser()
        if path.suffix.lower() != ".wav" or not path.is_file():
            return None
        try:
            with wave.open(str(path), "rb") as reader:
                return reader.getnframes() / float(reader.getframerate())
        except (wave.Error, ZeroDivisionError):
            return None

    def _evaluate_audio_location_gate(self, audio_locations: list[str]) -> QuickValidationGate:
        sampled_locations = list(dict.fromkeys(audio_locations))[:AUDIO_VALIDATION_SAMPLE_SIZE]
        if not sampled_locations:
            return QuickValidationGate(
                gate_key="audio_location_sample",
                status="fail",
                message="No audio locations available to validate.",
                checked_count=0,
                failed_count=0,
            )

        checked_count = 0
        failed_count = 0
        unverified_s3_count = 0

        for location in sampled_locations:
            resolved_location = self.audio_resolver.resolve(location)
            if resolved_location.scheme == "s3" and not self.audio_resolver.can_validate_s3():
                unverified_s3_count += 1
                continue

            checked_count += 1
            if not self.audio_resolver.location_exists(resolved_location):
                failed_count += 1

        if checked_count == 0 and unverified_s3_count > 0:
            return QuickValidationGate(
                gate_key="audio_location_sample",
                status="warning",
                message=(
                    f"Skipped audio existence check for {unverified_s3_count} sampled S3 locations "
                    "because S3 validation is not configured."
                ),
                checked_count=0,
                failed_count=0,
            )

        failure_ratio = (failed_count / checked_count) if checked_count else 1.0
        status: GateStatus
        if failure_ratio >= AUDIO_VALIDATION_FAIL_RATIO:
            status = "fail"
        elif failed_count > 0:
            status = "warning"
        else:
            status = "pass"

        unverified_suffix = (
            f" {unverified_s3_count} sampled S3 locations were not verified."
            if unverified_s3_count
            else ""
        )
        return QuickValidationGate(
            gate_key="audio_location_sample",
            status=status,
            message=(
                f"Sampled {len(sampled_locations)} audio locations; "
                f"{failed_count} of {checked_count} checked locations were unreachable."
                f"{unverified_suffix}"
            ),
            checked_count=checked_count,
            failed_count=failed_count,
        )

    def _import_single_row(
        self,
        upload_job_id: str,
        row: dict[str, Any],
        mapping: ColumnMappingRequest,
        actor_user_id: str,
        organization_id: str,
        metadata_enabled: bool,
    ) -> None:
        external_id = str(normalize_cell(row.get(mapping.id_column, ""))).strip()
        file_location = str(normalize_cell(row.get(mapping.file_location_column, ""))).strip()

        status = TaskStatusEnum.NOT_STARTED
        if mapping.status_column:
            raw_status = str(normalize_cell(row.get(mapping.status_column, ""))).strip()
            if raw_status:
                status = TaskStatusEnum(raw_status)

        duration_value = None
        duration_column = mapping.core_metadata_columns.get("duration_seconds")
        if duration_column:
            raw_duration = str(normalize_cell(row.get(duration_column, ""))).strip()
            if raw_duration:
                duration_value = Decimal(raw_duration)

        mapped_columns = {
            mapping.id_column,
            mapping.file_location_column,
            *[item.column_name for item in mapping.transcript_columns],
        }
        optional = [
            mapping.final_transcript_column,
            mapping.notes_column,
            mapping.status_column,
            *mapping.core_metadata_columns.values(),
        ]
        mapped_columns.update(c for c in optional if c)

        custom_columns = mapping.custom_metadata_columns
        if not metadata_enabled:
            custom_columns = []
        elif custom_columns is None:
            custom_columns = [str(k) for k in row.keys() if str(k) not in mapped_columns]

        custom_metadata = {
            column: normalize_cell(row.get(column))
            for column in custom_columns
            if str(normalize_cell(row.get(column))).strip() != ""
        }
        original_row = {str(k): normalize_cell(v) for k, v in row.items()}

        task = self.task_repo.create_task(
            organization_id=organization_id,
            upload_job_id=upload_job_id,
            external_id=external_id,
            file_location=file_location,
            final_transcript=(
                str(normalize_cell(row.get(mapping.final_transcript_column))).strip()
                if mapping.final_transcript_column
                else ""
            ),
            notes=(
                str(normalize_cell(row.get(mapping.notes_column))).strip() if mapping.notes_column else None
            ),
            status=status,
            speaker_gender=(
                str(normalize_cell(row.get(mapping.core_metadata_columns.get("speaker_gender")))).strip()
                if mapping.core_metadata_columns.get("speaker_gender")
                else None
            ),
            speaker_role=(
                str(normalize_cell(row.get(mapping.core_metadata_columns.get("speaker_role")))).strip()
                if mapping.core_metadata_columns.get("speaker_role")
                else None
            ),
            language=(
                str(normalize_cell(row.get(mapping.core_metadata_columns.get("language")))).strip()
                if mapping.core_metadata_columns.get("language")
                else None
            ),
            channel=(
                str(normalize_cell(row.get(mapping.core_metadata_columns.get("channel")))).strip()
                if mapping.core_metadata_columns.get("channel")
                else None
            ),
            duration_seconds=duration_value,
            custom_metadata=custom_metadata,
            original_row=original_row,
        )

        variants = []
        for transcript_map in mapping.transcript_columns:
            transcript_text = str(normalize_cell(row.get(transcript_map.column_name, ""))).strip()
            if transcript_text:
                variants.append(
                    {
                        "source_key": transcript_map.source_key,
                        "source_label": transcript_map.source_label or transcript_map.source_key,
                        "transcript_text": transcript_text,
                    }
                )
        if not variants:
            raise ServiceError("No transcript variants available for row")
        self.task_repo.add_transcript_variants(task_id=task.id, variants=variants)

        self.task_repo.add_status_history(
            task_id=task.id,
            old_status=None,
            new_status=task.status,
            changed_by_id=actor_user_id,
            comment="Task imported from Excel",
        )
