export function formatBytes(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatMs(ms: number | undefined | null): string {
  if (ms == null || isNaN(ms)) return "—";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "expired";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatDuration(sec: number | undefined): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatClock(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function formatNumber(n: number | undefined | null): string {
  if (n == null || isNaN(n as number)) return "—";
  return new Intl.NumberFormat().format(n);
}

/** Quote one argument the way redis-cli accepts it. */
export function cliQuote(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_:.\-/@+*?=]+$/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/** A copy-pasteable shell command. Arguments are shell-quoted because the
 * shell, not redis-cli, splits them when you run it from a terminal. */
export function cliCommand(args: (string | number)[]): string {
  return "redis-cli -p 6380 " + args.map((a) => shellQuote(String(a))).join(" ");
}

/** Quote for the dashboard console, which uses shell-style (shlex) parsing. */
export function shellQuote(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_:.\-/@+=]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}

/** Readable timestamp with milliseconds, e.g. "Nov 26, 17:15:24.123". */
export function formatClockMs(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const base = d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${base}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}
