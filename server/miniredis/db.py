"""The database engine: status machine, serialized write path with group
commit, background tasks (expiry sweep, fsync, snapshots) and recovery."""
from __future__ import annotations

import asyncio
import inspect
import logging
import os
import secrets
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from . import resp
from .config import Config
from .persistence import (
    AppendLog, RecoveryError, RecoveryReport, append_history, encode_record, recover, write_snapshot,
)
from .store import Keyspace, Tx, now_ms

log = logging.getLogger("miniredis")

STARTING, RECOVERING, READY, DEGRADED = "starting", "recovering", "ready", "degraded"
VERSION = "1.0.0"


def process_start_ms() -> int:
    """Wall-clock time this process was created (includes interpreter start-up).

    Uses /proc/uptime (10 ms resolution) rather than btime (1 s resolution).
    Falls back to "now" on systems without /proc."""
    try:
        with open("/proc/self/stat") as f:
            start_ticks = int(f.read().rsplit(")", 1)[1].split()[19])
        with open("/proc/uptime") as f:
            uptime_s = float(f.read().split()[0])
        age_s = uptime_s - start_ticks / os.sysconf("SC_CLK_TCK")
        return now_ms() - int(max(age_s, 0) * 1000)
    except (OSError, ValueError, IndexError):
        return now_ms()


def percentiles(samples, ps=(50, 95, 99)) -> dict[int, float]:
    if not samples:
        return {p: 0.0 for p in ps}
    data = sorted(samples)
    n = len(data)
    return {p: round(data[min(n - 1, int(round(p / 100 * (n - 1))))], 3) for p in ps}


class CommandError(Exception):
    def __init__(self, msg: str) -> None:
        super().__init__(msg)
        self.msg = msg if msg.split(" ", 1)[0].isupper() else "ERR " + msg


def _fault(point: str) -> None:
    """Test-only crash injection: MINIREDIS_FAULT=<point> kills the process
    at that point, exactly like a power cut or SIGKILL would."""
    if os.environ.get("MINIREDIS_FAULT") == point:
        log.warning("fault injection: crashing at %s", point)
        os._exit(1)


class PersistenceFailure(Exception):
    pass


@dataclass
class Client:
    id: int
    addr: str
    authed: bool = False
    name: str = ""
    close_after_reply: bool = False
    created: float = field(default_factory=time.time)


@dataclass
class _Pending:
    tx: Tx
    data: bytes
    last_seq: int
    future: asyncio.Future


class Database:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.keyspace = Keyspace()
        self.status = STARTING
        self.recovery_error: str | None = None
        self.persist_error: str | None = None
        self.recovery: RecoveryReport | None = None
        self.aof: AppendLog | None = None
        self.started = time.time()
        # A fresh id per process: lets clients tell a restarted server apart
        # even when the PID is reused (PID 1 in every container start).
        self.run_id = secrets.token_hex(6)
        self.process_started_ms = process_start_ms()
        self.listening_ms: int | None = None
        self.recovery_started_ms: int | None = None
        self.ready_ms: int | None = None
        self.ready_at: float | None = None

        # write path
        self.seq = 0
        self.durable_seq = 0
        self.pending: list[_Pending] = []
        self.flushing = False
        self._flush_event = asyncio.Event()
        self.drained = asyncio.Event()
        self.drained.set()
        self.writes_open = asyncio.Event()
        self.writes_open.set()
        self._aof_io = ThreadPoolExecutor(max_workers=1, thread_name_prefix="aof")
        self._snap_io = ThreadPoolExecutor(max_workers=1, thread_name_prefix="snapshot")

        # snapshots
        self.snapshot_lock = asyncio.Lock()
        self.snapshot_seq = 0
        self.ops_since_snapshot = 0
        self.last_save_time = 0  # unix seconds
        self.last_save_duration_ms = 0.0
        self.last_save_status = "never"
        self.last_save_error: str | None = None
        self.last_save_bytes = 0
        self.snapshots_taken = 0
        self.last_snapshot_pause: dict = {}

        # stats
        self.clients: dict[int, Client] = {}
        self.next_client_id = 1
        self.total_connections = 0
        self.total_commands = 0
        self.total_writes = 0
        self.keyspace_hits = 0
        self.keyspace_misses = 0
        self.expired_keys = 0
        self.fsyncs = 0
        self.ops_per_sec = 0.0
        self._ops_sample = (time.monotonic(), 0)
        # rolling latency windows (milliseconds)
        self.lat_read: deque[float] = deque(maxlen=4096)
        self.lat_write: deque[float] = deque(maxlen=4096)
        self.lat_batch: deque[float] = deque(maxlen=1024)  # log write + fsync per batch
        self.batch_sizes: deque[int] = deque(maxlen=1024)
        self.queue_depth_max = 0

        self._tasks: list[asyncio.Task] = []
        self.shutting_down = False

    # ================================================================ lifecycle
    async def start(self) -> None:
        self.status = RECOVERING
        self.recovery_started_ms = now_ms()
        loop = asyncio.get_running_loop()
        await self._debug_recovery_delay()
        log.info("recovering from %s", os.path.abspath(self.cfg.dir))
        try:
            ks, rep = await loop.run_in_executor(self._snap_io, recover, self.cfg.dir)
        except (RecoveryError, OSError) as e:
            self.recovery_error = str(e)
            self.status = DEGRADED
            self.recovery = RecoveryReport(started_at_ms=now_ms(), ok=False, error=str(e))
            append_history(self.cfg.dir, {**self.recovery.to_dict(), "replay_tail": [], "at": time.time()})
            log.error("RECOVERY FAILED: %s -- refusing to serve data. Inspect or restore the data directory.", e)
            return
        self.keyspace = ks
        self.recovery = rep
        self.seq = self.durable_seq = self.snapshot_seq = rep.last_seq
        self.snapshot_seq = rep.snapshot_seq
        self.ops_since_snapshot = rep.replayed_ops
        if rep.snapshot_created_ms:
            self.last_save_time = rep.snapshot_created_ms // 1000
            self.last_save_status = "ok"
        self.aof = AppendLog(self.cfg.dir, self.cfg.appendfsync)
        await loop.run_in_executor(self._aof_io, self.aof.open_latest)
        log.info(
            "recovered %d keys in %.1f ms (snapshot=%s keys=%d, replayed=%d, truncated=%d bytes)",
            rep.keys_after, rep.duration_ms, rep.snapshot_loaded, rep.snapshot_keys, rep.replayed_ops, rep.truncated_bytes,
        )
        self.status = READY
        self.ready_at = time.time()
        self.ready_ms = now_ms()
        append_history(self.cfg.dir, {
            **rep.to_dict(), "replay_tail": [], "at": time.time(), "run_id": self.run_id,
            "process_started_ms": self.process_started_ms, "listening_ms": self.listening_ms,
            "ready_ms": self.ready_ms, "startup_ms": self.ready_ms - self.process_started_ms,
        })
        self._tasks.append(asyncio.create_task(self._flusher(), name="flusher"))
        self._tasks.append(asyncio.create_task(self._cron(), name="cron"))
        if rep.replayed_ops > 0 or rep.truncated_bytes:
            # Compact right away so the next restart starts from a fresh snapshot.
            asyncio.create_task(self.snapshot("post-recovery"))

    async def _debug_recovery_delay(self) -> None:
        """Honour a one-shot DEBUG CRASH SLOW marker (only with --enable-debug-command)."""
        path = os.path.join(self.cfg.dir, ".debug-recovery-delay")
        if not os.path.exists(path):
            return
        try:
            with open(path) as f:
                ms = min(max(int(f.read().strip() or 0), 0), 30000)
            os.unlink(path)
        except (OSError, ValueError):
            return
        if ms and self.cfg.enable_debug_command:
            log.warning("debug: simulating a slow recovery (%d ms)", ms)
            await asyncio.sleep(ms / 1000)

    async def shutdown(self, save: bool) -> None:
        if self.shutting_down:
            return
        self.shutting_down = True
        self.writes_open.clear()
        await self.drained.wait()
        # Let an in-flight snapshot (automatic, post-recovery or BGSAVE) finish
        # before the executors shut down, then take the final one.
        while self.snapshot_lock.locked():
            await asyncio.sleep(0.01)
        self.writes_open.clear()
        await self.drained.wait()
        if save and self.status == READY and not self.persist_error:
            try:
                await self.snapshot("shutdown", force=True)
            except Exception as e:  # pragma: no cover
                log.error("shutdown snapshot failed: %s", e)
        for t in self._tasks:
            t.cancel()
        if self.aof:
            try:
                await asyncio.get_running_loop().run_in_executor(self._aof_io, self.aof.close)
            except OSError as e:
                log.error("closing log failed: %s", e)
        self._aof_io.shutdown(wait=True)
        self._snap_io.shutdown(wait=True)
        log.info("shutdown complete")

    # ================================================================ command execution
    async def execute(self, client: Client, args: list[bytes]) -> bytes:
        from .commands import COMMANDS  # local import to avoid a cycle

        self.total_commands += 1
        name = args[0].lower()
        spec = COMMANDS.get(name)
        if spec is None:
            shown = args[0][:128].decode("utf-8", "replace")
            rest = " ".join("'" + a[:64].decode("utf-8", "replace") + "'" for a in args[1:6])
            return resp.error(f"ERR unknown command '{shown}', with args beginning with: {rest}")
        n = len(args)
        if (spec.arity > 0 and n != spec.arity) or (spec.arity < 0 and n < -spec.arity):
            return resp.error(f"ERR wrong number of arguments for '{spec.name}' command")
        if self.cfg.requirepass and not client.authed and not spec.noauth:
            return resp.error("NOAUTH Authentication required.")
        if not spec.loading_ok:
            if self.status in (STARTING, RECOVERING):
                return resp.error("LOADING MiniRedis is loading the dataset in memory")
            if self.recovery_error:
                return resp.error(f"ERR recovery failed: {self.recovery_error}")
        t0 = time.perf_counter()
        try:
            if spec.write:
                return await self._execute_write(spec, client, args)
            r = spec.handler(self, client, args, None)
            if inspect.isawaitable(r):
                r = await r
            return r
        except CommandError as e:
            return resp.error(e.msg)
        finally:
            if not spec.loading_ok and name not in (b"save", b"scan", b"keys"):
                (self.lat_write if spec.write else self.lat_read).append((time.perf_counter() - t0) * 1000)

    async def _execute_write(self, spec, client: Client, args: list[bytes]) -> bytes:
        if self.persist_error:
            return self._misconf()
        while not self.writes_open.is_set():
            await self.writes_open.wait()
            if self.persist_error:
                return self._misconf()
        if self.shutting_down:
            return resp.error("ERR server is shutting down")
        tx = Tx(self.keyspace)
        try:
            reply = spec.handler(self, client, args, tx)
        except BaseException:
            tx.rollback()
            raise
        if not tx.effects:
            return reply
        fut = self._submit(tx)
        try:
            await fut
        except PersistenceFailure:
            return self._misconf()
        self.total_writes += 1
        return reply

    def try_submit_write(self, client: Client, args: list[bytes]) -> "asyncio.Future[bytes] | None":
        """Pipelining fast path. Applies a write immediately and returns a
        future that resolves to its reply once the log record is durable.

        The connection handler uses this for consecutive pipelined writes, so
        a batch sent in one go shares a single fsync instead of waiting for one
        per command. Replies are still sent in order and only after their own
        record is synced. Returns None whenever the normal path must be used
        (not a write, wrong arity, auth, not ready, write gate closed...)."""
        from .commands import COMMANDS

        spec = COMMANDS.get(args[0].lower())
        if spec is None or not spec.write:
            return None
        n = len(args)
        if (spec.arity > 0 and n != spec.arity) or (spec.arity < 0 and n < -spec.arity):
            return None
        if (self.cfg.requirepass and not client.authed) or self.status != READY or self.persist_error \
                or not self.writes_open.is_set() or self.shutting_down:
            return None
        self.total_commands += 1
        t0 = time.perf_counter()
        loop = asyncio.get_running_loop()
        out: asyncio.Future = loop.create_future()
        tx = Tx(self.keyspace)
        try:
            reply = spec.handler(self, client, args, tx)
        except CommandError as e:
            tx.rollback()
            out.set_result(resp.error(e.msg))
            return out
        except BaseException:
            tx.rollback()
            raise
        if not tx.effects:
            out.set_result(reply)
            return out
        fut = self._submit(tx)

        def _done(f: asyncio.Future) -> None:
            if f.exception() is not None:
                out.set_result(self._misconf())
            else:
                self.total_writes += 1
                self.lat_write.append((time.perf_counter() - t0) * 1000)
                out.set_result(reply)

        fut.add_done_callback(_done)
        return out

    def _misconf(self) -> bytes:
        return resp.error(
            f"MISCONF write was not persisted ({self.persist_error}). "
            "Writes are disabled until the disk problem is fixed and the server is restarted"
        )

    # ================================================================ serialized write path
    def _submit(self, tx: Tx) -> asyncio.Future:
        chunks = []
        for op, a in tx.effects:
            self.seq += 1
            chunks.append(encode_record(self.seq, op, a))
        fut = asyncio.get_running_loop().create_future()
        self.pending.append(_Pending(tx, b"".join(chunks), self.seq, fut))
        if len(self.pending) > self.queue_depth_max:
            self.queue_depth_max = len(self.pending)
        self.drained.clear()
        self._flush_event.set()
        return fut

    async def _flusher(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            await self._flush_event.wait()
            self._flush_event.clear()
            while self.pending:
                batch, self.pending = self.pending, []
                self.flushing = True
                offset = self.aof.size
                data = b"".join(p.data for p in batch)
                tb = time.perf_counter()
                try:
                    await loop.run_in_executor(self._aof_io, self.aof.write_batch, data)
                    self.lat_batch.append((time.perf_counter() - tb) * 1000)
                    self.batch_sizes.append(len(batch))
                except OSError as e:
                    await self._fail_persistence(e, batch, offset)
                    break
                finally:
                    self.flushing = False
                if self.cfg.appendfsync == "always":
                    self.fsyncs += 1
                self.durable_seq = batch[-1].last_seq
                self.ops_since_snapshot += sum(len(p.tx.effects) for p in batch)
                for p in batch:
                    if not p.future.done():
                        p.future.set_result(None)
            if not self.pending:
                self.drained.set()

    async def _fail_persistence(self, exc: OSError, batch: list[_Pending], offset: int) -> None:
        msg = f"log write failed: {exc.strerror or exc}" + (f" (errno {exc.errno})" if exc.errno else "")
        log.error("PERSISTENCE FAILURE: %s -- switching to read-only degraded mode", msg)
        self.persist_error = msg
        self.status = DEGRADED
        failed = batch + self.pending
        self.pending = []
        # Undo every un-acknowledged mutation, newest first, so memory matches disk.
        for p in reversed(failed):
            p.tx.rollback()
        self.seq = self.durable_seq
        for p in failed:
            if not p.future.done():
                p.future.set_exception(PersistenceFailure(msg))
        try:
            await asyncio.get_running_loop().run_in_executor(self._aof_io, self.aof.truncate, offset)
        except OSError:
            log.error("could not truncate partial log write; it will be discarded as an incomplete record on restart")
        self.drained.set()
        self.writes_open.set()  # wake waiters so they see persist_error

    # ================================================================ snapshots
    async def snapshot(self, reason: str, force: bool = False) -> dict:
        if self.status != READY or self.aof is None:
            raise CommandError("ERR cannot save while the server is not ready")
        if self.snapshot_lock.locked():
            raise CommandError("ERR Background save already in progress")
        loop = asyncio.get_running_loop()
        async with self.snapshot_lock:
            t0 = time.perf_counter()
            # 1. Close the write gate and wait for acknowledged writes to hit the log.
            reopen = not self.shutting_down
            self.writes_open.clear()
            gate_t0 = time.perf_counter()
            try:
                await self.drained.wait()
                drained_ms = (time.perf_counter() - gate_t0) * 1000
                if self.persist_error:
                    raise CommandError("ERR cannot save: persistence is degraded")
                # 2. Copy a consistent, fully durable view and rotate the log segment.
                seq = self.durable_seq
                tc = time.perf_counter()
                # dict.copy() duplicates the hash table in C (no per-key tuples),
                # so the write gate stays closed for a few ms even at 100k keys.
                # The worker thread then walks this private copy in chunks.
                items = self.keyspace.data.copy()
                expires = self.keyspace.expires.copy()
                copy_ms = (time.perf_counter() - tc) * 1000
                tr = time.perf_counter()
                try:
                    new_seg = await loop.run_in_executor(self._aof_io, self.aof.rotate)
                except OSError as e:
                    self.last_save_status, self.last_save_error = "err", f"log rotation failed: {e}"
                    raise CommandError(f"ERR {self.last_save_error}")
                _fault("snapshot_after_rotate")
                rotate_ms = (time.perf_counter() - tr) * 1000
            finally:
                if reopen:
                    self.writes_open.set()
            self.last_snapshot_pause = {
                "total_ms": round((time.perf_counter() - gate_t0) * 1000, 2),
                "drain_ms": round(locals().get("drained_ms", 0.0), 2),
                "copy_ms": round(locals().get("copy_ms", 0.0), 2),
                "rotate_ms": round(locals().get("rotate_ms", 0.0), 2),
            }
            # 3. Write the snapshot while clients keep writing to the new segment.
            try:
                size = await loop.run_in_executor(
                    self._snap_io, write_snapshot, self.cfg.dir, seq, items, expires,
                    os.environ.get("MINIREDIS_FAULT") == "snapshot_before_rename")
                _fault("snapshot_after_rename")
                await loop.run_in_executor(self._aof_io, self.aof.delete_before, new_seg)
            except OSError as e:
                self.last_save_status = "err"
                self.last_save_error = str(e)
                log.error("snapshot failed: %s (log is intact; data is still durable)", e)
                raise CommandError(f"ERR snapshot failed: {e}")
            self.snapshot_seq = seq
            self.ops_since_snapshot = max(0, self.durable_seq - seq)
            self.last_save_time = int(time.time())
            self.last_save_duration_ms = round((time.perf_counter() - t0) * 1000, 2)
            self.last_save_status = "ok"
            self.last_save_error = None
            self.last_save_bytes = size
            self.snapshots_taken += 1
            log.info("snapshot (%s): %d keys at seq %d in %.1f ms", reason, len(items), seq, self.last_save_duration_ms)
            return {"keys": len(items), "seq": seq, "bytes": size, "ms": self.last_save_duration_ms}

    async def _try_snapshot(self, reason: str) -> None:
        try:
            await self.snapshot(reason)
        except CommandError as e:
            log.warning("automatic snapshot skipped: %s", e.msg)

    # ================================================================ background work
    async def _cron(self) -> None:
        loop = asyncio.get_running_loop()
        tick = 0
        while True:
            await asyncio.sleep(0.1)
            tick += 1
            now = now_ms()
            if tick % 10 == 0:  # once per second
                self.expired_keys += self.keyspace.sweep(now)
                t, c = self._ops_sample
                mt = time.monotonic()
                self.ops_per_sec = round((self.total_commands - c) / max(mt - t, 1e-6), 1)
                self._ops_sample = (mt, self.total_commands)
                if self.cfg.appendfsync == "everysec" and self.aof and self.aof.dirty and not self.persist_error:
                    try:
                        await loop.run_in_executor(self._aof_io, self.aof.sync)
                        self.fsyncs += 1
                    except OSError as e:
                        self.persist_error = f"fsync failed: {e}"
                        self.status = DEGRADED
                        log.error("PERSISTENCE FAILURE: %s", e)
                if not self.persist_error and not self.snapshot_lock.locked() and self.ops_since_snapshot > 0:
                    due_ops = self.cfg.snapshot_every_ops > 0 and self.ops_since_snapshot >= self.cfg.snapshot_every_ops
                    due_time = (self.cfg.snapshot_every_seconds > 0 and
                                time.time() - max(self.last_save_time, self.started) >= self.cfg.snapshot_every_seconds)
                    if due_ops or due_time:
                        asyncio.create_task(self._try_snapshot("auto"))

    # ================================================================ introspection
    def _latency_fields(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for name, window in (("read", self.lat_read), ("write", self.lat_write), ("log_batch", self.lat_batch)):
            pc = percentiles(window)
            out[f"{name}_latency_p50_ms"] = pc[50]
            out[f"{name}_latency_p95_ms"] = pc[95]
            out[f"{name}_latency_p99_ms"] = pc[99]
        out["latency_samples_read"] = len(self.lat_read)
        out["latency_samples_write"] = len(self.lat_write)
        out["latency_samples_log_batch"] = len(self.lat_batch)
        out["log_batch_avg_writes"] = round(sum(self.batch_sizes) / len(self.batch_sizes), 2) if self.batch_sizes else 0
        return out

    def info_fields(self) -> dict[str, dict[str, object]]:
        r = self.recovery or RecoveryReport()
        ks = self.keyspace
        aof_size = self.aof.total_size() if self.aof else 0
        return {
            "server": {
                "miniredis_version": VERSION,
                "redis_version": "7.0.0",
                "tcp_port": self.cfg.port,
                "uptime_in_seconds": int(time.time() - self.started),
                "run_id": self.run_id,
                "server_time_ms": now_ms(),
                "process_started_ms": self.process_started_ms,
                "listening_ms": self.listening_ms or 0,
                "recovery_started_ms": self.recovery_started_ms or 0,
                "ready_ms": self.ready_ms or 0,
                "process_id": os.getpid(),
            },
            "clients": {"connected_clients": len(self.clients), "total_connections_received": self.total_connections},
            "stats": {
                "total_commands_processed": self.total_commands,
                "total_writes": self.total_writes,
                "instantaneous_ops_per_sec": self.ops_per_sec,
                "ops_window_seconds": 1,
                **self._latency_fields(),
                "keyspace_hits": self.keyspace_hits,
                "keyspace_misses": self.keyspace_misses,
                "expired_keys": self.expired_keys,
            },
            "memory": {"used_memory_dataset": ks.bytes},
            "persistence": {
                "status": self.status,
                "loading": int(self.status in (STARTING, RECOVERING)),
                "degraded_reason": self.recovery_error or self.persist_error or "",
                "appendfsync": self.cfg.appendfsync,
                "aof_segments": self.aof.segment_count() if self.aof else 0,
                "aof_size_bytes": aof_size,
                "last_seq": self.seq,
                "durable_seq": self.durable_seq,
                "snapshot_seq": self.snapshot_seq,
                "ops_since_snapshot": self.ops_since_snapshot,
                "snapshot_in_progress": int(self.snapshot_lock.locked()),
                "snapshots_taken": self.snapshots_taken,
                "last_save_time": self.last_save_time,
                "last_save_duration_ms": self.last_save_duration_ms,
                "last_save_status": self.last_save_status,
                "last_save_error": self.last_save_error or "",
                "last_save_bytes": self.last_save_bytes,
                "last_snapshot_write_pause_ms": self.last_snapshot_pause.get("total_ms", 0),
                "last_snapshot_pause_drain_ms": self.last_snapshot_pause.get("drain_ms", 0),
                "last_snapshot_pause_copy_ms": self.last_snapshot_pause.get("copy_ms", 0),
                "last_snapshot_pause_rotate_ms": self.last_snapshot_pause.get("rotate_ms", 0),
                "fsyncs": self.fsyncs,
                "write_queue_depth": len(self.pending),
                "write_queue_depth_max": self.queue_depth_max,
                "snapshot_every_ops": self.cfg.snapshot_every_ops,
                "snapshot_every_seconds": self.cfg.snapshot_every_seconds,
                "recovery_ok": int(r.ok),
                "recovery_duration_ms": r.duration_ms,
                "recovery_snapshot_loaded": int(r.snapshot_loaded),
                "recovery_snapshot_keys": r.snapshot_keys,
                "recovery_replayed_ops": r.replayed_ops,
                "recovery_skipped_ops": r.skipped_ops,
                "recovery_truncated_bytes": r.truncated_bytes,
                "recovery_expired_dropped": r.expired_dropped,
                "recovery_keys_after": r.keys_after,
                "recovery_started_at_ms": r.started_at_ms,
            },
            "keyspace": (
                {"db0": f"keys={len(ks.data)},expires={len(ks.expires)}"} if ks.data else {}
            ),
        }
