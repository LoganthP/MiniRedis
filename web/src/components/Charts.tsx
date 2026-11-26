import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "./ui";

/**
 * Small dependency-free SVG time-series chart.
 *  - stacked bars on the left axis (e.g. requests by outcome)
 *  - lines on the left or right axis (e.g. p95 latency)
 *  - vertical event markers (crash, cache down/up, ready)
 *  - hover crosshair with a tooltip listing every series
 * Colours come from CSS variables so it follows the light/dark theme.
 */

export interface Series {
  key: string;
  label: string;
  kind: "bar" | "line";
  color: string; // CSS colour, usually var(--...)
  axis?: "left" | "right";
  format?: (v: number) => string;
}

export interface ChartEvent {
  t: number; // ms
  label: string;
  tone: "danger" | "ok" | "warn" | "muted";
}

const TONE: Record<ChartEvent["tone"], string> = {
  danger: "var(--status-danger)",
  ok: "var(--status-ok)",
  warn: "var(--status-warn)",
  muted: "var(--text-muted)",
};

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(Math.max(240, e[0].contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function TimeChart({
  data,
  series,
  events = [],
  height = 180,
  leftLabel,
  rightLabel,
  empty,
  timeFormat = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false }),
}: {
  data: (Record<string, number | null | undefined> & { t: number })[];
  series: Series[];
  events?: ChartEvent[];
  height?: number;
  leftLabel?: string;
  rightLabel?: string;
  empty?: ReactNode;
  timeFormat?: (t: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: series.some((s) => s.axis === "right") ? 58 : 10, t: 18, b: 22 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;

  const bars = series.filter((s) => s.kind === "bar");
  const lines = series.filter((s) => s.kind === "line");
  const t0 = data[0]?.t ?? 0;
  const t1 = data[data.length - 1]?.t ?? 1;
  const span = Math.max(1, t1 - t0);

  const { maxL, maxR } = useMemo(() => {
    let mL = 0, mR = 0;
    for (const d of data) {
      const stack = bars.reduce((a, s) => a + (Number(d[s.key]) || 0), 0);
      mL = Math.max(mL, stack);
      for (const s of lines) {
        const v = Number(d[s.key]) || 0;
        if (s.axis === "right") mR = Math.max(mR, v);
        else mL = Math.max(mL, v);
      }
    }
    return { maxL: niceMax(mL), maxR: niceMax(mR) };
  }, [data, bars, lines]);

  if (!data.length) {
    return (
      <div ref={ref} className="grid place-items-center text-xs text-fg-3" style={{ height }}>
        {empty ?? "No data yet"}
      </div>
    );
  }

  const x = (t: number) => pad.l + ((t - t0) / span) * w;
  const yL = (v: number) => pad.t + h - (v / maxL) * h;
  const yR = (v: number) => pad.t + h - (v / maxR) * h;
  const barW = Math.max(1, (w / Math.max(1, data.length)) * 0.8);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = t0 + ((px - pad.l) / w) * span;
    let best = 0;
    for (let i = 0; i < data.length; i++) if (Math.abs(data[i].t - t) < Math.abs(data[best].t - t)) best = i;
    setHover(best);
  };

  const hd = hover != null ? data[hover] : null;
  const ticks = [0, 0.5, 1];

  return (
    <div ref={ref} className="relative">
      <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={series.map((s) => s.label).join(", ")}>
        {ticks.map((f) => (
          <line key={f} x1={pad.l} x2={pad.l + w} y1={pad.t + h - f * h} y2={pad.t + h - f * h} stroke="var(--chart-grid)" />
        ))}
        {leftLabel && <text x={4} y={2} fontSize="10" fill="var(--text-muted)" dominantBaseline="hanging">{leftLabel}</text>}
        {rightLabel && <text x={width - 4} y={2} fontSize="10" fill="var(--text-muted)" textAnchor="end" dominantBaseline="hanging">{rightLabel}</text>}

        {data.map((d, i) => {
          let acc = 0;
          return (
            <g key={i}>
              {bars.map((s) => {
                const v = Number(d[s.key]) || 0;
                if (!v) return null;
                const y0 = yL(acc);
                acc += v;
                const y1 = yL(acc);
                return <rect key={s.key} x={x(d.t) - barW / 2} y={y1} width={barW} height={Math.max(0.5, y0 - y1)} fill={s.color} />;
              })}
            </g>
          );
        })}

        {lines.map((s) => {
          const pts = data.filter((d) => d[s.key] != null).map((d) => `${x(d.t)},${(s.axis === "right" ? yR : yL)(Number(d[s.key]))}`);
          return pts.length > 1 ? <polyline key={s.key} points={pts.join(" ")} fill="none" stroke={s.color} strokeWidth={1.6} strokeLinejoin="round" /> : null;
        })}

        {events.filter((e) => e.t >= t0 - 1000 && e.t <= t1 + 1000).map((e, i) => (
          <g key={i}>
            <line x1={x(e.t)} x2={x(e.t)} y1={pad.t} y2={pad.t + h} stroke={TONE[e.tone]} strokeDasharray="3 3" />
            <circle cx={x(e.t)} cy={pad.t + 3} r={3} fill={TONE[e.tone]}><title>{e.label}</title></circle>
          </g>
        ))}

        {ticks.map((f) => (
          <g key={f}>
            <text x={pad.l - 6} y={pad.t + h - f * h + 3} textAnchor="end" className="num" fontSize="10" fill="var(--text-muted)">
              {(series.find((s) => s.axis !== "right")?.format ?? ((v: number) => String(Math.round(v))))(maxL * f)}
            </text>
            {lines.some((s) => s.axis === "right") && (
              <text x={pad.l + w + 6} y={pad.t + h - f * h + 3} fontSize="10" className="num" fill="var(--text-muted)">
                {(lines.find((s) => s.axis === "right")?.format ?? ((v: number) => String(Math.round(v))))(maxR * f)}
              </text>
            )}
          </g>
        ))}
        <text x={pad.l} y={height - 6} fontSize="10" className="num" fill="var(--text-muted)">{timeFormat(t0)}</text>
        <text x={pad.l + w} y={height - 6} fontSize="10" className="num" fill="var(--text-muted)" textAnchor="end">{timeFormat(t1)}</text>

        {hd && <line x1={x(hd.t)} x2={x(hd.t)} y1={pad.t} y2={pad.t + h} stroke="var(--border-strong)" />}
      </svg>
      {hd && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-40 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[11px] shadow-lg shadow-black/10"
          style={{ left: Math.min(Math.max(0, x(hd.t) + 10), width - 180) }}
        >
          <div className="num mb-1 text-fg-3">{timeFormat(hd.t)}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-fg-2"><span className="inline-block size-2 rounded-sm" style={{ background: s.color }} />{s.label}</span>
              <span className="num text-fg">{hd[s.key] == null ? "—" : (s.format ?? ((v: number) => String(v)))(Number(hd[s.key]))}</span>
            </div>
          ))}
          {events.filter((e) => Math.abs(e.t - hd.t) < 1000).map((e, i) => (
            <div key={i} className="mt-1 border-t border-line pt-1" style={{ color: TONE[e.tone] }}>{e.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-2">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className={cx("inline-block", i.dashed ? "h-0 w-3 border-t border-dashed" : "size-2 rounded-sm")} style={i.dashed ? { borderColor: i.color } : { background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
