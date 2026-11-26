#!/usr/bin/env python3
"""Repeated crash/restart timing under the fork-based supervisor.

Loads N keys (64-byte values, 30% with TTL), then repeats: DEBUG CRASH ->
poll every 2 ms until GET succeeds on a new run. Reports p50/p95/max of
end-to-end downtime and the server-side phases, for both a recent snapshot
and a long log tail.

    python scripts/bench_restart.py --keys 10000 100000 --runs 20
"""
from __future__ import annotations

import argparse
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(ROOT, "server")


def enc(*a) -> bytes:
    out = b"*%d\r\n" % len(a)
    for x in a:
        b = x if isinstance(x, bytes) else str(x).encode()
        out += b"$%d\r\n%s\r\n" % (len(b), b)
    return out


def call(port, *cmds, timeout=5.0):
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        s.sendall(b"".join(enc(*c) for c in cmds))
        f = s.makefile("rb")
        out = []
        for _ in cmds:
            line = f.readline()
            t, rest = line[:1], line[1:-2]
            if t == b"$":
                n = int(rest)
                out.append(None if n < 0 else f.read(n + 2)[:-2])
            elif t == b"-":
                out.append(RuntimeError(rest.decode()))
            else:
                out.append(rest.decode())
        return out


def info(port) -> dict:
    raw = call(port, ("INFO",))[0].decode()
    return dict(l.split(":", 1) for l in raw.splitlines() if ":" in l and not l.startswith("#"))


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def run(n: int, runs: int, snapshot: bool, backoff_after: str) -> dict:
    with tempfile.TemporaryDirectory() as d:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        sup = subprocess.Popen([sys.executable, "-m", "miniredis.supervise", "--port", str(port), "--dir", d,
                                "--enable-debug-command", "--log-level", "ERROR", "--snapshot-every-ops", "0",
                                "--snapshot-every-seconds", "0"], cwd=SERVER_DIR,
                               env={**os.environ, "MINIREDIS_SUPERVISE_BACKOFF_AFTER": backoff_after})
        try:
            while True:
                try:
                    if info(port)["status"] == "ready":
                        break
                except OSError:
                    time.sleep(0.01)
            v = b"x" * 64
            for i in range(0, n, 1000):
                call(port, *[("SET", f"key:{j:07d}", v, "EX", 3600) if j % 10 < 3 else ("SET", f"key:{j:07d}", v)
                             for j in range(i, min(i + 1000, n))], timeout=60)
            if snapshot:
                call(port, ("SAVE",), timeout=60)
            totals, phases = [], {"restart": [], "start": [], "recovery": [], "engine": []}
            for _ in range(runs):
                old = info(port)["run_id"]
                t0 = time.perf_counter()
                sent = time.time_ns() // 1_000_000
                try:
                    call(port, ("DEBUG", "CRASH"), timeout=1)
                except OSError:
                    pass
                while True:
                    try:
                        r = call(port, ("GET", "key:0000001"), ("INFO",), timeout=1)
                        if isinstance(r[0], bytes):
                            f = dict(l.split(":", 1) for l in r[1].decode().splitlines() if ":" in l and not l.startswith("#"))
                            if f["run_id"] != old:
                                break
                    except (OSError, IndexError):
                        pass
                    time.sleep(0.002)
                totals.append((time.perf_counter() - t0) * 1000)
                P, L, R = int(f["process_started_ms"]), int(f["listening_ms"]), int(f["ready_ms"])
                phases["restart"].append(max(0, P - sent))
                phases["start"].append(max(0, L - P))
                phases["recovery"].append(R - L)
                phases["engine"].append(float(f["recovery_duration_ms"]))
                replayed = int(f["recovery_replayed_ops"])
            return {"totals": totals, "phases": phases, "replayed": replayed}
        finally:
            sup.send_signal(signal.SIGTERM)
            sup.wait(30)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keys", type=int, nargs="+", default=[10_000, 100_000])
    ap.add_argument("--runs", type=int, default=20)
    ap.add_argument("--backoff-after", default="0",
                    help="supervisor crash-loop threshold; 0 (default here) disables back-off so every run measures a cold restart")
    a = ap.parse_args()
    print(f"{'dataset':<34}{'p50':>8}{'p95':>8}{'max':>8}   phases p50 (restart / start / recovery / engine)")
    for n in a.keys:
        for snap in (True, False):
            r = run(n, a.runs, snap, a.backoff_after)
            t = r["totals"]
            ph = {k: pct(v, 50) for k, v in r["phases"].items()}
            label = f"{n:,} keys, {'recent snapshot' if snap else 'log replay ' + format(r['replayed'], ',')}"
            print(f"{label:<34}{pct(t, 50):>7.0f}ms{pct(t, 95):>6.0f}ms{max(t):>6.0f}ms   "
                  f"{ph['restart']:.0f} / {ph['start']:.0f} / {ph['recovery']:.0f} / {ph['engine']:.1f} ms")


if __name__ == "__main__":
    main()
