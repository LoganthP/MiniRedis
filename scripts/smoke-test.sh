#!/usr/bin/env bash
# Post-deploy check: write a key, replace the db container, confirm the key and
# its expiry deadline come back from the persistent volume, and that the
# dashboard reconnects on its own.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
cli() { docker compose exec -T db python -m miniredis.cli "$@"; }
key="smoke:$(date +%s)"
cli SET "$key" ok EX 3600 >/dev/null
before=$(cli PEXPIRETIME "$key")
echo "wrote $key (deadline $before); replacing the db container…"
docker compose up -d --force-recreate --no-deps db >/dev/null
for _ in $(seq 1 60); do docker compose exec -T db python -m miniredis.healthcheck >/dev/null 2>&1 && break; sleep 1; done
val=$(cli GET "$key"); after=$(cli PEXPIRETIME "$key")
[ "$val" = "ok" ] || { echo "FAIL: value after replacement: $val"; exit 1; }
[ "$before" = "$after" ] || { echo "FAIL: deadline changed: $before -> $after"; exit 1; }
for _ in $(seq 1 20); do
  st=$(curl -fsS "http://127.0.0.1:${WEB_PORT:-8081}/api/health" | grep -o '"status":"[a-z]*"' || true)
  [ "$st" = '"status":"ready"' ] && break; sleep 0.5
done
[ "$st" = '"status":"ready"' ] || { echo "FAIL: dashboard API did not reconnect ($st)"; exit 1; }
cli DEL "$key" >/dev/null
echo "PASS: data and deadline survived container replacement; dashboard reconnected."
