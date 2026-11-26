"""Simulated e-commerce application that uses MiniRedis as its cache.

This is the "client's application" in the demo. It runs inside the API
process, talks to the database over RESP like any app would, and records what
its *users* experience:

  product page  (70%)  cache-aside: GET shop:product:<id>; on a miss, fetch
                       from the simulated backend (~30 ms) and SET ... EX 300.
                       If the cache is unavailable, the request falls back to
                       the backend directly: slower, but it still succeeds.
  stock check   (20%)  cache-aside with a short TTL (EX 10); backend ~15 ms.
  add to cart   (10%)  the cart lives in the cache (SET shop:cart:<session> EX 1800).
                       If the cache is unavailable the request FAILS: there is
                       nothing to fall back to. Successful carts are durable writes.

Everything measured here is application-side (request latency, fallbacks,
errors). MiniRedis itself measures command latency, replay and hit counts.
The backend is simulated with asyncio.sleep; its latency is labelled as such.

Dataset mode: when started with `dataset_prefix` (an imported product
catalog) and optionally `orders_prefix` (imported orders), every request is
driven by the imported data:

  product page  (60%)  GET <catalog key>            — your dataset, read-only
  order lookup  (15%)  GET <order key>              — your dataset, read-only
  stock check   (15%)  cache-aside shop:stock:<real product id> EX 10
                       (stock levels are not in the dataset, so the value is
                       derived; the product ids are yours)
  add to cart   (10%)  SET shop:cart:<session> with real product ids
Without an orders dataset the split is 70 / 20 / 10 with no order lookups.
A dataset key that is gone (expired TTL group, deleted) is a real miss and is
served by the simulated backend. Dataset reads never write back, so imported
data is never modified by the traffic.
"""
from __future__ import annotations

import asyncio
import json
import random
import time
from collections import deque
from dataclasses import dataclass, field

from .resp_client import ReplyError, RespClient, Unreachable

ROUTES = ("product", "order", "stock", "cart")
DATASET_ROUTES = ("product", "order")



BACKEND_MS = {"product": (22, 40), "stock": (10, 20), "order": (25, 45)}
PRODUCTS = 400


def _pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))], 2)


@dataclass
class Bucket:
    t: int  # unix second
    requests: int = 0
    ok: int = 0
    hits: int = 0
    misses: int = 0
    fallbacks: int = 0
    errors: int = 0
    lat: list[float] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"t": self.t, "requests": self.requests, "ok": self.ok, "hits": self.hits, "misses": self.misses,
                "fallbacks": self.fallbacks, "errors": self.errors,
                "p50_ms": _pct(self.lat, 50), "p95_ms": _pct(self.lat, 95)}


@dataclass
class RouteStats:
    requests: int = 0
    hits: int = 0
    misses: int = 0
    fallbacks: int = 0
    errors: int = 0
    lat: deque = field(default_factory=lambda: deque(maxlen=5000))
    backend_lat: deque = field(default_factory=lambda: deque(maxlen=5000))

    def to_dict(self) -> dict:
        lookups = self.hits + self.misses
        return {"requests": self.requests, "hits": self.hits, "misses": self.misses, "fallbacks": self.fallbacks,
                "errors": self.errors, "hit_rate": round(self.hits / lookups, 4) if lookups else None,
                "p50_ms": _pct(list(self.lat), 50), "p95_ms": _pct(list(self.lat), 95),
                "backend_avg_ms": round(sum(self.backend_lat) / len(self.backend_lat), 1) if self.backend_lat else None}


class Workload:
    def __init__(self, host: str, port: int, password: str | None) -> None:
        # Short timeouts, like a production cache client: a dead cache must not hang requests.
        self.client = RespClient(host, port, password, pool_size=24, timeout=0.5, connect_timeout=0.2)
        self.running = False
        self.rps = 0
        self.started_at: float | None = None
        self.stop_at: float | None = None
        self.task: asyncio.Task | None = None
        self.buckets: deque[Bucket] = deque(maxlen=900)
        self.routes = {r: RouteStats() for r in ROUTES}
        self.events: deque[dict] = deque(maxlen=200)
        self.totals = {"requests": 0, "ok": 0, "errors": 0, "fallbacks": 0, "hits": 0, "misses": 0,
                       "carts_saved": 0}
        self._cache_ok = True
        self._inflight = 0
        self.rng = random.Random(7)
        self.dataset_prefix: str | None = None
        self.dataset_keys: list[bytes] = []
        self.product_ids: list[str] = []
        self.orders_prefix: str | None = None
        self.order_keys: list[bytes] = []

    # ------------------------------------------------------------ lifecycle
    async def _load_dataset(self, prefix: str) -> list[bytes]:
        from .importer import _glob_escape
        keys: list[bytes] = []
        cursor = 0
        loader = RespClient(self.client.host, self.client.port, self.client.password, pool_size=1, timeout=10)
        try:
            while len(keys) < 20_000:
                nxt, batch = await loader.call("SCAN", cursor, "MATCH", f"{_glob_escape(prefix)}*", "COUNT", 2000)
                keys += batch
                cursor = int(nxt)
                if cursor == 0:
                    break
        finally:
            loader.reset()
        keys = sorted(keys)[:20_000]
        random.Random(11).shuffle(keys)  # popularity rank is random but stable
        return keys

    async def start(self, rps: int, duration_s: int, dataset_prefix: str | None = None, orders_prefix: str | None = None) -> None:
        dataset_prefix = dataset_prefix or None
        orders_prefix = (orders_prefix or None) if dataset_prefix else None
        if dataset_prefix != self.dataset_prefix or orders_prefix != self.orders_prefix or (dataset_prefix and not self.dataset_keys):
            keys = await self._load_dataset(dataset_prefix) if dataset_prefix else []
            if dataset_prefix and not keys:
                raise ValueError(f"No keys found under {dataset_prefix!r}. Import a dataset first.")
            okeys = await self._load_dataset(orders_prefix) if orders_prefix else []
            if orders_prefix and not okeys:
                raise ValueError(f"No keys found under {orders_prefix!r}.")
            if self.running:
                await self.stop("restarted with a different source")
            self.dataset_prefix, self.dataset_keys = dataset_prefix, keys
            n = len(dataset_prefix.encode()) if dataset_prefix else 0
            self.product_ids = [k[n:].decode("utf-8", "replace") for k in keys]
            self.orders_prefix, self.order_keys = orders_prefix, okeys
        if self.running:
            self.rps = rps
            self.stop_at = time.time() + duration_s
            self.event("config", f"rate set to {rps} req/s")
            return
        self.running = True
        self.rps = rps
        self.started_at = time.time()
        self.stop_at = self.started_at + duration_s
        self.buckets.clear()
        self.routes = {r: RouteStats() for r in ROUTES}
        self.events.clear()
        self.totals = {k: 0 for k in self.totals}
        self._cache_ok = True
        src = (f"your data: {len(self.dataset_keys):,} products under {self.dataset_prefix}"
               + (f" and {len(self.order_keys):,} orders under {self.orders_prefix}" if self.orders_prefix else "")
               if self.dataset_prefix else "synthetic catalog (shop:*)")
        self.event("start", f"sample e-commerce traffic started at {rps} req/s — {src}")
        self.task = asyncio.create_task(self._driver())

    async def stop(self, reason: str = "stopped") -> None:
        if not self.running:
            return
        self.running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
        self.event("stop", f"traffic {reason}")
        self.client.reset()

    def event(self, kind: str, label: str, at_ms: int | None = None) -> None:
        self.events.append({"t_ms": at_ms or int(time.time() * 1000), "kind": kind, "label": label})

    # ------------------------------------------------------------ traffic
    async def _driver(self) -> None:
        interval_start = time.perf_counter()
        sent = 0
        try:
            while self.running:
                if self.stop_at and time.time() >= self.stop_at:
                    asyncio.create_task(self.stop("finished (time limit)"))
                    return
                # open-loop pacing: requests arrive on schedule even when the cache is slow
                due = int((time.perf_counter() - interval_start) * self.rps)
                while sent < due and self._inflight < 400:
                    sent += 1
                    asyncio.create_task(self._request())
                await asyncio.sleep(0.005)
        except asyncio.CancelledError:
            pass

    def _bucket(self) -> Bucket:
        now = int(time.time())
        if not self.buckets or self.buckets[-1].t != now:
            # fill gaps so charts show silence explicitly
            last = self.buckets[-1].t if self.buckets else now - 1
            for t in range(last + 1, now + 1):
                self.buckets.append(Bucket(t))
        return self.buckets[-1]

    def _cache_state(self, ok: bool) -> None:
        if ok != self._cache_ok:
            self._cache_ok = ok
            self.event("cache_up" if ok else "cache_down",
                       "cache answering again" if ok else "cache unavailable — product/stock fall back to the backend, carts fail")

    async def _backend(self, route: str) -> float:
        lo, hi = BACKEND_MS[route]
        ms = self.rng.uniform(lo, hi)
        await asyncio.sleep(ms / 1000)
        return ms

    def _pick(self, n: int, alpha: float = 1.05) -> int:
        """Popularity-skewed index in [0, n)."""
        return min(int(self.rng.paretovariate(alpha)), n) - 1

    def _route(self) -> str:
        r = self.rng.random()
        if self.dataset_keys and self.order_keys:
            return "product" if r < 0.6 else "order" if r < 0.75 else "stock" if r < 0.9 else "cart"
        return "product" if r < 0.7 else "stock" if r < 0.9 else "cart"

    async def _request(self) -> None:
        self._inflight += 1
        route = self._route()
        stats = self.routes[route]
        t0 = time.perf_counter()
        outcome = "ok"
        hit = miss = fallback = False
        ds = bool(self.dataset_keys)
        try:
            if route == "cart":
                session = self.rng.randrange(2000)
                if ds:
                    items = [self.product_ids[self._pick(len(self.product_ids))] for _ in range(self.rng.randint(1, 4))]
                else:
                    items = [self.rng.randrange(PRODUCTS) for _ in range(self.rng.randint(1, 4))]
                cart = json.dumps({"session": session, "items": items})
                reply = await self.client.call_raw("SET", f"shop:cart:{session}", cart, "EX", 1800)
                if reply != "OK":
                    raise Unreachable(str(reply))
                self.totals["carts_saved"] += 1
                self._cache_state(True)
            else:
                read_only = False
                if route == "product" and ds:
                    key, read_only = self.dataset_keys[self._pick(len(self.dataset_keys))], True
                elif route == "order":
                    key, read_only = self.order_keys[self._pick(len(self.order_keys), 1.02)], True
                elif ds:  # stock for a real product id
                    pid = self.product_ids[self._pick(len(self.product_ids))]
                    key = f"shop:stock:{pid}"
                else:
                    pid = min(int(self.rng.paretovariate(1.2)), PRODUCTS)  # a few products are very popular
                    key = f"shop:{route}:{pid}"
                try:
                    val = await self.client.call_raw("GET", key)
                    if isinstance(val, ReplyError):
                        raise Unreachable(str(val))
                    self._cache_state(True)
                    if val is None:
                        miss = True
                        b = await self._backend(route)
                        stats.backend_lat.append(b)
                        if not read_only:  # dataset keys are never written back
                            payload = json.dumps({"id": str(key).rsplit(":", 1)[-1], "name": "Product", "price": 199} if route == "product"
                                                 else {"in_stock": self.rng.randint(0, 40)})
                            await self.client.call_raw("SET", key, payload, "EX", 300 if route == "product" else 10)
                    else:
                        hit = True
                except Unreachable:
                    self._cache_state(False)
                    fallback = True
                    b = await self._backend(route)
                    stats.backend_lat.append(b)
        except (Unreachable, ReplyError):
            self._cache_state(False)
            outcome = "error"
        except Exception:
            outcome = "error"
        finally:
            self._inflight -= 1
        lat = (time.perf_counter() - t0) * 1000
        bucket = self._bucket()
        bucket.requests += 1
        stats.requests += 1
        self.totals["requests"] += 1
        if outcome == "error":
            bucket.errors += 1
            stats.errors += 1
            self.totals["errors"] += 1
        else:
            bucket.ok += 1
            self.totals["ok"] += 1
            bucket.lat.append(lat)
            stats.lat.append(lat)
        if hit:
            bucket.hits += 1
            stats.hits += 1
            self.totals["hits"] += 1
        if miss:
            bucket.misses += 1
            stats.misses += 1
            self.totals["misses"] += 1
        if fallback:
            bucket.fallbacks += 1
            stats.fallbacks += 1
            self.totals["fallbacks"] += 1

    # ------------------------------------------------------------ reporting
    def _route_sources(self) -> dict:
        if not self.dataset_keys:
            return {"product": "synthetic", "order": "off", "stock": "synthetic", "cart": "synthetic"}
        return {"product": "dataset", "order": "dataset" if self.order_keys else "off",
                "stock": "dataset_ids", "cart": "dataset_ids"}

    def _dataset_lookups(self) -> dict | None:
        """Hit rate / latency over requests that read imported keys only (since start)."""
        if not self.dataset_keys:
            return None
        rs = [self.routes[r] for r in DATASET_ROUTES if r == "product" or self.order_keys]
        hits = sum(r.hits for r in rs)
        misses = sum(r.misses for r in rs)
        lat = [x for r in rs for x in r.lat]
        return {"requests": sum(r.requests for r in rs), "hits": hits, "misses": misses,
                "fallbacks": sum(r.fallbacks for r in rs), "errors": sum(r.errors for r in rs),
                "hit_rate": round(hits / (hits + misses), 4) if hits + misses else None,
                "p50_ms": _pct(lat, 50), "p95_ms": _pct(lat, 95)}

    def snapshot(self, seconds: int = 300) -> dict:
        now = int(time.time())
        series = [b.to_dict() for b in self.buckets if b.t >= now - seconds and b.t < now]  # completed seconds only
        recent = [b for b in self.buckets if now - 60 <= b.t < now]
        lat = [x for b in recent for x in b.lat]
        req = sum(b.requests for b in recent)
        ok = sum(b.ok for b in recent)
        hits = sum(b.hits for b in recent)
        lookups = hits + sum(b.misses for b in recent)
        return {
            "running": self.running,
            "rps": self.rps,
            "started_at": self.started_at,
            "stop_at": self.stop_at,
            "totals": self.totals,
            "last_60s": {
                "requests": req,
                "success_rate": round(ok / req, 4) if req else None,
                "p95_ms": _pct(lat, 95),
                "p50_ms": _pct(lat, 50),
                "hit_rate": round(hits / lookups, 4) if lookups else None,
                "fallbacks": sum(b.fallbacks for b in recent),
                "errors": sum(b.errors for b in recent),
            },
            "routes": {r: s.to_dict() for r, s in self.routes.items()},
            "series": series,
            "events": list(self.events),
            "source": "simulated e-commerce app inside the API process (backend latency simulated)",
            "dataset_prefix": self.dataset_prefix,
            "dataset_keys": len(self.dataset_keys),
            "orders_prefix": self.orders_prefix,
            "order_keys": len(self.order_keys),
            "route_sources": self._route_sources(),
            "dataset_lookups": self._dataset_lookups(),
        }
