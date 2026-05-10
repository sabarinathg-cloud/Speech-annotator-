"""add security controls

Revision ID: 20260508_0011
Revises: 20260508_0010
Create Date: 2026-05-08
"""

from alembic import op
import sqlalchemy as sa


revision = "20260508_0011"
down_revision = "20260508_0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("confidentiality_acknowledged_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("confidentiality_acknowledged_version", sa.String(length=80), nullable=True))
    op.create_table(
        "security_audit_events",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("actor_user_id", sa.String(length=36), nullable=True),
        sa.Column("actor_email", sa.String(length=255), nullable=True),
        sa.Column("actor_role", sa.String(length=40), nullable=True),
        sa.Column("action", sa.String(length=100), nullable=False),
        sa.Column("risk_level", sa.String(length=20), nullable=False),
        sa.Column("resource_type", sa.String(length=80), nullable=False),
        sa.Column("resource_id", sa.String(length=255), nullable=True),
        sa.Column("task_id", sa.String(length=36), nullable=True),
        sa.Column("ip_address", sa.String(length=100), nullable=True),
        sa.Column("user_agent", sa.String(length=500), nullable=True),
        sa.Column("event_metadata", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["task_id"], ["annotation_tasks.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_security_audit_events_action", "security_audit_events", ["action"])
    op.create_index("ix_security_audit_events_actor_user_id", "security_audit_events", ["actor_user_id"])
    op.create_index("ix_security_audit_events_created_at", "security_audit_events", ["created_at"])
    op.create_index("ix_security_audit_events_risk_level", "security_audit_events", ["risk_level"])
    op.create_index("ix_security_audit_events_task_id", "security_audit_events", ["task_id"])


def downgrade() -> None:
    op.drop_index("ix_security_audit_events_task_id", table_name="security_audit_events")
    op.drop_index("ix_security_audit_events_risk_level", table_name="security_audit_events")
    op.drop_index("ix_security_audit_events_created_at", table_name="security_audit_events")
    op.drop_index("ix_security_audit_events_actor_user_id", table_name="security_audit_events")
    op.drop_index("ix_security_audit_events_action", table_name="security_audit_events")
    op.drop_table("security_audit_events")
    op.drop_column("users", "confidentiality_acknowledged_version")
    op.drop_column("users", "confidentiality_acknowledged_at")
