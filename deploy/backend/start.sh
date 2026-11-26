#!/usr/bin/env bash
# Start the database supervisor and the API in one container. If either one
# exits, stop the other and exit, so the platform restarts the container.
set -u
APP=${APP_DIR:-/app}
: "${MINIREDIS_DIR:=/data}" "${PORT:=8000}" "${DB_PORT:=6380}"
: "${REPORTS_DIR:=$MINIREDIS_DIR/reports}"
export MINIREDIS_DIR PORT DB_PORT REPORTS_DIR
if [ "$(id -u)" = 0 ] && id miniredis >/dev/null 2>&1; then
  # A freshly mounted volume is owned by root: hand it to the service user, then drop privileges.
  mkdir -p "$MINIREDIS_DIR" "$REPORTS_DIR"
  chown -R miniredis "$MINIREDIS_DIR" "$REPORTS_DIR"
  exec setpriv --reuid=miniredis --regid=miniredis --init-groups "$0" "$@"
fi
mkdir -p "$MINIREDIS_DIR" "$REPORTS_DIR" 2>/dev/null
if ! touch "$MINIREDIS_DIR/.write-test" 2>/dev/null; then
  echo "start.sh: $MINIREDIS_DIR is not writable by $(id -un); the database cannot persist anything." >&2
  exit 1
fi
rm -f "$MINIREDIS_DIR/.write-test"
if [ -z "${DASHBOARD_PASSWORD:-}" ]; then
  echo "start.sh: DASHBOARD_PASSWORD is not set; refusing to start a public dashboard without a password." >&2
  exit 1
fi
debug=()
case "${ALLOW_CRASH_DEMO:-true}" in 1|true|TRUE|True|yes|on) debug=(--enable-debug-command) ;; esac

cd "$APP/server"
python -m miniredis.supervise --host 127.0.0.1 --port "$DB_PORT" --dir "$MINIREDIS_DIR" "${debug[@]}" &
db_pid=$!

cd "$APP/api"
python -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --proxy-headers --forwarded-allow-ips='*' &
api_pid=$!

term() { kill -TERM "$api_pid" "$db_pid" 2>/dev/null; wait "$api_pid" "$db_pid" 2>/dev/null; exit 0; }
trap term TERM INT
wait -n "$db_pid" "$api_pid"
code=$?
echo "start.sh: a backend process exited (code $code); stopping the other one." >&2
kill -TERM "$api_pid" "$db_pid" 2>/dev/null
wait 2>/dev/null
exit "$code"
