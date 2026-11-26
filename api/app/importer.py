"""Dataset import: ZIP or single file -> one key per record (JSON string value).

Flow (all steps go through the API; nothing is extracted to the live volume):

  1. upload   the browser streams the raw file; it is saved to a private temp
              dir with a hard size cap.
  2. inspect  for a ZIP, list the members with detected format, flag
              unsupported ones and enforce limits (total uncompressed size,
              suspicious compression ratio, member count).
  3. preview  first records of one member, its columns and a suggested ID column.
  4. plan     the keys the first records would become, and whether they exist.
  5. import   a background job streams records in bounded batches (500) and
              pipelines `SET key json NX [EX ttl]` (skip existing, default) or
              `SET key json [EX ttl] GET` (overwrite), reporting added /
              skipped / updated / failed with row numbers.

Formats: CSV, TSV, JSON arrays, JSON Lines / NDJSON — line-delimited JSON is
detected by content even when the file ends in .json (as in the Yelp dataset).
Excel and Parquet are listed as unsupported for now.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import secrets
import shutil
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from typing import Iterator

from .resp_client import ReplyError, RespClient, Unreachable

csv.field_size_limit(16 * 1024 * 1024)


@dataclass
class Limits:
    max_upload_bytes: int = int(os.environ.get("IMPORT_MAX_UPLOAD_MB", "200")) * 1024 * 1024
    max_uncompressed_bytes: int = int(os.environ.get("IMPORT_MAX_UNCOMPRESSED_MB", "1024")) * 1024 * 1024
    max_ratio: int = 200            # uncompressed / compressed, per member (zip-bomb guard)
    max_members: int = 5000
    max_records: int = int(os.environ.get("IMPORT_MAX_RECORDS", "500000"))
    max_value_bytes: int = 1024 * 1024
    max_json_array_bytes: int = 100 * 1024 * 1024  # JSON arrays are parsed whole; larger -> use JSONL
    batch: int = 500


LIMITS = Limits()
UNSUPPORTED = {
    ".xlsx": "Excel is not supported yet — export the sheet as CSV",
    ".xls": "Excel is not supported yet — export the sheet as CSV",
    ".parquet": "Parquet is not supported yet — convert to CSV or JSONL",
    ".gz": "nested archives are not supported — extract first",
    ".zip": "nested archives are not supported — extract first",
}


class ImportError_(Exception):
    """User-facing import problem (bad file, over a limit...)."""


# ============================================================================ uploads

@dataclass
class Upload:
    id: str
    dir: str
    name: str
    size: int
    is_zip: bool
    created: float = field(default_factory=time.time)

    @property
    def path(self) -> str:
        return os.path.join(self.dir, "upload.bin")


class UploadStore:
    TTL_S = 3600

    def __init__(self) -> None:
        self.root = tempfile.mkdtemp(prefix="miniredis-imports-")
        self.uploads: dict[str, Upload] = {}

    async def save(self, filename: str, chunks) -> Upload:
        self.sweep()
        uid = secrets.token_hex(8)
        d = os.path.join(self.root, uid)
        os.makedirs(d)
        size = 0
        path = os.path.join(d, "upload.bin")
        try:
            with open(path, "wb") as f:
                async for chunk in chunks:
                    size += len(chunk)
                    if size > LIMITS.max_upload_bytes:
                        raise ImportError_(f"Upload is larger than the {LIMITS.max_upload_bytes // (1024 * 1024)} MB limit.")
                    f.write(chunk)
        except BaseException:
            shutil.rmtree(d, ignore_errors=True)
            raise
        if size == 0:
            shutil.rmtree(d, ignore_errors=True)
            raise ImportError_("The uploaded file is empty.")
        up = Upload(uid, d, os.path.basename(filename or "upload"), size, zipfile.is_zipfile(path))
        self.uploads[uid] = up
        return up

    def get(self, uid: str) -> Upload:
        up = self.uploads.get(uid)
        if not up:
            raise ImportError_("This upload has expired. Upload the file again.")
        return up

    def drop(self, uid: str) -> None:
        up = self.uploads.pop(uid, None)
        if up:
            shutil.rmtree(up.dir, ignore_errors=True)

    def sweep(self) -> None:
        now = time.time()
        for uid in [u.id for u in self.uploads.values() if now - u.created > self.TTL_S]:
            self.drop(uid)


# ============================================================================ format detection

def _ext(name: str) -> str:
    return os.path.splitext(name.lower())[1]


def sniff(name: str, head: bytes) -> tuple[str | None, str | None]:
    """Return (format, reason_if_unsupported)."""
    ext = _ext(name)
    if ext in UNSUPPORTED:
        return None, UNSUPPORTED[ext]
    text = head.decode("utf-8-sig", "replace").lstrip()
    if ext in (".csv", ".tsv", ".tab", ".txt"):
        if ext in (".tsv", ".tab"):
            return "tsv", None
        first = text.splitlines()[0] if text else ""
        if first.count("\t") > first.count(","):
            return "tsv", None
        if ext == ".txt" and "," not in first:
            return None, "plain text without a CSV header"
        return "csv", None
    if ext in (".json", ".jsonl", ".ndjson") or text[:1] in ("[", "{"):
        if text.startswith("["):
            return "json_array", None
        if text.startswith("{"):
            lines = [ln for ln in text.splitlines() if ln.strip()][:3]
            ok = 0
            for ln in lines:
                try:
                    if isinstance(json.loads(ln), dict):
                        ok += 1
                except json.JSONDecodeError:
                    break
            if ok >= 1:  # the first line is a complete JSON object -> line-delimited (Yelp-style .json too)
                return "jsonl", None
            if ext in (".jsonl", ".ndjson"):
                return None, "lines are not JSON objects"
            return None, "a single JSON object, not a list of records"
        return None, "not a JSON list or JSON Lines file"
    return None, f"unsupported file type ({ext or 'no extension'})"


def _skip_member(name: str) -> bool:
    base = os.path.basename(name)
    return name.endswith("/") or name.startswith("__MACOSX/") or base.startswith("._") or base in (".DS_Store", "Thumbs.db")


def inspect(up: Upload) -> list[dict]:
    files = []
    if up.is_zip:
        with zipfile.ZipFile(up.path) as zf:
            infos = [i for i in zf.infolist() if not _skip_member(i.filename)]
            if len(infos) > LIMITS.max_members:
                raise ImportError_(f"The ZIP has {len(infos)} files; the limit is {LIMITS.max_members}.")
            total = sum(i.file_size for i in infos)
            if total > LIMITS.max_uncompressed_bytes:
                raise ImportError_(f"The ZIP expands to {total / 1e9:.2f} GB; the limit is {LIMITS.max_uncompressed_bytes / 1e9:.2f} GB.")
            for i in infos:
                entry = {"name": i.filename, "size": i.file_size, "compressed": i.compress_size}
                if i.flag_bits & 0x1:
                    entry.update(format=None, supported=False, reason="encrypted")
                elif i.compress_size and i.file_size / max(1, i.compress_size) > LIMITS.max_ratio and i.file_size > 10 * 1024 * 1024:
                    entry.update(format=None, supported=False, reason="suspicious compression ratio (possible zip bomb)")
                else:
                    with zf.open(i) as f:
                        head = f.read(65536)
                    fmt, reason = sniff(i.filename, head)
                    if fmt == "json_array" and i.file_size > LIMITS.max_json_array_bytes:
                        fmt, reason = None, "JSON array over 100 MB — convert it to JSON Lines"
                    entry.update(format=fmt, supported=fmt is not None, reason=reason)
                files.append(entry)
    else:
        with open(up.path, "rb") as f:
            head = f.read(65536)
        fmt, reason = sniff(up.name, head)
        if fmt == "json_array" and up.size > LIMITS.max_json_array_bytes:
            fmt, reason = None, "JSON array over 100 MB — convert it to JSON Lines"
        files.append({"name": up.name, "size": up.size, "compressed": up.size, "format": fmt, "supported": fmt is not None, "reason": reason})
    files.sort(key=lambda e: (not e["supported"], e["name"]))
    return files


# ============================================================================ reading records

def _open_binary(up: Upload, member: str):
    if up.is_zip:
        zf = zipfile.ZipFile(up.path)
        try:
            return zf, zf.open(member)
        except KeyError:
            zf.close()
            raise ImportError_(f"{member} is not in the ZIP.") from None
    if member != up.name:
        raise ImportError_(f"{member} is not part of this upload.")
    return None, open(up.path, "rb")


def iter_records(up: Upload, member: str, fmt: str) -> Iterator[tuple[int, dict | None, str | None]]:
    """Yield (row_number, record, error). Row numbers are 1-based data rows."""
    zf, raw = _open_binary(up, member)
    try:
        if fmt in ("csv", "tsv"):
            text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
            reader = csv.DictReader(text, delimiter="\t" if fmt == "tsv" else ",")
            if not reader.fieldnames:
                raise ImportError_("The file has no header row.")
            for n, row in enumerate(reader, 1):
                if None in row:  # more cells than headers
                    extra = row.pop(None)
                    yield n, None, f"row {n}: {len(extra)} more values than header columns"
                    continue
                yield n, {k: v for k, v in row.items()}, None
        elif fmt == "jsonl":
            text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace")
            n = 0
            for line in text:
                if not line.strip():
                    continue
                n += 1
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as e:
                    yield n, None, f"row {n}: invalid JSON ({e.msg})"
                    continue
                if not isinstance(obj, dict):
                    yield n, None, f"row {n}: not a JSON object"
                    continue
                yield n, obj, None
        elif fmt == "json_array":
            data = json.loads(raw.read().decode("utf-8-sig", "replace"))
            if not isinstance(data, list):
                raise ImportError_("The JSON file is not a list of records.")
            for n, obj in enumerate(data, 1):
                if isinstance(obj, dict):
                    yield n, obj, None
                else:
                    yield n, None, f"row {n}: not a JSON object"
        else:
            raise ImportError_(f"Unsupported format {fmt}.")
    finally:
        raw.close()
        if zf:
            zf.close()


def member_format(up: Upload, member: str) -> str:
    for f in inspect(up):
        if f["name"] == member:
            if not f["supported"]:
                raise ImportError_(f"{member}: {f['reason']}")
            return f["format"]
    raise ImportError_(f"{member} is not part of this upload.")


def preview(up: Upload, member: str, n: int = 8) -> dict:
    fmt = member_format(up, member)
    columns: list[str] = []
    sample: list[dict] = []
    errors: list[str] = []
    seen: dict[str, set] = {}
    count = 0
    for i, (row, rec, err) in enumerate(iter_records(up, member, fmt)):
        if i >= 300:
            break
        count += 1
        if err:
            errors.append(err)
            continue
        for k in rec:
            if k not in columns:
                columns.append(k)
            seen.setdefault(k, set()).add(json.dumps(rec[k], sort_keys=True) if isinstance(rec[k], (dict, list)) else str(rec[k]))
        if len(sample) < n:
            sample.append(rec)
    good = count - len(errors)

    def unique(c: str) -> bool:
        return len(seen.get(c, ())) == good and good > 0

    suggested = next((c for c in columns if c.lower() == "id" and unique(c)), None) \
        or next((c for c in columns if c.lower().endswith("_id") and unique(c)), None) \
        or next((c for c in columns if unique(c)), None)
    return {"file": member, "format": fmt, "columns": columns, "records": sample, "sampled": count,
            "sample_errors": errors[:5], "suggested_id": suggested,
            "unique_in_sample": [c for c in columns if unique(c)]}


def _key_for(prefix: str, rec: dict, id_column: str) -> tuple[str | None, str | None]:
    v = rec.get(id_column)
    if v is None or (isinstance(v, str) and not v.strip()):
        return None, f"empty {id_column}"
    if isinstance(v, (dict, list)):
        return None, f"{id_column} is not a scalar"
    key = f"{prefix}{v}".strip()
    if len(key.encode()) > 512:
        return None, "key longer than 512 bytes"
    return key, None


def encode_value(rec: dict) -> bytes:
    return json.dumps(rec, ensure_ascii=False, separators=(",", ":")).encode()


async def plan(client: RespClient, up: Upload, member: str, id_column: str, prefix: str, n: int = 10) -> dict:
    fmt = member_format(up, member)
    rows = []
    for row, rec, err in iter_records(up, member, fmt):
        if len(rows) >= n:
            break
        if err:
            rows.append({"row": row, "key": None, "error": err})
            continue
        key, kerr = _key_for(prefix, rec, id_column)
        rows.append({"row": row, "key": key, "error": kerr, "bytes": len(encode_value(rec)),
                     "value_preview": encode_value(rec)[:160].decode("utf-8", "replace")})
    keys = [r["key"] for r in rows if r["key"]]
    exists = await client.pipeline_raw([("EXISTS", k) for k in keys]) if keys else []
    ex = dict(zip(keys, exists))
    for r in rows:
        r["exists"] = bool(ex.get(r["key"])) if r["key"] else False
    # does the prefix already hold keys?
    existing_under_prefix = await client.call("KEYCOUNT", f"{_glob_escape(prefix)}*")
    return {"rows": rows, "existing_under_prefix": existing_under_prefix}


def _glob_escape(s: str) -> str:
    """Escape glob metacharacters with brackets (the server's matcher has no backslash escapes)."""
    return "".join(f"[{ch}]" if ch in "*?[" else ch for ch in s)


# ============================================================================ import job

@dataclass
class ImportJob:
    id: str
    upload_name: str
    file: str
    fmt: str
    id_column: str
    prefix: str
    ttl_seconds: int | None
    on_existing: str
    max_records: int
    state: str = "running"  # running | done | cancelled | failed
    processed: int = 0
    added: int = 0
    skipped: int = 0
    updated: int = 0
    failed: int = 0
    failures: list[str] = field(default_factory=list)
    error: str | None = None
    note: str | None = None
    started_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    finished_ms: int | None = None
    columns: list[str] = field(default_factory=list)
    _cancel: bool = False

    def to_dict(self) -> dict:
        el = ((self.finished_ms or int(time.time() * 1000)) - self.started_ms) / 1000
        d = {k: v for k, v in self.__dict__.items() if not k.startswith("_")}
        d["elapsed_s"] = round(el, 2)
        d["records_per_sec"] = round(self.processed / el) if el > 0 else 0
        return d


async def run_job(job: ImportJob, up: Upload, client: RespClient, on_done) -> None:
    it = iter_records(up, job.file, job.fmt)
    loop = asyncio.get_running_loop()

    def next_batch() -> list:
        out = []
        for item in it:
            out.append(item)
            if len(out) >= LIMITS.batch:
                break
        return out

    def fail(msg: str) -> None:
        job.failed += 1
        if len(job.failures) < 25:
            job.failures.append(msg)

    try:
        while not job._cancel:
            batch = await loop.run_in_executor(None, next_batch)  # parse off the event loop
            if not batch:
                break
            cmds, rows = [], []
            for row, rec, err in batch:
                if job.processed >= job.max_records:
                    job.note = f"imported the first {job.max_records:,} rows (row limit); the rest of the file was not read"
                    job._cancel = True
                    break
                job.processed += 1
                if err:
                    fail(err)
                    continue
                for k in rec:
                    if k not in job.columns and len(job.columns) < 200:
                        job.columns.append(k)
                key, kerr = _key_for(job.prefix, rec, job.id_column)
                if kerr:
                    fail(f"row {row}: {kerr}")
                    continue
                val = encode_value(rec)
                if len(val) > LIMITS.max_value_bytes:
                    fail(f"row {row}: value over 1 MB")
                    continue
                args: list = ["SET", key, val]
                if job.on_existing == "skip":
                    args.append("NX")
                if job.ttl_seconds:
                    args += ["EX", job.ttl_seconds]
                if job.on_existing == "overwrite":
                    args.append("GET")
                cmds.append(tuple(args))
                rows.append(row)
            if cmds:
                replies = await client.pipeline_raw(cmds, timeout=30)
                for row, r in zip(rows, replies):
                    if isinstance(r, ReplyError):
                        fail(f"row {row}: {r}")
                    elif job.on_existing == "skip":
                        if r == "OK":
                            job.added += 1
                        else:
                            job.skipped += 1
                    else:
                        if r is None:
                            job.added += 1
                        else:
                            job.updated += 1
            await asyncio.sleep(0)  # stay responsive between batches
        job.state = "cancelled" if job._cancel and not job.note else "done"
    except ImportError_ as e:
        job.state, job.error = "failed", str(e)
    except Unreachable as e:
        job.state, job.error = "failed", f"database unreachable during import ({e}); rows already acknowledged are stored"
    except Exception as e:  # pragma: no cover
        job.state, job.error = "failed", f"{e.__class__.__name__}: {e}"
    finally:
        it.close()
        client.reset()
        job.finished_ms = int(time.time() * 1000)
        try:
            on_done(job)
        except Exception:
            pass
