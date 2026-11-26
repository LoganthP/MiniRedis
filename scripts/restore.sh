#!/usr/bin/env bash
# Restore a backup made by backup.sh into the database volume.
#   scripts/restore.sh backups/miniredis-YYYYmmdd-HHMMSS.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
file="${1:?usage: scripts/restore.sh <backup.tar.gz>}"
[ -f "$file" ] || { echo "no such file: $file"; exit 1; }
echo "This replaces ALL data in the database volume with $file."
read -r -p "Type 'restore' to continue: " ok
[ "$ok" = "restore" ] || { echo "aborted"; exit 1; }
docker compose stop db
docker compose run --rm --no-deps -T --entrypoint sh db -c 'rm -rf /data/* && tar xzf - -C /data' < "$file"
docker compose start db
echo "restored; watch recovery on the dashboard's Recovery page or with: docker compose logs -f db"
