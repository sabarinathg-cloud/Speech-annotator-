from __future__ import annotations

import argparse
import copy
import json
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.enums import RoleEnum, TaskStatusEnum
from app.models.organization import Organization, OrganizationMembership
from app.models.task import AnnotationTask, TaskStatusHistory
from app.models.user import User
from app.repositories.task_repository import TaskRepository

DONE_STATUSES = {
    TaskStatusEnum.COMPLETED,
    TaskStatusEnum.NEEDS_REVIEW,
    TaskStatusEnum.REVIEWED,
    TaskStatusEnum.APPROVED,
}


@dataclass
class SyncOptions:
    source_org: str
    dest_org: str
    actor_email: str | None = None
    match_key: str = "audio-path"
    source_prefix: str | None = None
    dest_prefix: str | None = None
    apply: bool = False
    overwrite_worked: bool = False
    done_status_only: bool = False
    strict_source_duplicates: bool = False
    skip_status: bool = False
    skip_metadata: bool = False
    skip_pii: bool = False
    limit: int | None = None
    sample_limit: int = 10


@dataclass
class SyncResult:
    source_org_id: str
    source_org_name: str
    dest_org_id: str
    dest_org_name: str
    dry_run: bool
    match_key: str
    source_candidates: int = 0
    destination_tasks: int = 0
    matched_destination_tasks: int = 0
    copied: int = 0
    would_copy: int = 0
    skipped_no_source: int = 0
    skipped_source_duplicate: int = 0
    source_duplicates_resolved: int = 0
    skipped_destination_worked: int = 0
    skipped_no_changes: int = 0
    last_tagger_preserved: int = 0
    last_tagger_cleared: int = 0
    copied_samples: list[dict[str, Any]] = field(default_factory=list)
    skipped_samples: list[dict[str, Any]] = field(default_factory=list)


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


def resolve_actor(session: Session, actor_email: str | None) -> User:
    stmt = select(User).where(User.is_active.is_(True))
    if actor_email:
        stmt = stmt.where(User.email == actor_email)
    else:
        stmt = stmt.where(User.role == RoleEnum.ADMIN).order_by(User.created_at.asc())
    actor = session.execute(stmt.limit(1)).scalar_one_or_none()
    if not actor:
        if actor_email:
            raise ValueError(f"Active actor user not found: {actor_email}")
        raise ValueError("No active admin user found. Pass --actor-email explicitly.")
    return actor


def _location_path(file_location: str) -> str:
    if file_location.startswith("local://"):
        return file_location.replace("local://", "", 1)
    return file_location


def _strip_prefix(value: str, prefix: str | None) -> str:
    if not prefix:
        return value
    normalized_prefix = prefix.rstrip("/")
    if value == normalized_prefix:
        return ""
    if value.startswith(normalized_prefix + "/"):
        return value[len(normalized_prefix) + 1 :]
    return value


def task_match_key(task: AnnotationTask, *, mode: str, prefix: str | None = None) -> str:
    if mode == "external-id":
        return task.external_id
    path = _location_path(task.file_location or "")
    path = _strip_prefix(path, prefix)
    if mode == "basename":
        return PurePosixPath(path).name
    if mode == "audio-path":
        return path
    raise ValueError(f"Unsupported match key: {mode}")


def task_is_copyable(task: AnnotationTask, *, done_status_only: bool) -> bool:
    if task.status in DONE_STATUSES:
        return True
    if done_status_only:
        return False
    return bool(task.last_tagger_id)


def destination_has_work(task: AnnotationTask) -> bool:
    return bool(task.last_tagger_id) or task.status != TaskStatusEnum.NOT_STARTED or task.version > 1


def _source_sort_key(task: AnnotationTask) -> tuple[int, datetime, int]:
    status_rank = {
        TaskStatusEnum.APPROVED: 50,
        TaskStatusEnum.REVIEWED: 40,
        TaskStatusEnum.NEEDS_REVIEW: 30,
        TaskStatusEnum.COMPLETED: 20,
        TaskStatusEnum.IN_PROGRESS: 10,
        TaskStatusEnum.REJECTED: 5,
        TaskStatusEnum.NOT_STARTED: 0,
    }.get(task.status, 0)
    updated_at = task.updated_at or task.created_at or datetime.min.replace(tzinfo=timezone.utc)
    text_score = 1 if (task.final_transcript or "").strip() else 0
    return status_rank, updated_at, text_score


def _eligible_last_tagger_ids(session: Session, dest_org_id: str) -> set[str]:
    admin_ids = set(session.execute(select(User.id).where(User.role == RoleEnum.ADMIN)).scalars().all())
    member_ids = set(
        session.execute(
            select(OrganizationMembership.user_id)
            .where(OrganizationMembership.organization_id == dest_org_id)
            .where(OrganizationMembership.is_active.is_(True))
        )
        .scalars()
        .all()
    )
    return admin_ids | member_ids


def _load_source_tasks(session: Session, source_org_id: str, *, done_status_only: bool) -> list[AnnotationTask]:
    tasks = list(
        session.execute(
            select(AnnotationTask)
            .where(AnnotationTask.organization_id == source_org_id)
            .order_by(AnnotationTask.file_location.asc(), AnnotationTask.updated_at.desc())
        )
        .scalars()
        .all()
    )
    return [task for task in tasks if task_is_copyable(task, done_status_only=done_status_only)]


def _load_dest_tasks(session: Session, dest_org_id: str, limit: int | None) -> list[AnnotationTask]:
    stmt = (
        select(AnnotationTask)
        .where(AnnotationTask.organization_id == dest_org_id)
        .order_by(AnnotationTask.file_location.asc(), AnnotationTask.external_id.asc(), AnnotationTask.id.asc())
    )
    if limit:
        stmt = stmt.limit(limit)
    return list(session.execute(stmt).scalars().all())


def _build_source_index(
    source_tasks: list[AnnotationTask],
    *,
    options: SyncOptions,
    result: SyncResult,
) -> dict[str, AnnotationTask]:
    by_key: dict[str, list[AnnotationTask]] = defaultdict(list)
    for task in source_tasks:
        by_key[
            task_match_key(task, mode=options.match_key, prefix=options.source_prefix)
        ].append(task)

    index: dict[str, AnnotationTask] = {}
    for key, tasks in by_key.items():
        if len(tasks) == 1:
            index[key] = tasks[0]
            continue
        if options.strict_source_duplicates:
            result.skipped_source_duplicate += len(tasks)
            continue
        result.source_duplicates_resolved += len(tasks) - 1
        index[key] = sorted(tasks, key=_source_sort_key, reverse=True)[0]
    return index


def _copy_fields(
    *,
    source: AnnotationTask,
    dest: AnnotationTask,
    actor: User,
    dest_org: Organization,
    eligible_last_tagger_ids: set[str],
    options: SyncOptions,
    result: SyncResult,
) -> dict[str, Any]:
    previous: dict[str, Any] = {}
    new_values: dict[str, Any] = {}

    fields: list[str] = ["final_transcript", "notes"]
    if not options.skip_metadata and dest_org.metadata_enabled:
        fields.extend(["speaker_gender", "speaker_role", "language", "channel", "duration_seconds", "custom_metadata"])
    if not options.skip_pii and dest_org.pii_enabled:
        fields.append("pii_annotations")

    for field_name in fields:
        source_value = copy.deepcopy(getattr(source, field_name))
        if getattr(dest, field_name) == source_value:
            continue
        previous[field_name] = copy.deepcopy(getattr(dest, field_name))
        new_values[field_name] = source_value
        if options.apply:
            setattr(dest, field_name, source_value)

    if not options.skip_status and dest.status != source.status:
        previous["status"] = dest.status.value
        new_values["status"] = source.status.value
        if options.apply:
            dest.status = source.status

    if source.last_tagger_id and source.last_tagger_id in eligible_last_tagger_ids:
        if dest.last_tagger_id != source.last_tagger_id:
            previous["last_tagger_id"] = dest.last_tagger_id
            new_values["last_tagger_id"] = source.last_tagger_id
            if options.apply:
                dest.last_tagger_id = source.last_tagger_id
        result.last_tagger_preserved += 1
    elif source.last_tagger_id:
        result.last_tagger_cleared += 1

    if not new_values:
        return {}

    if options.apply:
        dest.version += 1
        dest.last_saved_at = datetime.now(timezone.utc)

    audit_values = {
        **new_values,
        "source_task_id": source.id,
        "source_external_id": source.external_id,
        "source_organization_id": source.organization_id,
        "sync_actor_id": actor.id,
        "sync_actor_email": actor.email,
    }
    return {"previous": previous, "new": audit_values}


def sync_annotations(session: Session, options: SyncOptions) -> SyncResult:
    if options.source_org == options.dest_org:
        raise ValueError("Source and destination organization must be different.")

    source_org = resolve_organization(session, options.source_org)
    dest_org = resolve_organization(session, options.dest_org)
    if source_org.id == dest_org.id:
        raise ValueError("Source and destination organization must be different.")

    actor = resolve_actor(session, options.actor_email)
    eligible_last_tagger_ids = _eligible_last_tagger_ids(session, dest_org.id)
    task_repo = TaskRepository(session)

    result = SyncResult(
        source_org_id=source_org.id,
        source_org_name=source_org.name,
        dest_org_id=dest_org.id,
        dest_org_name=dest_org.name,
        dry_run=not options.apply,
        match_key=options.match_key,
    )

    source_tasks = _load_source_tasks(session, source_org.id, done_status_only=options.done_status_only)
    result.source_candidates = len(source_tasks)
    source_index = _build_source_index(source_tasks, options=options, result=result)

    dest_tasks = _load_dest_tasks(session, dest_org.id, options.limit)
    result.destination_tasks = len(dest_tasks)

    for dest in dest_tasks:
        key = task_match_key(dest, mode=options.match_key, prefix=options.dest_prefix)
        source = source_index.get(key)
        if not source:
            result.skipped_no_source += 1
            if len(result.skipped_samples) < options.sample_limit:
                result.skipped_samples.append(
                    {"dest_task_id": dest.id, "external_id": dest.external_id, "reason": "no matching source task", "key": key}
                )
            continue
        result.matched_destination_tasks += 1

        if destination_has_work(dest) and not options.overwrite_worked:
            result.skipped_destination_worked += 1
            if len(result.skipped_samples) < options.sample_limit:
                result.skipped_samples.append(
                    {"dest_task_id": dest.id, "external_id": dest.external_id, "reason": "destination already has work", "key": key}
                )
            continue

        changes = _copy_fields(
            source=source,
            dest=dest,
            actor=actor,
            dest_org=dest_org,
            eligible_last_tagger_ids=eligible_last_tagger_ids,
            options=options,
            result=result,
        )
        if not changes:
            result.skipped_no_changes += 1
            continue

        result.would_copy += 1
        if len(result.copied_samples) < options.sample_limit:
            result.copied_samples.append(
                {
                    "source_task_id": source.id,
                    "dest_task_id": dest.id,
                    "file_location": dest.file_location,
                    "source_status": source.status.value,
                    "dest_status": dest.status.value,
                }
            )

        if options.apply:
            task_repo.add_audit_log(
                task_id=dest.id,
                actor_user_id=actor.id,
                action="SYNC_FROM_ORGANIZATION",
                changed_fields={field_name: True for field_name in changes["previous"]},
                previous_values=changes["previous"],
                new_values=changes["new"],
            )
            if "status" in changes["previous"]:
                session.add(
                    TaskStatusHistory(
                        task_id=dest.id,
                        old_status=TaskStatusEnum(changes["previous"]["status"]),
                        new_status=dest.status,
                        changed_by_id=actor.id,
                        comment=f"Synced annotation data from organization {source_org.name}",
                    )
                )
            result.copied += 1

    if options.apply:
        session.commit()

    return result


def parse_args() -> SyncOptions:
    parser = argparse.ArgumentParser(
        description="Copy already-completed annotation data from one organization to another by matching audio files."
    )
    parser.add_argument("--source-org", required=True, help="Source organization id, slug, or exact name.")
    parser.add_argument("--dest-org", required=True, help="Destination organization id, slug, or exact name.")
    parser.add_argument("--actor-email", help="Admin/user email to attach to sync audit logs. Defaults to first active admin.")
    parser.add_argument(
        "--match-key",
        choices=["audio-path", "external-id", "basename"],
        default="audio-path",
        help="How to match tasks between organizations. Default: audio-path.",
    )
    parser.add_argument("--source-prefix", help="Optional path prefix to strip from source file_location before matching.")
    parser.add_argument("--dest-prefix", help="Optional path prefix to strip from destination file_location before matching.")
    parser.add_argument("--apply", action="store_true", help="Actually update the database. Omit for dry run.")
    parser.add_argument("--overwrite-worked", action="store_true", help="Overwrite destination tasks that already have work.")
    parser.add_argument("--done-status-only", action="store_true", help="Only copy source tasks in completed/review statuses.")
    parser.add_argument("--strict-source-duplicates", action="store_true", help="Skip source keys with multiple candidates.")
    parser.add_argument("--skip-status", action="store_true", help="Copy content but leave destination status unchanged.")
    parser.add_argument("--skip-metadata", action="store_true", help="Do not copy metadata fields.")
    parser.add_argument("--skip-pii", action="store_true", help="Do not copy PII annotations.")
    parser.add_argument("--limit", type=int, help="Limit destination tasks processed, useful for testing.")
    parser.add_argument("--sample-limit", type=int, default=10, help="Number of sample rows to print.")
    args = parser.parse_args()
    return SyncOptions(**vars(args))


def main() -> None:
    options = parse_args()
    session = SessionLocal()
    try:
        result = sync_annotations(session, options)
        print(json.dumps(asdict(result), indent=2, default=str))
        if not options.apply:
            print("\nDry run only. Re-run with --apply to update destination tasks.")
    finally:
        session.close()


if __name__ == "__main__":
    main()
