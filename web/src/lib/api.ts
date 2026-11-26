// Typed client for the FastAPI dashboard API.

export type DbStatus = "starting" | "recovering" | "ready" | "degraded" | "offline";

export interface AofRecord {
  seq: number;
  op: string;
  args: string[];
  segment: string;
  offset: number;
  length: number;
  crc32: string;
  raw: string;
}

export interface RecoveryReport {
  started_at_ms: number;
  duration_ms: number;
  ok: boolean;
  error: string | null;
  snapshot_loaded: boolean;
  snapshot_seq: number;
  snapshot_keys: number;
  snapshot_created_ms: number | null;
  segments_read: number;
  replayed_ops: number;
  skipped_ops: number;
  truncated_bytes: number;
  truncated_segment: string | null;
  expired_dropped: number;
  keys_after: number;
  last_seq: number;
  notes: string[];
  replay_tail?: AofRecord[];
  redacted?: boolean;
  at?: number;
  run_id?: string;
  process_started_ms?: number;
  listening_ms?: number;
  ready_ms?: number;
  startup_ms?: number;
}

export interface Overview {
  reachable: boolean;
  status: DbStatus;
  instance?: { name: string; host: string; port: number; internal: boolean; public_address: string | null; cli_prefix: string };
  reason?: string;
  degraded_reason?: string | null;
  latency_ms?: number;
  checked_at: number;
  observed_ms?: number;
  server?: Record<string, number | string>;
  clients?: Record<string, number>;
  stats?: Record<string, number>;
  memory?: Record<string, number>;
  persistence?: Record<string, number | string>;
  keyspace?: { keys: number; expires: number };
  recovery?: RecoveryReport | null;
}

export interface KeySummary {
  key: string;
  binary_key: boolean;
  ttl_ms: number | null;
  expire_at_ms: number | null;
  size: number;
  preview: string | null;
}

export interface KeyDetail {
  key: string;
  ttl_ms: number | null;
  expire_at_ms: number | null;
  size: number;
  value: string;
  binary: boolean;
  truncated: boolean;
}

export type Reply =
  | { type: "status"; value: string }
  | { type: "error"; value: string }
  | { type: "integer"; value: number }
  | { type: "nil" }
  | { type: "bulk"; value: string; binary: boolean }
  | { type: "array"; value: Reply[] };

export interface WorkloadBucket {
  t: number;
  requests: number;
  ok: number;
  hits: number;
  misses: number;
  fallbacks: number;
  errors: number;
  p50_ms: number | null;
  p95_ms: number | null;
}

export interface RouteStats {
  requests: number;
  hits: number;
  misses: number;
  fallbacks: number;
  errors: number;
  hit_rate: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  backend_avg_ms: number | null;
}

export interface WorkloadStatus {
  running: boolean;
  rps: number;
  started_at: number | null;
  stop_at: number | null;
  totals: Record<string, number>;
  last_60s: { requests: number; success_rate: number | null; p95_ms: number | null; p50_ms: number | null; hit_rate: number | null; fallbacks: number; errors: number };
  routes: Record<"product" | "order" | "stock" | "cart", RouteStats>;
  series: WorkloadBucket[];
  events: { t_ms: number; kind: string; label: string }[];
  source: string;
  dataset_prefix?: string | null;
  dataset_keys?: number;
  orders_prefix?: string | null;
  order_keys?: number;
  route_sources?: Record<"product" | "order" | "stock" | "cart", "dataset" | "dataset_ids" | "synthetic" | "off">;
  dataset_lookups?: { requests: number; hits: number; misses: number; fallbacks: number; errors: number; hit_rate: number | null; p50_ms: number | null; p95_ms: number | null } | null;
}

export interface ImportFile {
  name: string;
  size: number;
  compressed: number;
  format: "csv" | "tsv" | "json_array" | "jsonl" | null;
  supported: boolean;
  reason: string | null;
}

export interface UploadResult {
  upload_id: string;
  name: string;
  size: number;
  zip: boolean;
  files: ImportFile[];
  limits: { max_upload_mb: number; max_uncompressed_mb: number; max_records: number };
}

export interface ImportPreview {
  file: string;
  format: string;
  columns: string[];
  records: Record<string, unknown>[];
  sampled: number;
  sample_errors: string[];
  suggested_id: string | null;
  unique_in_sample: string[];
}

export interface ImportPlan {
  rows: { row: number; key: string | null; error: string | null; exists: boolean; bytes?: number; value_preview?: string }[];
  existing_under_prefix: number;
}

export interface ImportJob {
  id: string;
  upload_name: string;
  file: string;
  fmt: string;
  id_column: string;
  prefix: string;
  ttl_seconds: number | null;
  on_existing: "skip" | "overwrite";
  max_records: number;
  state: "running" | "done" | "cancelled" | "failed";
  processed: number;
  added: number;
  skipped: number;
  updated: number;
  failed: number;
  failures: string[];
  error: string | null;
  note: string | null;
  started_ms: number;
  finished_ms: number | null;
  elapsed_s: number;
  records_per_sec: number;
}

export interface Dataset {
  id: string;
  created_ms: number;
  prefix: string;
  source: string;
  format: string;
  id_column: string;
  columns: string[];
  ttl_seconds: number | null;
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  processed: number;
  state: string;
  live_keys: number | null;
}

export interface DatasetInsights {
  prefix: string;
  total_keys: number;
  scanned: number;
  ttl_keys: number;
  json_records: number;
  fields: { categorical: string[]; date: string[]; numeric: string[] };
  category_field: string | null;
  date_field: string | null;
  numeric_field: string | null;
  top_categories: { value: string; count: number; avg?: number }[];
  per_month: { t: number; count: number }[];
}

export interface Fingerprint {
  count: number;
  with_ttl: number;
  excluded_expiring_soon: number;
  digest: string;
}

export interface MetricPoint {
  t: number;
  status: string;
  keys?: number;
  expires?: number;
  dataset_bytes?: number;
  expired_per_sec?: number;
  writes_per_sec?: number;
  hit_rate?: number | null;
  ops_per_sec?: number;
  read_p95_ms?: number;
  write_p95_ms?: number;
}

export interface RestoreCheck {
  at_ms: number;
  backup: string;
  ok: boolean;
  error?: string;
  keys?: number;
  with_ttl?: number;
  recovery_ms?: number;
  sampled?: number;
  identical?: number;
  value_differs?: number;
  deadline_differs?: number;
  missing_on_live?: number;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = "miniredis.token";

function loadToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

let token = loadToken();

export function setToken(t: string) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: keep the token in memory only */
  }
}

async function request<T>(method: string, path: string, body?: unknown, params?: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(url.pathname + url.search, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "The dashboard API is not reachable. Is it running?", "API_DOWN");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    let msg = data?.detail;
    if (Array.isArray(msg)) msg = msg.map((d: any) => d.msg).join("; ");
    if (!msg) msg = res.status >= 500 ? "The dashboard API is not reachable. Is it running?" : `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, data?.code ?? (res.status >= 500 && !data ? "API_DOWN" : undefined));
  }
  return data as T;
}

export const api = {
  session: () =>
    request<{ auth_required: boolean; authenticated: boolean; can_read: boolean; public_reads: boolean; crash_demo_enabled: boolean; demo_workload_enabled: boolean }>("GET", "/api/session"),
  login: (password: string) => request<{ token: string; expires_at: number | null }>("POST", "/api/login", { password }),
  overview: () => request<Overview>("GET", "/api/overview"),
  history: () => request<{ history: RecoveryReport[] }>("GET", "/api/recovery/history"),
  keys: (cursor: number, count: number, match: string, signal?: AbortSignal) =>
    request<{ keys: KeySummary[]; next_cursor: number; total: number; match: string }>("GET", "/api/keys", undefined, { cursor, count, match }, signal),
  key: (key: string) => request<KeyDetail>("GET", "/api/key", undefined, { key }),
  putKey: (body: { key: string; value: string; ttl_seconds?: number | null; keep_ttl?: boolean; only_if_new?: boolean }) =>
    request<{ ok: boolean; command: string[]; key: KeyDetail }>("PUT", "/api/key", body),
  expire: (key: string, ttl_seconds: number | null) =>
    request<{ ok: boolean; command: string[]; key: KeyDetail }>("POST", "/api/key/expire", { key, ttl_seconds }),
  deleteKey: (key: string) => request<{ ok: boolean; deleted: number }>("DELETE", "/api/key", undefined, { key }),
  command: (command: string) =>
    request<{ tokens: string[]; reply: Reply; wire: string; duration_ms: number; write: boolean }>("POST", "/api/command", { command }),
  workload: (seconds = 300) => request<WorkloadStatus>("GET", "/api/workload", undefined, { seconds }),
  /** orders_prefix: undefined = pick the newest imported orders dataset, "" = no order lookups */
  workloadStart: (rps: number, duration_s = 600, dataset_prefix?: string | null, orders_prefix?: string) =>
    request<WorkloadStatus>("POST", "/api/workload/start", { rps, duration_s, dataset_prefix: dataset_prefix || null, orders_prefix: orders_prefix ?? null }),
  importPreview: (uid: string, file: string) => request<ImportPreview>("GET", `/api/import/${uid}/preview`, undefined, { file }),
  importPlan: (uid: string, body: { file: string; id_column: string; prefix: string }) => request<ImportPlan>("POST", `/api/import/${uid}/plan`, body),
  importStart: (uid: string, body: { file: string; id_column: string; prefix: string; ttl_seconds: number | null; on_existing: "skip" | "overwrite"; max_records: number | null }) =>
    request<ImportJob>("POST", `/api/import/${uid}/start`, body),
  importJob: (id: string) => request<ImportJob>("GET", `/api/import/jobs/${id}`),
  importCancel: (id: string) => request<ImportJob>("POST", `/api/import/jobs/${id}/cancel`),
  datasets: () => request<{ datasets: Dataset[] }>("GET", "/api/datasets"),
  insights: (prefix: string, category?: string | null, date?: string | null) =>
    request<DatasetInsights>("GET", "/api/datasets/insights", undefined, {
      prefix, ...(category ? { category } : {}), ...(date ? { date } : {}) }),
  fingerprint: (prefixes: string[], cutoff_ms?: number) =>
    request<{ fingerprints: Record<string, Fingerprint>; at_ms: number; cutoff_ms: number }>("POST", "/api/datasets/fingerprint", { prefixes, cutoff_ms }),
  workloadStop: () => request<WorkloadStatus>("POST", "/api/workload/stop"),
  metricsHistory: (minutes = 15) => request<{ points: MetricPoint[]; interval_s: number }>("GET", "/api/metrics/history", undefined, { minutes }),
  saveReport: (kind: string, report: Record<string, unknown>) => request<{ id: string; created_ms: number }>("POST", "/api/reports", { kind, report }),
  reports: (kind?: string) => request<{ reports: (Record<string, unknown> & { id: string; created_ms: number })[] }>("GET", "/api/reports", undefined, kind ? { kind } : undefined),
  restores: () => request<{ restores: RestoreCheck[] }>("GET", "/api/restores"),
  aofTail: (count = 40) => request<{ records: AofRecord[] }>("GET", "/api/aof/tail", undefined, { count }),
  snapshot: () => request<{ ok: boolean; duration_ms: number }>("POST", "/api/snapshot"),
  sampleData: () =>
    request<{ ok: boolean; loaded: number; added: number; reset: number; unchanged: number; prefix: string }>("POST", "/api/sample-data"),
  waitReady: (previous_run_id: string, timeout = 60) =>
    request<{ ready: boolean; run_id: string; observed_ms: number; waited_ms: number; attempts: number; phases: { phase: string; at_ms: number }[] }>(
      "GET", "/api/wait-ready", undefined, { previous_run_id, timeout }),
  crash: (opts: { concurrent_writers?: number; slow_recovery_ms?: number } = {}) =>
    request<{ ok: boolean; sent_at: number; sent_at_ms: number; load_id: string | null; writers: number }>("POST", "/api/demo/crash", opts),
  verifyLoad: (id: string) =>
    request<{ writers: number; acked: number; recovered: number; lost: number; lost_examples: string[]; unacknowledged_attempts: number; persisted_without_ack: number; write_rate_per_sec: number }>(
      "GET", `/api/demo/load/${id}`),
};

/** Upload a file as the raw request body (no multipart), reporting progress. */
export function uploadDataset(file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/import/upload?filename=${encodeURIComponent(file.name)}`);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: any = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as UploadResult);
      else if (xhr.status === 413) reject(new ApiError(413, "The file is larger than the server accepts (proxy limit)."));
      else reject(new ApiError(xhr.status, data?.detail ?? `Upload failed (${xhr.status})`, data?.code));
    };
    xhr.onerror = () => reject(new ApiError(0, "The dashboard API is not reachable. Is it running?", "API_DOWN"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}
