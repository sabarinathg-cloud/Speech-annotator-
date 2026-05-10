from datetime import UTC, datetime, timedelta

from app.models.enums import TaskStatusEnum, UploadJobStatusEnum
from app.models.security import SecurityAuditEvent
from app.models.task import AnnotationTask, TaskAuditLog, TaskStatusHistory, TaskTranscriptVariant
from app.models.upload import UploadFile, UploadJob


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


def _import_sample_tasks(client, auth_headers, sample_excel_bytes):
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
    tasks = client.get("/api/v1/tasks", headers=auth_headers["admin"]).json()["items"]
    return upload_job_id, tasks


def _create_metrics_upload_job(db_session, admin_user):
    upload_file = UploadFile(
        original_filename="metrics.xlsx",
        stored_path="/tmp/metrics.xlsx",
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by_id=admin_user.id,
    )
    db_session.add(upload_file)
    db_session.flush()
    upload_job = UploadJob(
        upload_file_id=upload_file.id,
        created_by_id=admin_user.id,
        status=UploadJobStatusEnum.IMPORTED,
    )
    db_session.add(upload_job)
    db_session.flush()
    return upload_job


def _create_metrics_task(
    db_session,
    *,
    upload_job,
    external_id,
    final_transcript,
    variants,
    pii_annotations=None,
    masked_audio_intervals=None,
    masked_audio_reference_intervals=None,
    masked_audio_alignment_intervals=None,
    masked_audio_mode=None,
    language="en",
    status=TaskStatusEnum.COMPLETED,
    last_tagger_id=None,
):
    task = AnnotationTask(
        upload_job_id=upload_job.id,
        external_id=external_id,
        file_location=f"local:///{external_id}.wav",
        final_transcript=final_transcript,
        notes=None,
        status=status,
        language=language,
        custom_metadata={},
        original_row={},
        pii_annotations=pii_annotations or [],
        last_tagger_id=last_tagger_id,
    )
    db_session.add(task)
    db_session.flush()
    if masked_audio_intervals is not None:
        task.masked_audio_location = f"/tmp/{external_id}-masked.wav"
        task.masked_audio_pii_hash = f"{external_id}-hash"
        task.masked_audio_intervals = masked_audio_intervals
        task.masked_audio_reference_intervals = masked_audio_reference_intervals or []
        task.masked_audio_alignment_intervals = masked_audio_alignment_intervals or masked_audio_reference_intervals or []
        task.masked_audio_mode = masked_audio_mode or "silence"
    for source_key, source_label, transcript_text in variants:
        db_session.add(
            TaskTranscriptVariant(
                task_id=task.id,
                source_key=source_key,
                source_label=source_label,
                transcript_text=transcript_text,
            )
        )
    db_session.flush()
    return task


def test_admin_can_manage_pii_labels_and_taggers_get_active_labels(client, auth_headers):
    defaults = client.get("/api/v1/pii-labels", headers=auth_headers["annotator"])
    assert defaults.status_code == 200
    assert "EMAIL" in {item["key"] for item in defaults.json()["items"]}

    denied = client.post(
        "/api/v1/pii-labels",
        headers=auth_headers["annotator"],
        json={"key": "PASSPORT", "display_name": "Passport", "color": "#0f766e"},
    )
    assert denied.status_code == 403

    created = client.post(
        "/api/v1/pii-labels",
        headers=auth_headers["admin"],
        json={"key": "PASSPORT", "display_name": "Passport", "color": "#0f766e"},
    )
    assert created.status_code == 200
    label = created.json()
    assert label["key"] == "PASSPORT"
    assert label["is_active"] is True

    deactivated = client.patch(
        f"/api/v1/pii-labels/{label['id']}",
        headers=auth_headers["admin"],
        json={"is_active": False},
    )
    assert deactivated.status_code == 200
    assert deactivated.json()["is_active"] is False

    active = client.get("/api/v1/pii-labels", headers=auth_headers["reviewer"]).json()["items"]
    assert "PASSPORT" not in {item["key"] for item in active}

    admin_list = client.get("/api/v1/pii-labels/admin", headers=auth_headers["admin"]).json()["items"]
    passport = next(item for item in admin_list if item["key"] == "PASSPORT")
    assert passport["is_active"] is False


def test_admin_metrics_compare_model_transcripts_against_corrected_ground_truth(
    client,
    auth_headers,
    sample_excel_bytes,
    seed_users,
):
    _, tasks = _import_sample_tasks(client, auth_headers, sample_excel_bytes)
    task_id = next(task["id"] for task in tasks if task["external_id"] == "ROW-001")
    assign = client.patch(
        f"/api/v1/tasks/{task_id}/assignee",
        headers=auth_headers["admin"],
        json={"version": next(task["version"] for task in tasks if task["id"] == task_id), "assignee_id": seed_users["annotator"].id},
    )
    assert assign.status_code == 200
    detail = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"]).json()

    save = client.patch(
        f"/api/v1/tasks/{task_id}",
        headers=auth_headers["annotator"],
        json={
            "version": detail["version"],
            "final_transcript": "hello from model one",
            "pii_annotations": [
                {
                    "id": "pii-1",
                    "label": "NAME",
                    "start": 0,
                    "end": 5,
                    "value": "hello",
                    "source": "manual",
                    "confidence": None,
                }
            ],
        },
    )
    assert save.status_code == 200

    response = client.get("/api/v1/metrics/admin?language=en", headers=auth_headers["admin"])
    assert response.status_code == 200
    payload = response.json()
    assert payload["overview"]["total_tasks"] == 1
    assert payload["overview"]["scored_tasks"] == 1
    assert payload["pii_metrics"]["total_annotations"] == 1
    assert payload["pii_metrics"]["by_label"]["NAME"] == 1

    model_metrics = {item["source_key"]: item for item in payload["model_metrics"]}
    assert model_metrics["whisper"]["tasks_scored"] == 1
    assert model_metrics["whisper"]["average_wer"] == 0
    assert model_metrics["whisper"]["average_cer"] == 0
    assert model_metrics["qwen"]["tasks_scored"] == 1
    assert model_metrics["qwen"]["word_errors"] == 1
    assert model_metrics["qwen"]["reference_words"] == 4
    assert model_metrics["qwen"]["average_wer"] == 0.25

    tagger = next(item for item in payload["tagger_metrics"] if item["user_email"] == "annotator@test.com")
    assert tagger["tasks_touched"] == 1
    assert tagger["pii_annotations"] == 1


def test_metrics_endpoint_is_admin_only(client, auth_headers):
    response = client.get("/api/v1/metrics/admin", headers=auth_headers["annotator"])
    assert response.status_code == 403


def test_admin_metrics_use_macro_average_error_rates_and_real_pii_counts(
    client,
    auth_headers,
    db_session,
    seed_users,
):
    upload_job = _create_metrics_upload_job(db_session, seed_users["admin"])
    task_one = _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="MET-001",
        final_transcript="ab cd",
        variants=[
            ("model_a", "Model A", "ab cd"),
            ("model_b", "Model B", "ab"),
        ],
        pii_annotations=[
            {
                "id": "pii-1",
                "label": "NAME",
                "start": 0,
                "end": 2,
                "value": "ab",
                "source": "manual",
                "confidence": 0.95,
            },
            {
                "id": "pii-2",
                "label": "EMAIL",
                "start": 1,
                "end": 4,
                "value": "b c",
                "source": "auto",
                "confidence": 0.5,
            },
            {
                "id": "pii-3",
                "label": "PHONE",
                "start": 4,
                "end": 5,
                "value": "d",
                "source": "manual",
                "confidence": None,
            },
        ],
        status=TaskStatusEnum.COMPLETED,
        last_tagger_id=seed_users["annotator"].id,
    )
    task_two = _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="MET-002",
        final_transcript="ef",
        variants=[
            ("model_a", "Model A", "ef gh"),
            ("model_b", "Model B", "zz"),
        ],
        pii_annotations=[
            {
                "id": "pii-4",
                "label": "NAME",
                "start": 0,
                "end": 1,
                "value": "e",
                "source": None,
                "confidence": None,
            }
        ],
        status=TaskStatusEnum.REVIEWED,
        last_tagger_id=seed_users["annotator"].id,
    )
    _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="MET-003",
        final_transcript="",
        variants=[("model_a", "Model A", "ignored because reference is empty")],
        pii_annotations=[],
        status=TaskStatusEnum.APPROVED,
        last_tagger_id=seed_users["reviewer"].id,
    )
    db_session.commit()

    response = client.get("/api/v1/metrics/admin?language=en", headers=auth_headers["admin"])
    assert response.status_code == 200
    payload = response.json()

    assert payload["overview"]["total_tasks"] == 3
    assert payload["overview"]["scored_tasks"] == 2
    assert payload["overview"]["scored_pairs"] == 4
    assert payload["overview"]["average_wer"] == 0.625
    assert payload["overview"]["average_cer"] == 0.775

    model_metrics = {item["source_key"]: item for item in payload["model_metrics"]}
    assert model_metrics["model_a"]["tasks_scored"] == 2
    assert model_metrics["model_a"]["word_errors"] == 1
    assert model_metrics["model_a"]["reference_words"] == 3
    assert model_metrics["model_a"]["average_wer"] == 0.5
    assert model_metrics["model_a"]["character_errors"] == 3
    assert model_metrics["model_a"]["reference_characters"] == 7
    assert model_metrics["model_a"]["average_cer"] == 0.75
    assert model_metrics["model_b"]["word_errors"] == 2
    assert model_metrics["model_b"]["reference_words"] == 3
    assert model_metrics["model_b"]["average_wer"] == 0.75
    assert model_metrics["model_b"]["character_errors"] == 5
    assert model_metrics["model_b"]["reference_characters"] == 7
    assert model_metrics["model_b"]["average_cer"] == 0.8

    pii_metrics = payload["pii_metrics"]
    assert pii_metrics["total_annotations"] == 4
    assert pii_metrics["average_annotations_per_task"] == 1.33
    assert pii_metrics["low_confidence_annotations"] == 1
    assert pii_metrics["overlap_warnings"] == 1
    assert pii_metrics["by_label"] == {"EMAIL": 1, "NAME": 2, "PHONE": 1}
    assert pii_metrics["by_source"] == {"auto": 1, "manual": 3}

    tagger_metrics = {item["user_email"]: item for item in payload["tagger_metrics"]}
    assert tagger_metrics["annotator@test.com"]["tasks_touched"] == 2
    assert tagger_metrics["annotator@test.com"]["completed_tasks"] == 1
    assert tagger_metrics["annotator@test.com"]["reviewed_tasks"] == 1
    assert tagger_metrics["annotator@test.com"]["pii_annotations"] == 4
    assert tagger_metrics["reviewer@test.com"]["approved_tasks"] == 1

    worst_tasks = payload["worst_tasks"]
    assert worst_tasks[0]["task_id"] == task_two.id
    assert worst_tasks[0]["max_wer"] == 1
    assert worst_tasks[0]["average_wer"] == 1
    assert worst_tasks[1]["task_id"] == task_one.id
    assert worst_tasks[1]["max_wer"] == 0.5
    assert worst_tasks[1]["average_wer"] == 0.25


def test_admin_metrics_include_user_productivity_and_session_metrics(
    client,
    auth_headers,
    db_session,
    seed_users,
):
    now = datetime.now(UTC)
    annotator = seed_users["annotator"]
    annotator.last_login_at = now - timedelta(hours=3)
    annotator.active_session_started_at = now - timedelta(minutes=95)
    annotator.last_activity_at = now - timedelta(minutes=7)
    upload_job = _create_metrics_upload_job(db_session, seed_users["admin"])
    task = _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="USER-MET-001",
        final_transcript="hello customer",
        variants=[("model_a", "Model A", "hello customer")],
        pii_annotations=[
            {
                "id": "pii-1",
                "label": "NAME",
                "start": 0,
                "end": 5,
                "value": "hello",
                "source": "manual",
                "confidence": None,
            }
        ],
        status=TaskStatusEnum.COMPLETED,
        last_tagger_id=annotator.id,
    )
    db_session.add(
        TaskAuditLog(
            task_id=task.id,
            actor_user_id=annotator.id,
            action="UPDATE_TRANSCRIPT",
            changed_fields={"final_transcript": True},
            previous_values={},
            new_values={},
            created_at=now - timedelta(minutes=25),
        )
    )
    db_session.add(
        TaskStatusHistory(
            task_id=task.id,
            old_status=TaskStatusEnum.IN_PROGRESS,
            new_status=TaskStatusEnum.COMPLETED,
            changed_by_id=annotator.id,
            comment="Done",
            changed_at=now - timedelta(minutes=5),
        )
    )
    db_session.add(
        SecurityAuditEvent(
            actor_user_id=annotator.id,
            actor_email=annotator.email,
            actor_role=annotator.role.value,
            action="ATTEMPT_SCREEN_CAPTURE",
            risk_level="high",
            resource_type="client",
            event_metadata={},
            created_at=now - timedelta(minutes=4),
        )
    )
    db_session.commit()

    response = client.get("/api/v1/metrics/admin?language=en", headers=auth_headers["admin"])
    assert response.status_code == 200
    user_metrics = {item["user_email"]: item for item in response.json()["user_metrics"]}
    annotator_metrics = user_metrics["annotator@test.com"]

    assert annotator_metrics["assigned_tasks"] == 0
    assert annotator_metrics["tasks_touched"] == 1
    assert annotator_metrics["completed_tasks"] == 1
    assert annotator_metrics["pii_annotations"] == 1
    assert annotator_metrics["average_completion_minutes"] == 20
    assert annotator_metrics["completed_turnaround_count"] == 1
    assert annotator_metrics["task_audit_events"] == 1
    assert annotator_metrics["security_events"] == 2
    assert annotator_metrics["high_risk_security_events"] == 1
    assert annotator_metrics["active_session_minutes"] is not None
    assert annotator_metrics["active_session_minutes"] >= 94
    assert annotator_metrics["idle_minutes"] is not None
    assert annotator_metrics["idle_minutes"] >= 6


def test_admin_metrics_normalize_punctuation_and_average_pair_error_rates(
    client,
    auth_headers,
    db_session,
    seed_users,
):
    upload_job = _create_metrics_upload_job(db_session, seed_users["admin"])
    _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="WER-NORM-001",
        final_transcript="Hello, world!",
        variants=[("model_a", "Model A", "hello world")],
    )
    _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="WER-NORM-002",
        final_transcript="one two three four",
        variants=[("model_a", "Model A", "one two three")],
    )
    db_session.commit()

    response = client.get("/api/v1/metrics/admin?language=en", headers=auth_headers["admin"])
    assert response.status_code == 200
    payload = response.json()

    assert payload["overview"]["scored_tasks"] == 2
    assert payload["overview"]["scored_pairs"] == 2
    assert payload["overview"]["average_wer"] == 0.125
    assert payload["overview"]["average_cer"] == 0.1389

    model_metrics = {item["source_key"]: item for item in payload["model_metrics"]}
    assert model_metrics["model_a"]["word_errors"] == 1
    assert model_metrics["model_a"]["reference_words"] == 6
    assert model_metrics["model_a"]["average_wer"] == 0.125
    assert model_metrics["model_a"]["average_cer"] == 0.1389

    worst_tasks = {item["external_id"]: item for item in payload["worst_tasks"]}
    assert worst_tasks["WER-NORM-001"]["source_metrics"][0]["wer"] == 0
    assert worst_tasks["WER-NORM-001"]["source_metrics"][0]["cer"] == 0
    assert worst_tasks["WER-NORM-002"]["source_metrics"][0]["wer"] == 0.25


def test_admin_metrics_rank_models_by_displayed_macro_average_error_rates(
    client,
    auth_headers,
    db_session,
    seed_users,
):
    upload_job = _create_metrics_upload_job(db_session, seed_users["admin"])
    long_reference = " ".join(f"w{index}" for index in range(100))
    model_b_long_hypothesis = " ".join(
        [f"x{index}" for index in range(20)] + [f"w{index}" for index in range(20, 100)]
    )
    _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="RANK-001",
        final_transcript=long_reference,
        variants=[
            ("model_a", "Model A", long_reference),
            ("model_b", "Model B", model_b_long_hypothesis),
        ],
    )
    _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="RANK-002",
        final_transcript="short",
        variants=[
            ("model_a", "Model A", "wrong"),
            ("model_b", "Model B", "short"),
        ],
    )
    db_session.commit()

    response = client.get("/api/v1/metrics/admin?language=en", headers=auth_headers["admin"])
    assert response.status_code == 200
    benchmarks = response.json()["model_benchmarks"]

    assert benchmarks["best_model_source_key"] == "model_b"
    assert benchmarks["best_model_average_wer"] == 0.1
    assert [item["source_key"] for item in benchmarks["ranking"]] == ["model_b", "model_a"]
    assert benchmarks["ranking"][0]["average_wer"] == 0.1
    assert benchmarks["ranking"][1]["average_wer"] == 0.5


def test_admin_metrics_include_audio_masking_quality(
    client,
    auth_headers,
    db_session,
    seed_users,
):
    upload_job = _create_metrics_upload_job(db_session, seed_users["admin"])
    task_one = _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="MASK-001",
        final_transcript="call john",
        variants=[("model_a", "Model A", "call john")],
        masked_audio_reference_intervals=[
            {
                "id": "pii-1",
                "source_annotation_ids": ["pii-1"],
                "start_seconds": 0.2,
                "end_seconds": 0.7,
                "labels": ["NAME"],
                "text": "john",
            }
        ],
        masked_audio_intervals=[
            {
                "id": "pii-1",
                "source_annotation_ids": ["pii-1"],
                "start_seconds": 0.3,
                "end_seconds": 0.8,
                "labels": ["NAME"],
                "text": "john",
            }
        ],
        last_tagger_id=seed_users["annotator"].id,
    )
    task_two = _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="MASK-002",
        final_transcript="call priya",
        variants=[("model_a", "Model A", "call priya")],
        masked_audio_reference_intervals=[
            {
                "id": "pii-2",
                "source_annotation_ids": ["pii-2"],
                "start_seconds": 1.0,
                "end_seconds": 2.0,
                "labels": ["NAME"],
                "text": "priya",
            }
        ],
        masked_audio_intervals=[
            {
                "id": "pii-2",
                "source_annotation_ids": ["pii-2"],
                "start_seconds": 0.7,
                "end_seconds": 1.6,
                "labels": ["NAME"],
                "text": "priya",
            }
        ],
        last_tagger_id=seed_users["annotator"].id,
    )
    _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="MASK-003",
        final_transcript="call support",
        variants=[("model_a", "Model A", "call support")],
        masked_audio_intervals=[
            {
                "id": "legacy-mask",
                "start_seconds": 0.1,
                "end_seconds": 0.4,
                "labels": ["PHONE"],
                "text": "support",
            }
        ],
    )
    db_session.commit()

    response = client.get("/api/v1/metrics/admin?language=en", headers=auth_headers["admin"])
    assert response.status_code == 200
    payload = response.json()

    assert payload["masking_metrics"] == {
        "masked_tasks": 3,
        "scored_masked_tasks": 2,
        "scored_intervals": 2,
        "average_onset_error_ms": 200,
        "average_offset_error_ms": 250,
        "leaked_audio_duration_ms": 500,
        "over_masked_duration_ms": 400,
        "unscored_masked_tasks": 1,
        "alignment_adjusted_tasks": 0,
        "alignment_adjusted_intervals": 0,
        "average_alignment_onset_adjustment_ms": None,
        "average_alignment_offset_adjustment_ms": None,
        "alignment_trimmed_duration_ms": 0,
        "alignment_expanded_duration_ms": 0,
    }
    assert payload["worst_masking_tasks"][0]["task_id"] == task_two.id
    assert payload["worst_masking_tasks"][0]["risk_duration_ms"] == 700
    assert payload["worst_masking_tasks"][1]["task_id"] == task_one.id
    assert payload["worst_masking_tasks"][1]["risk_duration_ms"] == 200
    assert payload["masking_interval_drilldowns"][0]["task_id"] == task_two.id
    assert payload["masking_interval_drilldowns"][0]["leaked_audio_duration_ms"] == 400
    assert payload["model_benchmarks"]["best_model_source_key"] == "model_a"


def test_admin_metrics_separate_human_timing_corrections_from_masking_quality(
    client,
    auth_headers,
    db_session,
    seed_users,
):
    upload_job = _create_metrics_upload_job(db_session, seed_users["admin"])
    _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="MASK-HUMAN-001",
        final_transcript="john",
        variants=[("model_a", "Model A", "john")],
        masked_audio_alignment_intervals=[
            {
                "id": "pii-1",
                "source_annotation_ids": ["pii-1"],
                "start_seconds": 0.16,
                "end_seconds": 0.58,
                "labels": ["NAME"],
                "text": "john",
            }
        ],
        masked_audio_reference_intervals=[
            {
                "id": "pii-1",
                "source_annotation_ids": ["pii-1"],
                "start_seconds": 0.2,
                "end_seconds": 0.4,
                "labels": ["NAME"],
                "text": "john",
            }
        ],
        masked_audio_intervals=[
            {
                "id": "pii-1",
                "source_annotation_ids": ["pii-1"],
                "start_seconds": 0.2,
                "end_seconds": 0.4,
                "labels": ["NAME"],
                "text": "john",
            }
        ],
        last_tagger_id=seed_users["annotator"].id,
    )
    db_session.commit()

    response = client.get("/api/v1/metrics/admin?language=en", headers=auth_headers["admin"])
    assert response.status_code == 200
    payload = response.json()

    assert payload["masking_metrics"]["leaked_audio_duration_ms"] == 0
    assert payload["masking_metrics"]["over_masked_duration_ms"] == 0
    assert payload["masking_metrics"]["alignment_adjusted_tasks"] == 1
    assert payload["masking_metrics"]["average_alignment_onset_adjustment_ms"] == 40
    assert payload["masking_metrics"]["average_alignment_offset_adjustment_ms"] == 180
    assert payload["masking_metrics"]["alignment_trimmed_duration_ms"] == 220
    assert payload["masking_interval_drilldowns"][0]["alignment_onset_delta_ms"] == 40
    assert payload["masking_interval_drilldowns"][0]["alignment_offset_delta_ms"] == -180


def test_admin_metrics_scores_alignment_adjustments_without_interval_ids(
    client,
    auth_headers,
    db_session,
    seed_users,
):
    upload_job = _create_metrics_upload_job(db_session, seed_users["admin"])
    _create_metrics_task(
        db_session,
        upload_job=upload_job,
        external_id="MASK-LEGACY-001",
        final_transcript="john smith",
        variants=[("model_a", "Model A", "john smith")],
        masked_audio_alignment_intervals=[
            {"start_seconds": 0.05, "end_seconds": 0.5, "labels": ["NAME"], "text": "john"},
            {"start_seconds": 0.7, "end_seconds": 1.4, "labels": ["NAME"], "text": "smith"},
        ],
        masked_audio_reference_intervals=[
            {"start_seconds": 0.1, "end_seconds": 0.45, "labels": ["NAME"], "text": "john"},
            {"start_seconds": 0.8, "end_seconds": 1.2, "labels": ["NAME"], "text": "smith"},
        ],
        masked_audio_intervals=[
            {"start_seconds": 0.1, "end_seconds": 0.45, "labels": ["NAME"], "text": "john"},
            {"start_seconds": 0.8, "end_seconds": 1.2, "labels": ["NAME"], "text": "smith"},
        ],
        last_tagger_id=seed_users["annotator"].id,
    )
    db_session.commit()

    response = client.get("/api/v1/metrics/admin?language=en", headers=auth_headers["admin"])
    assert response.status_code == 200
    payload = response.json()

    assert payload["masking_metrics"]["leaked_audio_duration_ms"] == 0
    assert payload["masking_metrics"]["over_masked_duration_ms"] == 0
    assert payload["masking_metrics"]["alignment_adjusted_tasks"] == 1
    assert payload["masking_metrics"]["alignment_adjusted_intervals"] == 2
    assert payload["masking_metrics"]["alignment_trimmed_duration_ms"] == 400
    assert {item["text"] for item in payload["masking_interval_drilldowns"][:2]} == {"john", "smith"}
