from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    # Unset *or empty* means "use the default", so docker-compose can pass a
    # variable through as ${VAR:-} without forcing it to false.
    return default if v is None or v.strip() == "" else v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    db_host: str = field(default_factory=lambda: os.environ.get("DB_HOST", "127.0.0.1"))
    db_port: int = field(default_factory=lambda: int(os.environ.get("DB_PORT", "6380")))
    db_password: str | None = field(default_factory=lambda: os.environ.get("DB_PASSWORD") or None)
    # Empty password = writes are open (local development only).
    dashboard_password: str = field(default_factory=lambda: os.environ.get("DASHBOARD_PASSWORD", ""))
    session_secret: str = field(default_factory=lambda: os.environ.get("SESSION_SECRET") or secrets.token_hex(32))
    session_hours: int = field(default_factory=lambda: int(os.environ.get("SESSION_HOURS", "12")))
    instance_name: str = field(default_factory=lambda: os.environ.get("INSTANCE_NAME", "local-demo"))
    # How a developer reaches the database from a terminal. Used for the
    # copyable commands in the dashboard. In Docker the DB port is internal,
    # so the default there is `docker compose exec db python -m miniredis.cli`.
    cli_prefix: str = field(default_factory=lambda: os.environ.get("CLI_PREFIX", ""))
    # Set only if you publish the DB port on the host (e.g. "203.0.113.5:6380").
    db_public_address: str = field(default_factory=lambda: os.environ.get("DB_PUBLIC_ADDRESS", ""))
    # false = key names, values, console output and the raw log need sign-in too.
    public_reads: bool = field(default_factory=lambda: _bool("PUBLIC_READS", False))
    # Where crash-lab / workload reports are kept (a Docker volume in production).
    reports_dir: str = field(default_factory=lambda: os.environ.get("REPORTS_DIR", "./api-data"))
    allow_crash_demo: bool = field(default_factory=lambda: _bool("ALLOW_CRASH_DEMO", True))
    # The simulated e-commerce workload writes shop:* keys. Defaults to the
    # crash-demo setting: on for the demo profile, off for private data.
    allow_demo_workload: bool = field(default_factory=lambda: _bool("ALLOW_DEMO_WORKLOAD", _bool("ALLOW_CRASH_DEMO", True)))
    cors_origins: list[str] = field(default_factory=lambda: [
        o.strip() for o in os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
        if o.strip()
    ])

    @property
    def auth_required(self) -> bool:
        return bool(self.dashboard_password)
