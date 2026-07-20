"""add pii labels catalog

Revision ID: 20260424_0005
Revises: 20260424_0004
Create Date: 2026-04-24
"""

from datetime import datetime, timezone
import uuid

from alembic import op
import sqlalchemy as sa


revision = "20260424_0005"
down_revision = "20260424_0004"
branch_labels = None
depends_on = None


DEFAULT_LABELS = [
    ("EMAIL", "Email", "#2563eb", 10),
    ("PHONE", "Phone", "#16a34a", 20),
    ("SSN", "SSN", "#dc2626", 30),
    ("CREDIT_CARD", "Credit Card", "#ea580c", 40),
    ("IP_ADDRESS", "IP Address", "#4f46e5", 50),
    ("URL", "URL", "#0891b2", 60),
    ("PERSON", "Person", "#ca8a04", 70),
    ("NAME", "Name", "#a16207", 80),
    ("ADDRESS", "Address", "#9333ea", 90),
    ("DATE_OF_BIRTH", "Date of Birth", "#be185d", 100),
    ("ACCOUNT_NUMBER", "Account Number", "#0f766e", 110),
    ("MEDICAL_ID", "Medical ID", "#0e7490", 120),
    ("LOCATION", "Location", "#7c3aed", 130),
    ("ORGANIZATION", "Organization", "#475569", 140),
    ("OTHER", "Other", "#64748b", 1000),
]


def upgrade() -> None:
    op.create_table(
        "pii_labels",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=False),
        sa.Column("color", sa.String(length=32), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key", name="uq_pii_labels_key"),
    )
    op.create_index("ix_pii_labels_is_active", "pii_labels", ["is_active"])
    op.create_index("ix_pii_labels_sort_order", "pii_labels", ["sort_order"])

    labels_table = sa.table(
        "pii_labels",
        sa.column("id", sa.String),
        sa.column("key", sa.String),
        sa.column("display_name", sa.String),
        sa.column("color", sa.String),
        sa.column("description", sa.Text),
        sa.column("is_active", sa.Boolean),
        sa.column("sort_order", sa.Integer),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    now = datetime.now(timezone.utc)
    op.bulk_insert(
        labels_table,
        [
            {
                "id": str(uuid.uuid4()),
                "key": key,
                "display_name": display_name,
                "color": color,
                "description": None,
                "is_active": True,
                "sort_order": sort_order,
                "created_at": now,
                "updated_at": now,
            }
            for key, display_name, color, sort_order in DEFAULT_LABELS
        ],
    )


def downgrade() -> None:
    op.drop_index("ix_pii_labels_sort_order", table_name="pii_labels")
    op.drop_index("ix_pii_labels_is_active", table_name="pii_labels")
    op.drop_table("pii_labels")
