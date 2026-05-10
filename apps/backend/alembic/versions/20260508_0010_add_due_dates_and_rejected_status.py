"""add due dates and rejected task status

Revision ID: 20260508_0010
Revises: 20260424_0009
Create Date: 2026-05-08
"""

from alembic import op
import sqlalchemy as sa


revision = "20260508_0010"
down_revision = "20260424_0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER TYPE task_status_enum ADD VALUE IF NOT EXISTS 'Rejected'")
    op.add_column("annotation_tasks", sa.Column("due_date", sa.Date(), nullable=True))
    op.create_index("ix_annotation_tasks_due_date", "annotation_tasks", ["due_date"])


def downgrade() -> None:
    op.drop_index("ix_annotation_tasks_due_date", table_name="annotation_tasks")
    op.drop_column("annotation_tasks", "due_date")
