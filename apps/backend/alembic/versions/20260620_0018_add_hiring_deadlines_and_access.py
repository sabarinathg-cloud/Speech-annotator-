"""add hiring deadlines and assignment access flags

Revision ID: 20260620_0018
Revises: 20260620_0017
Create Date: 2026-06-20
"""

from alembic import op
import sqlalchemy as sa


revision = "20260620_0018"
down_revision = "20260620_0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("hiring_assessments", sa.Column("due_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "hiring_assignments",
        sa.Column("access_revoked", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.alter_column("hiring_assignments", "access_revoked", server_default=None)


def downgrade() -> None:
    op.drop_column("hiring_assignments", "access_revoked")
    op.drop_column("hiring_assessments", "due_at")
