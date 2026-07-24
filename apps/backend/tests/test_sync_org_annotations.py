from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.enums import TaskStatusEnum, UploadJobStatusEnum
from app.models.organization import Organization, OrganizationMembership
from app.models.task import AnnotationTask, TaskAuditLog, TaskStatusHistory
from app.models.upload import UploadFile, UploadJob
from scripts.sync_org_annotations import SyncOptions, sync_annotations


def _create_org(db_session: Session, *, name: str, slug: str) -> Organization:
    org = Organization(
        name=name,
        slug=slug,
        is_active=True,
        metadata_enabled=True,
        pii_enabled=True,
        transcript_redaction_enabled=False,
        audio_masking_enabled=False,
        hiring_enabled=False,
    )
    db_session.add(org)
    db_session.flush()
    return org


def _create_job(db_session: Session, *, org: Organization, admin_id: str, filename: str) -> UploadJob:
    upload = UploadFile(
        organization_id=org.id,
        original_filename=filename,
        stored_path=f"/tmp/{filename}",
        content_type="text/csv",
        uploaded_by_id=admin_id,
    )
    db_session.add(upload)
    db_session.flush()
    job = UploadJob(
        organization_id=org.id,
        upload_file_id=upload.id,
        created_by_id=admin_id,
        status=UploadJobStatusEnum.IMPORTED,
        mapping_json={"file_location_column": "file_location"},
        preview_row_count=2,
        imported_at=datetime.now(timezone.utc),
    )
    db_session.add(job)
    db_session.flush()
    return job


def _create_task(
    db_session: Session,
    *,
    org: Organization,
    job: UploadJob,
    external_id: str,
    file_location: str,
    status: TaskStatusEnum,
    final_transcript: str | None,
    last_tagger_id: str | None = None,
    version: int = 1,
) -> AnnotationTask:
    task = AnnotationTask(
        organization_id=org.id,
        upload_job_id=job.id,
        external_id=external_id,
        file_location=file_location,
        final_transcript=final_transcript,
        notes="source note" if last_tagger_id else None,
        status=status,
        speaker_gender="female" if last_tagger_id else None,
        speaker_role="customer" if last_tagger_id else None,
        language="en-US" if last_tagger_id else None,
        channel="channel1" if last_tagger_id else None,
        custom_metadata={"audio_quality": "clean"} if last_tagger_id else {},
        original_row={"id": external_id, "file_location": file_location},
        pii_annotations=[
            {"id": "pii-1", "label": "NAME", "start": 0, "end": 5, "value": "Alice", "source": "manual"}
        ]
        if last_tagger_id
        else [],
        last_tagger_id=last_tagger_id,
        version=version,
        last_saved_at=datetime.now(timezone.utc),
    )
    db_session.add(task)
    db_session.flush()
    return task


def _add_audit_log(
    db_session: Session,
    *,
    task: AnnotationTask,
    actor_id: str,
    action: str,
    changed_fields: dict,
) -> None:
    db_session.add(
        TaskAuditLog(
            task_id=task.id,
            actor_user_id=actor_id,
            action=action,
            changed_fields=changed_fields,
            previous_values={},
            new_values={},
        )
    )


def test_sync_org_annotations_dry_run_and_apply(db_session: Session, seed_users):
    source_org = _create_org(db_session, name="Org One", slug="org-one")
    dest_org = _create_org(db_session, name="Org Two", slug="org-two")
    db_session.add(
        OrganizationMembership(
            organization_id=dest_org.id,
            user_id=seed_users["annotator"].id,
            is_active=True,
        )
    )
    source_job = _create_job(db_session, org=source_org, admin_id=seed_users["admin"].id, filename="source.csv")
    dest_job = _create_job(db_session, org=dest_org, admin_id=seed_users["admin"].id, filename="dest.csv")
    file_one = "local:///audio/call-a/channel1/chunk_0001.wav"
    file_two = "local:///audio/call-b/channel1/chunk_0001.wav"

    source_task = _create_task(
        db_session,
        org=source_org,
        job=source_job,
        external_id="SRC-1",
        file_location=file_one,
        status=TaskStatusEnum.COMPLETED,
        final_transcript="Alice called about billing.",
        last_tagger_id=seed_users["annotator"].id,
        version=4,
    )
    _create_task(
        db_session,
        org=source_org,
        job=source_job,
        external_id="SRC-2",
        file_location=file_two,
        status=TaskStatusEnum.COMPLETED,
        final_transcript="This should not overwrite destination work.",
        last_tagger_id=seed_users["annotator"].id,
        version=4,
    )
    dest_task = _create_task(
        db_session,
        org=dest_org,
        job=dest_job,
        external_id="DST-1",
        file_location=file_one,
        status=TaskStatusEnum.NOT_STARTED,
        final_transcript="import seed",
        version=3,
    )
    protected_dest_task = _create_task(
        db_session,
        org=dest_org,
        job=dest_job,
        external_id="DST-2",
        file_location=file_two,
        status=TaskStatusEnum.IN_PROGRESS,
        final_transcript="already edited",
        last_tagger_id=seed_users["annotator"].id,
        version=2,
    )
    _add_audit_log(
        db_session,
        task=dest_task,
        actor_id=seed_users["admin"].id,
        action="BULK_AUTO_BALANCE_ASSIGNEE",
        changed_fields={"assignee_id": True},
    )
    _add_audit_log(
        db_session,
        task=protected_dest_task,
        actor_id=seed_users["annotator"].id,
        action="UPDATE_TRANSCRIPT",
        changed_fields={"final_transcript": True},
    )
    db_session.commit()

    dry_result = sync_annotations(
        db_session,
        SyncOptions(
            source_org=source_org.slug,
            dest_org=dest_org.slug,
            actor_email=seed_users["admin"].email,
            transcript_only=True,
        ),
    )

    assert dry_result.dry_run is True
    assert dry_result.would_copy == 1
    assert dry_result.skipped_destination_worked == 1
    db_session.refresh(dest_task)
    assert dest_task.final_transcript == "import seed"

    apply_result = sync_annotations(
        db_session,
        SyncOptions(
            source_org=source_org.slug,
            dest_org=dest_org.slug,
            actor_email=seed_users["admin"].email,
            apply=True,
            transcript_only=True,
        ),
    )

    assert apply_result.copied == 1
    db_session.refresh(dest_task)
    db_session.refresh(protected_dest_task)
    assert dest_task.final_transcript == source_task.final_transcript
    assert dest_task.status == TaskStatusEnum.COMPLETED
    assert dest_task.notes is None
    assert dest_task.speaker_gender is None
    assert dest_task.custom_metadata == {}
    assert dest_task.pii_annotations == []
    assert dest_task.last_tagger_id == seed_users["annotator"].id
    assert protected_dest_task.final_transcript == "already edited"

    audit = db_session.execute(
        select(TaskAuditLog)
        .where(TaskAuditLog.task_id == dest_task.id)
        .where(TaskAuditLog.action == "SYNC_FROM_ORGANIZATION")
    ).scalar_one()
    assert audit.action == "SYNC_FROM_ORGANIZATION"
    assert audit.new_values["source_task_id"] == source_task.id

    status_history = db_session.execute(
        select(TaskStatusHistory).where(TaskStatusHistory.task_id == dest_task.id)
    ).scalar_one()
    assert status_history.old_status == TaskStatusEnum.NOT_STARTED
    assert status_history.new_status == TaskStatusEnum.COMPLETED
