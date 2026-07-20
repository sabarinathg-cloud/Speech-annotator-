from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.dependencies import get_db_session
from app.core.device_policy import require_laptop_or_desktop_device
from app.models.user import User
from app.services.errors import ServiceError
from app.services.media_service import MediaService
from app.services.security_audit_service import SecurityAuditService

router = APIRouter(prefix="/media", tags=["media"])


def _http_error(exc: ServiceError) -> HTTPException:
    detail = {"message": exc.message}
    detail.update(exc.extra)
    return HTTPException(status_code=exc.status_code, detail=detail)


@router.get("/audio/{token}")
def stream_audio(
    token: str,
    request: Request,
    range_header: str | None = Header(default=None, alias="Range"),
    db: Session = Depends(get_db_session),
):
    require_laptop_or_desktop_device(request)
    service = MediaService()
    try:
        payload = service.decode_audio_token(token)
        file_location = payload["file_location"]
        actor = db.get(User, payload.get("actor_user_id")) if payload.get("actor_user_id") else None
        SecurityAuditService(db).log_event(
            action="STREAM_AUDIO",
            actor=actor,
            resource_type="audio",
            resource_id=payload.get("task_id"),
            task_id=payload.get("task_id"),
            organization_id=payload.get("organization_id"),
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={"masked": bool(payload.get("masked")), "range": bool(range_header)},
        )
        return service.build_audio_response(file_location, range_header)
    except (ServiceError, KeyError, FileNotFoundError) as exc:
        if isinstance(exc, ServiceError):
            raise _http_error(exc) from exc
        raise HTTPException(status_code=404, detail="Audio file not found") from exc
