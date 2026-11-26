#!/usr/bin/env bash
# Restore a backup into a FRESH temporary directory inside the db container
# (the live volume is not touched), run real recovery on it, and compare a
# sample of keys and expiry deadlines with the running database.
#   scripts/verify-backup.sh backups/miniredis-YYYYmmdd-HHMMSS.tar.gz [--strict]
set -euo pipefail
cd "$(dirname "$0")/.."
file="${1:?usage: scripts/verify-backup.sh <backup.tar.gz> [--strict]}"; shift
docker compose exec -T db python -m miniredis.verify_backup - --compare 127.0.0.1:6380 --record /data --name "$(basename "$file")" "$@" < "$file"
