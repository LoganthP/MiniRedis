#!/usr/bin/env bash
# Take a fresh snapshot and copy the database volume to ./backups/.
# Copy the resulting file OFF the VPS (scp, rclone, object storage...).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
ts=$(date +%Y%m%d-%H%M%S)
out="backups/miniredis-$ts.tar.gz"
docker compose exec -T db python -m miniredis.cli SAVE
docker compose exec -T db tar czf - -C /data . > "$out"
echo "backup written to $out ($(du -h "$out" | cut -f1))"
