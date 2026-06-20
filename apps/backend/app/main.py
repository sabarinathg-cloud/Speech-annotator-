from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.routers import auth, exports, health, hiring, jobs, media, metrics, pii_labels, security, tasks, uploads, users
from app.services.errors import ServiceError
from app.services.pii_detection_service import start_pii_model_preload

settings = get_settings()
configure_logging()


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.pii_model_preload_enabled:
        start_pii_model_preload()
    yield


app = FastAPI(title=settings.app_name, debug=settings.debug, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(ServiceError)
async def service_error_handler(_: Request, exc: ServiceError):
    body: dict = {"detail": exc.message}
    body.update(exc.extra)
    return JSONResponse(status_code=exc.status_code, content=body)


app.include_router(health.router)
app.include_router(auth.router, prefix=settings.api_v1_prefix)
app.include_router(uploads.router, prefix=settings.api_v1_prefix)
app.include_router(tasks.router, prefix=settings.api_v1_prefix)
app.include_router(exports.router, prefix=settings.api_v1_prefix)
app.include_router(jobs.router, prefix=settings.api_v1_prefix)
app.include_router(media.router, prefix=settings.api_v1_prefix)
app.include_router(users.router, prefix=settings.api_v1_prefix)
app.include_router(pii_labels.router, prefix=settings.api_v1_prefix)
app.include_router(metrics.router, prefix=settings.api_v1_prefix)
app.include_router(security.router, prefix=settings.api_v1_prefix)
app.include_router(hiring.router, prefix=settings.api_v1_prefix)
