"""add assignment scoped hiring audio

Revision ID: 20260620_0019
Revises: 20260620_0018
Create Date: 2026-06-20
"""

from alembic import op
import sqlalchemy as sa


revision = "20260620_0019"
down_revision = "20260620_0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("hiring_assessment_items", sa.Column("assignment_id", sa.String(length=36), nullable=True))
    op.create_index("ix_hiring_assessment_items_assignment_id", "hiring_assessment_items", ["assignment_id"])
    op.create_foreign_key(
        "fk_hiring_assessment_items_assignment_id",
        "hiring_assessment_items",
        "hiring_assignments",
        ["assignment_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint("fk_hiring_assessment_items_assignment_id", "hiring_assessment_items", type_="foreignkey")
    op.drop_index("ix_hiring_assessment_items_assignment_id", table_name="hiring_assessment_items")
    op.drop_column("hiring_assessment_items", "assignment_id")
