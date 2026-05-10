import io

import pandas as pd


def _mapping():
    return {
        "id_column": "id",
        "file_location_column": "file_location",
        "transcript_columns": [
            {"source_key": "whisper", "column_name": "model_1_transcript", "source_label": "Whisper"},
            {"source_key": "qwen", "column_name": "model_2_transcript", "source_label": "Qwen"},
        ],
        "core_metadata_columns": {
            "speaker_gender": "speaker_gender",
            "language": "language",
        },
        "notes_column": "notes",
    }


def test_export_csv_contains_corrected_fields(client, auth_headers, sample_excel_bytes):
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
    task_id = tasks_response.json()["items"][0]["id"]
    task_detail = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["admin"]).json()
    users_response = client.get("/api/v1/users", headers=auth_headers["admin"])
    annotator = next(user for user in users_response.json()["items"] if user["email"] == "annotator@test.com")
    assign_response = client.patch(
        f"/api/v1/tasks/{task_id}/assignee",
        headers=auth_headers["admin"],
        json={"version": task_detail["version"], "assignee_id": annotator["id"]},
    )
    assert assign_response.status_code == 200
    task_detail = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers["annotator"]).json()
    version = task_detail["version"]
    client.patch(
        f"/api/v1/tasks/{task_id}/transcript",
        headers=auth_headers["annotator"],
        json={"version": version, "final_transcript": "Corrected text"},
    )

    export_response = client.get("/api/v1/exports/tasks?format=csv", headers=auth_headers["admin"])
    assert export_response.status_code == 200
    dataframe = pd.read_csv(io.StringIO(export_response.text))
    assert "final_transcript_corrected" in dataframe.columns
    assert dataframe.iloc[0]["final_transcript_corrected"] == "Corrected text"
    assert "last_tagger_email" in dataframe.columns
    assert dataframe.iloc[0]["last_tagger_email"] == "annotator@test.com"


def test_export_supports_status_filter(client, auth_headers, sample_excel_bytes):
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

    export_response = client.get(
        "/api/v1/exports/tasks?format=csv&status=Approved",
        headers=auth_headers["admin"],
    )
    assert export_response.status_code == 200
    dataframe = pd.read_csv(io.StringIO(export_response.text))
    assert dataframe.empty


def test_export_supports_selected_task_ids(client, auth_headers, sample_excel_bytes):
    for _ in range(2):
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
    selected_task_id = tasks_response.json()["items"][0]["id"]
    export_response = client.get(
        f"/api/v1/exports/tasks?format=csv&task_ids={selected_task_id}",
        headers=auth_headers["admin"],
    )

    assert export_response.status_code == 200
    dataframe = pd.read_csv(io.StringIO(export_response.text))
    assert len(dataframe) == 1
    assert dataframe.iloc[0]["task_id"] == selected_task_id
