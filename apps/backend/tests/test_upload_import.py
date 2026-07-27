from app.core.config import get_settings


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
    assert preview_response.json()["detail"]["message"] == "Unable to read source file"


def test_upload_source_file_from_allowed_server_csv_path(client, auth_headers, tmp_path):
    settings = get_settings()
    original_roots = settings.task_manifest_import_roots
    settings.task_manifest_import_roots = str(tmp_path)
    try:
        audio_path = tmp_path / "audio-row.wav"
        audio_path.write_bytes(b"RIFF")
        csv_path = tmp_path / "tasks.csv"
        csv_path.write_text(
            "\n".join(
                [
                    "id,file_location,model_1_transcript,model_2_transcript,speaker_gender,language,notes",
                    f"CSV-001,local://{audio_path},hello from csv,hello alternate,female,en,server path import",
                ]
            ),
            encoding="utf-8",
        )

        upload_response = client.post(
            "/api/v1/uploads/from-path",
            headers=auth_headers["admin"],
            json={"path": str(csv_path)},
        )

        assert upload_response.status_code == 200
        assert upload_response.json()["filename"] == "tasks.csv"
        upload_job_id = upload_response.json()["upload_job_id"]

        preview_response = client.get(f"/api/v1/uploads/{upload_job_id}/preview", headers=auth_headers["admin"])
        assert preview_response.status_code == 200
        assert preview_response.json()["columns"][:3] == ["id", "file_location", "model_1_transcript"]

        validate_response = client.post(
            f"/api/v1/uploads/{upload_job_id}/validate",
            headers=auth_headers["admin"],
            json=_mapping(),
        )
        assert validate_response.status_code == 200
        assert validate_response.json()["valid_rows"] == 1

        import_response = client.post(
            f"/api/v1/uploads/{upload_job_id}/import",
            headers=auth_headers["admin"],
            json=_mapping(),
        )
        assert import_response.status_code == 200
        assert import_response.json()["imported_tasks"] == 1
    finally:
        settings.task_manifest_import_roots = original_roots


def test_upload_source_file_from_allowed_server_parquet_path_with_call_id_limit(client, auth_headers, tmp_path):
    import wave

    import pandas as pd
    import pytest

    pytest.importorskip("pyarrow")

    settings = get_settings()
    original_roots = settings.task_manifest_import_roots
    settings.task_manifest_import_roots = str(tmp_path)
    try:
        audio_paths = []
        for index in range(3):
            wav_path = tmp_path / f"segment-{index}.wav"
            with wave.open(str(wav_path), "wb") as writer:
                writer.setnchannels(1)
                writer.setsampwidth(2)
                writer.setframerate(8000)
                writer.writeframes(b"\x00\x00" * 8000)
            audio_paths.append(wav_path)

        parquet_path = tmp_path / "all_segments.parquet"
        dataframe = pd.DataFrame(
            [
                {
                    "segment_id": "SEG-A-0000",
                    "call_id": "CALL-A",
                    "segment_audio_path_abs": str(audio_paths[0]),
                    "whisper_transcript": "hello from call a zero",
                    "qwen_transcript": "hello from call a zero alt",
                    "final_transcript": "hello from call a zero final",
                    "duration_sec": "1.0",
                    "language": "en",
                    "channel": "channel1",
                },
                {
                    "segment_id": "SEG-A-0001",
                    "call_id": "CALL-A",
                    "segment_audio_path_abs": str(audio_paths[1]),
                    "whisper_transcript": "hello from call a one",
                    "qwen_transcript": "hello from call a one alt",
                    "final_transcript": "hello from call a one final",
                    "duration_sec": "1.0",
                    "language": "en",
                    "channel": "channel1",
                },
                {
                    "segment_id": "SEG-B-0000",
                    "call_id": "CALL-B",
                    "segment_audio_path_abs": str(audio_paths[2]),
                    "whisper_transcript": "hello from call b zero",
                    "qwen_transcript": "hello from call b zero alt",
                    "final_transcript": "hello from call b zero final",
                    "duration_sec": "1.0",
                    "language": "en",
                    "channel": "channel2",
                },
            ]
        )
        dataframe.to_parquet(parquet_path, index=False, engine="pyarrow")

        upload_response = client.post(
            "/api/v1/uploads/from-path",
            headers=auth_headers["admin"],
            json={"path": str(parquet_path), "call_id_limit": 1, "call_id_column": "call_id"},
        )

        assert upload_response.status_code == 200
        assert upload_response.json()["filename"] == "all_segments.parquet"
        upload_job_id = upload_response.json()["upload_job_id"]

        preview_response = client.get(f"/api/v1/uploads/{upload_job_id}/preview", headers=auth_headers["admin"])
        assert preview_response.status_code == 200
        preview_payload = preview_response.json()
        assert preview_payload["row_count"] == 2
        assert preview_payload["sample_rows"][0]["call_id"] == "CALL-A"
        assert preview_payload["columns"][:3] == ["segment_id", "call_id", "segment_audio_path_abs"]

        mapping = {
            "id_column": "segment_id",
            "file_location_column": "segment_audio_path_abs",
            "transcript_columns": [
                {"source_key": "whisper", "column_name": "whisper_transcript", "source_label": "Whisper"},
                {"source_key": "qwen", "column_name": "qwen_transcript", "source_label": "Qwen"},
            ],
            "final_transcript_column": "final_transcript",
            "core_metadata_columns": {
                "duration_seconds": "duration_sec",
                "language": "language",
                "channel": "channel",
            },
        }
        validate_response = client.post(
            f"/api/v1/uploads/{upload_job_id}/validate",
            headers=auth_headers["admin"],
            json=mapping,
        )
        assert validate_response.status_code == 200
        assert validate_response.json()["valid_rows"] == 2
        assert validate_response.json()["import_allowed"] is True

        import_response = client.post(
            f"/api/v1/uploads/{upload_job_id}/import",
            headers=auth_headers["admin"],
            json=mapping,
        )
        assert import_response.status_code == 200
        assert import_response.json()["imported_tasks"] == 2
    finally:
        settings.task_manifest_import_roots = original_roots


def test_upload_source_file_from_allowed_server_parquet_without_call_id_uses_row_limit(client, auth_headers, tmp_path):
    import wave

    import pandas as pd
    import pytest

    pytest.importorskip("pyarrow")

    settings = get_settings()
    original_roots = settings.task_manifest_import_roots
    settings.task_manifest_import_roots = str(tmp_path)
    try:
        audio_paths = []
        for index in range(3):
            wav_path = tmp_path / f"row-limit-segment-{index}.wav"
            with wave.open(str(wav_path), "wb") as writer:
                writer.setnchannels(1)
                writer.setsampwidth(2)
                writer.setframerate(8000)
                writer.writeframes(b"\x00\x00" * 8000)
            audio_paths.append(wav_path)

        parquet_path = tmp_path / "segments_without_call_id.parquet"
        dataframe = pd.DataFrame(
            [
                {
                    "segment_id": "ROW-LIMIT-0000",
                    "segment_audio_path_abs": str(audio_paths[0]),
                    "whisper_transcript": "row zero transcript",
                    "final_transcript": "row zero final",
                    "duration_sec": "1.0",
                    "language": "en",
                },
                {
                    "segment_id": "ROW-LIMIT-0001",
                    "segment_audio_path_abs": str(audio_paths[1]),
                    "whisper_transcript": "row one transcript",
                    "final_transcript": "row one final",
                    "duration_sec": "1.0",
                    "language": "en",
                },
                {
                    "segment_id": "ROW-LIMIT-0002",
                    "segment_audio_path_abs": str(audio_paths[2]),
                    "whisper_transcript": "row two transcript",
                    "final_transcript": "row two final",
                    "duration_sec": "1.0",
                    "language": "en",
                },
            ]
        )
        dataframe.to_parquet(parquet_path, index=False, engine="pyarrow")

        missing_call_id_response = client.post(
            "/api/v1/uploads/from-path",
            headers=auth_headers["admin"],
            json={"path": str(parquet_path), "call_id_limit": 1, "call_id_column": "call_id"},
        )
        assert missing_call_id_response.status_code == 422
        assert "Call ID column 'call_id' was not found" in missing_call_id_response.json()["detail"]["message"]

        upload_response = client.post(
            "/api/v1/uploads/from-path",
            headers=auth_headers["admin"],
            json={"path": str(parquet_path), "row_limit": 2},
        )

        assert upload_response.status_code == 200
        upload_job_id = upload_response.json()["upload_job_id"]

        preview_response = client.get(f"/api/v1/uploads/{upload_job_id}/preview", headers=auth_headers["admin"])
        assert preview_response.status_code == 200
        preview_payload = preview_response.json()
        assert preview_payload["row_count"] == 2
        assert [row["segment_id"] for row in preview_payload["sample_rows"]] == ["ROW-LIMIT-0000", "ROW-LIMIT-0001"]

        mapping = {
            "id_column": "segment_id",
            "file_location_column": "segment_audio_path_abs",
            "transcript_columns": [
                {"source_key": "whisper", "column_name": "whisper_transcript", "source_label": "Whisper"},
            ],
            "final_transcript_column": "final_transcript",
            "core_metadata_columns": {
                "duration_seconds": "duration_sec",
                "language": "language",
            },
        }
        validate_response = client.post(
            f"/api/v1/uploads/{upload_job_id}/validate",
            headers=auth_headers["admin"],
            json=mapping,
        )
        assert validate_response.status_code == 200
        assert validate_response.json()["valid_rows"] == 2
        assert validate_response.json()["import_allowed"] is True

        import_response = client.post(
            f"/api/v1/uploads/{upload_job_id}/import",
            headers=auth_headers["admin"],
            json=mapping,
        )
        assert import_response.status_code == 200
        assert import_response.json()["imported_tasks"] == 2
    finally:
        settings.task_manifest_import_roots = original_roots


def test_upload_source_file_from_path_rejects_unconfigured_or_outside_roots(client, auth_headers, tmp_path):
    settings = get_settings()
    original_roots = settings.task_manifest_import_roots
    csv_path = tmp_path / "tasks.csv"
    csv_path.write_text("id,file_location,model_1_transcript\n", encoding="utf-8")
    try:
        settings.task_manifest_import_roots = ""
        unconfigured = client.post(
            "/api/v1/uploads/from-path",
            headers=auth_headers["admin"],
            json={"path": str(csv_path)},
        )
        assert unconfigured.status_code == 422
        assert unconfigured.json()["detail"]["message"] == "No task manifest import roots are configured"

        allowed_root = tmp_path / "allowed"
        allowed_root.mkdir()
        settings.task_manifest_import_roots = str(allowed_root)
        outside = client.post(
            "/api/v1/uploads/from-path",
            headers=auth_headers["admin"],
            json={"path": str(csv_path)},
        )
        assert outside.status_code == 403
        assert outside.json()["detail"]["message"] == (
            "Source file path is outside the configured task manifest import roots"
        )
    finally:
        settings.task_manifest_import_roots = original_roots


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
