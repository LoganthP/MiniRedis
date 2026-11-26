"""Append-only log segments, snapshots and crash recovery.

On-disk layout inside the data directory::

    dump.snap                    latest snapshot (atomically replaced)
    aof/appendonly-000001.aof    log segments, replayed in order
    recovery-history.jsonl       one line per startup

Log record framing::

    uint32 length | uint32 crc32(payload) | payload

The payload is a RESP array of bulk strings: [seq, op, args...]. Ops are
*effects*, not commands (``S key value abs_ms|-1``, ``D key``,
``X key abs_ms``, ``P key``, ``F``), so replay is deterministic and expiry
deadlines are absolute: a restart never extends a key's lifetime.

Snapshot format::

    b"MRSNAP01" | payload | uint32 crc32(payload)
    payload = uint64 seq | uint64 created_ms | uint64 count |
              count * (uint32 klen | key | uint32 vlen | value | int64 expire_ms or -1)
"""
from __future__ import annotations

import json
import os
from collections import deque
import re
import struct
import time
import zlib
from dataclasses import asdict, dataclass, field

from . import resp
from .store import Keyspace, apply_effect, now_ms

AOF_MAGIC = b"MRAOF001"
SNAP_MAGIC = b"MRSNAP01"
REC_HDR = struct.Struct(">II")
SNAP_HDR = struct.Struct(">QQQ")
U32 = struct.Struct(">I")
I64 = struct.Struct(">q")
SEGMENT_RE = re.compile(r"^appendonly-(\d{6,})\.aof$")
MAX_RECORD = 1 << 30
HISTORY_KEEP = 50


class RecoveryError(Exception):
    """Persistent data is corrupt in a way that cannot be safely skipped."""


def fsync_dir(path: str) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def encode_record(seq: int, op: bytes, args: list[bytes]) -> bytes:
    payload = resp.encode_bulk_array([str(seq).encode(), op, *args])
    return REC_HDR.pack(len(payload), zlib.crc32(payload)) + payload


def segment_name(n: int) -> str:
    return f"appendonly-{n:06d}.aof"


def list_segments(aof_dir: str) -> list[tuple[int, str]]:
    if not os.path.isdir(aof_dir):
        return []
    out = []
    for name in os.listdir(aof_dir):
        m = SEGMENT_RE.match(name)
        if m:
            out.append((int(m.group(1)), os.path.join(aof_dir, name)))
    return sorted(out)


OP_NAMES = {b"S": "SET", b"D": "DEL", b"X": "PEXPIREAT", b"P": "PERSIST", b"F": "FLUSHALL"}


def _show(b: bytes, limit: int = 64) -> str:
    t = b.decode("utf-8", "replace")
    return t if len(t) <= limit else t[:limit] + "…"


def escape_wire(b: bytes, limit: int = 320) -> str:
    """Render raw protocol bytes with visible \\r\\n, the way they sit on disk."""
    out = b[:limit].decode("latin-1").replace("\\", "\\\\").replace("\r", "\\r").replace("\n", "\\n")
    return out + ("…" if len(b) > limit else "")


def describe_record(segment: str, offset: int, length: int, crc: int, payload: bytes,
                    seq: int, op: bytes, args: list[bytes]) -> dict:
    name = OP_NAMES.get(op, op.decode("latin-1"))
    shown = [_show(a) for a in args]
    if op == b"S":
        at = int(args[2]) if len(args) > 2 else -1
        shown = shown[:2] + ([f"PXAT {at}"] if at >= 0 else [])
    return {
        "seq": seq, "op": name, "args": shown, "segment": segment, "offset": offset,
        "length": length, "crc32": f"{crc:08x}", "raw": escape_wire(payload),
    }


def read_tail(data_dir: str, limit: int = 30) -> list[dict]:
    """Return the newest `limit` complete records on disk, oldest first."""
    out: deque[dict] = deque(maxlen=limit)
    segs = list_segments(os.path.join(data_dir, "aof"))
    chunks: list[list[dict]] = []
    total = 0
    for _, path in reversed(segs):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            continue
        recs: list[dict] = []
        pos, n = len(AOF_MAGIC), len(data)
        while n - pos >= REC_HDR.size:
            length, crc = REC_HDR.unpack_from(data, pos)
            end = pos + REC_HDR.size + length
            if end > n:
                break
            payload = data[pos + REC_HDR.size:end]
            if zlib.crc32(payload) != crc:
                break
            try:
                items = resp.parse_bulk_array(payload)
                recs.append(describe_record(os.path.basename(path), pos, length, crc, payload,
                                            int(items[0]), items[1], items[2:]))
            except (resp.ProtocolError, ValueError, IndexError):
                break
            pos = end
        chunks.append(recs)
        total += len(recs)
        if total >= limit:
            break
    for recs in reversed(chunks):
        out.extend(recs)
    return list(out)


# =========================================================================== log writer

class AppendLog:
    """Owns the active log segment. All methods are blocking and are called
    from a single-thread executor so writes stay ordered."""

    def __init__(self, data_dir: str, fsync_mode: str) -> None:
        self.dir = os.path.join(data_dir, "aof")
        os.makedirs(self.dir, exist_ok=True)
        self.fsync_mode = fsync_mode
        self.fd: int | None = None
        self.seg_no = 0
        self.path = ""
        self.size = 0  # size of the active segment
        self.dirty = False  # bytes written since last fsync

    def open_latest(self) -> None:
        segs = list_segments(self.dir)
        if segs:
            self.seg_no, self.path = segs[-1]
            self.fd = os.open(self.path, os.O_WRONLY | os.O_APPEND)
            self.size = os.fstat(self.fd).st_size
            if self.size < len(AOF_MAGIC):  # torn creation: rewrite header
                os.ftruncate(self.fd, 0)
                self._write_all(AOF_MAGIC)
                os.fsync(self.fd)
                self.size = len(AOF_MAGIC)
        else:
            self._create(1)

    def _create(self, n: int) -> None:
        path = os.path.join(self.dir, segment_name(n))
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_TRUNC, 0o644)
        os.write(fd, AOF_MAGIC)
        os.fsync(fd)
        fsync_dir(self.dir)
        self.fd, self.seg_no, self.path, self.size = fd, n, path, len(AOF_MAGIC)

    def _write_all(self, data: bytes) -> None:
        view = memoryview(data)
        while view:
            n = os.write(self.fd, view)
            view = view[n:]

    def write_batch(self, data: bytes) -> None:
        self._write_all(data)
        self.size += len(data)
        if self.fsync_mode == "always":
            os.fsync(self.fd)
            self.dirty = False
        else:
            self.dirty = True

    def sync(self) -> None:
        if self.dirty and self.fd is not None:
            os.fsync(self.fd)
            self.dirty = False

    def truncate(self, size: int) -> None:
        os.ftruncate(self.fd, size)
        self.size = size

    def rotate(self) -> int:
        """Start a new segment; returns the number of the new segment."""
        if self.fd is not None:
            os.fsync(self.fd)
            os.close(self.fd)
        self._create(self.seg_no + 1)
        self.dirty = False
        return self.seg_no

    def delete_before(self, seg_no: int) -> int:
        removed = 0
        for n, path in list_segments(self.dir):
            if n < seg_no:
                os.unlink(path)
                removed += 1
        if removed:
            fsync_dir(self.dir)
        return removed

    def total_size(self) -> int:
        total = 0
        for _, path in list_segments(self.dir):
            try:
                total += os.path.getsize(path)
            except OSError:
                pass
        return total

    def segment_count(self) -> int:
        return len(list_segments(self.dir))

    def close(self) -> None:
        if self.fd is not None:
            try:
                os.fsync(self.fd)
            finally:
                os.close(self.fd)
                self.fd = None


# =========================================================================== snapshots

def write_snapshot(data_dir: str, seq: int, items: dict[bytes, bytes] | list[tuple[bytes, bytes]],
                   expires: dict[bytes, int], _crash_before_rename: bool = False) -> int:
    """Serialize and atomically install a snapshot. Returns bytes written.

    Runs in a worker thread on a private copy of the keyspace. Serialization
    walks it in chunks with a short yield between them, which releases the
    GIL so the event loop keeps serving commands during a large snapshot."""
    pairs = items.items() if isinstance(items, dict) else items
    parts: list[bytes] = [SNAP_HDR.pack(seq, now_ms(), len(items))]
    pack_u32, pack_i64, get_exp = U32.pack, I64.pack, expires.get
    n = 0
    for k, v in pairs:
        parts.append(b"".join((pack_u32(len(k)), k, pack_u32(len(v)), v, pack_i64(get_exp(k, -1)))))
        n += 1
        if n % 2000 == 0:
            time.sleep(0)  # yield the GIL to the event loop
    buf = b"".join(parts)
    crc = zlib.crc32(buf)
    final = os.path.join(data_dir, "dump.snap")
    tmp = final + ".tmp"
    with open(tmp, "wb") as f:
        f.write(SNAP_MAGIC)
        f.write(buf)
        f.write(U32.pack(crc))
        f.flush()
        os.fsync(f.fileno())
    if _crash_before_rename:  # fault injection for tests
        os._exit(1)
    os.replace(tmp, final)
    fsync_dir(data_dir)
    return len(buf) + len(SNAP_MAGIC) + 4


def load_snapshot(path: str, ks: Keyspace) -> tuple[int, int, int]:
    """Load into ks. Returns (seq, created_ms, key_count)."""
    with open(path, "rb") as f:
        raw = f.read()
    if len(raw) < len(SNAP_MAGIC) + SNAP_HDR.size + 4 or raw[:8] != SNAP_MAGIC:
        raise RecoveryError("snapshot header is invalid")
    payload = raw[8:-4]
    (crc,) = U32.unpack(raw[-4:])
    if zlib.crc32(payload) != crc:
        raise RecoveryError("snapshot checksum mismatch; refusing to load a corrupt snapshot")
    seq, created, count = SNAP_HDR.unpack_from(payload, 0)
    pos = SNAP_HDR.size
    data: dict[bytes, bytes] = {}
    expires: dict[bytes, int] = {}
    try:
        for _ in range(count):
            (kl,) = U32.unpack_from(payload, pos); pos += 4
            k = bytes(payload[pos:pos + kl]); pos += kl
            (vl,) = U32.unpack_from(payload, pos); pos += 4
            v = bytes(payload[pos:pos + vl]); pos += vl
            (at,) = I64.unpack_from(payload, pos); pos += 8
            data[k] = v
            if at >= 0:
                expires[k] = at
    except struct.error:
        raise RecoveryError("snapshot body is truncated") from None
    if pos != len(payload):
        raise RecoveryError("snapshot has trailing bytes")
    ks.restore(data, expires)
    return seq, created, count


# =========================================================================== recovery

@dataclass
class RecoveryReport:
    started_at_ms: int = 0
    duration_ms: float = 0.0
    ok: bool = True
    error: str | None = None
    snapshot_loaded: bool = False
    snapshot_seq: int = 0
    snapshot_keys: int = 0
    snapshot_created_ms: int | None = None
    segments_read: int = 0
    replayed_ops: int = 0
    skipped_ops: int = 0
    truncated_bytes: int = 0
    truncated_segment: str | None = None
    expired_dropped: int = 0
    keys_after: int = 0
    last_seq: int = 0
    notes: list[str] = field(default_factory=list)
    replay_tail: list[dict] = field(default_factory=list)  # last records replayed (for the wire log view)

    def to_dict(self) -> dict:
        return asdict(self)


def recover(data_dir: str) -> tuple[Keyspace, RecoveryReport]:
    """Rebuild the keyspace from disk. Raises RecoveryError on corruption that
    is not an incomplete final record. Truncates a torn tail in place."""
    rep = RecoveryReport(started_at_ms=now_ms())
    t0 = time.perf_counter()
    ks = Keyspace()
    os.makedirs(data_dir, exist_ok=True)

    snap = os.path.join(data_dir, "dump.snap")
    stale_tmp = snap + ".tmp"
    if os.path.exists(stale_tmp):
        os.unlink(stale_tmp)
        rep.notes.append("removed unfinished snapshot temp file")
    if os.path.exists(snap):
        rep.snapshot_seq, rep.snapshot_created_ms, rep.snapshot_keys = load_snapshot(snap, ks)
        rep.snapshot_loaded = True

    last_seq = rep.snapshot_seq
    tail: deque[dict] = deque(maxlen=25)
    segs = list_segments(os.path.join(data_dir, "aof"))
    for i, (_, path) in enumerate(segs):
        is_last = i == len(segs) - 1
        name = os.path.basename(path)
        with open(path, "rb") as f:
            data = f.read()
        rep.segments_read += 1
        if len(data) < len(AOF_MAGIC):
            if is_last and AOF_MAGIC.startswith(data):
                rep.notes.append(f"{name}: empty segment with torn header")
                continue
            raise RecoveryError(f"{name}: missing segment header")
        if data[:8] != AOF_MAGIC:
            raise RecoveryError(f"{name}: bad segment header")
        pos = len(AOF_MAGIC)
        n = len(data)
        torn_at: int | None = None
        while pos < n:
            if n - pos < REC_HDR.size:
                torn_at = pos
                break
            length, crc = REC_HDR.unpack_from(data, pos)
            end = pos + REC_HDR.size + length
            if length > MAX_RECORD or end > n:
                torn_at = pos
                break
            payload = data[pos + REC_HDR.size:end]
            if zlib.crc32(payload) != crc:
                if end == n and is_last:
                    torn_at = pos
                    break
                raise RecoveryError(f"{name}: checksum mismatch in record at byte {pos} (log corrupted mid-file)")
            try:
                items = resp.parse_bulk_array(payload)
                seq = int(items[0])
                op, args = items[1], items[2:]
            except (resp.ProtocolError, ValueError, IndexError):
                raise RecoveryError(f"{name}: unreadable record at byte {pos}") from None
            if seq <= rep.snapshot_seq:
                rep.skipped_ops += 1
            else:
                if seq <= last_seq:
                    raise RecoveryError(f"{name}: sequence went backwards at byte {pos} ({seq} after {last_seq})")
                try:
                    apply_effect(ks, op, args)
                except (ValueError, IndexError):
                    raise RecoveryError(f"{name}: invalid record at byte {pos}") from None
                last_seq = seq
                rep.replayed_ops += 1
                tail.append(describe_record(name, pos, length, crc, payload, seq, op, args))
            pos = end
        if torn_at is not None:
            if not is_last:
                raise RecoveryError(f"{name}: incomplete record at byte {torn_at} in a non-final segment")
            rep.truncated_bytes = n - torn_at
            rep.truncated_segment = name
            with open(path, "r+b") as f:
                f.truncate(torn_at)
                f.flush()
                os.fsync(f.fileno())
            rep.notes.append(f"{name}: ignored incomplete final record ({rep.truncated_bytes} bytes)")

    rep.replay_tail = list(tail)
    rep.expired_dropped = ks.sweep(now_ms())
    rep.keys_after = len(ks.data)
    rep.last_seq = last_seq
    rep.duration_ms = round((time.perf_counter() - t0) * 1000, 3)
    return ks, rep


def append_history(data_dir: str, entry: dict, name: str = "recovery-history.jsonl") -> None:
    path = os.path.join(data_dir, name)
    try:
        lines: list[str] = []
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
        lines.append(json.dumps(entry, separators=(",", ":")))
        lines = lines[-HISTORY_KEEP:]
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except OSError:
        pass  # history is informational only


def read_history(data_dir: str, name: str = "recovery-history.jsonl") -> list[dict]:
    path = os.path.join(data_dir, name)
    out = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for ln in f:
                try:
                    out.append(json.loads(ln))
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return out
