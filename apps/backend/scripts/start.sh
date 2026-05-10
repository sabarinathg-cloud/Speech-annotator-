#!/usr/bin/env sh
set -e

export PYTHONPATH=/app

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"

alembic upgrade head
exec uvicorn app.main:app --host "$HOST" --port "$PORT"
