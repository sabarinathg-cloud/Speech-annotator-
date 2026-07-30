from datetime import datetime, timezone

from sqlalchemy import select

from app.models.activity import UserActivityEntry
from app.models.enums import TaskStatusEnum, UploadJobStatusEnum
from app.models.organization import Organization
from app.models.security import SecurityAuditEvent
from app.models.task import AnnotationTask, TaskAuditLog, TaskTranscriptVariant
from app.models.upload import UploadFile, UploadJob
from scripts.prune_untagged_tasks import PruneOptions, run_prune


def _seed_upload_job(db_session, seed_users):
    organization = db_session.execute(select(Organization).where(Organization.slug == "default")).scalar_one()
    upload_file = UploadFile(
        organization_id=organization.id,
        original_filename="prune.csv",
        stored_path="/tmp/prune.csv",
        content_type="text/csv",
        uploaded_by_id=seed_users["admin"].id,
    )
    db_session.add(upload_file)
    db_session.flush()
    upload_job = UploadJob(
        organization_id=organization.id,
        upload_file_id=upload_file.id,
        created_by_id=seed_users["admin"].id,
        status=UploadJobStatusEnum.IMPORTED,
        preview_row_count=4,
    )
    db_session.add(upload_job)
    db_session.flush()
    return organization, upload_job


def _task(upload_job, organization, *, external_id, status, assignee_id=None, last_tagger_id=None, call_id=None):
    call_id = call_id or external_id
    return AnnotationTask(
        organization_id=organization.id,
        upload_job_id=upload_job.id,
        external_id=external_id,
        file_location=f"/calls/{call_id}/channel1/{external_id}.wav",
        final_transcript="",
        notes=None,
        status=status,
        speaker_gender=None,
        speaker_role=None,
        language="en",
        channel=None,
        duration_seconds=None,
        custom_metadata={},
        original_row={"call_id": call_id},
        pii_annotations=[],
        alignment_words=[],
        assignee_id=assignee_id,
        last_tagger_id=last_tagger_id,
    )


def test_prune_untagged_tasks_dry_run_and_apply(db_session, seed_users):
    organization, upload_job = _seed_upload_job(db_session, seed_users)
    annotator = seed_users["annotator"]
    reviewer = seed_users["reviewer"]

    delete_unassigned = _task(
        upload_job,
        organization,
        external_id="PRUNE-001",
        status=TaskStatusEnum.NOT_STARTED,
    )
    delete_assigned = _task(
        upload_job,
        organization,
        external_id="PRUNE-002",
        status=TaskStatusEnum.NOT_STARTED,
        assignee_id=reviewer.id,
    )
    keep_completed = _task(
        upload_job,
        organization,
        external_id="PRUNE-003",
        status=TaskStatusEnum.COMPLETED,
        assignee_id=annotator.id,
        last_tagger_id=annotator.id,
        call_id="PRUNE-PARTIAL",
    )
    keep_callmate = _task(
        upload_job,
        organization,
        external_id="PRUNE-003B",
        status=TaskStatusEnum.NOT_STARTED,
        assignee_id=reviewer.id,
        call_id="PRUNE-PARTIAL",
    )
    keep_started = _task(
        upload_job,
        organization,
        external_id="PRUNE-004",
        status=TaskStatusEnum.IN_PROGRESS,
        assignee_id=reviewer.id,
    )
    keep_last_tagged = _task(
        upload_job,
        organization,
        external_id="PRUNE-005",
        status=TaskStatusEnum.NOT_STARTED,
        assignee_id=reviewer.id,
        last_tagger_id=annotator.id,
    )
    db_session.add_all([delete_unassigned, delete_assigned, keep_completed, keep_callmate, keep_started, keep_last_tagged])
    db_session.flush()
    db_session.add(
        TaskTranscriptVariant(
            task_id=delete_assigned.id,
            source_key="asr",
            source_label="ASR",
            transcript_text="seed",
        )
    )
    db_session.add(
        TaskAuditLog(
            task_id=delete_assigned.id,
            actor_user_id=seed_users["admin"].id,
            action="BULK_AUTO_BALANCE_ASSIGNEE",
            changed_fields={"assignee_id": True},
            previous_values={},
            new_values={},
        )
    )
    db_session.add(
        UserActivityEntry(
            organization_id=organization.id,
            user_id=reviewer.id,
            task_id=delete_assigned.id,
            route="/tasks",
            active_seconds=60,
            idle_seconds=0,
            event_count=1,
            started_at=datetime.now(timezone.utc),
            ended_at=datetime.now(timezone.utc),
        )
    )
    db_session.add(
        SecurityAuditEvent(
            organization_id=organization.id,
            actor_user_id=seed_users["admin"].id,
            actor_email=seed_users["admin"].email,
            actor_role=seed_users["admin"].role.value,
            action="TEST_REFERENCE",
            risk_level="low",
            resource_type="task",
            resource_id=delete_assigned.id,
            task_id=delete_assigned.id,
            event_metadata={},
        )
    )
    db_session.commit()

    options = PruneOptions(org="default", actor_email=seed_users["admin"].email)
    dry_run = run_prune(db_session, options)

    assert dry_run.dry_run is True
    assert dry_run.candidate_count == 2
    assert dry_run.would_delete_count == 2
    assert dry_run.kept_tagged_or_started_count == 3
    assert dry_run.kept_callmate_count == 1
    assert dry_run.candidates_by_assignee == {"unassigned": 1, reviewer.email: 1}
    assert db_session.get(AnnotationTask, delete_assigned.id) is not None

    apply_result = run_prune(db_session, PruneOptions(**{**options.__dict__, "apply": True}))

    assert apply_result.dry_run is False
    assert apply_result.deleted_count == 2
    assert db_session.get(AnnotationTask, delete_unassigned.id) is None
    assert db_session.get(AnnotationTask, delete_assigned.id) is None
    assert db_session.get(AnnotationTask, keep_completed.id) is not None
    assert db_session.get(AnnotationTask, keep_callmate.id) is not None
    assert db_session.get(AnnotationTask, keep_started.id) is not None
    assert db_session.get(AnnotationTask, keep_last_tagged.id) is not None
    assert db_session.execute(
        select(TaskTranscriptVariant).where(TaskTranscriptVariant.task_id == delete_assigned.id)
    ).scalar_one_or_none() is None
    assert db_session.execute(
        select(UserActivityEntry.task_id).where(UserActivityEntry.route == "/tasks")
    ).scalar_one_or_none() is None
    assert db_session.execute(
        select(SecurityAuditEvent.action).where(SecurityAuditEvent.action == "PRUNE_UNTAGGED_TASKS")
    ).scalar_one() == "PRUNE_UNTAGGED_TASKS"
