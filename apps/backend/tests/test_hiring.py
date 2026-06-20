from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.core.security import get_password_hash
from app.core.config import get_settings
from app.models.enums import RoleEnum
from app.models.hiring import HiringAssessmentItem
from app.models.user import User


def _create_assessment(client, auth_headers):
    response = client.post(
        "/api/v1/hiring/assessments",
        headers=auth_headers["admin"],
        json={
            "title": "Hiring Batch A",
            "instructions": "Transcribe every WAV and mark PII.",
            "metadata_schema": [
                {
                    "key": "language",
                    "label": "Language",
                    "type": "select",
                    "required": True,
                    "options": ["en", "hi"],
                    "sort_order": 0,
                }
            ],
        },
    )
    assert response.status_code == 200
    return response.json()


def _activate_assessment(client, auth_headers, assessment_id):
    response = client.patch(
        f"/api/v1/hiring/assessments/{assessment_id}",
        headers=auth_headers["admin"],
        json={"status": "ACTIVE"},
    )
    assert response.status_code == 200
    return response.json()


def _write_wav(path: Path):
    path.write_bytes(b"RIFF$\x00\x00\x00WAVEfmt ")


def test_candidate_role_cannot_access_annotation_tasks(client, auth_headers):
    response = client.get("/api/v1/tasks", headers=auth_headers["candidate"])
    assert response.status_code == 403
    assert response.json()["detail"] == "Candidates cannot access annotation tasks"

    pii_response = client.post(
        "/api/v1/tasks/detect-pii",
        headers=auth_headers["candidate"],
        json={"transcript": "call me at 555-1212"},
    )
    assert pii_response.status_code == 403


def test_folder_import_requires_allowlisted_wav_files(client, auth_headers, tmp_path):
    settings = get_settings()
    original_roots = settings.hiring_audio_import_roots
    settings.hiring_audio_import_roots = str(tmp_path / "allowed")
    try:
        assessment = _create_assessment(client, auth_headers)
        allowed = tmp_path / "allowed"
        allowed.mkdir()
        audio_folder = allowed / "batch"
        audio_folder.mkdir()
        _write_wav(audio_folder / "sample.wav")
        (audio_folder / "readme.txt").write_text("not audio")

        reject_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/items/folder",
            headers=auth_headers["admin"],
            json={"folder_path": str(audio_folder), "recursive": False},
        )
        assert reject_response.status_code == 422
        assert reject_response.json()["detail"]["message"] == "Folder import only supports WAV files"

        (audio_folder / "readme.txt").unlink()
        import_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/items/folder",
            headers=auth_headers["admin"],
            json={"folder_path": str(audio_folder), "recursive": False},
        )
        assert import_response.status_code == 200
        assert import_response.json()["imported_items"] == 1

        outside = tmp_path / "outside"
        outside.mkdir()
        _write_wav(outside / "outside.wav")
        outside_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/items/folder",
            headers=auth_headers["admin"],
            json={"folder_path": str(outside), "recursive": False},
        )
        assert outside_response.status_code == 403
    finally:
        settings.hiring_audio_import_roots = original_roots


def test_admin_can_import_candidate_specific_folders(client, auth_headers, seed_users, tmp_path, db_session):
    settings = get_settings()
    original_roots = settings.hiring_audio_import_roots
    settings.hiring_audio_import_roots = str(tmp_path)
    try:
        assessment = _create_assessment(client, auth_headers)
        candidate_two = User(
            email="candidate.two@test.com",
            full_name="Candidate Two",
            password_hash=get_password_hash("Candidate@123"),
            role=RoleEnum.CANDIDATE,
            is_active=True,
        )
        db_session.add(candidate_two)
        db_session.commit()

        assign_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/assignments",
            headers=auth_headers["admin"],
            json={"candidate_ids": [seed_users["candidate"].id, candidate_two.id]},
        )
        assert assign_response.status_code == 200
        assignments = {item["candidate_id"]: item["id"] for item in assign_response.json()["items"]}
        first_assignment_id = assignments[seed_users["candidate"].id]
        second_assignment_id = assignments[candidate_two.id]

        first_folder = tmp_path / "candidate-one"
        second_folder = tmp_path / "candidate-two"
        first_folder.mkdir()
        second_folder.mkdir()
        _write_wav(first_folder / "candidate-one.wav")
        _write_wav(second_folder / "candidate-two.wav")

        first_import = client.post(
            f"/api/v1/hiring/assignments/{first_assignment_id}/items/folder",
            headers=auth_headers["admin"],
            json={"folder_path": str(first_folder), "recursive": False},
        )
        second_import = client.post(
            f"/api/v1/hiring/assignments/{second_assignment_id}/items/folder",
            headers=auth_headers["admin"],
            json={"folder_path": str(second_folder), "recursive": False},
        )
        assert first_import.status_code == 200
        assert second_import.status_code == 200

        first_review = client.get(
            f"/api/v1/hiring/assignments/{first_assignment_id}/review",
            headers=auth_headers["admin"],
        )
        second_review = client.get(
            f"/api/v1/hiring/assignments/{second_assignment_id}/review",
            headers=auth_headers["admin"],
        )
        assert first_review.status_code == 200
        assert second_review.status_code == 200
        assert [item["original_filename"] for item in first_review.json()["items"]] == ["candidate-one.wav"]
        assert [item["original_filename"] for item in second_review.json()["items"]] == ["candidate-two.wav"]

        _activate_assessment(client, auth_headers, assessment["id"])
        candidate_detail = client.get(
            f"/api/v1/hiring/candidate/assignments/{first_assignment_id}",
            headers=auth_headers["candidate"],
        )
        assert candidate_detail.status_code == 200
        assert [item["original_filename"] for item in candidate_detail.json()["items"]] == ["candidate-one.wav"]

        second_item_id = second_review.json()["items"][0]["id"]
        wrong_assignment_download = client.get(
            f"/api/v1/hiring/candidate/assignments/{first_assignment_id}/items/{second_item_id}/download",
            headers=auth_headers["candidate"],
        )
        assert wrong_assignment_download.status_code == 404
    finally:
        settings.hiring_audio_import_roots = original_roots


def test_hiring_candidate_submit_download_and_admin_scorecard(client, auth_headers, seed_users, tmp_path, db_session):
    settings = get_settings()
    original_roots = settings.hiring_audio_import_roots
    settings.hiring_audio_import_roots = str(tmp_path)
    try:
        assessment = _create_assessment(client, auth_headers)
        audio_folder = tmp_path / "audio"
        audio_folder.mkdir()
        _write_wav(audio_folder / "call.wav")

        import_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/items/folder",
            headers=auth_headers["admin"],
            json={"folder_path": str(audio_folder), "recursive": False},
        )
        assert import_response.status_code == 200
        item = db_session.query(HiringAssessmentItem).filter_by(assessment_id=assessment["id"]).one()
        assert item.original_source == str(audio_folder / "call.wav")
        assert Path(item.stored_path).is_file()
        assert Path(item.stored_path).parent.name == assessment["id"]

        _activate_assessment(client, auth_headers, assessment["id"])
        assign_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/assignments",
            headers=auth_headers["admin"],
            json={"candidate_ids": [seed_users["candidate"].id]},
        )
        assert assign_response.status_code == 200
        assignment_id = assign_response.json()["items"][0]["id"]

        candidate_detail = client.get(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}",
            headers=auth_headers["candidate"],
        )
        assert candidate_detail.status_code == 200
        payload = candidate_detail.json()
        submission = payload["submissions"][0]
        item_id = payload["items"][0]["id"]
        assert payload["items"][0]["reference_transcript"] is None

        download_response = client.get(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}/items/{item_id}/download",
            headers=auth_headers["candidate"],
        )
        assert download_response.status_code == 200
        assert download_response.headers["content-disposition"].startswith("attachment")

        zip_response = client.get(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}/download-zip",
            headers=auth_headers["candidate"],
        )
        assert zip_response.status_code == 200
        assert zip_response.headers["content-type"] == "application/zip"

        save_response = client.patch(
            f"/api/v1/hiring/candidate/submissions/{submission['id']}",
            headers=auth_headers["candidate"],
            json={
                "version": submission["version"],
                "final_transcript": "hello candidate",
                "pii_text": "None",
                "pii_reviewed": True,
            },
        )
        assert save_response.status_code == 200
        submission = save_response.json()["submissions"][0]
        assert submission["pii_text"] == "None"

        blocked_submit = client.post(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}/submit",
            headers=auth_headers["candidate"],
        )
        assert blocked_submit.status_code == 422
        assert "Language is required" in blocked_submit.json()["detail"]["errors"][0]

        save_metadata_response = client.patch(
            f"/api/v1/hiring/candidate/submissions/{submission['id']}",
            headers=auth_headers["candidate"],
            json={
                "version": submission["version"],
                "metadata_values": {"language": "en"},
                "pii_annotations": [],
                "pii_reviewed": True,
            },
        )
        assert save_metadata_response.status_code == 200

        submit_response = client.post(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}/submit",
            headers=auth_headers["candidate"],
        )
        assert submit_response.status_code == 200
        assert submit_response.json()["status"] == "SUBMITTED"

        locked_save = client.patch(
            f"/api/v1/hiring/candidate/submissions/{submission['id']}",
            headers=auth_headers["candidate"],
            json={"version": save_metadata_response.json()["submissions"][0]["version"], "notes": "late edit"},
        )
        assert locked_save.status_code == 409

        review_response = client.get(
            f"/api/v1/hiring/assignments/{assignment_id}/review",
            headers=auth_headers["admin"],
        )
        assert review_response.status_code == 200
        review_payload = review_response.json()
        assert review_payload["candidate_email"] == "candidate@test.com"
        assert review_payload["submissions"][0]["pii_text"] == "None"

        validation_response = client.patch(
            f"/api/v1/hiring/submissions/{review_payload['submissions'][0]['id']}/validation",
            headers=auth_headers["admin"],
            json={"validation_status": "VALIDATED"},
        )
        assert validation_response.status_code == 200
        assert validation_response.json()["validation_status"] == "VALIDATED"

        score_response = client.patch(
            f"/api/v1/hiring/assignments/{assignment_id}/scorecard",
            headers=auth_headers["admin"],
            json={
                "transcript_score": 8,
                "pii_score": 9,
                "metadata_score": 10,
                "total_score": 27,
                "decision": "PASS",
                "evaluator_notes": "Good work",
            },
        )
        assert score_response.status_code == 200
        assert score_response.json()["status"] == "EVALUATED"
        assert score_response.json()["decision"] == "PASS"
    finally:
        settings.hiring_audio_import_roots = original_roots


def test_hiring_reference_answers_drive_review_comparison_and_score_suggestion(
    client,
    auth_headers,
    seed_users,
    tmp_path,
    db_session,
):
    settings = get_settings()
    original_roots = settings.hiring_audio_import_roots
    settings.hiring_audio_import_roots = str(tmp_path)
    try:
        create_response = client.post(
            "/api/v1/hiring/assessments",
            headers=auth_headers["admin"],
            json={
                "title": "Reference Scoring",
                "instructions": "Transcribe and list PII.",
                "rubric_schema": [
                    {
                        "key": "transcript_accuracy",
                        "label": "Transcript accuracy",
                        "max_score": 40,
                        "required": True,
                        "sort_order": 0,
                    }
                ],
            },
        )
        assert create_response.status_code == 200
        assessment = create_response.json()

        audio_folder = tmp_path / "reference-audio"
        audio_folder.mkdir()
        _write_wav(audio_folder / "reference.wav")
        import_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/items/folder",
            headers=auth_headers["admin"],
            json={"folder_path": str(audio_folder), "recursive": False},
        )
        assert import_response.status_code == 200
        item = db_session.query(HiringAssessmentItem).filter_by(assessment_id=assessment["id"]).one()

        reference_response = client.patch(
            f"/api/v1/hiring/assessments/{assessment['id']}/items/{item.id}/reference",
            headers=auth_headers["admin"],
            json={
                "reference_transcript": "hello john doe today",
                "reference_pii_entries": [
                    {"type": "Name", "value": "John", "timestamp": "00:01", "notes": None},
                    {"type": "Email", "value": "john@example.com", "timestamp": None, "notes": None},
                ],
            },
        )
        assert reference_response.status_code == 200
        reference_item = reference_response.json()["items"][0]
        assert reference_item["reference_transcript"] == "hello john doe today"
        assert reference_item["reference_pii_entries"][0]["value"] == "John"

        _activate_assessment(client, auth_headers, assessment["id"])
        assign_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/assignments",
            headers=auth_headers["admin"],
            json={"candidate_ids": [seed_users["candidate"].id]},
        )
        assert assign_response.status_code == 200
        assignment_id = assign_response.json()["items"][0]["id"]

        candidate_detail = client.get(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}",
            headers=auth_headers["candidate"],
        )
        assert candidate_detail.status_code == 200
        candidate_payload = candidate_detail.json()
        assert candidate_payload["items"][0]["reference_transcript"] is None
        assert candidate_payload["items"][0]["reference_pii_entries"] == []
        submission = candidate_payload["submissions"][0]

        save_response = client.patch(
            f"/api/v1/hiring/candidate/submissions/{submission['id']}",
            headers=auth_headers["candidate"],
            json={
                "version": submission["version"],
                "final_transcript": "hello john today",
                "pii_text": "John as person, phone 555-0100",
                "pii_entries": [
                    {"type": "Person", "value": "John", "timestamp": "00:01", "notes": None},
                    {"type": "Phone", "value": "555-0100", "timestamp": "00:03", "notes": None},
                ],
                "pii_reviewed": True,
            },
        )
        assert save_response.status_code == 200

        submit_response = client.post(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}/submit",
            headers=auth_headers["candidate"],
        )
        assert submit_response.status_code == 200

        review_response = client.get(
            f"/api/v1/hiring/assignments/{assignment_id}/review",
            headers=auth_headers["admin"],
        )
        assert review_response.status_code == 200
        metrics = review_response.json()["submissions"][0]["reference_metrics"]
        assert metrics["word_error_rate"] == 0.25
        assert metrics["transcript_accuracy_percent"] == 75.0
        assert metrics["suggested_transcript_score"] == 30.0
        assert metrics["suggested_transcript_score_max"] == 40.0
        assert metrics["transcript_missing_words"] == ["doe"]
        assert metrics["pii_matched_count"] == 0
        assert metrics["pii_missing"][0]["type"] == "Email"
        assert metrics["pii_extra"][0]["type"] == "Phone"
        assert metrics["pii_type_mismatches"][0]["expected"]["type"] == "Name"
        assert metrics["pii_type_mismatches"][0]["actual"]["type"] == "Person"
    finally:
        settings.hiring_audio_import_roots = original_roots


def test_hiring_deadline_locks_and_admin_can_extend(client, auth_headers, seed_users, tmp_path):
    settings = get_settings()
    original_roots = settings.hiring_audio_import_roots
    settings.hiring_audio_import_roots = str(tmp_path)
    try:
        past_due_at = datetime.now(UTC) - timedelta(minutes=5)
        future_due_at = datetime.now(UTC) + timedelta(minutes=30)
        response = client.post(
            "/api/v1/hiring/assessments",
            headers=auth_headers["admin"],
            json={
                "title": "Timed Deadline",
                "instructions": "Submit before deadline.",
                "due_at": past_due_at.isoformat(),
                "due_date": past_due_at.date().isoformat(),
            },
        )
        assert response.status_code == 200
        assessment = response.json()

        audio_folder = tmp_path / "deadline-audio"
        audio_folder.mkdir()
        _write_wav(audio_folder / "deadline.wav")
        import_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/items/folder",
            headers=auth_headers["admin"],
            json={"folder_path": str(audio_folder), "recursive": False},
        )
        assert import_response.status_code == 200
        _activate_assessment(client, auth_headers, assessment["id"])

        assign_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/assignments",
            headers=auth_headers["admin"],
            json={"candidate_ids": [seed_users["candidate"].id]},
        )
        assert assign_response.status_code == 200
        assignment_id = assign_response.json()["items"][0]["id"]

        candidate_detail = client.get(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}",
            headers=auth_headers["candidate"],
        )
        assert candidate_detail.status_code == 200
        assert candidate_detail.json()["seconds_remaining"] == 0
        submission = candidate_detail.json()["submissions"][0]

        locked_save = client.patch(
            f"/api/v1/hiring/candidate/submissions/{submission['id']}",
            headers=auth_headers["candidate"],
            json={"version": submission["version"], "final_transcript": "too late"},
        )
        assert locked_save.status_code == 409

        extend_response = client.patch(
            f"/api/v1/hiring/assessments/{assessment['id']}",
            headers=auth_headers["admin"],
            json={"due_at": future_due_at.isoformat(), "due_date": future_due_at.date().isoformat()},
        )
        assert extend_response.status_code == 200
        assert extend_response.json()["due_at"] is not None

        unlocked_save = client.patch(
            f"/api/v1/hiring/candidate/submissions/{submission['id']}",
            headers=auth_headers["candidate"],
            json={"version": submission["version"], "final_transcript": "extended time"},
        )
        assert unlocked_save.status_code == 200
        assert unlocked_save.json()["seconds_remaining"] > 0
    finally:
        settings.hiring_audio_import_roots = original_roots


def test_admin_can_revoke_assignment_access_and_remove_candidate(client, auth_headers, seed_users, tmp_path):
    settings = get_settings()
    original_roots = settings.hiring_audio_import_roots
    settings.hiring_audio_import_roots = str(tmp_path)
    try:
        assessment = _create_assessment(client, auth_headers)
        audio_folder = tmp_path / "access-audio"
        audio_folder.mkdir()
        _write_wav(audio_folder / "access.wav")
        import_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/items/folder",
            headers=auth_headers["admin"],
            json={"folder_path": str(audio_folder), "recursive": False},
        )
        assert import_response.status_code == 200
        _activate_assessment(client, auth_headers, assessment["id"])

        assign_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/assignments",
            headers=auth_headers["admin"],
            json={"candidate_ids": [seed_users["candidate"].id]},
        )
        assert assign_response.status_code == 200
        assignment_id = assign_response.json()["items"][0]["id"]

        revoke_response = client.patch(
            f"/api/v1/hiring/assignments/{assignment_id}/access",
            headers=auth_headers["admin"],
            json={"access_revoked": True},
        )
        assert revoke_response.status_code == 200
        assert revoke_response.json()["access_revoked"] is True

        candidate_list = client.get("/api/v1/hiring/candidate/assignments", headers=auth_headers["candidate"])
        assert candidate_list.status_code == 200
        assert candidate_list.json()["items"] == []

        revoked_detail = client.get(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}",
            headers=auth_headers["candidate"],
        )
        assert revoked_detail.status_code == 403

        restore_response = client.patch(
            f"/api/v1/hiring/assignments/{assignment_id}/access",
            headers=auth_headers["admin"],
            json={"access_revoked": False},
        )
        assert restore_response.status_code == 200
        restored_detail = client.get(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}",
            headers=auth_headers["candidate"],
        )
        assert restored_detail.status_code == 200

        remove_response = client.delete(
            f"/api/v1/users/{seed_users['candidate'].id}",
            headers=auth_headers["admin"],
        )
        assert remove_response.status_code == 200
        assert remove_response.json()["is_active"] is False

        removed_detail = client.get(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}",
            headers=auth_headers["candidate"],
        )
        assert removed_detail.status_code == 401
    finally:
        settings.hiring_audio_import_roots = original_roots


def test_hiring_invite_timer_structured_pii_blind_rubric_ranking_and_audit(
    client,
    auth_headers,
    seed_users,
    tmp_path,
    db_session,
):
    settings = get_settings()
    original_roots = settings.hiring_audio_import_roots
    settings.hiring_audio_import_roots = str(tmp_path)
    try:
        response = client.post(
            "/api/v1/hiring/assessments",
            headers=auth_headers["admin"],
            json={
                "title": "Blind Timed Hiring",
                "instructions": "Transcribe and list PII.",
                "time_limit_minutes": 30,
                "blind_review_enabled": True,
                "metadata_schema": [
                    {
                        "key": "audio_quality",
                        "label": "Audio quality",
                        "type": "select",
                        "required": True,
                        "options": ["Clean audio", "Background noise"],
                        "sort_order": 0,
                    }
                ],
                "rubric_schema": [
                    {
                        "key": "accuracy",
                        "label": "Accuracy",
                        "max_score": 10,
                        "required": True,
                        "sort_order": 0,
                    }
                ],
            },
        )
        assert response.status_code == 200
        assessment = response.json()

        audio_folder = tmp_path / "audio"
        audio_folder.mkdir()
        _write_wav(audio_folder / "blind.wav")
        import_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/items/folder",
            headers=auth_headers["admin"],
            json={"folder_path": str(audio_folder), "recursive": False},
        )
        assert import_response.status_code == 200
        _activate_assessment(client, auth_headers, assessment["id"])

        assign_response = client.post(
            f"/api/v1/hiring/assessments/{assessment['id']}/assignments",
            headers=auth_headers["admin"],
            json={"candidate_ids": [seed_users["candidate"].id]},
        )
        assert assign_response.status_code == 200
        assignment_id = assign_response.json()["items"][0]["id"]

        invite_response = client.post(
            f"/api/v1/hiring/assignments/{assignment_id}/invite",
            headers=auth_headers["admin"],
        )
        assert invite_response.status_code == 200
        invite_payload = invite_response.json()
        assert invite_payload["candidate_email"] == "candidate@test.com"
        assert invite_payload["temporary_password"]
        assert f"/hiring/{assignment_id}" in invite_payload["invite_url"]

        candidate_detail = client.get(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}",
            headers=auth_headers["candidate"],
        )
        assert candidate_detail.status_code == 200
        detail_payload = candidate_detail.json()
        assert detail_payload["started_at"] is not None
        assert 0 < detail_payload["seconds_remaining"] <= 1800
        submission = detail_payload["submissions"][0]

        save_response = client.patch(
            f"/api/v1/hiring/candidate/submissions/{submission['id']}",
            headers=auth_headers["candidate"],
            json={
                "version": submission["version"],
                "final_transcript": "hello john",
                "pii_text": "Name John",
                "pii_entries": [
                    {"type": "Name", "value": "John", "timestamp": "00:02", "notes": "speaker name"}
                ],
                "metadata_values": {"audio_quality": "Clean audio"},
                "pii_reviewed": True,
            },
        )
        assert save_response.status_code == 200
        saved_submission = save_response.json()["submissions"][0]
        assert saved_submission["pii_entries"][0]["value"] == "John"

        submit_response = client.post(
            f"/api/v1/hiring/candidate/assignments/{assignment_id}/submit",
            headers=auth_headers["candidate"],
        )
        assert submit_response.status_code == 200

        review_response = client.get(
            f"/api/v1/hiring/assignments/{assignment_id}/review",
            headers=auth_headers["admin"],
        )
        assert review_response.status_code == 200
        review_payload = review_response.json()
        assert review_payload["candidate_email"] == "Hidden for blind review"
        assert review_payload["submissions"][0]["pii_entries"][0]["type"] == "Name"

        score_response = client.patch(
            f"/api/v1/hiring/assignments/{assignment_id}/scorecard",
            headers=auth_headers["admin"],
            json={
                "rubric_scores": {"accuracy": 8},
                "decision": "PASS",
                "evaluator_notes": "Strong candidate",
            },
        )
        assert score_response.status_code == 200
        assert score_response.json()["total_score"] == 8

        ranking_response = client.get(
            f"/api/v1/hiring/assessments/{assessment['id']}/ranking",
            headers=auth_headers["admin"],
        )
        assert ranking_response.status_code == 200
        ranking_payload = ranking_response.json()["items"][0]
        assert ranking_payload["candidate_identity_hidden"] is True
        assert ranking_payload["total_score"] == 8

        audit_response = client.get(
            f"/api/v1/hiring/assignments/{assignment_id}/audit-events",
            headers=auth_headers["admin"],
        )
        assert audit_response.status_code == 200
        actions = {event["action"] for event in audit_response.json()["items"]}
        assert {
            "CREATE_HIRING_INVITE",
            "OPEN_HIRING_ASSIGNMENT",
            "SAVE_HIRING_SUBMISSION",
            "SUBMIT_HIRING_ASSIGNMENT",
            "SAVE_HIRING_SCORECARD",
        }.issubset(actions)
    finally:
        settings.hiring_audio_import_roots = original_roots
