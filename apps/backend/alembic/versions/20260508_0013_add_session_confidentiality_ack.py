"""add session confidentiality acknowledgement

Revision ID: 20260508_0013
Revises: 20260508_0012
Create Date: 2026-05-08
"""

from alembic import op
import sqlalchemy as sa


revision = "20260508_0013"
down_revision = "20260508_0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("confidentiality_acknowledged_session_id", sa.String(length=80), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "confidentiality_acknowledged_session_id")
