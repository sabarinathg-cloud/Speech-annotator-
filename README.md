# outcomes.ai Speech Annotator

Production-ready speech annotation platform for importing ASR outputs, reviewing audio, correcting transcripts, managing task status, and exporting curated datasets.

## What It Includes

- FastAPI backend with PostgreSQL, SQLAlchemy, Alembic migrations, JWT auth, RBAC, audit history, and background jobs.
- Next.js frontend with an annotation workspace, upload flow, reviewer queue, autosave, conflict handling, waveform playback, and PII tagging.
- Shared TypeScript API contracts in `packages/shared-types`.
- Docker Compose stack for PostgreSQL, Redis, backend worker, frontend, and Nginx.
- Unit, component, contract, and Playwright smoke tests.

## Repository Layout

```text
apps/
  backend/          FastAPI service, migrations, workers, tests
  frontend/         Next.js application, UI components, Vitest tests
packages/
  shared-types/     Shared TypeScript models for frontend API contracts
infra/
  docker/           Nginx reverse proxy configuration
tests/
  e2e/              Playwright smoke test suite
```

## Core Workflows

- Upload Excel datasets, preview rows, map columns, validate inputs, and import tasks.
- Compare multiple ASR transcript variants and highlight model disagreement.
- Edit final transcript, notes, core metadata, custom metadata, and PII spans.
- Force-align corrected transcript words to audio, play individual words, and generate masked PII audio for review.
- Track task lifecycle across assignment, annotation, review, completion, and rejection.
- Save work automatically with optimistic concurrency conflict resolution.
- Export the latest corrected dataset as CSV or XLSX.
- Audit transcript, metadata, notes, and status changes.

## Prerequisites

- Docker and Docker Compose for the full stack.
- Node.js 22 for frontend and E2E development.
- Python 3.11 or newer for backend development.

## Quick Start

```bash
docker compose up --build
```

Open <http://localhost:8080>. The Docker stack starts PostgreSQL, Redis, the API, worker, frontend, and Nginx with local defaults, so a copied `.env` file is not required for local sharing.

Forced alignment uses Wav2Vec2 through Torch/Torchaudio. The Docker backend and worker images install the CPU alignment dependencies by default. For a smaller local image when audio masking is not needed:

```bash
INSTALL_ALIGNMENT_DEPS=false docker compose build backend worker
docker compose up
```

Open:

- App: <http://localhost:8080>
- API docs: <http://localhost:8080/docs>

Development users are created automatically on Docker startup:

```text
admin@outcomes.ai      Admin@123      ADMIN
annotator@outcomes.ai  Annotator@123  ANNOTATOR
reviewer@outcomes.ai   Reviewer@123   REVIEWER
```

## Local Development

Backend:

```bash
cd apps/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -r requirements-alignment.txt  # enables Wav2Vec2 forced alignment
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

Frontend:

```bash
cd apps/frontend
npm install
npm run dev
```

Root helpers:

```bash
make backend-install
make backend-test
make frontend-install
make frontend-test
make frontend-build
make e2e-test
```

## Environment

Copy `.env.example` to `.env` and replace all production secrets before deploying.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Backend SQLAlchemy connection string. |
| `JWT_SECRET_KEY` | Access-token signing secret. |
| `JWT_REFRESH_SECRET_KEY` | Refresh-token signing secret. |
| `AUDIO_SIGNING_SECRET` | Signed media URL secret. |
| `NEXT_PUBLIC_API_URL` | Browser-facing API base URL. |
| `REDIS_URL` | Queue and rate-limit Redis connection. |
| `UPLOAD_DIR` | Backend upload storage location. |
| `HIRING_AUDIO_IMPORT_ROOTS` | Comma-separated backend-accessible folders admins may import hiring WAV files from. Mount host folders into Docker before using these paths. |
| `HIRING_AUDIO_IMPORT_MAX_FILES` | Maximum WAV files accepted in one hiring import. Defaults to `5000`. |
| `HIRING_AUDIO_IMPORT_MIN_FREE_BYTES` | Minimum disk space to keep free after hiring audio import preflight. Defaults to `1073741824` bytes. |

The API rejects default secrets when `ENVIRONMENT` is set to `production` or `prod`.

## Testing

Backend:

```bash
cd apps/backend
source .venv/bin/activate
pytest
```

Frontend:

```bash
cd apps/frontend
npm run test
npm run build
```

E2E smoke tests:

```bash
docker compose up -d --build
E2E_BASE_URL=http://localhost:8080 npm run test:e2e
docker compose down -v
```

## Operations Notes

- Migrations are managed with Alembic and should be forward-only.
- Background imports and exports run through Redis/RQ unless `JOBS_INLINE=true`.
- Uploaded files and generated exports live under `UPLOAD_DIR` and are intentionally ignored by Git.
- `scripts/seed.py` creates development users only; task data should come from uploaded annotation files.
- On Linux Docker hosts, Redis may require `vm.overcommit_memory=1` for reliable background persistence.
