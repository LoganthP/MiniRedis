import { CornerDownLeft, Eraser, Lock, Terminal, BookOpen } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type Reply } from "../lib/api";
import { useApp } from "../lib/app-context";
import { Button, Kbd, Panel, PanelHeader, Tag, cx } from "../components/ui";
import { JsonHighlight, WireBytes, jsonKind } from "../components/Json";
import { ReadGate } from "../components/Shell";

interface Entry {
  id: number;
  input: string;
  reply?: Reply;
  wire?: string;
  error?: string;
  ms?: number;
}

const REFERENCE: { group: string; items: { syntax: string; desc: string; example: string; write?: boolean }[] }[] = [
  {
    group: "Strings",
    items: [
      { syntax: "SET key value [NX|XX] [EX s|PX ms] [KEEPTTL] [GET]", desc: "Store a value, optionally with a TTL.", example: "SET user:42 'Asha Rao' EX 300", write: true },
      { syntax: "GET key", desc: "Read a value; (nil) if missing or expired.", example: "GET user:42" },
      { syntax: "DEL key [key …]", desc: "Delete keys; returns how many existed.", example: "DEL user:42", write: true },
      { syntax: "EXISTS key [key …]", desc: "Count existing keys.", example: "EXISTS user:42" },
      { syntax: "MGET key [key …]", desc: "Read several values.", example: "MGET demo:feature:new-checkout demo:feature:beta-search" },
      { syntax: "STRLEN key", desc: "Value length in bytes.", example: "STRLEN demo:greeting" },
    ],
  },
  {
    group: "Expiration",
    items: [
      { syntax: "EXPIRE key seconds [NX|XX|GT|LT]", desc: "Set a TTL (logged as an absolute deadline).", example: "EXPIRE user:42 120", write: true },
      { syntax: "TTL key", desc: "Seconds left · -1 no TTL · -2 missing.", example: "TTL user:42" },
      { syntax: "PTTL key", desc: "Milliseconds left.", example: "PTTL user:42" },
      { syntax: "PEXPIRETIME key", desc: "Absolute deadline in Unix ms.", example: "PEXPIRETIME user:42" },
      { syntax: "PERSIST key", desc: "Remove the TTL.", example: "PERSIST user:42", write: true },
    ],
  },
  {
    group: "Server",
    items: [
      { syntax: "PING [message]", desc: "Round-trip check.", example: "PING" },
      { syntax: "SCAN cursor [MATCH p] [COUNT n]", desc: "Page through keys in sorted order.", example: "SCAN 0 MATCH demo:* COUNT 10" },
      { syntax: "DBSIZE", desc: "Number of keys.", example: "DBSIZE" },
      { syntax: "INFO [section]", desc: "Server, persistence and recovery stats.", example: "INFO persistence" },
      { syntax: "AOF TAIL [count]", desc: "Newest log records with offsets and CRC32.", example: "AOF TAIL 5" },
      { syntax: "SAVE", desc: "Write a snapshot and compact the log.", example: "SAVE", write: true },
      { syntax: "RECOVERY LAST|HISTORY", desc: "What happened at startup.", example: "RECOVERY LAST" },
    ],
  },
];

const HISTORY_KEY = "miniredis.history";

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function quoteBulk(s: string) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

const PREVIEW_LINES = 24;
const MAX_CHARS = 200_000;

/** Structured bulk replies (JSON) are pretty-printed and collapsed; long text is capped. */
function LongText({ text, json }: { text: string; json: boolean }) {
  const [open, setOpen] = useState(false);
  const pretty = json ? (() => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } })() : text;
  const capped = pretty.length > MAX_CHARS ? pretty.slice(0, MAX_CHARS) : pretty;
  const lines = capped.split("\n");
  const shown = open ? capped : lines.slice(0, PREVIEW_LINES).join("\n");
  return (
    <span className="block">
      <span className="mb-1 flex items-center gap-2 font-sans text-[11px] text-fg-3">
        {json ? "JSON" : "text"} · {lines.length} lines · {pretty.length.toLocaleString()} chars
        <button
          onClick={() => navigator.clipboard?.writeText(text).catch(() => undefined)}
          className="rounded border border-line px-1.5 text-[10px] uppercase hover:text-fg"
        >
          copy raw
        </button>
      </span>
      <span className="block max-h-[480px] overflow-auto whitespace-pre rounded border border-line bg-surface px-2.5 py-2 text-[12px] leading-relaxed">
        {json ? <JsonHighlight text={shown} /> : <span className="text-fg-2">{shown}</span>}
      </span>
      {lines.length > PREVIEW_LINES && (
        <button onClick={() => setOpen((o) => !o)} className="mt-1 font-sans text-[11px] text-fg-3 hover:text-fg">
          {open ? "Collapse" : `Show all ${lines.length} lines`}
        </button>
      )}
      {pretty.length > MAX_CHARS && <span className="block font-sans text-[11px] text-warn">Preview capped at {MAX_CHARS.toLocaleString()} characters; use copy raw for the full reply.</span>}
    </span>
  );
}

/** Render a reply the way redis-cli prints it (JSON payloads pretty-printed). */
function RenderReply({ r }: { r: Reply }): ReactNode {
  switch (r.type) {
    case "status":
      return <span className="text-fg">{r.value}</span>;
    case "error":
      return <span className="text-danger">(error) {r.value}</span>;
    case "integer":
      return <span className="text-fg">(integer) <span className="num">{r.value}</span></span>;
    case "nil":
      return <span className="text-fg-3">(nil)</span>;
    case "bulk":
      if (r.binary) return <span className="break-all text-fg-2">(binary, base64) {r.value.slice(0, 2000)}{r.value.length > 2000 ? "…" : ""}</span>;
      if (jsonKind(r.value)) return <LongText text={r.value} json />;
      if (r.value.includes("\n") || r.value.length > 2000) return <LongText text={r.value.trimEnd()} json={false} />;
      return <span className="break-all text-fg">{quoteBulk(r.value)}</span>;
    case "array":
      if (r.value.length === 0) return <span className="text-fg-3">(empty array)</span>;
      return (
        <span className="block">
          {r.value.map((item, i) => (
            <span key={i} className="flex gap-2">
              <span className="num shrink-0 text-fg-3">{i + 1})</span>
              <span className="min-w-0"><RenderReply r={item} /></span>
            </span>
          ))}
        </span>
      );
  }
}

export function CommandsView() {
  const { canWrite, canRead, session, requireWrite, overview, isReady } = useApp();
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [hIdx, setHIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [showWire, setShowWire] = useState(false);
  const idRef = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inst = overview?.instance;
  const prompt = `${inst?.host ?? "127.0.0.1"}:${inst?.port ?? 6380}>`;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [entries, showWire]);

  const run = async (cmd: string) => {
    const text = cmd.trim();
    if (!text || busy) return;
    if (text.toLowerCase() === "clear") {
      setEntries([]);
      setInput("");
      return;
    }
    const id = ++idRef.current;
    setEntries((e) => [...e.slice(-199), { id, input: text }]);
    setInput("");
    setHIdx(-1);
    const nh = [text, ...history.filter((h) => h !== text)].slice(0, 50);
    setHistory(nh);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(nh));
    } catch {
      /* ignore */
    }
    setBusy(true);
    try {
      const r = await api.command(text);
      setEntries((e) => e.map((x) => (x.id === id ? { ...x, reply: r.reply, wire: r.wire, ms: r.duration_ms } : x)));
    } catch (err) {
      setEntries((e) => e.map((x) => (x.id === id ? { ...x, error: (err as Error).message } : x)));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") run(input);
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      const i = Math.min(hIdx + 1, history.length - 1);
      if (i >= 0) {
        setHIdx(i);
        setInput(history[i]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const i = hIdx - 1;
      setHIdx(Math.max(i, -1));
      setInput(i >= 0 ? history[i] : "");
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setEntries([]);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Panel className="flex h-[min(calc(100dvh-8.5rem),760px)] min-h-[420px] flex-col overflow-hidden lg:h-[calc(100dvh-8.5rem)] lg:max-h-none">
        <PanelHeader
          icon={<Terminal />}
          title="Console"
          meta="RESP2 over TCP — same protocol as redis-cli"
          right={
            <>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg-3 hover:text-fg-2">
                <input type="checkbox" checked={showWire} onChange={(e) => setShowWire(e.target.checked)} className="accent-[var(--accent-primary)]" />
                Show RESP
              </label>
              <Button size="sm" variant="ghost" onClick={() => setEntries([])} icon={<Eraser />}>Clear</Button>
            </>
          }
        />

        {session && !canRead ? (
          <div className="flex-1"><ReadGate what="the console" /></div>
        ) : (
        <>
        <div ref={scroller} className="flex-1 overflow-y-auto bg-canvas px-4 py-3 font-mono text-[13px] leading-relaxed">
          {entries.length === 0 && (
            <div className="text-fg-3">
              <p># Type a command and press Enter. Quote values with spaces:</p>
              <p className="text-fg-2">#   SET greeting 'hello world' EX 60</p>
              <p># ↑/↓ history · Ctrl+L clear · writes require sign-in</p>
            </div>
          )}
          {entries.map((e) => (
            <div key={e.id} className="group py-1.5">
              <div className="flex items-start justify-between gap-3">
                <span className="break-all">
                  <span className="select-none text-fg-3">{prompt} </span>
                  <span className="text-fg">{e.input}</span>
                </span>
                {e.ms != null && <span className="num shrink-0 text-[11px] text-fg-3">{e.ms.toFixed(2)} ms</span>}
              </div>
              {showWire && e.wire && (
                <div className="my-1 break-all rounded border border-line bg-surface px-2 py-1 text-[11px]">
                  <span className="select-none text-fg-3">→ </span>
                  <WireBytes text={e.wire} />
                </div>
              )}
              <div className="mt-0.5">
                {e.reply ? <RenderReply r={e.reply} /> : e.error ? <span className="font-sans text-[13px] text-danger">{e.error}</span> : <span className="skeleton inline-block h-3.5 w-20 align-middle" />}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-surface p-2.5">
          <span className="hidden select-none pl-1 font-mono text-xs text-fg-3 sm:inline">{prompt}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={isReady ? "GET demo:greeting" : "waiting for the database…"}
            className="field h-9 flex-1 px-3 font-mono text-[13px]"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-label="Command"
          />
          <Button variant="primary" onClick={() => run(input)} loading={busy} disabled={!input.trim()} icon={<CornerDownLeft />}>
            <span className="hidden sm:inline">Run</span>
          </Button>
        </div>
        </>
        )}
      </Panel>

      <Panel className="flex max-h-[520px] flex-col overflow-hidden lg:max-h-[calc(100dvh-8.5rem)]">
        <PanelHeader icon={<BookOpen />} title="Command reference" meta="Click an example to load it" />
        <div className="flex-1 overflow-y-auto">
          {REFERENCE.map((g) => (
            <div key={g.group}>
              <div className="sticky top-0 border-b border-line bg-surface px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-3">{g.group}</div>
              {g.items.map((it) => (
                <button
                  key={it.syntax}
                  onClick={() => {
                    const load = () => {
                      setInput(it.example);
                      inputRef.current?.focus();
                    };
                    if (it.write) requireWrite("run commands that change data", load);
                    else load();
                  }}
                  className={cx("block w-full border-b border-line/70 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover")}
                >
                  <div className="flex items-start justify-between gap-2">
                    <code className="font-mono text-xs text-fg">{it.syntax}</code>
                    {it.write && <Tag tone={canWrite ? "muted" : "muted"}>{!canWrite && <Lock />}write</Tag>}
                  </div>
                  <div className="mt-0.5 text-xs text-fg-3">{it.desc}</div>
                  <code className="mt-1 block truncate font-mono text-[11px] text-fg-2">
                    <span className="text-accent">›</span> {it.example}
                  </code>
                </button>
              ))}
            </div>
          ))}
          <p className="px-4 py-3 text-[11px] text-fg-3">
            Blocked here: <Kbd>QUIT</Kbd> <Kbd>AUTH</Kbd> <Kbd>SHUTDOWN</Kbd> <Kbd>DEBUG</Kbd> — use the Durability tab for crash tests.
          </p>
        </div>
      </Panel>
    </div>
  );
}
