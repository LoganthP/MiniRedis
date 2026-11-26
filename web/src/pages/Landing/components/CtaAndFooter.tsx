import { ArrowRight, ArrowUp } from "lucide-react";
import { motion } from "motion/react";
import { Button, Panel, ease } from "../../../components/ui";
import { BrandLogo } from "./LandingNavbar";

const GITHUB_URL = "https://github.com/Loganth/MiniRedis";
const LINKEDIN_URL = "https://www.linkedin.com";

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

function LinkedinIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden="true">
      <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" />
    </svg>
  );
}

export function CtaSection({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <section className="py-16 sm:py-20">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: "some" }}
          transition={ease}
        >
          <Panel className="flex flex-col items-start justify-between gap-6 border-line-strong p-6 sm:flex-row sm:items-center sm:p-8">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">
                Start exploring MiniRedis
              </h2>
              <p className="mt-1.5 max-w-xl text-sm text-fg-2">
                Browse live keys, inspect AOF records, run RESP2 commands, or crash the database mid-traffic in the Chaos Lab.
              </p>
            </div>
            <Button
              variant="primary"
              className="h-10 shrink-0 px-5 text-sm active:scale-[0.98]"
              onClick={() => onNavigate("/app")}
            >
              Launch App
              <ArrowRight className="size-4" />
            </Button>
          </Panel>
        </motion.div>
      </div>
    </section>
  );
}

export function LandingFooter({ onScrollTop }: { onScrollTop: () => void }) {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-line bg-surface/50 py-8">
      <div className="mx-auto flex max-w-[1200px] flex-col items-start justify-between gap-4 px-4 sm:flex-row sm:items-center sm:px-6">
        <div className="flex items-center gap-2.5 text-xs text-fg-2">
          <BrandLogo />
          <span className="font-semibold text-fg">MiniRedis</span>
          <span className="text-fg-3">·</span>
          <span>Built by Loganth · {year}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="MiniRedis on GitHub"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs font-medium text-fg-2 transition-colors hover:border-line-strong hover:text-fg"
          >
            <GithubIcon />
            GitHub
          </a>

          <a
            href={LINKEDIN_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Author on LinkedIn"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs font-medium text-fg-2 transition-colors hover:border-line-strong hover:text-fg"
          >
            <LinkedinIcon />
            LinkedIn
          </a>

          <button
            type="button"
            onClick={onScrollTop}
            aria-label="Back to top"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs font-medium text-fg-2 transition-colors hover:border-line-strong hover:text-fg active:scale-[0.98]"
          >
            <ArrowUp className="size-3.5" aria-hidden="true" />
            Back to top
          </button>
        </div>
      </div>
    </footer>
  );
}
