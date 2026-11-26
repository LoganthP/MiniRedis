import { Activity, ArrowRight, BarChart3, Boxes, ClipboardList, Gauge, HardDrive, Info, Pause, Play, ShieldCheck, ShoppingCart, Zap } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Dataset, type DatasetInsights, type MetricPoint, type RestoreCheck, type WorkloadStatus } from "../lib/api";
import { useApp } from "../lib/app-context";
import { useExperiment, type CrashReport } from "../lib/experiment";
import { formatBytes, formatMs, formatNumber, timeAgo } from "../lib/format";
import { Button, Panel, PanelHeader, Segmented, Tag, cx, useToast } from "../components/ui";
import { Legend, TimeChart, type ChartEvent } from "../components/Charts";

/**
 * Overview: "If this cache goes down, how quickly will my application
 * recover, and what data will survive?" — answered with the simulated
 * e-commerce app (application-side metrics), the engine's own metrics, and
 * the saved crash / restore verifications. Every number says where it comes from.
 */

const pctStr = (v: number | null | undefined, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);

function Source({ children }: { children: ReactNode }) {
  return <span className="rounded border border-line px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-fg-3">{children}</span>;
}

function Kpi({ label, value, hint, source, tone }: { label: string; value: ReactNode; hint: ReactNode; source: string; tone?: "ok" | "warn" | "danger" }) {
  return (
    <Panel className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-fg-3">{label}</div>
        <Source>{source}</Source>
      </div>
      <div className={cx("num mt-2 text-[26px] font-medium leading-none", tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : "text-fg")}>{value}</div>
      <div className="mt-2 text-xs text-fg-3">{hint}</div>
    </Panel>
  );
}

const ROUTE_META = {
  product: { label: "Product pages", icon: Boxes, desc: "cache-aside on shop:product:*, TTL 300 s; backend ~22–40 ms" },
  order: { label: "Order lookups", icon: ClipboardList, desc: "" },
  stock: { label: "Stock checks", icon: Activity, desc: "cache-aside on shop:stock:*, TTL 10 s; backend ~10–20 ms" },
  cart: { label: "Add to cart", icon: ShoppingCart, desc: "stored in the cache (durable write); no fallback" },
} as const;

type RouteKey = keyof typeof ROUTE_META;

/** How each request type uses data, for the current traffic source. */
function routeDesc(k: RouteKey, wl: WorkloadStatus | null): string {
  if (!wl?.dataset_prefix) return ROUTE_META[k].desc;
  const p = wl.dataset_prefix;
  switch (k) {
    case "product": return `GET ${p}<id> on ${formatNumber(wl.dataset_keys)} imported products · read-only; missing key → backend`;
    case "order": return `GET ${wl.orders_prefix}<id> on ${formatNumber(wl.order_keys)} imported orders · read-only; missing key → backend`;
    case "stock": return "cache-aside shop:stock:<your product id>, TTL 10 s · stock levels are simulated";
    case "cart": return "SET shop:cart:<session> with your product ids (durable write); no fallback";
  }
}

const SOURCE_LABEL: Record<string, string> = { dataset: "your data", dataset_ids: "your ids", synthetic: "synthetic" };

const EVENT_TONE: Record<string, ChartEvent["tone"]> = { crash: "danger", cache_down: "warn", ready: "ok", cache_up: "ok", start: "muted", stop: "muted", config: "muted" };

export function OverviewView() {
  const { live, isReady, canWrite, requireWrite, session, canRead, overview } = useApp();
  const exp = useExperiment();
  const toast = useToast();
  const [wl, setWl] = useState<WorkloadStatus | null>(null);
  const [hist, setHist] = useState<MetricPoint[]>([]);
  const [reports, setReports] = useState<CrashReport[]>([]);
  const [restores, setRestores] = useState<RestoreCheck[]>([]);
  const [rps, setRps] = useState<"30" | "60" | "150">("60");
  const [busy, setBusy] = useState(false);
  const [slowDemo, setSlowDemo] = useState(true);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [source, setSource] = useState<string | null>(null); // null = not chosen yet, "" = synthetic catalog, else dataset prefix
  const [ordersSrc, setOrdersSrc] = useState<string>("__auto"); // "__auto" | "" (none) | prefix
  const [insights, setInsights] = useState<Record<string, DatasetInsights>>({});

  const loadWl = useCallback(async () => {
    try {
      setWl(await api.workload(300));
    } catch {
      /* API down */
    }
  }, []);
  const loadHist = useCallback(async () => {
    try {
      setHist((await api.metricsHistory(15)).points);
    } catch {
      /* API down */
    }
  }, []);
  const loadReports = useCallback(async () => {
    try {
      setReports((await api.reports("crash_lab")).reports as unknown as CrashReport[]);
    } catch {
      /* private reads */
    }
    try {
      setRestores((await api.restores()).restores);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    loadWl();
    loadHist();
    if (!live) return;
    const a = window.setInterval(loadWl, 1000);
    const b = window.setInterval(loadHist, 5000);
    return () => {
      window.clearInterval(a);
      window.clearInterval(b);
    };
  }, [live, loadWl, loadHist]);
  useEffect(() => {
    loadReports();
  }, [loadReports, exp.savedCount, canRead]);

  const loadDatasets = useCallback(async () => {
    try {
      const d = (await api.datasets()).datasets.filter((x) => (x.live_keys ?? 0) > 0);
      setDatasets(d);
      const out: Record<string, DatasetInsights> = {};
      await Promise.all(d.slice(0, 6).map(async (x) => {
        try {
          out[x.prefix] = await api.insights(x.prefix);
        } catch {
          /* skip */
        }
      }));
      setInsights(out);
    } catch {
      /* private reads / offline */
    }
  }, []);
  useEffect(() => {
    loadDatasets();
    if (!live) return;
    const t = window.setInterval(loadDatasets, 30000);
    return () => window.clearInterval(t);
  }, [loadDatasets, live, canRead, isReady]);
  // Running traffic shows its own source; otherwise default to the newest imported
  // product-like dataset (orders datasets are offered separately).
  const isOrders = (d: Dataset) => /order/i.test(d.prefix + d.id_column);
  const catalogs = datasets.filter((d) => !isOrders(d));
  const orderSets = datasets.filter(isOrders);
  useEffect(() => {
    if (wl?.running) setSource(wl.dataset_prefix ?? "");
  }, [wl?.running, wl?.dataset_prefix]);
  // newest persistent catalog first (a TTL group is usually a short-lived subset)
  const chosenSource = source ?? ((catalogs.find((d) => !d.ttl_seconds) ?? catalogs[0])?.prefix ?? "");
  const autoOrders = orderSets[0]?.prefix ?? "";

  const start = () =>
    requireWrite("start sample traffic", async () => {
      setBusy(true);
      try {
        const w = await api.workloadStart(Number(rps), 900, chosenSource || null, ordersSrc === "__auto" ? undefined : ordersSrc);
        setWl(w);
        toast("success", `Traffic started at ${rps} req/s on ${w.dataset_prefix ? `${w.dataset_prefix}*${w.orders_prefix ? ` + ${w.orders_prefix}*` : ""}` : "the synthetic catalog"} (stops after 15 min)`);
      } catch (e) {
        toast("error", (e as Error).message);
      } finally {
        setBusy(false);
      }
    });
  const stop = () =>
    requireWrite("stop sample traffic", async () => {
      setBusy(true);
      try {
        setWl(await api.workloadStop());
      } finally {
        setBusy(false);
      }
    });

  const running = !!wl?.running;
  const l60 = wl?.last_60s;
  const last = reports[0];
  const lastRestore = restores[0];
  const histNow = [...hist].reverse().find((p) => p.status !== "offline");
  const engineHit = [...hist].reverse().find((p) => p.hit_rate != null)?.hit_rate ?? null;
  const workloadEnabled = session?.demo_workload_enabled !== false;
  const crashEnabled = session?.crash_demo_enabled !== false;

  const series = (wl?.series ?? []).map((b) => ({
    t: b.t * 1000,
    cache: b.hits,
    miss: b.misses,
    fallback: b.fallbacks,
    failed: b.errors,
    p95: b.p95_ms,
  }));
  const events: ChartEvent[] = (wl?.events ?? []).filter((e) => e.kind !== "config").map((e) => ({ t: e.t_ms, label: e.label, tone: EVENT_TONE[e.kind] ?? "muted" }));
  const lastImpact = reports.find((r) => r.workload)?.workload;
  const dsl = wl?.dataset_prefix ? wl.dataset_lookups : null;
  const activeSource = wl?.running || wl?.totals?.requests ? wl?.dataset_prefix : chosenSource;
  const appSource = activeSource ? "your data + sim backend" : "synthetic app";

  return (
    <div className="space-y-4">
      {/* Question + walkthrough */}
      <Panel className="p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <h1 className="text-lg font-semibold tracking-tight sm:text-xl">If this cache goes down, how fast does the app recover — and what survives?</h1>
            <p className="mt-1.5 text-[13px] text-fg-2">
              Start the sample shop's traffic, crash the database while requests are flowing, and read what its users saw and which data came back.
              {overview?.instance && <> Instance <span className="font-mono">{overview.instance.name}</span>.</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {workloadEnabled ? (
              <>
                {!running && datasets.length > 0 && (
                  <>
                    <select value={chosenSource} onChange={(e) => setSource(e.target.value)} className="field h-8 max-w-[280px] px-2 text-xs" aria-label="Product catalog for sample traffic">
                      <option value="">Products: synthetic shop:*</option>
                      {[...catalogs, ...orderSets].map((d) => (
                        <option key={d.prefix} value={d.prefix}>Products: {d.prefix}* ({formatNumber(d.live_keys)})</option>
                      ))}
                    </select>
                    {chosenSource && (
                      <select value={ordersSrc} onChange={(e) => setOrdersSrc(e.target.value)} className="field h-8 max-w-[280px] px-2 text-xs" aria-label="Orders for sample traffic">
                        <option value="__auto">{autoOrders ? `Orders: ${autoOrders}* (newest)` : "Orders: none imported"}</option>
                        <option value="">Orders: no order lookups</option>
                        {orderSets.filter((d) => d.prefix !== chosenSource).map((d) => (
                          <option key={d.prefix} value={d.prefix}>Orders: {d.prefix}*</option>
                        ))}
                      </select>
                    )}
                  </>
                )}
                {running && (
                  <span className="max-w-[340px] text-right text-[11px] leading-snug text-fg-3">
                    {wl?.dataset_prefix ? (
                      <>Driven by your data: <span className="font-mono text-fg-2">{wl.dataset_prefix}*</span>{wl.orders_prefix && <> + <span className="font-mono text-fg-2">{wl.orders_prefix}*</span></>}</>
                    ) : (
                      <>Synthetic catalog <span className="font-mono">shop:*</span>{datasets.length > 0 && " — stop traffic to switch to your data"}</>
                    )}
                  </span>
                )}
                {!running && <Segmented value={rps} onChange={setRps} options={[{ value: "30", label: "30 req/s" }, { value: "60", label: "60 req/s" }, { value: "150", label: "150 req/s" }]} />}
                {running ? (
                  <Button variant="secondary" onClick={stop} loading={busy} icon={<Pause />}>Stop traffic</Button>
                ) : (
                  <Button variant="secondary" onClick={start} loading={busy} disabled={!isReady} icon={<Play />}>Start sample traffic</Button>
                )}
              </>
            ) : null}
            {crashEnabled && (
              <Button variant="primary" onClick={() => exp.run({ concurrentWriters: 8, slowRecoveryMs: slowDemo ? 3000 : 0 })} loading={exp.running} disabled={!isReady && !exp.running} icon={<Zap />}>
                {exp.running ? "Crashing & verifying…" : "Crash the database"}
              </Button>
            )}
          </div>
        </div>
        <ol className="mt-4 hidden gap-2 text-xs sm:grid sm:grid-cols-3">
          {[
            { n: 1, t: "Start sample traffic", d: "product pages, order lookups, stock checks and carts hit the cache", done: running },
            { n: 2, t: "Crash the database mid-traffic", d: "8 extra writers make durable SETs while it dies", done: !!exp.report || exp.running },
            { n: 3, t: "Read the outcome", d: "app impact, downtime, acked writes, TTL deadlines", done: !!exp.report },
          ].map((s) => (
            <li key={s.n} className={cx("flex items-start gap-2.5 rounded-lg border px-3 py-2", s.done ? "border-ok/30 bg-ok/5" : "border-line")}>
              <span className={cx("num grid size-5 shrink-0 place-items-center rounded-full border text-[10px]", s.done ? "border-ok/50 text-ok" : "border-line-strong text-fg-3")}>{s.n}</span>
              <span>
                <span className="block font-medium text-fg">{s.t}</span>
                <span className="text-fg-3">{s.d}</span>
              </span>
            </li>
          ))}
        </ol>
        {crashEnabled && (
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-fg-2">
            <input type="checkbox" checked={slowDemo} onChange={(e) => setSlowDemo(e.target.checked)} disabled={exp.running} className="mt-0.5 accent-[var(--accent-primary)]" />
            <span>
              Simulate a slow 3 s recovery so the impact on the app is visible{" "}
              <span className="text-fg-3">(a real restart here takes ~0.1 s — often too fast for the app to notice)</span>
            </span>
          </label>
        )}
        {!workloadEnabled && (
          <div className="mt-4 flex gap-2.5 rounded-lg border border-line bg-canvas px-3 py-2.5 text-xs text-fg-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-fg-3" />
            <span>
              <b className="font-medium text-fg">Sample traffic is turned off on this deployment</b>, so the application-impact charts stay empty. The dataset,
              capacity and durability panels below still work. To turn traffic on, set <code className="font-mono">ALLOW_DEMO_WORKLOAD=true</code> in{" "}
              <code className="font-mono">.env</code> (or <code className="font-mono">cp deploy/demo.env .env</code>) and run{" "}
              <code className="font-mono">docker compose up -d api</code>.
            </span>
          </div>
        )}
        {!canWrite && session?.auth_required && <p className="mt-3 text-xs text-fg-3">Starting traffic and crashing the database require sign-in; you'll be asked when you click.</p>}
        {exp.running && <p className="mt-3 text-xs text-warn">{exp.log[exp.log.length - 1]?.text}</p>}
        {exp.report && !exp.running && (
          <div className={cx("mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-xs", exp.report.passed ? "border-ok/30 bg-ok/5" : "border-danger/30 bg-danger/5")}>
            {exp.report.passed ? <Tag tone="ok">passed</Tag> : <Tag tone="danger">failed</Tag>}
            <span>Downtime <b className="num">{formatMs(exp.report.downtime_ms)}</b></span>
            <span>first request after <b className="num">{formatMs(exp.report.first_success_ms)}</b></span>
            {exp.report.load && <span>acked writes <b className="num">{exp.report.load.recovered.toLocaleString()} / {exp.report.load.acked.toLocaleString()}</b> recovered</span>}
            {exp.report.workload && <span>app: <b className="num">{exp.report.workload.served_by_fallback}</b> via fallback, <b className="num">{exp.report.workload.failed}</b> failed</span>}
            <a href="#/recovery" className="ml-auto inline-flex items-center gap-1 text-fg-2 hover:text-fg">Full report <ArrowRight className="size-3" /></a>
          </div>
        )}
      </Panel>

      {/* Four signals */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi
          label="Request success"
          source={appSource}
          value={l60?.requests ? pctStr(l60.success_rate, 2) : "—"}
          tone={l60?.success_rate == null ? undefined : l60.success_rate >= 0.999 ? "ok" : l60.success_rate >= 0.98 ? "warn" : "danger"}
          hint={l60?.requests ? `${formatNumber(l60.requests)} requests in the last 60 s · ${l60.errors} failed` : "start sample traffic to measure"}
        />
        <Kpi
          label="p95 app latency"
          source={appSource}
          value={l60?.p95_ms != null ? formatMs(l60.p95_ms) : "—"}
          hint={l60?.p50_ms != null ? `p50 ${formatMs(l60.p50_ms)} · last 60 s, incl. backend on misses` : "start sample traffic to measure"}
        />
        {dsl ? (
          <Kpi
            label="Hit rate on your data"
            source="your dataset"
            value={pctStr(dsl.hit_rate)}
            hint={<>{formatNumber(dsl.hits)} hits · {formatNumber(dsl.misses)} misses · {formatNumber(dsl.fallbacks)} fallbacks on imported keys since start{l60?.hit_rate != null && <> · all lookups {pctStr(l60.hit_rate)}</>}</>}
          />
        ) : (
          <Kpi
            label="Cache hit rate"
            source={l60?.hit_rate != null ? "synthetic app" : "engine"}
            value={l60?.hit_rate != null ? pctStr(l60.hit_rate) : engineHit != null ? pctStr(engineHit) : "—"}
            hint={l60?.hit_rate != null ? `${l60.fallbacks} fallbacks in the last 60 s` : engineHit != null ? "GET hits ÷ lookups, last 2 s window" : "no reads yet"}
          />
        )}
        <Kpi
          label="Last verified recovery"
          source="crash lab"
          tone={last ? (last.passed ? "ok" : "danger") : undefined}
          value={last ? (last.passed ? "passed" : "failed") : "—"}
          hint={
            last ? (
              <>
                {formatMs(last.downtime_ms)} downtime · {timeAgo(last.created_ms)}
                {lastRestore && <> · restore {lastRestore.ok ? "verified" : "FAILED"} {timeAgo(lastRestore.at_ms)}</>}
              </>
            ) : (
              "no crash test yet"
            )
          }
        />
      </div>

      {/* Application impact timeline */}
      <Panel>
        <PanelHeader
          icon={<Gauge />}
          title="Application impact"
          meta="Requests per second by outcome, with p95 latency — crash, cache-down and recovery are marked"
          right={<Source>{activeSource ? `traffic on ${activeSource}*` : "synthetic app"} · simulated backend</Source>}
        />
        <div className="px-4 pt-3">
          <Legend
            items={[
              { label: "served from cache", color: "var(--chart-ok)" },
              { label: "cache miss → backend", color: "var(--chart-cache)" },
              { label: "cache down → backend fallback", color: "var(--status-warn)" },
              { label: "failed", color: "var(--status-danger)" },
              { label: "p95 latency (right axis)", color: "var(--text-primary)", dashed: true },
            ]}
          />
        </div>
        <div className="px-2 pb-3 pt-1">
          <TimeChart
            data={series}
            height={220}
            leftLabel="req/s"
            rightLabel="p95 ms"
            series={[
              { key: "cache", label: "served from cache", kind: "bar", color: "var(--chart-ok)" },
              { key: "miss", label: "miss → backend", kind: "bar", color: "var(--chart-cache)" },
              { key: "fallback", label: "fallback", kind: "bar", color: "var(--status-warn)" },
              { key: "failed", label: "failed", kind: "bar", color: "var(--status-danger)" },
              { key: "p95", label: "p95 latency", kind: "line", color: "var(--text-primary)", axis: "right", format: (v) => `${v.toFixed(1)} ms` },
            ]}
            events={events}
            empty={workloadEnabled ? "Start sample traffic to see requests flow through the cache." : "Sample traffic is disabled on this deployment."}
          />
        </div>
        {lastImpact && (
          <div className="border-t border-line px-4 py-2.5 text-xs text-fg-2">
            Last crash under traffic{lastImpact.data_source && <> on <span className="font-mono">{lastImpact.data_source}</span></>}: <b className="num text-fg">{lastImpact.requests}</b> requests during a {lastImpact.window_s} s outage window —{" "}
            <b className="num text-warn">{lastImpact.served_by_fallback}</b> served by the backend fallback,{" "}
            <b className={cx("num", lastImpact.failed ? "text-danger" : "text-fg")}>{lastImpact.failed}</b> failed (carts have no fallback), p95{" "}
            <b className="num text-fg">{lastImpact.p95_before_ms ?? "—"} → {lastImpact.p95_peak_ms ?? "—"} ms</b>
            {lastImpact.back_to_normal_ms != null && <>; cache answering again after <b className="num text-fg">{formatMs(lastImpact.back_to_normal_ms)}</b></>}.
          </div>
        )}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Cache effectiveness by workload */}
        <Panel className="overflow-hidden">
          <PanelHeader icon={<Boxes />} title="Cache effectiveness by workload" meta="Which part of the app benefits most from the cache — and which data each request uses" right={<Source>{activeSource ? "your data" : "synthetic app"}</Source>} />
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-wider text-fg-3">
                <th className="px-4 py-2 font-medium">Workload</th>
                <th className="px-2 py-2 font-medium">Hit rate</th>
                <th className="px-2 py-2 text-right font-medium">p95</th>
                <th className="px-2 py-2 text-right font-medium">Fallback / failed</th>
                <th className="px-4 py-2 text-right font-medium">Backend avg</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(ROUTE_META) as RouteKey[]).map((k) => {
                const r = wl?.routes?.[k];
                const M = ROUTE_META[k];
                const src = wl?.route_sources?.[k] ?? (k === "order" ? "off" : "synthetic");
                if (src === "off") return null;
                return (
                  <tr key={k} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 font-medium text-fg">
                        <M.icon className="size-3.5 text-fg-3" />{M.label}
                        <Tag tone={src === "dataset" ? "accent" : "muted"}>{SOURCE_LABEL[src]}</Tag>
                      </div>
                      <div className="text-[11px] text-fg-3">{routeDesc(k, wl)} · {formatNumber(r?.requests ?? 0)} req</div>
                    </td>
                    <td className="px-2">
                      {r?.hit_rate != null ? (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-hover"><div className="h-full bg-fg-2" style={{ width: `${r.hit_rate * 100}%` }} /></div>
                          <span className="num text-fg">{pctStr(r.hit_rate, 0)}</span>
                        </div>
                      ) : (
                        <span className="text-fg-3">{k === "cart" ? "writes only" : "—"}</span>
                      )}
                    </td>
                    <td className="num px-2 text-right text-fg">{r?.p95_ms != null ? formatMs(r.p95_ms) : "—"}</td>
                    <td className="num px-2 text-right text-fg-2">
                      <span className={r?.fallbacks ? "text-warn" : ""}>{r?.fallbacks ?? 0}</span> / <span className={r?.errors ? "text-danger" : ""}>{r?.errors ?? 0}</span>
                    </td>
                    <td className="num px-4 text-right text-fg-3">{r?.backend_avg_ms != null ? `${r.backend_avg_ms} ms` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-line px-4 py-2 text-[11px] text-fg-3">
            Hit rate and latency are measured by the app's own client. <b className="font-medium text-fg-2">your data</b> = reads your imported keys;{" "}
            <b className="font-medium text-fg-2">your ids</b> = uses your product ids with simulated values. Backend latency is simulated, so savings are illustrative, not a cost estimate.
          </p>
        </Panel>

        {/* Capacity & expiration */}
        <Panel>
          <PanelHeader
            icon={<HardDrive />}
            title="Capacity & expiration"
            meta={histNow ? `${formatNumber(histNow.keys)} keys · ${formatNumber(histNow.expires)} with TTL · ${formatBytes(histNow.dataset_bytes)} · last 15 min` : "last 15 min"}
            right={<Source>engine · INFO every 2 s</Source>}
          />
          <div className="px-4 pt-3"><Legend items={[{ label: "keys", color: "var(--text-primary)", dashed: true }, { label: "keys with TTL", color: "var(--status-warn)", dashed: true }]} /></div>
          <div className="px-2">
            <TimeChart
              data={hist.filter((p) => p.status !== "offline").map((p) => ({ t: p.t, keys: p.keys ?? null, ttl: p.expires ?? null }))}
              height={130}
              series={[
                { key: "keys", label: "keys", kind: "line", color: "var(--text-primary)", format: (v) => formatNumber(v) },
                { key: "ttl", label: "with TTL", kind: "line", color: "var(--status-warn)", format: (v) => formatNumber(v) },
              ]}
              empty="Collecting… the API samples the engine every 2 seconds."
            />
          </div>
          <div className="px-4"><Legend items={[{ label: "expired / s", color: "var(--status-warn)" }, { label: "writes / s", color: "var(--text-primary)", dashed: true }]} /></div>
          <div className="px-2 pb-2">
            <TimeChart
              data={hist.filter((p) => p.status !== "offline").map((p) => ({ t: p.t, exp: p.expired_per_sec ?? null, wr: p.writes_per_sec ?? null }))}
              height={110}
              series={[
                { key: "exp", label: "expired / s", kind: "bar", color: "var(--status-warn)", format: (v) => (v >= 100 ? formatNumber(Math.round(v)) : v.toFixed(1)) },
                { key: "wr", label: "writes / s", kind: "line", color: "var(--text-primary)", format: (v) => (v >= 100 ? formatNumber(Math.round(v)) : v.toFixed(1)) },
              ]}
              events={hist.filter((p) => p.status === "offline").map((p) => ({ t: p.t, label: "database unreachable", tone: "danger" as const }))}
            />
          </div>
          <p className="border-t border-line px-4 py-2 text-[11px] text-fg-3">
            Keys leave only by expiry or deletion — there is no eviction policy, so nothing is evicted under memory pressure.
          </p>
        </Panel>
      </div>

      <DatasetPanel datasets={datasets} insights={insights} />

      {/* Durability & restore history */}
      <Panel className="overflow-hidden">
        <PanelHeader
          icon={<ShieldCheck />}
          title="Durability & restore history"
          meta="Most recent crash tests and backup restore checks"
          right={<a href="#/recovery" className="inline-flex items-center gap-1 text-xs text-fg-2 hover:text-fg">Compare & export <ArrowRight className="size-3" /></a>}
        />
        {session && !canRead ? (
          <p className="px-4 py-4 text-xs text-fg-3">Sign in to see saved reports on this instance.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <tbody>
              {reports.slice(0, 5).map((r) => (
                <tr key={r.id} className="border-b border-line/70">
                  <td className="w-24 px-4 py-2">{r.passed ? <Tag tone="ok">passed</Tag> : <Tag tone="danger">failed</Tag>}</td>
                  <td className="px-2 text-fg-2">crash test · {timeAgo(r.created_ms)}</td>
                  <td className="num px-2 text-right text-fg">{formatMs(r.downtime_ms)} down</td>
                  <td className="num hidden px-2 text-right text-fg-2 sm:table-cell">{r.load ? `${r.load.recovered.toLocaleString()}/${r.load.acked.toLocaleString()} acked writes` : "—"}</td>
                  <td className="num hidden px-4 text-right text-fg-2 md:table-cell">{formatNumber(Number(r.environment?.keys ?? 0))} keys · {r.replayed} replayed</td>
                </tr>
              ))}
              {lastRestore && (
                <tr className="border-b border-line/70">
                  <td className="w-24 px-4 py-2">{lastRestore.ok ? <Tag tone="ok">passed</Tag> : <Tag tone="danger">failed</Tag>}</td>
                  <td className="px-2 text-fg-2">restore to fresh dir · {timeAgo(lastRestore.at_ms)}</td>
                  <td className="num px-2 text-right text-fg">{lastRestore.keys?.toLocaleString() ?? "—"} keys</td>
                  <td className="num hidden px-2 text-right text-fg-2 sm:table-cell">{lastRestore.sampled != null ? `${lastRestore.identical}/${lastRestore.sampled} identical` : "—"}</td>
                  <td className="hidden px-4 text-right font-mono text-fg-3 md:table-cell">{lastRestore.backup}</td>
                </tr>
              )}
              {!reports.length && !lastRestore && (
                <tr><td className="px-4 py-5 text-center text-fg-3" colSpan={5}>Nothing verified yet — run “Crash the database” above.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

const monthFmt = (t: number) => new Date(t).toLocaleDateString([], { year: "2-digit", month: "short" });

function DatasetPanel({ datasets, insights }: { datasets: Dataset[]; insights: Record<string, DatasetInsights> }) {
  // product-style "category" fields first, then the rest
  const withCat = datasets
    .filter((d) => insights[d.prefix]?.top_categories.length)
    .sort((a, b) =>
      Number(/categ/i.test(insights[b.prefix]?.category_field ?? "")) - Number(/categ/i.test(insights[a.prefix]?.category_field ?? "")) ||
      Number(!b.ttl_seconds) - Number(!a.ttl_seconds) ||
      (b.live_keys ?? 0) - (a.live_keys ?? 0));
  const withDate = datasets.filter((d) => insights[d.prefix]?.per_month.length);
  const [catPrefix, setCatPrefix] = useState("");
  const [datePrefix, setDatePrefix] = useState("");
  const cp = withCat.find((d) => d.prefix === catPrefix)?.prefix ?? withCat[0]?.prefix;
  const dp = withDate.find((d) => d.prefix === datePrefix)?.prefix ?? withDate[0]?.prefix;
  const ci = cp ? insights[cp] : null;
  const di = dp ? insights[dp] : null;
  const maxCount = Math.max(1, ...(ci?.top_categories.map((c) => c.count) ?? [1]));

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        icon={<BarChart3 />}
        title="Imported data"
        meta={datasets.length ? `${datasets.length} dataset${datasets.length > 1 ? "s" : ""} · aggregated from the JSON values stored in MiniRedis` : "Import a ZIP or CSV in Keys → Import dataset to chart it here"}
        right={<Source>keys · SCAN + GET</Source>}
      />
      {datasets.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-fg-3">
          No imported datasets yet. <a href="#/keys" className="text-fg-2 underline-offset-2 hover:underline">Open Keys → Import dataset</a> and try the synthetic shop ZIP.
        </div>
      ) : (
        <div className="grid divide-y divide-line xl:grid-cols-2 xl:divide-x xl:divide-y-0">
          <div className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-fg">
                Top {ci?.category_field ?? "categories"}
                {ci?.numeric_field && <span className="font-normal text-fg-3"> · avg {ci.numeric_field}</span>}
              </div>
              {withCat.length > 1 && (
                <select value={cp} onChange={(e) => setCatPrefix(e.target.value)} className="field h-7 px-2 text-xs" aria-label="Dataset for categories">
                  {withCat.map((d) => <option key={d.prefix} value={d.prefix}>{d.prefix}*</option>)}
                </select>
              )}
            </div>
            {ci ? (
              <ul className="space-y-1.5">
                {ci.top_categories.map((c) => (
                  <li key={c.value} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-xs">
                    <span className="truncate text-fg-2" title={c.value}>{c.value}</span>
                    <span className="h-2 overflow-hidden rounded-sm bg-surface-hover">
                      <span className="block h-full rounded-sm bg-[var(--chart-cache)]" style={{ width: `${(c.count / maxCount) * 100}%` }} />
                    </span>
                    <span className="num w-24 text-right text-fg">
                      {formatNumber(c.count)}
                      {c.avg != null && <span className="text-fg-3"> · {c.avg.toFixed(0)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-fg-3">No categorical field found in the imported values.</p>
            )}
            {ci && <p className="mt-3 text-[11px] text-fg-3">{formatNumber(ci.json_records)} of {formatNumber(ci.total_keys)} keys under {cp} sampled{ci.ttl_keys ? ` · ${formatNumber(ci.ttl_keys)} with TTL` : ""}.</p>}
          </div>
          <div className="p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-fg">Records per month {di?.date_field && <span className="font-normal text-fg-3">· by {di.date_field}</span>}</div>
              {withDate.length > 1 && (
                <select value={dp} onChange={(e) => setDatePrefix(e.target.value)} className="field h-7 px-2 text-xs" aria-label="Dataset for months">
                  {withDate.map((d) => <option key={d.prefix} value={d.prefix}>{d.prefix}*</option>)}
                </select>
              )}
            </div>
            {di ? (
              <TimeChart
                data={di.per_month.map((m) => ({ t: m.t, count: m.count }))}
                height={200}
                series={[{ key: "count", label: "records", kind: "bar", color: "var(--chart-cache)", format: (v) => formatNumber(v) }]}
                timeFormat={monthFmt}
              />
            ) : (
              <p className="py-8 text-center text-xs text-fg-3">No date field in the imported values. Import <span className="font-mono">orders.jsonl</span> from the synthetic ZIP to chart orders per month.</p>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
