"""The fork-based supervisor restarts a crashed server almost instantly."""
import os
import signal
import subprocess
import sys
import time

from conftest import SERVER_DIR, Conn, free_port


def _info(port):
    c = Conn(port)
    raw = c("INFO").decode()
    c.close()
    return dict(line.split(":", 1) for line in raw.splitlines() if ":" in line and not line.startswith("#"))


def _wait_ready(port, run_id=None, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            i = _info(port)
            if i["status"] == "ready" and i["run_id"] != run_id:
                return i
        except OSError:
            pass
        time.sleep(0.005)
    raise TimeoutError


def test_supervisor_restarts_after_crash_and_stops_on_sigterm(tmp_path):
    port = free_port()
    p = subprocess.Popen([sys.executable, "-m", "miniredis.supervise", "--port", str(port), "--dir", str(tmp_path),
                          "--enable-debug-command", "--log-level", "WARNING"], cwd=SERVER_DIR)
    try:
        first = _wait_ready(port)
        c = Conn(port)
        c("SET", "k", "v")
        c.send("DEBUG", "CRASH")
        t0 = time.time()
        second = _wait_ready(port, first["run_id"])
        assert time.time() - t0 < 2
        assert int(second["process_id"]) != int(first["process_id"])
        # Forked from a warm parent: process start -> listening is fast.
        assert int(second["listening_ms"]) - int(second["process_started_ms"]) < 150
        assert Conn(port)("GET", "k") == b"v"
        assert p.poll() is None  # supervisor itself is still running
        p.send_signal(signal.SIGTERM)
        assert p.wait(10) == 0
    finally:
        if p.poll() is None:
            p.kill()


def test_child_does_not_outlive_a_killed_supervisor(tmp_path):
    port = free_port()
    p = subprocess.Popen([sys.executable, "-m", "miniredis.supervise", "--port", str(port), "--dir", str(tmp_path),
                          "--log-level", "WARNING"], cwd=SERVER_DIR)
    child = int(_wait_ready(port)["process_id"])
    p.kill()
    p.wait()
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    os.kill(child, signal.SIGKILL)
    raise AssertionError("server child kept running after the supervisor was killed")


def test_crash_loop_backoff_only_for_early_deaths(tmp_path):
    port = free_port()
    env = {**os.environ, "MINIREDIS_SUPERVISE_BACKOFF_AFTER": "2"}
    p = subprocess.Popen([sys.executable, "-m", "miniredis.supervise", "--port", str(port), "--dir", str(tmp_path),
                          "--enable-debug-command", "--log-level", "WARNING"], cwd=SERVER_DIR, env=env,
                         stderr=subprocess.PIPE, text=True)
    try:
        run_id = _wait_ready(port)["run_id"]
        times = []
        for _ in range(4):
            t0 = time.time()
            Conn(port).send("DEBUG", "CRASH")
            run_id = _wait_ready(port, run_id, timeout=15)["run_id"]
            times.append(time.time() - t0)
        assert max(times[:2]) < 1.0       # first crashes restart immediately
        assert times[3] >= 0.15           # then the crash loop is throttled
    finally:
        p.terminate()
        p.wait(10)
