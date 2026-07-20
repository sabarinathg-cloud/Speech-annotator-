from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.enums import RoleEnum, TaskStatusEnum
from app.models.organization import OrganizationMembership
from app.models.task import AnnotationTask
from app.models.user import User


class UserRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_by_email(self, email: str) -> User | None:
        stmt = select(User).where(User.email == email.lower())
        return self.db.execute(stmt).scalar_one_or_none()

    def get_by_id(self, user_id: str) -> User | None:
        return self.db.get(User, user_id)

    def list_users(
        self,
        *,
        search: str | None = None,
        role: RoleEnum | None = None,
        is_active: bool | None = None,
        organization_id: str | None = None,
    ) -> list[User]:
        stmt = select(User).order_by(User.full_name.asc())
        if organization_id:
            stmt = (
                stmt.outerjoin(
                    OrganizationMembership,
                    (OrganizationMembership.user_id == User.id)
                    & (OrganizationMembership.organization_id == organization_id)
                    & (OrganizationMembership.is_active.is_(True)),
                )
                .where(or_(User.role == RoleEnum.ADMIN, OrganizationMembership.id.is_not(None)))
            )
        if search:
            pattern = f"%{search.lower()}%"
            stmt = stmt.where((User.email.ilike(pattern)) | (User.full_name.ilike(pattern)))
        if role is not None:
            stmt = stmt.where(User.role == role)
        if is_active is not None:
            stmt = stmt.where(User.is_active == is_active)
        return list(self.db.execute(stmt).scalars().all())

    def assignment_counts_by_user(
        self,
        user_ids: list[str],
        *,
        organization_id: str | None = None,
    ) -> dict[str, dict[str, int]]:
        if not user_ids:
            return {}
        stmt = select(AnnotationTask.assignee_id, AnnotationTask.status).where(
            AnnotationTask.assignee_id.in_(user_ids)
        )
        if organization_id:
            stmt = stmt.where(AnnotationTask.organization_id == organization_id)
        counts = {
            user_id: {
                "assigned_task_count": 0,
                "open_assigned_task_count": 0,
                "completed_task_count": 0,
                "approved_task_count": 0,
            }
            for user_id in user_ids
        }
        for assignee_id, status in self.db.execute(stmt).all():
            if assignee_id not in counts:
                continue
            counts[assignee_id]["assigned_task_count"] += 1
            if status != TaskStatusEnum.APPROVED:
                counts[assignee_id]["open_assigned_task_count"] += 1
            if status in {
                TaskStatusEnum.COMPLETED,
                TaskStatusEnum.NEEDS_REVIEW,
                TaskStatusEnum.REVIEWED,
                TaskStatusEnum.APPROVED,
            }:
                counts[assignee_id]["completed_task_count"] += 1
            if status == TaskStatusEnum.APPROVED:
                counts[assignee_id]["approved_task_count"] += 1
        return counts

    def create(self, *, email: str, full_name: str, password_hash: str, role: str) -> User:
        user = User(email=email.lower(), full_name=full_name, password_hash=password_hash, role=role)
        self.db.add(user)
        self.db.flush()
        return user
