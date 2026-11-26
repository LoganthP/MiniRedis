"""Command table and handlers.

Handlers have the signature ``handler(db, client, args, tx)``. Write handlers
receive a :class:`~miniredis.store.Tx` and must validate every argument
*before* mutating anything. Read handlers receive ``tx=None`` and may return
an awaitable.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Callable

from . import resp
from .db import CommandError, Database
from .persistence import read_history, read_tail
from .store import compile_glob, now_ms

log = logging.getLogger("miniredis")

INT64_MAX = (1 << 63) - 1
_INT_RE = re.compile(rb"^-?(0|[1-9][0-9]*)$")


@dataclass
class Spec:
    name: str
    handler: Callable
    arity: int
    write: bool = False
    loading_ok: bool = False
    noauth: bool = False
    summary: str = ""


def parse_int(b: bytes) -> int:
    if not _INT_RE.match(b):
        raise CommandError("ERR value is not an integer or out of range")
    n = int(b)
    if n > INT64_MAX or n < -INT64_MAX - 1:
        raise CommandError("ERR value is not an integer or out of range")
    return n


# =========================================================================== connection
def cmd_ping(db, c, a, tx):
    if len(a) > 2:
        raise CommandError("ERR wrong number of arguments for 'ping' command")
    return resp.PONG if len(a) == 1 else resp.bulk(a[1])


def cmd_echo(db, c, a, tx):
    return resp.bulk(a[1])


def cmd_quit(db, c, a, tx):
    c.close_after_reply = True
    return resp.OK


def cmd_select(db, c, a, tx):
    if parse_int(a[1]) != 0:
        raise CommandError("ERR DB index is out of range")
    return resp.OK


def cmd_auth(db, c, a, tx):
    if len(a) > 3:
        raise CommandError("ERR syntax error")
    if not db.cfg.requirepass:
        raise CommandError("ERR AUTH <password> called without any password configured for the default user. "
                           "Are you sure your configuration is correct?")
    password = a[-1].decode("utf-8", "replace")
    user = a[1].decode() if len(a) == 3 else "default"
    if user != "default" or password != db.cfg.requirepass:
        raise CommandError("WRONGPASS invalid username-password pair or user is disabled.")
    c.authed = True
    return resp.OK


def cmd_command(db, c, a, tx):
    if len(a) >= 2 and a[1].upper() == b"COUNT":
        return resp.integer(len(COMMANDS))
    return resp.array([])  # redis-cli asks for COMMAND DOCS; an empty answer is fine


def cmd_time(db, c, a, tx):
    ns = time.time_ns()
    return resp.bulk_array([str(ns // 10**9).encode(), str((ns // 1000) % 10**6).encode()])


def cmd_config(db, c, a, tx):
    sub = a[1].upper()
    if sub == b"GET" and len(a) == 3:
        cfg = db.cfg
        values = {
            "appendonly": "yes", "appendfsync": cfg.appendfsync, "dir": os.path.abspath(cfg.dir),
            "save": "", "port": str(cfg.port), "maxclients": str(cfg.max_clients),
            "snapshot-every-ops": str(cfg.snapshot_every_ops),
            "snapshot-every-seconds": str(cfg.snapshot_every_seconds),
        }
        pred = compile_glob(a[2].lower())
        out = []
        for k, v in values.items():
            if pred(k.encode()):
                out += [k.encode(), v.encode()]
        return resp.bulk_array(out)
    raise CommandError("ERR CONFIG only supports GET <pattern> in this server")


# =========================================================================== strings
def cmd_get(db, c, a, tx):
    v = db.keyspace.lookup(a[1], now_ms())
    if v is None:
        db.keyspace_misses += 1
    else:
        db.keyspace_hits += 1
    return resp.bulk(v)


def cmd_mget(db, c, a, tx):
    now = now_ms()
    return resp.bulk_array([db.keyspace.lookup(k, now) for k in a[1:]])


def cmd_strlen(db, c, a, tx):
    v = db.keyspace.lookup(a[1], now_ms())
    return resp.integer(0 if v is None else len(v))


def _abs_deadline(kind: bytes, n: int, now: int, cmd: str) -> int:
    try:
        if kind == b"EX":
            at = now + n * 1000
        elif kind == b"PX":
            at = now + n
        elif kind == b"EXAT":
            at = n * 1000
        else:
            at = n
    except OverflowError:  # pragma: no cover
        at = INT64_MAX + 1
    if at > INT64_MAX or at < -INT64_MAX:
        raise CommandError(f"ERR invalid expire time in '{cmd}' command")
    return at


def cmd_set(db, c, a, tx):
    key, value = a[1], a[2]
    nx = xx = keepttl = get = False
    at: int | None = None
    has_exp = False
    now = now_ms()
    i = 3
    while i < len(a):
        opt = a[i].upper()
        if opt in (b"EX", b"PX", b"EXAT", b"PXAT") and i + 1 < len(a) and not has_exp and not keepttl:
            n = parse_int(a[i + 1])
            if n <= 0:
                raise CommandError("ERR invalid expire time in 'set' command")
            at = _abs_deadline(opt, n, now, "set")
            has_exp = True
            i += 2
            continue
        if opt == b"NX" and not xx:
            nx = True
        elif opt == b"XX" and not nx:
            xx = True
        elif opt == b"KEEPTTL" and not has_exp:
            keepttl = True
        elif opt == b"GET":
            get = True
        else:
            raise CommandError("ERR syntax error")
        i += 1

    ks = db.keyspace
    old = ks.lookup(key, now)
    exists = old is not None
    if (nx and exists) or (xx and not exists):
        return resp.bulk(old) if get else resp.NULL
    if keepttl and exists:
        at = ks.expires.get(key)
    if at is not None and at <= now:  # EXAT/PXAT already in the past
        tx.delete(key)
    else:
        tx.set(key, value, at)
    return resp.bulk(old) if get else resp.OK


def cmd_del(db, c, a, tx):
    now = now_ms()
    n = 0
    for k in a[1:]:
        if db.keyspace.lookup(k, now) is not None and tx.delete(k):
            n += 1
    return resp.integer(n)


def cmd_exists(db, c, a, tx):
    now = now_ms()
    return resp.integer(sum(1 for k in a[1:] if db.keyspace.exists(k, now)))


def cmd_type(db, c, a, tx):
    return resp.simple("string" if db.keyspace.exists(a[1], now_ms()) else "none")


def cmd_flushdb(db, c, a, tx):
    if len(a) > 2 or (len(a) == 2 and a[1].upper() not in (b"ASYNC", b"SYNC")):
        raise CommandError("ERR syntax error")
    if db.keyspace.data:
        tx.flush()
    return resp.OK


# =========================================================================== expiry
def _expire_generic(unit_ms: int, absolute: bool, name: str):
    def handler(db, c, a, tx):
        key = a[1]
        n = parse_int(a[2])
        flags = set()
        for f in a[3:]:
            f = f.upper()
            if f not in (b"NX", b"XX", b"GT", b"LT"):
                raise CommandError(f"ERR Unsupported option {f.decode('utf-8', 'replace')}")
            flags.add(f)
        if b"NX" in flags and len(flags) > 1:
            raise CommandError("ERR NX and XX, GT or LT options at the same time are not compatible")
        if b"GT" in flags and b"LT" in flags:
            raise CommandError("ERR GT and LT options at the same time are not compatible")
        now = now_ms()
        at = n * unit_ms if absolute else now + n * unit_ms
        if at > INT64_MAX or at < -INT64_MAX:
            raise CommandError(f"ERR invalid expire time in '{name}' command")
        ks = db.keyspace
        if not ks.exists(key, now):
            return resp.integer(0)
        cur = ks.expires.get(key)  # None means "never expires"
        if b"NX" in flags and cur is not None:
            return resp.integer(0)
        if b"XX" in flags and cur is None:
            return resp.integer(0)
        if b"GT" in flags and (cur is None or at <= cur):
            return resp.integer(0)
        if b"LT" in flags and cur is not None and at >= cur:
            return resp.integer(0)
        if at <= now:
            tx.delete(key)
        else:
            tx.expire_at(key, at)
        return resp.integer(1)
    return handler


def _ttl_generic(kind: str):
    def handler(db, c, a, tx):
        now = now_ms()
        ks = db.keyspace
        if not ks.exists(a[1], now):
            return resp.integer(-2)
        at = ks.expires.get(a[1])
        if at is None:
            return resp.integer(-1)
        if kind == "ttl":
            return resp.integer((at - now + 500) // 1000)
        if kind == "pttl":
            return resp.integer(at - now)
        if kind == "expiretime":
            return resp.integer(at // 1000)
        return resp.integer(at)
    return handler


def cmd_persist(db, c, a, tx):
    if not db.keyspace.exists(a[1], now_ms()):
        return resp.integer(0)
    return resp.integer(1 if tx.persist(a[1]) else 0)


# =========================================================================== keyspace
def cmd_dbsize(db, c, a, tx):
    return resp.integer(len(db.keyspace.data))


def cmd_keys(db, c, a, tx):
    now = now_ms()
    ks = db.keyspace
    return resp.bulk_array([k for k in ks.matching(a[1]) if ks.exists(k, now)])


def cmd_keycount(db, c, a, tx):
    """KEYCOUNT pattern -- number of keys matching a glob (cheap for literal prefixes)."""
    now = now_ms()
    ks = db.keyspace
    return resp.integer(sum(1 for k in ks.matching(a[1]) if ks.expires.get(k, now + 1) > now))


def cmd_scan(db, c, a, tx):
    """SCAN cursor [MATCH pattern] [COUNT n]. The cursor is an offset into the
    sorted list of matching keys, so pages come back in key order."""
    cursor = parse_int(a[1])
    if cursor < 0:
        raise CommandError("ERR invalid cursor")
    pattern, count = b"*", 10
    i = 2
    while i < len(a):
        opt = a[i].upper()
        if opt == b"MATCH" and i + 1 < len(a):
            pattern = a[i + 1]
        elif opt == b"COUNT" and i + 1 < len(a):
            count = parse_int(a[i + 1])
            if count < 1:
                raise CommandError("ERR syntax error")
        elif opt == b"TYPE" and i + 1 < len(a):
            if a[i + 1].lower() != b"string":
                return resp.array([resp.bulk(b"0"), resp.array([])])
        else:
            raise CommandError("ERR syntax error")
        i += 2
    keys = db.keyspace.matching(pattern)
    page = keys[cursor:cursor + count]
    nxt = cursor + count if cursor + count < len(keys) else 0
    now = now_ms()
    live = [k for k in page if db.keyspace.expires.get(k, now + 1) > now]
    return resp.array([resp.bulk(str(nxt).encode()), resp.bulk_array(live)])


# =========================================================================== server
def _format_info(db: Database, section: str | None) -> bytes:
    fields = db.info_fields()
    names = list(fields) if section in (None, "all", "everything", "default") else [section]
    lines = []
    for name in names:
        if name not in fields:
            continue
        lines.append(f"# {name.capitalize()}")
        for k, v in fields[name].items():
            lines.append(f"{k}:{v}")
        lines.append("")
    return "\r\n".join(lines).encode()


def cmd_info(db, c, a, tx):
    if len(a) > 2:
        raise CommandError("ERR syntax error")
    section = a[1].decode().lower() if len(a) == 2 else None
    return resp.bulk(_format_info(db, section))


async def cmd_save(db, c, a, tx):
    # If an automatic snapshot is running, wait for it, then take a fresh one
    # so SAVE always covers every write acknowledged before it was issued.
    while db.snapshot_lock.locked():
        await asyncio.sleep(0.01)
    await db.snapshot("SAVE")
    return resp.OK


def cmd_bgsave(db, c, a, tx):
    if db.snapshot_lock.locked():
        raise CommandError("ERR Background save already in progress")
    if db.status != "ready":
        raise CommandError("ERR cannot save while the server is not ready")
    asyncio.create_task(db._try_snapshot("BGSAVE"))
    return resp.simple("Background saving started")


def cmd_lastsave(db, c, a, tx):
    return resp.integer(db.last_save_time)


def cmd_recovery(db, c, a, tx):
    sub = a[1].upper()
    if sub == b"LAST":
        r = db.recovery.to_dict() if db.recovery else None
        return resp.bulk(json.dumps({"status": db.status, "report": r}).encode())
    if sub == b"HISTORY":
        return resp.bulk(json.dumps(read_history(db.cfg.dir)).encode())
    if sub == b"RESTORES":
        return resp.bulk(json.dumps(read_history(db.cfg.dir, "restore-verifications.jsonl")).encode())
    raise CommandError("ERR RECOVERY subcommand must be LAST, HISTORY or RESTORES")


def cmd_aof(db, c, a, tx):
    """AOF TAIL [count] -- newest complete log records on disk, as JSON."""
    if a[1].upper() != b"TAIL" or len(a) > 3:
        raise CommandError("ERR AOF subcommand must be TAIL [count]")
    count = parse_int(a[2]) if len(a) == 3 else 30
    if not 1 <= count <= 500:
        raise CommandError("ERR count must be between 1 and 500")

    async def run():
        recs = await asyncio.to_thread(read_tail, db.cfg.dir, count)
        return resp.bulk(json.dumps(recs).encode())
    return run()


def cmd_debug(db, c, a, tx):
    if not db.cfg.enable_debug_command:
        raise CommandError("ERR DEBUG command not allowed. Start the server with --enable-debug-command")
    sub = a[1].upper()
    if sub == b"CRASH":
        if len(a) == 4 and a[2].upper() == b"SLOW":
            # One-shot marker: the next startup stays in "recovering" this long,
            # to test how clients and the dashboard behave during slow recovery.
            ms = min(max(parse_int(a[3]), 0), 30000)
            path = os.path.join(db.cfg.dir, ".debug-recovery-delay")
            with open(path, "w") as f:
                f.write(str(ms))
                f.flush()
                os.fsync(f.fileno())
        elif len(a) != 2:
            raise CommandError("ERR usage: DEBUG CRASH [SLOW <ms>]")
        log.warning("DEBUG CRASH requested by %s -- terminating abruptly (no snapshot, no cleanup)", c.addr)
        logging.shutdown()
        os._exit(1)
    if sub == b"SLEEP" and len(a) == 3:
        try:
            sec = float(a[2])
        except ValueError:
            raise CommandError("ERR value is not a valid float") from None
        return _debug_sleep(min(max(sec, 0.0), 60.0))
    raise CommandError("ERR DEBUG subcommand must be CRASH [SLOW <ms>] or SLEEP <seconds>")


async def _debug_sleep(sec: float):
    await asyncio.sleep(sec)
    return resp.OK


def cmd_shutdown(db, c, a, tx):
    save = db.cfg.save_on_shutdown
    for opt in a[1:]:
        o = opt.upper()
        if o == b"NOSAVE":
            save = False
        elif o == b"SAVE":
            save = True
        else:
            raise CommandError("ERR syntax error")
    from .server import request_shutdown
    request_shutdown(save)
    c.close_after_reply = True
    return resp.OK


# =========================================================================== table
def _s(name, h, arity, summary, **kw) -> tuple[bytes, Spec]:
    return name.lower().encode(), Spec(name.lower(), h, arity, summary=summary, **kw)


COMMANDS: dict[bytes, Spec] = dict([
    _s("PING", cmd_ping, -1, "PING [message]", loading_ok=True, noauth=False),
    _s("ECHO", cmd_echo, 2, "ECHO message"),
    _s("QUIT", cmd_quit, -1, "QUIT", loading_ok=True, noauth=True),
    _s("SELECT", cmd_select, 2, "SELECT 0", loading_ok=True),
    _s("AUTH", cmd_auth, -2, "AUTH [username] password", loading_ok=True, noauth=True),
    _s("COMMAND", cmd_command, -1, "COMMAND [COUNT]", loading_ok=True),
    _s("TIME", cmd_time, 1, "TIME", loading_ok=True),
    _s("CONFIG", cmd_config, -2, "CONFIG GET pattern", loading_ok=True),
    _s("SET", cmd_set, -3, "SET key value [NX|XX] [GET] [EX s|PX ms|EXAT ts|PXAT ms-ts|KEEPTTL]", write=True),
    _s("GET", cmd_get, 2, "GET key"),
    _s("MGET", cmd_mget, -2, "MGET key [key ...]"),
    _s("STRLEN", cmd_strlen, 2, "STRLEN key"),
    _s("DEL", cmd_del, -2, "DEL key [key ...]", write=True),
    _s("UNLINK", cmd_del, -2, "UNLINK key [key ...]", write=True),
    _s("EXISTS", cmd_exists, -2, "EXISTS key [key ...]"),
    _s("TYPE", cmd_type, 2, "TYPE key"),
    _s("EXPIRE", _expire_generic(1000, False, "expire"), -3, "EXPIRE key seconds [NX|XX|GT|LT]", write=True),
    _s("PEXPIRE", _expire_generic(1, False, "pexpire"), -3, "PEXPIRE key ms [NX|XX|GT|LT]", write=True),
    _s("EXPIREAT", _expire_generic(1000, True, "expireat"), -3, "EXPIREAT key unix-seconds", write=True),
    _s("PEXPIREAT", _expire_generic(1, True, "pexpireat"), -3, "PEXPIREAT key unix-ms", write=True),
    _s("TTL", _ttl_generic("ttl"), 2, "TTL key"),
    _s("PTTL", _ttl_generic("pttl"), 2, "PTTL key"),
    _s("EXPIRETIME", _ttl_generic("expiretime"), 2, "EXPIRETIME key"),
    _s("PEXPIRETIME", _ttl_generic("pexpiretime"), 2, "PEXPIRETIME key"),
    _s("PERSIST", cmd_persist, 2, "PERSIST key", write=True),
    _s("DBSIZE", cmd_dbsize, 1, "DBSIZE"),
    _s("KEYS", cmd_keys, 2, "KEYS pattern"),
    _s("KEYCOUNT", cmd_keycount, 2, "KEYCOUNT pattern"),
    _s("SCAN", cmd_scan, -2, "SCAN cursor [MATCH pattern] [COUNT n]"),
    _s("FLUSHDB", cmd_flushdb, -1, "FLUSHDB", write=True),
    _s("FLUSHALL", cmd_flushdb, -1, "FLUSHALL", write=True),
    _s("INFO", cmd_info, -1, "INFO [section]", loading_ok=True),
    _s("SAVE", cmd_save, 1, "SAVE"),
    _s("BGSAVE", cmd_bgsave, -1, "BGSAVE"),
    _s("LASTSAVE", cmd_lastsave, 1, "LASTSAVE", loading_ok=True),
    _s("RECOVERY", cmd_recovery, 2, "RECOVERY LAST|HISTORY|RESTORES", loading_ok=True),
    _s("AOF", cmd_aof, -2, "AOF TAIL [count]", loading_ok=False),
    _s("DEBUG", cmd_debug, -2, "DEBUG CRASH [SLOW ms]|SLEEP seconds", loading_ok=True),
    _s("SHUTDOWN", cmd_shutdown, -1, "SHUTDOWN [NOSAVE|SAVE]", loading_ok=True),
])
