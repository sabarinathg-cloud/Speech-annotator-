"""add hiring submission pii text

Revision ID: 20260620_0015
Revises: 20260619_0014
Create Date: 2026-06-20
"""

from alembic import op
import sqlalchemy as sa


revision = "20260620_0015"
down_revision = "20260619_0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "hiring_submissions",
        sa.Column("pii_text", sa.Text(), server_default="", nullable=False),
    )
    op.alter_column("hiring_submissions", "pii_text", server_default=None)


def downgrade() -> None:
    op.drop_column("hiring_submissions", "pii_text")
