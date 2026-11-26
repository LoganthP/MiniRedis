import { AlertOctagon, Home, Loader2, Lock, LogIn, LogOut, Moon, Pause, Play, Sun, Unlock, WifiOff } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useApp, useNow } from "../lib/app-context";
import type { ApiError } from "../lib/api";
import { Button, Modal, StatusPill, cx } from "./ui";

export type ViewId = "overview" | "keys" | "commands" | "recovery";

const tabs: { id: ViewId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "keys", label: "Keys" },
  { id: "commands", label: "Console" },
  { id: "recovery", label: "Durability" },
];

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("miniredis.theme", next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  };
  return (
    <button
      onClick={toggle}
      className="inline-flex size-7 items-center justify-center rounded-md border border-line bg-surface text-fg-2 hover:text-fg"
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Light theme" : "Dark theme"}
    >
      {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </button>
  );
}

function prettyName(name: string) {
  return name.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-canvas">
      <div className="canvas-grid absolute inset-x-0 top-0 h-[70vh]" />
    </div>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
      <rect width="24" height="24" rx="5" fill="var(--accent-primary)" />
      <path d="M6 8.5h12M6 12h12M6 15.5h7" stroke="#fff" strokeWidth="2.2" strokeLinecap="square" />
    </svg>
  );
}

export function TopNav({ view, onView, onHome }: { view: ViewId; onView: (v: ViewId) => void; onHome?: () => void }) {
  const { overview, status, stale, session, canWrite, openLogin, logout, live, setLive, lastUpdated, apiProblem } = useApp();
  const now = useNow(1000);
  const inst = overview?.instance;
  const ago = lastUpdated ? Math.max(0, Math.round((now - lastUpdated) / 1000)) : null;

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
        <a
          href="/app#/overview"
          onClick={(e) => {
            e.preventDefault();
            onView("overview");
          }}
          className="flex items-center gap-2.5"
        >
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">MiniRedis</span>
          <span className="hidden rounded border border-line px-1.5 font-mono text-[10px] text-fg-3 sm:inline">v{String(overview?.server?.miniredis_version ?? "1.0.0")}</span>
        </a>

        <span className="hidden h-5 w-px bg-line md:block" />

        {inst && (
          <span
            className="hidden h-7 items-center overflow-hidden rounded-md border border-line bg-surface font-mono text-xs text-fg-2 lg:inline-flex"
            title={`Dashboard: this page (${window.location.host}). Database TCP: the address the API uses to reach the database${inst.internal ? " — internal to the container network, not reachable from your machine" : ""}.`}
          >
            <span className="flex h-full items-center bg-surface-hover px-2.5 font-sans font-medium text-fg">{prettyName(inst.name)}</span>
            <span className="px-2.5"><span className="font-sans text-fg-3">Dashboard</span> {window.location.host}</span>
            <span className="h-full w-px bg-line" />
            <span className="px-2.5">
              <span className="font-sans text-fg-3">Database TCP</span> {inst.public_address ?? `${inst.host}:${inst.port}`}
              {inst.internal && <span className="ml-1.5 font-sans text-[10px] uppercase text-fg-3">internal</span>}
            </span>
          </span>
        )}

        <nav className="ml-2 hidden h-14 items-stretch gap-1 md:flex">
          {tabs.map((t) => (
            <TabLink key={t.id} id={t.id} active={view === t.id} onView={onView}>
              {t.label}
            </TabLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <a
            href="/"
            onClick={(e) => {
              if (onHome) {
                e.preventDefault();
                onHome();
              }
            }}
            className="inline-flex size-7 items-center justify-center rounded-md border border-line bg-surface text-fg-2 hover:text-fg"
            aria-label="Landing page"
            title="Landing page"
          >
            <Home className="size-3.5" />
          </a>
          <ThemeToggle />
          <button
            onClick={() => setLive(!live)}
            className={cx(
              "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
              live ? "border-line bg-surface text-fg-2 hover:text-fg" : "border-warn/40 bg-warn/10 text-warn",
            )}
            title={live ? "Live polling every 2 s — click to pause" : "Polling paused — click to resume"}
            aria-pressed={live}
          >
            {live ? <Pause className="size-3" /> : <Play className="size-3" />}
            <span className="hidden sm:inline">{live ? "Live" : "Paused"}</span>
            {ago !== null && <span className="num hidden text-fg-3 lg:inline">{live ? `${Math.min(ago, 99)}s` : `${ago}s ago`}</span>}
          </button>
          <StatusPill status={status} stale={stale} label={apiProblem === "missing" ? "No backend" : apiProblem === "down" ? "API down" : undefined} />
          {session?.auth_required &&
            (canWrite ? (
              <Button size="sm" variant="ghost" onClick={logout} icon={<LogOut />} title="Sign out">
                <span className="hidden lg:inline">Sign out</span>
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => openLogin()} icon={<LogIn />}>
                Sign in
              </Button>
            ))}
          {session && !session.auth_required && (
            <span className="hidden items-center gap-1 rounded-md border border-warn/30 px-2 py-1 font-mono text-[10px] uppercase text-warn lg:flex" title="DASHBOARD_PASSWORD is not set: anyone can write">
              <Unlock className="size-3" /> open
            </span>
          )}
        </div>
      </div>

      {/* Mobile tabs */}
      <nav className="flex h-10 items-stretch gap-1 border-t border-line px-2 md:hidden">
        {tabs.map((t) => (
          <TabLink key={t.id} id={t.id} active={view === t.id} onView={onView} className="flex-1 justify-center">
            {t.label}
          </TabLink>
        ))}
      </nav>
      <StatusBanner />
      <LoginDialog />
    </header>
  );
}

function TabLink({ id, active, onView, children, className }: { id: ViewId; active: boolean; onView: (v: ViewId) => void; children: ReactNode; className?: string }) {
  return (
    <a
      href={`/app#/${id}`}
      onClick={(e) => {
        e.preventDefault();
        onView(id);
      }}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative flex items-center px-3 text-[13px] font-medium transition-colors",
        active ? "text-fg" : "text-fg-3 hover:text-fg-2",
        className,
      )}
    >
      {children}
      {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
    </a>
  );
}

function StatusBanner() {
  const { overview, apiDown, apiProblem, everConnected, live, stale, lastUpdated } = useApp();
  const now = useNow(1000);
  if (!overview) return null;
  let content: { icon: ReactNode; text: string; tone: string } | null = null;
  if (!live && stale) {
    content = { icon: <Pause className="size-3.5" />, text: `Polling paused — status and data shown are from ${Math.round((now - lastUpdated) / 1000)}s ago. Writes stay disabled until a fresh check. Resume Live to refresh.`, tone: "text-warn border-warn/30" };
  } else if (apiProblem === "missing") {
    content = {
      icon: <AlertOctagon className="size-3.5" />,
      text: "No backend: requests to /api on this site return the host's own page, so nothing here can load. Deploy the backend (deploy/backend) and point this site's /api/* at it — see README › “Frontend on Netlify, backend elsewhere”.",
      tone: "text-danger border-danger/30",
    };
  } else if (apiDown) {
    content = { icon: <WifiOff className="size-3.5" />, text: "Dashboard API is not responding (it may be starting up or asleep on a free plan). Retrying…", tone: "text-fg-2 border-line" };
  } else if (overview.status === "offline") {
    const reason = (overview as { reason?: string }).reason;
    content = {
      icon: <WifiOff className="size-3.5" />,
      text: everConnected
        ? `Database unreachable. Reconnecting automatically — after a crash the supervisor restarts it.${reason ? ` (${reason})` : ""}`
        : `The API is up but cannot reach the database${reason ? `: ${reason}` : ""}. Check that the database is running and the API's DB_HOST / DB_PORT point to it.`,
      tone: everConnected ? "text-fg-2 border-line" : "text-danger border-danger/30",
    };
  } else if (overview.status === "recovering" || overview.status === "starting") {
    content = { icon: <Loader2 className="size-3.5 animate-spin" />, text: "Recovering: loading snapshot and replaying the append-only log. Commands resume when it finishes.", tone: "text-warn border-warn/30" };
  } else if (overview.status === "degraded") {
    content = { icon: <AlertOctagon className="size-3.5" />, text: `Degraded — ${overview.degraded_reason ?? "unknown problem"}`, tone: "text-danger border-danger/30" };
  }
  if (!content) return null;
  return (
    <div className={cx("border-t bg-surface", content.tone)} role="status">
      <div className="mx-auto flex max-w-[1400px] items-center gap-2 px-4 py-2 text-xs font-medium sm:px-6">
        {content.icon}
        {content.text}
      </div>
    </div>
  );
}

function LoginDialog() {
  const { loginOpen, loginReason, closeLogin, login } = useApp();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<{ kind: "password" | "network" | "other"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await login(pw);
      setPw("");
    } catch (ex) {
      const a = ex as ApiError;
      if (a.status === 401) setErr({ kind: "password", text: "Incorrect password. Check DASHBOARD_PASSWORD in your .env file." });
      else if (a.code === "API_DOWN" || a.status === 0 || a.status >= 500) setErr({ kind: "network", text: "Can't reach the dashboard API. Is the api service running?" });
      else setErr({ kind: "other", text: a.message });
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setErr(null);
    setPw("");
    closeLogin();
  };

  return (
    <Modal open={loginOpen} onClose={close} title="Sign in" description={loginReason ? `Sign in to ${loginReason}.` : "Required to view or change data on this instance."}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="dashboard-password" className="mb-1.5 block text-xs font-medium text-fg-2">
            Dashboard password
          </label>
          <input
            id="dashboard-password"
            name="password"
            type="password"
            data-autofocus
            value={pw}
            onChange={(e) => {
              setPw(e.target.value);
              if (err) setErr(null);
            }}
            className={cx("field h-10 w-full px-3 text-[14px]", err?.kind === "password" && "border-danger")}
            autoComplete="current-password"
            aria-invalid={err?.kind === "password" || undefined}
            aria-describedby={err ? "login-error" : "login-hint"}
          />
          {!err && (
            <p id="login-hint" className="mt-1.5 text-[11px] text-fg-3">
              The value of <code className="font-mono">DASHBOARD_PASSWORD</code> set on the server.
            </p>
          )}
          {err && (
            <p id="login-error" role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-danger">
              {err.kind === "network" ? <WifiOff className="mt-px size-3.5 shrink-0" /> : <AlertOctagon className="mt-px size-3.5 shrink-0" />}
              {err.text}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!pw}>Sign in</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Shown in place of data views when this instance keeps reads private. */
export function ReadGate({ what }: { what: string }) {
  const { openLogin, session } = useApp();
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="grid size-10 place-items-center rounded-lg border border-line bg-surface-hover text-fg-2">
        <Lock className="size-4" />
      </span>
      <h3 className="mt-4 text-sm font-semibold">Sign in to view {what}</h3>
      <p className="mt-1 max-w-md text-[13px] text-fg-3">
        This instance keeps key names, values and log contents private (<code className="font-mono">PUBLIC_READS=false</code>). Health and status stay visible to everyone.
      </p>
      {session?.auth_required && (
        <Button className="mt-5" variant="primary" onClick={() => openLogin()} icon={<LogIn />}>
          Sign in
        </Button>
      )}
    </div>
  );
}
