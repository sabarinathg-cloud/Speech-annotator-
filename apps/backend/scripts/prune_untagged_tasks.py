from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any, Iterable
from urllib.parse import urlparse

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session, joinedload

from app.core.database import SessionLocal
from app.models.activity import UserActivityEntry
from app.models.enums import RoleEnum, TaskStatusEnum
from app.models.organization import Organization
from app.models.security import SecurityAuditEvent
from app.models.task import AnnotationTask, TaskAuditLog, TaskStatusHistory, TaskTranscriptVariant
from app.models.user import User
from app.services.audio_group_service import audio_group_info


DEFAULT_PRUNE_STATUSES = {TaskStatusEnum.NOT_STARTED}


@dataclass
class PruneOptions:
    org: str
    actor_email: str | None = None
    assignee_email: str | None = None
    upload_job_id: str | None = None
    statuses: set[TaskStatusEnum] = field(default_factory=lambda: set(DEFAULT_PRUNE_STATUSES))
    apply: bool = False
    limit: int | None = None
    sample_limit: int = 10


@dataclass
class PruneResult:
    organization_id: str
    organization_name: str
    dry_run: bool
    statuses: list[str]
    assignee_email: str | None
    upload_job_id: str | None
    candidate_count: int = 0
    deleted_count: int = 0
    would_delete_count: int = 0
    kept_tagged_or_started_count: int = 0
    kept_callmate_count: int = 0
    candidates_by_assignee: dict[str, int] = field(default_factory=dict)
    samples: list[dict[str, Any]] = field(default_factory=list)


def resolve_organization(session: Session, value: str) -> Organization:
    organizations = session.execute(
        select(Organization)
        .where(or_(Organization.id == value, Organization.slug == value, Organization.name == value))
        .order_by(Organization.name.asc())
        .limit(2)
    ).scalars().all()
    if not organizations:
        raise ValueError(f"Organization not found: {value}")
    if len(organizations) > 1:
        names = ", ".join(f"{item.name} ({item.id})" for item in organizations)
        raise ValueError(f"Organization value is ambiguous: {value}. Matches: {names}")
    return organizations[0]


def resolve_user(session: Session, email: str, *, active_only: bool = True) -> User:
    stmt = select(User).where(User.email == email)
    if active_only:
        stmt = stmt.where(User.is_active.is_(True))
    user = session.execute(stmt.limit(1)).scalar_one_or_none()
    if not user:
        active_label = "active " if active_only else ""
        raise ValueError(f"{active_label}user not found: {email}")
    return user


def resolve_actor(session: Session, actor_email: str | None) -> User | None:
    if actor_email:
        actor = resolve_user(session, actor_email)
        if actor.role != RoleEnum.ADMIN:
            raise ValueError(f"Actor must be an admin user: {actor_email}")
        return actor
    return session.execute(
        select(User).where(User.role == RoleEnum.ADMIN, User.is_active.is_(True)).order_by(User.created_at.asc()).limit(1)
    ).scalar_one_or_none()


def _base_org_task_stmt(organization_id: str):
    return select(AnnotationTask).where(AnnotationTask.organization_id == organization_id)


def _candidate_stmt(
    *,
    organization_id: str,
    statuses: set[TaskStatusEnum],
    assignee_id: str | None,
    upload_job_id: str | None,
):
    stmt = (
        _base_org_task_stmt(organization_id)
        .options(joinedload(AnnotationTask.assignee))
        .where(AnnotationTask.status.in_(statuses))
        .where(AnnotationTask.last_tagger_id.is_(None))
        .order_by(AnnotationTask.updated_at.asc(), AnnotationTask.id.asc())
    )
    if assignee_id:
        stmt = stmt.where(AnnotationTask.assignee_id == assignee_id)
    if upload_job_id:
        stmt = stmt.where(AnnotationTask.upload_job_id == upload_job_id)
    return stmt


def _scoped_task_rows_stmt(*, organization_id: str, upload_job_id: str | None):
    stmt = select(
        AnnotationTask.original_row,
        AnnotationTask.file_location,
        AnnotationTask.external_id,
        AnnotationTask.status,
        AnnotationTask.last_tagger_id,
    ).where(AnnotationTask.organization_id == organization_id)
    if upload_job_id:
        stmt = stmt.where(AnnotationTask.upload_job_id == upload_job_id)
    return stmt


def _row_call_key(*, original_row: Any, file_location: str, external_id: str, call_id_column: str = "call_id") -> str:
    row = original_row if isinstance(original_row, dict) else {}
    candidate_keys = [call_id_column, "call_id", "file_id", "source_path_abs"]
    seen_keys: set[str] = set()
    for key in candidate_keys:
        if not key or key in seen_keys:
            continue
        seen_keys.add(key)
        value = row.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text

    path_text = str(row.get("segment_audio_path_abs") or row.get("audio") or file_location or "").strip()
    path_group = _path_call_key(path_text)
    if path_group:
        return path_group

    info = audio_group_info(file_location)
    if info and info.chunk_index is not None:
        return info.group_key
    return file_location or external_id


def _task_call_key(task: AnnotationTask) -> str:
    return _row_call_key(
        original_row=task.original_row,
        file_location=task.file_location,
        external_id=task.external_id,
    )


def _path_call_key(file_location: str) -> str | None:
    if not file_location:
        return None
    prefix = ""
    path_text = file_location
    if file_location.startswith("local://"):
        prefix = "local://"
        path_text = file_location.replace("local://", "", 1)
    elif file_location.startswith("s3://"):
        parsed = urlparse(file_location)
        prefix = f"s3://{parsed.netloc}/"
        path_text = parsed.path.lstrip("/")

    path = PurePosixPath(path_text)
    parent = path.parent
    if not str(parent) or str(parent) == ".":
        return None
    info = audio_group_info(file_location)
    if not info or info.chunk_index is None:
        return None
    if parent.name.lower().startswith("channel") and str(parent.parent) and str(parent.parent) != ".":
        return f"{prefix}{parent.parent}"
    return info.group_key


def _load_protected_call_keys(
    session: Session,
    *,
    organization_id: str,
    statuses: set[TaskStatusEnum],
    upload_job_id: str | None,
) -> set[str]:
    protected: set[str] = set()
    rows = session.execute(_scoped_task_rows_stmt(organization_id=organization_id, upload_job_id=upload_job_id)).all()
    for original_row, file_location, external_id, status, last_tagger_id in rows:
        if status in statuses and last_tagger_id is None:
            continue
        protected.add(
            _row_call_key(
                original_row=original_row,
                file_location=file_location,
                external_id=external_id,
            )
        )
    return protected


def _count_kept_tagged_or_started(
    session: Session,
    *,
    organization_id: str,
    statuses: set[TaskStatusEnum],
    assignee_id: str | None,
    upload_job_id: str | None,
) -> int:
    stmt = select(func.count()).select_from(AnnotationTask).where(AnnotationTask.organization_id == organization_id)
    stmt = stmt.where(or_(AnnotationTask.status.notin_(statuses), AnnotationTask.last_tagger_id.is_not(None)))
    if assignee_id:
        stmt = stmt.where(AnnotationTask.assignee_id == assignee_id)
    if upload_job_id:
        stmt = stmt.where(AnnotationTask.upload_job_id == upload_job_id)
    return int(session.execute(stmt).scalar_one() or 0)


def _batched(values: list[str], size: int = 1000) -> Iterable[list[str]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def run_prune(session: Session, options: PruneOptions) -> PruneResult:
    organization = resolve_organization(session, options.org)
    actor = resolve_actor(session, options.actor_email)
    assignee = resolve_user(session, options.assignee_email) if options.assignee_email else None
    if not options.statuses:
        raise ValueError("At least one status must be selected for pruning.")

    candidate_stmt = _candidate_stmt(
        organization_id=organization.id,
        statuses=options.statuses,
        assignee_id=assignee.id if assignee else None,
        upload_job_id=options.upload_job_id,
    )

    protected_call_keys = _load_protected_call_keys(
        session,
        organization_id=organization.id,
        statuses=options.statuses,
        upload_job_id=options.upload_job_id,
    )
    all_candidate_tasks = session.execute(candidate_stmt).unique().scalars().all()
    tasks: list[AnnotationTask] = []
    kept_callmate_count = 0
    for task in all_candidate_tasks:
        if _task_call_key(task) in protected_call_keys:
            kept_callmate_count += 1
            continue
        tasks.append(task)
        if options.limit and len(tasks) >= options.limit:
            break

    result = PruneResult(
        organization_id=organization.id,
        organization_name=organization.name,
        dry_run=not options.apply,
        statuses=sorted(status.value for status in options.statuses),
        assignee_email=assignee.email if assignee else None,
        upload_job_id=options.upload_job_id,
        candidate_count=len(tasks),
        kept_callmate_count=kept_callmate_count,
        kept_tagged_or_started_count=_count_kept_tagged_or_started(
            session,
            organization_id=organization.id,
            statuses=options.statuses,
            assignee_id=assignee.id if assignee else None,
            upload_job_id=options.upload_job_id,
        ),
    )

    task_ids = [task.id for task in tasks]
    for task in tasks:
        assignee_label = task.assignee.email if task.assignee else "unassigned"
        result.candidates_by_assignee[assignee_label] = result.candidates_by_assignee.get(assignee_label, 0) + 1
        if len(result.samples) < options.sample_limit:
            result.samples.append(
                {
                    "task_id": task.id,
                    "external_id": task.external_id,
                    "status": task.status.value,
                    "assignee_email": task.assignee.email if task.assignee else None,
                    "file_location": task.file_location,
                }
            )

    if not options.apply:
        result.would_delete_count = len(task_ids)
        return result

    for batch in _batched(task_ids):
        session.execute(update(UserActivityEntry).where(UserActivityEntry.task_id.in_(batch)).values(task_id=None))
        session.execute(update(SecurityAuditEvent).where(SecurityAuditEvent.task_id.in_(batch)).values(task_id=None))
        session.execute(delete(TaskTranscriptVariant).where(TaskTranscriptVariant.task_id.in_(batch)))
        session.execute(delete(TaskStatusHistory).where(TaskStatusHistory.task_id.in_(batch)))
        session.execute(delete(TaskAuditLog).where(TaskAuditLog.task_id.in_(batch)))
        session.execute(delete(AnnotationTask).where(AnnotationTask.id.in_(batch)))
        result.deleted_count += len(batch)

    if actor:
        session.add(
            SecurityAuditEvent(
                organization_id=organization.id,
                actor_user_id=actor.id,
                actor_email=actor.email,
                actor_role=actor.role.value,
                action="PRUNE_UNTAGGED_TASKS",
                risk_level="medium",
                resource_type="organization",
                resource_id=organization.id,
                event_metadata={
                    "deleted_count": result.deleted_count,
                    "statuses": result.statuses,
                    "assignee_email": result.assignee_email,
                    "upload_job_id": result.upload_job_id,
                    "candidate_count": result.candidate_count,
                    "kept_tagged_or_started_count": result.kept_tagged_or_started_count,
                    "kept_callmate_count": result.kept_callmate_count,
                    "ran_at": datetime.now(timezone.utc).isoformat(),
                },
            )
        )

    session.commit()
    return result


def _parse_statuses(values: list[str]) -> set[TaskStatusEnum]:
    if not values:
        return set(DEFAULT_PRUNE_STATUSES)
    return {TaskStatusEnum(value) for value in values}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Delete untouched/unworked annotation tasks while keeping tagged or started tasks."
    )
    parser.add_argument("--org", required=True, help="Organization id, slug, or name.")
    parser.add_argument("--actor-email", help="Admin actor email for the security audit event.")
    parser.add_argument("--assignee-email", help="Optional safety filter for tasks currently assigned to one user.")
    parser.add_argument("--upload-job-id", help="Optional safety filter for one upload job.")
    parser.add_argument(
        "--status",
        dest="statuses",
        action="append",
        choices=[status.value for status in TaskStatusEnum],
        default=[],
        help="Status to prune. Repeat for multiple values. Defaults to Not Started only.",
    )
    parser.add_argument("--limit", type=int, help="Optional maximum tasks to inspect/delete.")
    parser.add_argument("--sample-limit", type=int, default=10, help="Number of sample rows to print.")
    parser.add_argument("--apply", action="store_true", help="Actually delete tasks. Without this, dry-run only.")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    options = PruneOptions(
        org=args.org,
        actor_email=args.actor_email,
        assignee_email=args.assignee_email,
        upload_job_id=args.upload_job_id,
        statuses=_parse_statuses(args.statuses),
        apply=args.apply,
        limit=args.limit,
        sample_limit=args.sample_limit,
    )
    with SessionLocal() as session:
        result = run_prune(session, options)
    print(json.dumps(asdict(result), indent=2, default=str))
    if not options.apply:
        print("\nDry run only. Re-run with --apply to delete matching untagged tasks.")


if __name__ == "__main__":
    main()
