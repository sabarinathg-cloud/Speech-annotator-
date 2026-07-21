from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
import wave

from app.core.config import Settings
from app.models.enums import TaskStatusEnum
from app.models.job import BackgroundJob
from app.models.task import AnnotationTask, TaskTranscriptVariant
from app.models.upload import UploadFile, UploadJob
from app.services.organization_service import OrganizationService
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


def _write_wav(path: Path, samples: list[int], *, framerate: int = 8000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(framerate)
        wav_file.writeframes(b"".join(sample.to_bytes(2, "little", signed=True) for sample in samples))


def _create_chunk_group(
    db_session,
    seed_users,
    tmp_path: Path,
    *,
    second_chunk_framerate: int = 8000,
) -> tuple[str, str]:
    organization = OrganizationService(db_session).ensure_default_organization()
    group_dir = tmp_path / "recording-one" / "channel1"
    chunk_one = group_dir / "chunk_0001.wav"
    chunk_two = group_dir / "chunk_0002.wav"
    _write_wav(chunk_one, [0, 1200, -1200])
    _write_wav(chunk_two, [500, -500], framerate=second_chunk_framerate)

    upload_file = UploadFile(
        organization_id=organization.id,
        original_filename="manifest.xlsx",
        stored_path=str(tmp_path / "manifest.xlsx"),
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by_id=seed_users["admin"].id,
    )
    db_session.add(upload_file)
    db_session.flush()
    upload_job = UploadJob(
        organization_id=organization.id,
        upload_file_id=upload_file.id,
        created_by_id=seed_users["admin"].id,
        mapping_json=_mapping(),
    )
    db_session.add(upload_job)
    db_session.flush()

    task_one = AnnotationTask(
        organization_id=organization.id,
        upload_job_id=upload_job.id,
        external_id="chunk-1",
        file_location=f"local://{chunk_one}",
        final_transcript="hello",
        status=TaskStatusEnum.IN_PROGRESS,
        assignee_id=seed_users["annotator"].id,
        original_row={},
    )
    task_two = AnnotationTask(
        organization_id=organization.id,
        upload_job_id=upload_job.id,
        external_id="chunk-2",
        file_location=f"local://{chunk_two}",
        final_transcript="world",
        status=TaskStatusEnum.IN_PROGRESS,
        assignee_id=seed_users["annotator"].id,
        original_row={},
    )
    db_session.add_all([task_one, task_two])
    db_session.commit()
    return task_one.id, task_two.id


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


def test_audio_group_combines_wav_chunks_for_full_recording_playback(
    client, auth_headers, db_session, seed_users, tmp_path
):
    task_id, _ = _create_chunk_group(db_session, seed_users, tmp_path)

    group_response = client.get(f"/api/v1/tasks/{task_id}/audio-group", headers=auth_headers["annotator"])

    assert group_response.status_code == 200
    group = group_response.json()
    assert group["chunk_count"] == 2
    assert group["current_position"] == 1
    assert group["assembled_transcript"] == "hello\nworld"
    assert group["full_audio_available"] is True
    assert [chunk["filename"] for chunk in group["chunks"]] == ["chunk_0001.wav", "chunk_0002.wav"]

    audio_response = client.get(group["full_audio_url"])

    assert audio_response.status_code == 200
    assert audio_response.headers["content-type"].startswith("audio/")
    with wave.open(BytesIO(audio_response.content), "rb") as combined:
        assert combined.getnchannels() == 1
        assert combined.getsampwidth() == 2
        assert combined.getframerate() == 8000
        assert combined.getnframes() == 5


def test_audio_group_seeds_full_transcript_from_final_then_mapped_asr(
    client, auth_headers, db_session, seed_users, tmp_path
):
    task_id, second_task_id = _create_chunk_group(db_session, seed_users, tmp_path)
    task_one = db_session.get(AnnotationTask, task_id)
    task_two = db_session.get(AnnotationTask, second_task_id)
    task_one.final_transcript = None
    task_two.final_transcript = "corrected second chunk"
    db_session.add_all(
        [
            TaskTranscriptVariant(
                task_id=task_one.id,
                source_key="qwen",
                source_label="Qwen",
                transcript_text="qwen first chunk",
            ),
            TaskTranscriptVariant(
                task_id=task_one.id,
                source_key="whisper",
                source_label="Whisper",
                transcript_text="whisper first chunk",
            ),
            TaskTranscriptVariant(
                task_id=task_two.id,
                source_key="whisper",
                source_label="Whisper",
                transcript_text="ignored second chunk",
            ),
        ]
    )
    db_session.commit()

    group_response = client.get(f"/api/v1/tasks/{task_id}/audio-group", headers=auth_headers["annotator"])

    assert group_response.status_code == 200
    group = group_response.json()
    assert group["full_transcript_source"] == "segment_asr_seed"
    assert group["full_transcript_text"] == "whisper first chunk\ncorrected second chunk"
    assert group["full_transcript_seed_missing_count"] == 0
    assert group["full_transcript_seed_source_counts"] == {"whisper": 1, "final_transcript": 1}
    assert group["chunks"][0]["seed_source_key"] == "whisper"
    assert group["chunks"][1]["seed_source_key"] == "final_transcript"


def test_audio_group_full_transcript_review_saves_reloads_and_conflicts(
    client, auth_headers, db_session, seed_users, tmp_path
):
    task_id, second_task_id = _create_chunk_group(db_session, seed_users, tmp_path)

    saved = client.patch(
        f"/api/v1/tasks/{task_id}/audio-group/full-transcript",
        headers=auth_headers["annotator"],
        json={"transcript": "edited full call", "review_version": None},
    )
    assert saved.status_code == 200
    payload = saved.json()
    assert payload["full_transcript_source"] == "saved_review"
    assert payload["full_transcript_text"] == "edited full call"
    assert payload["full_transcript_review_version"] == 1

    reloaded = client.get(f"/api/v1/tasks/{second_task_id}/audio-group", headers=auth_headers["annotator"])
    assert reloaded.status_code == 200
    assert reloaded.json()["full_transcript_text"] == "edited full call"

    stale = client.patch(
        f"/api/v1/tasks/{task_id}/audio-group/full-transcript",
        headers=auth_headers["annotator"],
        json={"transcript": "stale edit", "review_version": None},
    )
    assert stale.status_code == 409

    updated = client.patch(
        f"/api/v1/tasks/{task_id}/audio-group/full-transcript",
        headers=auth_headers["annotator"],
        json={"transcript": "edited again", "review_version": 1},
    )
    assert updated.status_code == 200
    assert updated.json()["full_transcript_review_version"] == 2
    assert updated.json()["full_transcript_text"] == "edited again"


def test_audio_group_full_transcript_reviews_are_scoped_by_assignee(
    client, auth_headers, db_session, seed_users, tmp_path
):
    task_id, second_task_id = _create_chunk_group(db_session, seed_users, tmp_path)
    source_task_one = db_session.get(AnnotationTask, task_id)
    source_task_two = db_session.get(AnnotationTask, second_task_id)
    reviewer_task_one = AnnotationTask(
        organization_id=source_task_one.organization_id,
        upload_job_id=source_task_one.upload_job_id,
        external_id="reviewer-chunk-1",
        file_location=source_task_one.file_location,
        final_transcript=None,
        status=TaskStatusEnum.IN_PROGRESS,
        assignee_id=seed_users["reviewer"].id,
        original_row={},
    )
    reviewer_task_two = AnnotationTask(
        organization_id=source_task_two.organization_id,
        upload_job_id=source_task_two.upload_job_id,
        external_id="reviewer-chunk-2",
        file_location=source_task_two.file_location,
        final_transcript=None,
        status=TaskStatusEnum.IN_PROGRESS,
        assignee_id=seed_users["reviewer"].id,
        original_row={},
    )
    db_session.add_all([reviewer_task_one, reviewer_task_two])
    db_session.commit()

    annotator_save = client.patch(
        f"/api/v1/tasks/{task_id}/audio-group/full-transcript",
        headers=auth_headers["annotator"],
        json={"transcript": "annotator full call", "review_version": None},
    )
    reviewer_save = client.patch(
        f"/api/v1/tasks/{reviewer_task_one.id}/audio-group/full-transcript",
        headers=auth_headers["reviewer"],
        json={"transcript": "reviewer full call", "review_version": None},
    )

    assert annotator_save.status_code == 200
    assert reviewer_save.status_code == 200
    assert annotator_save.json()["full_transcript_text"] == "annotator full call"
    assert reviewer_save.json()["full_transcript_text"] == "reviewer full call"

    annotator_reload = client.get(f"/api/v1/tasks/{second_task_id}/audio-group", headers=auth_headers["annotator"])
    reviewer_reload = client.get(
        f"/api/v1/tasks/{reviewer_task_two.id}/audio-group",
        headers=auth_headers["reviewer"],
    )
    assert annotator_reload.json()["full_transcript_text"] == "annotator full call"
    assert reviewer_reload.json()["full_transcript_text"] == "reviewer full call"


def test_audio_group_rejects_incompatible_wav_chunks_without_crashing(
    client, auth_headers, db_session, seed_users, tmp_path
):
    task_id, _ = _create_chunk_group(db_session, seed_users, tmp_path, second_chunk_framerate=16000)
    group_response = client.get(f"/api/v1/tasks/{task_id}/audio-group", headers=auth_headers["annotator"])
    assert group_response.status_code == 200

    audio_response = client.get(group_response.json()["full_audio_url"])

    assert audio_response.status_code == 422
    assert audio_response.json()["detail"]["message"] == (
        "Audio chunks use different WAV formats and cannot be combined safely"
    )


def test_cleanup_removes_abandoned_uploads_and_expired_job_outputs(db_session, tmp_path, seed_users):
    now = datetime.now(timezone.utc)
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
