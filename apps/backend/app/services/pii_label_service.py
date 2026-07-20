from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.pii_label import PIILabel
from app.schemas.pii_label import PIILabelResponse
from app.services.errors import ServiceError


DEFAULT_PII_LABELS: list[dict[str, object]] = [
    {"key": "EMAIL", "display_name": "Email", "color": "#2563eb", "sort_order": 10},
    {"key": "PHONE", "display_name": "Phone", "color": "#16a34a", "sort_order": 20},
    {"key": "SSN", "display_name": "SSN", "color": "#dc2626", "sort_order": 30},
    {"key": "CREDIT_CARD", "display_name": "Credit Card", "color": "#ea580c", "sort_order": 40},
    {"key": "IP_ADDRESS", "display_name": "IP Address", "color": "#4f46e5", "sort_order": 50},
    {"key": "URL", "display_name": "URL", "color": "#0891b2", "sort_order": 60},
    {"key": "PERSON", "display_name": "Person", "color": "#ca8a04", "sort_order": 70},
    {"key": "NAME", "display_name": "Name", "color": "#a16207", "sort_order": 80},
    {"key": "ADDRESS", "display_name": "Address", "color": "#9333ea", "sort_order": 90},
    {"key": "DATE_OF_BIRTH", "display_name": "Date of Birth", "color": "#be185d", "sort_order": 100},
    {"key": "ACCOUNT_NUMBER", "display_name": "Account Number", "color": "#0f766e", "sort_order": 110},
    {"key": "MEDICAL_ID", "display_name": "Medical ID", "color": "#0e7490", "sort_order": 120},
    {"key": "LOCATION", "display_name": "Location", "color": "#7c3aed", "sort_order": 130},
    {"key": "ORGANIZATION", "display_name": "Organization", "color": "#475569", "sort_order": 140},
    {"key": "DATE", "display_name": "Date", "color": "#b45309", "sort_order": 150},
    {"key": "AADHAAR_NUMBER", "display_name": "Aadhaar Number", "color": "#0d9488", "sort_order": 160},
    {"key": "INSURANCE_ID", "display_name": "Insurance ID", "color": "#0369a1", "sort_order": 170},
    {"key": "ID_NUMBER", "display_name": "ID Number", "color": "#4338ca", "sort_order": 180},
    {"key": "USERNAME", "display_name": "Username", "color": "#7e22ce", "sort_order": 190},
    {"key": "PASSWORD", "display_name": "Password", "color": "#be123c", "sort_order": 200},
    {"key": "ZIPCODE", "display_name": "ZIP Code", "color": "#2563eb", "sort_order": 210},
    {"key": "INSTITUTION", "display_name": "Institution", "color": "#475569", "sort_order": 220},
    {"key": "AGE", "display_name": "Age", "color": "#15803d", "sort_order": 230},
    {"key": "OTHER", "display_name": "Other", "color": "#64748b", "sort_order": 1000},
]


class PIILabelService:
    def __init__(self, db: Session):
        self.db = db

    def list_active_labels(self, *, organization_id: str) -> list[PIILabelResponse]:
        self.ensure_default_labels(organization_id=organization_id)
        labels = self.db.execute(
            select(PIILabel)
            .where(PIILabel.organization_id == organization_id)
            .where(PIILabel.is_active.is_(True))
            .order_by(PIILabel.sort_order.asc(), PIILabel.display_name.asc())
        ).scalars().all()
        return [PIILabelResponse.model_validate(label) for label in labels]

    def list_admin_labels(self, *, organization_id: str) -> list[PIILabelResponse]:
        self.ensure_default_labels(organization_id=organization_id)
        labels = self.db.execute(
            select(PIILabel)
            .where(PIILabel.organization_id == organization_id)
            .order_by(PIILabel.sort_order.asc(), PIILabel.display_name.asc())
        ).scalars().all()
        return [PIILabelResponse.model_validate(label) for label in labels]

    def create_label(
        self,
        *,
        key: str,
        display_name: str,
        color: str,
        description: str | None,
        is_active: bool,
        sort_order: int | None,
        organization_id: str,
    ) -> PIILabelResponse:
        self.ensure_default_labels(organization_id=organization_id)
        existing = self.db.execute(
            select(PIILabel).where(PIILabel.organization_id == organization_id).where(PIILabel.key == key)
        ).scalar_one_or_none()
        if existing:
            raise ServiceError("PII label key already exists", status_code=409)

        label = PIILabel(
            organization_id=organization_id,
            key=key,
            display_name=display_name.strip(),
            color=color.strip(),
            description=description.strip() if description else None,
            is_active=is_active,
            sort_order=sort_order if sort_order is not None else self._next_sort_order(organization_id=organization_id),
        )
        self.db.add(label)
        self.db.commit()
        self.db.refresh(label)
        return PIILabelResponse.model_validate(label)

    def update_label(
        self,
        *,
        label_id: str,
        display_name: str | None,
        color: str | None,
        description: str | None,
        is_active: bool | None,
        sort_order: int | None,
        provided_fields: set[str],
        organization_id: str,
    ) -> PIILabelResponse:
        label = self._get_label_or_404(label_id, organization_id=organization_id)
        if not provided_fields:
            raise ServiceError("No PII label fields provided for update", status_code=422)

        if "display_name" in provided_fields and display_name is not None:
            label.display_name = display_name.strip()
        if "color" in provided_fields and color is not None:
            label.color = color.strip()
        if "description" in provided_fields:
            label.description = description.strip() if description else None
        if "is_active" in provided_fields and is_active is not None:
            label.is_active = is_active
        if "sort_order" in provided_fields and sort_order is not None:
            label.sort_order = sort_order

        label.updated_at = datetime.now(timezone.utc)
        self.db.commit()
        self.db.refresh(label)
        return PIILabelResponse.model_validate(label)

    def ensure_default_labels(self, *, organization_id: str) -> None:
        existing_keys = set(
            self.db.execute(select(PIILabel.key).where(PIILabel.organization_id == organization_id)).scalars().all()
        )
        missing = [item for item in DEFAULT_PII_LABELS if item["key"] not in existing_keys]
        if not missing:
            return
        for item in missing:
            self.db.add(
                PIILabel(
                    organization_id=organization_id,
                    key=str(item["key"]),
                    display_name=str(item["display_name"]),
                    color=str(item["color"]),
                    sort_order=int(item["sort_order"]),
                    is_active=True,
                )
            )
        self.db.commit()

    def _get_label_or_404(self, label_id: str, *, organization_id: str) -> PIILabel:
        label = self.db.get(PIILabel, label_id)
        if not label:
            raise ServiceError("PII label not found", status_code=404)
        if label.organization_id != organization_id:
            raise ServiceError("PII label not found", status_code=404)
        return label

    def _next_sort_order(self, *, organization_id: str) -> int:
        current = self.db.execute(
            select(func.max(PIILabel.sort_order)).where(PIILabel.organization_id == organization_id)
        ).scalar_one()
        return int(current or 0) + 10
