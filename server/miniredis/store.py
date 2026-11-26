"""In-memory keyspace plus a small transaction object that records undo
information and the log effects of a write command."""
from __future__ import annotations

import bisect
import fnmatch
import re
import time


def now_ms() -> int:
    return time.time_ns() // 1_000_000


_GLOB_CHARS = re.compile(rb"[*?\[\\]")


def compile_glob(pattern: bytes):
    """Return a predicate for a Redis-style glob (*, ?, [abc], [^a], \\x)."""
    if pattern == b"*":
        return lambda k: True
    p = pattern.decode("latin-1").replace("[^", "[!")
    return lambda k: fnmatch.fnmatchcase(k.decode("latin-1"), p)


def literal_prefix(pattern: bytes) -> bytes | None:
    """If pattern is 'literal*' return 'literal', else None."""
    if pattern.endswith(b"*") and not _GLOB_CHARS.search(pattern[:-1]):
        return pattern[:-1]
    return None


class Keyspace:
    def __init__(self) -> None:
        self.data: dict[bytes, bytes] = {}
        self.expires: dict[bytes, int] = {}  # absolute unix time in ms
        self.version = 0  # bumps whenever the set of keys changes
        self.bytes = 0  # approximate payload bytes (keys + values)
        self._sorted: list[bytes] = []
        self._sorted_version = -1
        self._match_cache: tuple[int, bytes, list[bytes]] | None = None

    # ---------------------------------------------------------------- reads
    def lookup(self, key: bytes, now: int) -> bytes | None:
        v = self.data.get(key)
        if v is None:
            return None
        at = self.expires.get(key)
        if at is not None and at <= now:
            self.remove(key)  # lazy expiry; deadline is absolute so no log entry needed
            return None
        return v

    def exists(self, key: bytes, now: int) -> bool:
        return self.lookup(key, now) is not None

    # ---------------------------------------------------------------- raw mutations
    def put(self, key: bytes, value: bytes, at: int | None) -> None:
        old = self.data.get(key)
        if old is None:
            self.version += 1
            self.bytes += len(key)
        else:
            self.bytes -= len(old)
        self.data[key] = value
        self.bytes += len(value)
        if at is None:
            self.expires.pop(key, None)
        else:
            self.expires[key] = at

    def remove(self, key: bytes) -> bool:
        v = self.data.pop(key, None)
        if v is None:
            return False
        self.expires.pop(key, None)
        self.bytes -= len(key) + len(v)
        self.version += 1
        return True

    def clear(self) -> None:
        self.data = {}
        self.expires = {}
        self.bytes = 0
        self.version += 1

    def restore(self, data: dict, expires: dict) -> None:
        self.data = data
        self.expires = expires
        self.bytes = sum(len(k) + len(v) for k, v in data.items())
        self.version += 1

    # ---------------------------------------------------------------- expiry
    def sweep(self, now: int) -> int:
        dead = [k for k, at in self.expires.items() if at <= now]
        for k in dead:
            self.remove(k)
        return len(dead)

    # ---------------------------------------------------------------- iteration
    def sorted_keys(self) -> list[bytes]:
        if self._sorted_version != self.version:
            self._sorted = sorted(self.data)
            self._sorted_version = self.version
        return self._sorted

    def matching(self, pattern: bytes) -> list[bytes]:
        keys = self.sorted_keys()
        if pattern == b"*":
            return keys
        c = self._match_cache
        if c and c[0] == self.version and c[1] == pattern:
            return c[2]
        prefix = literal_prefix(pattern)
        if prefix is not None:
            lo = bisect.bisect_left(keys, prefix)
            hi = lo
            while hi < len(keys) and keys[hi].startswith(prefix):
                hi += 1
            result = keys[lo:hi]
        else:
            pred = compile_glob(pattern)
            result = [k for k in keys if pred(k)]
        self._match_cache = (self.version, pattern, result)
        return result


_FLUSH = object()


class Tx:
    """Applies mutations for one write command, remembering how to undo them
    and which effect records must be appended to the log."""

    __slots__ = ("ks", "undo", "effects")

    def __init__(self, ks: Keyspace) -> None:
        self.ks = ks
        self.undo: list = []
        self.effects: list[tuple[bytes, list[bytes]]] = []

    def _save(self, key: bytes) -> None:
        self.undo.append((key, self.ks.data.get(key), self.ks.expires.get(key)))

    def set(self, key: bytes, value: bytes, at: int | None) -> None:
        self._save(key)
        self.ks.put(key, value, at)
        self.effects.append((b"S", [key, value, str(-1 if at is None else at).encode()]))

    def delete(self, key: bytes) -> bool:
        if key not in self.ks.data:
            return False
        self._save(key)
        self.ks.remove(key)
        self.effects.append((b"D", [key]))
        return True

    def expire_at(self, key: bytes, at: int) -> None:
        self._save(key)
        self.ks.expires[key] = at
        self.effects.append((b"X", [key, str(at).encode()]))

    def persist(self, key: bytes) -> bool:
        if key not in self.ks.expires:
            return False
        self._save(key)
        del self.ks.expires[key]
        self.effects.append((b"P", [key]))
        return True

    def flush(self) -> None:
        self.undo.append((_FLUSH, self.ks.data, self.ks.expires))
        self.ks.clear()
        self.effects.append((b"F", []))

    def rollback(self) -> None:
        for entry in reversed(self.undo):
            if entry[0] is _FLUSH:
                self.ks.restore(entry[1], entry[2])
                continue
            key, value, at = entry
            if value is None:
                self.ks.remove(key)
            else:
                self.ks.put(key, value, at)
        self.undo.clear()


def apply_effect(ks: Keyspace, op: bytes, args: list[bytes]) -> None:
    """Replay one logged effect (used by recovery)."""
    if op == b"S":
        at = int(args[2])
        ks.put(args[0], args[1], None if at < 0 else at)
    elif op == b"D":
        ks.remove(args[0])
    elif op == b"X":
        if args[0] in ks.data:
            ks.expires[args[0]] = int(args[1])
    elif op == b"P":
        ks.expires.pop(args[0], None)
    elif op == b"F":
        ks.clear()
    else:
        raise ValueError(f"unknown log op {op!r}")
