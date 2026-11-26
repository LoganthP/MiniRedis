import { ArrowLeftRight, Cpu, Globe, HardDrive, Server } from "lucide-react";
import { motion } from "motion/react";
import type { ComponentType } from "react";
import { IconBox, Panel, SectionTitle, Tag, ease } from "../../../components/ui";

interface ArchNode {
  title: string;
  subtitle: string;
  port: string;
  icon: ComponentType<{ className?: string }>;
}

const ARCH_NODES: ArchNode[] = [
  {
    title: "React Dashboard",
    subtitle: "Vite SPA + Obsidian UI",
    port: "Browser",
    icon: Globe,
  },
  {
    title: "FastAPI Bridge",
    subtitle: "RESP client + Auth + Jobs",
    port: "nginx :8081 → :8000",
    icon: Server,
  },
  {
    title: "MiniRedis Engine",
    subtitle: "Asyncio TCP + Group Commit",
    port: "Private RESP2 :6380",
    icon: Cpu,
  },
  {
    title: "Disk Persistence",
    subtitle: "CRC32 AOF + dump.snap",
    port: "redis-data volume",
    icon: HardDrive,
  },
];

export function ArchitectureSection() {
  return (
    <section id="architecture" className="landing-section border-b border-line bg-surface/40 py-16 sm:py-20">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: "some" }}
          transition={ease}
        >
          <SectionTitle>Architecture</SectionTitle>
          <h2 className="text-2xl font-semibold tracking-tight text-fg sm:text-[28px]">
            Clean separation over real RESP2 sockets.
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-fg-2">
            The database port stays private inside the Docker network. The FastAPI bridge opens standard RESP2 TCP connections—no back-door imports into engine memory.
          </p>
        </motion.div>

        <div className="mt-9 grid gap-3 md:grid-cols-4">
          {ARCH_NODES.map((node, i) => {
            const Icon = node.icon;
            return (
              <motion.div
                key={node.title}
                initial={{ opacity: 0, y: 14 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: "some" }}
                transition={{ ...ease, delay: i * 0.06 }}
                className="relative flex"
              >
                <Panel className="flex w-full flex-col justify-between p-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <IconBox>
                        <Icon />
                      </IconBox>
                      <Tag tone="muted">{node.port}</Tag>
                    </div>
                    <div className="mt-3 text-sm font-semibold text-fg">{node.title}</div>
                    <div className="mt-1 text-xs text-fg-2">{node.subtitle}</div>
                  </div>
                </Panel>
                {i < ARCH_NODES.length - 1 && (
                  <ArrowLeftRight
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-2.5 top-1/2 z-10 hidden size-3.5 -translate-y-1/2 rounded-full bg-canvas text-fg-3 md:block"
                  />
                )}
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
