from __future__ import annotations

import argparse
import os
from dataclasses import dataclass


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 6380
    dir: str = "./data"
    appendfsync: str = "always"  # always | everysec | no
    snapshot_every_ops: int = 10_000
    snapshot_every_seconds: int = 300
    save_on_shutdown: bool = True
    requirepass: str | None = None
    enable_debug_command: bool = False
    max_bulk_bytes: int = 64 * 1024 * 1024
    max_clients: int = 1000
    log_level: str = "INFO"


def _env(name: str, default):
    v = os.environ.get("MINIREDIS_" + name)
    if v is None or v == "":
        return default
    if isinstance(default, bool):
        return v.lower() in ("1", "true", "yes", "on")
    if isinstance(default, int):
        return int(v)
    return v


def parse_args(argv: list[str] | None = None) -> Config:
    d = Config()
    p = argparse.ArgumentParser(prog="miniredis", description="Persistent Redis-style key-value server (RESP2).")
    p.add_argument("--host", default=_env("HOST", d.host))
    p.add_argument("--port", type=int, default=_env("PORT", d.port))
    p.add_argument("--dir", default=_env("DIR", d.dir), help="data directory for snapshot and log")
    p.add_argument("--appendfsync", choices=["always", "everysec", "no"], default=_env("APPENDFSYNC", d.appendfsync),
                   help="always: reply only after fsync (durable). everysec: fsync once per second. no: leave it to the OS")
    p.add_argument("--snapshot-every-ops", type=int, default=_env("SNAPSHOT_EVERY_OPS", d.snapshot_every_ops))
    p.add_argument("--snapshot-every-seconds", type=int, default=_env("SNAPSHOT_EVERY_SECONDS", d.snapshot_every_seconds))
    p.add_argument("--no-save-on-shutdown", action="store_true", default=not _env("SAVE_ON_SHUTDOWN", d.save_on_shutdown))
    p.add_argument("--requirepass", default=_env("REQUIREPASS", d.requirepass))
    p.add_argument("--enable-debug-command", action="store_true", default=_env("ENABLE_DEBUG_COMMAND", d.enable_debug_command),
                   help="allow DEBUG CRASH (abrupt termination, used by the recovery demo)")
    p.add_argument("--max-bulk-bytes", type=int, default=_env("MAX_BULK_BYTES", d.max_bulk_bytes))
    p.add_argument("--max-clients", type=int, default=_env("MAX_CLIENTS", d.max_clients))
    p.add_argument("--log-level", default=_env("LOG_LEVEL", d.log_level))
    a = p.parse_args(argv)
    return Config(
        host=a.host, port=a.port, dir=a.dir, appendfsync=a.appendfsync,
        snapshot_every_ops=a.snapshot_every_ops, snapshot_every_seconds=a.snapshot_every_seconds,
        save_on_shutdown=not a.no_save_on_shutdown, requirepass=a.requirepass or None,
        enable_debug_command=a.enable_debug_command, max_bulk_bytes=a.max_bulk_bytes,
        max_clients=a.max_clients, log_level=a.log_level.upper(),
    )
