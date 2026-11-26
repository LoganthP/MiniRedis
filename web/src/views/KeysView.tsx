import { Check, ChevronLeft, ChevronRight, Clock, Copy, Database, FileUp, Plus, RefreshCw, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Dataset, type KeySummary } from "../lib/api";
import { useApp, useNow } from "../lib/app-context";
import { formatBytes, formatCountdown, formatNumber } from "../lib/format";
import { ReadGate } from "../components/Shell";
import { Button, Kbd, KpiStrip, Panel, PanelHeader, Tag, cx, useToast } from "../components/ui";
import { JsonHighlight, jsonKind } from "../components/Json";
import { KeyDrawer } from "./KeyDrawer";
import { ImportDrawer } from "./ImportDrawer";

const PAGE_SIZES = [25, 50, 100];

/** Filter and page size live in the URL (#/keys?q=demo:&n=50) so a refresh or a shared link keeps them. */
function readHashParams() {
  const qs = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const n = Number(qs.get("n"));
  return { q: qs.get("q") ?? "", n: PAGE_SIZES.includes(n) ? n : 25 };
}

function writeHashParams(q: string, n: number) {
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (n !== 25) qs.set("n", String(n));
  const str = qs.toString();
  const next = `#/keys${str ? `?${str}` : ""}`;
  if (window.location.hash !== next) window.history.replaceState(null, "", next);
}

function toPattern(q: string) {
  const t = q.trim();
  if (!t) return "*";
  return /[*?[]/.test(t) ? t : `*${t}*`;
}

export function TtlCell({ left }: { left: number | null }) {
  if (left == null) return <span className="num text-xs text-fg-3">—</span>;
  if (left <= 0) return <span className="num text-xs text-danger">expired</span>;
  return (
    <span className="num inline-flex items-center gap-1.5 text-xs text-warn">
      <span className="size-1.5 rounded-full bg-warn" />
      {formatCountdown(left)}
    </span>
  );
}

export function KeysView() {
  const { overview, canRead, session, requireWrite, refreshOverview, live, isReady, cli } = useApp();
  const toast = useToast();
  const now = useNow(500);
  const initial = useRef(readHashParams()).current;
  const [query, setQuery] = useState(initial.q);
  const [pattern, setPattern] = useState(toPattern(initial.q));
  const [pageSize, setPageSize] = useState(initial.n);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [cursors, setCursors] = useState<number[]>([0]);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<KeySummary[]>([]);
  const [nextCursor, setNextCursor] = useState(0);
  const [total, setTotal] = useState(0);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<{ open: boolean; key: string | null }>({ open: false, key: null });
  const [seeding, setSeeding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const ready = isReady;
  const reqId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (cursor: number, quiet = false) => {
      if (!canRead) return;
      const id = ++reqId.current;
      // Cancel the previous request so a slow, outdated filter never overwrites a newer one.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      if (!quiet) setLoading(true);
      try {
        const r = await api.keys(cursor, pageSize, pattern, ctrl.signal);
        if (id !== reqId.current) return;
        setRows(r.keys);
        setNextCursor(r.next_cursor);
        setTotal(r.total);
        setFetchedAt(Date.now());
        setError("");
      } catch (e) {
        if (id !== reqId.current || (e as Error).name === "AbortError") return;
        setError((e as Error).message);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [pageSize, pattern, canRead],
  );

  useEffect(() => writeHashParams(query.trim(), pageSize), [query, pageSize]);

  const copyRow = async (key: string) => {
    try {
      await navigator.clipboard.writeText(cli(["GET", key]));
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
    } catch {
      toast("error", "Clipboard is not available in this browser.");
    }
  };

  useEffect(() => {
    const t = setTimeout(() => setPattern(toPattern(query)), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    setCursors([0]);
    setPage(0);
    load(0);
  }, [load]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // "/" focuses search, like most developer consoles.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Live mode refreshes the visible page every 5 s.
  useEffect(() => {
    if (!live || !ready) return;
    const t = window.setInterval(() => load(cursors[page], true), 5000);
    return () => window.clearInterval(t);
  }, [live, ready, load, cursors, page]);

  const wasReady = useRef(ready);
  useEffect(() => {
    if (ready && !wasReady.current) load(cursors[page], true);
    wasReady.current = ready;
  }, [ready, load, cursors, page]);

  const anyExpired = rows.some((r) => r.ttl_ms != null && r.ttl_ms - (now - fetchedAt) <= 0);
  useEffect(() => {
    if (!anyExpired || !live) return;
    const t = setTimeout(() => load(cursors[page], true), 1200);
    return () => clearTimeout(t);
  }, [anyExpired, live, load, cursors, page]);

  const goNext = () => {
    if (!nextCursor) return;
    setCursors([...cursors.slice(0, page + 1), nextCursor]);
    setPage(page + 1);
    load(nextCursor);
  };
  const goPrev = () => {
    if (page === 0) return;
    setPage(page - 1);
    load(cursors[page - 1]);
  };
  const refresh = () => {
    load(cursors[page], true);
    refreshOverview();
  };

  const seed = () => requireWrite("load the sample dataset", doSeed);
  const doSeed = async () => {
    setSeeding(true);
    try {
      const r = await api.sampleData();
      toast("success", `Sample data under ${r.prefix}*: ${r.added} added · ${r.reset} reset to sample value · ${r.unchanged} unchanged. Other keys untouched.`);
      setQuery("demo:");
      refreshOverview();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSeeding(false);
    }
  };

  const openNew = () => requireWrite("create a key", () => setDrawer({ open: true, key: null }));
  const openImport = () => requireWrite("import a dataset", () => setImportOpen(true));

  const loadDatasets = useCallback(async () => {
    if (!canRead) return;
    try {
      setDatasets((await api.datasets()).datasets);
    } catch {
      /* the strip is optional */
    }
  }, [canRead]);
  useEffect(() => {
    loadDatasets();
  }, [loadDatasets, ready]);
  useEffect(() => {
    if (!live || !ready || datasets.length === 0) return;
    const t = window.setInterval(loadDatasets, 10000);
    return () => window.clearInterval(t);
  }, [live, ready, datasets.length, loadDatasets]);

  const onImported = useCallback(
    (prefix: string, show: boolean) => {
      loadDatasets();
      refreshOverview();
      if (show) setQuery(prefix);
      else load(cursors[page], true);
    },
    [loadDatasets, refreshOverview, load, cursors, page],
  );

  return (
    <div className="space-y-4">
      <KpiStrip
        items={[
          { label: "Keys", value: formatNumber(overview?.keyspace?.keys ?? total) },
          { label: "With TTL", value: formatNumber(overview?.keyspace?.expires) },
          { label: "Dataset", value: formatBytes(overview?.memory?.used_memory_dataset) },
          { label: "Expired", value: formatNumber(overview?.stats?.expired_keys), hint: "since start" },
          { label: "Ops / sec", value: formatNumber(Number(overview?.stats?.instantaneous_ops_per_sec ?? 0)), hint: "1 s window" },
        ]}
      />

      <Panel>
        <PanelHeader
          icon={<Database />}
          title="Key explorer"
          meta={
            !canRead ? <span>sign in to browse</span> :
            <span>
              <span className="num">{formatNumber(total)}</span> keys · pattern <span className="num text-fg-2">{pattern}</span> via SCAN
            </span>
          }
          right={
            session && !canRead ? undefined : (
            <>
              <Button size="sm" variant="ghost" onClick={refresh} icon={<RefreshCw className={cx(loading && "animate-spin")} />} aria-label="Refresh">
                <span className="hidden sm:inline">Refresh</span>
              </Button>
              <Button size="sm" variant="secondary" onClick={seed} loading={seeding} disabled={!ready} icon={<Sparkles />} title="Adds 16 example keys under demo:*" aria-label="Sample data">
                <span className="hidden sm:inline">Sample data</span>
              </Button>
              <Button size="sm" variant="secondary" onClick={openImport} disabled={!ready} icon={<FileUp />} title="Import rows from a ZIP, CSV, TSV, JSON or JSON Lines file" aria-label="Import dataset">
                <span className="hidden sm:inline">Import dataset</span>
              </Button>
              <Button size="sm" variant="primary" onClick={openNew} disabled={!ready} icon={<Plus />}>
                New key
              </Button>
            </>
            )
          }
        />

        {session && !canRead ? (
          <ReadGate what="keys" />
        ) : (
        <>
        <div className="border-b border-line p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter keys — text, or a glob like user:*"
              className="field h-9 w-full pl-9 pr-12 font-mono text-[13px]"
              aria-label="Search keys"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2"><Kbd>/</Kbd></span>
          </div>
          {datasets.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] text-fg-3">Imported</span>
              {datasets.map((d) => {
                const active = query.trim() === d.prefix;
                return (
                  <button
                    key={d.prefix}
                    onClick={() => setQuery(active ? "" : d.prefix)}
                    title={`${d.source} · id ${d.id_column} · imported ${new Date(d.created_ms).toLocaleString()}`}
                    aria-pressed={active}
                    className={cx(
                      "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors",
                      active ? "border-accent/60 bg-accent/5 text-fg" : "border-line bg-canvas text-fg-2 hover:border-line-strong hover:text-fg",
                    )}
                  >
                    <span className="font-mono">{d.prefix}</span>
                    <span className="num text-fg-3">{d.live_keys == null ? "—" : formatNumber(d.live_keys)}</span>
                    {d.ttl_seconds ? <Clock className="size-3 text-warn" aria-label={`TTL ${d.ttl_seconds} s`} /> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {error && <div className="m-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-[13px] text-danger">{error}</div>}

        {!error && rows.length > 0 && (
          <ul className={cx("divide-y divide-line/70 md:hidden", loading && "opacity-60")}>
            {rows.map((r) => {
              const left = r.ttl_ms != null ? r.ttl_ms - (now - fetchedAt) : null;
              const kind = jsonKind(r.preview);
              return (
                <li key={r.key}>
                  <button onClick={() => setDrawer({ open: true, key: r.key })} className="block w-full px-4 py-3 text-left active:bg-surface-hover">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[13px] text-fg">{r.key}</span>
                      <TtlCell left={left} />
                    </div>
                    <div className="mt-1 truncate font-mono text-xs">
                      {r.preview == null ? <span className="text-fg-3">{formatBytes(r.size)}</span> : kind ? <JsonHighlight text={r.preview} /> : <span className="text-fg-2">{r.preview}</span>}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1">
                      <Tag>str</Tag>
                      {kind && <Tag>json</Tag>}
                      <span className="num ml-auto text-[11px] text-fg-3">{formatBytes(r.size)}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {!error && (
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[720px] table-fixed text-left">
              <colgroup>
                <col className="w-[92px]" />
                <col className="w-[32%]" />
                <col />
                <col className="w-[120px]" />
                <col className="w-[84px]" />
              </colgroup>
              <thead>
                <tr className="border-b border-line text-[11px] font-medium uppercase tracking-wider text-fg-3">
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Key</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">TTL</th>
                  <th className="px-4 py-2 text-right font-medium">Size</th>
                </tr>
              </thead>
              <tbody className={cx(loading && rows.length > 0 && "opacity-60")}>
                {loading && rows.length === 0 &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b border-line/70">
                      <td colSpan={5} className="px-4 py-2.5"><div className="skeleton h-4 w-full" /></td>
                    </tr>
                  ))}
                {rows.map((r) => {
                  const left = r.ttl_ms != null ? r.ttl_ms - (now - fetchedAt) : null;
                  const kind = jsonKind(r.preview);
                  const selected = drawer.open && drawer.key === r.key;
                  return (
                    <tr
                      key={r.key}
                      onClick={() => setDrawer({ open: true, key: r.key })}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setDrawer({ open: true, key: r.key })}
                      tabIndex={0}
                      className={cx(
                        "group h-10 cursor-pointer border-b border-line/70 transition-colors hover:bg-surface-hover focus:bg-surface-hover focus:outline-none",
                        selected && "bg-surface-hover shadow-[inset_2px_0_0_var(--accent-primary)]",
                      )}
                    >
                      <td className="px-4">
                        <span className="flex gap-1">
                          <Tag>str</Tag>
                          {kind && <Tag>json</Tag>}
                        </span>
                      </td>
                      <td className="truncate px-3 font-mono text-[13px] text-fg">{r.key}</td>
                      <td className="truncate px-3 font-mono text-xs">
                        {r.preview == null ? (
                          <span className="text-fg-3">{r.size > 4096 ? `${formatBytes(r.size)} — open to load` : "binary"}</span>
                        ) : kind ? (
                          <JsonHighlight text={r.preview} />
                        ) : (
                          <span className="text-fg-2">{r.preview}</span>
                        )}
                      </td>
                      <td className="px-3"><TtlCell left={left} /></td>
                      <td className="num px-4 text-right text-xs text-fg-3">
                        <span className="group-hover:hidden group-focus:hidden">{formatBytes(r.size)}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            copyRow(r.key);
                          }}
                          className="hidden items-center gap-1 rounded border border-line-strong px-1.5 py-0.5 text-[10px] text-fg-2 hover:text-fg group-hover:inline-flex group-focus:inline-flex"
                          title={cli(["GET", r.key])}
                          aria-label={`Copy redis-cli GET command for ${r.key}`}
                        >
                          {copiedKey === r.key ? <Check className="size-3 text-ok" /> : <Copy className="size-3" />} GET
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!error && !loading && rows.length === 0 && (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="grid size-10 place-items-center rounded-lg border border-line bg-surface-hover text-fg-2">
              <Database className="size-4" />
            </span>
            <h3 className="mt-4 text-sm font-semibold">{pattern !== "*" ? "No keys match this filter" : "No keys yet"}</h3>
            <p className="mt-1 max-w-sm text-[13px] text-fg-3">
              {pattern !== "*" ? "Try a shorter filter or clear it." : "Create a key, load the sample keys, or import a dataset (ZIP, CSV, JSON Lines)."}
            </p>
            {pattern === "*" && (
              <div className="mt-5 flex gap-2">
                <Button variant="secondary" onClick={seed} loading={seeding} disabled={!ready} icon={<Sparkles />}>Load sample data</Button>
                <Button variant="secondary" onClick={openImport} disabled={!ready} icon={<FileUp />}>Import dataset</Button>
                <Button variant="primary" onClick={openNew} disabled={!ready} icon={<Plus />}>New key</Button>
              </div>
            )}
          </div>
        )}

        {(rows.length > 0 || page > 0) && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs text-fg-3">
            <div className="flex items-center gap-3">
              <span>
                Page <span className="num text-fg-2">{page + 1}</span>
              </span>
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="field h-7 px-2 text-xs" aria-label="Rows per page">
                {PAGE_SIZES.map((s) => (
                  <option key={s} value={s}>{s} rows</option>
                ))}
              </select>
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="secondary" onClick={goPrev} disabled={page === 0 || loading} icon={<ChevronLeft />}>Prev</Button>
              <Button size="sm" variant="secondary" onClick={goNext} disabled={!nextCursor || loading}>
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        )}
        </>
        )}
      </Panel>

      <ImportDrawer open={importOpen} onClose={() => setImportOpen(false)} onImported={onImported} />
      <KeyDrawer open={drawer.open} keyName={drawer.key} onClose={() => setDrawer((d) => ({ ...d, open: false }))} onChanged={refresh} />
    </div>
  );
}
