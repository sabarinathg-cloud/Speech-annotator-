"""add organization scoped workspaces

Revision ID: 20260720_0021
Revises: 20260620_0020
Create Date: 2026-07-20
"""

from datetime import datetime, timezone
import uuid

from alembic import op
import sqlalchemy as sa


revision = "20260720_0021"
down_revision = "20260620_0020"
branch_labels = None
depends_on = None


DEFAULT_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000001"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _add_org_column(table_name: str, *, nullable: bool = False) -> None:
    op.add_column(table_name, sa.Column("organization_id", sa.String(length=36), nullable=True))
    op.create_index(f"ix_{table_name}_organization_id", table_name, ["organization_id"])
    op.create_foreign_key(
        f"fk_{table_name}_organization_id_organizations",
        table_name,
        "organizations",
        ["organization_id"],
        ["id"],
        ondelete="SET NULL" if nullable else "RESTRICT",
    )
    op.execute(sa.text(f"UPDATE {table_name} SET organization_id = :org_id").bindparams(org_id=DEFAULT_ORGANIZATION_ID))
    if not nullable:
        op.alter_column(table_name, "organization_id", nullable=False)


def upgrade() -> None:
    now = _now()
    op.create_table(
        "organizations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("slug", sa.String(length=80), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("metadata_enabled", sa.Boolean(), nullable=False),
        sa.Column("pii_enabled", sa.Boolean(), nullable=False),
        sa.Column("transcript_redaction_enabled", sa.Boolean(), nullable=False),
        sa.Column("audio_masking_enabled", sa.Boolean(), nullable=False),
        sa.Column("hiring_enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug", name="uq_organizations_slug"),
    )
    op.create_index("ix_organizations_status", "organizations", ["is_active"])
    op.bulk_insert(
        sa.table(
            "organizations",
            sa.column("id", sa.String),
            sa.column("name", sa.String),
            sa.column("slug", sa.String),
            sa.column("is_active", sa.Boolean),
            sa.column("metadata_enabled", sa.Boolean),
            sa.column("pii_enabled", sa.Boolean),
            sa.column("transcript_redaction_enabled", sa.Boolean),
            sa.column("audio_masking_enabled", sa.Boolean),
            sa.column("hiring_enabled", sa.Boolean),
            sa.column("created_at", sa.DateTime(timezone=True)),
            sa.column("updated_at", sa.DateTime(timezone=True)),
        ),
        [
            {
                "id": DEFAULT_ORGANIZATION_ID,
                "name": "Default Organization",
                "slug": "default",
                "is_active": True,
                "metadata_enabled": True,
                "pii_enabled": True,
                "transcript_redaction_enabled": True,
                "audio_masking_enabled": True,
                "hiring_enabled": True,
                "created_at": now,
                "updated_at": now,
            }
        ],
    )

    op.create_table(
        "organization_memberships",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id", "user_id", name="uq_organization_memberships_org_user"),
    )
    op.create_index("ix_organization_memberships_organization_id", "organization_memberships", ["organization_id"])
    op.create_index("ix_organization_memberships_user_id", "organization_memberships", ["user_id"])
    op.create_index("ix_organization_memberships_is_active", "organization_memberships", ["is_active"])

    bind = op.get_bind()
    user_ids = [row[0] for row in bind.execute(sa.text("SELECT id FROM users")).all()]
    if user_ids:
        memberships_table = sa.table(
            "organization_memberships",
            sa.column("id", sa.String),
            sa.column("organization_id", sa.String),
            sa.column("user_id", sa.String),
            sa.column("is_active", sa.Boolean),
            sa.column("created_at", sa.DateTime(timezone=True)),
            sa.column("updated_at", sa.DateTime(timezone=True)),
        )
        op.bulk_insert(
            memberships_table,
            [
                {
                    "id": str(uuid.uuid4()),
                    "organization_id": DEFAULT_ORGANIZATION_ID,
                    "user_id": user_id,
                    "is_active": True,
                    "created_at": now,
                    "updated_at": now,
                }
                for user_id in user_ids
            ],
        )

    _add_org_column("upload_files")
    _add_org_column("upload_jobs")
    _add_org_column("annotation_tasks")
    _add_org_column("hiring_assessments")
    _add_org_column("background_jobs", nullable=True)
    _add_org_column("security_audit_events", nullable=True)

    op.add_column("pii_labels", sa.Column("organization_id", sa.String(length=36), nullable=True))
    op.create_index("ix_pii_labels_organization_id", "pii_labels", ["organization_id"])
    op.create_foreign_key(
        "fk_pii_labels_organization_id_organizations",
        "pii_labels",
        "organizations",
        ["organization_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.execute(sa.text("UPDATE pii_labels SET organization_id = :org_id").bindparams(org_id=DEFAULT_ORGANIZATION_ID))
    op.alter_column("pii_labels", "organization_id", nullable=False)
    op.drop_constraint("uq_pii_labels_key", "pii_labels", type_="unique")
    op.create_unique_constraint("uq_pii_labels_organization_key", "pii_labels", ["organization_id", "key"])


def downgrade() -> None:
    op.drop_constraint("uq_pii_labels_organization_key", "pii_labels", type_="unique")
    op.create_unique_constraint("uq_pii_labels_key", "pii_labels", ["key"])
    op.drop_constraint("fk_pii_labels_organization_id_organizations", "pii_labels", type_="foreignkey")
    op.drop_index("ix_pii_labels_organization_id", table_name="pii_labels")
    op.drop_column("pii_labels", "organization_id")

    for table_name in [
        "security_audit_events",
        "background_jobs",
        "hiring_assessments",
        "annotation_tasks",
        "upload_jobs",
        "upload_files",
    ]:
        op.drop_constraint(f"fk_{table_name}_organization_id_organizations", table_name, type_="foreignkey")
        op.drop_index(f"ix_{table_name}_organization_id", table_name=table_name)
        op.drop_column(table_name, "organization_id")

    op.drop_index("ix_organization_memberships_is_active", table_name="organization_memberships")
    op.drop_index("ix_organization_memberships_user_id", table_name="organization_memberships")
    op.drop_index("ix_organization_memberships_organization_id", table_name="organization_memberships")
    op.drop_table("organization_memberships")
    op.drop_index("ix_organizations_status", table_name="organizations")
    op.drop_table("organizations")
