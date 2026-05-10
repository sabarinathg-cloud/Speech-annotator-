# Railway Deployment

Yes, this app can run on Railway. Deploy it as separate services rather than as one Docker Compose stack.

## Recommended Services

1. PostgreSQL database
2. Backend API service
3. Frontend service
4. Redis database, optional for login rate limiting or later background workers

For a first Railway deployment, keep background jobs inline by setting `JOBS_INLINE=true`. The current import/export jobs read and write files under `UPLOAD_DIR`, so a separate worker service would need shared object storage before it is reliable on Railway.

## Backend Service

- Source: this GitHub repository
- Root directory: `/apps/backend`
- Builder: Dockerfile
- Healthcheck path: `/health`
- Volume: mount a Railway volume at `/app/data/uploads` if uploaded spreadsheets, exports, or masked audio should survive redeploys

Variables:

```env
ENVIRONMENT=production
DEBUG=false
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET_KEY=<long-random-secret>
JWT_REFRESH_SECRET_KEY=<long-random-secret>
AUDIO_SIGNING_SECRET=<long-random-secret>
CORS_ORIGINS=https://<frontend-domain>
UPLOAD_DIR=/app/data/uploads
JOBS_INLINE=true
LOGIN_RATE_LIMIT_ENABLED=true
PII_MODEL_PRELOAD_ENABLED=false
```

Optional:

```env
REDIS_URL=${{Redis.REDIS_URL}}
INSTALL_ALIGNMENT_DEPS=false
```

Use `INSTALL_ALIGNMENT_DEPS=true` only when forced alignment or masked-audio generation is needed in the deployed environment. It installs Torch/Torchaudio and downloads a Wav2Vec2 model during the image build.

## Frontend Service

- Source: this GitHub repository
- Root directory: `/`
- Dockerfile path: `apps/frontend/Dockerfile`
- Healthcheck path: `/`

Variables:

```env
NEXT_PUBLIC_API_URL=https://<backend-domain>/api/v1
```

Because Next.js inlines `NEXT_PUBLIC_*` values into the client bundle during `next build`, keep `NEXT_PUBLIC_API_URL` set before deploying or rebuilding the frontend image.

After both services deploy, update the backend `CORS_ORIGINS` value to the exact Railway frontend domain.

## Notes

- The backend runs Alembic migrations on startup.
- Railway injects `PORT`; the backend startup script now listens on that value.
- Railway's default Postgres URL is accepted directly; the app normalizes `postgresql://` to SQLAlchemy's `postgresql+psycopg://` driver URL.
- Do not deploy the root `docker-compose.yml` directly on Railway. Use Railway's Postgres/Redis services and the app Dockerfiles instead.
