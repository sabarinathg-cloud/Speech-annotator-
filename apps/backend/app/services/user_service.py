from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.enums import RoleEnum
from app.models.user import User
from app.repositories.user_repository import UserRepository
from app.schemas.user import UserAdminResponse, UserListResponse
from app.services.errors import ServiceError


class UserService:
    def __init__(self, db: Session):
        self.db = db
        self.user_repo = UserRepository(db)

    def list_users(
        self,
        *,
        search: str | None = None,
        role: RoleEnum | None = None,
        is_active: bool | None = None,
    ) -> UserListResponse:
        users = self.user_repo.list_users(search=search, role=role, is_active=is_active)
        counts_by_user = self.user_repo.assignment_counts_by_user([user.id for user in users])
        return UserListResponse(
            items=[
                self._build_admin_response(user, counts_by_user.get(user.id))
                for user in users
            ]
        )

    def create_user(
        self,
        *,
        email: str,
        full_name: str,
        password: str,
        role: RoleEnum,
        is_active: bool,
    ) -> UserAdminResponse:
        existing = self.user_repo.get_by_email(email)
        if existing:
            raise ServiceError("User with this email already exists", status_code=409)

        user = self.user_repo.create(
            email=email,
            full_name=full_name.strip(),
            password_hash=get_password_hash(password),
            role=role,
        )
        user.is_active = is_active
        self.db.commit()
        self.db.refresh(user)
        return self._build_admin_response(user)

    def update_user(
        self,
        *,
        user_id: str,
        actor_user_id: str,
        full_name: str | None,
        password: str | None,
        role: RoleEnum | None,
        is_active: bool | None,
    ) -> UserAdminResponse:
        user = self.user_repo.get_by_id(user_id)
        if not user:
            raise ServiceError("User not found", status_code=404)
        self._guard_self_admin_update(
            user_id=user_id,
            actor_user_id=actor_user_id,
            role=role,
            is_active=is_active,
        )

        if full_name is not None:
            user.full_name = full_name.strip()
        if role is not None:
            user.role = role
        if password is not None:
            user.password_hash = get_password_hash(password)
        if is_active is not None:
            user.is_active = is_active
            if not is_active:
                user.active_session_id = None
                user.confidentiality_acknowledged_session_id = None

        self.db.commit()
        self.db.refresh(user)
        return self._build_admin_response(user)

    def deactivate_user(self, *, user_id: str, actor_user_id: str) -> UserAdminResponse:
        user = self.user_repo.get_by_id(user_id)
        if not user:
            raise ServiceError("User not found", status_code=404)
        self._guard_self_admin_update(
            user_id=user_id,
            actor_user_id=actor_user_id,
            role=None,
            is_active=False,
        )
        user.is_active = False
        user.active_session_id = None
        user.confidentiality_acknowledged_session_id = None
        self.db.commit()
        self.db.refresh(user)
        return self._build_admin_response(user)

    def reset_password(
        self,
        *,
        user_id: str,
        password: str,
    ) -> UserAdminResponse:
        user = self.user_repo.get_by_id(user_id)
        if not user:
            raise ServiceError("User not found", status_code=404)
        user.password_hash = get_password_hash(password)
        self.db.commit()
        self.db.refresh(user)
        return self._build_admin_response(user)

    def _build_admin_response(self, user: User, counts: dict[str, int] | None = None) -> UserAdminResponse:
        counts = counts or {
            "assigned_task_count": 0,
            "open_assigned_task_count": 0,
            "completed_task_count": 0,
            "approved_task_count": 0,
        }
        open_count = counts["open_assigned_task_count"]
        if open_count == 0:
            load = "none"
        elif open_count <= 5:
            load = "light"
        elif open_count <= 15:
            load = "normal"
        else:
            load = "heavy"
        return UserAdminResponse.model_validate(user).model_copy(
            update={
                **counts,
                "assignment_load": load,
            }
        )

    def _guard_self_admin_update(
        self,
        *,
        user_id: str,
        actor_user_id: str,
        role: RoleEnum | None,
        is_active: bool | None,
    ) -> None:
        if user_id != actor_user_id:
            return
        if is_active is False:
            raise ServiceError("Admins cannot deactivate their own account", status_code=400)
        if role is not None and role != RoleEnum.ADMIN:
            raise ServiceError("Admins cannot remove their own admin role", status_code=400)
