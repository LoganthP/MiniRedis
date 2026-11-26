"""Dashboard API. Every data operation is a RESP command sent to the database
server over TCP -- the same interface redis-cli uses."""
from __future__ import annotations

import asyncio
import base64
import json
import shlex
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .auth import can_read, check_password, is_authenticated, issue_token, require_auth, require_read
from .resp_client import ReplyError, RespClient, Unreachable, encode
from .sample_data import SAMPLE_KEYS
from . import importer as imp
from .history import MetricsHistory, ReportStore
from .synthetic import build as build_synthetic
from .settings import Settings
from .workload import Workload

WRITE_COMMANDS = {
    "set", "del", "unlink", "expire", "pexpire", "expireat", "pexpireat", "persist",
    "flushdb", "flushall", "save", "bgsave",
}
BLOCKED_COMMANDS = {
    "quit": "QUIT would close the dashboard's pooled connection.",
    "auth": "The API authenticates to the database itself.",
    "shutdown": "Stop the server from the host or Docker instead.",
    "debug": "Use the crash-and-recover demo on the Recovery page.",
    "select": "This server has a single database (0).",
}
MAX_VALUE_BYTES = 1024 * 1024
MAX_PREVIEW = 120


@asynccontextmanager
async def lifespan(app: FastAPI):
    s: Settings = app.state.settings
    app.state.db = RespClient(s.db_host, s.db_port, s.db_password)
    app.state.workload = Workload(s.db_host, s.db_port, s.db_password)
    app.state.history = MetricsHistory(RespClient(s.db_host, s.db_port, s.db_password, pool_size=1, connect_timeout=0.5))
    app.state.reports = ReportStore(s.reports_dir)
    app.state.uploads = imp.UploadStore()
    app.state.imports: dict[str, imp.ImportJob] = {}
    app.state.insights_cache: dict = {}
    app.state.history.start()
    yield
    await app.state.workload.stop("API shutting down")
    await app.state.history.stop()
    import shutil as _sh
    _sh.rmtree(app.state.uploads.root, ignore_errors=True)
    app.state.db.reset()


def create_app(settings: Settings | None = None) -> FastAPI:
    app = FastAPI(title="MiniRedis Dashboard API", version="1.0.0", lifespan=lifespan)
    app.state.settings = settings or Settings()
    app.add_middleware(CORSMiddleware, allow_origins=app.state.settings.cors_origins,
                       allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(Unreachable)
    async def _unreachable(_: Request, exc: Unreachable):
        return JSONResponse(status_code=503, content={"detail": "The database is not reachable right now.",
                                                      "code": "OFFLINE", "reason": str(exc)})

    @app.exception_handler(imp.ImportError_)
    async def _import_error(_: Request, exc: imp.ImportError_):
        return JSONResponse(status_code=400, content={"detail": str(exc), "code": "IMPORT"})

    @app.exception_handler(ReplyError)
    async def _reply_error(_: Request, exc: ReplyError):
        code = exc.code
        if code == "LOADING":
            return JSONResponse(status_code=503, content={"detail": "The database is recovering. Try again in a moment.",
                                                          "code": code})
        if code == "MISCONF":
            return JSONResponse(status_code=503, content={"detail": str(exc), "code": code})
        return JSONResponse(status_code=400, content={"detail": str(exc), "code": code})

    app.state.loads = {}
    register_routes(app)
    return app


# ============================================================================ helpers

def db(request: Request) -> RespClient:
    return request.app.state.db


def text_or_b64(raw: bytes) -> tuple[str, bool]:
    try:
        return raw.decode("utf-8"), False
    except UnicodeDecodeError:
        return base64.b64encode(raw).decode(), True


def parse_info(raw: bytes) -> dict:
    sections: dict[str, dict] = {}
    current = sections.setdefault("misc", {})
    for line in raw.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("#"):
            current = sections.setdefault(line[1:].strip().lower(), {})
            continue
        k, _, v = line.partition(":")
        try:
            current[k] = int(v)
        except ValueError:
            try:
                current[k] = float(v)
            except ValueError:
                current[k] = v
    return sections


def escape_wire(b: bytes, limit: int = 1200) -> str:
    out = b[:limit].decode("latin-1").replace("\\", "\\\\").replace("\r", "\\r").replace("\n", "\\n")
    return out + ("…" if len(b) > limit else "")


def instance(request: Request) -> dict:
    s: Settings = request.app.state.settings
    if s.cli_prefix:
        cli = s.cli_prefix
    elif s.db_public_address:
        host, _, port = s.db_public_address.rpartition(":")
        cli = f"redis-cli -h {host} -p {port}"
    else:
        cli = f"redis-cli -p {s.db_port}" if s.db_host in ("127.0.0.1", "localhost") else f"redis-cli -h {s.db_host} -p {s.db_port}"
    return {"name": s.instance_name, "host": s.db_host, "port": s.db_port,
            "internal": s.db_host not in ("127.0.0.1", "localhost") and not s.db_public_address,
            "public_address": s.db_public_address or None, "cli_prefix": cli}


def reply_to_json(reply) -> dict:
    """Typed reply tree; the browser renders it the way redis-cli does."""
    if isinstance(reply, ReplyError):
        return {"type": "error", "value": str(reply)}
    if reply is None:
        return {"type": "nil"}
    if isinstance(reply, bool):  # pragma: no cover
        return {"type": "integer", "value": int(reply)}
    if isinstance(reply, int):
        return {"type": "integer", "value": reply}
    if isinstance(reply, str):
        return {"type": "status", "value": reply}
    if isinstance(reply, bytes):
        text, binary = text_or_b64(reply)
        return {"type": "bulk", "value": text, "binary": binary}
    if isinstance(reply, list):
        return {"type": "array", "value": [reply_to_json(r) for r in reply]}
    return {"type": "status", "value": str(reply)}


async def key_detail(client: RespClient, key: str, with_value: bool = True) -> dict | None:
    cmds = [("EXISTS", key), ("PTTL", key), ("PEXPIRETIME", key), ("STRLEN", key)]
    if with_value:
        cmds.append(("GET", key))
    replies = await client.pipeline_raw(cmds)
    for r in replies:
        if isinstance(r, ReplyError):
            raise r
    if replies[0] == 0:
        return None
    out = {
        "key": key,
        "ttl_ms": replies[1] if replies[1] >= 0 else None,
        "expire_at_ms": replies[2] if replies[2] >= 0 else None,
        "size": replies[3],
    }
    if with_value:
        raw = replies[4] if replies[4] is not None else b""
        truncated = len(raw) > MAX_VALUE_BYTES
        value, binary = text_or_b64(raw[:MAX_VALUE_BYTES])
        out.update(value=value, binary=binary, truncated=truncated)
    return out


# ============================================================================ models

class LoginBody(BaseModel):
    password: str


class PutKeyBody(BaseModel):
    key: str = Field(min_length=1, max_length=1024)
    value: str = Field(max_length=MAX_VALUE_BYTES)
    ttl_seconds: int | None = Field(default=None, ge=1, le=10 * 365 * 24 * 3600)
    keep_ttl: bool = False
    only_if_new: bool = False


class ExpireBody(BaseModel):
    key: str = Field(min_length=1)
    ttl_seconds: int | None = Field(default=None, ge=1, le=10 * 365 * 24 * 3600)


class CommandBody(BaseModel):
    command: str = Field(min_length=1, max_length=64 * 1024)


# ============================================================================ routes

def register_routes(app: FastAPI) -> None:

    @app.get("/api/health")
    async def health(request: Request):
        try:
            info = parse_info(await db(request).call("INFO", "persistence"))
            return {"api": "ok", "db": {"reachable": True, "status": info["persistence"]["status"]}}
        except (Unreachable, ReplyError) as e:
            return {"api": "ok", "db": {"reachable": False, "status": "offline", "reason": str(e)}}

    @app.get("/api/session")
    async def session(request: Request, authorization: str | None = Header(default=None)):
        s: Settings = request.app.state.settings
        return {"auth_required": s.auth_required, "authenticated": is_authenticated(request, authorization),
                "can_read": can_read(request, authorization), "public_reads": s.public_reads or not s.auth_required,
                "crash_demo_enabled": s.allow_crash_demo, "demo_workload_enabled": s.allow_demo_workload}

    @app.post("/api/login")
    async def login(body: LoginBody, request: Request):
        s: Settings = request.app.state.settings
        if not s.auth_required:
            return {"token": "", "expires_at": None, "auth_required": False}
        if not check_password(s.dashboard_password, body.password):
            raise HTTPException(status_code=401, detail="That password is not correct.")
        token, exp = issue_token(s.session_secret, s.session_hours)
        return {"token": token, "expires_at": exp, "auth_required": True}

    @app.get("/api/overview")
    async def overview(request: Request, authorization: str | None = Header(default=None)):
        t0 = time.perf_counter()
        try:
            info_raw, last_raw = await db(request).pipeline_raw([("INFO",), ("RECOVERY", "LAST")])
            observed_ms = int(time.time() * 1000)
        except Unreachable as e:
            return {"reachable": False, "status": "offline", "reason": str(e), "checked_at": time.time(),
                    "instance": instance(request)}
        if isinstance(info_raw, ReplyError):
            raise info_raw
        info = parse_info(info_raw)
        p = info.get("persistence", {})
        last = json.loads(last_raw) if isinstance(last_raw, bytes) else {}
        report = (last or {}).get("report")
        if report and not can_read(request, authorization):
            report["replay_tail"] = []  # contains key names and values
            report["redacted"] = True
        keyspace = info.get("keyspace", {}).get("db0", "")
        keys = expires = 0
        if isinstance(keyspace, str) and keyspace:
            parts = dict(kv.split("=") for kv in keyspace.split(","))
            keys, expires = int(parts.get("keys", 0)), int(parts.get("expires", 0))
        return {
            "reachable": True,
            "instance": instance(request),
            "status": p.get("status", "unknown"),
            "degraded_reason": p.get("degraded_reason") or None,
            "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
            "checked_at": time.time(),
            "observed_ms": observed_ms,
            "server": info.get("server", {}),
            "clients": info.get("clients", {}),
            "stats": info.get("stats", {}),
            "memory": info.get("memory", {}),
            "persistence": p,
            "keyspace": {"keys": keys, "expires": expires},
            "recovery": report,
        }

    @app.get("/api/recovery/history")
    async def recovery_history(request: Request):
        raw = await db(request).call("RECOVERY", "HISTORY")
        return {"history": list(reversed(json.loads(raw)))}

    @app.get("/api/wait-ready", dependencies=[Depends(require_auth)])
    async def wait_ready(request: Request, previous_run_id: str = Query("", max_length=64),
                         timeout: float = Query(30, ge=0.5, le=60)):
        """Long-poll until a server with a different run id is ready.

        Probes every 10 ms with a 250 ms connect timeout, so the "ready ->
        first successful command" gap is not bounded by the browser's polling
        interval. Returns the phases it saw, timestamped on the API clock."""
        s: Settings = request.app.state.settings
        probe = RespClient(s.db_host, s.db_port, s.db_password, pool_size=1, timeout=1.0, connect_timeout=0.25)
        t0 = time.perf_counter()
        phases: list[dict] = []
        attempts = 0
        try:
            while time.perf_counter() - t0 < timeout:
                attempts += 1
                try:
                    info = parse_info(await probe.call("INFO"))
                    status = str(info.get("persistence", {}).get("status", "unknown"))
                    run_id = str(info.get("server", {}).get("run_id", ""))
                    restarted = run_id != previous_run_id
                    phase = status if restarted else f"{status} (old run)"
                except (Unreachable, ReplyError):
                    probe.reset()
                    phase, restarted, status, run_id = "offline", False, "offline", ""
                if not phases or phases[-1]["phase"] != phase:
                    phases.append({"phase": phase, "at_ms": int(time.time() * 1000)})
                if restarted and status == "ready":
                    wl: Workload = request.app.state.workload
                    if wl.running:
                        wl.event("ready", "database ready again (first successful command)", int(time.time() * 1000))
                    return {"ready": True, "run_id": run_id, "observed_ms": int(time.time() * 1000),
                            "waited_ms": round((time.perf_counter() - t0) * 1000, 1), "attempts": attempts,
                            "phases": phases}
                if restarted and status == "degraded":
                    raise HTTPException(status_code=503, detail=f"Recovery failed: {info['persistence'].get('degraded_reason')}")
                await asyncio.sleep(0.01)
        finally:
            probe.reset()
        raise HTTPException(status_code=504, detail="The database did not become ready in time.")

    # ----------------------------------------------------------- demo workload
    @app.get("/api/workload")
    async def workload_status(request: Request, seconds: int = Query(300, ge=10, le=900)):
        """Application-side metrics of the simulated e-commerce app (aggregates only, no key data)."""
        return request.app.state.workload.snapshot(seconds)

    @app.post("/api/workload/start", dependencies=[Depends(require_auth)])
    async def workload_start(request: Request, body: WorkloadBody):
        s: Settings = request.app.state.settings
        if not s.allow_demo_workload:
            raise HTTPException(status_code=403, detail="The demo workload is disabled on this deployment (ALLOW_DEMO_WORKLOAD=false).")
        orders = body.orders_prefix
        if body.dataset_prefix and orders is None:
            orders = None
            for r in request.app.state.reports.list("dataset"):  # newest first
                if r["prefix"] == body.dataset_prefix or "order" not in (r.get("id_column", "") + r["prefix"]).lower():
                    continue
                if await db(request).call("KEYCOUNT", f"{imp._glob_escape(r['prefix'])}*") > 0:
                    orders = r["prefix"]
                    break
        try:
            await request.app.state.workload.start(body.rps, body.duration_s, body.dataset_prefix, orders or None)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return request.app.state.workload.snapshot(60)

    @app.post("/api/workload/stop", dependencies=[Depends(require_auth)])
    async def workload_stop(request: Request):
        await request.app.state.workload.stop("stopped by user")
        return request.app.state.workload.snapshot(60)

    # ----------------------------------------------------------- history & reports
    @app.get("/api/metrics/history")
    async def metrics_history(request: Request, minutes: int = Query(15, ge=1, le=30)):
        return {"points": request.app.state.history.series(minutes), "interval_s": 2}

    @app.post("/api/reports", dependencies=[Depends(require_auth)])
    async def save_report(request: Request, body: ReportBody):
        raw = json.dumps(body.report)
        if len(raw) > 512 * 1024:
            raise HTTPException(status_code=413, detail="Report too large.")
        return request.app.state.reports.add(body.kind, body.report)

    @app.get("/api/reports", dependencies=[Depends(require_read)])
    async def list_reports(request: Request, kind: str | None = None, limit: int = Query(50, ge=1, le=200)):
        return {"reports": request.app.state.reports.list(kind)[:limit]}

    @app.get("/api/reports/{rid}", dependencies=[Depends(require_read)])
    async def get_report(request: Request, rid: str):
        r = request.app.state.reports.get(rid)
        if not r:
            raise HTTPException(status_code=404, detail="No such report.")
        return r

    @app.get("/api/restores")
    async def restores(request: Request):
        """Results of scripts/verify-backup.sh (restore into a fresh directory)."""
        raw = await db(request).call("RECOVERY", "RESTORES")
        return {"restores": list(reversed(json.loads(raw)))}

    # ----------------------------------------------------------- dataset import
    @app.post("/api/import/upload", dependencies=[Depends(require_auth)])
    async def import_upload(request: Request, filename: str = Query(..., min_length=1, max_length=255)):
        """Raw upload (the browser sends the file as the request body)."""
        up = await request.app.state.uploads.save(filename, request.stream())
        files = await asyncio.to_thread(imp.inspect, up)
        return {"upload_id": up.id, "name": up.name, "size": up.size, "zip": up.is_zip, "files": files,
                "limits": {"max_upload_mb": imp.LIMITS.max_upload_bytes // 2**20,
                           "max_uncompressed_mb": imp.LIMITS.max_uncompressed_bytes // 2**20,
                           "max_records": imp.LIMITS.max_records}}

    @app.get("/api/import/{uid}/preview", dependencies=[Depends(require_auth)])
    async def import_preview(request: Request, uid: str, file: str = Query(...)):
        up = request.app.state.uploads.get(uid)
        return await asyncio.to_thread(imp.preview, up, file)

    @app.post("/api/import/{uid}/plan", dependencies=[Depends(require_auth)])
    async def import_plan(request: Request, uid: str, body: ImportPlanBody):
        up = request.app.state.uploads.get(uid)
        return await imp.plan(db(request), up, body.file, body.id_column, body.prefix)

    @app.post("/api/import/{uid}/start", dependencies=[Depends(require_auth)])
    async def import_start(request: Request, uid: str, body: ImportStartBody):
        up = request.app.state.uploads.get(uid)
        fmt = await asyncio.to_thread(imp.member_format, up, body.file)
        if any(j.state == "running" for j in request.app.state.imports.values()):
            raise HTTPException(status_code=409, detail="Another import is still running.")
        job = imp.ImportJob(id=uuid_hex(), upload_name=up.name, file=body.file, fmt=fmt, id_column=body.id_column,
                            prefix=body.prefix, ttl_seconds=body.ttl_seconds, on_existing=body.on_existing,
                            max_records=min(body.max_records or imp.LIMITS.max_records, imp.LIMITS.max_records))
        request.app.state.imports[job.id] = job
        reports: ReportStore = request.app.state.reports

        def done(j: imp.ImportJob) -> None:
            if j.added or j.updated:
                reports.add("dataset", {"prefix": j.prefix, "source": f"{j.upload_name} › {j.file}", "format": j.fmt,
                                        "id_column": j.id_column, "columns": j.columns, "ttl_seconds": j.ttl_seconds,
                                        "added": j.added, "updated": j.updated, "skipped": j.skipped, "failed": j.failed,
                                        "processed": j.processed, "state": j.state})
            request.app.state.insights_cache.clear()

        job_client = RespClient(request.app.state.settings.db_host, request.app.state.settings.db_port,
                                request.app.state.settings.db_password, pool_size=2, timeout=30)
        asyncio.create_task(imp.run_job(job, up, job_client, done))
        return job.to_dict()

    @app.get("/api/import/jobs/{jid}", dependencies=[Depends(require_auth)])
    async def import_job(request: Request, jid: str):
        job = request.app.state.imports.get(jid)
        if not job:
            raise HTTPException(status_code=404, detail="Unknown import job.")
        return job.to_dict()

    @app.post("/api/import/jobs/{jid}/cancel", dependencies=[Depends(require_auth)])
    async def import_cancel(request: Request, jid: str):
        job = request.app.state.imports.get(jid)
        if not job:
            raise HTTPException(status_code=404, detail="Unknown import job.")
        job._cancel = True
        return job.to_dict()

    @app.get("/api/import/synthetic.zip")
    async def synthetic_zip(products: int = Query(1000, ge=10, le=100_000), orders: int = Query(5000, ge=10, le=200_000)):
        """CC0 synthetic shop data shaped like Olist — safe to use in client demos."""
        data = await asyncio.to_thread(build_synthetic, products, orders)
        from fastapi.responses import Response as _R
        return _R(content=data, media_type="application/zip",
                  headers={"Content-Disposition": f'attachment; filename="synthetic-shop-{products}p-{orders}o.zip"'})

    # ----------------------------------------------------------- datasets
    @app.get("/api/datasets", dependencies=[Depends(require_read)])
    async def datasets(request: Request):
        """Imported datasets (latest import per prefix) with their live key counts."""
        latest: dict[str, dict] = {}
        for r in request.app.state.reports.list("dataset"):
            latest.setdefault(r["prefix"], r)
        items = list(latest.values())
        if items:
            counts = await db(request).pipeline_raw([("KEYCOUNT", f"{imp._glob_escape(d['prefix'])}*") for d in items])
            for d, c in zip(items, counts):
                d["live_keys"] = c if isinstance(c, int) else None
        return {"datasets": items}

    @app.get("/api/datasets/insights", dependencies=[Depends(require_read)])
    async def dataset_insights(request: Request, prefix: str = Query(..., min_length=1), category: str | None = None,
                               date: str | None = None, sample: int = Query(20000, ge=100, le=100000)):
        """Category counts and records per month, computed from the stored JSON values (sampled)."""
        cache = request.app.state.insights_cache
        ck = (prefix, category, date, sample)
        if ck in cache and time.time() - cache[ck]["_at"] < 10:
            return cache[ck]["data"]
        client = db(request)
        pattern = f"{imp._glob_escape(prefix)}*"
        total = await client.call("KEYCOUNT", pattern)
        keys: list[bytes] = []
        cursor = 0
        while len(keys) < sample:
            nxt, batch = await client.call("SCAN", cursor, "MATCH", pattern, "COUNT", 1000)
            keys += batch
            cursor = int(nxt)
            if cursor == 0:
                break
        keys = keys[:sample]
        records: list[dict] = []
        ttl_keys = 0
        for i in range(0, len(keys), 1000):
            chunk = keys[i:i + 1000]
            replies = await client.pipeline_raw([c for k in chunk for c in (("GET", k), ("PTTL", k))])
            for j in range(0, len(replies), 2):
                v, t = replies[j], replies[j + 1]
                if isinstance(t, int) and t >= 0:
                    ttl_keys += 1
                if isinstance(v, bytes):
                    try:
                        obj = json.loads(v)
                        if isinstance(obj, dict):
                            records.append(obj)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        pass
        data = _insights(records, category, date)
        data.update(prefix=prefix, total_keys=total, scanned=len(keys), ttl_keys=ttl_keys, json_records=len(records))
        cache[ck] = {"_at": time.time(), "data": data}
        return data

    @app.post("/api/datasets/fingerprint", dependencies=[Depends(require_auth)])
    async def dataset_fingerprint(request: Request, body: FingerprintBody):
        """Count + SHA-256 over (key, value, absolute deadline) for each prefix. Keys that
        expire within `exclude_expiring_within_ms` are left out so a fingerprint taken
        before a crash can be compared with one taken after it."""
        import hashlib
        client = db(request)
        now = int(time.time() * 1000)
        cutoff = body.cutoff_ms or now + body.exclude_expiring_within_ms
        out = {}
        for prefix in body.prefixes[:10]:
            pattern = f"{imp._glob_escape(prefix)}*"
            keys: list[bytes] = []
            cursor = 0
            while True:
                nxt, batch = await client.call("SCAN", cursor, "MATCH", pattern, "COUNT", 2000)
                keys += batch
                cursor = int(nxt)
                if cursor == 0 or len(keys) >= 200_000:
                    break
            h = hashlib.sha256()
            count = ttl = excluded = 0
            for i in range(0, len(keys), 1000):
                chunk = sorted(keys[i:i + 1000])
                replies = await client.pipeline_raw([c for k in chunk for c in (("GET", k), ("PEXPIRETIME", k))])
                for k, j in zip(chunk, range(0, len(replies), 2)):
                    v, exp = replies[j], replies[j + 1]
                    if not isinstance(v, bytes):
                        continue
                    if isinstance(exp, int) and exp >= 0 and exp < cutoff:
                        excluded += 1
                        continue
                    count += 1
                    ttl += int(isinstance(exp, int) and exp >= 0)
                    h.update(k + b"\x00" + v + b"\x00" + str(exp).encode() + b"\n")
            out[prefix] = {"count": count, "with_ttl": ttl, "excluded_expiring_soon": excluded, "digest": h.hexdigest()}
        return {"fingerprints": out, "at_ms": now, "cutoff_ms": cutoff}

    @app.get("/api/aof/tail", dependencies=[Depends(require_read)])
    async def aof_tail(request: Request, count: int = Query(30, ge=1, le=200)):
        raw = await db(request).call("AOF", "TAIL", count)
        return {"records": json.loads(raw)}

    @app.get("/api/keys", dependencies=[Depends(require_read)])
    async def list_keys(request: Request, cursor: int = Query(0, ge=0), count: int = Query(25, ge=1, le=200),
                        match: str = Query("*", max_length=512)):
        client = db(request)
        pattern = match.strip() or "*"
        nxt, keys = await client.call("SCAN", cursor, "MATCH", pattern, "COUNT", count)
        total = await client.call("DBSIZE")
        items = []
        if keys:
            cmds = []
            for k in keys:
                cmds += [("PTTL", k), ("PEXPIRETIME", k), ("STRLEN", k)]
            replies = await client.pipeline_raw(cmds)
            # Previews are fetched only for short values so pages stay light;
            # full values load on demand from /api/key.
            sizes = replies[2::3]
            preview_keys = [k for k, size in zip(keys, sizes) if isinstance(size, int) and 0 < size <= 4096]
            previews = dict(zip(preview_keys, await client.pipeline_raw([("GET", k) for k in preview_keys]))) \
                if preview_keys else {}
            for i, k in enumerate(keys):
                pttl, pexp, size = replies[i * 3:i * 3 + 3]
                if pttl == -2:
                    continue  # expired between SCAN and PTTL
                name, binary_key = text_or_b64(k)
                pv = previews.get(k)
                preview = None
                if isinstance(pv, bytes):
                    t, b = text_or_b64(pv[:MAX_PREVIEW])
                    preview = None if b else t
                items.append({
                    "key": name, "binary_key": binary_key,
                    "ttl_ms": pttl if isinstance(pttl, int) and pttl >= 0 else None,
                    "expire_at_ms": pexp if isinstance(pexp, int) and pexp >= 0 else None,
                    "size": size if isinstance(size, int) else 0,
                    "preview": preview,
                })
        return {"keys": items, "next_cursor": int(nxt), "total": total, "match": pattern}

    @app.get("/api/key", dependencies=[Depends(require_read)])
    async def get_key(request: Request, key: str = Query(min_length=1)):
        d = await key_detail(db(request), key)
        if d is None:
            raise HTTPException(status_code=404, detail="That key does not exist or has expired.")
        return d

    @app.put("/api/key", dependencies=[Depends(require_auth)])
    async def put_key(body: PutKeyBody, request: Request):
        args: list = ["SET", body.key, body.value]
        if body.only_if_new:
            args.append("NX")
        if body.ttl_seconds:
            args += ["EX", body.ttl_seconds]
        elif body.keep_ttl:
            args.append("KEEPTTL")
        res = await db(request).call(*args)
        if res is None:
            raise HTTPException(status_code=409, detail="A key with that name already exists.")
        return {"ok": True, "command": [str(a) for a in args], "key": await key_detail(db(request), body.key)}

    @app.post("/api/key/expire", dependencies=[Depends(require_auth)])
    async def expire_key(body: ExpireBody, request: Request):
        args = ["EXPIRE", body.key, body.ttl_seconds] if body.ttl_seconds else ["PERSIST", body.key]
        client = db(request)
        if not await client.call("EXISTS", body.key):
            raise HTTPException(status_code=404, detail="That key does not exist or has expired.")
        await client.call(*args)
        return {"ok": True, "command": [str(a) for a in args], "key": await key_detail(client, body.key)}

    @app.delete("/api/key", dependencies=[Depends(require_auth)])
    async def delete_key(request: Request, key: str = Query(min_length=1)):
        n = await db(request).call("DEL", key)
        return {"ok": True, "deleted": n, "command": ["DEL", key]}

    @app.post("/api/command", dependencies=[Depends(require_read)])
    async def run_command(body: CommandBody, request: Request, authorization: str | None = Header(default=None)):
        try:
            tokens = shlex.split(body.command, posix=True)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"Could not parse the command: {e}")
        if not tokens:
            raise HTTPException(status_code=400, detail="Type a command, for example: GET user:1")
        name = tokens[0].lower()
        if name in BLOCKED_COMMANDS:
            raise HTTPException(status_code=403, detail=f"{tokens[0].upper()} is disabled in the dashboard. "
                                                        f"{BLOCKED_COMMANDS[name]}")
        if name in WRITE_COMMANDS and not is_authenticated(request, authorization):
            raise HTTPException(status_code=401, detail="Sign in to run commands that change data.")
        t0 = time.perf_counter()
        timeout = 60.0 if name == "save" else None
        reply = (await db(request).pipeline_raw([tuple(tokens)], timeout=timeout))[0]
        return {"tokens": tokens, "reply": reply_to_json(reply), "wire": escape_wire(encode(tuple(tokens))),
                "duration_ms": round((time.perf_counter() - t0) * 1000, 2), "write": name in WRITE_COMMANDS}

    @app.post("/api/snapshot", dependencies=[Depends(require_auth)])
    async def snapshot(request: Request):
        t0 = time.perf_counter()
        reply = (await db(request).pipeline_raw([("SAVE",)], timeout=60.0))[0]
        if isinstance(reply, ReplyError):
            raise reply
        return {"ok": True, "duration_ms": round((time.perf_counter() - t0) * 1000, 2)}

    @app.post("/api/sample-data", dependencies=[Depends(require_auth)])
    async def load_sample(request: Request):
        # SET ... GET returns the previous value atomically, so we can tell an
        # added key from one that was reset to its sample value. Only demo:*
        # keys are touched.
        cmds = []
        for key, value, ttl in SAMPLE_KEYS:
            cmds.append(("SET", key, value, "EX", ttl, "GET") if ttl else ("SET", key, value, "GET"))
        replies = await db(request).pipeline_raw(cmds)
        errors = [str(r) for r in replies if isinstance(r, ReplyError)]
        if errors:
            raise HTTPException(status_code=503, detail=errors[0])
        added = sum(1 for r in replies if r is None)
        unchanged = sum(1 for r, (_, v, _) in zip(replies, SAMPLE_KEYS) if r is not None and r == v.encode())
        reset = len(replies) - added - unchanged
        return {"ok": True, "loaded": len(cmds), "added": added, "reset": reset, "unchanged": unchanged,
                "prefix": "demo:"}

    @app.post("/api/demo/crash", dependencies=[Depends(require_auth)])
    async def crash(request: Request, body: CrashBody | None = None):
        """Kill the database process (DEBUG CRASH).

        Options: `slow_recovery_ms` makes the next startup stay in
        "recovering" that long (to test the UI and clients during a slow
        recovery). `concurrent_writers` starts that many clients doing durable
        SETs; the crash is sent while they write, and every acknowledged write
        is recorded so /api/demo/load/{id} can verify it survived."""
        s: Settings = request.app.state.settings
        body = body or CrashBody()
        if not s.allow_crash_demo:
            raise HTTPException(status_code=403, detail="The crash demo is disabled on this deployment.")
        client = db(request)
        reply = await client.call_raw("DEBUG", "SLEEP", "0")
        if isinstance(reply, ReplyError):
            raise HTTPException(status_code=409, detail="The database was started without --enable-debug-command.")
        load = None
        if body.concurrent_writers:
            load = WriteLoad(s, body.concurrent_writers)
            request.app.state.loads[load.id] = load
            load.start()
            await asyncio.sleep(body.load_lead_ms / 1000)  # let writers reach steady state
        args = ("DEBUG", "CRASH", "SLOW", body.slow_recovery_ms) if body.slow_recovery_ms else ("DEBUG", "CRASH")
        sent_at_ms = int(time.time() * 1000)
        await client.send_and_forget(*args)
        client.reset()
        if load:
            load.crash_sent_ms = sent_at_ms
        wl: Workload = request.app.state.workload
        if wl.running:
            wl.event("crash", "DEBUG CRASH: database process killed" + (f" (slow recovery {body.slow_recovery_ms} ms)" if body.slow_recovery_ms else ""), sent_at_ms)
        return {"ok": True, "sent_at": sent_at_ms / 1000, "sent_at_ms": sent_at_ms,
                "load_id": load.id if load else None, "writers": body.concurrent_writers}

    @app.get("/api/demo/load/{load_id}", dependencies=[Depends(require_auth)])
    async def verify_load(request: Request, load_id: str, cleanup: bool = True):
        """After restart: check every write acknowledged before the crash."""
        load: WriteLoad | None = request.app.state.loads.get(load_id)
        if not load:
            raise HTTPException(status_code=404, detail="Unknown or expired load id.")
        await load.wait_stopped()
        result = await load.verify(db(request), cleanup=cleanup)
        request.app.state.loads.pop(load_id, None)
        return result


class WorkloadBody(BaseModel):
    rps: int = Field(default=60, ge=5, le=500)
    duration_s: int = Field(default=300, ge=10, le=1800)
    dataset_prefix: str | None = Field(default=None, max_length=200)
    # None = pick the most recent imported orders dataset automatically; "" = no order lookups
    orders_prefix: str | None = Field(default=None, max_length=200)


class ImportPlanBody(BaseModel):
    file: str
    id_column: str = Field(min_length=1)
    prefix: str = Field(default="", max_length=200)


class ImportStartBody(ImportPlanBody):
    ttl_seconds: int | None = Field(default=None, ge=1, le=10 * 365 * 24 * 3600)
    on_existing: str = Field(default="skip", pattern="^(skip|overwrite)$")
    max_records: int | None = Field(default=None, ge=1)


class FingerprintBody(BaseModel):
    prefixes: list[str]
    exclude_expiring_within_ms: int = Field(default=120_000, ge=0)
    # absolute cutoff (ms): reuse the value returned by the "before" fingerprint so
    # the "after" fingerprint excludes exactly the same keys.
    cutoff_ms: int | None = None


def uuid_hex() -> str:
    import secrets as _s
    return _s.token_hex(6)


def _insights(records: list[dict], category: str | None, date: str | None) -> dict:
    """Pick a categorical and a date field (or use the requested ones) and aggregate."""
    from collections import Counter
    from datetime import datetime as _dt
    sample = records[:500]
    cols: list[str] = []
    for r in sample:
        for k in r:
            if k not in cols:
                cols.append(k)

    def parse_date(v):
        if not isinstance(v, str) or len(v) < 7:
            return None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m"):
            try:
                return _dt.strptime(v[:len(_dt(2000, 1, 1).strftime(fmt))] if fmt != "%Y-%m-%dT%H:%M:%SZ" else v, fmt)
            except ValueError:
                continue
        return None

    categorical, dates, numeric = [], [], []
    for c in cols:
        vals = [r.get(c) for r in sample if r.get(c) not in (None, "")]
        if not vals:
            continue
        if sum(1 for v in vals if parse_date(v)) >= 0.9 * len(vals):
            dates.append(c)
            continue
        nums = 0
        for v in vals:
            try:
                float(v)
                nums += 1
            except (TypeError, ValueError):
                pass
        distinct = len({str(v) for v in vals})
        if nums >= 0.9 * len(vals) and distinct > 12:
            numeric.append(c)
        elif 1 < distinct <= max(60, len(vals) // 8) and all(isinstance(v, (str, int, bool)) for v in vals):
            categorical.append(c)
    cat = category if category in cols else (categorical[0] if categorical else None)
    dt = date if date in cols else (dates[0] if dates else None)
    num = next((c for c in numeric if "price" in c.lower() or "value" in c.lower()), numeric[0] if numeric else None)
    top = []
    if cat:
        cnt = Counter(str(r.get(cat)) for r in records if r.get(cat) not in (None, ""))
        sums: dict[str, float] = {}
        if num:
            for r in records:
                try:
                    sums[str(r.get(cat))] = sums.get(str(r.get(cat)), 0.0) + float(r.get(num))
                except (TypeError, ValueError):
                    pass
        top = [{"value": v, "count": n, **({"avg": round(sums.get(v, 0) / n, 2)} if num else {})} for v, n in cnt.most_common(12)]
    per_month = []
    if dt:
        months = Counter()
        for r in records:
            d = parse_date(r.get(dt))
            if d:
                months[_dt(d.year, d.month, 1)] += 1
        per_month = [{"t": int(m.timestamp() * 1000), "count": n} for m, n in sorted(months.items())]
    return {"fields": {"categorical": categorical, "date": dates, "numeric": numeric}, "category_field": cat,
            "date_field": dt, "numeric_field": num, "top_categories": top, "per_month": per_month}


class ReportBody(BaseModel):
    kind: str = Field(pattern=r"^[a-z_]{3,32}$")
    report: dict


class CrashBody(BaseModel):
    slow_recovery_ms: int = Field(default=0, ge=0, le=30000)
    concurrent_writers: int = Field(default=0, ge=0, le=64)
    load_lead_ms: int = Field(default=700, ge=0, le=10000)


class WriteLoad:
    """Durable write traffic that is running when the crash happens."""

    def __init__(self, s: Settings, writers: int) -> None:
        import secrets as _secrets
        self.id = _secrets.token_hex(6)
        self.s = s
        self.writers = writers
        self.acked: dict[str, str] = {}
        self.failed_attempts = 0
        self.started_ms = int(time.time() * 1000)
        self.crash_sent_ms: int | None = None
        self.last_ack_ms: int | None = None
        self.tasks: list[asyncio.Task] = []

    def start(self) -> None:
        self.tasks = [asyncio.create_task(self._writer(i)) for i in range(self.writers)]

    async def _writer(self, n: int) -> None:
        c = RespClient(self.s.db_host, self.s.db_port, self.s.db_password, pool_size=1, timeout=2.0, connect_timeout=0.5)
        i = 0
        deadline = time.monotonic() + 15
        try:
            while time.monotonic() < deadline:
                key, val = f"lab:load:{self.id}:{n}:{i}", f"{n}-{i}"
                try:
                    r = await c.call_raw("SET", key, val)
                except Unreachable:
                    self.failed_attempts += 1
                    return  # the server died under us: this write was never acknowledged
                if r == "OK":
                    self.acked[key] = val
                    self.last_ack_ms = int(time.time() * 1000)
                else:
                    self.failed_attempts += 1
                i += 1
        finally:
            c.reset()

    async def wait_stopped(self) -> None:
        await asyncio.gather(*self.tasks, return_exceptions=True)

    async def verify(self, client: RespClient, cleanup: bool) -> dict:
        keys = list(self.acked)
        lost: list[str] = []
        for i in range(0, len(keys), 500):
            chunk = keys[i:i + 500]
            got = await client.pipeline_raw([("GET", k) for k in chunk])
            lost += [k for k, g in zip(chunk, got) if not isinstance(g, bytes) or g.decode() != self.acked[k]]
        extra = 0
        if cleanup:
            # Remove every key of this run, including writes that reached the log
            # but whose OK never arrived (allowed: only acknowledged writes are promised).
            cursor, prefix = 0, f"lab:load:{self.id}:*"
            while True:
                nxt, batch = await client.call("SCAN", cursor, "MATCH", prefix, "COUNT", 1000)
                if batch:
                    extra += sum(1 for k in batch if k.decode() not in self.acked)
                    await client.call("DEL", *batch)
                cursor = int(nxt)
                if cursor == 0:
                    break
                cursor = 0  # deleting shifts the offset-based cursor; restart until empty
        dur = max(1, (self.last_ack_ms or self.started_ms) - self.started_ms)
        return {"writers": self.writers, "acked": len(keys), "recovered": len(keys) - len(lost), "lost": len(lost),
                "lost_examples": lost[:5], "unacknowledged_attempts": self.failed_attempts,
                "persisted_without_ack": extra,
                "write_rate_per_sec": round(len(keys) / dur * 1000), "cleaned_up": cleanup}


app = create_app()
