from app.models.enums import TaskStatusEnum, UploadJobStatusEnum
from app.models.task import AnnotationTask
from app.models.upload import UploadFile, UploadJob


def _create_upload_job(db_session, admin_user):
    upload_file = UploadFile(
        original_filename="access-control.xlsx",
        stored_path="/tmp/access-control.xlsx",
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by_id=admin_user.id,
    )
    db_session.add(upload_file)
    db_session.flush()
    upload_job = UploadJob(
        upload_file_id=upload_file.id,
        created_by_id=admin_user.id,
        status=UploadJobStatusEnum.IMPORTED,
        preview_row_count=0,
    )
    db_session.add(upload_job)
    db_session.flush()
    return upload_job


def _create_task(db_session, upload_job, external_id, assignee=None, status=TaskStatusEnum.NOT_STARTED):
    task = AnnotationTask(
        upload_job_id=upload_job.id,
        external_id=external_id,
        file_location=f"local:///tmp/{external_id}.wav",
        final_transcript=f"Transcript for {external_id}",
        notes=None,
        status=status,
        speaker_gender=None,
        speaker_role=None,
        language="en-US",
        channel=None,
        duration_seconds=None,
        custom_metadata={},
        original_row={},
        pii_annotations=[],
        alignment_words=[],
        assignee_id=assignee.id if assignee else None,
    )
    db_session.add(task)
    db_session.flush()
    return task


def test_non_admin_task_list_is_limited_to_assigned_tasks(client, auth_headers, db_session, seed_users):
    upload_job = _create_upload_job(db_session, seed_users["admin"])
    annotator_task = _create_task(db_session, upload_job, "ASSIGNED-ANNOTATOR", seed_users["annotator"])
    reviewer_task = _create_task(db_session, upload_job, "ASSIGNED-REVIEWER", seed_users["reviewer"])
    _create_task(db_session, upload_job, "UNASSIGNED")
    db_session.commit()

    annotator_response = client.get("/api/v1/tasks", headers=auth_headers["annotator"])
    assert annotator_response.status_code == 200
    annotator_payload = annotator_response.json()
    assert annotator_payload["total"] == 1
    assert [item["id"] for item in annotator_payload["items"]] == [annotator_task.id]
    assert annotator_payload["status_counts"] == {"Not Started": 1}

    requested_other_assignee = client.get(
        f"/api/v1/tasks?assignee_id={seed_users['reviewer'].id}",
        headers=auth_headers["annotator"],
    )
    assert requested_other_assignee.status_code == 200
    assert [item["id"] for item in requested_other_assignee.json()["items"]] == [annotator_task.id]

    requested_unassigned = client.get("/api/v1/tasks?assignee_id=unassigned", headers=auth_headers["annotator"])
    assert requested_unassigned.status_code == 200
    assert [item["id"] for item in requested_unassigned.json()["items"]] == [annotator_task.id]

    reviewer_response = client.get("/api/v1/tasks", headers=auth_headers["reviewer"])
    assert reviewer_response.status_code == 200
    assert [item["id"] for item in reviewer_response.json()["items"]] == [reviewer_task.id]

    admin_response = client.get("/api/v1/tasks", headers=auth_headers["admin"])
    assert admin_response.status_code == 200
    assert admin_response.json()["total"] == 3


def test_non_admin_task_detail_requires_assignment(client, auth_headers, db_session, seed_users):
    upload_job = _create_upload_job(db_session, seed_users["admin"])
    annotator_task = _create_task(db_session, upload_job, "OWNED", seed_users["annotator"])
    reviewer_task = _create_task(db_session, upload_job, "REVIEWER-OWNED", seed_users["reviewer"])
    unassigned_task = _create_task(db_session, upload_job, "UNASSIGNED")
    db_session.commit()

    own_detail = client.get(f"/api/v1/tasks/{annotator_task.id}", headers=auth_headers["annotator"])
    assert own_detail.status_code == 200
    assert own_detail.json()["id"] == annotator_task.id

    other_detail = client.get(f"/api/v1/tasks/{reviewer_task.id}", headers=auth_headers["annotator"])
    assert other_detail.status_code == 403

    unassigned_detail = client.get(f"/api/v1/tasks/{unassigned_task.id}", headers=auth_headers["annotator"])
    assert unassigned_detail.status_code == 403

    admin_detail = client.get(f"/api/v1/tasks/{unassigned_task.id}", headers=auth_headers["admin"])
    assert admin_detail.status_code == 200


def test_next_task_for_non_admin_uses_assigned_queue(client, auth_headers, db_session, seed_users):
    upload_job = _create_upload_job(db_session, seed_users["admin"])
    annotator_task = _create_task(db_session, upload_job, "ANNOTATOR-NEXT", seed_users["annotator"])
    reviewer_task = _create_task(db_session, upload_job, "REVIEWER-NEXT", seed_users["reviewer"])
    _create_task(db_session, upload_job, "UNASSIGNED-NEXT")
    db_session.commit()

    annotator_next = client.get("/api/v1/tasks/next", headers=auth_headers["annotator"])
    assert annotator_next.status_code == 200
    assert annotator_next.json()["task_id"] == annotator_task.id

    reviewer_next = client.get("/api/v1/tasks/next", headers=auth_headers["reviewer"])
    assert reviewer_next.status_code == 200
    assert reviewer_next.json()["task_id"] == reviewer_task.id
