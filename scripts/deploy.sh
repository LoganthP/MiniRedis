#!/usr/bin/env bash
# One-command deployment on a Linux host with Docker.
#   scripts/deploy.sh --profile private     # real data (default)
#   scripts/deploy.sh --profile demo        # disposable demo with chaos lab
#   scripts/deploy.sh --https               # also start Caddy (needs DOMAIN in .env)
set -euo pipefail
cd "$(dirname "$0")/.."
profile=private; https=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile="$2"; shift 2 ;;
    --https) https=1; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
[ -f "deploy/$profile.env" ] || { echo "no such profile: $profile (use private or demo)"; exit 2; }
command -v docker >/dev/null || { echo "Docker is not installed: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (docker compose ...)"; exit 1; }

gen() { head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-24; }
if [ ! -f .env ]; then
  sed "s/__GENERATE__/GEN/" "deploy/$profile.env" | while IFS= read -r line; do
    case "$line" in *=GEN*) echo "${line%%=*}=$(gen)${line#*=GEN}";; *) echo "$line";; esac
  done > .env
  chmod 600 .env
  echo "created .env from the '$profile' profile (secrets generated)"
else
  echo "using existing .env"
fi
set -a; . ./.env; set +a

compose=(docker compose)
[ "$https" = 1 ] && compose+=(--profile https)
"${compose[@]}" up -d --build

echo -n "waiting for the database to finish recovery"
for _ in $(seq 1 60); do
  if docker compose exec -T db python -m miniredis.healthcheck >/dev/null 2>&1; then ok=1; break; fi
  echo -n "."; sleep 1
done
echo
[ "${ok:-0}" = 1 ] || { echo "database did not become ready; see: docker compose logs db"; exit 1; }
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT:-8081}/api/health" >/dev/null 2>&1; then web=1; break; fi
  sleep 1
done
[ "${web:-0}" = 1 ] || { echo "dashboard not responding; see: docker compose logs web api"; exit 1; }

echo
echo "MiniRedis is running."
echo "  Dashboard:  http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):${WEB_PORT:-8081}   (bound to ${WEB_BIND:-0.0.0.0})"
[ -n "${DOMAIN:-}" ] && [ "$https" = 1 ] && echo "  HTTPS:      https://$DOMAIN"
echo "  Password:   DASHBOARD_PASSWORD in .env"
echo "  Next:       scripts/smoke-test.sh   (container replacement + persistence check)"
