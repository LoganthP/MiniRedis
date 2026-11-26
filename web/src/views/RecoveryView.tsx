import { motion } from "motion/react";
import {
  AlertOctagon, Camera, Check, ChevronDown, Copy, Download, FileStack, FlaskConical, Gauge, GitCompare, History, Loader2, RotateCcw, ScrollText, ShieldCheck, X, Zap,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { api, type AofRecord, type RecoveryReport, type RestoreCheck } from "../lib/api";
import { useApp, useNow } from "../lib/app-context";
import { download, reportMarkdown, useExperiment, type CrashReport, type StepState, type VCheck } from "../lib/experiment";
import { formatBytes, formatClock, formatDuration, formatMs, formatNumber, timeAgo } from "../lib/format";
import { ReadGate } from "../components/Shell";
import { Button, KpiStrip, Panel, PanelHeader, Row, Segmented, Tag, cx, useToast } from "../components/ui";
import { WireBytes } from "../components/Json";

function n2(v: unknown) {
  const x = Number(v ?? 0);
  return x < 10 ? x.toFixed(2) : x.toFixed(1);
}

const PRELIM_N = 100;

/** Percentiles with their sample count; never shows 0.00 ms for an empty window. */
function Pct({ stats, kind, n, ps = [50, 95, 99] }: { stats?: Record<string, number>; kind: string; n: number; ps?: number[] }) {
  if (!n) return <span className="text-fg-3">no samples yet</span>;
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span>{ps.map((p) => n2(stats?.[`${kind}_latency_p${p}_ms`])).join(" · ")} ms</span>
      <span className="text-[10px] text-fg-3">n={n.toLocaleString()}</span>
      {n < PRELIM_N && <span className="rounded border border-warn/40 px-1 text-[9px] uppercase text-warn" title={`Fewer than ${PRELIM_N} samples: treat as preliminary`}>prelim.</span>}
    </span>
  );
}

export function RecoveryView() {
  const { overview, status } = useApp();
  const exp = useExperiment();
  const [reports, setReports] = useState<CrashReport[]>([]);
  const [restores, setRestores] = useState<RestoreCheck[]>([]);
  const { canRead, session } = useApp();

  const load = useCallback(async () => {
    try {
      const r = await api.reports("crash_lab");
      setReports(r.reports as unknown as CrashReport[]);
    } catch {
      /* private reads or offline */
    }
    try {
      setRestores((await api.restores()).restores);
    } catch {
      /* offline */
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, exp.savedCount, canRead]);

  const last = reports[0];
  const lastRestore = restores[0];
  const statusText = { ready: "text-ok", recovering: "text-warn", starting: "text-warn", degraded: "text-danger", offline: "text-fg-2" }[status];

  return (
    <div className="space-y-4">
      <KpiStrip
        items={[
          { label: "Database", value: <span className={cx("capitalize", statusText)}>{status}</span>, hint: `uptime ${formatDuration(Number(overview?.server?.uptime_in_seconds ?? 0))}` },
          { label: "Last downtime", value: last ? formatMs(last.downtime_ms) : "—", hint: last ? `crash test ${timeAgo(last.created_ms)}` : "run the crash lab" },
          { label: "First request after crash", value: last ? formatMs(last.first_success_ms) : "—", hint: "crash → first successful command" },
          {
            label: "Acked writes recovered",
            value: last?.load ? <span className={last.load.lost ? "text-danger" : "text-ok"}>{last.load.recovered.toLocaleString()} / {last.load.acked.toLocaleString()}</span> : "—",
            hint: last?.load ? `${last.load.lost} lost · ${last.load.writers} writers` : "enable concurrent writes",
          },
          {
            label: "Expiry deadlines",
            value: last ? (last.checks.filter((c) => /Expiry|TTL/.test(c.name)).every((c) => c.pass) ? <span className="text-ok">preserved</span> : <span className="text-danger">changed</span>) : "—",
            hint: "absolute deadline + countdown",
          },
          {
            label: "Last verified restore",
            value: lastRestore ? <span className={lastRestore.ok ? "text-ok" : "text-danger"}>{lastRestore.ok ? "passed" : "failed"}</span> : "—",
            hint: lastRestore ? `${timeAgo(lastRestore.at_ms)} · ${lastRestore.keys?.toLocaleString() ?? "?"} keys` : "scripts/verify-backup.sh",
          },
        ]}
      />

      <ChaosLab />

      {session && !canRead ? (
        <Panel><ReadGate what="saved crash reports" /></Panel>
      ) : (
        <SavedRuns reports={reports} />
      )}

      <RestoreChecks restores={restores} />

      <details className="group rounded-[10px] border border-line bg-surface">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[13px] font-medium">
          <span className="flex items-center gap-2.5">
            <ChevronDown className="size-4 text-fg-3 transition-transform group-open:rotate-180" />
            Engine details — log, snapshots, latency, startup history, wire log
          </span>
          <span className="text-xs text-fg-3">for engineers</span>
        </summary>
        <div className="space-y-4 border-t border-line p-4">
          <EngineDetails />
        </div>
      </details>
    </div>
  );
}

function SavedRuns({ reports }: { reports: CrashReport[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const a = reports.find((r) => r.id === picked[0]);
  const b = reports.find((r) => r.id === picked[1]);
  const exportCsv = () => {
    const cols = ["created", "passed", "downtime_ms", "first_success_ms", "recovery_engine_ms", "replayed", "keys", "writers", "acked", "lost", "app_requests_in_outage", "app_fallbacks", "app_failed", "slow_recovery_ms"];
    const rows = reports.map((r) => [
      new Date(r.created_ms ?? 0).toISOString(), r.passed, r.downtime_ms, r.first_success_ms, r.recovery_engine_ms, r.replayed, r.environment?.keys ?? "",
      r.load?.writers ?? 0, r.load?.acked ?? "", r.load?.lost ?? "", r.workload?.requests ?? "", r.workload?.served_by_fallback ?? "", r.workload?.failed ?? "", r.options?.slow_recovery_ms ?? 0,
    ]);
    download("miniredis-crash-runs.csv", [cols, ...rows].map((r) => r.join(",")).join("\n"), "text/csv");
  };
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        icon={<History />}
        title="Saved crash runs"
        meta="Stored on the server · tick two to compare"
        right={reports.length > 0 && <Button size="sm" variant="secondary" onClick={exportCsv} icon={<Download />}>Export CSV</Button>}
      />
      {picked.length === 2 && a && b && <ReportCompare a={a} b={b} onClear={() => setPicked([])} />}
      <div className="max-h-80 overflow-auto">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-fg-3">
              <th className="w-8 py-2 pl-4"><span className="sr-only">Compare</span></th>
              <th className="px-2 py-2 font-medium">When</th>
              <th className="px-2 py-2 font-medium">Result</th>
              <th className="px-2 py-2 text-right font-medium">Downtime</th>
              <th className="px-2 py-2 text-right font-medium">First request</th>
              <th className="px-2 py-2 text-right font-medium">Acked / lost</th>
              <th className="px-2 py-2 text-right font-medium">App failed / fallback</th>
              <th className="px-2 py-2 text-right font-medium">Keys</th>
              <th className="px-4 py-2 text-right font-medium">Report</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id} className={cx("border-b border-line/70", picked.includes(r.id!) && "bg-surface-hover")}>
                <td className="py-2 pl-4">
                  <input type="checkbox" aria-label={`Compare run from ${formatClock(r.created_ms)}`} className="accent-[var(--accent-primary)]"
                    checked={picked.includes(r.id!)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id!].slice(-2) : p.filter((x) => x !== r.id)))} />
                </td>
                <td className="num px-2 text-fg-2">{formatClock(r.created_ms)}</td>
                <td className="px-2">{r.passed ? <Tag tone="ok">passed</Tag> : <Tag tone="danger">failed</Tag>}{r.options?.slow_recovery_ms ? <Tag className="ml-1">slow</Tag> : null}</td>
                <td className="num px-2 text-right text-fg">{formatMs(r.downtime_ms)}</td>
                <td className="num px-2 text-right text-fg-2">{formatMs(r.first_success_ms)}</td>
                <td className="num px-2 text-right text-fg-2">{r.load ? `${r.load.acked.toLocaleString()} / ${r.load.lost}` : "—"}</td>
                <td className="num px-2 text-right text-fg-2">{r.workload ? `${r.workload.failed} / ${r.workload.served_by_fallback}` : "—"}</td>
                <td className="num px-2 text-right text-fg-2">{formatNumber(Number(r.environment?.keys ?? 0))}</td>
                <td className="px-4 text-right">
                  <button className="text-fg-3 hover:text-fg" onClick={() => download(`miniredis-crash-report-${r.id}.md`, reportMarkdown(r))} aria-label="Download report">
                    <Download className="inline size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {!reports.length && <tr><td colSpan={9} className="px-4 py-6 text-center text-fg-3">No saved runs yet. Run the crash lab above; every run is saved here.</td></tr>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ReportCompare({ a, b, onClear }: { a: CrashReport; b: CrashReport; onClear: () => void }) {
  const [older, newer] = (a.created_ms ?? 0) < (b.created_ms ?? 0) ? [a, b] : [b, a];
  const rows: [string, (r: CrashReport) => number | null | undefined, (v: number) => string, boolean][] = [
    ["Downtime", (r) => r.downtime_ms, formatMs, true],
    ["First successful command", (r) => r.first_success_ms, formatMs, true],
    ["Engine recovery timer", (r) => r.recovery_engine_ms, formatMs, true],
    ["Records replayed", (r) => r.replayed, formatNumber, false],
    ["Keys in dataset", (r) => Number(r.environment?.keys ?? 0), formatNumber, false],
    ["Acked writes", (r) => r.load?.acked, formatNumber, false],
    ["Acked writes lost", (r) => r.load?.lost, formatNumber, true],
    ["App requests failed", (r) => r.workload?.failed, formatNumber, true],
    ["App requests via fallback", (r) => r.workload?.served_by_fallback, formatNumber, true],
    ["App p95 peak", (r) => r.workload?.p95_peak_ms, formatMs, true],
  ];
  return (
    <div className="border-b border-line bg-canvas px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-medium text-fg-2"><GitCompare className="size-3.5" /> {formatClock(older.created_ms)} → {formatClock(newer.created_ms)}</span>
        <button onClick={onClear} className="text-[11px] text-fg-3 hover:text-fg">clear</button>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-fg-3">
            <th className="py-1 text-left font-medium" /><th className="py-1 text-right font-medium">Earlier</th><th className="py-1 text-right font-medium">Later</th><th className="py-1 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-line/60">
            <td className="py-1.5 text-fg-3">Result</td>
            <td className="py-1.5 text-right">{older.passed ? <Tag tone="ok">passed</Tag> : <Tag tone="danger">failed</Tag>}</td>
            <td className="py-1.5 text-right">{newer.passed ? <Tag tone="ok">passed</Tag> : <Tag tone="danger">failed</Tag>}</td>
            <td />
          </tr>
          {rows.map(([label, get, fmt, lowerIsBetter]) => {
            const x = get(older), y = get(newer);
            const d = x != null && y != null ? y - x : null;
            const better = d == null || d === 0 ? null : lowerIsBetter ? d < 0 : d > 0;
            return (
              <tr key={label} className="border-t border-line/60">
                <td className="py-1.5 text-fg-3">{label}</td>
                <td className="num py-1.5 text-right text-fg-2">{x != null ? fmt(x) : "—"}</td>
                <td className="num py-1.5 text-right text-fg">{y != null ? fmt(y) : "—"}</td>
                <td className={cx("num w-24 py-1.5 text-right", better === null ? "text-fg-3" : better ? "text-ok" : "text-danger")}>
                  {d == null ? "" : d === 0 ? "=" : `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RestoreChecks({ restores }: { restores: RestoreCheck[] }) {
  return (
    <Panel className="overflow-hidden">
      <PanelHeader icon={<ShieldCheck />} title="Restore verifications" meta="Backups restored into a fresh directory and compared with the live data (scripts/verify-backup.sh)" />
      {restores.length ? (
        <table className="w-full text-left text-xs">
          <tbody>
            {restores.slice(0, 8).map((r, i) => (
              <tr key={i} className="border-b border-line/70 last:border-0">
                <td className="num px-4 py-2 text-fg-2">{formatClock(r.at_ms)}</td>
                <td className="px-2">{r.ok ? <Tag tone="ok">passed</Tag> : <Tag tone="danger">failed</Tag>}</td>
                <td className="truncate px-2 font-mono text-fg-2">{r.backup}</td>
                <td className="num px-2 text-right text-fg-2">{r.keys != null ? `${r.keys.toLocaleString()} keys · ${r.with_ttl ?? 0} with TTL` : r.error}</td>
                <td className="num px-4 text-right text-fg-2">{r.sampled != null ? `${r.identical}/${r.sampled} sampled identical` : "not compared"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-4 py-5 text-xs text-fg-3">
          None recorded yet. On the server run <code className="font-mono text-fg-2">scripts/backup.sh</code> then <code className="font-mono text-fg-2">scripts/verify-backup.sh backups/&lt;file&gt;</code>.
        </p>
      )}
    </Panel>
  );
}

function EngineDetails() {
  const { overview, isReady, requireWrite, refreshOverview } = useApp();
  const toast = useToast();
  const now = useNow(1000);
  const [history, setHistory] = useState<RecoveryReport[]>([]);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<number[]>([]); // started_at_ms of runs to compare

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await api.history()).history);
    } catch {
      /* offline: keep last list */
    }
  }, []);

  const stamp = overview?.recovery?.started_at_ms;
  useEffect(() => {
    loadHistory();
  }, [loadHistory, stamp]);

  const p = overview?.persistence ?? {};
  const r = overview?.recovery;

  const snapshot = () => requireWrite("take a snapshot", doSnapshot);
  const doSnapshot = async () => {
    setSaving(true);
    try {
      const res = await api.snapshot();
      toast("success", `SAVE → OK in ${formatMs(res.duration_ms)} · older segments removed`);
      refreshOverview();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const total = (r?.snapshot_keys ?? 0) + (r?.replayed_ops ?? 0);
  const snapPct = total ? ((r?.snapshot_keys ?? 0) / total) * 100 : 0;
  return (
    <div className="space-y-4">

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Panel>
          <PanelHeader icon={<RotateCcw />} title="Last startup recovery" meta={r ? `${formatNumber(r.keys_after)} keys rebuilt` : "—"} />
          <div className="p-4">
            {!r ? (
              <div className="space-y-2"><div className="skeleton h-4" /><div className="skeleton h-4" /><div className="skeleton h-4 w-2/3" /></div>
            ) : !r.ok ? (
              <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-[13px]">
                <div className="flex items-center gap-2 font-medium text-danger"><AlertOctagon className="size-4" /> Recovery halted</div>
                <p className="mt-1.5 font-mono text-xs text-fg-2">{r.error}</p>
                <p className="mt-2 text-xs text-fg-3">The server refuses to serve a partial dataset. Restore a backup or inspect the data directory, then restart.</p>
              </div>
            ) : (
              <>
                <div className="mb-1.5 flex justify-between text-[11px] text-fg-3">
                  <span>snapshot <span className="num text-fg-2">{formatNumber(r.snapshot_keys)}</span></span>
                  <span>log replay <span className="num text-fg-2">{formatNumber(r.replayed_ops)}</span></span>
                </div>
                <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-hover">
                  <div className="bg-fg-2" style={{ width: `${snapPct}%` }} />
                  <div className="bg-accent" style={{ width: `${total ? 100 - snapPct : 0}%` }} />
                </div>
                <div className="mt-3">
                  <Row label="Duration">{formatMs(r.duration_ms)}</Row>
                  <Row label="Snapshot seq">{formatNumber(r.snapshot_seq)}</Row>
                  <Row label="Last seq">{formatNumber(r.last_seq)}</Row>
                  <Row label="Skipped (≤ snapshot)">{formatNumber(r.skipped_ops)}</Row>
                  <Row label="Expired on load">{formatNumber(r.expired_dropped)}</Row>
                </div>
                {r.notes.length > 0 && (
                  <ul className="mt-3 space-y-1 rounded-lg border border-warn/30 bg-warn/5 p-2.5 font-mono text-[11px] text-warn">
                    {r.notes.map((n) => <li key={n}>{n}</li>)}
                  </ul>
                )}
              </>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader icon={<FileStack />} title="Append-only log" meta="CRC32-framed effect records" right={<Tag>{String(p.appendfsync ?? "—")}</Tag>} />
          <div className="px-4 py-2">
            <Row label="Size on disk">{formatBytes(Number(p.aof_size_bytes ?? 0))}</Row>
            <Row label="Segments">{formatNumber(Number(p.aof_segments ?? 0))}</Row>
            <Row label="Durable seq">{formatNumber(Number(p.durable_seq ?? 0))}</Row>
            <Row label="Ops since snapshot">{formatNumber(Number(p.ops_since_snapshot ?? 0))}</Row>
            <Row label="Writes acknowledged">{formatNumber(Number(overview?.stats?.total_writes ?? 0))}</Row>
            <Row label="Ops / sec">{formatNumber(Number(overview?.stats?.instantaneous_ops_per_sec ?? 0))}</Row>
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            icon={<Camera />}
            title="Snapshot"
            meta={`every ${formatNumber(Number(p.snapshot_every_ops ?? 0))} ops or ${formatNumber(Number(p.snapshot_every_seconds ?? 0))} s`}
            right={<Button size="sm" variant="secondary" onClick={snapshot} loading={saving} disabled={!isReady} icon={<Camera />}>SAVE</Button>}
          />
          <div className="px-4 py-2">
            <Row label="Last saved">{Number(p.last_save_time) ? timeAgo(Number(p.last_save_time) * 1000) : "never"}</Row>
            <Row label="Duration">{formatMs(Number(p.last_save_duration_ms ?? 0))}</Row>
            <Row label="Size">{formatBytes(Number(p.last_save_bytes ?? 0))}</Row>
            <Row label="Snapshot seq">{formatNumber(Number(p.snapshot_seq ?? 0))}</Row>
            <Row label="Taken this run">{formatNumber(Number(p.snapshots_taken ?? 0))}</Row>
            <Row label="Status">
              <span className={p.last_save_status === "err" ? "text-danger" : p.last_save_status === "ok" ? "text-ok" : "text-fg-3"}>{String(p.last_save_status ?? "—")}</span>
            </Row>
          </div>
        </Panel>

        <Panel>
          <PanelHeader icon={<Gauge />} title="Performance" meta={`server-side · last ${formatNumber(Number(overview?.stats?.latency_samples_read ?? 0) + Number(overview?.stats?.latency_samples_write ?? 0))} cmds since start`} />
          <div className="px-4 py-2">
            <Row label="Read p50·95·99"><Pct stats={overview?.stats} kind="read" n={Number(overview?.stats?.latency_samples_read ?? 0)} /></Row>
            <Row label="Write ack p50·95·99"><Pct stats={overview?.stats} kind="write" n={Number(overview?.stats?.latency_samples_write ?? 0)} /></Row>
            <Row label="Disk sync p50·95"><Pct stats={overview?.stats} kind="log_batch" n={Number(overview?.stats?.latency_samples_log_batch ?? 0)} ps={[50, 95]} /></Row>
            <Row label="Writes / disk sync">{Number(overview?.stats?.latency_samples_log_batch ?? 0) ? n2(overview?.stats?.log_batch_avg_writes) : <span className="text-fg-3">—</span>}</Row>
            <Row label="Queue now / max">{`${formatNumber(Number(p.write_queue_depth ?? 0))} / ${formatNumber(Number(p.write_queue_depth_max ?? 0))}`}</Row>
            <Row label="Ops/s (1 s window)">{formatNumber(Number(overview?.stats?.instantaneous_ops_per_sec ?? 0))}</Row>
            <Row label="Since last snapshot">{Number(p.last_save_time) ? formatDuration(Math.max(0, Math.round(now / 1000 - Number(p.last_save_time)))) : "never"}</Row>
          </div>
        </Panel>
      </div>


      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel className="overflow-hidden">
          <PanelHeader icon={<History />} title="Startup history" meta="Tick two runs to compare them" right={<span className="num text-xs text-fg-3">{history.length}</span>} />
          {picked.length === 2 && <RunCompare a={history.find((h) => h.started_at_ms === picked[0])} b={history.find((h) => h.started_at_ms === picked[1])} onClear={() => setPicked([])} />}
          <div className="max-h-80 overflow-auto">
            <table className="w-full min-w-[600px] text-left text-xs">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-line text-[11px] uppercase tracking-wider text-fg-3">
                  <th className="w-8 py-2 pl-4"><span className="sr-only">Compare</span></th>
                  <th className="px-2 py-2 font-medium">Started</th>
                  <th className="px-2 py-2 font-medium">Result</th>
                  <th className="px-2 py-2 text-right font-medium">Recovery</th>
                  <th className="px-2 py-2 text-right font-medium">Start→ready</th>
                  <th className="px-2 py-2 text-right font-medium">Keys</th>
                  <th className="px-2 py-2 text-right font-medium">Snapshot</th>
                  <th className="px-4 py-2 text-right font-medium">Replayed</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 30).map((h, i) => (
                  <tr key={`${h.started_at_ms}-${i}`} className={cx("border-b border-line/70", picked.includes(h.started_at_ms) && "bg-surface-hover")}>
                    <td className="py-2 pl-4">
                      <input
                        type="checkbox"
                        aria-label={`Compare run from ${formatClock(h.started_at_ms)}`}
                        className="accent-[var(--accent-primary)]"
                        checked={picked.includes(h.started_at_ms)}
                        onChange={(e) =>
                          setPicked((p) => (e.target.checked ? [...p, h.started_at_ms].slice(-2) : p.filter((x) => x !== h.started_at_ms)))
                        }
                      />
                    </td>
                    <td className="num px-2 py-2 text-fg-2">{formatClock(h.started_at_ms)}{i === 0 && <span className="ml-2 text-accent">●</span>}</td>
                    <td className="px-2">{h.ok ? <Tag tone="ok">ok</Tag> : <Tag tone="danger" className="max-w-40 truncate" >failed</Tag>}</td>
                    <td className="num px-2 text-right text-fg">{h.ok ? formatMs(h.duration_ms) : "—"}</td>
                    <td className="num px-2 text-right text-fg-2">{h.startup_ms != null ? formatMs(h.startup_ms) : "—"}</td>
                    <td className="num px-2 text-right text-fg-2">{formatNumber(h.keys_after)}</td>
                    <td className="num px-2 text-right text-fg-2">{formatNumber(h.snapshot_keys)}</td>
                    <td className="num px-4 text-right text-fg-2">{formatNumber(h.replayed_ops)}{h.truncated_bytes > 0 && <span className="ml-1 text-warn">+tail</span>}</td>
                  </tr>
                ))}
                {!history.length && (
                  <tr><td colSpan={8} className="px-4 py-6 text-center text-fg-3">No startups recorded yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel>
          <PanelHeader icon={<ShieldCheck />} title="Durability guarantees" />
          <ol className="divide-y divide-line/70">
            {[
              ["Serialized write path", "Every mutation is ordered through one writer and framed as length · CRC32 · RESP payload."],
              ["Ack after fsync", `appendfsync=${String(p.appendfsync ?? "—")}: OK is sent only after the record is synced. Concurrent writers share one fsync.`],
              ["Absolute deadlines", "EXPIRE is logged as PEXPIREAT <unix-ms>, so downtime counts against the TTL."],
              ["Snapshot + tail replay", "Snapshots rotate the log. Startup loads the snapshot, replays newer records, drops a torn final record, halts on mid-log corruption."],
              ["Fail closed on disk errors", "A failed write rolls back in memory, returns MISCONF and switches the node to read-only."],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-3 px-4 py-2.5">
                <span className="num mt-px text-xs text-fg-3">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-[13px]">
                  <span className="font-medium text-fg">{t}</span>
                  <span className="block text-xs text-fg-3">{d}</span>
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}

function RunCompare({ a, b, onClear }: { a?: RecoveryReport; b?: RecoveryReport; onClear: () => void }) {
  if (!a || !b) return null;
  const [older, newer] = a.started_at_ms < b.started_at_ms ? [a, b] : [b, a];
  const rows: [string, (r: RecoveryReport) => number | undefined, (v: number) => string][] = [
    ["Keys after recovery", (r) => r.keys_after, formatNumber],
    ["Snapshot keys", (r) => r.snapshot_keys, formatNumber],
    ["Records replayed", (r) => r.replayed_ops, formatNumber],
    ["Torn tail", (r) => r.truncated_bytes, formatBytes],
    ["Engine recovery", (r) => r.duration_ms, formatMs],
    ["Process start → ready", (r) => r.startup_ms, formatMs],
  ];
  return (
    <div className="border-b border-line bg-canvas px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-medium text-fg-2"><GitCompare className="size-3.5" /> {formatClock(older.started_at_ms)} → {formatClock(newer.started_at_ms)}</span>
        <button onClick={onClear} className="text-[11px] text-fg-3 hover:text-fg">clear</button>
      </div>
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([label, get, fmt]) => {
            const x = get(older), y = get(newer);
            const d = x != null && y != null ? y - x : null;
            return (
              <tr key={label} className="border-t border-line/60">
                <td className="py-1.5 text-fg-3">{label}</td>
                <td className="num py-1.5 text-right text-fg-2">{x != null ? fmt(x) : "—"}</td>
                <td className="num py-1.5 text-right text-fg">{y != null ? fmt(y) : "—"}</td>
                <td className={cx("num w-24 py-1.5 text-right", d == null || d === 0 ? "text-fg-3" : "text-fg-2")}>
                  {d == null ? "" : d === 0 ? "=" : `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ====================================================================== Chaos lab */

const PHASE_SHADES = ["bg-fg-3", "bg-fg-2", "bg-accent", "bg-[var(--syntax-literal)]", "bg-line-strong"];

function ChaosLab() {
  const { canWrite, session, isReady } = useApp();
  const exp = useExperiment();
  const [withLoad, setWithLoad] = useState(true);
  const [slow, setSlow] = useState(false);
  const [wireOpen, setWireOpen] = useState(false);
  const enabled = session?.crash_demo_enabled !== false;
  const r = exp.report;
  const allPass = r?.passed;
  useEffect(() => {
    if (r) setWireOpen(true);
  }, [r?.id]);

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        icon={<FlaskConical />}
        title="Crash lab · does your data survive?"
        meta="Kills the database mid-traffic, waits for it to recover, then verifies values, deadlines and every acknowledged write"
        right={
          <Button variant="primary" onClick={() => exp.run({ concurrentWriters: withLoad ? 8 : 0, slowRecoveryMs: slow ? 3000 : 0 })}
            loading={exp.running} disabled={!enabled || (!isReady && !exp.running)} icon={<Zap />}>
            {exp.running ? "Running" : r || exp.error ? "Run again" : "Run experiment"}
          </Button>
        }
      />
      <div className="border-b border-line px-4 py-5">
        <ol className="grid grid-cols-1 gap-3 md:grid-cols-4 md:gap-0">
          {exp.steps.map((s, i) => (
            <li key={s.title} className="relative flex items-start gap-3 md:flex-col md:items-stretch md:gap-2 md:pr-4">
              <div className="flex items-center md:w-full">
                <StepDot state={s.state} n={i + 1} />
                {i < exp.steps.length - 1 && (
                  <div className="ml-2 hidden h-px flex-1 bg-line md:block">
                    <motion.div className={cx("h-px", s.state === "failed" ? "bg-danger" : "bg-ok/70")} initial={false} animate={{ width: s.state === "done" ? "100%" : "0%" }} transition={{ duration: 0.3 }} />
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className={cx("text-[13px] font-medium", s.state === "idle" ? "text-fg-3" : "text-fg")}>{s.title}</span>
                  <span className={cx("num text-[11px]", s.at != null && s.state !== "active" ? "text-fg-2" : "text-fg-3")}>
                    {s.at != null && s.state !== "active" ? `+${Math.round(s.at)} ms` : s.state === "active" ? "running…" : "—"}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-fg-3">{s.detail}</div>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-fg-2">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={withLoad} onChange={(e) => setWithLoad(e.target.checked)} disabled={exp.running} className="accent-[var(--accent-primary)]" />
            Crash during concurrent durable writes (8 writers)
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} disabled={exp.running} className="accent-[var(--accent-primary)]" />
            Simulate a slow recovery (3 s in "recovering")
          </label>
        </div>
        {!canWrite && enabled && <p className="mt-3 text-xs text-fg-3">Sign in to run — the experiment writes demo:recovery:* and lab:load:* keys and kills the database process.</p>}
        {!enabled && <p className="mt-3 text-xs text-fg-3">Disabled on this deployment (ALLOW_CRASH_DEMO=false). Run it on a disposable demo instance instead.</p>}
      </div>

      {(exp.log.length > 0 || r) && (
        <div className="grid gap-0 border-b border-line lg:grid-cols-2">
          <div className="border-b border-line bg-canvas px-4 py-3 font-mono text-xs leading-relaxed lg:border-b-0 lg:border-r">
            <div className="mb-1.5 font-sans text-[11px] font-medium uppercase tracking-wider text-fg-3">Execution log</div>
            {exp.log.map((l, i) => (
              <div key={i} className="flex gap-3">
                <span className="num w-20 shrink-0 text-right text-fg-3">+{l.t.toFixed(0)}ms</span>
                <span className={cx("break-all", l.tone === "ok" ? "text-ok" : l.tone === "warn" ? "text-warn" : l.tone === "danger" ? "text-danger" : "text-fg-2")}>{l.text}</span>
              </div>
            ))}
            {exp.running && <Loader2 className="ml-[92px] mt-1 size-3 animate-spin text-fg-3" />}
          </div>
          <div className="px-4 py-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-fg-3">Verification</span>
              {r && <Tag tone={allPass ? "ok" : "danger"}>{allPass ? "passed" : "failed"}</Tag>}
            </div>
            {r ? (
              <div className="space-y-2">{r.checks.map((c) => <CheckRow key={c.name} c={c} />)}</div>
            ) : exp.error ? (
              <p className="text-[13px] text-danger">{exp.error}</p>
            ) : (
              <p className="text-xs text-fg-3">Waiting for the server to come back…</p>
            )}
            {r?.workload && (
              <div className="mt-3 rounded-lg border border-line p-3 text-xs">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-fg-3">Sample app during the outage</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div><div className="text-fg-3">Requests</div><div className="num text-sm text-fg">{r.workload.requests}</div></div>
                  <div><div className="text-fg-3">Via fallback</div><div className="num text-sm text-warn">{r.workload.served_by_fallback}</div></div>
                  <div><div className="text-fg-3">Failed (carts)</div><div className={cx("num text-sm", r.workload.failed ? "text-danger" : "text-fg")}>{r.workload.failed}</div></div>
                  <div><div className="text-fg-3">p95 before → peak</div><div className="num text-sm text-fg">{r.workload.p95_before_ms ?? "—"} → {r.workload.p95_peak_ms ?? "—"} ms</div></div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {r && <DowntimeBreakdown r={r} />}

      <WireLog open={wireOpen} onToggle={() => setWireOpen((o) => !o)} />
    </Panel>
  );
}

function DowntimeBreakdown({ r }: { r: CrashReport }) {
  const total = r.phases.reduce((a, p) => a + p.ms, 0) || 1;
  const dominant = r.phases.reduce((a, p) => (p.ms > a.ms ? p : a), r.phases[0]);
  return (
    <div className="border-b border-line px-4 py-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-fg-3">Where the downtime went</div>
          <div className="mt-0.5 text-xs text-fg-3">
            End-to-end <span className="num text-fg">{formatMs(r.downtime_ms)}</span> · first successful command <span className="num text-fg">{formatMs(r.first_success_ms)}</span> ·
            engine timer (snapshot load + replay only) <span className="num text-fg">{formatMs(r.recovery_engine_ms)}</span> · replayed <span className="num text-fg">{formatNumber(r.replayed)}</span> · largest phase <span className="text-fg">{dominant.label}</span>
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => download(`miniredis-crash-report-${r.id ?? Date.now()}.md`, reportMarkdown(r))} icon={<Download />}>Download report</Button>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-hover">
        {r.phases.map((p, i) => (
          <div key={p.label} className={cx(PHASE_SHADES[i], "border-r border-canvas last:border-0")} style={{ width: `${(p.ms / total) * 100}%` }} title={`${p.label}: ${formatMs(p.ms)}`} />
        ))}
      </div>
      <table className="mt-3 w-full text-left text-xs">
        <tbody>
          {r.phases.map((p, i) => (
            <tr key={p.label} className="border-b border-line/60 last:border-0">
              <td className="py-1.5 pr-3"><span className={cx("inline-block size-2 rounded-sm", PHASE_SHADES[i])} /></td>
              <td className={cx("py-1.5 pr-3", p === dominant ? "text-fg" : "text-fg-2")}>{p.label}</td>
              <td className="hidden py-1.5 pr-3 text-fg-3 md:table-cell">{p.hint}</td>
              <td className="num py-1.5 text-right text-fg">{formatMs(p.ms)}</td>
              <td className="num w-14 py-1.5 text-right text-fg-3">{Math.round((p.ms / total) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CheckRow({ c }: { c: VCheck }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const before = raw && c.beforeRaw ? c.beforeRaw : c.before;
  const after = raw && c.afterRaw ? c.afterRaw : c.after;
  return (
    <div className="rounded-lg border border-line">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-hover" aria-expanded={open}>
        {c.pass ? <Tag tone="ok">pass</Tag> : <Tag tone="danger">fail</Tag>}
        <span className="text-[13px] text-fg">{c.name}</span>
        <span className="num ml-auto hidden truncate text-xs text-fg-2 sm:inline">{after}</span>
        <ChevronDown className={cx("size-3.5 shrink-0 text-fg-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2.5">
          {[["Before", before], ["After", after]].map(([label, v]) => (
            <div key={label} className="flex items-start gap-3">
              <span className="w-12 shrink-0 pt-0.5 text-[11px] uppercase tracking-wider text-fg-3">{label}</span>
              <code className={cx("num flex-1 break-all text-xs", label === "After" && !c.pass ? "text-danger" : "text-fg")}>{v}</code>
              <CopyButton text={v} />
            </div>
          ))}
          {c.beforeRaw && (
            <button onClick={() => setRaw((r) => !r)} className="text-[11px] text-fg-3 underline-offset-2 hover:text-fg-2 hover:underline">
              {raw ? "Show readable time" : "Show raw Unix ms"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="rounded p-0.5 text-fg-3 hover:bg-surface-hover hover:text-fg"
      aria-label="Copy value"
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function StepDot({ state, n }: { state: StepState; n: number }) {
  const base = "grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-medium";
  if (state === "done") return <span className={cx(base, "border-ok/50 bg-ok/10 text-ok")}><Check className="size-3.5" /></span>;
  if (state === "failed") return <span className={cx(base, "border-danger/50 bg-danger/10 text-danger")}><X className="size-3.5" /></span>;
  if (state === "active") return <span className={cx(base, "border-accent bg-accent-subtle text-accent")}><Loader2 className="size-3.5 animate-spin" /></span>;
  return <span className={cx(base, "num border-line-strong text-fg-3")}>{n}</span>;
}

/* ====================================================================== Wire log */

function WireLog({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { live, overview, canRead, session } = useApp();
  const replayTail: AofRecord[] = overview?.recovery?.replay_tail ?? [];
  const [source, setSource] = useState<"replay" | "disk">("replay");
  const [disk, setDisk] = useState<AofRecord[]>([]);
  const [diskError, setDiskError] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    if (!open || source !== "disk" || !canRead) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await api.aofTail(40);
        if (!cancelled) {
          setDisk(r.records);
          setDiskError("");
        }
      } catch (e) {
        if (!cancelled) setDiskError((e as Error).message);
      }
    };
    load();
    if (!live) return () => { cancelled = true; };
    const t = window.setInterval(load, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [open, source, live, canRead]);

  const records = source === "replay" ? replayTail : disk;

  return (
    <div>
      <button onClick={onToggle} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-surface-hover" aria-expanded={open}>
        <span className="flex items-center gap-2.5">
          <ScrollText className="size-3.5 text-fg-3" />
          <span className="text-[13px] font-medium">Raw AOF tail / wire log</span>
          <span className="hidden text-xs text-fg-3 sm:inline">RESP payloads, byte offsets and CRC32 checksums read from disk</span>
        </span>
        <ChevronDown className={cx("size-4 text-fg-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && session && !canRead && (
        <div className="border-t border-line"><ReadGate what="log contents" /></div>
      )}
      {open && (!session || canRead) && (
        <div className="border-t border-line">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <Segmented
              value={source}
              onChange={(v) => {
                setSource(v);
                setExpanded(null);
              }}
              options={[
                { value: "replay", label: `Replayed at startup (${replayTail.length})` },
                { value: "disk", label: "Live AOF tail" },
              ]}
            />
            <span className="text-[11px] text-fg-3">
              {source === "replay" ? "Last records applied during recovery, oldest first" : `AOF TAIL 40${live ? " · refreshes every 3 s" : " · paused"}`}
            </span>
          </div>
          {diskError && source === "disk" && <p className="px-4 pb-2 text-xs text-danger">{diskError}</p>}
          <div className="max-h-96 overflow-auto bg-canvas">
            <table className="w-full min-w-[760px] text-left font-mono text-xs">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-y border-line text-[10px] uppercase tracking-wider text-fg-3">
                  <th className="px-4 py-1.5 font-medium">seq</th>
                  <th className="px-2 py-1.5 font-medium">op</th>
                  <th className="px-2 py-1.5 font-medium">args</th>
                  <th className="px-2 py-1.5 font-medium">segment @ offset</th>
                  <th className="px-2 py-1.5 text-right font-medium">len</th>
                  <th className="px-2 py-1.5 font-medium">crc32</th>
                  <th className="w-8 px-2" />
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <Fragment key={`${r.segment}-${r.offset}`}>
                    <tr onClick={() => setExpanded(expanded === r.seq ? null : r.seq)} className="cursor-pointer border-b border-line/60 hover:bg-surface-hover">
                      <td className="num px-4 py-1.5 text-fg-3">{r.seq}</td>
                      <td className={cx("px-2", r.op === "DEL" || r.op === "FLUSHALL" ? "text-danger" : "text-fg")}>{r.op}</td>
                      <td className="max-w-[320px] truncate px-2 text-fg-2">{r.args.join(" ")}</td>
                      <td className="px-2 text-fg-3">{r.segment.replace("appendonly-", "").replace(".aof", "")} @ <span className="num">{r.offset}</span></td>
                      <td className="num px-2 text-right text-fg-3">{r.length}</td>
                      <td className="px-2 text-[var(--syntax-literal)]">{r.crc32}</td>
                      <td className="px-2 text-fg-3"><ChevronDown className={cx("size-3 transition-transform", expanded === r.seq && "rotate-180")} /></td>
                    </tr>
                    {expanded === r.seq && (
                      <tr className="border-b border-line/60 bg-surface">
                        <td colSpan={7} className="px-4 py-2">
                          <div className="text-[10px] uppercase tracking-wider text-fg-3">payload (RESP) · framed as [len:u32][crc32:u32][payload]</div>
                          <div className="mt-1 break-all leading-relaxed"><WireBytes text={r.raw} /></div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {!records.length && (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center font-sans text-fg-3">
                      {source === "replay"
                        ? "Nothing was replayed at the last startup — the snapshot already held every record. Run the experiment to produce a replay."
                        : "The active log segment is empty (a snapshot just compacted it). Write a key to see it appear."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
