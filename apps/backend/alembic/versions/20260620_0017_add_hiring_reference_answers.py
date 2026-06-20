"""add hiring reference answers

Revision ID: 20260620_0017
Revises: 20260620_0016
Create Date: 2026-06-20
"""

from alembic import op
import sqlalchemy as sa


revision = "20260620_0017"
down_revision = "20260620_0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "hiring_assessment_items",
        sa.Column("reference_pii_entries", sa.JSON(), server_default="[]", nullable=False),
    )
    op.alter_column("hiring_assessment_items", "reference_pii_entries", server_default=None)


def downgrade() -> None:
    op.drop_column("hiring_assessment_items", "reference_pii_entries")
