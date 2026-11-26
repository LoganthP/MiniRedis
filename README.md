# MiniRedis — Build Your Own Redis

A persistent, Redis-style key-value server written from scratch in Python `asyncio`, with a FastAPI bridge and a dark, developer-console style React dashboard.

- **Real database server.** It speaks RESP2 over TCP, so `redis-cli` works against it.
- **Durable.** Writes go through an append-only log with CRC32 checksums and are fsynced before the client gets `OK`. Snapshots and log rotation keep restarts fast.
- **Crash-safe recovery.** On startup it loads the snapshot and replays newer log records. An incomplete final record is ignored and reported. Corruption in the middle of the log stops the server *before* it serves any data.
- **Expirations survive restarts.** Deadlines are stored as absolute timestamps, so a restart never resets a key's lifetime.
- **Dashboard.** It has three views: **Keys** (key explorer and inspector), **Console** (redis-cli style, with optional raw RESP bytes) and **Durability** (recovery stats, a chaos lab that crashes and recovers the server, and a raw AOF tail with byte offsets and CRC32 checksums read from disk).

## The dashboard

Everything the dashboard shows comes from the running system, and every metric is labelled with its source:

- **sample app**: measured by the simulated application's own client;
- **engine**: MiniRedis `INFO`, sampled every 2 s by the API;
- **crash lab**: saved verification reports.

There are four tabs:

| Tab | What it shows |
|---|---|
| **Overview** (default) | It answers one question: *if this cache goes down, how fast does the app recover, and what survives?* Start the sample shop's traffic, click **Crash the database**, and read the outcome. It shows request success rate, p95 app latency, cache hit rate and the last verified recovery. Below that are an application-impact timeline (requests by outcome plus p95, with crash, cache-down and recovery marked), cache effectiveness per workload, capacity and expiration charts, and durability and restore history. |
| **Keys** | A cursor-paginated explorer and a key editor. The editor has one **Save**: a **Changes on save** box shows exactly what will change and which command runs, and expiration is a single **Keep / Set new / Remove** choice. Before writing, the editor re-reads the key. If the key expired or another client changed it, you choose to recreate, overwrite or load the latest, instead of silently clobbering it. "Saved" appears inline beside the button, and a failed save keeps your draft. |
| **Console** | Works like `redis-cli`. JSON replies are pretty-printed and collapsible, and a toggle shows the raw RESP bytes. |
| **Durability** | Leads with outcomes: downtime, first successful request, acknowledged writes recovered, expiry deadlines, last verified restore. Below that are the crash lab, saved runs (compare two, export CSV or Markdown) and restore verifications. Engine internals (log, snapshots, latency with sample counts, startup history, raw AOF tail) are in a collapsible section. |

**Theme.** Light by default, with a dark theme toggle in the header. Both are built from the same tokens in `web/src/index.css`: a single crimson accent, and emerald, amber and rose reserved for status. Numbers use tabular monospace digits so they don't jitter while updating.

**Status.** One readiness state drives the header, every write control and the crash lab: Offline, Recovering, Ready, Degraded, and *stale* when checks are paused or failing. Writes re-enable automatically after a fresh ready check.

**Empty metrics.** Latency percentiles show "no samples yet" instead of `0.00 ms`, and display their sample count. Values from fewer than 100 samples are marked *prelim.*

## The sample application (Overview)

The API can run a simulated e-commerce app that uses MiniRedis as its cache, so the crash lab can show what an application's users experience. It talks to MiniRedis over RESP with short timeouts, like a production client.

| Request | Share | How it uses the cache | When the cache is down |
|---|---|---|---|
| Product page | 70% | cache-aside, `EX 300`; simulated backend 22–40 ms | falls back to the backend: slower, still succeeds |
| Stock check | 20% | cache-aside, `EX 10`; backend 10–20 ms | falls back to the backend |
| Add to cart | 10% | stored in the cache (durable `SET … EX 1800`) | **fails**: there is nothing to fall back to |

The backend latency is simulated, so savings are illustrative, not a cost estimate. The workload writes `shop:*` keys. It is enabled by `ALLOW_DEMO_WORKLOAD` (on in the demo profile, off in the private one).

**Traffic on your own data.** When you have imported data, the Overview preselects your newest persistent product dataset (a TTL group is usually a short-lived subset) and your newest orders dataset. You can change both before you start. With a dataset selected, every request type uses it:

| Request | Share | Data it uses | Tag on the Overview |
|---|---|---|---|
| Product page | 60% | `GET <your product key>`, read-only | your data |
| Order lookup | 15% | `GET <your order key>`, read-only (only with an orders dataset) | your data |
| Stock check | 15% | cache-aside `shop:stock:<your product id>`, `EX 10`. Stock levels aren't in the dataset, so they are simulated | your ids |
| Add to cart | 10% | `SET shop:cart:<session>` containing your product ids | your ids |

Without an orders dataset the split is 70 / 20 / 10. A missing or expired imported key is a real miss, served by the simulated backend. Dataset reads never write back, so the traffic never changes imported data. The **Hit rate on your data** card counts only lookups on imported keys. Its hint also shows the all-requests rate, so the two are never mixed. Each crash report records which data the traffic used.

**Crash options.** Both are available in the crash lab and on the Overview:

- **Concurrent durable writes.** 8 extra clients do `SET`s while the crash hits. Every acknowledged key is recorded and checked after restart, then cleaned up. Some writes can reach the disk without their OK arriving before the crash; these are reported separately and allowed.
- **Simulate a slow recovery.** `DEBUG CRASH SLOW <ms>` keeps the next startup in `recovering` for that long (debug builds only). A real restart here takes about 0.1 s, which is often shorter than the app's own retry, so the impact is invisible.

In one recorded run with a 3 s simulated recovery at 60 req/s:

- 300 requests arrived in the outage window.
- 172 were served by the backend fallback.
- 11 carts failed.
- p95 latency went from 8 ms to 40 ms.
- All 2,357 concurrently acknowledged writes were recovered.

**Saved reports.** Every crash run is saved on the server in `REPORTS_DIR` (a Docker volume), including environment, dataset size, durability mode, phases, checks and app impact. You can compare two runs side by side or export them as Markdown or CSV.

## Import a dataset (Keys → Import dataset)

The Key explorer has an **Import dataset** button. It turns each row of a file into one key, with the row stored as a compact JSON string.

1. **Upload** a ZIP or a single file: CSV, TSV, a JSON array, or JSON Lines / NDJSON. A `.json` file with one object per line (the Yelp layout) is detected as JSON Lines. Excel, Parquet and nested archives are listed with the reason they can't be imported. The button **Synthetic shop ZIP (CC0)** downloads a generated catalog in the Olist layout (`products.csv`, `orders.jsonl`, `reviews.json`, `categories.json`).
2. **Pick one file** inside the ZIP. The drawer shows its first 8 records, suggests an ID column (`id`, then a unique `*_id`, then any column unique in the sample), and lets you set the key prefix. Before anything is written it previews the first 10 resulting keys, marks the ones that already exist, and counts the keys already under the prefix.
3. **Import.** Defaults are **Skip existing** (`SET … NX`) and **No expiration**. You can switch to Overwrite, add a TTL, or import only the first N rows to make a smaller test group. Rows are parsed off the event loop and written in pipelined batches of 500 durable `SET`s. The report lists processed, added, skipped or overwritten, and failed rows, with the first 25 failure reasons.

**Limits** (environment variables on the API): 200 MB upload (`IMPORT_MAX_UPLOAD_MB`), 1 GB unpacked (`IMPORT_MAX_UNCOMPRESSED_MB`), 500,000 rows per import (`IMPORT_MAX_RECORDS`), 5,000 files per ZIP, 1 MB per value, and 100 MB for a JSON array (it is parsed whole; use JSON Lines for anything bigger). Members with a compression ratio above 200:1 and encrypted members are refused. Uploads are deleted after an hour.

**What uses imported data.**

- **Key explorer:** chips under the search box filter by each imported prefix and show its live key count; a clock marks TTL groups.
- **Overview → Imported data:** top values of a category field (with the average of a price-like field) and records per month, computed from the stored JSON values.
- **Overview → sample traffic:** all four request types run on your data (see *Traffic on your own data* above).
- **Crash lab:** before the crash it fingerprints every imported prefix (key count plus SHA-256 over key, value and absolute deadline). After the restart it compares them. Keys due to expire within two minutes are excluded from both sides with the same cutoff, so a TTL group can be checked too.

**Licensing.** Check the licence before you put third-party data into a demo you hand to someone. The Olist Brazilian e-commerce dataset on Kaggle is CC BY-NC-SA 4.0. That is fine for noncommercial testing, but not for a commercial client demo. For client demos, use the synthetic ZIP (CC0, generated by `python -m app.synthetic out.zip --products 10000 --orders 20000`) or data you have a commercial licence for. No third-party data is bundled in this repository.

### First run (recorded)

This run used the synthetic Olist-layout ZIP, not the Kaggle download, because the build machine has no Kaggle access. It used the same column names and the same steps, at 60 req/s with 8 concurrent durable writers and a 3 s simulated slow recovery.

| Step | Result |
|---|---|
| Import `products.csv`, first 1,000 rows → `sample:olist:product:` (persistent) | 1,000 added, 0 failed |
| Import first 200 rows → `sample:olist:hot:` with TTL 300 s | 200 added, all with deadlines |
| Import `orders.jsonl` → `sample:olist:order:` | 20,000 added |
| Crash under replay traffic (1,000-product catalog) | 3.12 s downtime · 2,843/2,843 acked writes recovered · product 1,000/1,000, hot 200/200, orders 20,000/20,000: identical hashes |
| App during that outage | 298 requests: 96 from cache, 159 via backend fallback, 27 carts failed; p95 7.3 → 89.5 ms |
| Re-import all 10,000 products (Skip existing) | 9,000 added, 1,000 skipped |
| Crash again (10,000-product catalog) | 3.14 s downtime · 2,844/2,844 acked writes · product 10,000/10,000, hot 200/200, orders 20,000/20,000: identical hashes |
| App during that outage | 298 requests: 98 from cache, 168 via backend fallback, 18 carts failed; p95 7.8 → 138 ms |

With the full catalog loaded, replay traffic had a 100% product-page hit rate outside the outage: every requested product existed. Hit rate drops below 100% only when keys are missing, for example after the TTL group expires.

A later run had all four request types on the data: 10,000 products plus 20,000 orders at 60 req/s. The crash gave 3.14 s downtime with 2,550 of 2,550 acknowledged writes recovered and all dataset hashes identical. 295 requests arrived in the outage window: 169 were served by the backend fallback and 17 carts failed. Lookups on imported keys had 0 misses outside the outage (product pages, order lookups). Stock checks on real product ids had an 84% hit rate because of their 10 s TTL.

## Project layout

| Path | What it is |
|---|---|
| `server/miniredis/` | The database: `resp.py` (protocol), `store.py` (keyspace + undo), `persistence.py` (log, snapshot, recovery), `db.py` (write path, group commit, status), `commands.py`, `server.py` |
| `server/tests/` | 51 tests (supervisor restart/orphan/back-off, backup verification, shutdown during a snapshot), including crashes at three points inside a snapshot and a SIGKILL during 8-way concurrent writes that checks every acknowledged write. Also covers: protocol, commands, expiry, concurrency, `kill -9`, torn tail, mid-log corruption, corrupt snapshot, disk-full rollback, real `redis-cli` |
| `api/app/` | FastAPI dashboard API. It uses its own RESP client, so it has no back door into the database |
| `api/tests/` | 18 integration tests (incl. the sample app seeing a crash, reports surviving an API restart, restore records) against a real database process, including the crash demo |
| `web/` | React 19 + Vite + TypeScript + Tailwind v4 + Motion dashboard |
| `scripts/` | `bench_scenario.py` (durable writes + snapshot + crash, N trials), `deploy.sh`, `smoke-test.sh`, `verify-backup.sh`, `run-db.sh` (supervised), `run-api.sh`, `bench_restart.py`, `bench_load.py` (throughput, p50/p95/p99, RSS, restart downtime, crash under load), `bench_recovery.py`, `backup.sh`, `restore.sh` |
| `docker-compose.yml`, `deploy/` | db + api + web (+ optional Caddy HTTPS), `private.env` / `demo.env` profiles |

## Run it locally (no Docker)

You need Python 3.11+, Node 20+ and, optionally, `redis-cli`.

```bash
# 1. Install dependencies (one time)
pip install -r api/requirements-dev.txt -r server/requirements-dev.txt
cd web && npm install && cd ..

# 2. Terminal 1: database on :6380 (auto-restarts after a crash, Ctrl+C stops)
scripts/run-db.sh

# 3. Terminal 2: API on :8000 (dashboard password defaults to "admin")
DASHBOARD_PASSWORD=admin scripts/run-api.sh

# 4. Terminal 3: dashboard on http://localhost:5173
cd web && npm run dev
```

Open http://localhost:5173 (dev server; the Docker build serves on 8081), sign in with `admin`, then click **Sample data**.

To use redis-cli against the same database:

```bash
redis-cli -p 6380 SET greeting "hello" EX 120
redis-cli -p 6380 TTL greeting
redis-cli -p 6380 --scan --pattern 'demo:*'
```

If you don't have redis-cli, use `cd server && python -m miniredis.cli SET greeting hello`.

## Deploy (Docker Compose on a Linux VPS or your PC)

```bash
scripts/deploy.sh --profile private          # real data (default)
# or
scripts/deploy.sh --profile demo             # disposable demo with sample data + chaos lab
scripts/smoke-test.sh                        # replace the db container, verify data + deadline survive
```

What `deploy.sh` does:

1. Checks that Docker and Compose v2 are installed.
2. Creates `.env` from `deploy/<profile>.env`, generating random `DASHBOARD_PASSWORD`, `SESSION_SECRET` and `DB_PASSWORD`.
3. Runs `docker compose up -d --build`.
4. Waits for the database to report `ready` and for the dashboard to answer.
5. Prints the URL.

The dashboard runs on **http://localhost:8081** by default (`WEB_PORT`).

| Profile | Use for | Settings |
|---|---|---|
| `private` | your own data | `PUBLIC_READS=false`, `ALLOW_CRASH_DEMO=false`, database password set, web port bound to `127.0.0.1` (put HTTPS in front, or set `WEB_BIND=0.0.0.0`) |
| `demo` | a disposable portfolio instance | `PUBLIC_READS=true`, crash lab on, web port exposed |

**HTTPS.** Point DNS at the server, set `DOMAIN=miniredis.example.com` in `.env`, then run `scripts/deploy.sh --https`. That adds Caddy with automatic Let's Encrypt certificates on ports 80/443.

**How the stack is wired:**

- **db** runs `python -m miniredis.supervise`, which restarts a crashed server in about 1 ms. Its health check passes only when recovery has finished. The database port is never published.
- **api** reaches the database on the private compose network.
- **web** is nginx serving the built dashboard and proxying `/api`.
- Data lives in the `redis-data` volume.
- `docker compose stop` drains writes and writes a final snapshot.
- Copy-to-clipboard commands in the dashboard use `docker compose exec db python -m miniredis.cli …` (`CLI_PREFIX`), because the database isn't reachable from your machine.

**Backups:**

```bash
scripts/backup.sh                                   # SAVE + archive the volume to backups/
scripts/verify-backup.sh backups/<file>.tar.gz      # restore into a FRESH temp dir, run recovery, compare with live
scripts/restore.sh backups/<file>.tar.gz            # replace the volume (asks for confirmation)
```

`verify-backup` never touches the live volume, and it records its result so the dashboard can show the last verified restore. It reports recovered key count, keys with TTL, replayed records and torn tail. It then samples 200 keys and compares each value and absolute expiry deadline with the running database. Add `--strict` to fail on any difference.

**CI.** `.github/workflows/ci.yml` runs both test suites and the web build, then builds the three images, starts the stack and runs `scripts/smoke-test.sh`.

## Supported commands

| Group | Commands |
|---|---|
| The seven core commands | `PING` `SET` `GET` `DEL` `EXISTS` `EXPIRE` `TTL` |
| Option and variant commands | `SET … NX/XX/EX/PX/EXAT/PXAT/KEEPTTL/GET`, `EXPIRE … NX/XX/GT/LT`, `PEXPIRE`, `EXPIREAT`, `PEXPIREAT`, `PTTL`, `EXPIRETIME`, `PEXPIRETIME`, `PERSIST`, `MGET`, `STRLEN`, `TYPE`, `UNLINK` |
| Commands the dashboard needs | `SCAN` (sorted pages), `KEYS`, `DBSIZE`, `INFO`, `SAVE`, `BGSAVE`, `LASTSAVE`, `FLUSHDB` |
| Operations commands | `AUTH`, `SELECT 0`, `ECHO`, `TIME`, `CONFIG GET`, `COMMAND`, `QUIT`, `SHUTDOWN [NOSAVE\|SAVE]`, `DEBUG CRASH` / `DEBUG SLEEP` (only when started with `--enable-debug-command`) |
| Custom commands | `RECOVERY LAST\|HISTORY` returns JSON describing what happened at startup. `AOF TAIL [n]` returns the newest log records with byte offsets and CRC32 checksums |

Values are binary-safe strings. There is one database (db 0).

## Access control

| Setting | Effect |
|---|---|
| `DASHBOARD_PASSWORD` | Required to write. Covers creating, editing and deleting keys, `SAVE`, sample data and the crash lab. If empty, everything is open (local development only). |
| `PUBLIC_READS=false` (default) | Key names, values, console output and the raw log tail also require sign-in. Health, status and aggregate counts stay public. The log records replayed at startup are redacted for anonymous viewers. |
| `PUBLIC_READS=true` | Use only for a public portfolio demo that holds sample data. |
| `ALLOW_CRASH_DEMO=false` | Disables the crash lab. Keep it on only for a disposable demo instance. |
| `ALLOW_DEMO_WORKLOAD=false` | Disables the simulated e-commerce traffic, which writes `shop:*` keys. It is off in the private profile. |

The database port is never published by Docker Compose.

## Durability model

| `--appendfsync` | A client gets `OK` when… | What a crash can lose |
|---|---|---|
| `always` (default) | the log record is written **and fsynced** | nothing that was acknowledged |
| `everysec` | the record is written to the OS | up to about 1 second of writes if the machine loses power |
| `no` | the record is written to the OS | whatever the OS hadn't flushed yet |

- **Group commit.** Concurrent writers share one fsync, so many clients get much higher throughput than one client writing sequentially.
- **Disk errors.** If a log write fails (for example, a full disk), every unacknowledged change is rolled back in memory and the clients get `-MISCONF`. The server then turns **Degraded** (read-only) and the dashboard shows the reason.
- **Visibility.** Another client can read a value during the few milliseconds before its fsync finishes, the same as with Redis `appendfsync always`.

### Snapshots

The server snapshots every `--snapshot-every-ops` (10,000) operations, every `--snapshot-every-seconds` (300) seconds, and on `SAVE` or shutdown. A snapshot works like this:

1. Briefly pause new writes.
2. Wait for in-flight ones to sync.
3. Copy the state and rotate to a new log segment.
4. Resume writes.
5. Write the snapshot in the background (temp file, then fsync, then atomic rename).
6. Delete the old log segments.

A crash at any of these steps still recovers correctly, because log records carry sequence numbers and recovery skips anything the snapshot already holds.

## Benchmarks

### Durability scenario (repeatable)

Command: `python scripts/bench_scenario.py --keys 10000 100000 --trials 3 --json docs/scenario-results.json`

Each trial starts a fresh server under the supervisor, loads the dataset (64-byte values, 30% with TTL) and runs 16 clients doing durable `SET`s (`appendfsync=always`) in three phases:

1. Baseline.
2. While a snapshot runs.
3. Then `DEBUG CRASH` mid-traffic.

Measured on 2 vCPUs with Python 3.13. Values are medians across 3 trials:

| | 10,000 keys | 100,000 keys |
|---|---|---|
| Write ack p95 / p99, baseline | 3.38 / 5.51 ms | 3.32 / 5.01 ms |
| Write ack p95 / p99, whole snapshot phase | 3.40 / 5.60 ms | 3.40 / 5.74 ms |
| Write ack p95 / p99, **writes issued inside the snapshot window** | 15.6 / 15.6 ms | 27.3 / 30.2 ms |
| Snapshot duration | 41 ms | 158 ms |
| Max write-queue depth / disk-sync p95 | 14 / 2.75 ms | 14 / 3.03 ms |
| Crash under load: first successful command | 291 ms | 369 ms |
| Recovery replaying the log written since the last snapshot (35–38k records) | 264 ms | 343 ms |
| Acknowledged writes lost | **0 of 38,003** | **0 of 34,873** |
| Pass rate | 3/3 | 3/3 |
| Peak RSS | 50 MB | 93 MB |

**What changed because of this benchmark.** A snapshot used to pause writes while it copied the keyspace as a list of tuples: 24 ms at 100k keys. It now uses `dict.copy()` (C-level, no tuples) and serializes the private copy in a worker thread in chunks. The pause is now **5–8 ms**: copy 3 ms, log rotation 2.5 ms. As a result, p95 for writes issued inside the snapshot window fell from 41 to 27 ms at 100k keys.

The remaining gap comes from the serializer thread competing for the interpreter lock. The next step would be a forked snapshot process, as Redis does with `BGSAVE`.

`INFO persistence` reports `last_snapshot_write_pause_ms` with its copy and rotate parts.

### Throughput, latency and restarts

These numbers come from `scripts/bench_load.py` and `scripts/bench_restart.py` (results in `docs/benchmark-results.json`). 100,000 keys, 16 clients:

| Workload | ops/s | p50 | p95 | p99 |
|---|---|---|---|---|
| GET | 38,593 | 0.38 ms | 0.67 ms | 1.04 ms |
| GET + dashboard polling | 38,247 | 0.37 ms | 0.71 ms | 1.10 ms |
| SET (fsync before every OK) | 7,347 | 2.02 ms | 3.46 ms | 5.30 ms |
| SET + dashboard polling | 7,313 | 2.00 ms | 3.41 ms | 5.54 ms |
| 80/20 mixed | 18,821 | 0.41 ms | 3.11 ms | 4.41 ms |

The dashboard's polling has no measurable effect.

Repeated crash/restart under the supervisor, 20 runs each:

| Dataset | Kill → first GET, p50 / p95 |
|---|---|
| 10k keys, recent snapshot | 26 / 32 ms |
| 10k keys, 10k-record log | 86 / 110 ms |
| 100k keys, recent snapshot | 123 / 169 ms |
| 100k keys, 100k-record log | 678 / 840 ms |

## Restart timeline (where downtime goes)

The server records, on its own clock:

- `process_started_ms`: read from `/proc`, so it covers interpreter start-up.
- `listening_ms` and `ready_ms`.
- A random `run_id` for each process.

The API records when it sent the crash, and `/api/wait-ready` long-polls the database every 10 ms. The chaos lab splits the downtime into these phases:

**supervisor restart → process start → recovery (listening → ready) → first successful command → dashboard.**

The **engine timer** shown next to it covers only snapshot load and log replay, which is a narrower window than the "recovery" phase.

These are the fixes made because of this breakdown:

| Phase | Before (Docker run in the review) | Now (nginx on :8081, supervisor) | Fix |
|---|---:|---:|---|
| Supervisor restart | 279 ms | ~0–4 ms | In-container fork supervisor instead of a container restart |
| Interpreter / process start | 611 ms | 2–11 ms | The supervisor imports once and forks warm children; bytecode is precompiled in the image |
| First successful command | 364 ms | 11–26 ms | `/api/wait-ready` probes every 10 ms (250 ms connect timeout) instead of the browser's poll interval; stale pooled connections are retried once |
| Dashboard | 17 ms | 40–55 ms | (one `INFO` round-trip through nginx) |
| **End to end** | **1.27 s** | **55–106 ms** | |

**Crash-loop back-off.** If more than 3 server processes die within 5 s of starting, inside a 30 s window, the supervisor backs off (0.2 s doubling to 5 s). A server that ran normally before crashing is always restarted immediately. Set `MINIREDIS_SUPERVISE_BACKOFF_AFTER=0` to turn off back-off.

**Orphans.** If the supervisor itself is killed, the server process receives SIGTERM (`PR_SET_PDEATHSIG`), so no orphan keeps holding the port.

## Tests

```bash
cd server && python -m pytest -q   # 51 tests, ~25 s
cd api && python -m pytest -q      # 22 tests (incl. dataset import), start a real db process
```

## Configuration reference

You can pass these as server flags or set the matching `MINIREDIS_*` environment variables:

`--host --port --dir --appendfsync --snapshot-every-ops --snapshot-every-seconds --no-save-on-shutdown --requirepass --enable-debug-command --max-bulk-bytes --max-clients --log-level`

The API reads these environment variables:

`DB_HOST DB_PORT DB_PASSWORD DASHBOARD_PASSWORD PUBLIC_READS SESSION_SECRET SESSION_HOURS INSTANCE_NAME CLI_PREFIX DB_PUBLIC_ADDRESS ALLOW_CRASH_DEMO ALLOW_DEMO_WORKLOAD REPORTS_DIR CORS_ORIGINS IMPORT_MAX_UPLOAD_MB IMPORT_MAX_UNCOMPRESSED_MB IMPORT_MAX_RECORDS`

If the Overview says sample traffic is turned off, set `ALLOW_DEMO_WORKLOAD=true` in `.env` (or `cp deploy/demo.env .env`) and run `docker compose up -d api`. An empty value follows `ALLOW_CRASH_DEMO`.

If `DASHBOARD_PASSWORD` is empty, writes are open. Only do that for local development.

## Known limits (good next steps)

- Only string values are supported. Lists, hashes and sets would come next.
- There is no replication, no `MULTI`/`EXEC`, and no pub/sub.
- Active expiry scans the expiring keys once per second. That is fine up to hundreds of thousands of keys, but a sampled or heap-based sweep would scale further.
- `SCAN` cursors are offsets into a sorted, cached key list. A key added or removed mid-iteration can shift a page by one item.

## Fault injection (tests only)

Setting `MINIREDIS_FAULT` makes the server kill itself at one of these points:

- `snapshot_after_rotate`
- `snapshot_before_rename`
- `snapshot_after_rename`

`tests/test_hard_recovery.py` uses this to prove that a crash at any step of a snapshot loses nothing.
