import type { ReactNode } from "react";

/** Detect whether a string value holds JSON (object or array). */
export function jsonKind(v: string | null | undefined): "json" | null {
  if (!v) return null;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    JSON.parse(t);
    return "json";
  } catch {
    return null;
  }
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

/**
 * Restrained syntax tint: keys muted, strings bright, literals in the accent
 * tint, punctuation dim. Works on single-line previews and pretty-printed text.
 */
export function JsonHighlight({ text, className }: { text: string; className?: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      if (m[2] !== undefined) {
        out.push(<span key={i++} className="text-fg-2">{m[1]}</span>, <span key={i++} className="text-fg-3">{m[2]}</span>);
      } else {
        out.push(<span key={i++} className="text-fg">{m[1]}</span>);
      }
    } else if (m[3] !== undefined) {
      out.push(<span key={i++} className="text-[var(--syntax-literal)]">{m[3]}</span>);
    } else if (m[4] !== undefined) {
      out.push(<span key={i++} className="italic text-[var(--syntax-literal)]">{m[4]}</span>);
    } else {
      out.push(<span key={i++} className="text-fg-3">{m[5]}</span>);
    }
    last = TOKEN.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return <span className={className}>{out}</span>;
}

/** Wire bytes with the CRLF delimiters dimmed so the RESP framing reads clearly. */
export function WireBytes({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\\r\\n)/g);
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p === "\\r\\n" ? (
          <span key={i} className="text-fg-3/60">\r\n</span>
        ) : (
          <span key={i} className={/^[*$]\d+$/.test(p) ? "text-[var(--syntax-literal)]" : "text-fg-2"}>
            {p}
          </span>
        ),
      )}
    </span>
  );
}
