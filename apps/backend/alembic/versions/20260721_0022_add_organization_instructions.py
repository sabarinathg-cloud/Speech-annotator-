"""add organization instructions

Revision ID: 20260721_0022
Revises: 20260720_0021
Create Date: 2026-07-21
"""

from alembic import op
import sqlalchemy as sa


revision = "20260721_0022"
down_revision = "20260720_0021"
branch_labels = None
depends_on = None


DEFAULT_ORGANIZATION_INSTRUCTIONS = """Please read these instructions before starting annotation work.

- Work only on tasks assigned to you in this organization.
- Listen to the full audio before finalizing transcript changes.
- Correct the transcript exactly as spoken, including punctuation when it is clear.
- Complete metadata or PII fields only when they are enabled for this organization.
- Do not copy, download, screenshot, or share customer audio, transcripts, PII, or metadata outside the approved workspace.
- Contact an admin if audio is missing, unclear, duplicated, or assigned incorrectly."""


def upgrade() -> None:
    op.add_column("organizations", sa.Column("instructions", sa.Text(), nullable=True))
    op.execute(
        sa.text("UPDATE organizations SET instructions = :instructions WHERE instructions IS NULL").bindparams(
            instructions=DEFAULT_ORGANIZATION_INSTRUCTIONS
        )
    )


def downgrade() -> None:
    op.drop_column("organizations", "instructions")
