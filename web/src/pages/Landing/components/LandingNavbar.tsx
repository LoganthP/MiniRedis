import { ArrowRight, Menu, Moon, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, cx } from "../../../components/ui";

const NAV_LINKS = [
  { id: "features", label: "Features" },
  { id: "how-it-works", label: "How it Works" },
  { id: "commands", label: "Commands" },
  { id: "architecture", label: "Architecture" },
] as const;

export function BrandLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="var(--accent-primary)" />
      <path d="M6 8.5h12M6 12h12M6 15.5h7" stroke="#fff" strokeWidth="2.2" strokeLinecap="square" />
    </svg>
  );
}

export function LandingNavbar({
  version,
  onNavigate,
  onScrollTo,
}: {
  version: string;
  onNavigate: (path: string) => void;
  onScrollTo: (id: string) => void;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("miniredis.theme", next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  };

  const handleAnchor = (id: string) => {
    setMobileOpen(false);
    onScrollTo(id);
  };

  return (
    <header
      className={cx(
        "sticky top-0 z-40 transition-colors duration-200",
        scrolled
          ? "border-b border-line bg-canvas/90 backdrop-blur-md shadow-xs"
          : "border-b border-transparent bg-canvas/60 backdrop-blur-xs",
      )}
    >
      <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            handleAnchor("top");
          }}
          className="flex items-center gap-2.5 rounded-md focus-visible:outline-2"
        >
          <BrandLogo />
          <span className="text-[15px] font-semibold tracking-tight text-fg">MiniRedis</span>
          <span className="hidden rounded border border-line bg-surface px-1.5 font-mono text-[10px] text-fg-3 sm:inline">
            v{version}
          </span>
        </a>

        <nav aria-label="Primary navigation" className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={(e) => {
                e.preventDefault();
                handleAnchor(item.id);
              }}
              className="rounded-md px-3 py-1.5 text-[13px] font-medium text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            className="inline-flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 transition-colors hover:border-line-strong hover:text-fg"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}
          >
            {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          </button>

          <Button
            variant="primary"
            size="md"
            className="hidden active:scale-[0.98] sm:inline-flex"
            onClick={() => onNavigate("/app")}
          >
            Open App
            <ArrowRight className="size-3.5" />
          </Button>

          <button
            type="button"
            onClick={() => setMobileOpen((o) => !o)}
            className="inline-flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 transition-colors hover:border-line-strong hover:text-fg md:hidden"
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileOpen}
            aria-controls="landing-mobile-menu"
          >
            {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav
          id="landing-mobile-menu"
          aria-label="Mobile navigation"
          className="border-t border-line bg-surface px-4 py-3 md:hidden"
        >
          <div className="flex flex-col gap-1">
            {NAV_LINKS.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  handleAnchor(item.id);
                }}
                className="rounded-lg px-3 py-2 text-sm font-medium text-fg-2 transition-colors hover:bg-surface-hover hover:text-fg"
              >
                {item.label}
              </a>
            ))}
            <div className="mt-2 border-t border-line pt-2.5">
              <Button
                variant="primary"
                className="w-full justify-center active:scale-[0.98]"
                onClick={() => {
                  setMobileOpen(false);
                  onNavigate("/app");
                }}
              >
                Open App
                <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </nav>
      )}
    </header>
  );
}
