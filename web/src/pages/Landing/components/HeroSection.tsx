import { ArrowRight, ExternalLink, Terminal } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { Overview } from "../../../lib/api";
import { Button, Panel, StatusPill, Tag, cx, ease } from "../../../components/ui";

const GITHUB_URL = "https://github.com/Loganth/MiniRedis";

interface TerminalStep {
  cmd: string;
  output: { text: string; tone?: "ok" | "accent" | "muted" | "warn" }[];
}

const TERMINAL_SCRIPT: TerminalStep[] = [
  {
    cmd: `SET session:42 '{"user":"asha","plan":"pro"}' EX 120`,
    output: [{ text: "OK", tone: "ok" }],
  },
  {
    cmd: "GET session:42",
    output: [{ text: '"{\\"user\\":\\"asha\\",\\"plan\\":\\"pro\\"}"' }],
  },
  {
    cmd: "PEXPIRETIME session:42",
    output: [{ text: "(integer) 1795674391852", tone: "warn" }],
  },
  {
    cmd: "AOF TAIL 1",
    output: [
      {
        text: '[{"seq": 1, "op": "SET", "segment": "appendonly-000001.aof", "crc32": "0x8a3f19c2"}]',
        tone: "muted",
      },
    ],
  },
  {
    cmd: "PING",
    output: [{ text: "PONG", tone: "ok" }],
  },
];

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function CountUp({ target, suffix = "" }: { target: number; suffix?: string }) {
  const reduced = usePrefersReducedMotion();
  const [val, setVal] = useState(reduced ? target : 0);
  const started = useRef(false);
  const elRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (reduced) {
      setVal(target);
      return;
    }
    const el = elRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || started.current) return;
        started.current = true;
        const t0 = performance.now();
        const dur = 800;
        const tick = (now: number) => {
          const p = Math.min(1, (now - t0) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          setVal(Math.round(target * eased));
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        obs.disconnect();
      },
      { threshold: 0.3 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [target, reduced]);

  return (
    <span ref={elRef} className="num">
      {val}
      {suffix}
    </span>
  );
}

function AnimatedTerminal() {
  const reduced = usePrefersReducedMotion();
  const [stepIdx, setStepIdx] = useState(reduced ? TERMINAL_SCRIPT.length - 1 : 0);
  const [charIdx, setCharIdx] = useState(reduced ? TERMINAL_SCRIPT[TERMINAL_SCRIPT.length - 1].cmd.length : 0);
  const [showOutput, setShowOutput] = useState(reduced);

  useEffect(() => {
    if (reduced) {
      setStepIdx(TERMINAL_SCRIPT.length - 1);
      setCharIdx(TERMINAL_SCRIPT[TERMINAL_SCRIPT.length - 1].cmd.length);
      setShowOutput(true);
      return;
    }

    const current = TERMINAL_SCRIPT[stepIdx];
    let t: number;

    if (charIdx < current.cmd.length) {
      t = window.setTimeout(() => setCharIdx((c) => c + 1), 26);
    } else if (!showOutput) {
      t = window.setTimeout(() => setShowOutput(true), 220);
    } else if (stepIdx < TERMINAL_SCRIPT.length - 1) {
      t = window.setTimeout(() => {
        setStepIdx((s) => s + 1);
        setCharIdx(0);
        setShowOutput(false);
      }, 950);
    } else {
      t = window.setTimeout(() => {
        setStepIdx(0);
        setCharIdx(0);
        setShowOutput(false);
      }, 2800);
    }

    return () => window.clearTimeout(t);
  }, [stepIdx, charIdx, showOutput, reduced]);

  const completedSteps = reduced ? TERMINAL_SCRIPT : TERMINAL_SCRIPT.slice(0, stepIdx);
  const active = TERMINAL_SCRIPT[stepIdx];

  return (
    <Panel className="relative overflow-hidden border-line-strong shadow-xl shadow-black/5">
      <div className="flex items-center justify-between border-b border-line bg-surface-hover/70 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-danger/70" aria-hidden="true" />
          <span className="size-2.5 rounded-full bg-warn/70" aria-hidden="true" />
          <span className="size-2.5 rounded-full bg-ok/70" aria-hidden="true" />
          <span className="ml-2 inline-flex items-center gap-1.5 font-mono text-xs text-fg-2">
            <Terminal className="size-3.5 text-fg-3" aria-hidden="true" />
            redis-cli -p 6380
          </span>
        </div>
        <Tag tone="muted">RESP2</Tag>
      </div>

      <div
        className="min-h-[290px] space-y-2.5 bg-canvas/70 p-4 font-mono text-[12px] leading-relaxed sm:p-5"
        aria-label="Animated MiniRedis terminal session"
      >
        {completedSteps.map((s, idx) => (
          <div key={idx} className="space-y-1">
            <div className="flex items-start gap-2">
              <span className="select-none text-accent">127.0.0.1:6380&gt;</span>
              <span className="break-all text-fg">{s.cmd}</span>
            </div>
            {s.output.map((o, j) => (
              <div
                key={j}
                className={cx(
                  "break-all pl-4",
                  o.tone === "ok"
                    ? "text-ok"
                    : o.tone === "warn"
                      ? "text-warn"
                      : o.tone === "muted"
                        ? "text-fg-3"
                        : "text-fg-2",
                )}
              >
                {o.text}
              </div>
            ))}
          </div>
        ))}

        {!reduced && (
          <div className="space-y-1">
            <div className="flex items-start gap-2">
              <span className="select-none text-accent">127.0.0.1:6380&gt;</span>
              <span className="break-all text-fg">
                {active.cmd.slice(0, charIdx)}
                {!showOutput && (
                  <span
                    className="landing-cursor ml-0.5 inline-block h-[14px] w-[7px] translate-y-[2px] bg-accent"
                    aria-hidden="true"
                  />
                )}
              </span>
            </div>
            {showOutput && (
              <>
                {active.output.map((o, j) => (
                  <div
                    key={j}
                    className={cx(
                      "break-all pl-4",
                      o.tone === "ok"
                        ? "text-ok"
                        : o.tone === "warn"
                          ? "text-warn"
                          : o.tone === "muted"
                            ? "text-fg-3"
                            : "text-fg-2",
                    )}
                  >
                    {o.text}
                  </div>
                ))}
                <div className="flex items-center gap-2 pt-0.5">
                  <span className="select-none text-accent">127.0.0.1:6380&gt;</span>
                  <span
                    className="landing-cursor inline-block h-[14px] w-[7px] bg-accent"
                    aria-hidden="true"
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function HeroGraphBackground() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1200 480"
      fill="none"
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[480px] w-full opacity-60"
      preserveAspectRatio="xMidYMid slice"
    >
      <motion.path
        d="M -40 160 C 180 160, 240 100, 420 100 C 600 100, 680 220, 880 220 C 1020 220, 1110 140, 1240 140"
        stroke="var(--border-strong)"
        strokeWidth="1.25"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 0.7 }}
        transition={{ duration: 1.4, ease: [0.2, 0, 0, 1] }}
      />
      <motion.path
        d="M 240 132 C 330 132, 370 280, 540 280 C 710 280, 760 220, 880 220"
        stroke="var(--accent-primary)"
        strokeOpacity="0.32"
        strokeWidth="1.25"
        className="landing-flow-line"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.9, delay: 0.3 }}
      />
      {[
        { cx: 240, cy: 132, accent: false },
        { cx: 420, cy: 100, accent: true },
        { cx: 540, cy: 280, accent: false },
        { cx: 880, cy: 220, accent: true },
        { cx: 1080, cy: 162, accent: false },
      ].map((n, i) => (
        <g key={i}>
          <circle
            cx={n.cx}
            cy={n.cy}
            r={n.accent ? 4.5 : 3.5}
            fill={n.accent ? "var(--accent-primary)" : "var(--bg-surface)"}
            stroke={n.accent ? "var(--accent-primary)" : "var(--border-strong)"}
            strokeWidth="1.5"
            className="landing-node-pulse"
            style={{ animationDelay: `${i * 0.5}s` }}
          />
        </g>
      ))}
    </svg>
  );
}

const STATS = [
  { label: "RESP2 commands", value: 40, suffix: "", hint: "Strings, TTLs, SCAN, AOF, RECOVERY" },
  { label: "Acked writes lost", value: 0, suffix: "", hint: "With appendfsync=always & group commit" },
  { label: "Automated tests", value: 73, suffix: "", hint: "51 engine + 22 FastAPI integration" },
  { label: "Recovery stages", value: 5, suffix: "", hint: "Snapshot → AOF replay → Verify" },
];

export function HeroSection({
  overview,
  onNavigate,
}: {
  overview: Overview | null;
  onNavigate: (path: string) => void;
}) {
  return (
    <section id="top" className="landing-section relative overflow-hidden border-b border-line">
      <HeroGraphBackground />
      <div className="mx-auto max-w-[1200px] px-4 pb-16 pt-12 sm:px-6 sm:pb-20 sm:pt-16 lg:pt-20">
        <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-12">
          <motion.div
            className="lg:col-span-6"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={ease}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone="accent">Build Your Own Redis</Tag>
              {overview && (
                <StatusPill
                  status={overview.reachable ? overview.status : "offline"}
                  className="h-5 px-2 text-[11px]"
                />
              )}
            </div>

            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-fg sm:text-4xl lg:text-[42px] lg:leading-[1.15]">
              MiniRedis — crash-safe key-value storage from scratch.
            </h1>

            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-fg-2">
              A persistent Redis-compatible server built in pure Python <code className="font-mono text-[13px] text-fg">asyncio</code>.
              Speaks RESP2 over TCP, group-commits CRC32-checksummed AOF records, preserves absolute TTL deadlines across restarts, and ships with a live observability dashboard.
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                className="h-10 px-4 text-sm active:scale-[0.98]"
                onClick={() => onNavigate("/app")}
              >
                Launch App
                <ArrowRight className="size-4" />
              </Button>

              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface-hover px-4 text-sm font-medium text-fg transition-colors hover:border-[var(--btn-secondary-hover-border)] hover:bg-[var(--btn-secondary-hover)] active:scale-[0.98]"
              >
                View on GitHub
                <ExternalLink className="size-3.5 text-fg-3" aria-hidden="true" />
              </a>
            </div>
          </motion.div>

          <motion.div
            className="lg:col-span-6"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...ease, delay: 0.08 }}
          >
            <AnimatedTerminal />
          </motion.div>
        </div>

        <motion.div
          className="mt-14"
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: "some" }}
          transition={ease}
        >
          <Panel className="grid grid-cols-2 overflow-hidden lg:grid-cols-4">
            {STATS.map((s) => (
              <div
                key={s.label}
                className="-mb-px -mr-px border-b border-r border-line px-4 py-4 sm:px-5"
              >
                <div className="text-[11px] font-medium uppercase tracking-wider text-fg-3">
                  {s.label}
                </div>
                <div className="mt-1 text-2xl font-medium text-fg">
                  <CountUp target={s.value} suffix={s.suffix} />
                </div>
                <div className="mt-0.5 text-xs text-fg-3">{s.hint}</div>
              </div>
            ))}
          </Panel>
        </motion.div>
      </div>
    </section>
  );
}
