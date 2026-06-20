"""add hiring evaluation features

Revision ID: 20260620_0016
Revises: 20260620_0015
Create Date: 2026-06-20
"""

from alembic import op
import sqlalchemy as sa


revision = "20260620_0016"
down_revision = "20260620_0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("hiring_assessments", sa.Column("time_limit_minutes", sa.Integer(), nullable=True))
    op.add_column(
        "hiring_assessments",
        sa.Column("blind_review_enabled", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "hiring_assessments",
        sa.Column("rubric_schema", sa.JSON(), server_default="[]", nullable=False),
    )
    op.alter_column("hiring_assessments", "blind_review_enabled", server_default=None)
    op.alter_column("hiring_assessments", "rubric_schema", server_default=None)

    op.add_column("hiring_assignments", sa.Column("invite_token", sa.String(length=120), nullable=True))
    op.add_column("hiring_assignments", sa.Column("invite_created_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("hiring_assignments", sa.Column("invite_expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "hiring_assignments",
        sa.Column("rubric_scores", sa.JSON(), server_default="{}", nullable=False),
    )
    op.alter_column("hiring_assignments", "rubric_scores", server_default=None)
    op.create_index("ix_hiring_assignments_invite_token", "hiring_assignments", ["invite_token"])
    op.create_unique_constraint("uq_hiring_assignments_invite_token", "hiring_assignments", ["invite_token"])

    op.add_column(
        "hiring_submissions",
        sa.Column("pii_entries", sa.JSON(), server_default="[]", nullable=False),
    )
    op.alter_column("hiring_submissions", "pii_entries", server_default=None)


def downgrade() -> None:
    op.drop_column("hiring_submissions", "pii_entries")
    op.drop_constraint("uq_hiring_assignments_invite_token", "hiring_assignments", type_="unique")
    op.drop_index("ix_hiring_assignments_invite_token", table_name="hiring_assignments")
    op.drop_column("hiring_assignments", "rubric_scores")
    op.drop_column("hiring_assignments", "invite_expires_at")
    op.drop_column("hiring_assignments", "invite_created_at")
    op.drop_column("hiring_assignments", "invite_token")
    op.drop_column("hiring_assessments", "rubric_schema")
    op.drop_column("hiring_assessments", "blind_review_enabled")
    op.drop_column("hiring_assessments", "time_limit_minutes")
