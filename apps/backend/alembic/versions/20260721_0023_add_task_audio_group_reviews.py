"""add task audio group reviews

Revision ID: 20260721_0023
Revises: 20260721_0022
Create Date: 2026-07-21 00:23:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260721_0023"
down_revision: str | None = "20260721_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "task_audio_group_reviews",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("upload_job_id", sa.String(length=36), nullable=False),
        sa.Column("group_key", sa.Text(), nullable=False),
        sa.Column("group_hash", sa.String(length=64), nullable=False),
        sa.Column("assignee_id", sa.String(length=36), nullable=True),
        sa.Column("assignment_scope_key", sa.String(length=80), nullable=False),
        sa.Column("transcript", sa.Text(), nullable=False, server_default=""),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["assignee_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["upload_job_id"], ["upload_jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "organization_id",
            "upload_job_id",
            "group_hash",
            "assignment_scope_key",
            name="uq_task_audio_group_reviews_scope",
        ),
    )
    op.create_index(
        "ix_task_audio_group_reviews_assignee_id",
        "task_audio_group_reviews",
        ["assignee_id"],
        unique=False,
    )
    op.create_index(
        "ix_task_audio_group_reviews_group_hash",
        "task_audio_group_reviews",
        ["group_hash"],
        unique=False,
    )
    op.create_index(
        "ix_task_audio_group_reviews_organization_id",
        "task_audio_group_reviews",
        ["organization_id"],
        unique=False,
    )
    op.create_index(
        "ix_task_audio_group_reviews_upload_job_id",
        "task_audio_group_reviews",
        ["upload_job_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_task_audio_group_reviews_upload_job_id", table_name="task_audio_group_reviews")
    op.drop_index("ix_task_audio_group_reviews_organization_id", table_name="task_audio_group_reviews")
    op.drop_index("ix_task_audio_group_reviews_group_hash", table_name="task_audio_group_reviews")
    op.drop_index("ix_task_audio_group_reviews_assignee_id", table_name="task_audio_group_reviews")
    op.drop_table("task_audio_group_reviews")
