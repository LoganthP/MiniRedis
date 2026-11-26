import { AnimatePresence, motion } from "motion/react";
import { X, Loader2, Check, AlertTriangle, Info } from "lucide-react";
import { createPortal } from "react-dom";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import type { DbStatus } from "../lib/api";

export const ease = { duration: 0.18, ease: [0.2, 0, 0, 1] } as const;

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ Panels */
export function Panel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rounded-[10px] border border-line bg-surface", className)} {...rest}>
      {children}
    </div>
  );
}

/** Monochrome icon in a subtle bordered box — the only icon treatment in the app. */
export function IconBox({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx("grid size-7 shrink-0 place-items-center rounded-md border border-line bg-surface-hover text-fg-2 [&_svg]:size-3.5", className)}>
      {children}
    </span>
  );
}

export function PanelHeader({ icon, title, meta, right, className }: { icon?: ReactNode; title: ReactNode; meta?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-h-12 items-center justify-between gap-3 border-b border-line px-4 py-2.5", className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <IconBox>{icon}</IconBox>}
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-fg">{title}</div>
          {meta && <div className="truncate text-xs text-fg-3">{meta}</div>}
        </div>
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ Button */
type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean; icon?: ReactNode }) {
  const styles: Record<Variant, string> = {
    primary: "bg-accent text-white border border-accent hover:bg-accent-hover hover:border-accent-hover",
    secondary: "bg-surface-hover text-fg border border-line-strong hover:bg-[var(--btn-secondary-hover)] hover:border-[var(--btn-secondary-hover-border)]",
    ghost: "text-fg-2 border border-transparent hover:text-fg hover:bg-surface-hover",
    danger: "text-danger border border-danger/40 bg-danger/5 hover:bg-danger/10 hover:border-danger/70",
  };
  return (
    <button
      disabled={disabled || loading}
      className={cx(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors active:translate-y-px",
        "disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-3.5",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
        styles[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ Status */
const statusMeta: Record<DbStatus, { label: string; dot: string; text: string }> = {
  ready: { label: "Ready", dot: "bg-ok", text: "text-ok" },
  recovering: { label: "Recovering", dot: "bg-warn", text: "text-warn" },
  starting: { label: "Starting", dot: "bg-warn", text: "text-warn" },
  degraded: { label: "Degraded", dot: "bg-danger", text: "text-danger" },
  offline: { label: "Offline", dot: "bg-fg-3", text: "text-fg-2" },
};

export function StatusPill({ status, stale, className }: { status: DbStatus; stale?: boolean; className?: string }) {
  const m = statusMeta[status] ?? statusMeta.offline;
  return (
    <span
      className={cx("inline-flex h-7 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-xs font-medium", stale ? "text-fg-3" : m.text, className)}
      title={stale ? "Last status check is out of date" : undefined}
    >
      <span className={cx("size-1.5 rounded-full", stale ? "bg-fg-3" : m.dot, !stale && status !== "ready" && status !== "offline" && "pulse-dot")} />
      {m.label}
      {stale && <span className="font-mono text-[10px] uppercase text-fg-3">stale</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ Tags */
export function Tag({ children, tone = "muted", className }: { children: ReactNode; tone?: "muted" | "ok" | "warn" | "danger" | "accent"; className?: string }) {
  const tones = {
    muted: "border-line-strong text-fg-2 bg-surface-hover",
    ok: "border-ok/30 text-ok bg-ok/10",
    warn: "border-warn/30 text-warn bg-warn/10",
    danger: "border-danger/30 text-danger bg-danger/10",
    accent: "border-accent/30 text-accent bg-accent-subtle",
  };
  return (
    <span className={cx("inline-flex h-5 items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium uppercase tracking-wide [&_svg]:size-3", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-surface-hover px-1 font-mono text-[10px] text-fg-3">{children}</kbd>;
}

/* ------------------------------------------------------------------ KPI strip */
export function KpiStrip({ items, className }: { items: { label: string; value: ReactNode; hint?: ReactNode }[]; className?: string }) {
  return (
    <Panel className={cx("grid grid-cols-2 overflow-hidden sm:grid-cols-3", items.length >= 5 ? "lg:grid-cols-5" : "lg:grid-cols-4", items.length >= 6 && "xl:grid-cols-6", className)}>
      {items.map((it) => (
        <div key={it.label} className="-mb-px -mr-px border-b border-r border-line px-4 py-3.5 [&:last-child:nth-child(odd)]:col-span-2 sm:[&:last-child:nth-child(odd)]:col-span-1">
          <div className="text-[11px] font-medium uppercase tracking-wider text-fg-3">{it.label}</div>
          <div className="num mt-1 truncate text-xl font-medium text-fg">{it.value}</div>
          {it.hint && <div className="mt-0.5 truncate text-xs text-fg-3">{it.hint}</div>}
        </div>
      ))}
    </Panel>
  );
}

/** Two-column definition row used throughout the technical panels. */
export function Row({ label, children, mono = true }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/70 py-2 last:border-0">
      <span className="text-xs text-fg-3">{label}</span>
      <span className={cx("truncate text-right text-[13px] text-fg", mono && "num")}>{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ Overlays */
/*
 * Overlays render through a portal at <body>. They used to render inside the
 * sticky header, whose backdrop-filter makes it the containing block for
 * position:fixed descendants, so the "full-screen" dialog was laid out inside
 * a 56 px bar and clipped above the viewport.
 */
function Portal({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? null : createPortal(children, document.body);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const overlayStack: symbol[] = [];

/** Escape closes, Tab stays inside, focus returns to the opener, page scroll locks.
 * Only the top-most overlay reacts, so Escape in a confirm dialog opened from
 * the inspector closes just the dialog. */
function useOverlay(open: boolean, onClose: () => void, ref: React.RefObject<HTMLElement | null>) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const me = Symbol("overlay");
    overlayStack.push(me);
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => {
      const el = ref.current;
      if (el && !el.contains(document.activeElement)) {
        const auto = el.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE);
        auto?.focus();
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (overlayStack[overlayStack.length - 1] !== me) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab" && ref.current) {
        const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      overlayStack.splice(overlayStack.indexOf(me), 1);
      if (!overlayStack.length) document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, ref]);
}

export function Modal({ open, onClose, title, description, children, width = "max-w-md" }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children: ReactNode; width?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open, onClose, ref);
  const titleId = `modal-title-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <motion.div className="fixed inset-0 z-[70] overflow-y-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={ease}>
            <div className="fixed inset-0 bg-[var(--overlay)]" onClick={onClose} aria-hidden />
            {/* min-h-full + padding keeps the whole dialog reachable on short screens, at 200% zoom and with a mobile keyboard open */}
            <div className="relative flex min-h-full items-center justify-center p-4 sm:p-6">
              <motion.div
                ref={ref}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className={cx("relative flex max-h-[calc(100dvh-2rem)] w-full flex-col rounded-[10px] border border-line-strong bg-surface shadow-2xl shadow-black/20", width)}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={ease}
              >
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-3.5">
                  <div>
                    <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
                    {description && <div className="mt-0.5 text-xs text-fg-3">{description}</div>}
                  </div>
                  <button onClick={onClose} className="rounded-md p-1 text-fg-3 hover:bg-surface-hover hover:text-fg" aria-label="Close dialog">
                    <X className="size-4" />
                  </button>
                </div>
                <div className="overflow-y-auto p-5">{children}</div>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Portal>
  );
}

export function Drawer({ open, onClose, title, subtitle, children, footer, width = "max-w-[560px]" }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  const ref = useRef<HTMLElement>(null);
  useOverlay(open, onClose, ref);
  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <motion.div className="fixed inset-0 z-[60]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={ease}>
            <div className="absolute inset-0 bg-[var(--overlay)]" onClick={onClose} aria-hidden />
            <motion.aside
              ref={ref}
              role="dialog"
              aria-modal="true"
              className={cx("absolute inset-y-0 right-0 flex h-[100dvh] w-full flex-col", width, "border-l border-line-strong bg-surface shadow-2xl shadow-black/25")}
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
            >
              <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold">{title}</div>
                  {subtitle && <div className="mt-2">{subtitle}</div>}
                </div>
                <button onClick={onClose} className="rounded-md p-1 text-fg-3 hover:bg-surface-hover hover:text-fg" aria-label="Close inspector">
                  <X className="size-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
              {footer && <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-5 py-3">{footer}</div>}
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
    </Portal>
  );
}

/* ------------------------------------------------------------------ Toasts */
type Toast = { id: number; tone: "success" | "error" | "info"; text: string };
const ToastCtx = createContext<(tone: Toast["tone"], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const id = useRef(0);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const t = { id: ++id.current, tone, text };
    setToasts((ts) => [...ts.slice(-3), t]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), tone === "error" ? 6000 : 3200);
  }, []);
  const icons = { success: <Check className="size-4 text-ok" />, error: <AlertTriangle className="size-4 text-danger" />, info: <Info className="size-4 text-fg-2" /> };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <Portal>
      {/* Bottom-left on desktop (the editor drawer and its actions live on the right);
          top on phones, where the full-width drawer's actions sit at the bottom. */}
      <div className="pointer-events-none fixed left-4 top-[108px] z-[80] flex md:bottom-4 md:top-auto w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={ease}
              className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line-strong bg-surface-hover px-3.5 py-2.5 text-[13px] text-fg shadow-xl shadow-black/15"
              role="status"
            >
              <span className="mt-0.5">{icons[t.tone]}</span>
              <span>{t.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      </Portal>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/* ------------------------------------------------------------------ Form bits */
export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <span className="text-xs font-medium text-fg-2">{children}</span>
      {hint && <span className="text-[11px] text-fg-3">{hint}</span>}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, disabled }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-canvas p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cx(
            "h-6 rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-50",
            value === o.value ? "bg-surface-hover text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]" : "text-fg-3 hover:text-fg-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-fg-3">{children}</h3>
      {right}
    </div>
  );
}
