#!/usr/bin/env python3
"""Repeatable durability scenario: concurrent durable writes, a snapshot, and a
crash/restart, measured over several trials.

For each dataset size and trial (fresh server under the fork supervisor):

  A. baseline      16 clients doing durable SETs (appendfsync=always) for --phase-seconds
  B. snapshot      the same traffic while a SAVE of the whole dataset runs
  C. crash         the same traffic, then DEBUG CRASH mid-stream; measure time to
                   the first successful GET and check every acknowledged write

Per phase: write throughput, p50/p95/p99 ack latency, max write-queue depth and
disk-sync (log write + fsync) p95 sampled from INFO every 100 ms. Per trial:
snapshot duration, downtime, recovery timer, acknowledged/lost writes, peak RSS.

    python scripts/bench_scenario.py --keys 10000 100000 --trials 3 --json docs/scenario-results.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench_load import Conn, enc, pct, read_reply, rss_mb  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(ROOT, "server")
CLIENTS = 16


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def info(port: int) -> dict:
    c = await Conn.open(port)
    raw = (await c.call("INFO")).decode()
    c.close()
    return dict(l.split(":", 1) for l in raw.splitlines() if ":" in l and not l.startswith("#"))


async def wait_ready(port: int, old_run: str | None = None, timeout: float = 60) -> dict:
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        try:
            i = await info(port)
            if i["status"] == "ready" and i["run_id"] != old_run:
                return i
        except (OSError, asyncio.IncompleteReadError, ValueError):
            pass
        await asyncio.sleep(0.002)
    raise TimeoutError


class Traffic:
    """CLIENTS closed-loop writers; records ack latency and acknowledged keys."""

    def __init__(self, port: int, tag: str):
        self.port, self.tag = port, tag
        self.lat: list[float] = []
        self.samples: list[tuple[float, float]] = []  # (issued at, latency ms)
        self.acked: dict[bytes, bytes] = {}
        self.stop = asyncio.Event()
        self.tasks: list[asyncio.Task] = []

    async def _client(self, n: int):
        try:
            c = await Conn.open(self.port)
        except OSError:
            return
        i = 0
        try:
            while not self.stop.is_set():
                k = f"w:{self.tag}:{n}:{i}".encode()
                v = b"v%d" % i
                t = time.perf_counter()
                r = await c.call("SET", k, v)
                if r == "OK":
                    self.lat.append((time.perf_counter() - t) * 1000)
                    self.samples.append((t, self.lat[-1]))
                    self.acked[k] = v
                i += 1
        except (OSError, asyncio.IncompleteReadError, ValueError):
            return
        finally:
            c.close()

    def start(self):
        self.t0 = time.perf_counter()
        self.tasks = [asyncio.create_task(self._client(n)) for n in range(CLIENTS)]

    async def finish(self) -> dict:
        self.stop.set()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        el = time.perf_counter() - self.t0
        return {"writes_per_sec": round(len(self.lat) / el), "p50_ms": round(pct(self.lat, 50), 2),
                "p95_ms": round(pct(self.lat, 95), 2), "p99_ms": round(pct(self.lat, 99), 2), "samples": len(self.lat)}


async def sampler(port: int, stop: asyncio.Event, out: dict, pid_holder: list):
    """Max queue depth, disk-sync p95 and peak RSS while a phase runs."""
    while not stop.is_set():
        try:
            i = await info(port)
            out["queue_max"] = max(out.get("queue_max", 0), int(i["write_queue_depth"]))
            out["sync_p95_ms"] = max(out.get("sync_p95_ms", 0.0), float(i["log_batch_latency_p95_ms"]))
            out["writes_per_sync"] = float(i["log_batch_avg_writes"])
            pid_holder[0] = int(i["process_id"])
            out["peak_rss_mb"] = max(out.get("peak_rss_mb", 0.0), rss_mb(pid_holder[0]))
        except (OSError, asyncio.IncompleteReadError, ValueError, KeyError):
            pass
        await asyncio.sleep(0.1)


async def phase(port: int, tag: str, seconds: float, pid_holder: list, during=None) -> dict:
    tr = Traffic(port, tag)
    stop = asyncio.Event()
    stats: dict = {}
    s = asyncio.create_task(sampler(port, stop, stats, pid_holder))
    tr.start()
    extra = {}
    if during:
        extra = await during()
    else:
        await asyncio.sleep(seconds)
    res = await tr.finish()
    stop.set()
    await s
    win = extra.pop("_window", None)
    if win:
        inside = [l for (t, l) in tr.samples if win[0] <= t <= win[1]]
        extra["in_snapshot_window"] = {"samples": len(inside), "p95_ms": round(pct(inside, 95), 2) if inside else None,
                                       "p99_ms": round(pct(inside, 99), 2) if inside else None,
                                       "max_ms": round(max(inside), 2) if inside else None}
    return {**res, **stats, **extra}


async def trial(n: int, seconds: float) -> dict:
    with tempfile.TemporaryDirectory() as d:
        port = free_port()
        sup = subprocess.Popen([sys.executable, "-m", "miniredis.supervise", "--port", str(port), "--dir", d,
                                "--enable-debug-command", "--log-level", "ERROR",
                                "--snapshot-every-ops", "0", "--snapshot-every-seconds", "0"],
                               cwd=SERVER_DIR, env={**os.environ, "MINIREDIS_SUPERVISE_BACKOFF_AFTER": "0"})
        pid_holder = [0]
        try:
            await wait_ready(port)
            c = await Conn.open(port)
            v = b"x" * 64
            for i in range(0, n, 1000):
                await c.pipeline([("SET", f"key:{j:07d}", v, "EX", 3600) if j % 10 < 3 else ("SET", f"key:{j:07d}", v)
                                  for j in range(i, min(i + 1000, n))])
            await c.call("SAVE")
            c.close()

            out: dict = {"keys": n}
            out["baseline"] = await phase(port, "a", seconds, pid_holder)

            async def do_snapshot():
                await asyncio.sleep(seconds / 3)  # some steady traffic first
                sc = await Conn.open(port)
                t = time.perf_counter()
                await sc.call("SAVE")
                t_end = time.perf_counter()
                sc.close()
                dur = (t_end - t) * 1000
                if dur < seconds * 1000:
                    await asyncio.sleep(max(0.0, seconds - dur / 1000))
                return {"snapshot_ms": round(dur, 1), "_window": (t, t_end)}
            out["during_snapshot"] = await phase(port, "b", seconds, pid_holder, during=do_snapshot)

            # C: crash under load
            before = await info(port)
            tr = Traffic(port, "c")
            tr.start()
            await asyncio.sleep(seconds / 2)
            cc = await Conn.open(port)
            t_crash = time.perf_counter()
            cc.w.write(enc("DEBUG", "CRASH"))
            await cc.w.drain()
            cc.close()
            await asyncio.gather(*tr.tasks, return_exceptions=True)
            # time to first successful command on the new process
            while True:
                try:
                    g = await Conn.open(port)
                    r = await g.call("GET", "key:0000001")
                    i2 = (await g.call("INFO")).decode()
                    g.close()
                    f = dict(l.split(":", 1) for l in i2.splitlines() if ":" in l and not l.startswith("#"))
                    if isinstance(r, bytes) and f["run_id"] != before["run_id"]:
                        break
                except (OSError, asyncio.IncompleteReadError, ValueError):
                    pass
                await asyncio.sleep(0.002)
            downtime = (time.perf_counter() - t_crash) * 1000
            g = await Conn.open(port)
            keys = list(tr.acked)
            lost = 0
            for i in range(0, len(keys), 1000):
                ch = keys[i:i + 1000]
                got = await g.pipeline([("GET", k) for k in ch])
                lost += sum(1 for k, x in zip(ch, got) if x != tr.acked[k])
            g.close()
            out["crash"] = {"acked_writes": len(keys), "lost": lost, "pass": lost == 0 and len(keys) > 0,
                            "first_success_ms": round(downtime, 1), "recovery_ms": float(f["recovery_duration_ms"]),
                            "replayed": int(f["recovery_replayed_ops"]),
                            "start_to_ready_ms": int(f["ready_ms"]) - int(f["process_started_ms"])}
            out["peak_rss_mb"] = max(out["baseline"].get("peak_rss_mb", 0), out["during_snapshot"].get("peak_rss_mb", 0),
                                     rss_mb(int(f["process_id"])))
            return out
        finally:
            sup.send_signal(signal.SIGTERM)
            try:
                sup.wait(30)
            except subprocess.TimeoutExpired:
                sup.kill()


def med(xs):
    return round(statistics.median(xs), 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keys", type=int, nargs="+", default=[10_000, 100_000])
    ap.add_argument("--trials", type=int, default=3)
    ap.add_argument("--phase-seconds", type=float, default=3.0)
    ap.add_argument("--json")
    a = ap.parse_args()
    env = {"machine": platform.platform(), "python": platform.python_version(), "cpus": os.cpu_count(),
           "durability": "appendfsync=always (OK only after fsync)", "clients": CLIENTS, "value_bytes": 64,
           "ttl_share": "30% of keys", "phase_seconds": a.phase_seconds, "trials": a.trials,
           "supervisor": "fork-based (miniredis.supervise)"}
    print(json.dumps(env))
    results = {}
    for n in a.keys:
        runs = [asyncio.run(trial(n, a.phase_seconds)) for _ in range(a.trials)]
        results[n] = runs
        print(f"\n=== {n:,} keys · {a.trials} trials · {CLIENTS} durable writers · medians ===")
        print(f"{'phase':<18}{'writes/s':>9}{'p50':>8}{'p95':>8}{'p99':>8}{'queue max':>11}{'sync p95':>10}")
        for ph in ("baseline", "during_snapshot"):
            rs = [r[ph] for r in runs]
            print(f"{ph:<18}{med([r['writes_per_sec'] for r in rs]):>9.0f}{med([r['p50_ms'] for r in rs]):>7}ms"
                  f"{med([r['p95_ms'] for r in rs]):>6}ms{med([r['p99_ms'] for r in rs]):>6}ms"
                  f"{med([r.get('queue_max', 0) for r in rs]):>11.0f}{med([r.get('sync_p95_ms', 0) for r in rs]):>8}ms")
        w = [r["during_snapshot"]["in_snapshot_window"] for r in runs]
        print(f"snapshot duration  {med([r['during_snapshot']['snapshot_ms'] for r in runs])} ms · writes acked inside the snapshot window:"
              f" {sum(x['samples'] for x in w):,} · p95 {med([x['p95_ms'] or 0 for x in w])} ms · p99 {med([x['p99_ms'] or 0 for x in w])} ms"
              f" · max {max(x['max_ms'] or 0 for x in w)} ms")
        cr = [r["crash"] for r in runs]
        print(f"crash under load   first success {med([c['first_success_ms'] for c in cr])} ms (max {max(c['first_success_ms'] for c in cr)})"
              f" · recovery timer {med([c['recovery_ms'] for c in cr])} ms · start→ready {med([c['start_to_ready_ms'] for c in cr])} ms")
        print(f"                   acknowledged {sum(c['acked_writes'] for c in cr):,} · lost {sum(c['lost'] for c in cr)}"
              f" · pass rate {sum(c['pass'] for c in cr)}/{len(cr)} · peak RSS {max(r['peak_rss_mb'] for r in runs):.1f} MB")
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"environment": env, "results": results}, f, indent=2)


if __name__ == "__main__":
    main()
