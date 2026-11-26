#!/usr/bin/env python3
"""Load, latency, memory and restart benchmark for MiniRedis.

For each dataset size it starts a fresh server in a temp directory and:

  1. loads N keys (values of --value-size bytes; 30% get a 1-hour TTL),
  2. runs closed-loop workloads (read-only, write-only, 80/20 mixed) with
     --clients concurrent connections for --seconds each, with the dashboard's
     polling pattern OFF and then ON (INFO + RECOVERY LAST every 2 s and a
     25-key SCAN page with PTTL/PEXPIRETIME/STRLEN every 5 s, like the UI),
  3. records server RSS memory,
  4. crash-under-load: SIGKILLs the server while all clients write, restarts
     it, and checks that every acknowledged write is present,
  5. measures end-to-end restart downtime: SIGKILL -> first successful GET
     (no supervisor delay; the benchmark restarts the process immediately).

    python scripts/bench_load.py --keys 10000 100000 --clients 16 --seconds 5
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import random
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(ROOT, "server")


def enc(*args) -> bytes:
    out = [b"*%d\r\n" % len(args)]
    for a in args:
        b = a if isinstance(a, bytes) else str(a).encode()
        out.append(b"$%d\r\n%s\r\n" % (len(b), b))
    return b"".join(out)


async def read_reply(r: asyncio.StreamReader):
    line = await r.readuntil(b"\r\n")
    t, rest = line[:1], line[1:-2]
    if t == b"+":
        return rest.decode()
    if t == b"-":
        return RuntimeError(rest.decode())
    if t == b":":
        return int(rest)
    if t == b"$":
        n = int(rest)
        return None if n < 0 else (await r.readexactly(n + 2))[:-2]
    if t == b"*":
        return [await read_reply(r) for _ in range(int(rest))]
    raise ValueError(line)


class Conn:
    def __init__(self, r, w):
        self.r, self.w = r, w

    @classmethod
    async def open(cls, port: int) -> "Conn":
        r, w = await asyncio.open_connection("127.0.0.1", port, limit=1 << 22)
        return cls(r, w)

    async def call(self, *args):
        self.w.write(enc(*args))
        await self.w.drain()
        return await read_reply(self.r)

    async def pipeline(self, cmds):
        self.w.write(b"".join(enc(*c) for c in cmds))
        await self.w.drain()
        return [await read_reply(self.r) for _ in cmds]

    def close(self):
        self.w.close()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(port: int, data_dir: str) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-m", "miniredis", "--port", str(port), "--dir", data_dir, "--log-level", "WARNING",
         "--snapshot-every-ops", "50000"], cwd=SERVER_DIR)


async def wait_ready(port: int, timeout: float = 60) -> float:
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < timeout:
        try:
            c = await Conn.open(port)
            info = await c.call("INFO", "persistence")
            c.close()
            if isinstance(info, bytes) and b"status:ready" in info:
                return time.perf_counter() - t0
        except OSError:
            pass
        await asyncio.sleep(0.005)
    raise TimeoutError("server not ready")


def rss_mb(pid: int) -> float:
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except OSError:
        pass
    return float("nan")


def pct(xs: list[float], p: float) -> float:
    if not xs:
        return float("nan")
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


async def load(port: int, n: int, value: bytes) -> float:
    c = await Conn.open(port)
    t0 = time.perf_counter()
    batch = 500
    for i in range(0, n, batch):
        cmds = []
        for j in range(i, min(i + batch, n)):
            cmds.append(("SET", f"key:{j:07d}", value, "EX", 3600) if j % 10 < 3 else ("SET", f"key:{j:07d}", value))
        await c.pipeline(cmds)
    c.close()
    return time.perf_counter() - t0


async def dashboard_poller(port: int, stop: asyncio.Event) -> None:
    """Mimics an open dashboard tab (Durability + Keys views, live mode)."""
    c = await Conn.open(port)
    last_scan = 0.0
    while not stop.is_set():
        await c.pipeline([("INFO",), ("RECOVERY", "LAST")])
        if time.monotonic() - last_scan > 5:
            nxt, keys = await c.call("SCAN", 0, "MATCH", "*", "COUNT", 25)
            await c.pipeline([cmd for k in keys for cmd in (("PTTL", k), ("PEXPIRETIME", k), ("STRLEN", k))])
            await c.call("DBSIZE")
            last_scan = time.monotonic()
        try:
            await asyncio.wait_for(stop.wait(), 2)
        except asyncio.TimeoutError:
            pass
    c.close()


async def snapshotter(port: int, stop: asyncio.Event, counter: list[int], every: float) -> None:
    """Periodic SAVEs (every `every` s; 0 = back-to-back) during a write workload."""
    c = await Conn.open(port)
    while not stop.is_set():
        await c.call("SAVE")
        counter[0] += 1
        if every:
            try:
                await asyncio.wait_for(stop.wait(), every)
            except asyncio.TimeoutError:
                pass
    c.close()


async def workload(port: int, n: int, value: bytes, kind: str, clients: int, seconds: float, dashboard: bool,
                   snapshots: float | None = None) -> dict:
    stop = asyncio.Event()
    lat_r: list[float] = []
    lat_w: list[float] = []

    async def client(i: int):
        c = await Conn.open(port)
        rnd = random.Random(i)
        while not stop.is_set():
            k = f"key:{rnd.randrange(n):07d}"
            write = kind == "write" or (kind == "mixed" and rnd.random() < 0.2)
            t = time.perf_counter()
            if write:
                await c.call("SET", k, value)
                lat_w.append((time.perf_counter() - t) * 1000)
            else:
                await c.call("GET", k)
                lat_r.append((time.perf_counter() - t) * 1000)
        c.close()

    tasks = [asyncio.create_task(client(i)) for i in range(clients)]
    if dashboard:
        tasks.append(asyncio.create_task(dashboard_poller(port, stop)))
    saves = [0]
    if snapshots is not None:
        tasks.append(asyncio.create_task(snapshotter(port, stop, saves, snapshots)))
    t0 = time.perf_counter()
    await asyncio.sleep(seconds)
    stop.set()
    await asyncio.gather(*tasks)
    el = time.perf_counter() - t0
    all_l = lat_r + lat_w
    return {
        "ops_per_sec": round(len(all_l) / el),
        "p50_ms": round(pct(all_l, 50), 3), "p95_ms": round(pct(all_l, 95), 3), "p99_ms": round(pct(all_l, 99), 3),
        "write_p95_ms": round(pct(lat_w, 95), 3) if lat_w else None,
        "read_p95_ms": round(pct(lat_r, 95), 3) if lat_r else None,
        **({"snapshots_during_run": saves[0]} if snapshots is not None else {}),
    }


async def crash_under_load(port: int, proc: subprocess.Popen, data_dir: str, clients: int) -> tuple[dict, subprocess.Popen]:
    acked: dict[str, bytes] = {}
    stop = asyncio.Event()

    async def writer(i: int):
        try:
            c = await Conn.open(port)
            j = 0
            while not stop.is_set():
                k, v = f"crash:{i}:{j}", f"v{j}".encode()
                r = await c.call("SET", k, v)
                if r == "OK":
                    acked[k] = v
                j += 1
        except (OSError, asyncio.IncompleteReadError, ValueError):
            return

    tasks = [asyncio.create_task(writer(i)) for i in range(clients)]
    await asyncio.sleep(1.5)
    proc.send_signal(signal.SIGKILL)
    proc.wait()
    stop.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    proc = start_server(port, data_dir)
    await wait_ready(port)
    c = await Conn.open(port)
    keys = list(acked)
    lost = 0
    for i in range(0, len(keys), 1000):
        chunk = keys[i:i + 1000]
        got = await c.pipeline([("GET", k) for k in chunk])
        lost += sum(1 for k, g in zip(chunk, got) if g != acked[k])
    c.close()
    return {"acked_writes": len(acked), "lost_after_restart": lost}, proc


async def restart_downtime(port: int, proc: subprocess.Popen, data_dir: str, snapshot: bool) -> tuple[dict, subprocess.Popen]:
    c = await Conn.open(port)
    if snapshot:
        await c.call("SAVE")
    c.close()
    t0 = time.perf_counter()
    proc.send_signal(signal.SIGKILL)
    proc.wait()
    proc = start_server(port, data_dir)
    while True:  # first successful command, measured from the kill
        try:
            c = await Conn.open(port)
            r = await c.call("GET", "key:0000001")
            c.close()
            if isinstance(r, bytes):
                break
        except OSError:
            pass
        await asyncio.sleep(0.002)
    total = (time.perf_counter() - t0) * 1000
    c = await Conn.open(port)
    info = (await c.call("INFO")).decode()
    c.close()
    f = dict(line.split(":", 1) for line in info.splitlines() if ":" in line and not line.startswith("#"))
    return {
        "kill_to_first_get_ms": round(total, 1),
        "process_start_to_ready_ms": int(f["ready_ms"]) - int(f["process_started_ms"]),
        "recovery_ms": float(f["recovery_duration_ms"]),
        "replayed_ops": int(f["recovery_replayed_ops"]),
        "snapshot_keys": int(f["recovery_snapshot_keys"]),
    }, proc


async def run_size(n: int, args) -> dict:
    value = (b"x" * args.value_size)
    out: dict = {"keys": n, "value_bytes": args.value_size}
    with tempfile.TemporaryDirectory() as d:
        port = free_port()
        proc = start_server(port, d)
        try:
            await wait_ready(port)
            out["load_writes_per_sec"] = round(n / await load(port, n, value))
            out["rss_mb_after_load"] = round(rss_mb(proc.pid), 1)
            for kind in ("read", "write", "mixed"):
                for dash in (False, True):
                    r = await workload(port, n, value, kind, args.clients, args.seconds, dash)
                    out[f"{kind}{'+dashboard' if dash else ''}"] = r
            out["write+snapshot/1s"] = await workload(port, n, value, "write", args.clients, args.seconds, False, snapshots=1.0)
            out["write+snapshots nonstop"] = await workload(port, n, value, "write", args.clients, args.seconds, False, snapshots=0)
            out["rss_mb_after_workloads"] = round(rss_mb(proc.pid), 1)
            out["restart_log_replay"], proc = await restart_downtime(port, proc, d, snapshot=False)
            out["restart_snapshot"], proc = await restart_downtime(port, proc, d, snapshot=True)
            out["crash_under_load"], proc = await crash_under_load(port, proc, d, args.clients)
        finally:
            proc.send_signal(signal.SIGKILL)
            proc.wait()
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keys", type=int, nargs="+", default=[10_000, 100_000])
    ap.add_argument("--clients", type=int, default=16)
    ap.add_argument("--seconds", type=float, default=5)
    ap.add_argument("--value-size", type=int, default=64)
    ap.add_argument("--json", help="also write results to this file")
    args = ap.parse_args()
    meta = {"machine": platform.platform(), "python": platform.python_version(), "cpus": os.cpu_count(),
            "clients": args.clients, "seconds_per_workload": args.seconds, "appendfsync": "always"}
    print(json.dumps(meta))
    results = []
    for n in args.keys:
        r = asyncio.run(run_size(n, args))
        results.append(r)
        print(f"\n=== {n:,} keys · {args.value_size}-byte values · 30% with TTL · {args.clients} clients ===")
        print(f"load {r['load_writes_per_sec']:,} writes/s (pipelined) · RSS {r['rss_mb_after_load']} MB after load, "
              f"{r['rss_mb_after_workloads']} MB after workloads")
        print(f"{'workload':<24}{'ops/s':>9}{'p50 ms':>9}{'p95 ms':>9}{'p99 ms':>9}")
        for k in ("read", "read+dashboard", "write", "write+dashboard", "write+snapshot/1s", "write+snapshots nonstop", "mixed", "mixed+dashboard"):
            w = r[k]
            extra = f"   ({w['snapshots_during_run']} snapshots during run)" if "snapshots_during_run" in w else ""
            print(f"{k:<24}{w['ops_per_sec']:>9,}{w['p50_ms']:>9}{w['p95_ms']:>9}{w['p99_ms']:>9}{extra}")
        for k in ("restart_log_replay", "restart_snapshot"):
            x = r[k]
            print(f"{k:<20} kill→first GET {x['kill_to_first_get_ms']} ms · start→ready {x['process_start_to_ready_ms']} ms · "
                  f"recovery {x['recovery_ms']} ms · replayed {x['replayed_ops']:,} · snapshot keys {x['snapshot_keys']:,}")
        c = r["crash_under_load"]
        print(f"crash under load     {c['acked_writes']:,} acknowledged writes, {c['lost_after_restart']} lost after restart")
    if args.json:
        with open(args.json, "w") as f:
            json.dump({"meta": meta, "results": results}, f, indent=2)


if __name__ == "__main__":
    main()
