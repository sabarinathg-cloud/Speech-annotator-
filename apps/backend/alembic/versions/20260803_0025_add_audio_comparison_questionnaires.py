"""add audio comparison questionnaires

Revision ID: 20260803_0025
Revises: 20260728_0024
Create Date: 2026-08-03 00:25:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260803_0025"
down_revision: str | None = "20260728_0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


task_workflow_type_enum = sa.Enum(
    "TRANSCRIPT_CORRECTION",
    "AUDIO_COMPARISON",
    name="task_workflow_type_enum",
)


def upgrade() -> None:
    bind = op.get_bind()
    task_workflow_type_enum.create(bind, checkfirst=True)

    op.create_table(
        "organization_questionnaires",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("questions", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_organization_questionnaires_organization_id",
        "organization_questionnaires",
        ["organization_id"],
        unique=False,
    )
    op.create_index(
        "ix_organization_questionnaires_is_active",
        "organization_questionnaires",
        ["is_active"],
        unique=False,
    )

    op.add_column(
        "annotation_tasks",
        sa.Column(
            "workflow_type",
            task_workflow_type_enum,
            nullable=False,
            server_default="TRANSCRIPT_CORRECTION",
        ),
    )
    op.add_column("annotation_tasks", sa.Column("comparison_audio_location", sa.Text(), nullable=True))
    op.add_column("annotation_tasks", sa.Column("questionnaire_id", sa.String(length=36), nullable=True))
    op.add_column(
        "annotation_tasks",
        sa.Column("questionnaire_snapshot", sa.JSON(), nullable=False, server_default="{}"),
    )
    op.add_column(
        "annotation_tasks",
        sa.Column("questionnaire_answers", sa.JSON(), nullable=False, server_default="{}"),
    )
    op.create_foreign_key(
        "fk_annotation_tasks_questionnaire_id",
        "annotation_tasks",
        "organization_questionnaires",
        ["questionnaire_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_annotation_tasks_workflow_type", "annotation_tasks", ["workflow_type"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_annotation_tasks_workflow_type", table_name="annotation_tasks")
    op.drop_constraint("fk_annotation_tasks_questionnaire_id", "annotation_tasks", type_="foreignkey")
    op.drop_column("annotation_tasks", "questionnaire_answers")
    op.drop_column("annotation_tasks", "questionnaire_snapshot")
    op.drop_column("annotation_tasks", "questionnaire_id")
    op.drop_column("annotation_tasks", "comparison_audio_location")
    op.drop_column("annotation_tasks", "workflow_type")
    op.drop_index("ix_organization_questionnaires_is_active", table_name="organization_questionnaires")
    op.drop_index("ix_organization_questionnaires_organization_id", table_name="organization_questionnaires")
    op.drop_table("organization_questionnaires")
    task_workflow_type_enum.drop(op.get_bind(), checkfirst=True)
