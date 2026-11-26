import {
  ArrowRight,
  Camera,
  FileCheck2,
  HardDrive,
  Layers,
  Network,
  RotateCcw,
} from "lucide-react";
import { motion } from "motion/react";
import { useState, type ComponentType } from "react";
import { IconBox, Panel, SectionTitle, Tag, cx, ease } from "../../../components/ui";

interface PipelineStage {
  id: string;
  step: string;
  title: string;
  module: string;
  summary: string;
  detail: string;
  icon: ComponentType<{ className?: string }>;
}

const STAGES: PipelineStage[] = [
  {
    id: "resp",
    step: "01",
    title: "RESP2 TCP Server",
    module: "server.py · resp.py",
    summary: "Asyncio socket loop parses RESP2 bulk arrays and pipelines commands.",
    detail:
      "Every client—redis-cli, Python CLI, or the FastAPI bridge—connects over TCP on :6380 using standard RESP2 frames with AUTH and inline support.",
    icon: Network,
  },
  {
    id: "queue",
    step: "02",
    title: "Write Queue & Group Commit",
    module: "db.py",
    summary: "Concurrent writers share a single fsync before receiving OK.",
    detail:
      "Mutations enter a serialized write queue with an undo log. Concurrent clients batch into one group-commit fsync, boosting throughput under appendfsync=always.",
    icon: Layers,
  },
  {
    id: "aof",
    step: "03",
    title: "AOF Segments + CRC32",
    module: "persistence.py",
    summary: "Every record stores sequence ID, absolute deadline, length, and CRC32.",
    detail:
      "Expirations are persisted as absolute Unix millisecond deadlines (PEXPIREAT) rather than relative TTLs, so restarts never extend or reset key lifetimes.",
    icon: FileCheck2,
  },
  {
    id: "store",
    step: "04",
    title: "In-Memory Store & Snapshots",
    module: "store.py · db.py",
    summary: "O(1) keyspace with dict.copy() snapshots and atomic log rotation.",
    detail:
      "Background snapshots briefly pause writes (~5–8 ms) to copy the dictionary, rotate to a new AOF segment, write dump.snap via atomic rename, and prune old segments.",
    icon: Camera,
  },
  {
    id: "recover",
    step: "05",
    title: "Crash-Safe Startup Recovery",
    module: "recover() · supervise.py",
    summary: "Loads snapshot, replays newer AOF records, and trims torn tails.",
    detail:
      "On restart, the supervisor respawns the server in milliseconds. Recovery truncates an incomplete final record safely, or enters Degraded read-only mode if mid-log corruption is detected.",
    icon: RotateCcw,
  },
];

export function HowItWorksSection() {
  const [selected, setSelected] = useState<string>(STAGES[0].id);
  const current = STAGES.find((s) => s.id === selected) ?? STAGES[0];

  return (
    <section id="how-it-works" className="landing-section border-b border-line bg-surface/40 py-16 sm:py-20">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: "some" }}
          transition={ease}
        >
          <SectionTitle>How it works</SectionTitle>
          <h2 className="text-2xl font-semibold tracking-tight text-fg sm:text-[28px]">
            From RESP2 frame on the wire to crash-safe recovery on disk.
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-fg-2">
            Select any stage in the write and recovery pipeline to inspect how MiniRedis guarantees durability without sacrificing in-memory speed.
          </p>
        </motion.div>

        <div className="mt-9 grid gap-4 md:grid-cols-5">
          {STAGES.map((stage, i) => {
            const Icon = stage.icon;
            const isActive = stage.id === selected;
            return (
              <motion.div
                key={stage.id}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: "some" }}
                transition={{ ...ease, delay: i * 0.08 }}
                className="relative flex"
              >
                <button
                  type="button"
                  onClick={() => setSelected(stage.id)}
                  aria-pressed={isActive}
                  className={cx(
                    "flex w-full flex-col rounded-[10px] border p-4 text-left transition-[transform,border-color,background-color] duration-150 hover:-translate-y-0.5 active:scale-[0.99]",
                    isActive
                      ? "border-accent bg-surface shadow-[0_0_0_1px_var(--accent-subtle)]"
                      : "border-line bg-surface hover:border-line-strong",
                  )}
                >
                  <div className="flex w-full items-center justify-between">
                    <IconBox className={cx(isActive && "border-accent/40 text-accent")}>
                      <Icon />
                    </IconBox>
                    <span className="num text-[11px] font-medium text-fg-3">{stage.step}</span>
                  </div>
                  <div className="mt-3 text-[13px] font-semibold text-fg">{stage.title}</div>
                  <div className="mt-1 text-xs leading-relaxed text-fg-2">{stage.summary}</div>
                </button>
                {i < STAGES.length - 1 && (
                  <ArrowRight
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-3 top-1/2 hidden size-3.5 -translate-y-1/2 text-fg-3 md:block"
                  />
                )}
              </motion.div>
            );
          })}
        </div>

        <motion.div
          key={current.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={ease}
          className="mt-5"
        >
          <Panel className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone="accent">Stage {current.step}</Tag>
                <span className="font-mono text-xs text-fg-3">{current.module}</span>
              </div>
              <div className="text-sm font-semibold text-fg">{current.title}</div>
              <p className="max-w-3xl text-[13px] leading-relaxed text-fg-2">{current.detail}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-xs text-fg-2">
              <HardDrive className="size-3.5 text-fg-3" aria-hidden="true" />
              appendfsync=always
            </div>
          </Panel>
        </motion.div>
      </div>
    </section>
  );
}
