import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { api, type Overview, type WorkloadStatus } from "./api";
import { useApp } from "./app-context";
import { formatClockMs, formatMs } from "./format";

/**
 * The crash & recover experiment, shared by the Overview and Durability tabs.
 * Living in a provider means a run keeps going (and its result stays visible)
 * when the user switches tabs. Every finished run is saved on the server as a
 * report, so "last verified recovery" and comparisons survive reloads.
 */

export type StepState = "idle" | "active" | "done" | "failed";
export interface Step {
  title: string;
  detail: string;
  state: StepState;
  at?: number;
}
export interface VCheck {
  name: string;
  before: string;
  after: string;
  beforeRaw?: string;
  afterRaw?: string;
  pass: boolean;
}
export interface Phase {
  label: string;
  hint: string;
  ms: number;
}
export interface Summary {
  downtime: number;
  firstSuccess: number;
  recovery: number;
  replayed: number;
  phases: Phase[];
  skew: boolean;
}
export interface WorkloadImpact {
  window_s: number;
  requests: number;
  served_from_cache: number;
  served_by_fallback: number;
  failed: number;
  failed_carts: number;
  p95_peak_ms: number | null;
  p95_before_ms: number | null;
  back_to_normal_ms: number | null;
  data_source?: string;
}
export interface CrashReport {
  id?: string;
  created_ms?: number;
  kind?: string;
  passed: boolean;
  downtime_ms: number;
  first_success_ms: number;
  recovery_engine_ms: number;
  replayed: number;
  phases: Phase[];
  checks: VCheck[];
  options: { concurrent_writers: number; slow_recovery_ms: number };
  load: { acked: number; recovered: number; lost: number; writers: number; persisted_without_ack: number } | null;
  environment: Record<string, string | number | null>;
  workload: WorkloadImpact | null;
  datasets?: { prefix: string; ttl: boolean; before: number; after: number; with_ttl: number; excluded: number; digest_match: boolean }[];
  log: { t: number; text: string }[];
}
export interface LogLine {
  t: number;
  text: string;
  tone?: "ok" | "warn" | "danger";
}

export const INITIAL_STEPS: Step[] = [
  { title: "Write", detail: "SET persistent · SET expiring EX 120 · fingerprint datasets", state: "idle" },
  { title: "Crash", detail: "DEBUG CRASH → os._exit(1)", state: "idle" },
  { title: "Recover", detail: "restart · load snapshot · replay AOF", state: "idle" },
  { title: "Verify", detail: "GET · PEXPIRETIME · acked writes · dataset hashes", state: "idle" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildPhases(sentMs: number, after: Overview, firstOkMs: number, dashboardMs: number): { phases: Phase[]; skew: boolean } {
  const srv = after.server ?? {};
  const P = Number(srv.process_started_ms), L = Number(srv.listening_ms), R = Number(srv.ready_ms);
  const raw = [
    { label: "Supervisor restart", hint: "old process exits → new server process forked", ms: P - sentMs },
    { label: "Process start", hint: "new process → TCP listener open", ms: L - P },
    { label: "Recovery (listening → ready)", hint: "whole startup recovery; the engine timer covers only snapshot load + replay", ms: R - L },
    { label: "First successful command", hint: "server ready → first INFO the API sees as ready (10 ms long-poll)", ms: firstOkMs - R },
    { label: "Dashboard", hint: "API observed ready → dashboard state updated", ms: dashboardMs },
  ];
  const skew = raw.some((p) => !Number.isFinite(p.ms) || p.ms < -15);
  return { phases: raw.map((p) => ({ ...p, ms: Number.isFinite(p.ms) ? Math.max(0, p.ms) : 0 })), skew };
}

/** What the simulated application's users saw between the crash and steady traffic. */
export function workloadImpact(w: WorkloadStatus, crashMs: number): WorkloadImpact | null {
  if (!w.series.length) return null;
  const crashS = Math.floor(crashMs / 1000);
  const before = w.series.filter((b) => b.t >= crashS - 10 && b.t < crashS);
  const after = w.series.filter((b) => b.t >= crashS);
  if (!after.length) return null;
  // the outage window ends at the first second with no fallbacks and no errors after the cache is back
  let endIdx = after.findIndex((b, i) => i > 0 && b.fallbacks === 0 && b.errors === 0 && b.requests > 0);
  if (endIdx < 0) endIdx = after.length - 1;
  const win = after.slice(0, endIdx + 1);
  const peak = win.map((b) => b.p95_ms ?? 0);
  const p95Before = before.map((b) => b.p95_ms ?? 0).filter((x) => x > 0);
  const upEvent = w.events.find((e) => e.kind === "cache_up" && e.t_ms >= crashMs);
  return {
    window_s: win.length,
    requests: win.reduce((a, b) => a + b.requests, 0),
    served_from_cache: win.reduce((a, b) => a + b.hits, 0),
    served_by_fallback: win.reduce((a, b) => a + b.fallbacks, 0),
    failed: win.reduce((a, b) => a + b.errors, 0),
    failed_carts: win.reduce((a, b) => a + b.errors, 0),
    p95_peak_ms: peak.length ? Math.max(...peak) : null,
    p95_before_ms: p95Before.length ? Math.round((p95Before.reduce((a, x) => a + x, 0) / p95Before.length) * 10) / 10 : null,
    back_to_normal_ms: upEvent ? upEvent.t_ms - crashMs : null,
  };
}

export function reportMarkdown(r: CrashReport): string {
  const total = r.phases.reduce((a, x) => a + x.ms, 0) || 1;
  const lines = [
    `# MiniRedis crash & recover report`,
    ``,
    `- Date: ${new Date(r.created_ms ?? Date.now()).toISOString()}`,
    ...Object.entries(r.environment).map(([k, v]) => `- ${k}: ${v ?? "—"}`),
    `- Options: ${r.options.concurrent_writers} concurrent writers · simulated slow recovery ${r.options.slow_recovery_ms} ms`,
    `- Result: **${r.passed ? "PASSED" : "FAILED"}**`,
    ``,
    `## Outcome`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Downtime (dashboard-visible) | ${formatMs(r.downtime_ms)} |`,
    `| First successful command after crash | ${formatMs(r.first_success_ms)} |`,
    `| Engine recovery timer (snapshot load + replay) | ${formatMs(r.recovery_engine_ms)} · ${r.replayed} records replayed |`,
    ...(r.load ? [`| Acknowledged writes recovered | ${r.load.recovered.toLocaleString()} / ${r.load.acked.toLocaleString()} (${r.load.lost} lost) |`] : []),
    ...(r.workload
      ? [
          ...(r.workload.data_source ? [`| Traffic data | ${r.workload.data_source} |`] : []),
          `| App requests during the outage | ${r.workload.requests} in ${r.workload.window_s} s · ${r.workload.served_by_fallback} served by fallback · ${r.workload.failed} failed |`,
          `| App p95 latency | ${r.workload.p95_before_ms ?? "—"} ms before → ${r.workload.p95_peak_ms ?? "—"} ms peak |`,
          `| Cache back for the app after | ${r.workload.back_to_normal_ms != null ? formatMs(r.workload.back_to_normal_ms) : "—"} |`,
        ]
      : []),
    ``,
    `## Downtime by phase`,
    ``,
    `| Phase | Time | Share |`,
    `|---|---:|---:|`,
    ...r.phases.map((p) => `| ${p.label} | ${formatMs(p.ms)} | ${Math.round((p.ms / total) * 100)}% |`),
    ``,
    `## Verification`,
    ``,
    `| Check | Before | After | Result |`,
    `|---|---|---|---|`,
    ...r.checks.map((c) => `| ${c.name} | ${c.before}${c.beforeRaw ? ` (${c.beforeRaw})` : ""} | ${c.after}${c.afterRaw ? ` (${c.afterRaw})` : ""} | ${c.pass ? "pass" : "FAIL"} |`),
    ``,
    `## Execution log`,
    ``,
    "```",
    ...r.log.map((l) => `+${l.t.toFixed(0).padStart(5)}ms  ${l.text}`),
    "```",
    ``,
  ];
  return lines.join("\n");
}

export function download(name: string, text: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface ExperimentState {
  steps: Step[];
  log: LogLine[];
  running: boolean;
  error: string;
  report: CrashReport | null;
  savedCount: number;
  run: (opts: { concurrentWriters: number; slowRecoveryMs: number }) => void;
}

const Ctx = createContext<ExperimentState | null>(null);

export function ExperimentProvider({ children }: { children: ReactNode }) {
  const { requireWrite, refreshOverview } = useApp();
  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS);
  const [log, setLog] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<CrashReport | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const busy = useRef(false);

  const doRun = useCallback(
    async (opts: { concurrentWriters: number; slowRecoveryMs: number }) => {
      if (busy.current) return;
      busy.current = true;
      setRunning(true);
      setError("");
      setReport(null);
      setLog([]);
      const t0 = performance.now();
      const el = () => performance.now() - t0;
      const lines: LogLine[] = [];
      const say = (text: string, tone?: LogLine["tone"]) => {
        const l = { t: el(), text, tone };
        lines.push(l);
        setLog((x) => [...x, l]);
      };
      const mark = (i: number, state: StepState) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, state, at: state === "active" ? x.at : el() } : x)));
      setSteps(INITIAL_STEPS.map((s, i) => ({ ...s, state: i === 0 ? "active" : "idle" })));
      let step = 0;
      try {
        const persistentBefore = `written ${new Date().toISOString()}`;
        await api.putKey({ key: "demo:recovery:persistent", value: persistentBefore });
        say("SET demo:recovery:persistent → OK (fsynced)");
        const exp = await api.putKey({ key: "demo:recovery:expiring", value: "deadline must not move", ttl_seconds: 120 });
        const deadlineBefore = exp.key.expire_at_ms!;
        say(`SET demo:recovery:expiring EX 120 → OK · PEXPIRETIME ${deadlineBefore}`);
        // Fingerprint imported datasets (count + SHA-256 of key/value/deadline) so the
        // same keys can be compared after the restart. Keys that expire within the next
        // 2 minutes are left out of both fingerprints (same absolute cutoff).
        const ds = (await api.datasets().catch(() => ({ datasets: [] }))).datasets.filter((d) => (d.live_keys ?? 0) > 0).slice(0, 10);
        let fpBefore: Awaited<ReturnType<typeof api.fingerprint>> | null = null;
        if (ds.length) {
          fpBefore = await api.fingerprint(ds.map((d) => d.prefix));
          for (const d of ds) {
            const f = fpBefore.fingerprints[d.prefix];
            say(`dataset ${d.prefix}* → ${f.count.toLocaleString()} keys (${f.with_ttl.toLocaleString()} with TTL) · sha256 ${f.digest.slice(0, 12)}…`);
          }
        }
        const before = await refreshOverview();
        const runId = before?.server?.run_id;
        if (!runId) throw new Error("Could not read the server's run id before the crash.");
        say(`run ${runId} · durable_seq ${before?.persistence?.durable_seq}`);
        mark(0, "done");

        step = 1;
        mark(1, "active");
        if (opts.concurrentWriters) say(`starting ${opts.concurrentWriters} concurrent writers (durable SETs) — the crash hits mid-traffic`);
        const crash = await api.crash({ concurrent_writers: opts.concurrentWriters, slow_recovery_ms: opts.slowRecoveryMs });
        say(`DEBUG CRASH${opts.slowRecoveryMs ? ` SLOW ${opts.slowRecoveryMs}` : ""} sent — process terminated without snapshot or cleanup`, "danger");
        mark(1, "done");

        step = 2;
        mark(2, "active");
        let waiting = true;
        void (async () => {
          while (waiting) {
            await refreshOverview();
            if (waiting) await sleep(250);
          }
        })();
        let w: Awaited<ReturnType<typeof api.waitReady>>;
        try {
          w = await api.waitReady(String(runId), 60);
        } finally {
          waiting = false;
        }
        const tReadyKnown = performance.now();
        for (const ph of w.phases) say(`status: ${ph.phase}  (API, +${Math.max(0, ph.at_ms - crash.sent_at_ms)} ms after crash)`, ph.phase === "offline" ? "warn" : undefined);
        const after = await refreshOverview();
        // Downtime = crash sent → first successful command (API clock, same host as the
        // database) + the dashboard's own update time (browser clock). The writers'
        // warm-up before the crash is not downtime and is excluded.
        const dashboardMs = performance.now() - tReadyKnown;
        const browserTotal = Math.max(0, w.observed_ms - crash.sent_at_ms) + dashboardMs;
        if (!after || after.server?.run_id !== w.run_id) throw new Error("The dashboard could not confirm the restarted server.");
        say(`ready · new run ${w.run_id} · engine recovery ${formatMs(after.recovery?.duration_ms)} · replayed ${after.recovery?.replayed_ops} records`, "ok");
        mark(2, "done");

        step = 3;
        mark(3, "active");
        const [p, e] = await Promise.all([api.key("demo:recovery:persistent").catch(() => null), api.key("demo:recovery:expiring").catch(() => null)]);
        let load: Awaited<ReturnType<typeof api.verifyLoad>> | null = null;
        if (crash.load_id) {
          load = await api.verifyLoad(crash.load_id);
          say(
            `concurrent writers: ${load.acked.toLocaleString()} writes acknowledged before the crash, ${load.recovered.toLocaleString()} recovered, ${load.lost} lost` +
              (load.persisted_without_ack ? ` · ${load.persisted_without_ack} more reached disk without an OK (allowed)` : ""),
            load.lost ? "danger" : "ok",
          );
        }
        const datasetRows: NonNullable<CrashReport["datasets"]> = [];
        if (fpBefore && ds.length) {
          const fpAfter = await api.fingerprint(ds.map((d) => d.prefix), fpBefore.cutoff_ms);
          for (const d of ds) {
            const b = fpBefore.fingerprints[d.prefix], a = fpAfter.fingerprints[d.prefix];
            const match = a.count === b.count && a.digest === b.digest;
            datasetRows.push({ prefix: d.prefix, ttl: !!d.ttl_seconds, before: b.count, after: a.count, with_ttl: a.with_ttl, excluded: a.excluded_expiring_soon, digest_match: match });
            say(`dataset ${d.prefix}* after restart → ${a.count.toLocaleString()} keys · sha256 ${a.digest.slice(0, 12)}… ${match ? "identical" : "DIFFERENT"}`, match ? "ok" : "danger");
          }
        }
        const ttlBound = 120000 - browserTotal + 1000;
        const checks: VCheck[] = [
          ...(load
            ? [{
                name: "Acknowledged writes recovered",
                before: `${load.acked.toLocaleString()} acknowledged by ${load.writers} concurrent writers`,
                after: `${load.recovered.toLocaleString()} present after restart · ${load.lost} lost`,
                pass: load.lost === 0 && load.acked > 0,
              }]
            : []),
          ...datasetRows.map((d) => ({
            name: `Dataset ${d.prefix}*${d.ttl ? " (TTL group)" : ""}`,
            before: `${d.before.toLocaleString()} keys${d.with_ttl ? `, ${d.with_ttl.toLocaleString()} with deadlines` : ""}`,
            after: `${d.after.toLocaleString()} keys · values + deadlines ${d.digest_match ? "identical (SHA-256)" : "differ"}`,
            pass: d.digest_match,
          })),
          { name: "Persistent value", before: persistentBefore, after: p?.value ?? "(nil)", pass: p?.value === persistentBefore },
          {
            name: "Expiry deadline",
            before: formatClockMs(deadlineBefore),
            after: e?.expire_at_ms != null ? formatClockMs(e.expire_at_ms) : "(missing)",
            beforeRaw: `${deadlineBefore} ms`,
            afterRaw: e?.expire_at_ms != null ? `${e.expire_at_ms} ms` : undefined,
            pass: e?.expire_at_ms === deadlineBefore,
          },
          {
            name: "TTL kept counting",
            before: `≤ ${(ttlBound / 1000).toFixed(1)} s left (120 s − downtime)`,
            after: e?.ttl_ms != null ? `${(e.ttl_ms / 1000).toFixed(1)} s left` : "(missing)",
            pass: e?.ttl_ms != null && e.ttl_ms <= ttlBound,
          },
        ];
        const { phases, skew } = buildPhases(crash.sent_at_ms, after, w.observed_ms, dashboardMs);
        const passed = checks.every((x) => x.pass);
        const dominant = [...phases].sort((a, b) => b.ms - a.ms)[0];
        say(`downtime ${formatMs(browserTotal)} · largest phase: ${dominant.label} (${formatMs(dominant.ms)})`);
        say(passed ? "all checks passed" : "verification mismatch", passed ? "ok" : "danger");
        mark(3, passed ? "done" : "failed");

        const rep: CrashReport = {
          passed,
          downtime_ms: Math.round(browserTotal),
          first_success_ms: Math.max(0, w.observed_ms - crash.sent_at_ms),
          recovery_engine_ms: after.recovery?.duration_ms ?? 0,
          replayed: after.recovery?.replayed_ops ?? 0,
          phases,
          checks,
          options: { concurrent_writers: opts.concurrentWriters, slow_recovery_ms: opts.slowRecoveryMs },
          load: load ? { acked: load.acked, recovered: load.recovered, lost: load.lost, writers: load.writers, persisted_without_ack: load.persisted_without_ack } : null,
          environment: {
            instance: after.instance?.name ?? null,
            database: after.instance ? `${after.instance.host}:${after.instance.port}` : null,
            durability: `appendfsync=${after.persistence?.appendfsync ?? "?"}`,
            keys: after.keyspace?.keys ?? null,
            dataset_bytes: Number(after.memory?.used_memory_dataset ?? 0),
            server_version: String(after.server?.miniredis_version ?? ""),
            browser: navigator.userAgent.split(") ")[0] + ")",
            phase_timing_skew: skew ? "yes" : "no",
          },
          workload: null,
          datasets: datasetRows,
          log: [],
        };
        setReport({ ...rep, log: lines.map(({ t, text }) => ({ t, text })) });

        // If sample traffic is running, measure what its users saw.
        const wl = await api.workload().catch(() => null);
        if (wl?.running) {
          say("measuring application impact (waiting 3 s of steady traffic)…");
          await sleep(3200);
          const wl2 = await api.workload().catch(() => null);
          rep.workload = wl2 ? workloadImpact(wl2, crash.sent_at_ms) : null;
          if (rep.workload && wl2)
            rep.workload.data_source = wl2.dataset_prefix
              ? `${wl2.dataset_prefix}* (${wl2.dataset_keys} products)${wl2.orders_prefix ? ` + ${wl2.orders_prefix}* (${wl2.order_keys} orders)` : ""}`
              : "synthetic shop:* catalog";
          if (rep.workload)
            say(`app during the outage: ${rep.workload.requests} requests · ${rep.workload.served_by_fallback} served by fallback · ${rep.workload.failed} failed · p95 peak ${rep.workload.p95_peak_ms ?? "—"} ms`,
              rep.workload.failed ? "warn" : "ok");
        }
        rep.log = lines.map(({ t, text }) => ({ t, text }));
        try {
          const saved = await api.saveReport("crash_lab", rep as unknown as Record<string, unknown>);
          setReport({ ...rep, id: saved.id, created_ms: saved.created_ms });
          setSavedCount((n) => n + 1);
        } catch {
          setReport(rep);
          say("could not save the report on the server (it is still downloadable)", "warn");
        }
      } catch (err) {
        mark(step, "failed");
        setError((err as Error).message);
        say((err as Error).message, "danger");
      } finally {
        busy.current = false;
        setRunning(false);
      }
    },
    [refreshOverview],
  );

  const run = useCallback(
    (opts: { concurrentWriters: number; slowRecoveryMs: number }) => requireWrite("run the crash experiment", () => doRun(opts)),
    [requireWrite, doRun],
  );

  return <Ctx.Provider value={{ steps, log, running, error, report, savedCount, run }}>{children}</Ctx.Provider>;
}

export function useExperiment() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useExperiment outside provider");
  return c;
}
