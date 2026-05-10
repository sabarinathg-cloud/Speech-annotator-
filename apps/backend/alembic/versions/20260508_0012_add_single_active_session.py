"""add single active session controls

Revision ID: 20260508_0012
Revises: 20260508_0011
Create Date: 2026-05-08
"""

from alembic import op
import sqlalchemy as sa


revision = "20260508_0012"
down_revision = "20260508_0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("active_session_id", sa.String(length=80), nullable=True))
    op.add_column("users", sa.Column("active_session_started_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "active_session_started_at")
    op.drop_column("users", "active_session_id")
