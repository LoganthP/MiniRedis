import {
  Activity,
  ArrowUpRight,
  Database,
  FileSpreadsheet,
  FlaskConical,
  ScrollText,
  Terminal,
} from "lucide-react";
import { motion } from "motion/react";
import type { ComponentType } from "react";
import { IconBox, Panel, SectionTitle, Tag, ease } from "../../../components/ui";

interface FeatureItem {
  title: string;
  description: string;
  route: string;
  tag: string;
  icon: ComponentType<{ className?: string }>;
}

const FEATURES: FeatureItem[] = [
  {
    title: "Live Workload & Impact Overview",
    description:
      "Simulate e-commerce cache traffic at 30–150 req/s and watch request success, p95 latency, and fallback rates live during a crash.",
    route: "/app#/overview",
    tag: "Overview",
    icon: Activity,
  },
  {
    title: "Key Explorer & Conflict-Safe Editor",
    description:
      "Cursor-paginated SCAN filtering with inline JSON syntax tinting, live amber TTL countdowns, and pre-write conflict detection.",
    route: "/app#/keys",
    tag: "Keys",
    icon: Database,
  },
  {
    title: "Streaming Dataset Importer",
    description:
      "Upload ZIP, CSV, TSV, JSON, or NDJSON catalogs up to 500,000 rows, preview keys, and load in pipelined 500-command batches.",
    route: "/app#/keys",
    tag: "Import",
    icon: FileSpreadsheet,
  },
  {
    title: "RESP2 Console & Wire Inspector",
    description:
      "Run commands like redis-cli with collapsible JSON output, command history, built-in syntax reference, and raw RESP wire bytes.",
    route: "/app#/commands",
    tag: "Console",
    icon: Terminal,
  },
  {
    title: "Chaos Lab & Crash Verification",
    description:
      "Trigger DEBUG CRASH under concurrent writes, verify zero lost acknowledgments and preserved deadlines, and export run reports.",
    route: "/app#/recovery",
    tag: "Durability",
    icon: FlaskConical,
  },
  {
    title: "Raw AOF Tail & Backup Restores",
    description:
      "Inspect on-disk append-only segments with sequence numbers, byte offsets, CRC32 checksums, and verified restore checks.",
    route: "/app#/recovery",
    tag: "AOF Log",
    icon: ScrollText,
  },
];

export function FeaturesSection({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <section id="features" className="landing-section border-b border-line py-16 sm:py-20">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: "some" }}
          transition={ease}
        >
          <SectionTitle>Capabilities</SectionTitle>
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-fg sm:text-[28px]">
                Every dashboard view is wired to the live engine.
              </h2>
              <p className="mt-2 max-w-2xl text-sm text-fg-2">
                No mocked charts—the FastAPI bridge talks to MiniRedis exclusively over RESP2 TCP, the same socket interface used by <code className="font-mono text-xs text-fg">redis-cli</code>.
              </p>
            </div>
          </div>
        </motion.div>

        <div className="mt-9 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => {
            const Icon = f.icon;
            return (
              <motion.a
                key={f.title}
                href={f.route}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(f.route);
                }}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: "some" }}
                transition={{ ...ease, delay: i * 0.05 }}
                className="group block rounded-[10px] focus-visible:outline-2"
              >
                <Panel className="flex h-full flex-col justify-between p-5 transition-[transform,border-color,box-shadow] duration-200 group-hover:-translate-y-0.5 group-hover:border-line-strong group-hover:shadow-[0_0_0_1px_var(--accent-subtle),0_10px_28px_-14px_var(--accent-subtle)]">
                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <IconBox className="transition-colors group-hover:border-accent/40 group-hover:text-accent">
                        <Icon />
                      </IconBox>
                      <Tag tone="muted">{f.tag}</Tag>
                    </div>
                    <h3 className="mt-4 text-[15px] font-semibold text-fg">{f.title}</h3>
                    <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-fg-2">
                      {f.description}
                    </p>
                  </div>
                  <div className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-fg-3 transition-colors group-hover:text-accent">
                    Open in dashboard
                    <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" />
                  </div>
                </Panel>
              </motion.a>
            );
          })}
        </div>
      </div>
    </section>
  );
}
