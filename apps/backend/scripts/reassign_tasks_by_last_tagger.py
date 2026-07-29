from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, joinedload

from app.core.database import SessionLocal
from app.models.enums import RoleEnum, TaskStatusEnum
from app.models.organization import Organization, OrganizationMembership
from app.models.task import AnnotationTask
from app.models.user import User
from app.repositories.task_repository import TaskRepository


DONE_STATUSES = {
    TaskStatusEnum.COMPLETED,
    TaskStatusEnum.NEEDS_REVIEW,
    TaskStatusEnum.REVIEWED,
    TaskStatusEnum.APPROVED,
}


@dataclass
class ReassignOptions:
    org: str
    last_tagger_email: str
    assignee_email: str
    actor_email: str | None = None
    current_assignee_email: str | None = None
    statuses: set[TaskStatusEnum] | None = field(default_factory=lambda: set(DONE_STATUSES))
    apply: bool = False
    limit: int | None = None
    sample_limit: int = 10


@dataclass
class ReassignResult:
    organization_id: str
    organization_name: str
    dry_run: bool
    last_tagger_email: str
    target_assignee_email: str
    current_assignee_email: str | None
    statuses: list[str] | None
    matched_count: int = 0
    reassigned: int = 0
    would_reassign: int = 0
    skipped_already_assigned: int = 0
    samples: list[dict[str, Any]] = field(default_factory=list)


def resolve_organization(session: Session, value: str) -> Organization:
    organization = session.execute(
        select(Organization)
        .where(or_(Organization.id == value, Organization.slug == value, Organization.name == value))
        .order_by(Organization.name.asc())
        .limit(2)
    ).scalars().all()
    if not organization:
        raise ValueError(f"Organization not found: {value}")
    if len(organization) > 1:
        names = ", ".join(f"{item.name} ({item.id})" for item in organization)
        raise ValueError(f"Organization value is ambiguous: {value}. Matches: {names}")
    return organization[0]


def resolve_user(session: Session, email: str, *, active_only: bool = True) -> User:
    stmt = select(User).where(User.email == email)
    if active_only:
        stmt = stmt.where(User.is_active.is_(True))
    user = session.execute(stmt.limit(1)).scalar_one_or_none()
    if not user:
        active_label = "active " if active_only else ""
        raise ValueError(f"{active_label}user not found: {email}")
    return user


def resolve_actor(session: Session, actor_email: str | None) -> User:
    if actor_email:
        actor = resolve_user(session, actor_email)
        if actor.role != RoleEnum.ADMIN:
            raise ValueError(f"Actor must be an admin user: {actor_email}")
        return actor
    actor = session.execute(
        select(User).where(User.role == RoleEnum.ADMIN, User.is_active.is_(True)).order_by(User.created_at.asc()).limit(1)
    ).scalar_one_or_none()
    if not actor:
        raise ValueError("No active admin user found. Pass --actor-email explicitly.")
    return actor


def user_can_receive_org_tasks(session: Session, user: User, organization_id: str) -> bool:
    if user.role == RoleEnum.ADMIN:
        return True
    membership_id = session.execute(
        select(OrganizationMembership.user_id)
        .where(OrganizationMembership.organization_id == organization_id)
        .where(OrganizationMembership.user_id == user.id)
        .where(OrganizationMembership.is_active.is_(True))
        .limit(1)
    ).scalar_one_or_none()
    return membership_id is not None


def run_reassignment(session: Session, options: ReassignOptions) -> ReassignResult:
    organization = resolve_organization(session, options.org)
    actor = resolve_actor(session, options.actor_email)
    last_tagger = resolve_user(session, options.last_tagger_email)
    target_assignee = resolve_user(session, options.assignee_email)
    current_assignee = resolve_user(session, options.current_assignee_email) if options.current_assignee_email else None

    if not user_can_receive_org_tasks(session, target_assignee, organization.id):
        raise ValueError(f"Target assignee is not an active member of organization {organization.name}: {target_assignee.email}")

    stmt = (
        select(AnnotationTask)
        .options(joinedload(AnnotationTask.assignee), joinedload(AnnotationTask.last_tagger))
        .where(AnnotationTask.organization_id == organization.id)
        .where(AnnotationTask.last_tagger_id == last_tagger.id)
        .order_by(AnnotationTask.updated_at.desc(), AnnotationTask.id.asc())
    )
    if current_assignee:
        stmt = stmt.where(AnnotationTask.assignee_id == current_assignee.id)
    if options.statuses:
        stmt = stmt.where(AnnotationTask.status.in_(options.statuses))
    if options.limit:
        stmt = stmt.limit(options.limit)

    tasks = session.execute(stmt).unique().scalars().all()
    result = ReassignResult(
        organization_id=organization.id,
        organization_name=organization.name,
        dry_run=not options.apply,
        last_tagger_email=last_tagger.email,
        target_assignee_email=target_assignee.email,
        current_assignee_email=current_assignee.email if current_assignee else None,
        statuses=sorted(status.value for status in options.statuses) if options.statuses else None,
        matched_count=len(tasks),
    )

    now = datetime.now(timezone.utc)
    audit_entries: list[dict[str, Any]] = []
    for task in tasks:
        if task.assignee_id == target_assignee.id:
            result.skipped_already_assigned += 1
            continue

        previous_assignee = task.assignee
        sample = {
            "task_id": task.id,
            "external_id": task.external_id,
            "status": task.status.value,
            "previous_assignee_email": previous_assignee.email if previous_assignee else None,
            "new_assignee_email": target_assignee.email,
            "last_tagger_email": last_tagger.email,
        }
        if len(result.samples) < options.sample_limit:
            result.samples.append(sample)

        if options.apply:
            audit_entries.append(
                {
                    "task_id": task.id,
                    "actor_user_id": actor.id,
                    "action": "REASSIGN_BY_LAST_TAGGER",
                    "changed_fields": {"assignee_id": True},
                    "previous_values": {
                        "assignee_id": task.assignee_id,
                        "assignee_name": previous_assignee.full_name if previous_assignee else None,
                        "assignee_email": previous_assignee.email if previous_assignee else None,
                    },
                    "new_values": {
                        "assignee_id": target_assignee.id,
                        "assignee_name": target_assignee.full_name,
                        "assignee_email": target_assignee.email,
                        "last_tagger_id": last_tagger.id,
                        "last_tagger_email": last_tagger.email,
                    },
                }
            )
            task.assignee_id = target_assignee.id
            task.version += 1
            task.last_saved_at = now
            task.updated_at = now
            result.reassigned += 1
        else:
            result.would_reassign += 1

    if options.apply:
        session.flush()
        TaskRepository(session).add_audit_logs(audit_entries)
        session.commit()
    return result


def _parse_statuses(values: list[str], *, include_all_statuses: bool) -> set[TaskStatusEnum] | None:
    if include_all_statuses:
        return None
    if not values:
        return set(DONE_STATUSES)
    return {TaskStatusEnum(value) for value in values}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Reassign tasks whose last saved/tagged user matches a specific annotator."
    )
    parser.add_argument("--org", required=True, help="Organization id, slug, or name.")
    parser.add_argument("--last-tagger-email", required=True, help="Only tasks last tagged by this user are considered.")
    parser.add_argument("--assignee-email", required=True, help="Assign matching tasks to this user.")
    parser.add_argument("--current-assignee-email", help="Optional safety filter for tasks currently assigned to this user.")
    parser.add_argument("--actor-email", help="Admin actor email for audit logs. Defaults to the first active admin.")
    parser.add_argument(
        "--status",
        dest="statuses",
        action="append",
        choices=[status.value for status in TaskStatusEnum],
        default=[],
        help="Status to include. Repeat for multiple values. Defaults to completed/review statuses.",
    )
    parser.add_argument(
        "--include-all-statuses",
        action="store_true",
        help="Include every task status instead of the default completed/review statuses.",
    )
    parser.add_argument("--limit", type=int, help="Optional maximum tasks to inspect/update.")
    parser.add_argument("--sample-limit", type=int, default=10, help="Number of sample rows to print.")
    parser.add_argument("--apply", action="store_true", help="Actually update the database. Without this, dry-run only.")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    options = ReassignOptions(
        org=args.org,
        last_tagger_email=args.last_tagger_email,
        assignee_email=args.assignee_email,
        actor_email=args.actor_email,
        current_assignee_email=args.current_assignee_email,
        statuses=_parse_statuses(args.statuses, include_all_statuses=args.include_all_statuses),
        apply=args.apply,
        limit=args.limit,
        sample_limit=args.sample_limit,
    )
    with SessionLocal() as session:
        result = run_reassignment(session, options)
    print(json.dumps(asdict(result), indent=2, default=str))
    if not options.apply:
        print("\nDry run only. Re-run with --apply to update matching tasks.")


if __name__ == "__main__":
    main()
