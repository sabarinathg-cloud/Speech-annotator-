from datetime import datetime, timezone

from app.models.enums import TaskStatusEnum, UploadJobStatusEnum
from app.models.task import AnnotationTask
from app.models.upload import UploadFile, UploadJob
from app.services.audio_alignment_service import AudioAlignmentService, transcript_hash

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


def _create_task(client, auth_headers, sample_excel_bytes, *, assign_to_annotator=True):
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
    tasks_response = client.get("/api/v1/tasks", headers=auth_headers["admin"])
    task = tasks_response.json()["items"][0]
    if assign_to_annotator:
        users_response = client.get("/api/v1/users", headers=auth_headers["admin"])
        annotator = next(user for user in users_response.json()["items"] if user["email"] == "annotator@test.com")
        assign_response = client.patch(
            f"/api/v1/tasks/{task['id']}/assignee",
            headers=auth_headers["admin"],
            json={"version": task["version"], "assignee_id": annotator["id"]},
        )
        assert assign_response.status_code == 200
        task = assign_response.json()["task"]
    return task["id"]


def test_transcript_and_metadata_updates(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"])
    version = detail_response.json()["version"]

    transcript_response = client.patch(
        f"/api/v1/tasks/{task_id}/transcript",
        headers=auth_headers["annotator"],
        json={"version": version, "final_transcript": "Corrected transcript content"},
    )
    assert transcript_response.status_code == 200
    assert transcript_response.json()["task"]["last_tagger_email"] == "annotator@test.com"
    version = transcript_response.json()["task"]["version"]

    metadata_response = client.patch(
        f"/api/v1/tasks/{task_id}/metadata",
        headers=auth_headers["annotator"],
        json={
            "version": version,
            "speaker_gender": "non-binary",
            "channel": "agent/customer (left) #1",
            "custom_metadata": {"custom_tag": "UPDATED", "quality": "clean / review (ok)"},
        },
    )
    assert metadata_response.status_code == 200
    payload = metadata_response.json()["task"]
    assert payload["speaker_gender"] == "non-binary"
    assert payload["channel"] == "agent/customer (left) #1"
    assert payload["custom_metadata"]["quality"] == "clean / review (ok)"


def test_combined_task_save_updates_multiple_sections_once(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"])
    version = detail_response.json()["version"]

    save_response = client.patch(
        f"/api/v1/tasks/{task_id}",
        headers=auth_headers["annotator"],
        json={
            "version": version,
            "final_transcript": "Combined corrected transcript",
            "notes": "Combined save note",
            "speaker_gender": "female",
            "channel": "phone/ivr (mono)",
            "status": "In Progress",
        },
    )
    assert save_response.status_code == 200
    task = save_response.json()["task"]
    assert task["version"] == version + 1
    assert task["final_transcript"] == "Combined corrected transcript"
    assert task["notes"] == "Combined save note"
    assert task["channel"] == "phone/ivr (mono)"
    assert task["status"] == "In Progress"
    assert task["last_tagger_email"] == "annotator@test.com"


def test_transcript_update_accepts_grammatical_punctuation(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"])
    version = detail_response.json()["version"]

    transcript = "I don't know — she said, “that's John's ₹5.00 (maybe).” #VIP & ready 🙂"
    save_response = client.patch(
        f"/api/v1/tasks/{task_id}/transcript",
        headers=auth_headers["annotator"],
        json={"version": version, "final_transcript": transcript},
    )

    assert save_response.status_code == 200
    assert save_response.json()["task"]["final_transcript"] == transcript


def test_combined_task_save_accepts_special_transcript_and_note_characters(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"])
    version = detail_response.json()["version"]
    transcript = "Don't remove grammar: (A/B), ₹5.00, #VIP, “quoted text”, emoji 🙂."
    notes = "Reviewer note: keep apostrophes, slashes /, brackets [], and symbols & %."

    save_response = client.patch(
        f"/api/v1/tasks/{task_id}",
        headers=auth_headers["annotator"],
        json={"version": version, "final_transcript": transcript, "notes": notes},
    )

    assert save_response.status_code == 200
    assert save_response.json()["task"]["final_transcript"] == transcript
    assert save_response.json()["task"]["notes"] == notes


def test_combined_task_save_returns_conflict_for_stale_version(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"])
    version = detail_response.json()["version"]

    first_save = client.patch(
        f"/api/v1/tasks/{task_id}/notes",
        headers=auth_headers["annotator"],
        json={"version": version, "notes": "first"},
    )
    assert first_save.status_code == 200

    stale_save = client.patch(
        f"/api/v1/tasks/{task_id}",
        headers=auth_headers["annotator"],
        json={"version": version, "final_transcript": "stale"},
    )
    assert stale_save.status_code == 409
    assert stale_save.json()["detail"]["conflicting_fields"] == ["final_transcript"]


def test_combined_task_save_noop_does_not_increment_version(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"]).json()

    noop_save = client.patch(
        f"/api/v1/tasks/{task_id}",
        headers=auth_headers["annotator"],
        json={
            "version": detail["version"],
            "final_transcript": detail["final_transcript"],
            "notes": detail["notes"],
        },
    )

    assert noop_save.status_code == 200
    assert noop_save.json()["task"]["version"] == detail["version"]


def test_first_edit_automatically_starts_not_started_task(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"]).json()
    assert detail["status"] == "Not Started"

    notes_response = client.patch(
        f"/api/v1/tasks/{task_id}/notes",
        headers=auth_headers["annotator"],
        json={"version": detail["version"], "notes": "Started with first annotation note"},
    )

    assert notes_response.status_code == 200
    task = notes_response.json()["task"]
    assert task["status"] == "In Progress"
    assert task["version"] == detail["version"] + 1

    activity = client.get(f"/api/v1/tasks/{task_id}/activity", headers=auth_headers["annotator"])
    assert activity.status_code == 200
    assert any(
        item["type"] == "status"
        and item["old_status"] == "Not Started"
        and item["new_status"] == "In Progress"
        and item["comment"] == "Automatically moved to In Progress when work started"
        for item in activity.json()["items"]
    )


def test_metadata_update_requires_at_least_one_metadata_field(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"])
    original_task = detail_response.json()

    metadata_response = client.patch(
        f"/api/v1/tasks/{task_id}/metadata",
        headers=auth_headers["annotator"],
        json={"version": original_task["version"]},
    )
    assert metadata_response.status_code == 422

    unchanged_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"])
    unchanged_task = unchanged_response.json()
    assert unchanged_task["speaker_gender"] == original_task["speaker_gender"]
    assert unchanged_task["language"] == original_task["language"]
    assert unchanged_task["custom_metadata"] == original_task["custom_metadata"]


def test_metadata_update_can_audit_duration_changes(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"])
    version = detail_response.json()["version"]

    metadata_response = client.patch(
        f"/api/v1/tasks/{task_id}/metadata",
        headers=auth_headers["annotator"],
        json={"version": version, "duration_seconds": 42.125},
    )
    assert metadata_response.status_code == 200
    assert metadata_response.json()["task"]["duration_seconds"] == 42.125


def test_optimistic_lock_conflict(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"])
    version = detail_response.json()["version"]

    first_save = client.patch(
        f"/api/v1/tasks/{task_id}/notes",
        headers=auth_headers["annotator"],
        json={"version": version, "notes": "first save"},
    )
    assert first_save.status_code == 200

    stale_save = client.patch(
        f"/api/v1/tasks/{task_id}/notes",
        headers=auth_headers["annotator"],
        json={"version": version, "notes": "stale write"},
    )
    assert stale_save.status_code == 409
    detail = stale_save.json()["detail"]
    assert detail["conflicting_fields"] == ["notes"]
    assert "server_task" in detail


def test_status_transition_permission(client, auth_headers, sample_excel_bytes, seed_users):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"])
    version = detail_response.json()["version"]

    in_progress = client.patch(
        f"/api/v1/tasks/{task_id}/status",
        headers=auth_headers["annotator"],
        json={"version": version, "status": "In Progress"},
    )
    assert in_progress.status_code == 200
    version = in_progress.json()["task"]["version"]

    completed = client.patch(
        f"/api/v1/tasks/{task_id}/status",
        headers=auth_headers["annotator"],
        json={"version": version, "status": "Completed"},
    )
    assert completed.status_code == 200
    version = completed.json()["task"]["version"]

    needs_review = client.patch(
        f"/api/v1/tasks/{task_id}/status",
        headers=auth_headers["annotator"],
        json={"version": version, "status": "Needs Review"},
    )
    assert needs_review.status_code == 200
    version = needs_review.json()["task"]["version"]

    assign_reviewer = client.patch(
        f"/api/v1/tasks/{task_id}/assignee",
        headers=auth_headers["admin"],
        json={"version": version, "assignee_id": seed_users["reviewer"].id},
    )
    assert assign_reviewer.status_code == 200
    version = assign_reviewer.json()["task"]["version"]

    reviewed = client.patch(
        f"/api/v1/tasks/{task_id}/status",
        headers=auth_headers["reviewer"],
        json={"version": version, "status": "Reviewed"},
    )
    assert reviewed.status_code == 200
    version = reviewed.json()["task"]["version"]

    denied = client.patch(
        f"/api/v1/tasks/{task_id}/status",
        headers=auth_headers["annotator"],
        json={"version": version, "status": "In Progress"},
    )
    assert denied.status_code == 403


def test_admin_can_set_due_date_and_reviewer_can_reject(client, auth_headers, sample_excel_bytes, seed_users):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["admin"]).json()

    due_date_response = client.patch(
        f"/api/v1/tasks/{task_id}",
        headers=auth_headers["admin"],
        json={"version": detail["version"], "due_date": "2026-05-15"},
    )
    assert due_date_response.status_code == 200, due_date_response.json()
    due_date_task = due_date_response.json()["task"]
    assert due_date_task["due_date"] == "2026-05-15"

    task_list = client.get("/api/v1/tasks", headers=auth_headers["admin"]).json()["items"]
    assert task_list[0]["due_date"] == "2026-05-15"
    version = due_date_task["version"]

    completed = client.patch(
        f"/api/v1/tasks/{task_id}/status",
        headers=auth_headers["annotator"],
        json={"version": version, "status": "In Progress"},
    )
    version = completed.json()["task"]["version"]
    completed = client.patch(
        f"/api/v1/tasks/{task_id}/status",
        headers=auth_headers["annotator"],
        json={"version": version, "status": "Completed"},
    )
    version = completed.json()["task"]["version"]
    needs_review = client.patch(
        f"/api/v1/tasks/{task_id}/status",
        headers=auth_headers["annotator"],
        json={"version": version, "status": "Needs Review"},
    )
    version = needs_review.json()["task"]["version"]
    assigned = client.patch(
        f"/api/v1/tasks/{task_id}/assignee",
        headers=auth_headers["admin"],
        json={"version": version, "assignee_id": seed_users["reviewer"].id},
    )
    version = assigned.json()["task"]["version"]

    rejected = client.patch(
        f"/api/v1/tasks/{task_id}/status",
        headers=auth_headers["reviewer"],
        json={"version": version, "status": "Rejected", "comment": "Transcript punctuation needs another pass"},
    )

    assert rejected.status_code == 200
    assert rejected.json()["task"]["status"] == "Rejected"
    activity = client.get(f"/api/v1/tasks/{task_id}/activity", headers=auth_headers["reviewer"]).json()["items"]
    assert any(
        item["type"] == "status"
        and item["new_status"] == "Rejected"
        and item["comment"] == "Transcript punctuation needs another pass"
        for item in activity
    )


def test_pii_annotation_update(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"])
    version = detail_response.json()["version"]

    transcript_response = client.patch(
        f"/api/v1/tasks/{task_id}/transcript",
        headers=auth_headers["annotator"],
        json={"version": version, "final_transcript": "Contact me at john.doe@test.com"},
    )
    assert transcript_response.status_code == 200
    version = transcript_response.json()["task"]["version"]

    pii_response = client.patch(
        f"/api/v1/tasks/{task_id}/pii",
        headers=auth_headers["annotator"],
        json={
            "version": version,
            "pii_annotations": [
                {
                    "id": "pii-1",
                    "label": "EMAIL",
                    "start": 14,
                    "end": 31,
                    "value": "john.doe@test.com",
                    "source": "manual",
                    "confidence": 0.98,
                }
            ],
        },
    )
    assert pii_response.status_code == 200
    updated_task = pii_response.json()["task"]
    assert len(updated_task["pii_annotations"]) == 1
    assert updated_task["pii_annotations"][0]["label"] == "EMAIL"
    assert updated_task["pii_annotations"][0]["value"] == "john.doe@test.com"
    assert updated_task["last_tagger_email"] == "annotator@test.com"


def test_alignment_and_masked_audio_endpoints(client, auth_headers, sample_excel_bytes, monkeypatch, tmp_path, db_session):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"]).json()
    transcript_response = client.patch(
        f"/api/v1/tasks/{task_id}/transcript",
        headers=auth_headers["annotator"],
        json={"version": detail["version"], "final_transcript": "Call John now"},
    )
    version = transcript_response.json()["task"]["version"]
    pii_response = client.patch(
        f"/api/v1/tasks/{task_id}/pii",
        headers=auth_headers["annotator"],
        json={
            "version": version,
            "pii_annotations": [
                {
                    "id": "pii-1",
                    "label": "NAME",
                    "start": 5,
                    "end": 9,
                    "value": "John",
                    "source": "manual",
                    "confidence": None,
                }
            ],
        },
    )
    assert pii_response.status_code == 200

    def fake_align(self, task, force=False):
        words = [
            {
                "index": 0,
                "text": "Call",
                "normalized_text": "CALL",
                "start_char": 0,
                "end_char": 4,
                "start_seconds": 0.0,
                "end_seconds": 0.2,
                "score": 0.96,
            },
            {
                "index": 1,
                "text": "John",
                "normalized_text": "JOHN",
                "start_char": 5,
                "end_char": 9,
                "start_seconds": 0.22,
                "end_seconds": 0.5,
                "score": 0.94,
            },
        ]
        task.alignment_words = words
        task.alignment_transcript_hash = transcript_hash(task.final_transcript or "")
        task.alignment_model = "test-aligner"
        task.alignment_updated_at = datetime.now(timezone.utc)
        return words

    mask_modes: list[str] = []
    custom_mask_intervals: list[list[dict]] = []

    def fake_mask(self, task, force=False, mask_mode="silence", custom_intervals=None):
        mask_modes.append(mask_mode)
        custom_mask_intervals.append(custom_intervals or [])
        fake_path = tmp_path / "masked.wav"
        fake_path.write_bytes(b"RIFFmasked")
        task.alignment_words = fake_align(self, task, force=False)
        reference_intervals = [
            {
                "id": "pii-1",
                "source_annotation_ids": ["pii-1"],
                "start_seconds": 0.18,
                "end_seconds": 0.54,
                "labels": ["NAME"],
                "text": "John",
            }
        ]
        actual_intervals = custom_intervals or reference_intervals
        accepted_reference_intervals = actual_intervals if custom_intervals else reference_intervals
        task.masked_audio_location = str(fake_path)
        task.masked_audio_pii_hash = "pii-hash"
        task.masked_audio_updated_at = datetime.now(timezone.utc)
        task.masked_audio_intervals = actual_intervals
        task.masked_audio_reference_intervals = accepted_reference_intervals
        task.masked_audio_alignment_intervals = reference_intervals
        task.masked_audio_mode = mask_mode
        return str(fake_path), actual_intervals

    monkeypatch.setattr(AudioAlignmentService, "align_task_audio", fake_align)
    monkeypatch.setattr(AudioAlignmentService, "build_pii_masked_audio", fake_mask)

    alignment = client.post(f"/api/v1/tasks/{task_id}/alignment", headers=auth_headers["annotator"])
    assert alignment.status_code == 200
    assert alignment.json()["words"][1]["text"] == "John"
    assert alignment.json()["model"] == "test-aligner"

    masked = client.post(f"/api/v1/tasks/{task_id}/mask-pii-audio", headers=auth_headers["annotator"])
    assert masked.status_code == 200
    payload = masked.json()
    assert payload["masked_audio_url"].startswith("/api/v1/media/audio/")
    assert payload["mask_mode"] == "silence"
    assert payload["masked_intervals"] == [
        {
            "id": "pii-1",
            "source_annotation_ids": ["pii-1"],
            "start_seconds": 0.18,
            "end_seconds": 0.54,
            "labels": ["NAME"],
            "text": "John",
        }
    ]

    masked_beep = client.post(f"/api/v1/tasks/{task_id}/mask-pii-audio?mask_mode=beep", headers=auth_headers["annotator"])
    assert masked_beep.status_code == 200
    assert masked_beep.json()["mask_mode"] == "beep"
    adjusted = client.post(
        f"/api/v1/tasks/{task_id}/mask-pii-audio?mask_mode=beep",
        headers=auth_headers["annotator"],
        json={
            "mask_intervals": [
                {"start_seconds": 0.2, "end_seconds": 0.7, "labels": ["NAME"], "text": "John"},
            ]
        },
    )
    assert adjusted.status_code == 200
    assert mask_modes == ["silence", "beep", "beep"]
    assert custom_mask_intervals[-1] == [
        {"start_seconds": 0.2, "end_seconds": 0.7, "labels": ["NAME"], "text": "John"},
    ]
    refreshed = db_session.get(AnnotationTask, task_id)
    assert refreshed.masked_audio_mode == "beep"
    assert refreshed.masked_audio_intervals == [
        {"start_seconds": 0.2, "end_seconds": 0.7, "labels": ["NAME"], "text": "John"},
    ]
    assert refreshed.masked_audio_reference_intervals == [
        {"start_seconds": 0.2, "end_seconds": 0.7, "labels": ["NAME"], "text": "John"},
    ]
    assert refreshed.masked_audio_alignment_intervals == [
        {
            "id": "pii-1",
            "source_annotation_ids": ["pii-1"],
            "start_seconds": 0.18,
            "end_seconds": 0.54,
            "labels": ["NAME"],
            "text": "John",
        }
    ]

    cleared = client.patch(
        f"/api/v1/tasks/{task_id}/pii",
        headers=auth_headers["annotator"],
        json={"version": pii_response.json()["task"]["version"], "pii_annotations": []},
    )
    assert cleared.status_code == 200
    db_session.refresh(refreshed)
    assert refreshed.masked_audio_intervals == []
    assert refreshed.masked_audio_reference_intervals == []
    assert refreshed.masked_audio_alignment_intervals == []
    assert refreshed.masked_audio_mode is None


def test_admin_can_assign_task_to_user(client, auth_headers, sample_excel_bytes, seed_users):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["admin"])
    version = detail_response.json()["version"]

    denied = client.patch(
        f"/api/v1/tasks/{task_id}/assignee",
        headers=auth_headers["annotator"],
        json={"version": version, "assignee_id": seed_users["reviewer"].id},
    )
    assert denied.status_code == 403

    assign_response = client.patch(
        f"/api/v1/tasks/{task_id}/assignee",
        headers=auth_headers["admin"],
        json={"version": version, "assignee_id": seed_users["reviewer"].id},
    )
    assert assign_response.status_code == 200
    payload = assign_response.json()["task"]
    assert payload["assignee_id"] == seed_users["reviewer"].id
    assert payload["assignee_email"] == "reviewer@test.com"


def test_admin_can_create_parallel_assignment_copy(client, auth_headers, sample_excel_bytes, seed_users):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)
    source = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["admin"]).json()

    duplicate_same_user = client.post(
        f"/api/v1/tasks/{task_id}/assignment-copy",
        headers=auth_headers["admin"],
        json={"version": source["version"], "assignee_id": seed_users["annotator"].id},
    )
    assert duplicate_same_user.status_code == 409

    copy_response = client.post(
        f"/api/v1/tasks/{task_id}/assignment-copy",
        headers=auth_headers["admin"],
        json={"version": source["version"], "assignee_id": seed_users["reviewer"].id},
    )
    assert copy_response.status_code == 200
    copied = copy_response.json()["task"]
    assert copied["id"] != task_id
    assert copied["external_id"].startswith(f"{source['external_id']}__copy-reviewer-test-com")
    assert copied["file_location"] == source["file_location"]
    assert copied["assignee_email"] == "reviewer@test.com"
    assert copied["status"] == "Not Started"
    assert copied["pii_annotations"] == []
    assert [
        (variant["source_key"], variant["source_label"], variant["transcript_text"])
        for variant in copied["transcript_variants"]
    ] == [
        (variant["source_key"], variant["source_label"], variant["transcript_text"])
        for variant in source["transcript_variants"]
    ]

    annotator_tasks = client.get("/api/v1/tasks", headers=auth_headers["annotator"]).json()["items"]
    reviewer_tasks = client.get("/api/v1/tasks", headers=auth_headers["reviewer"]).json()["items"]
    assert [task["id"] for task in annotator_tasks] == [task_id]
    assert [task["id"] for task in reviewer_tasks] == [copied["id"]]

    reviewer_update = client.patch(
        f"/api/v1/tasks/{copied['id']}/transcript",
        headers=auth_headers["reviewer"],
        json={"version": copied["version"], "final_transcript": "reviewer transcript"},
    )
    assert reviewer_update.status_code == 200

    original_after_copy_work = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"]).json()
    assert original_after_copy_work["final_transcript"] != "reviewer transcript"


def test_admin_can_bulk_create_parallel_assignment_copies(client, auth_headers, sample_excel_bytes, seed_users):
    first_task_id = _create_task(client, auth_headers, sample_excel_bytes, assign_to_annotator=False)
    second_task_id = _create_task(client, auth_headers, sample_excel_bytes, assign_to_annotator=False)
    tasks = {
        task["id"]: task
        for task in client.get("/api/v1/tasks", headers=auth_headers["admin"]).json()["items"]
        if task["id"] in {first_task_id, second_task_id}
    }

    bulk = client.post(
        "/api/v1/tasks/bulk-assignment-copies",
        headers=auth_headers["admin"],
        json={
            "assignments": [
                {
                    "task_id": first_task_id,
                    "version": tasks[first_task_id]["version"],
                    "assignee_id": seed_users["reviewer"].id,
                },
                {
                    "task_id": second_task_id,
                    "version": tasks[second_task_id]["version"],
                    "assignee_id": seed_users["reviewer"].id,
                },
            ]
        },
    )
    assert bulk.status_code == 200
    assert len(bulk.json()["created"]) == 2
    assert bulk.json()["errors"] == []
    assert {item["task"]["assignee_email"] for item in bulk.json()["created"]} == {"reviewer@test.com"}


def test_unassigned_filter_claim_next_bulk_assignment_and_activity(client, auth_headers, sample_excel_bytes, seed_users):
    task_id = _create_task(client, auth_headers, sample_excel_bytes, assign_to_annotator=False)

    unassigned = client.get("/api/v1/tasks?assignee_id=unassigned", headers=auth_headers["admin"])
    assert unassigned.status_code == 200
    assert unassigned.json()["total"] == 1

    claim = client.post(f"/api/v1/tasks/{task_id}/claim", headers=auth_headers["annotator"])
    assert claim.status_code == 200
    claimed_task = claim.json()["task"]
    assert claimed_task["assignee_email"] == "annotator@test.com"
    assert claimed_task["status"] == "In Progress"

    claim_again = client.post(f"/api/v1/tasks/{task_id}/claim", headers=auth_headers["reviewer"])
    assert claim_again.status_code == 409

    bulk = client.post(
        "/api/v1/tasks/bulk-assignee",
        headers=auth_headers["admin"],
        json={
            "assignments": [
                {
                    "task_id": task_id,
                    "version": claimed_task["version"],
                    "assignee_id": seed_users["reviewer"].id,
                }
            ]
        },
    )
    assert bulk.status_code == 200
    assert bulk.json()["updated"][0]["task"]["assignee_email"] == "reviewer@test.com"
    assert bulk.json()["errors"] == []

    activity = client.get(f"/api/v1/tasks/{task_id}/activity", headers=auth_headers["reviewer"])
    assert activity.status_code == 200
    activity_types = {item["type"] for item in activity.json()["items"]}
    assert {"audit", "status"}.issubset(activity_types)
    assert any(item["actor_email"] == "annotator@test.com" for item in activity.json()["items"])


def test_admin_can_auto_balance_all_matching_tasks_beyond_current_page(client, auth_headers, db_session, seed_users):
    upload_file = UploadFile(
        original_filename="bulk-balance.xlsx",
        stored_path="/tmp/bulk-balance.xlsx",
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by_id=seed_users["admin"].id,
    )
    db_session.add(upload_file)
    db_session.flush()
    upload_job = UploadJob(
        upload_file_id=upload_file.id,
        created_by_id=seed_users["admin"].id,
        status=UploadJobStatusEnum.IMPORTED,
        preview_row_count=5,
    )
    db_session.add(upload_job)
    db_session.flush()
    tasks = []
    for index in range(5):
        task = AnnotationTask(
            upload_job_id=upload_job.id,
            external_id=f"BULK-BALANCE-{index}",
            file_location=f"local:///tmp/bulk-balance-{index}.wav",
            final_transcript="",
            notes=None,
            status=TaskStatusEnum.NOT_STARTED,
            speaker_gender=None,
            speaker_role=None,
            language="en",
            channel=None,
            duration_seconds=None,
            custom_metadata={},
            original_row={},
            pii_annotations=[],
            alignment_words=[],
        )
        db_session.add(task)
        tasks.append(task)
    db_session.commit()

    first_page = client.get("/api/v1/tasks?search=BULK-BALANCE&page_size=2", headers=auth_headers["admin"])
    assert first_page.status_code == 200
    assert len(first_page.json()["items"]) == 2
    assert first_page.json()["total"] == 5

    response = client.post(
        "/api/v1/tasks/bulk-auto-balance",
        headers=auth_headers["admin"],
        json={
            "filters": {
                "search": "BULK-BALANCE",
                "status": "Not Started",
                "assignee_id": "unassigned",
            },
            "assignee_ids": [seed_users["annotator"].id, seed_users["reviewer"].id],
        },
    )
    assert response.status_code == 200, response.json()
    assert response.json() == {
        "matched_count": 5,
        "updated_count": 5,
        "skipped_count": 0,
        "assignee_count": 2,
    }

    assigned = client.get("/api/v1/tasks?search=BULK-BALANCE&page_size=10", headers=auth_headers["admin"]).json()["items"]
    assignee_counts = {}
    for task in assigned:
        assignee_counts[task["assignee_email"]] = assignee_counts.get(task["assignee_email"], 0) + 1
    assert assignee_counts == {"annotator@test.com": 3, "reviewer@test.com": 2}

    activity = client.get(f"/api/v1/tasks/{tasks[0].id}/activity", headers=auth_headers["admin"]).json()["items"]
    assert any(item["action"] == "BULK_AUTO_BALANCE_ASSIGNEE" for item in activity)


def test_admin_auto_balance_keeps_segments_from_same_call_together(client, auth_headers, db_session, seed_users):
    upload_file = UploadFile(
        original_filename="call-balanced.csv",
        stored_path="/tmp/call-balanced.csv",
        content_type="text/csv",
        uploaded_by_id=seed_users["admin"].id,
    )
    db_session.add(upload_file)
    db_session.flush()
    upload_job = UploadJob(
        upload_file_id=upload_file.id,
        created_by_id=seed_users["admin"].id,
        status=UploadJobStatusEnum.IMPORTED,
        preview_row_count=6,
    )
    db_session.add(upload_job)
    db_session.flush()

    for call_index in range(3):
        for chunk_index in range(2):
            db_session.add(
                AnnotationTask(
                    upload_job_id=upload_job.id,
                    external_id=f"CALL-BALANCED-{call_index}-{chunk_index}",
                    file_location=f"/calls/CALL-{call_index}/channel1/chunk_{chunk_index:04d}.wav",
                    final_transcript="",
                    notes=None,
                    status=TaskStatusEnum.NOT_STARTED,
                    speaker_gender=None,
                    speaker_role=None,
                    language="en",
                    channel=None,
                    duration_seconds=None,
                    custom_metadata={},
                    original_row={"call_id": f"CALL-{call_index}"},
                    pii_annotations=[],
                    alignment_words=[],
                )
            )
    db_session.commit()

    response = client.post(
        "/api/v1/tasks/bulk-auto-balance",
        headers=auth_headers["admin"],
        json={
            "filters": {
                "search": "CALL-BALANCED",
                "status": "Not Started",
                "assignee_id": "unassigned",
            },
            "assignee_ids": [seed_users["annotator"].id, seed_users["reviewer"].id],
        },
    )
    assert response.status_code == 200, response.json()
    assert response.json()["updated_count"] == 6

    assigned = client.get("/api/v1/tasks?search=CALL-BALANCED&page_size=10", headers=auth_headers["admin"]).json()[
        "items"
    ]
    assignees_by_call: dict[str, set[str]] = {}
    for task in assigned:
        call_id = task["external_id"].rsplit("-", 1)[0]
        assignees_by_call.setdefault(call_id, set()).add(task["assignee_email"])

    assert assignees_by_call
    assert all(len(assignees) == 1 for assignees in assignees_by_call.values())
    assert {"annotator@test.com", "reviewer@test.com"}.issubset(
        {next(iter(assignees)) for assignees in assignees_by_call.values()}
    )


def test_admin_can_split_assignment_by_call_batches(client, auth_headers, db_session, seed_users):
    upload_file = UploadFile(
        original_filename="call-split.csv",
        stored_path="/tmp/call-split.csv",
        content_type="text/csv",
        uploaded_by_id=seed_users["admin"].id,
    )
    db_session.add(upload_file)
    db_session.flush()
    upload_job = UploadJob(
        upload_file_id=upload_file.id,
        created_by_id=seed_users["admin"].id,
        status=UploadJobStatusEnum.IMPORTED,
        preview_row_count=8,
    )
    db_session.add(upload_job)
    db_session.flush()
    tasks = []
    for call_index in range(4):
        for chunk_index in range(2):
            task = AnnotationTask(
                upload_job_id=upload_job.id,
                external_id=f"CALL-SPLIT-{call_index}-{chunk_index}",
                file_location=f"/calls/CALL-{call_index}/channel1/chunk_{chunk_index:04d}.wav",
                final_transcript="",
                notes=None,
                status=TaskStatusEnum.NOT_STARTED,
                speaker_gender=None,
                speaker_role=None,
                language="en",
                channel=None,
                duration_seconds=None,
                custom_metadata={},
                original_row={"call_id": f"CALL-{call_index}"},
                pii_annotations=[],
                alignment_words=[],
            )
            db_session.add(task)
            tasks.append(task)
    db_session.commit()

    response = client.post(
        "/api/v1/tasks/bulk-call-split",
        headers=auth_headers["admin"],
        json={
            "filters": {
                "search": "CALL-SPLIT",
                "status": "Not Started",
                "assignee_id": "unassigned",
            },
            "assignee_ids": [seed_users["annotator"].id, seed_users["reviewer"].id],
            "calls_per_assignee": 2,
            "call_id_column": "call_id",
        },
    )
    assert response.status_code == 200, response.json()
    payload = response.json()
    assert payload["matched_count"] == 8
    assert payload["matched_call_count"] == 4
    assert payload["updated_count"] == 8
    assert payload["skipped_count"] == 0
    assert payload["assignments"] == [
        {
            "assignee_id": seed_users["annotator"].id,
            "assignee_name": "Annotator",
            "assignee_email": "annotator@test.com",
            "call_count": 2,
            "task_count": 4,
        },
        {
            "assignee_id": seed_users["reviewer"].id,
            "assignee_name": "Reviewer",
            "assignee_email": "reviewer@test.com",
            "call_count": 2,
            "task_count": 4,
        },
    ]

    refreshed_tasks = (
        db_session.query(AnnotationTask)
        .filter(AnnotationTask.external_id.like("CALL-SPLIT-%"))
        .order_by(AnnotationTask.external_id.asc())
        .all()
    )
    assignee_by_call = {}
    for task in refreshed_tasks:
        assignee_by_call.setdefault(task.original_row["call_id"], set()).add(task.assignee_id)
    assert assignee_by_call == {
        "CALL-0": {seed_users["annotator"].id},
        "CALL-1": {seed_users["annotator"].id},
        "CALL-2": {seed_users["reviewer"].id},
        "CALL-3": {seed_users["reviewer"].id},
    }

    activity = client.get(f"/api/v1/tasks/{tasks[0].id}/activity", headers=auth_headers["admin"]).json()["items"]
    assert any(item["action"] == "BULK_CALL_SPLIT_ASSIGNEE" for item in activity)


def test_start_endpoint_claims_and_marks_task_in_progress(client, auth_headers, sample_excel_bytes):
    task_id = _create_task(client, auth_headers, sample_excel_bytes)

    start = client.post(f"/api/v1/tasks/{task_id}/start", headers=auth_headers["annotator"])

    assert start.status_code == 200
    task = start.json()["task"]
    assert task["assignee_email"] == "annotator@test.com"
    assert task["status"] == "In Progress"

    repeat_start = client.post(f"/api/v1/tasks/{task_id}/start", headers=auth_headers["annotator"])
    assert repeat_start.status_code == 200
    assert repeat_start.json()["task"]["version"] == task["version"]


def test_next_claim_and_bulk_assignment_partial_conflicts(client, auth_headers, sample_excel_bytes, seed_users):
    task_id = _create_task(client, auth_headers, sample_excel_bytes, assign_to_annotator=False)

    next_claim = client.post("/api/v1/tasks/next/claim", headers=auth_headers["reviewer"])
    assert next_claim.status_code == 200
    assert next_claim.json()["task"]["id"] == task_id
    assert next_claim.json()["task"]["assignee_email"] == "reviewer@test.com"

    empty_next = client.post("/api/v1/tasks/next/claim", headers=auth_headers["annotator"])
    assert empty_next.status_code == 404

    claimed = next_claim.json()["task"]
    bulk = client.post(
        "/api/v1/tasks/bulk-assignee",
        headers=auth_headers["admin"],
        json={
            "assignments": [
                {
                    "task_id": task_id,
                    "version": claimed["version"] - 1,
                    "assignee_id": seed_users["annotator"].id,
                },
                {
                    "task_id": "missing-task",
                    "version": 1,
                    "assignee_id": seed_users["annotator"].id,
                },
            ]
        },
    )
    assert bulk.status_code == 200
    assert bulk.json()["updated"] == []
    assert {error["status_code"] for error in bulk.json()["errors"]} == {404, 409}


def test_admin_can_bulk_update_due_dates_and_move_statuses(client, auth_headers, sample_excel_bytes):
    first_task_id = _create_task(client, auth_headers, sample_excel_bytes, assign_to_annotator=False)
    second_task_id = _create_task(client, auth_headers, sample_excel_bytes, assign_to_annotator=False)
    tasks = {
        task["id"]: task
        for task in client.get("/api/v1/tasks", headers=auth_headers["admin"]).json()["items"]
        if task["id"] in {first_task_id, second_task_id}
    }

    due_date_response = client.post(
        "/api/v1/tasks/bulk-due-date",
        headers=auth_headers["admin"],
        json={
            "updates": [
                {"task_id": first_task_id, "version": tasks[first_task_id]["version"], "due_date": "2026-05-20"},
                {"task_id": second_task_id, "version": tasks[second_task_id]["version"], "due_date": "2026-05-20"},
            ]
        },
    )
    assert due_date_response.status_code == 200, due_date_response.json()
    due_date_payload = due_date_response.json()
    assert len(due_date_payload["updated"]) == 2
    assert due_date_payload["errors"] == []
    assert {item["task"]["due_date"] for item in due_date_payload["updated"]} == {"2026-05-20"}

    versions = {item["task"]["id"]: item["task"]["version"] for item in due_date_payload["updated"]}
    status_response = client.post(
        "/api/v1/tasks/bulk-status",
        headers=auth_headers["admin"],
        json={
            "status": "In Progress",
            "comment": "Bulk move for today",
            "updates": [
                {"task_id": first_task_id, "version": versions[first_task_id]},
                {"task_id": second_task_id, "version": versions[second_task_id]},
            ],
        },
    )
    assert status_response.status_code == 200, status_response.json()
    status_payload = status_response.json()
    assert len(status_payload["updated"]) == 2
    assert status_payload["errors"] == []
    assert {item["task"]["status"] for item in status_payload["updated"]} == {"In Progress"}

    activity = client.get(f"/api/v1/tasks/{first_task_id}/activity", headers=auth_headers["admin"]).json()["items"]
    assert any(
        item["type"] == "status"
        and item["new_status"] == "In Progress"
        and item["comment"] == "Bulk move for today"
        for item in activity
    )
