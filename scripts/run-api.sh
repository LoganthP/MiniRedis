#!/usr/bin/env bash
# Run the dashboard API locally on :8000, talking to the database on :6380.
set -eu
cd "$(dirname "$0")/../api"
export DB_HOST="${DB_HOST:-127.0.0.1}" DB_PORT="${DB_PORT:-6380}"
export DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-admin}"
exec "${PYTHON:-python3}" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 "$@"
