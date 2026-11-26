"""Server-side metric history and persistent run reports.

* MetricsHistory samples INFO every 2 s (one small request) and keeps 30
  minutes in memory, so charts are aggregated on the server and every
  dashboard tab reads the same bounded series instead of polling INFO itself.
* ReportStore keeps crash-lab / workload reports as JSON lines in
  REPORTS_DIR (a Docker volume in production), so "last verified recovery"
  and run comparisons survive API restarts.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import threading
import time
from collections import deque

from .resp_client import ReplyError, RespClient, Unreachable

SAMPLE_EVERY_S = 2.0
KEEP_POINTS = 900  # 30 minutes


def _parse_info(raw: bytes) -> dict:
    out: dict = {}
    for line in raw.decode("utf-8", "replace").splitlines():
        if ":" in line and not line.startswith("#"):
            k, v = line.split(":", 1)
            out[k] = v
    return out


class MetricsHistory:
    def __init__(self, client: RespClient) -> None:
        self.client = client
        self.points: deque[dict] = deque(maxlen=KEEP_POINTS)
        self.task: asyncio.Task | None = None
        self._prev: dict | None = None

    def start(self) -> None:
        self.task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

    async def _loop(self) -> None:
        while True:
            await self.sample()
            await asyncio.sleep(SAMPLE_EVERY_S)

    async def sample(self) -> None:
        t = int(time.time() * 1000)
        try:
            i = _parse_info(await self.client.call("INFO"))
        except (Unreachable, ReplyError):
            self.points.append({"t": t, "status": "offline"})
            self._prev = None
            return
        ks = i.get("db0", "")
        parts = dict(kv.split("=") for kv in ks.split(",")) if ks else {}
        point = {
            "t": t,
            "status": i.get("status", "unknown"),
            "keys": int(parts.get("keys", 0)),
            "expires": int(parts.get("expires", 0)),
            "dataset_bytes": int(i.get("used_memory_dataset", 0)),
            "expired_total": int(i.get("expired_keys", 0)),
            "writes_total": int(i.get("total_writes", 0)),
            "hits_total": int(i.get("keyspace_hits", 0)),
            "misses_total": int(i.get("keyspace_misses", 0)),
            "ops_per_sec": float(i.get("instantaneous_ops_per_sec", 0)),
            "read_p95_ms": float(i.get("read_latency_p95_ms", 0)),
            "write_p95_ms": float(i.get("write_latency_p95_ms", 0)),
            "run_id": i.get("run_id"),
        }
        prev = self._prev
        # Per-interval rates; reset when the server restarted (counters start over).
        if prev and prev.get("run_id") == point["run_id"]:
            dt = max((t - prev["t"]) / 1000, 0.001)
            point["expired_per_sec"] = round((point["expired_total"] - prev["expired_total"]) / dt, 2)
            point["writes_per_sec"] = round((point["writes_total"] - prev["writes_total"]) / dt, 2)
            dh = point["hits_total"] - prev["hits_total"]
            dm = point["misses_total"] - prev["misses_total"]
            point["hit_rate"] = round(dh / (dh + dm), 4) if dh + dm else None
        self.points.append(point)
        self._prev = point

    def series(self, minutes: int) -> list[dict]:
        cutoff = int(time.time() * 1000) - minutes * 60_000
        return [p for p in self.points if p["t"] >= cutoff]


class ReportStore:
    MAX = 200

    def __init__(self, directory: str) -> None:
        self.dir = directory
        os.makedirs(directory, exist_ok=True)
        self.path = os.path.join(directory, "reports.jsonl")
        self.lock = threading.Lock()

    def add(self, kind: str, report: dict) -> dict:
        entry = {"id": secrets.token_hex(6), "kind": kind, "created_ms": int(time.time() * 1000), **report}
        with self.lock:
            lines = self._read_lines()
            lines.append(json.dumps(entry, separators=(",", ":")))
            lines = lines[-self.MAX:]
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        return entry

    def _read_lines(self) -> list[str]:
        try:
            with open(self.path, encoding="utf-8") as f:
                return [ln for ln in f.read().splitlines() if ln.strip()]
        except FileNotFoundError:
            return []

    def list(self, kind: str | None = None) -> list[dict]:
        out = []
        for ln in self._read_lines():
            try:
                e = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if kind is None or e.get("kind") == kind:
                out.append(e)
        return list(reversed(out))

    def get(self, rid: str) -> dict | None:
        return next((e for e in self.list() if e.get("id") == rid), None)
