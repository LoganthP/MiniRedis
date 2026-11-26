"""Verify a backup by restoring it into a fresh, temporary directory.

    python -m miniredis.verify_backup BACKUP.tar.gz [--compare HOST:PORT] [--sample 200] [--strict]
    python -m miniredis.verify_backup - --compare 127.0.0.1:6380 < BACKUP.tar.gz

Steps:
  1. extract the archive into a new temp dir (never touching the live volume),
  2. run the real recovery code on it (snapshot load + log replay),
  3. report key count, keys with TTL, replayed records, torn tail,
  4. with --compare, sample keys and check value and absolute expiry deadline
     against a running server.

Exit code: 0 if the backup recovers cleanly (and, with --strict, every sampled
key matches), 1 otherwise. Differences without --strict are reported only,
because the live server may have accepted writes after the backup was taken.
"""
from __future__ import annotations

import argparse
import io
import os
import random
import socket
import sys
import tarfile
import tempfile

from .persistence import RecoveryError, recover
from .store import now_ms


def _enc(*args: bytes | str) -> bytes:
    out = b"*%d\r\n" % len(args)
    for a in args:
        b = a if isinstance(a, bytes) else a.encode()
        out += b"$%d\r\n%s\r\n" % (len(b), b)
    return out


def _read(f):
    line = f.readline()
    t, rest = line[:1], line[1:-2]
    if t == b"$":
        n = int(rest)
        return None if n < 0 else f.read(n + 2)[:-2]
    if t == b":":
        return int(rest)
    if t == b"-":
        raise RuntimeError(rest.decode())
    return rest.decode()


def _extract(src: str, dest: str) -> None:
    data = sys.stdin.buffer.read() if src == "-" else open(src, "rb").read()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tar:
        try:
            tar.extractall(dest, filter="data")  # Python 3.12+: refuses absolute paths / traversal
        except TypeError:  # pragma: no cover - older Python
            for m in tar.getmembers():
                if m.name.startswith(("/", "..")) or ".." in m.name.split("/"):
                    raise RuntimeError(f"unsafe path in archive: {m.name}")
            tar.extractall(dest)


def _record(a, result: dict) -> None:
    if a.record:
        from .persistence import append_history
        append_history(a.record, result, "restore-verifications.jsonl")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("backup", help="backup .tar.gz from scripts/backup.sh, or - for stdin")
    ap.add_argument("--compare", metavar="HOST:PORT", help="compare sampled keys with a running server")
    ap.add_argument("--password", default=os.environ.get("MINIREDIS_REQUIREPASS"))
    ap.add_argument("--sample", type=int, default=200)
    ap.add_argument("--strict", action="store_true", help="fail if any sampled key differs from the live server")
    ap.add_argument("--record", metavar="DATA_DIR",
                    help="append the result to DATA_DIR/restore-verifications.jsonl (shown on the dashboard)")
    ap.add_argument("--name", default="", help="label for the recorded result (e.g. the backup file name)")
    a = ap.parse_args()

    with tempfile.TemporaryDirectory(prefix="miniredis-verify-") as d:
        _extract(a.backup, d)
        result = {"at_ms": now_ms(), "backup": a.name or a.backup, "ok": False}
        try:
            ks, rep = recover(d)
        except RecoveryError as e:
            print(f"FAIL  backup does not recover: {e}")
            _record(a, {**result, "error": str(e)})
            return 1
        result.update(ok=True, keys=len(ks.data), with_ttl=len(ks.expires), recovery_ms=rep.duration_ms,
                      snapshot_loaded=rep.snapshot_loaded, replayed=rep.replayed_ops, torn_tail_bytes=rep.truncated_bytes)
        print(f"OK    recovered {len(ks.data):,} keys ({len(ks.expires):,} with TTL) in {rep.duration_ms} ms")
        print(f"      snapshot: {'loaded, ' + format(rep.snapshot_keys, ',') + ' keys' if rep.snapshot_loaded else 'none'}"
              f" · replayed {rep.replayed_ops:,} log records · torn tail {rep.truncated_bytes} B"
              f" · expired since backup {rep.expired_dropped:,}")
        if not a.compare:
            _record(a, result)
            return 0

        host, _, port = a.compare.rpartition(":")
        keys = list(ks.data)
        random.Random(42).shuffle(keys)
        sample = keys[: a.sample]
        same = differ = missing = deadline_diff = 0
        examples: list[str] = []
        with socket.create_connection((host or "127.0.0.1", int(port)), timeout=10) as s:
            f = s.makefile("rb")
            if a.password:
                s.sendall(_enc("AUTH", a.password))
                _read(f)
            s.sendall(_enc("DBSIZE"))
            live_size = _read(f)
            now = now_ms()
            for k in sample:
                s.sendall(_enc("GET", k) + _enc("PEXPIRETIME", k))
                v, exp = _read(f), _read(f)
                want_exp = ks.expires.get(k, -1)
                if v is None:
                    missing += 1
                    if want_exp == -1 or want_exp > now:
                        examples.append(f"missing on live: {k!r}")
                elif v != ks.data[k]:
                    differ += 1
                    examples.append(f"value differs: {k!r}")
                elif exp != want_exp:
                    deadline_diff += 1
                    examples.append(f"deadline differs: {k!r} backup={want_exp} live={exp}")
                else:
                    same += 1
        print(f"      live server {a.compare}: {live_size:,} keys (backup has {len(ks.data):,})")
        print(f"      sampled {len(sample)}: {same} identical · {differ} value differs · {deadline_diff} deadline differs · {missing} missing on live")
        for e in examples[:10]:
            print(f"        - {e}")
        result.update(compared_with=a.compare, sampled=len(sample), identical=same, value_differs=differ,
                      deadline_differs=deadline_diff, missing_on_live=missing, live_keys=live_size)
        if a.strict and (differ or deadline_diff or missing):
            print("FAIL  --strict: live data does not match the backup")
            _record(a, {**result, "ok": False, "error": "live data does not match (--strict)"})
            return 1
        _record(a, result)
        return 0


if __name__ == "__main__":
    sys.exit(main())
