from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.core.config import Settings
from app.models.job import BackgroundJob
from app.models.upload import UploadFile, UploadJob
from scripts.cleanup import run_cleanup


def _mapping():
    return {
        "id_column": "id",
        "file_location_column": "file_location",
        "transcript_columns": [
            {"source_key": "whisper", "column_name": "model_1_transcript", "source_label": "Whisper"},
            {"source_key": "qwen", "column_name": "model_2_transcript", "source_label": "Qwen"},
        ],
        "notes_column": "notes",
        "core_metadata_columns": {
            "speaker_gender": "speaker_gender",
            "language": "language",
        },
    }


def test_production_rejects_default_secrets():
    try:
        Settings(environment="production")
    except ValueError as exc:
        assert "production secrets" in str(exc)
    else:
        raise AssertionError("production settings accepted default secrets")


def test_async_export_job_completes_and_downloads(client, auth_headers, sample_excel_bytes):
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
    client.post(f"/api/v1/uploads/{upload_job_id}/validate", headers=auth_headers["admin"], json=_mapping())
    client.post(f"/api/v1/uploads/{upload_job_id}/import", headers=auth_headers["admin"], json=_mapping())

    enqueue = client.post("/api/v1/exports/tasks/jobs", headers=auth_headers["admin"], json={"format": "csv"})
    assert enqueue.status_code == 200
    job_id = enqueue.json()["job_id"]

    status = client.get(f"/api/v1/jobs/{job_id}", headers=auth_headers["admin"])
    assert status.status_code == 200
    assert status.json()["status"] == "COMPLETED"

    download = client.get(f"/api/v1/jobs/{job_id}/download", headers=auth_headers["admin"])
    assert download.status_code == 200
    assert "final_transcript_corrected" in download.text


def test_job_download_rejects_incomplete_jobs(client, auth_headers, db_session, seed_users):
    job = BackgroundJob(
        job_type="export",
        status="QUEUED",
        payload={"format": "csv"},
        created_by_id=seed_users["admin"].id,
    )
    db_session.add(job)
    db_session.commit()

    download = client.get(f"/api/v1/jobs/{job.id}/download", headers=auth_headers["admin"])
    assert download.status_code == 409


def test_async_import_job_completes(client, auth_headers, sample_excel_bytes):
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

    enqueue = client.post(
        f"/api/v1/uploads/{upload_job_id}/import/jobs",
        headers=auth_headers["admin"],
        json=_mapping(),
    )
    assert enqueue.status_code == 200
    job_id = enqueue.json()["job_id"]
    status = client.get(f"/api/v1/jobs/{job_id}", headers=auth_headers["admin"])
    assert status.status_code == 200
    assert status.json()["status"] == "COMPLETED"
    assert status.json()["result"]["imported_tasks"] == 1


def test_audio_stream_supports_range_requests(client, auth_headers, sample_excel_bytes):
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
    client.post(f"/api/v1/uploads/{upload_job_id}/validate", headers=auth_headers["admin"], json=_mapping())
    client.post(f"/api/v1/uploads/{upload_job_id}/import", headers=auth_headers["admin"], json=_mapping())
    task_id = client.get("/api/v1/tasks", headers=auth_headers["admin"]).json()["items"][0]["id"]
    signed = client.get(f"/api/v1/tasks/{task_id}/audio-url", headers=auth_headers["admin"]).json()

    response = client.get(signed["url"], headers={"Range": "bytes=0-1"})
    assert response.status_code == 206
    assert response.headers["content-range"].startswith("bytes 0-1/")
    assert response.content == b"ID"
    assert response.headers["content-type"].startswith("audio/mpeg")


def test_audio_stream_rejects_invalid_ranges_and_tokens(client, auth_headers, sample_excel_bytes):
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
    client.post(f"/api/v1/uploads/{upload_job_id}/validate", headers=auth_headers["admin"], json=_mapping())
    client.post(f"/api/v1/uploads/{upload_job_id}/import", headers=auth_headers["admin"], json=_mapping())
    task_id = client.get("/api/v1/tasks", headers=auth_headers["admin"]).json()["items"][0]["id"]
    signed = client.get(f"/api/v1/tasks/{task_id}/audio-url", headers=auth_headers["admin"]).json()

    invalid_range = client.get(signed["url"], headers={"Range": "bytes=99-100"})
    assert invalid_range.status_code == 416

    invalid_token = client.get("/api/v1/media/audio/not-a-valid-token")
    assert invalid_token.status_code == 401


def test_audio_stream_rejects_mobile_devices(client, auth_headers, sample_excel_bytes):
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
    client.post(f"/api/v1/uploads/{upload_job_id}/validate", headers=auth_headers["admin"], json=_mapping())
    client.post(f"/api/v1/uploads/{upload_job_id}/import", headers=auth_headers["admin"], json=_mapping())
    task_id = client.get("/api/v1/tasks", headers=auth_headers["admin"]).json()["items"][0]["id"]
    signed = client.get(f"/api/v1/tasks/{task_id}/audio-url", headers=auth_headers["admin"]).json()

    response = client.get(
        signed["url"],
        headers={
            "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123.0 Mobile Safari/537.36"
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"]["message"] == "This application can only be used from a laptop or desktop browser."


def test_cleanup_removes_abandoned_uploads_and_expired_job_outputs(db_session, tmp_path, seed_users):
    now = datetime.now(UTC)
    upload_path = tmp_path / "abandoned.xlsx"
    upload_path.write_bytes(b"abandoned")
    output_path = tmp_path / "old-export.csv"
    output_path.write_bytes(b"old export")

    upload_file = UploadFile(
        original_filename="abandoned.xlsx",
        stored_path=str(upload_path),
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by_id=seed_users["admin"].id,
        created_at=now - timedelta(days=3),
        updated_at=now - timedelta(days=3),
    )
    db_session.add(upload_file)
    db_session.flush()
    db_session.add(
        UploadJob(
            upload_file_id=upload_file.id,
            created_by_id=seed_users["admin"].id,
            created_at=now - timedelta(days=3),
            updated_at=now - timedelta(days=3),
        )
    )
    job = BackgroundJob(
        job_type="export",
        status="COMPLETED",
        payload={"format": "csv"},
        result={"filename": "old-export.csv"},
        output_path=str(output_path),
        content_type="text/csv",
        created_by_id=seed_users["admin"].id,
        completed_at=now - timedelta(days=8),
        created_at=now - timedelta(days=8),
        updated_at=now - timedelta(days=8),
    )
    db_session.add(job)
    db_session.commit()

    result = run_cleanup(db_session)

    assert result["abandoned_upload_files_deleted"] == 1
    assert result["job_output_files_deleted"] == 1
    assert not upload_path.exists()
    assert not output_path.exists()
    assert job.output_path is None
