from app.models.enums import TaskStatusEnum, UploadJobStatusEnum
from app.models.task import AnnotationTask
from app.models.upload import UploadFile, UploadJob


def _create_upload_job(db_session, admin_user):
    upload_file = UploadFile(
        original_filename="security-controls.xlsx",
        stored_path="/tmp/security-controls.xlsx",
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


def _create_task(
    db_session,
    upload_job,
    external_id="SEC-001",
    *,
    assignee=None,
    file_location="local:///tmp/private/customer-call.wav",
    transcript="Customer phone is 1234567890",
):
    task = AnnotationTask(
        upload_job_id=upload_job.id,
        external_id=external_id,
        file_location=file_location,
        final_transcript=transcript,
        notes="Sensitive customer note",
        status=TaskStatusEnum.IN_PROGRESS,
        speaker_gender=None,
        speaker_role="customer",
        language="en-US",
        channel=None,
        duration_seconds=None,
        custom_metadata={"account_number": "ACCT-0099"},
        original_row={"raw_secret": "do-not-leak"},
        pii_annotations=[],
        alignment_words=[],
        assignee_id=assignee.id if assignee else None,
    )
    db_session.add(task)
    db_session.flush()
    return task


def test_confidentiality_acknowledgement_is_required_before_task_access(
    client,
    db_session,
    seed_users,
):
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "annotator@test.com", "password": "Annotator@123"},
    )
    assert login.status_code == 200
    assert login.json()["user"]["confidentiality_acknowledged_for_session"] is False
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    blocked = client.get("/api/v1/tasks", headers=headers)
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["message"] == "Confidentiality acknowledgement required"

    acknowledgement = client.post(
        "/api/v1/auth/confidentiality-acknowledgement",
        headers=headers,
    )
    assert acknowledgement.status_code == 200
    assert acknowledgement.json()["user"]["confidentiality_acknowledged_at"] is not None
    assert acknowledgement.json()["user"]["confidentiality_acknowledged_version"] == "2026-05-sensitive-data-v1"
    assert acknowledgement.json()["user"]["confidentiality_acknowledged_for_session"] is True

    allowed = client.get(
        "/api/v1/tasks",
        headers={"Authorization": f"Bearer {acknowledgement.json()['access_token']}"},
    )
    assert allowed.status_code == 200


def test_confidentiality_acknowledgement_is_required_again_after_each_login(client, db_session, seed_users):
    first_login = client.post(
        "/api/v1/auth/login",
        json={"email": "annotator@test.com", "password": "Annotator@123"},
    )
    assert first_login.status_code == 200
    first_ack = client.post(
        "/api/v1/auth/confidentiality-acknowledgement",
        headers={"Authorization": f"Bearer {first_login.json()['access_token']}"},
    )
    assert first_ack.status_code == 200
    first_access_token = first_ack.json()["access_token"]
    assert client.get("/api/v1/tasks", headers={"Authorization": f"Bearer {first_access_token}"}).status_code == 200

    second_login = client.post(
        "/api/v1/auth/login",
        json={"email": "annotator@test.com", "password": "Annotator@123"},
    )
    assert second_login.status_code == 200
    assert second_login.json()["user"]["confidentiality_acknowledged_at"] is not None
    assert second_login.json()["user"]["confidentiality_acknowledged_for_session"] is False

    blocked = client.get(
        "/api/v1/tasks",
        headers={"Authorization": f"Bearer {second_login.json()['access_token']}"},
    )
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["message"] == "Confidentiality acknowledgement required"

    second_ack = client.post(
        "/api/v1/auth/confidentiality-acknowledgement",
        headers={"Authorization": f"Bearer {second_login.json()['access_token']}"},
    )
    assert second_ack.status_code == 200
    assert second_ack.json()["user"]["confidentiality_acknowledged_for_session"] is True


def test_task_detail_minimizes_file_location_for_annotators(
    client,
    auth_headers,
    db_session,
    seed_users,
):
    upload_job = _create_upload_job(db_session, seed_users["admin"])
    task = _create_task(
        db_session,
        upload_job,
        assignee=seed_users["annotator"],
        file_location="local:///very/private/customer-audio/call-001.wav",
    )
    db_session.commit()

    annotator_detail = client.get(f"/api/v1/tasks/{task.id}", headers=auth_headers["annotator"])
    assert annotator_detail.status_code == 200
    assert annotator_detail.json()["file_location"] == "call-001.wav"
    assert "/very/private" not in annotator_detail.json()["file_location"]

    admin_detail = client.get(f"/api/v1/tasks/{task.id}", headers=auth_headers["admin"])
    assert admin_detail.status_code == 200
    assert admin_detail.json()["file_location"] == "local:///very/private/customer-audio/call-001.wav"


def test_task_activity_redacts_sensitive_values_from_audit_payloads(
    client,
    auth_headers,
    db_session,
    seed_users,
):
    upload_job = _create_upload_job(db_session, seed_users["admin"])
    task = _create_task(db_session, upload_job, assignee=seed_users["annotator"])
    db_session.commit()

    response = client.patch(
        f"/api/v1/tasks/{task.id}",
        headers=auth_headers["annotator"],
        json={
            "version": task.version,
            "final_transcript": "Customer phone changed to 9998887777",
            "notes": "Customer mentioned a secret account",
            "pii_annotations": [
                {
                    "id": "phone-1",
                    "label": "PHONE",
                    "start": 26,
                    "end": 36,
                    "value": "9998887777",
                    "source": "manual",
                    "confidence": None,
                }
            ],
        },
    )
    assert response.status_code == 200

    activity = client.get(f"/api/v1/tasks/{task.id}/activity", headers=auth_headers["annotator"])
    assert activity.status_code == 200
    update_event = next(item for item in activity.json()["items"] if item["action"] == "UPDATE_TASK")
    assert update_event["new_values"]["final_transcript"] == "[REDACTED_TEXT]"
    assert update_event["new_values"]["notes"] == "[REDACTED_TEXT]"
    assert update_event["new_values"]["pii_annotations"]["count"] == 1
    assert update_event["new_values"]["pii_annotations"]["labels"] == ["PHONE"]
    assert "9998887777" not in str(update_event)
    assert "secret account" not in str(update_event)


def test_audio_stream_uses_inline_no_store_headers(client, auth_headers, sample_excel_bytes):
    upload_response = client.post(
        "/api/v1/uploads",
        headers=auth_headers["admin"],
        files={
            "file": (
                "tasks.xlsx",
                sample_excel_bytes,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    upload_job_id = upload_response.json()["upload_job_id"]
    mapping = {
        "id_column": "id",
        "file_location_column": "file_location",
        "transcript_columns": [
            {"source_key": "whisper", "column_name": "model_1_transcript", "source_label": "Whisper"},
        ],
    }
    client.post(f"/api/v1/uploads/{upload_job_id}/validate", headers=auth_headers["admin"], json=mapping)
    client.post(f"/api/v1/uploads/{upload_job_id}/import", headers=auth_headers["admin"], json=mapping)
    task_id = client.get("/api/v1/tasks", headers=auth_headers["admin"]).json()["items"][0]["id"]
    signed = client.get(f"/api/v1/tasks/{task_id}/audio-url", headers=auth_headers["admin"]).json()

    full_response = client.get(signed["url"])
    assert full_response.status_code == 200
    assert full_response.headers["content-disposition"] == "inline"
    assert full_response.headers["cache-control"] == "no-store, max-age=0"
    assert full_response.headers["x-content-type-options"] == "nosniff"

    range_response = client.get(signed["url"], headers={"Range": "bytes=0-1"})
    assert range_response.status_code == 206
    assert range_response.headers["content-disposition"] == "inline"
    assert range_response.headers["cache-control"] == "no-store, max-age=0"
    assert range_response.headers["x-content-type-options"] == "nosniff"


def test_security_audit_events_are_admin_visible_and_record_sensitive_actions(
    client,
    auth_headers,
    db_session,
    seed_users,
    sample_excel_bytes,
):
    upload_response = client.post(
        "/api/v1/uploads",
        headers=auth_headers["admin"],
        files={
            "file": (
                "tasks.xlsx",
                sample_excel_bytes,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    upload_job_id = upload_response.json()["upload_job_id"]
    mapping = {
        "id_column": "id",
        "file_location_column": "file_location",
        "transcript_columns": [
            {"source_key": "whisper", "column_name": "model_1_transcript", "source_label": "Whisper"},
        ],
    }
    client.post(f"/api/v1/uploads/{upload_job_id}/validate", headers=auth_headers["admin"], json=mapping)
    client.post(f"/api/v1/uploads/{upload_job_id}/import", headers=auth_headers["admin"], json=mapping)
    task_id = client.get("/api/v1/tasks", headers=auth_headers["admin"]).json()["items"][0]["id"]

    client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["admin"])
    signed = client.get(f"/api/v1/tasks/{task_id}/audio-url", headers=auth_headers["admin"]).json()
    client.get(
        signed["url"],
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
        },
    )
    client.get("/api/v1/exports/tasks?format=csv", headers=auth_headers["admin"])

    denied = client.get("/api/v1/security/audit-events", headers=auth_headers["annotator"])
    assert denied.status_code == 403

    events = client.get("/api/v1/security/audit-events", headers=auth_headers["admin"])
    assert events.status_code == 200
    actions = [item["action"] for item in events.json()["items"]]
    assert "VIEW_TASK" in actions
    assert "GENERATE_AUDIO_URL" in actions
    assert "STREAM_AUDIO" in actions
    assert "EXPORT_TASKS" in actions
    assert all("Customer phone" not in str(item) for item in events.json()["items"])


def test_client_security_events_are_logged_for_admin_review(client, auth_headers):
    event = client.post(
        "/api/v1/security/client-events",
        headers=auth_headers["annotator"],
        json={
            "action": "ATTEMPT_PRINT",
            "metadata": {
                "route": "/tasks/task-1",
                "shortcut": "Ctrl+P",
                "final_transcript": "Customer secret should not appear",
            },
        },
    )

    assert event.status_code == 200
    assert event.json()["action"] == "ATTEMPT_PRINT"
    assert event.json()["risk_level"] == "high"
    assert event.json()["metadata"]["route"] == "/tasks/task-1"
    assert event.json()["metadata"]["final_transcript"] == "[REDACTED]"

    events = client.get("/api/v1/security/audit-events?action=ATTEMPT_PRINT", headers=auth_headers["admin"])
    assert events.status_code == 200
    assert events.json()["total"] == 1
    assert events.json()["items"][0]["actor_email"] == "annotator@test.com"
