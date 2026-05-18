#!/usr/bin/env sh
set -e

export PYTHONPATH=/app

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"

alembic upgrade head

case "$(printf "%s" "${AUTO_SEED_DEV_USERS:-false}" | tr "[:upper:]" "[:lower:]")" in
  1|true|yes)
    python /app/scripts/seed.py
    ;;
esac

exec uvicorn app.main:app --host "$HOST" --port "$PORT"
