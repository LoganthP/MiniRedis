import { ArrowRight, CheckCircle2, Loader2, Play, Terminal, WifiOff } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { ApiError, api, type Reply } from "../../../lib/api";
import { Button, Panel, PanelHeader, SectionTitle, Tag, cx, ease } from "../../../components/ui";
import { WireBytes } from "../../../components/Json";

interface PresetCmd {
  label: string;
  cmd: string;
  desc: string;
  demoReply: string;
  demoWire: string;
}

const PRESETS: PresetCmd[] = [
  {
    label: "PING",
    cmd: "PING",
    desc: "Verify RESP2 connection",
    demoReply: "PONG",
    demoWire: "*1\\r\\n$4\\r\\nPING\\r\\n",
  },
  {
    label: "DBSIZE",
    cmd: "DBSIZE",
    desc: "Count keys in db 0",
    demoReply: "(integer) 12",
    demoWire: "*1\\r\\n$6\\r\\nDBSIZE\\r\\n",
  },
  {
    label: "INFO persistence",
    cmd: "INFO persistence",
    desc: "Inspect AOF & snapshot state",
    demoReply:
      "status:ready\r\nappendfsync:always\r\naof_segments:1\r\nlast_seq:14\r\ndurable_seq:14",
    demoWire: "*2\\r\\n$4\\r\\nINFO\\r\\n$11\\r\\npersistence\\r\\n",
  },
  {
    label: "RECOVERY LAST",
    cmd: "RECOVERY LAST",
    desc: "Startup replay report",
    demoReply: JSON.stringify(
      {
        status: "ready",
        report: { ok: true, snapshot_loaded: true, replayed_ops: 2, truncated_bytes: 0 },
      },
      null,
      2,
    ),
    demoWire: "*2\\r\\n$8\\r\\nRECOVERY\\r\\n$4\\r\\nLAST\\r\\n",
  },
  {
    label: "SCAN 0 COUNT 5",
    cmd: "SCAN 0 COUNT 5",
    desc: "Cursor-paginated key scan",
    demoReply: '1) "0"\n2) 1) "demo:greeting"\n   2) "demo:feature:new-checkout"',
    demoWire: "*4\\r\\n$4\\r\\nSCAN\\r\\n$1\\r\\n0\\r\\n$5\\r\\nCOUNT\\r\\n$1\\r\\n5\\r\\n",
  },
  {
    label: "AOF TAIL 3",
    cmd: "AOF TAIL 3",
    desc: "Newest CRC32 log records",
    demoReply: JSON.stringify(
      [{ seq: 14, op: "SET", segment: "appendonly-000001.aof", crc32: "0x4c91e02a" }],
      null,
      2,
    ),
    demoWire: "*3\\r\\n$3\\r\\nAOF\\r\\n$4\\r\\nTAIL\\r\\n$1\\r\\n3\\r\\n",
  },
];

function formatReply(r: Reply): string {
  switch (r.type) {
    case "status":
      return r.value;
    case "error":
      return `(error) ${r.value}`;
    case "integer":
      return `(integer) ${r.value}`;
    case "nil":
      return "(nil)";
    case "bulk":
      try {
        const parsed = JSON.parse(r.value);
        if (typeof parsed === "object" && parsed !== null) {
          return JSON.stringify(parsed, null, 2);
        }
      } catch {
        /* plain bulk text */
      }
      return r.value;
    case "array":
      if (r.value.length === 0) return "(empty array)";
      return r.value.map((item, i) => `${i + 1}) ${formatReply(item)}`).join("\n");
  }
}

export function PlaygroundSection({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [canRead, setCanRead] = useState<boolean | null>(null);
  const [activeCmd, setActiveCmd] = useState<string>("PING");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    cmd: string;
    reply: string;
    wire: string;
    ms?: number;
    mode: "live" | "demo";
  } | null>(null);

  useEffect(() => {
    let mounted = true;
    api
      .session()
      .then((s) => {
        if (mounted) setCanRead(s.can_read);
      })
      .catch(() => {
        if (mounted) setCanRead(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const runPreset = async (preset: PresetCmd) => {
    setActiveCmd(preset.cmd);
    setError(null);
    setLoading(true);
    try {
      const res = await api.command(preset.cmd);
      setCanRead(true);
      setResult({
        cmd: preset.cmd,
        reply: formatReply(res.reply),
        wire: res.wire,
        ms: res.duration_ms,
        mode: "live",
      });
    } catch (e) {
      const err = e as ApiError;
      if (err instanceof ApiError && err.status === 401) {
        setCanRead(false);
        setError("Instance requires sign-in for live reads (PUBLIC_READS=false). Showing scripted demo output below.");
      } else {
        setError(
          err instanceof Error
            ? `${err.message} Showing scripted demo output below.`
            : "Live server unreachable. Showing scripted demo output below.",
        );
      }
      setResult({
        cmd: preset.cmd,
        reply: preset.demoReply,
        wire: preset.demoWire,
        mode: "demo",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Run PING on mount once session readiness resolves (live if allowed, otherwise scripted demo).
    if (canRead === null) return;
    if (canRead) {
      void runPreset(PRESETS[0]);
    } else {
      setResult({
        cmd: PRESETS[0].cmd,
        reply: PRESETS[0].demoReply,
        wire: PRESETS[0].demoWire,
        mode: "demo",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead !== null]);

  return (
    <section id="commands" className="landing-section border-b border-line py-16 sm:py-20">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: "some" }}
          transition={ease}
        >
          <SectionTitle>Command playground</SectionTitle>
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-fg sm:text-[28px]">
                Inspect RESP2 responses and wire frames.
              </h2>
              <p className="mt-2 max-w-2xl text-sm text-fg-2">
                Click a read-only command to query the FastAPI <code className="font-mono text-xs text-fg">/api/command</code> endpoint or preview scripted output when running offline.
              </p>
            </div>
            <Button
              variant="secondary"
              onClick={() => onNavigate("/app#/commands")}
              className="shrink-0 active:scale-[0.98]"
            >
              Open full console
              <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </motion.div>

        <motion.div
          className="mt-8 grid gap-5 lg:grid-cols-12"
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: "some" }}
          transition={ease}
        >
          <div className="grid gap-2.5 sm:grid-cols-2 lg:col-span-5 lg:grid-cols-1">
            {PRESETS.map((p) => {
              const selected = activeCmd === p.cmd;
              return (
                <button
                  key={p.cmd}
                  type="button"
                  onClick={() => runPreset(p)}
                  disabled={loading}
                  className={cx(
                    "flex items-center justify-between gap-3 rounded-[10px] border px-4 py-3 text-left transition-[transform,border-color,background-color] duration-150 hover:border-line-strong active:scale-[0.99] disabled:opacity-60",
                    selected
                      ? "border-accent bg-surface shadow-[0_0_0_1px_var(--accent-subtle)]"
                      : "border-line bg-surface hover:bg-surface-hover/50",
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[13px] font-medium text-fg">
                      {p.label}
                    </div>
                    <div className="truncate text-xs text-fg-3">{p.desc}</div>
                  </div>
                  <span
                    className={cx(
                      "grid size-7 shrink-0 place-items-center rounded-md border",
                      selected
                        ? "border-accent/40 bg-accent-subtle text-accent"
                        : "border-line bg-surface-hover text-fg-3",
                    )}
                  >
                    {loading && selected ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Play className="size-3" />
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          <Panel className="flex flex-col overflow-hidden lg:col-span-7">
            <PanelHeader
              icon={<Terminal />}
              title={<span className="font-mono">{result?.cmd ?? activeCmd}</span>}
              meta={
                result?.mode === "live"
                  ? "Executed against /api/command"
                  : "Scripted demo preview (safe read-only sample)"
              }
              right={
                <div className="flex items-center gap-2">
                  {result?.ms !== undefined && (
                    <span className="num text-xs text-fg-3">{result.ms} ms</span>
                  )}
                  {result?.mode === "live" ? (
                    <Tag tone="ok">
                      <CheckCircle2 /> Live API
                    </Tag>
                  ) : (
                    <Tag tone="warn">Demo</Tag>
                  )}
                </div>
              }
            />

            <div className="flex-1 space-y-4 p-4 sm:p-5">
              {error && (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn"
                >
                  <WifiOff className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-3">
                  Reply
                </div>
                <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas p-3.5 font-mono text-[12px] leading-relaxed text-fg">
                  {loading ? "Waiting for response…" : result?.reply ?? "Select a command to run."}
                </pre>
              </div>

              {result?.wire && (
                <div>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-3">
                    RESP2 Wire Payload
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-line bg-canvas px-3.5 py-2.5 font-mono text-xs">
                    <WireBytes text={result.wire} />
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </motion.div>
      </div>
    </section>
  );
}
