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


def test_upload_validate_and_import(client, auth_headers, sample_excel_bytes):
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
    assert upload_response.status_code == 200
    upload_job_id = upload_response.json()["upload_job_id"]

    preview_response = client.get(f"/api/v1/uploads/{upload_job_id}/preview", headers=auth_headers["admin"])
    assert preview_response.status_code == 200
    assert "id" in preview_response.json()["columns"]

    validate_response = client.post(
        f"/api/v1/uploads/{upload_job_id}/validate",
        headers=auth_headers["admin"],
        json=_mapping(),
    )
    assert validate_response.status_code == 200
    validation_payload = validate_response.json()
    assert validation_payload["valid_rows"] == 1
    assert validation_payload["invalid_rows"] > 0
    assert validation_payload["import_allowed"] is True
    assert len(validation_payload["gates"]) >= 1

    import_response = client.post(
        f"/api/v1/uploads/{upload_job_id}/import",
        headers=auth_headers["admin"],
        json=_mapping(),
    )
    assert import_response.status_code == 200
    assert import_response.json()["imported_tasks"] == 1

    list_response = client.get("/api/v1/tasks", headers=auth_headers["admin"])
    assert list_response.status_code == 200
    items = list_response.json()["items"]
    assert len(items) == 1

    annotator_list_response = client.get("/api/v1/tasks", headers=auth_headers["annotator"])
    assert annotator_list_response.status_code == 200
    assert annotator_list_response.json()["items"] == []

    task_id = items[0]["id"]
    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["admin"])
    assert detail_response.status_code == 200
    assert detail_response.json()["final_transcript"] == ""


def test_import_uses_selected_final_transcript_column(client, auth_headers, tmp_path):
    import io

    import pandas as pd

    audio_path = tmp_path / "audio_final.mp3"
    audio_path.write_bytes(b"ID3")

    dataframe = pd.DataFrame(
        [
            {
                "id": "ROW-FINAL-001",
                "file_location": f"local://{audio_path}",
                "model_1_transcript": "hello from model one",
                "model_2_transcript": "hello from model two",
                "seed_final_transcript": "preselected corrected transcript",
                "speaker_gender": "female",
                "language": "en",
                "notes": "seeded final transcript",
            }
        ]
    )
    excel_bytes = io.BytesIO()
    dataframe.to_excel(excel_bytes, index=False)

    upload_response = client.post(
        "/api/v1/uploads",
        headers=auth_headers["admin"],
        files={
            "file": (
                "final_transcript_source.xlsx",
                excel_bytes.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert upload_response.status_code == 200
    upload_job_id = upload_response.json()["upload_job_id"]

    mapping = _mapping()
    mapping["final_transcript_column"] = "seed_final_transcript"

    validate_response = client.post(
        f"/api/v1/uploads/{upload_job_id}/validate",
        headers=auth_headers["admin"],
        json=mapping,
    )
    assert validate_response.status_code == 200
    assert validate_response.json()["import_allowed"] is True

    import_response = client.post(
        f"/api/v1/uploads/{upload_job_id}/import",
        headers=auth_headers["admin"],
        json=mapping,
    )
    assert import_response.status_code == 200
    assert import_response.json()["imported_tasks"] == 1

    tasks_response = client.get("/api/v1/tasks", headers=auth_headers["admin"])
    assert tasks_response.status_code == 200
    task_id = tasks_response.json()["items"][0]["id"]

    detail_response = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["admin"])
    assert detail_response.status_code == 200
    assert detail_response.json()["final_transcript"] == "preselected corrected transcript"


def test_validate_rejects_missing_custom_metadata_columns(client, auth_headers, sample_excel_bytes):
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
    assert upload_response.status_code == 200
    upload_job_id = upload_response.json()["upload_job_id"]

    mapping = _mapping()
    mapping["custom_metadata_columns"] = ["custom_tag", "missing_custom_column"]

    validate_response = client.post(
        f"/api/v1/uploads/{upload_job_id}/validate",
        headers=auth_headers["admin"],
        json=mapping,
    )
    assert validate_response.status_code == 422
    assert validate_response.json()["detail"]["missing_columns"] == ["missing_custom_column"]


def test_preview_rejects_unreadable_excel_files(client, auth_headers):
    upload_response = client.post(
        "/api/v1/uploads",
        headers=auth_headers["admin"],
        files={
            "file": (
                "broken.xlsx",
                b"not actually an excel workbook",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert upload_response.status_code == 200
    upload_job_id = upload_response.json()["upload_job_id"]

    preview_response = client.get(f"/api/v1/uploads/{upload_job_id}/preview", headers=auth_headers["admin"])
    assert preview_response.status_code == 422
    assert preview_response.json()["detail"]["message"] == "Unable to read Excel file"


def test_import_is_blocked_when_quick_gates_fail(client, auth_headers, tmp_path):
    import io

    import pandas as pd

    dataframe = pd.DataFrame(
        [
            {
                "id": "ROW-100",
                "file_location": f"local://{tmp_path / 'missing-audio-1.mp3'}",
                "model_1_transcript": "hello world",
                "model_2_transcript": "",
                "speaker_gender": "female",
                "language": "en",
                "notes": "gate test row 1",
            },
            {
                "id": "ROW-101",
                "file_location": f"local://{tmp_path / 'missing-audio-2.mp3'}",
                "model_1_transcript": "another sentence",
                "model_2_transcript": "",
                "speaker_gender": "male",
                "language": "en",
                "notes": "gate test row 2",
            },
        ]
    )
    excel_bytes = io.BytesIO()
    dataframe.to_excel(excel_bytes, index=False)

    upload_response = client.post(
        "/api/v1/uploads",
        headers=auth_headers["admin"],
        files={
            "file": (
                "gate_fail.xlsx",
                excel_bytes.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert upload_response.status_code == 200
    upload_job_id = upload_response.json()["upload_job_id"]

    validate_response = client.post(
        f"/api/v1/uploads/{upload_job_id}/validate",
        headers=auth_headers["admin"],
        json=_mapping(),
    )
    assert validate_response.status_code == 200
    payload = validate_response.json()
    assert payload["import_allowed"] is False
    assert any(gate["gate_key"] == "audio_location_sample" and gate["status"] == "fail" for gate in payload["gates"])
    assert any(
        gate["gate_key"] == "transcript_columns_have_content" and gate["status"] == "fail"
        for gate in payload["gates"]
    )

    import_response = client.post(
        f"/api/v1/uploads/{upload_job_id}/import",
        headers=auth_headers["admin"],
        json=_mapping(),
    )
    assert import_response.status_code == 422
    assert import_response.json()["detail"]["message"] == "Import blocked by validation gates"
    assert len(import_response.json()["detail"]["failed_gates"]) >= 1


def test_validate_reports_richer_import_quality_gates(client, auth_headers, tmp_path):
    import io
    import wave

    import pandas as pd

    wav_path = tmp_path / "one-second.wav"
    with wave.open(str(wav_path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(8000)
        writer.writeframes(b"\x00\x00" * 8000)
    unsupported_path = tmp_path / "not-audio.txt"
    unsupported_path.write_text("not audio")

    dataframe = pd.DataFrame(
        [
            {
                "id": "DUP-001",
                "file_location": f"local://{wav_path}",
                "model_1_transcript": "hello",
                "model_2_transcript": "hello",
                "seed_final_transcript": "hello",
                "speaker_gender": "female",
                "language": "english",
                "notes": "duration mismatch",
                "duration_seconds": "10",
            },
            {
                "id": "DUP-001",
                "file_location": f"local://{unsupported_path}",
                "model_1_transcript": "hello again",
                "model_2_transcript": "hello again",
                "seed_final_transcript": "",
                "speaker_gender": "male",
                "language": "en-US",
                "notes": "unsupported extension",
                "duration_seconds": "1",
            },
        ]
    )
    excel_bytes = io.BytesIO()
    dataframe.to_excel(excel_bytes, index=False)

    upload_response = client.post(
        "/api/v1/uploads",
        headers=auth_headers["admin"],
        files={
            "file": (
                "rich_gates.xlsx",
                excel_bytes.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert upload_response.status_code == 200
    upload_job_id = upload_response.json()["upload_job_id"]

    mapping = _mapping()
    mapping["final_transcript_column"] = "seed_final_transcript"
    mapping["core_metadata_columns"]["duration_seconds"] = "duration_seconds"

    validate_response = client.post(
        f"/api/v1/uploads/{upload_job_id}/validate",
        headers=auth_headers["admin"],
        json=mapping,
    )
    assert validate_response.status_code == 200
    gates = {gate["gate_key"]: gate for gate in validate_response.json()["gates"]}

    assert gates["duplicate_ids"]["status"] == "warning"
    assert gates["final_transcript_coverage"]["status"] == "pass"
    assert gates["language_format"]["status"] == "warning"
    assert gates["audio_extension_support"]["status"] == "fail"
    assert gates["duration_matches_audio"]["status"] == "warning"
