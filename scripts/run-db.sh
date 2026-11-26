#!/usr/bin/env bash
# Run the database locally under the fork-based supervisor: a crash
# (kill -9 of the server process, or DEBUG CRASH from the chaos lab) is
# restarted immediately, like in Docker. Ctrl+C stops it cleanly.
set -eu
cd "$(dirname "$0")/../server"
exec "${PYTHON:-python3}" -m miniredis.supervise --host 127.0.0.1 \
  --port "${MINIREDIS_PORT:-6380}" --dir "${MINIREDIS_DIR:-../data}" --enable-debug-command "$@"
