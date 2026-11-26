"""Fork-based supervisor ("zygote") for the database server.

    python -m miniredis.supervise [server options...]

Why: after a crash, most of the restart time is not recovery but starting a
fresh Python interpreter and importing asyncio & co. (hundreds of ms inside a
container), plus the container runtime's own restart delay. This supervisor
imports everything once, then fork()s the server. When the server process
dies, a new child is forked from the already-warm parent in about a
millisecond, and it goes straight to recovery.

Behaviour:
  * child exits 0 (SHUTDOWN, SIGTERM)    -> supervisor exits 0
  * child crashes (non-zero / signal)    -> restart immediately
  * crash loop: more than BACKOFF_AFTER children (default 3) died within
    their first 5 s of life, inside a 30 s window -> exponential back-off
    (0.2 s ... 5 s). A server that ran fine before crashing never waits.
    Set MINIREDIS_SUPERVISE_BACKOFF_AFTER=0 to disable back-off entirely.
  * the supervisor dies (even SIGKILL)   -> the child gets SIGTERM (Linux
    PR_SET_PDEATHSIG), so no orphan keeps holding the port
  * SIGTERM / SIGINT to the supervisor   -> forwarded to the child, then exit

Docker's restart policy stays as the outer safety net in case the supervisor
itself dies.
"""
from __future__ import annotations

import logging
import os
import signal
import sys
import time
import traceback
from collections import deque

# Pre-import everything the server needs, so forked children start warm.
from . import commands, db, persistence, resp, server, store  # noqa: F401
from .config import parse_args

log = logging.getLogger("miniredis.supervise")


def _die_with_parent(parent_pid: int) -> None:
    """Ask the kernel to SIGTERM us if the supervisor dies (Linux only)."""
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except (OSError, AttributeError):
        return
    if os.getppid() != parent_pid:  # parent already died before prctl ran
        os.kill(os.getpid(), signal.SIGTERM)


def _run_child(cfg, parent_pid: int) -> None:
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    _die_with_parent(parent_pid)
    code = 0
    try:
        server.main(cfg)
    except SystemExit as e:
        code = int(e.code or 0)
    except BaseException:  # pragma: no cover - crash path
        traceback.print_exc()
        code = 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    os._exit(code)


def main() -> int:
    cfg = parse_args()
    logging.basicConfig(level=cfg.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    child = 0
    stopping = False

    def forward(sig, _frame):
        nonlocal stopping
        stopping = True
        if child:
            try:
                os.kill(child, sig)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    backoff_after = int(os.environ.get("MINIREDIS_SUPERVISE_BACKOFF_AFTER", "3"))
    early_deaths: deque[float] = deque(maxlen=50)
    me = os.getpid()

    while True:
        started = time.monotonic()
        pid = os.fork()
        if pid == 0:
            _run_child(cfg, me)
        child = pid
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
        child = 0
        if stopping or code == 0:
            log.info("server exited with code %s; supervisor stopping", code)
            return 0 if code < 0 else code
        now = time.monotonic()
        if now - started < 5:  # died soon after start: possible crash loop
            early_deaths.append(now)
        recent = sum(1 for t in early_deaths if now - t < 30)
        delay = 0.0 if backoff_after <= 0 or recent <= backoff_after else min(5.0, 0.2 * 2 ** (recent - backoff_after - 1))
        log.warning("server exited with %s; restarting%s", code if code >= 0 else f"signal {-code}",
                    f" in {delay:.1f}s (crash loop back-off)" if delay else " now")
        if delay:
            time.sleep(delay)
            if stopping:
                return 0


if __name__ == "__main__":
    sys.exit(main())
