from datetime import datetime, timezone

from sqlalchemy import func, select

from app.models.activity import UserActivityEntry
from app.models.hiring import HiringAssessment
from app.models.job import BackgroundJob
from app.models.organization import Organization, OrganizationMembership, OrganizationQuestionnaire
from app.models.pii_label import PIILabel
from app.models.security import SecurityAuditEvent
from app.models.task import AnnotationTask, TaskAudioGroupReview, TaskTranscriptVariant
from app.models.upload import UploadFile, UploadJob
from app.models.user import User


def test_admin_can_create_and_update_organization_instructions(client, auth_headers):
    instructions = "Listen fully before saving.\nUse commas, punctuation, and special characters when needed."
    create_response = client.post(
        "/api/v1/organizations",
        headers=auth_headers["admin"],
        json={
            "name": "Clinical QA",
            "slug": "clinical-qa",
            "instructions": instructions,
        },
    )

    assert create_response.status_code == 200
    organization = create_response.json()
    assert organization["instructions"] == instructions

    me_response = client.get("/api/v1/auth/me", headers=auth_headers["admin"])
    assert me_response.status_code == 200
    org_access = next(item for item in me_response.json()["organizations"] if item["id"] == organization["id"])
    assert org_access["settings"]["instructions"] == instructions

    update_response = client.patch(
        f"/api/v1/organizations/{organization['id']}",
        headers=auth_headers["admin"],
        json={"instructions": ""},
    )

    assert update_response.status_code == 200
    assert update_response.json()["instructions"] is None


def test_admin_can_save_rating_question_labels(client, auth_headers):
    organizations_response = client.get("/api/v1/organizations", headers=auth_headers["admin"])
    assert organizations_response.status_code == 200
    organization_id = organizations_response.json()["items"][0]["id"]

    payload = {
        "title": "Masking QA",
        "description": "Compare original and masked audio.",
        "is_active": True,
        "questions": [
            {
                "id": "mask_quality",
                "label": "Masking quality",
                "field_type": "rating",
                "help_text": "Score how natural the masked audio sounds.",
                "required": True,
                "options": ["Very bad", "Bad", "Acceptable", "Good", "Excellent"],
                "sort_order": 1,
                "scoring_key": "quality",
            }
        ],
    }

    save_response = client.put(
        f"/api/v1/organizations/{organization_id}/questionnaire",
        headers=auth_headers["admin"],
        json=payload,
    )

    assert save_response.status_code == 200
    question = save_response.json()["questions"][0]
    assert question["field_type"] == "rating"
    assert question["options"] == ["Very bad", "Bad", "Acceptable", "Good", "Excellent"]

    reload_response = client.get(
        f"/api/v1/organizations/{organization_id}/questionnaire",
        headers=auth_headers["admin"],
    )

    assert reload_response.status_code == 200
    assert reload_response.json()["questions"][0]["options"] == [
        "Very bad",
        "Bad",
        "Acceptable",
        "Good",
        "Excellent",
    ]


def test_admin_can_delete_organization_and_related_data(client, auth_headers, db_session):
    create_response = client.post(
        "/api/v1/organizations",
        headers=auth_headers["admin"],
        json={"name": "Delete Me", "slug": "delete-me", "pii_enabled": True, "hiring_enabled": True},
    )
    assert create_response.status_code == 200
    organization = create_response.json()
    admin = db_session.execute(select(User).where(User.email == "admin@test.com")).scalar_one()
    annotator = db_session.execute(select(User).where(User.email == "annotator@test.com")).scalar_one()

    upload_file = UploadFile(
        organization_id=organization["id"],
        original_filename="source.csv",
        stored_path="/tmp/source.csv",
        uploaded_by_id=admin.id,
    )
    db_session.add(upload_file)
    db_session.flush()
    upload_job = UploadJob(organization_id=organization["id"], upload_file_id=upload_file.id, created_by_id=admin.id)
    db_session.add(upload_job)
    db_session.flush()
    task = AnnotationTask(
        organization_id=organization["id"],
        upload_job_id=upload_job.id,
        external_id="task-1",
        file_location="/tmp/audio.wav",
        original_row={},
    )
    db_session.add(task)
    db_session.flush()
    db_session.add_all(
        [
            TaskTranscriptVariant(
                task_id=task.id,
                source_key="model",
                source_label="Model",
                transcript_text="hello",
            ),
            TaskAudioGroupReview(
                organization_id=organization["id"],
                upload_job_id=upload_job.id,
                group_key="call-1",
                group_hash="hash",
                assignment_scope_key="unassigned",
                transcript="hello",
            ),
            PIILabel(organization_id=organization["id"], key="person", display_name="Person"),
            OrganizationQuestionnaire(
                organization_id=organization["id"],
                title="QA",
                questions=[],
                is_active=True,
            ),
            OrganizationMembership(organization_id=organization["id"], user_id=annotator.id, is_active=True),
            BackgroundJob(
                organization_id=organization["id"],
                job_type="export",
                payload={},
                created_by_id=admin.id,
            ),
            SecurityAuditEvent(
                organization_id=organization["id"],
                actor_user_id=admin.id,
                actor_email=admin.email,
                actor_role=admin.role.value,
                action="TEST_EVENT",
                resource_type="organization",
            ),
            UserActivityEntry(
                organization_id=organization["id"],
                user_id=annotator.id,
                task_id=task.id,
                started_at=datetime.now(timezone.utc),
                ended_at=datetime.now(timezone.utc),
            ),
            HiringAssessment(
                organization_id=organization["id"],
                title="Hiring",
                instructions="",
                created_by_id=admin.id,
            ),
        ]
    )
    db_session.commit()

    wrong_response = client.delete(
        f"/api/v1/organizations/{organization['id']}?confirm_slug=wrong",
        headers=auth_headers["admin"],
    )
    assert wrong_response.status_code == 422

    delete_response = client.delete(
        f"/api/v1/organizations/{organization['id']}?confirm_slug=delete-me",
        headers=auth_headers["admin"],
    )
    assert delete_response.status_code == 200
    payload = delete_response.json()
    assert payload["deleted_organization_id"] == organization["id"]
    assert payload["deleted_counts"]["annotation_tasks"] == 1
    assert payload["deleted_counts"]["upload_jobs"] == 1
    assert payload["deleted_counts"]["hiring_assessments"] == 1
    assert db_session.get(Organization, organization["id"]) is None
    assert db_session.execute(
        select(func.count()).select_from(AnnotationTask).where(AnnotationTask.organization_id == organization["id"])
    ).scalar_one() == 0
    assert db_session.execute(
        select(func.count()).select_from(UploadJob).where(UploadJob.organization_id == organization["id"])
    ).scalar_one() == 0
    assert db_session.execute(select(func.count()).select_from(User).where(User.id == annotator.id)).scalar_one() == 1


def test_admin_cannot_delete_default_organization(client, auth_headers):
    organizations_response = client.get("/api/v1/organizations", headers=auth_headers["admin"])
    assert organizations_response.status_code == 200
    default_org = next(item for item in organizations_response.json()["items"] if item["slug"] == "default")

    delete_response = client.delete(
        f"/api/v1/organizations/{default_org['id']}?confirm_slug=default",
        headers=auth_headers["admin"],
    )

    assert delete_response.status_code == 422
    assert delete_response.json()["detail"]["message"] == "Default organization cannot be deleted"
