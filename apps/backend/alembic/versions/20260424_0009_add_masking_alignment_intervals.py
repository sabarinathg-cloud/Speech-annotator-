"""add masking alignment intervals

Revision ID: 20260424_0009
Revises: 20260424_0008
Create Date: 2026-04-24
"""

from alembic import op
import sqlalchemy as sa


revision = "20260424_0009"
down_revision = "20260424_0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("annotation_tasks", sa.Column("masked_audio_alignment_intervals", sa.JSON(), nullable=True))
    op.execute(
        "UPDATE annotation_tasks "
        "SET masked_audio_alignment_intervals = masked_audio_reference_intervals "
        "WHERE masked_audio_alignment_intervals IS NULL"
    )
    op.execute(
        "UPDATE annotation_tasks SET masked_audio_alignment_intervals = '[]' "
        "WHERE masked_audio_alignment_intervals IS NULL"
    )
    op.alter_column("annotation_tasks", "masked_audio_alignment_intervals", nullable=False)


def downgrade() -> None:
    op.drop_column("annotation_tasks", "masked_audio_alignment_intervals")
