"""add hiring assessments

Revision ID: 20260619_0014
Revises: 20260508_0013
Create Date: 2026-06-19
"""

from alembic import op
import sqlalchemy as sa


revision = "20260619_0014"
down_revision = "20260508_0013"
branch_labels = None
depends_on = None


hiring_assessment_status_enum = sa.Enum("DRAFT", "ACTIVE", "CLOSED", name="hiring_assessment_status_enum")
hiring_assignment_status_enum = sa.Enum(
    "ASSIGNED", "IN_PROGRESS", "SUBMITTED", "EVALUATED", name="hiring_assignment_status_enum"
)
hiring_submission_validation_status_enum = sa.Enum(
    "PENDING", "VALIDATED", "REJECTED", name="hiring_submission_validation_status_enum"
)
hiring_decision_enum = sa.Enum("PENDING", "PASS", "FAIL", "HOLD", name="hiring_decision_enum")


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE role_enum ADD VALUE IF NOT EXISTS 'CANDIDATE'")

    op.create_table(
        "hiring_assessments",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("status", hiring_assessment_status_enum, nullable=False),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("metadata_schema", sa.JSON(), nullable=False),
        sa.Column("pii_label_keys", sa.JSON(), nullable=False),
        sa.Column("created_by_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_hiring_assessments_status", "hiring_assessments", ["status"])
    op.create_index("ix_hiring_assessments_created_by_id", "hiring_assessments", ["created_by_id"])

    op.create_table(
        "hiring_assessment_items",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("assessment_id", sa.String(length=36), nullable=False),
        sa.Column("external_id", sa.String(length=255), nullable=False),
        sa.Column("original_filename", sa.String(length=500), nullable=False),
        sa.Column("original_source", sa.Text(), nullable=False),
        sa.Column("stored_path", sa.Text(), nullable=False),
        sa.Column("reference_transcript", sa.Text(), nullable=True),
        sa.Column("reference_pii_annotations", sa.JSON(), nullable=False),
        sa.Column("reference_metadata", sa.JSON(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["assessment_id"], ["hiring_assessments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("assessment_id", "external_id", name="uq_hiring_items_assessment_external"),
    )
    op.create_index("ix_hiring_assessment_items_assessment_id", "hiring_assessment_items", ["assessment_id"])

    op.create_table(
        "hiring_assignments",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("assessment_id", sa.String(length=36), nullable=False),
        sa.Column("candidate_id", sa.String(length=36), nullable=False),
        sa.Column("assigned_by_id", sa.String(length=36), nullable=False),
        sa.Column("evaluator_id", sa.String(length=36), nullable=True),
        sa.Column("status", hiring_assignment_status_enum, nullable=False),
        sa.Column("decision", hiring_decision_enum, nullable=False),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("transcript_score", sa.Numeric(6, 2), nullable=True),
        sa.Column("pii_score", sa.Numeric(6, 2), nullable=True),
        sa.Column("metadata_score", sa.Numeric(6, 2), nullable=True),
        sa.Column("total_score", sa.Numeric(6, 2), nullable=True),
        sa.Column("evaluator_notes", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["assessment_id"], ["hiring_assessments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["assigned_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["candidate_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["evaluator_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("assessment_id", "candidate_id", name="uq_hiring_assignments_assessment_candidate"),
    )
    op.create_index("ix_hiring_assignments_assessment_id", "hiring_assignments", ["assessment_id"])
    op.create_index("ix_hiring_assignments_candidate_id", "hiring_assignments", ["candidate_id"])
    op.create_index("ix_hiring_assignments_status", "hiring_assignments", ["status"])

    op.create_table(
        "hiring_submissions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("assignment_id", sa.String(length=36), nullable=False),
        sa.Column("item_id", sa.String(length=36), nullable=False),
        sa.Column("final_transcript", sa.Text(), nullable=False),
        sa.Column("pii_annotations", sa.JSON(), nullable=False),
        sa.Column("metadata_values", sa.JSON(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("pii_reviewed", sa.Boolean(), nullable=False),
        sa.Column("validation_status", hiring_submission_validation_status_enum, nullable=False),
        sa.Column("validation_feedback", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("last_saved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["assignment_id"], ["hiring_assignments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["item_id"], ["hiring_assessment_items.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("assignment_id", "item_id", name="uq_hiring_submissions_assignment_item"),
    )
    op.create_index("ix_hiring_submissions_assignment_id", "hiring_submissions", ["assignment_id"])
    op.create_index("ix_hiring_submissions_item_id", "hiring_submissions", ["item_id"])
    op.create_index("ix_hiring_submissions_validation_status", "hiring_submissions", ["validation_status"])


def downgrade() -> None:
    op.drop_index("ix_hiring_submissions_validation_status", table_name="hiring_submissions")
    op.drop_index("ix_hiring_submissions_item_id", table_name="hiring_submissions")
    op.drop_index("ix_hiring_submissions_assignment_id", table_name="hiring_submissions")
    op.drop_table("hiring_submissions")
    op.drop_index("ix_hiring_assignments_status", table_name="hiring_assignments")
    op.drop_index("ix_hiring_assignments_candidate_id", table_name="hiring_assignments")
    op.drop_index("ix_hiring_assignments_assessment_id", table_name="hiring_assignments")
    op.drop_table("hiring_assignments")
    op.drop_index("ix_hiring_assessment_items_assessment_id", table_name="hiring_assessment_items")
    op.drop_table("hiring_assessment_items")
    op.drop_index("ix_hiring_assessments_created_by_id", table_name="hiring_assessments")
    op.drop_index("ix_hiring_assessments_status", table_name="hiring_assessments")
    op.drop_table("hiring_assessments")

    bind = op.get_bind()
    hiring_submission_validation_status_enum.drop(bind, checkfirst=True)
    hiring_assignment_status_enum.drop(bind, checkfirst=True)
    hiring_assessment_status_enum.drop(bind, checkfirst=True)
    hiring_decision_enum.drop(bind, checkfirst=True)
