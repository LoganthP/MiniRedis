#!/usr/bin/env python3
"""Measure cold-restart recovery time.

Starts a fresh server in a temp directory, loads N small keys, kills the
process with SIGKILL, restarts it and measures wall-clock time from process
start until INFO reports status:ready. Runs twice: once with every key only in
the append-only log, once right after a snapshot.

    python scripts/bench_recovery.py --keys 10000
"""
from __future__ import annotations

import argparse
import os
import platform
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(ROOT, "server")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def cmd(*args: str) -> bytes:
    out = [b"*%d\r\n" % len(args)]
    for a in args:
        b = a.encode()
        out.append(b"$%d\r\n%s\r\n" % (len(b), b))
    return b"".join(out)


def request(port: int, payload: bytes, replies: int) -> bytes:
    with socket.create_connection(("127.0.0.1", port), timeout=60) as s:
        s.sendall(payload)
        buf = b""
        while buf.count(b"\r\n") < replies:
            chunk = s.recv(1 << 16)
            if not chunk:
                break
            buf += chunk
        return buf


def info(port: int) -> dict:
    raw = request(port, cmd("INFO", "persistence"), 2)
    while not raw.endswith(b"\r\n\r\n"):
        raw += b""  # INFO fits in one read in practice
        break
    out = {}
    for line in raw.decode().splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            out[k] = v
    return out


def start(port: int, data_dir: str) -> tuple[subprocess.Popen, float]:
    t0 = time.perf_counter()
    p = subprocess.Popen([sys.executable, "-m", "miniredis", "--port", str(port), "--dir", data_dir,
                          "--snapshot-every-ops", "0", "--snapshot-every-seconds", "0", "--log-level", "WARNING"],
                         cwd=SERVER_DIR)
    while True:
        try:
            if info(port).get("status") == "ready":
                return p, time.perf_counter() - t0
        except OSError:
            pass
        time.sleep(0.01)


def load(port: int, n: int) -> None:
    batch = 1000
    for i in range(0, n, batch):
        payload = b"".join(cmd("SET", f"key:{j:06d}", f"value-{j}") for j in range(i, min(i + batch, n)))
        request(port, payload, min(batch, n - i))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keys", type=int, default=10_000)
    a = ap.parse_args()
    print(f"machine: {platform.platform()} | python {platform.python_version()} | cpus {os.cpu_count()}")
    print(f"dataset: {a.keys} keys, ~16-byte values\n")
    for label, snapshot in (("log only (no snapshot)", False), ("recent snapshot", True)):
        with tempfile.TemporaryDirectory() as d:
            port = free_port()
            p, _ = start(port, d)
            t = time.perf_counter()
            load(port, a.keys)
            load_s = time.perf_counter() - t
            if snapshot:
                request(port, cmd("SAVE"), 1)
            p.send_signal(signal.SIGKILL)
            p.wait()
            p, ready_s = start(port, d)
            i = info(port)
            print(f"{label:24s} restart-to-ready {ready_s*1000:8.1f} ms | recovery {float(i['recovery_duration_ms']):8.1f} ms"
                  f" | replayed {i['recovery_replayed_ops']:>6} | snapshot keys {i['recovery_snapshot_keys']:>6}"
                  f" | load {a.keys/load_s:,.0f} writes/s (fsync always)")
            p.send_signal(signal.SIGKILL)
            p.wait()


if __name__ == "__main__":
    main()
