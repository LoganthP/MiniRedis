import { AlertTriangle, Check, CircleSlash, Download, FileArchive, FileText, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  api,
  uploadDataset,
  type ImportFile,
  type ImportJob,
  type ImportPlan,
  type ImportPreview,
  type UploadResult,
} from "../lib/api";
import { formatBytes, formatNumber } from "../lib/format";
import { Button, Drawer, Label, Segmented, SectionTitle, Tag, cx, useToast } from "../components/ui";

const FORMAT_LABEL: Record<string, string> = { csv: "CSV", tsv: "TSV", json_array: "JSON array", jsonl: "JSON Lines" };
const ACCEPT = ".zip,.csv,.tsv,.tab,.txt,.json,.jsonl,.ndjson";

function defaultPrefix(file: string) {
  const base = file.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `dataset:${base || "rows"}:`;
}

function cell(v: unknown) {
  if (v == null) return <span className="text-fg-3">null</span>;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s === "" ? <span className="text-fg-3">""</span> : s;
}

type Phase = "pick" | "configure" | "running" | "finished";

export function ImportDrawer({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (prefix: string, show: boolean) => void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("pick");
  const [uploading, setUploading] = useState<{ name: string; progress: number } | null>(null);
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState<string>("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [idColumn, setIdColumn] = useState("");
  const [prefix, setPrefix] = useState("");
  const [onExisting, setOnExisting] = useState<"skip" | "overwrite">("skip");
  const [expiry, setExpiry] = useState<"none" | "ttl">("none");
  const [ttl, setTtl] = useState("300");
  const [limit, setLimit] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [planError, setPlanError] = useState("");
  const [job, setJob] = useState<ImportJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = () => {
    abortRef.current?.abort();
    setPhase("pick");
    setUpload(null);
    setUploading(null);
    setError("");
    setFile("");
    setPreview(null);
    setPlan(null);
    setJob(null);
    setLimit("");
    setOnExisting("skip"); // safe defaults for every new file
    setExpiry("none");
    setTtl("300");
  };

  // ------------------------------------------------------------- upload
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    reset();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setUploading({ name: f.name, progress: 0 });
    try {
      const r = await uploadDataset(f, (p) => setUploading({ name: f.name, progress: p }), ctrl.signal);
      setUpload(r);
      setPhase("configure");
      // default to the biggest importable file (usually the main table)
      const first = [...r.files].filter((x) => x.supported).sort((a, b) => b.size - a.size)[0];
      if (first) selectFile(r, first.name);
      else setError("None of the files in this upload can be imported. Supported: CSV, TSV, JSON arrays, JSON Lines / NDJSON.");
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setUploading(null);
    }
  };

  const selectFile = async (up: UploadResult, name: string) => {
    setFile(name);
    setPreview(null);
    setPlan(null);
    setPrefix(defaultPrefix(name));
    setPreviewLoading(true);
    try {
      const p = await api.importPreview(up.upload_id, name);
      setPreview(p);
      setIdColumn(p.suggested_id ?? p.columns[0] ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreviewLoading(false);
    }
  };

  // ------------------------------------------------------------- key preview (debounced)
  useEffect(() => {
    if (!upload || !file || !idColumn || phase !== "configure") return;
    const t = setTimeout(async () => {
      try {
        setPlan(await api.importPlan(upload.upload_id, { file, id_column: idColumn, prefix }));
        setPlanError("");
      } catch (e) {
        setPlanError((e as Error).message);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [upload, file, idColumn, prefix, phase]);

  // ------------------------------------------------------------- job polling
  useEffect(() => {
    if (!job || job.state !== "running") return;
    const t = setInterval(async () => {
      try {
        const j = await api.importJob(job.id);
        setJob(j);
        if (j.state !== "running") {
          setPhase("finished");
          onImported(j.prefix, false);
        }
      } catch {
        /* transient; keep polling */
      }
    }, 400);
    return () => clearInterval(t);
  }, [job, onImported]);

  const ttlSeconds = expiry === "ttl" ? Math.floor(Number(ttl)) : null;
  const ttlInvalid = expiry === "ttl" && (!Number.isFinite(ttlSeconds) || (ttlSeconds ?? 0) < 1);
  const limitN = limit.trim() ? Math.floor(Number(limit)) : null;
  const limitInvalid = limitN != null && (!Number.isFinite(limitN) || limitN < 1);
  const badKeys = plan?.rows.filter((r) => r.error).length ?? 0;
  const existing = plan?.rows.filter((r) => r.exists).length ?? 0;

  const start = async () => {
    if (!upload) return;
    setStarting(true);
    try {
      const j = await api.importStart(upload.upload_id, {
        file, id_column: idColumn, prefix, ttl_seconds: ttlSeconds, on_existing: onExisting, max_records: limitN,
      });
      setJob(j);
      setPhase("running");
    } catch (e) {
      toast("error", (e as Error).message);
      if (e instanceof ApiError && /expired/.test(e.message)) reset();
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (job) setJob(await api.importCancel(job.id));
  };

  const close = () => {
    if (phase === "running") {
      toast("info", "The import keeps running on the server. Reopen Import dataset to watch it.");
    }
    onClose();
  };

  const supported = upload?.files.filter((f) => f.supported) ?? [];
  const unsupported = upload?.files.filter((f) => !f.supported) ?? [];

  const footer =
    phase === "configure" ? (
      <>
        <span className="mr-auto text-xs text-fg-3">
          {onExisting === "skip" ? "Existing keys are left untouched." : "Existing keys are replaced."}{" "}
          {expiry === "ttl" && !ttlInvalid ? `Each key expires ${formatNumber(ttlSeconds!)} s after it is written.` : "Keys never expire."}
        </span>
        <Button variant="ghost" onClick={reset}>Start over</Button>
        <Button variant="primary" onClick={start} loading={starting} disabled={!preview || !idColumn || ttlInvalid || limitInvalid || !!planError} icon={<Upload />}>
          Import {limitN ? formatNumber(limitN) : "all"} rows
        </Button>
      </>
    ) : phase === "running" ? (
      <>
        <span className="mr-auto text-xs text-fg-3">Writing in batches of 500 with durable (fsync’d) SETs.</span>
        <Button variant="danger" onClick={cancel} icon={<X />}>Cancel import</Button>
      </>
    ) : phase === "finished" && job ? (
      <>
        <Button variant="ghost" className="mr-auto" onClick={reset}>Import another file</Button>
        <Button variant="primary" onClick={() => { onImported(job.prefix, true); onClose(); }}>Show {job.prefix}* keys</Button>
      </>
    ) : undefined;

  return (
    <Drawer
      open={open}
      onClose={close}
      width="max-w-[780px]"
      title="Import dataset"
      subtitle={<p className="text-xs text-fg-3">One key per row, value stored as a JSON string. ZIP, CSV, TSV, JSON arrays and JSON Lines.</p>}
      footer={footer}
    >
      <div className="space-y-6">
        {/* ---------------------------------------------------------------- source */}
        {(phase === "pick" || phase === "configure") && (
          <section>
            <SectionTitle>1 · Source</SectionTitle>
            {upload ? (
              <div className="flex items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5">
                {upload.zip ? <FileArchive className="size-4 text-fg-2" /> : <FileText className="size-4 text-fg-2" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{upload.name}</div>
                  <div className="num text-[11px] text-fg-3">
                    {formatBytes(upload.size)} · {upload.zip ? `${upload.files.length} files, ${supported.length} importable` : FORMAT_LABEL[upload.files[0]?.format ?? ""] ?? "unsupported"}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => inputRef.current?.click()}>Replace</Button>
              </div>
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); onFile(e.dataTransfer.files[0]); }}
                className={cx(
                  "flex flex-col items-center rounded-lg border border-dashed px-6 py-8 text-center transition-colors",
                  dragging ? "border-accent bg-accent/5" : "border-line-strong bg-canvas",
                )}
              >
                {uploading ? (
                  <div className="w-full max-w-sm">
                    <div className="truncate text-[13px] font-medium">Uploading {uploading.name}</div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-hover">
                      <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(uploading.progress * 100)}%` }} />
                    </div>
                    <div className="num mt-1.5 text-[11px] text-fg-3">{Math.round(uploading.progress * 100)}% · then the server inspects the archive</div>
                  </div>
                ) : (
                  <>
                    <span className="grid size-10 place-items-center rounded-lg border border-line bg-surface-hover text-fg-2"><Upload className="size-4" /></span>
                    <p className="mt-3 text-[13px] font-medium">Drop a ZIP or data file here</p>
                    <p className="mt-1 text-xs text-fg-3">CSV · TSV · JSON array · JSON Lines / NDJSON (also .json files with one object per line). Up to 200 MB upload, 1 GB unpacked.</p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      <Button variant="primary" onClick={() => inputRef.current?.click()} icon={<Upload />}>Choose file</Button>
                      <a
                        href="/api/import/synthetic.zip?products=1000&orders=5000"
                        download
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface-hover px-3 text-[13px] font-medium text-fg hover:bg-[var(--btn-secondary-hover)] [&_svg]:size-3.5"
                      >
                        <Download /> Synthetic shop ZIP (CC0)
                      </a>
                    </div>
                    <p className="mt-4 max-w-md text-[11px] leading-relaxed text-fg-3">
                      Check the licence before you import third-party data into a demo you distribute. For example, the Olist e-commerce dataset on Kaggle is
                      CC BY-NC-SA 4.0: fine for noncommercial testing, not for a client deliverable. The synthetic ZIP is generated here and is CC0.
                    </p>
                  </>
                )}
              </div>
            )}
            <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
            {error && (
              <div className="mt-3 flex gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-[13px] text-danger">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {error}
              </div>
            )}
          </section>
        )}

        {phase === "configure" && upload && (
          <>
            {/* -------------------------------------------------------------- file list */}
            {upload.zip && (
              <section>
                <SectionTitle right={<span className="text-[11px] text-fg-3">pick one file to import</span>}>2 · File in the ZIP</SectionTitle>
                <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                  {supported.map((f) => (
                    <FileRow key={f.name} f={f} selected={f.name === file} onSelect={() => selectFile(upload, f.name)} />
                  ))}
                  {unsupported.map((f) => (
                    <FileRow key={f.name} f={f} selected={false} />
                  ))}
                </ul>
              </section>
            )}

            {/* -------------------------------------------------------------- preview */}
            <section>
              <SectionTitle right={preview && <span className="num text-[11px] text-fg-3">{FORMAT_LABEL[preview.format]} · first {preview.records.length} of {formatNumber(preview.sampled)} sampled rows</span>}>
                {upload.zip ? "3" : "2"} · Preview
              </SectionTitle>
              {previewLoading && <div className="skeleton h-32 w-full" />}
              {preview && (
                <>
                  <div className="max-h-64 overflow-auto rounded-lg border border-line">
                    <table className="min-w-full text-left font-mono text-[11.5px]">
                      <thead className="sticky top-0 bg-surface">
                        <tr className="border-b border-line">
                          {preview.columns.map((c) => (
                            <th key={c} className={cx("whitespace-nowrap px-2.5 py-1.5 font-medium", c === idColumn ? "text-accent" : "text-fg-2")}>
                              {c}{c === idColumn && " · id"}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.records.map((r, i) => (
                          <tr key={i} className="border-b border-line/60 last:border-0">
                            {preview.columns.map((c) => (
                              <td key={c} className="max-w-[220px] truncate whitespace-nowrap px-2.5 py-1.5 text-fg-2">{cell(r[c])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {preview.sample_errors.length > 0 && (
                    <p className="mt-2 text-xs text-warn">{preview.sample_errors.length} bad rows in the sample (they will be reported as failed): {preview.sample_errors[0]}</p>
                  )}
                </>
              )}
            </section>

            {/* -------------------------------------------------------------- settings */}
            {preview && (
              <section>
                <SectionTitle>{upload.zip ? "4" : "3"} · Keys</SectionTitle>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label hint={preview.unique_in_sample.includes(idColumn) ? "unique in sample" : <span className="text-warn">not unique in sample</span>}>ID column</Label>
                    <select value={idColumn} onChange={(e) => setIdColumn(e.target.value)} className="field h-9 w-full px-2.5 font-mono text-[13px]" aria-label="ID column">
                      {preview.columns.map((c) => (
                        <option key={c} value={c}>{c}{preview.unique_in_sample.includes(c) ? "" : " (repeats)"}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label hint="key = prefix + id">Key prefix</Label>
                    <input value={prefix} onChange={(e) => setPrefix(e.target.value)} className="field h-9 w-full px-2.5 font-mono text-[13px]" aria-label="Key prefix" spellCheck={false} />
                  </div>
                  <div>
                    <Label>If a key already exists</Label>
                    <Segmented value={onExisting} onChange={setOnExisting} options={[{ value: "skip", label: "Skip existing" }, { value: "overwrite", label: "Overwrite" }]} />
                  </div>
                  <div>
                    <Label>Expiration</Label>
                    <div className="flex items-center gap-2">
                      <Segmented value={expiry} onChange={setExpiry} options={[{ value: "none", label: "No expiration" }, { value: "ttl", label: "TTL" }]} />
                      {expiry === "ttl" && (
                        <span className="flex items-center gap-1.5">
                          <input value={ttl} onChange={(e) => setTtl(e.target.value)} inputMode="numeric" className={cx("field h-7 w-20 px-2 font-mono text-xs", ttlInvalid && "border-danger")} aria-label="TTL seconds" />
                          <span className="text-xs text-fg-3">s</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    <Label hint={`server limit ${formatNumber(upload.limits.max_records)} rows`}>Rows to import</Label>
                    <input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="numeric" placeholder="All rows" className={cx("field h-9 w-40 px-2.5 font-mono text-[13px]", limitInvalid && "border-danger")} aria-label="Rows to import" />
                    <span className="ml-2 text-xs text-fg-3">first N rows of the file — use this for a smaller test group</span>
                  </div>
                </div>
              </section>
            )}

            {/* -------------------------------------------------------------- key preview */}
            {preview && (
              <section>
                <SectionTitle
                  right={plan && (
                    <span className="text-[11px] text-fg-3">
                      <span className="num">{formatNumber(plan.existing_under_prefix)}</span> keys already under <span className="font-mono">{prefix || "(no prefix)"}</span>
                    </span>
                  )}
                >
                  Resulting keys (nothing written yet)
                </SectionTitle>
                {planError && <p className="text-xs text-danger">{planError}</p>}
                {plan && (
                  <ul className="divide-y divide-line/70 rounded-lg border border-line">
                    {plan.rows.map((r) => (
                      <li key={r.row} className="flex items-center gap-2 px-3 py-1.5">
                        <span className="num w-10 shrink-0 text-[11px] text-fg-3">#{r.row}</span>
                        {r.key ? (
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{r.key}</span>
                        ) : (
                          <span className="flex-1 text-xs text-danger">{r.error}</span>
                        )}
                        {r.key && r.exists && <Tag tone="warn">{onExisting === "skip" ? "exists · skip" : "exists · overwrite"}</Tag>}
                        {r.key && !r.exists && <Tag tone="ok">new</Tag>}
                        {r.bytes != null && <span className="num w-14 shrink-0 text-right text-[11px] text-fg-3">{formatBytes(r.bytes)}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {plan && (badKeys > 0 || existing > 0) && (
                  <p className="mt-2 text-xs text-fg-3">
                    In these first rows: {existing > 0 && <>{existing} already exist{onExisting === "skip" ? " and will be skipped" : " and will be replaced"}. </>}
                    {badKeys > 0 && <span className="text-warn">{badKeys} cannot become keys and will be reported as failed.</span>}
                  </p>
                )}
              </section>
            )}
          </>
        )}

        {/* ---------------------------------------------------------------- progress */}
        {(phase === "running" || phase === "finished") && job && <JobView job={job} />}
      </div>
    </Drawer>
  );
}

function FileRow({ f, selected, onSelect }: { f: ImportFile; selected: boolean; onSelect?: () => void }) {
  const Comp = f.supported ? "button" : "div";
  return (
    <li>
      <Comp
        {...(f.supported ? { onClick: onSelect, type: "button" as const } : {})}
        className={cx(
          "flex w-full items-center gap-3 px-3 py-2 text-left",
          f.supported ? "hover:bg-surface-hover" : "opacity-70",
          selected && "bg-surface-hover shadow-[inset_2px_0_0_var(--accent-primary)]",
        )}
      >
        {f.supported ? (
          <span className={cx("grid size-4 place-items-center rounded-full border", selected ? "border-accent bg-accent text-white" : "border-line-strong")}>
            {selected && <Check className="size-2.5" />}
          </span>
        ) : (
          <CircleSlash className="size-4 text-fg-3" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">{f.name}</span>
          {!f.supported && <span className="block text-[11px] text-fg-3">{f.reason}</span>}
        </span>
        {f.format && <Tag>{FORMAT_LABEL[f.format]}</Tag>}
        <span className="num w-16 text-right text-[11px] text-fg-3">{formatBytes(f.size)}</span>
      </Comp>
    </li>
  );
}

function JobView({ job }: { job: ImportJob }) {
  const done = job.state !== "running";
  const stats = useMemo(
    () => [
      { label: "Processed", value: job.processed },
      { label: "Added", value: job.added, tone: "text-ok" },
      { label: job.on_existing === "skip" ? "Skipped (existed)" : "Overwritten", value: job.on_existing === "skip" ? job.skipped : job.updated },
      { label: "Failed", value: job.failed, tone: job.failed ? "text-danger" : undefined },
    ],
    [job],
  );
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        {job.state === "running" ? (
          <span className="size-2 animate-pulse rounded-full bg-accent" />
        ) : job.state === "done" ? (
          <Check className="size-4 text-ok" />
        ) : (
          <AlertTriangle className={cx("size-4", job.state === "failed" ? "text-danger" : "text-warn")} />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">
            {job.state === "running" ? "Importing…" : job.state === "done" ? "Import finished" : job.state === "cancelled" ? "Import cancelled" : "Import failed"}
          </div>
          <div className="truncate text-xs text-fg-3">
            {job.upload_name} › {job.file} → <span className="font-mono">{job.prefix}&lt;{job.id_column}&gt;</span>
            {job.ttl_seconds ? ` · TTL ${formatNumber(job.ttl_seconds)} s` : " · no expiration"}
          </div>
        </div>
        <span className="num text-xs text-fg-3">{formatNumber(job.records_per_sec)} rows/s · {job.elapsed_s.toFixed(1)} s</span>
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface px-3 py-2.5">
            <div className="text-[11px] text-fg-3">{s.label}</div>
            <div className={cx("num mt-0.5 text-lg font-semibold", s.tone)}>{formatNumber(s.value)}</div>
          </div>
        ))}
      </div>
      {job.note && <p className="text-xs text-fg-3">Note: {job.note}.</p>}
      {job.error && <p className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger">{job.error}</p>}
      {done && job.state === "cancelled" && (
        <p className="text-xs text-fg-3">Rows written before the cancel stay in the database; run the import again with “Skip existing” to continue.</p>
      )}
      {job.failures.length > 0 && (
        <div>
          <SectionTitle right={<span className="num text-[11px] text-fg-3">showing {job.failures.length} of {formatNumber(job.failed)}</span>}>Failed rows</SectionTitle>
          <ul className="max-h-48 overflow-auto rounded-lg border border-line font-mono text-[11.5px]">
            {job.failures.map((f, i) => (
              <li key={i} className="border-b border-line/60 px-3 py-1.5 text-fg-2 last:border-0">{f}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
