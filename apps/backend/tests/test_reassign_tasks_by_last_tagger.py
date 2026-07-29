from sqlalchemy import select

from app.models.enums import TaskStatusEnum, UploadJobStatusEnum
from app.models.organization import Organization
from app.models.task import AnnotationTask, TaskAuditLog
from app.models.upload import UploadFile, UploadJob
from scripts.reassign_tasks_by_last_tagger import ReassignOptions, run_reassignment


def _seed_upload_job(db_session, seed_users):
    organization = db_session.execute(select(Organization).where(Organization.slug == "default")).scalar_one()
    upload_file = UploadFile(
        organization_id=organization.id,
        original_filename="reassign.csv",
        stored_path="/tmp/reassign.csv",
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
        preview_row_count=3,
    )
    db_session.add(upload_job)
    db_session.flush()
    return organization, upload_job


def test_reassign_tasks_by_last_tagger_dry_run_and_apply(db_session, seed_users):
    organization, upload_job = _seed_upload_job(db_session, seed_users)
    varunesh = seed_users["annotator"]
    shalu = seed_users["reviewer"]

    should_move = AnnotationTask(
        organization_id=organization.id,
        upload_job_id=upload_job.id,
        external_id="REASSIGN-001",
        file_location="/calls/one/channel1/chunk_0001.wav",
        final_transcript="done",
        notes=None,
        status=TaskStatusEnum.COMPLETED,
        speaker_gender=None,
        speaker_role=None,
        language="en",
        channel=None,
        duration_seconds=None,
        custom_metadata={},
        original_row={"call_id": "one"},
        pii_annotations=[],
        alignment_words=[],
        assignee_id=shalu.id,
        last_tagger_id=varunesh.id,
    )
    wrong_last_tagger = AnnotationTask(
        organization_id=organization.id,
        upload_job_id=upload_job.id,
        external_id="REASSIGN-002",
        file_location="/calls/two/channel1/chunk_0001.wav",
        final_transcript="done",
        notes=None,
        status=TaskStatusEnum.COMPLETED,
        speaker_gender=None,
        speaker_role=None,
        language="en",
        channel=None,
        duration_seconds=None,
        custom_metadata={},
        original_row={"call_id": "two"},
        pii_annotations=[],
        alignment_words=[],
        assignee_id=shalu.id,
        last_tagger_id=shalu.id,
    )
    not_done = AnnotationTask(
        organization_id=organization.id,
        upload_job_id=upload_job.id,
        external_id="REASSIGN-003",
        file_location="/calls/three/channel1/chunk_0001.wav",
        final_transcript="started",
        notes=None,
        status=TaskStatusEnum.IN_PROGRESS,
        speaker_gender=None,
        speaker_role=None,
        language="en",
        channel=None,
        duration_seconds=None,
        custom_metadata={},
        original_row={"call_id": "three"},
        pii_annotations=[],
        alignment_words=[],
        assignee_id=shalu.id,
        last_tagger_id=varunesh.id,
    )
    db_session.add_all([should_move, wrong_last_tagger, not_done])
    db_session.commit()

    options = ReassignOptions(
        org="default",
        last_tagger_email=varunesh.email,
        assignee_email=varunesh.email,
        current_assignee_email=shalu.email,
        actor_email=seed_users["admin"].email,
    )
    dry_run = run_reassignment(db_session, options)

    assert dry_run.dry_run is True
    assert dry_run.matched_count == 1
    assert dry_run.would_reassign == 1
    db_session.refresh(should_move)
    assert should_move.assignee_id == shalu.id

    apply_result = run_reassignment(db_session, ReassignOptions(**{**options.__dict__, "apply": True}))

    assert apply_result.dry_run is False
    assert apply_result.reassigned == 1
    db_session.refresh(should_move)
    db_session.refresh(wrong_last_tagger)
    db_session.refresh(not_done)
    assert should_move.assignee_id == varunesh.id
    assert wrong_last_tagger.assignee_id == shalu.id
    assert not_done.assignee_id == shalu.id
    audit_action = db_session.execute(
        select(TaskAuditLog.action).where(TaskAuditLog.task_id == should_move.id).order_by(TaskAuditLog.created_at.desc())
    ).scalar_one()
    assert audit_action == "REASSIGN_BY_LAST_TAGGER"
