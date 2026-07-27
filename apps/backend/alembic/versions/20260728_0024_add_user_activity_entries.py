"""add user activity entries

Revision ID: 20260728_0024
Revises: 20260721_0023
Create Date: 2026-07-28 00:24:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260728_0024"
down_revision: str | None = "20260721_0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_activity_entries",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("task_id", sa.String(length=36), nullable=True),
        sa.Column("route", sa.Text(), nullable=True),
        sa.Column("active_seconds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("idle_seconds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("event_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["annotation_tasks.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_user_activity_entries_organization_task_started",
        "user_activity_entries",
        ["organization_id", "task_id", "started_at"],
        unique=False,
    )
    op.create_index(
        "ix_user_activity_entries_organization_user_started",
        "user_activity_entries",
        ["organization_id", "user_id", "started_at"],
        unique=False,
    )
    op.create_index(
        "ix_user_activity_entries_started_at",
        "user_activity_entries",
        ["started_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_user_activity_entries_started_at", table_name="user_activity_entries")
    op.drop_index("ix_user_activity_entries_organization_user_started", table_name="user_activity_entries")
    op.drop_index("ix_user_activity_entries_organization_task_started", table_name="user_activity_entries")
    op.drop_table("user_activity_entries")
