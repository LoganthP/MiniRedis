import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, setToken, type DbStatus, type Overview } from "./api";
import { shellQuote } from "./format";

interface Session {
  auth_required: boolean;
  authenticated: boolean;
  can_read: boolean;
  public_reads: boolean;
  crash_demo_enabled: boolean;
  demo_workload_enabled: boolean;
}

/**
 * Single source of truth for database readiness. The header, every write
 * control and the chaos lab read `status` / `isReady` from here, and every
 * component that probes the server goes through `refreshOverview`, so two
 * parts of the UI can never disagree about whether the database is up.
 */
interface AppState {
  overview: Overview | null;
  status: DbStatus;
  /** True only when the last check succeeded recently and reported "ready". */
  isReady: boolean;
  /** Last successful check is older than expected (paused, or checks failing). */
  stale: boolean;
  apiDown: boolean;
  refreshOverview: () => Promise<Overview | null>;
  live: boolean;
  setLive: (v: boolean) => void;
  lastUpdated: number;
  session: Session | null;
  canWrite: boolean;
  canRead: boolean;
  loginOpen: boolean;
  /** What the user was trying to do when sign-in opened (shown in the dialog). */
  loginReason: string | null;
  openLogin: (reason?: string) => void;
  closeLogin: () => void;
  /** Run `action` now if signed in; otherwise open sign-in and run it right after. */
  requireWrite: (reason: string, action: () => void) => void;
  /** Builds a copyable terminal command for this instance. */
  cli: (args: (string | number)[]) => string;
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AppState | null>(null);
const READY_FRESH_MS = 6000;

export function AppProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [apiDown, setApiDown] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginReason, setLoginReason] = useState<string | null>(null);
  const pendingAction = useRef<(() => void) | null>(null);
  const [live, setLiveState] = useState<boolean>(() => {
    try {
      return localStorage.getItem("miniredis.live") !== "0";
    } catch {
      return true;
    }
  });
  const [lastUpdated, setLastUpdated] = useState(0);
  const [now, setNow] = useState(Date.now());
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const setLive = useCallback((v: boolean) => {
    setLiveState(v);
    try {
      localStorage.setItem("miniredis.live", v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);

  const refreshOverview = useCallback(async () => {
    try {
      const o = await api.overview();
      setOverview(o);
      setApiDown(false);
      setLastUpdated(Date.now());
      setNow(Date.now());
      return o;
    } catch (e) {
      const down = e instanceof ApiError && (e.code === "API_DOWN" || e.status >= 500);
      setApiDown(down);
      // A failed check never leaves a green "Ready" on screen.
      setOverview((prev) => ({ ...(prev ?? { checked_at: Date.now() / 1000 }), reachable: false, status: "offline" }) as Overview);
      setLastUpdated(Date.now());
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loop = async () => {
      const o = await refreshOverview();
      if (cancelled || !live) return;
      const fast = !o || o.status !== "ready";
      timer.current = window.setTimeout(loop, fast ? 700 : 2000);
    };
    loop();
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
    };
  }, [refreshOverview, live]);

  const loadSession = useCallback(async () => {
    try {
      const s = await api.session();
      if (s.auth_required && !s.authenticated) setToken("");
      setSession(s);
    } catch {
      /* API down: retried below */
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);
  useEffect(() => {
    if (!session && !apiDown) loadSession();
  }, [apiDown, session, loadSession]);

  const login = useCallback(
    async (password: string) => {
      const r = await api.login(password);
      setToken(r.token);
      await loadSession();
      await refreshOverview();
      setLoginOpen(false);
      const next = pendingAction.current;
      pendingAction.current = null;
      // Let the session state settle, then resume what the user clicked.
      if (next) setTimeout(next, 0);
    },
    [loadSession, refreshOverview],
  );

  const openLogin = useCallback((reason?: string) => {
    setLoginReason(reason ?? null);
    setLoginOpen(true);
  }, []);
  const closeLogin = useCallback(() => {
    pendingAction.current = null;
    setLoginOpen(false);
  }, []);

  const logout = useCallback(() => {
    setToken("");
    loadSession();
    refreshOverview();
  }, [loadSession, refreshOverview]);

  const status: DbStatus = overview?.status ?? "offline";
  const stale = !lastUpdated || now - lastUpdated > READY_FRESH_MS;
  const isReady = status === "ready" && !stale;
  const canWrite = !!session && (!session.auth_required || session.authenticated);
  const canRead = !!session && session.can_read;

  const requireWrite = useCallback(
    (reason: string, action: () => void) => {
      if (canWrite) return action();
      pendingAction.current = action;
      openLogin(reason);
    },
    [canWrite, openLogin],
  );

  const cliPrefix = overview?.instance?.cli_prefix ?? "redis-cli -p 6380";
  const cli = useCallback((args: (string | number)[]) => `${cliPrefix} ${args.map((a) => shellQuote(String(a))).join(" ")}`, [cliPrefix]);

  return (
    <Ctx.Provider
      value={{
        overview,
        status,
        isReady,
        stale,
        apiDown,
        refreshOverview,
        live,
        setLive,
        lastUpdated,
        session,
        canWrite,
        canRead,
        loginOpen,
        loginReason,
        openLogin,
        closeLogin,
        requireWrite,
        cli,
        login,
        logout,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp outside provider");
  return c;
}

/** Re-render every `ms` so countdowns tick. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
