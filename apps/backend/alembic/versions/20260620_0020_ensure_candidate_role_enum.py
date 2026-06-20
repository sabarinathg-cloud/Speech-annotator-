"""ensure candidate role enum value

Revision ID: 20260620_0020
Revises: 20260620_0019
Create Date: 2026-06-20
"""

from alembic import op


revision = "20260620_0020"
down_revision = "20260620_0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.execute("ALTER TYPE role_enum ADD VALUE IF NOT EXISTS 'CANDIDATE'")


def downgrade() -> None:
    # PostgreSQL cannot safely remove enum values in-place.
    pass
