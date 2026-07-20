from datetime import datetime, timedelta, timezone

from app.models.enums import RoleEnum, TaskStatusEnum, UploadJobStatusEnum
from app.models.task import AnnotationTask
from app.models.upload import UploadFile, UploadJob


def _create_upload_job(db_session, admin):
    upload_file = UploadFile(
        original_filename="admin-user-management.xlsx",
        stored_path="/tmp/admin-user-management.xlsx",
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by_id=admin.id,
    )
    db_session.add(upload_file)
    db_session.flush()
    upload_job = UploadJob(
        upload_file_id=upload_file.id,
        created_by_id=admin.id,
        status=UploadJobStatusEnum.IMPORTED,
        mapping_json={},
    )
    db_session.add(upload_job)
    db_session.flush()
    return upload_job


def _create_task(db_session, upload_job, *, external_id, assignee_id, status):
    task = AnnotationTask(
        external_id=external_id,
        upload_job_id=upload_job.id,
        file_location=f"local:///tmp/{external_id}.wav",
        status=status,
        assignee_id=assignee_id,
        custom_metadata={},
        original_row={"id": external_id, "file_location": f"local:///tmp/{external_id}.wav"},
        pii_annotations=[],
    )
    db_session.add(task)
    return task


def test_admin_can_list_and_create_users(client, auth_headers):
    list_response = client.get("/api/v1/users", headers=auth_headers["admin"])
    assert list_response.status_code == 200
    assert len(list_response.json()["items"]) >= 3
    assert {
        "last_login_at",
        "last_activity_at",
        "assigned_task_count",
        "open_assigned_task_count",
        "completed_task_count",
        "approved_task_count",
        "assignment_load",
    }.issubset(list_response.json()["items"][0].keys())

    create_response = client.post(
        "/api/v1/users",
        headers=auth_headers["admin"],
        json={
            "email": "new.annotator@test.com",
            "full_name": "New Annotator",
            "role": "ANNOTATOR",
            "password": "StrongPass@123",
            "is_active": True,
        },
    )
    assert create_response.status_code == 200
    payload = create_response.json()
    assert payload["email"] == "new.annotator@test.com"
    assert payload["role"] == "ANNOTATOR"
    assert payload["is_active"] is True


def test_non_admin_cannot_manage_users(client, auth_headers):
    denied_list = client.get("/api/v1/users", headers=auth_headers["annotator"])
    assert denied_list.status_code == 403

    denied_create = client.post(
        "/api/v1/users",
        headers=auth_headers["reviewer"],
        json={
            "email": "blocked.user@test.com",
            "full_name": "Blocked User",
            "role": "ANNOTATOR",
            "password": "StrongPass@123",
        },
    )
    assert denied_create.status_code == 403


def test_admin_can_filter_users_by_search_role_and_status(client, auth_headers, db_session, seed_users):
    seed_users["reviewer"].is_active = False
    db_session.commit()

    role_response = client.get("/api/v1/users?role=ANNOTATOR", headers=auth_headers["admin"])
    assert role_response.status_code == 200
    assert [item["email"] for item in role_response.json()["items"]] == ["annotator@test.com"]

    status_response = client.get("/api/v1/users?status=inactive", headers=auth_headers["admin"])
    assert status_response.status_code == 200
    assert [item["email"] for item in status_response.json()["items"]] == ["reviewer@test.com"]

    search_response = client.get("/api/v1/users?search=admin%40test", headers=auth_headers["admin"])
    assert search_response.status_code == 200
    assert [item["email"] for item in search_response.json()["items"]] == ["admin@test.com"]


def test_user_admin_response_includes_real_assignment_counts(client, auth_headers, db_session, seed_users):
    upload_job = _create_upload_job(db_session, seed_users["admin"])
    _create_task(
        db_session,
        upload_job,
        external_id="OPEN-001",
        assignee_id=seed_users["annotator"].id,
        status=TaskStatusEnum.IN_PROGRESS,
    )
    _create_task(
        db_session,
        upload_job,
        external_id="DONE-001",
        assignee_id=seed_users["annotator"].id,
        status=TaskStatusEnum.APPROVED,
    )
    _create_task(
        db_session,
        upload_job,
        external_id="REVIEW-001",
        assignee_id=seed_users["reviewer"].id,
        status=TaskStatusEnum.NEEDS_REVIEW,
    )
    db_session.commit()

    response = client.get("/api/v1/users?role=ANNOTATOR", headers=auth_headers["admin"])
    assert response.status_code == 200
    annotator = response.json()["items"][0]
    assert annotator["email"] == "annotator@test.com"
    assert annotator["assigned_task_count"] == 2
    assert annotator["open_assigned_task_count"] == 1
    assert annotator["completed_task_count"] == 1
    assert annotator["approved_task_count"] == 1
    assert annotator["assignment_load"] == "light"


def test_admin_can_activate_deactivate_edit_role_and_reset_password(client, auth_headers):
    create_response = client.post(
        "/api/v1/users",
        headers=auth_headers["admin"],
        json={
            "email": "mutable.user@test.com",
            "full_name": "Mutable User",
            "role": "ANNOTATOR",
            "password": "OldPass@123",
            "is_active": True,
        },
    )
    assert create_response.status_code == 200
    user_id = create_response.json()["id"]

    update_response = client.patch(
        f"/api/v1/users/{user_id}",
        headers=auth_headers["admin"],
        json={"role": "REVIEWER", "is_active": False},
    )
    assert update_response.status_code == 200
    assert update_response.json()["role"] == "REVIEWER"
    assert update_response.json()["is_active"] is False

    inactive_login = client.post(
        "/api/v1/auth/login",
        json={"email": "mutable.user@test.com", "password": "OldPass@123"},
    )
    assert inactive_login.status_code == 403

    reset_response = client.post(
        f"/api/v1/users/{user_id}/reset-password",
        headers=auth_headers["admin"],
        json={"password": "NewPass@123"},
    )
    assert reset_response.status_code == 200

    reactivate_response = client.patch(
        f"/api/v1/users/{user_id}",
        headers=auth_headers["admin"],
        json={"is_active": True},
    )
    assert reactivate_response.status_code == 200

    old_password_login = client.post(
        "/api/v1/auth/login",
        json={"email": "mutable.user@test.com", "password": "OldPass@123"},
    )
    assert old_password_login.status_code == 401

    new_password_login = client.post(
        "/api/v1/auth/login",
        json={"email": "mutable.user@test.com", "password": "NewPass@123"},
    )
    assert new_password_login.status_code == 200


def test_admin_cannot_deactivate_or_demote_self(client, auth_headers, seed_users):
    admin_id = seed_users["admin"].id

    deactivate_response = client.patch(
        f"/api/v1/users/{admin_id}",
        headers=auth_headers["admin"],
        json={"is_active": False},
    )
    assert deactivate_response.status_code == 400

    demote_response = client.patch(
        f"/api/v1/users/{admin_id}",
        headers=auth_headers["admin"],
        json={"role": "ANNOTATOR"},
    )
    assert demote_response.status_code == 400


def test_login_and_authenticated_requests_update_user_activity(client, auth_headers, db_session, seed_users):
    annotator = seed_users["annotator"]
    db_session.refresh(annotator)
    assert annotator.last_login_at is not None
    assert annotator.last_activity_at is not None

    stale_activity = datetime.now(timezone.utc) - timedelta(days=3)
    annotator.last_activity_at = stale_activity
    db_session.commit()

    response = client.get("/api/v1/auth/me", headers=auth_headers["annotator"])
    assert response.status_code == 200

    db_session.refresh(annotator)
    refreshed_activity = annotator.last_activity_at
    if refreshed_activity.tzinfo is None:
        refreshed_activity = refreshed_activity.replace(tzinfo=timezone.utc)
    assert refreshed_activity > stale_activity
