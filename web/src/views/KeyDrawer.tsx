import { AlertTriangle, Braces, Check, CheckCircle2, Copy, Lock, Pencil, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type KeyDetail } from "../lib/api";
import { useApp, useNow } from "../lib/app-context";
import { formatBytes, formatClock, formatCountdown } from "../lib/format";
import { Button, Drawer, Label, Modal, Row, SectionTitle, Segmented, Tag, cx, useToast } from "../components/ui";
import { JsonHighlight, jsonKind } from "../components/Json";

/**
 * Key inspector / editor.
 *
 * One Save button commits everything. The "Changes on save" box lists exactly
 * what will happen and which command runs, so nothing takes effect silently.
 * Before writing, the editor re-reads the key: if it expired, was deleted, or
 * was changed by another client since the drawer opened, the user decides
 * (recreate / overwrite / load latest) instead of the edit silently winning.
 */

type Expiry = "keep" | "set" | "remove";
type Unit = "s" | "m" | "h" | "d";
const unitSeconds: Record<Unit, number> = { s: 1, m: 60, h: 3600, d: 86400 };
type Conflict = { kind: "gone" } | { kind: "changed"; latest: KeyDetail } | null;

function useCopy() {
  const toast = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      toast("error", "Clipboard is not available in this browser.");
    }
  };
  return { copied, copy };
}

export function KeyDrawer({ open, keyName, onClose, onChanged }: { open: boolean; keyName: string | null; onClose: () => void; onChanged: () => void }) {
  const creating = keyName === null;
  const { canWrite, openLogin, requireWrite, isReady, cli } = useApp();
  const toast = useToast();
  const now = useNow(250);
  const { copied, copy } = useCopy();

  const [detail, setDetail] = useState<KeyDetail | null>(null); // server state when loaded / last saved
  const [fetchedAt, setFetchedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [expiry, setExpiry] = useState<Expiry>("keep");
  const [amount, setAmount] = useState("60");
  const [unit, setUnit] = useState<Unit>("s");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [conflict, setConflict] = useState<Conflict>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);

  const ready = isReady;

  const apply = (d: KeyDetail) => {
    setDetail(d);
    setFetchedAt(Date.now());
    setValue(d.value);
    setExpiry("keep");
  };

  const load = async (k: string) => {
    setLoading(true);
    setLoadError("");
    try {
      const d = await api.key(k);
      apply(d);
      setView(jsonKind(d.value) ? "preview" : "edit");
    } catch (e) {
      setDetail(null);
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setError("");
    setConflict(null);
    setSavedAt(null);
    if (keyName === null) {
      setDetail(null);
      setName("");
      setValue("");
      setExpiry("keep");
      setAmount("60");
      setUnit("s");
      setView("edit");
      setLoadError("");
    } else {
      setName(keyName);
      load(keyName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keyName]);

  const ttlSeconds = Math.round(Number(amount) * unitSeconds[unit]);
  const ttlValid = Number.isFinite(ttlSeconds) && ttlSeconds >= 1 && ttlSeconds <= 315360000;
  const hadTtl = detail?.ttl_ms != null;
  const remaining = hadTtl ? detail!.ttl_ms! - (now - fetchedAt) : null;
  const expired = remaining != null && remaining <= 0;
  const isJson = jsonKind(value) === "json";
  const binary = !!detail?.binary;
  const valueChanged = creating || !detail || value !== detail.value;
  const key = creating ? name : (keyName ?? "");

  /** The exact command(s) Save will run, plus a human summary. */
  const plan = useMemo(() => {
    const lines: string[] = [];
    let args: (string | number)[] | null = null;
    if (creating) {
      args = ["SET", key || "<key>", value, "NX", ...(expiry === "set" && ttlValid ? ["EX", ttlSeconds] : [])];
      lines.push(`Create the key with a ${new TextEncoder().encode(value).length}-byte value`);
      lines.push(expiry === "set" ? (ttlValid ? `Expires in ${formatCountdown(ttlSeconds * 1000)}` : "Expiration: enter at least 1 second") : "No expiration");
    } else if (valueChanged) {
      args = ["SET", key, value];
      if (expiry === "set" && ttlValid) args.push("EX", ttlSeconds);
      if (expiry === "keep" && hadTtl) args.push("KEEPTTL");
      lines.push(`Value: ${formatBytes(detail?.size ?? 0)} → ${formatBytes(new TextEncoder().encode(value).length)}`);
      lines.push(
        expiry === "set" ? `Expiration: reset to ${formatCountdown(ttlSeconds * 1000)} from now`
          : expiry === "remove" ? "Expiration: removed — key no longer expires"
          : hadTtl ? "Expiration: unchanged (original deadline kept)" : "Expiration: none",
      );
    } else if (expiry === "set" && ttlValid) {
      args = ["EXPIRE", key, ttlSeconds];
      lines.push("Value: unchanged", `Expiration: reset to ${formatCountdown(ttlSeconds * 1000)} from now`);
    } else if (expiry === "remove" && hadTtl) {
      args = ["PERSIST", key];
      lines.push("Value: unchanged", "Expiration: removed — key no longer expires");
    }
    return { args, lines };
  }, [creating, key, value, expiry, ttlValid, ttlSeconds, valueChanged, hadTtl, detail?.size]);

  const noChanges = !plan.args;

  const formatJson = () => {
    try {
      setValue(JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      setError("The value is not valid JSON.");
    }
  };

  const showSaved = () => {
    setSavedAt(Date.now());
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSavedAt(null), 4000);
  };

  const save = () => requireWrite(creating ? "create this key" : "save this key", () => doSave(false));

  const doSave = async (force: boolean) => {
    if (creating && !name.trim()) return setError("Key name is required, e.g. user:42");
    if (expiry === "set" && !ttlValid) return setError("Expiration must be at least 1 second.");
    if (noChanges) return;
    setSaving(true);
    setError("");
    try {
      // Re-read before writing so a concurrent change is never silently overwritten.
      if (!creating && !force) {
        let latest: KeyDetail | null = null;
        try {
          latest = await api.key(keyName!);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
        if (!latest) {
          setConflict({ kind: "gone" });
          return;
        }
        if (detail && !detail.binary && latest.value !== detail.value) {
          setConflict({ kind: "changed", latest });
          return;
        }
      }
      setConflict(null);
      let result: KeyDetail;
      const recreate = force && conflict?.kind === "gone";
      if (creating || valueChanged || recreate) {
        const r = await api.putKey({
          key,
          value,
          ttl_seconds: expiry === "set" ? ttlSeconds : null,
          keep_ttl: expiry === "keep" && hadTtl && !recreate,
          only_if_new: creating,
        });
        result = r.key;
      } else {
        const r = await api.expire(key, expiry === "set" ? ttlSeconds : null);
        result = r.key;
      }
      onChanged();
      if (creating) {
        toast("success", `Created ${result.key}`);
        onClose();
      } else {
        apply(result);
        showSaved();
      }
    } catch (e) {
      // The draft stays in the editor; nothing is lost on failure.
      setError((e as Error).message + " — your edits are still here; try again.");
      if (e instanceof ApiError && e.status === 401) openLogin("save this key");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await api.deleteKey(keyName!);
      toast("success", `Deleted ${keyName}`);
      setConfirmDelete(false);
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canWrite || !ready || saving;
  const expiryOptions: { value: Expiry; label: string }[] =
    !creating && hadTtl
      ? [
          { value: "keep", label: "Keep" },
          { value: "set", label: "Set new" },
          { value: "remove", label: "Remove" },
        ]
      : [
          { value: "keep", label: "No expiration" },
          { value: "set", label: "Set expiration" },
        ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={creating ? "New key" : <span className="font-mono">{keyName}</span>}
      subtitle={
        creating ? (
          <span className="text-xs text-fg-3">Creates the key only if it does not exist (SET … NX).</span>
        ) : detail ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <Tag>string</Tag>
            {isJson && <Tag>json</Tag>}
            <Tag>{formatBytes(detail.size)}</Tag>
            {remaining == null ? <Tag>no expiry</Tag> : expired ? <Tag tone="danger">expired</Tag> : <Tag tone="warn">expires in {formatCountdown(remaining)}</Tag>}
            <button onClick={() => copy("key", keyName!)} className="ml-1 inline-flex items-center gap-1 text-[11px] text-fg-3 hover:text-fg" aria-label="Copy key name">
              {copied === "key" ? <Check className="size-3" /> : <Copy className="size-3" />} copy key
            </button>
          </span>
        ) : null
      }
      footer={
        (creating || detail) && !loading ? (
          <>
            {!creating && (
              <Button variant="danger" onClick={() => requireWrite("delete this key", () => setConfirmDelete(true))} disabled={!ready || saving || expired} icon={<Trash2 />}>
                Delete
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <span aria-live="polite" className="text-xs">
                {savedAt && !saving && (
                  <span className="inline-flex items-center gap-1 text-ok">
                    <CheckCircle2 className="size-3.5" /> Saved {new Date(savedAt).toLocaleTimeString()}
                  </span>
                )}
                {!savedAt && !saving && noChanges && !creating && <span className="text-fg-3">No changes</span>}
              </span>
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <Button
                variant="primary"
                onClick={save}
                loading={saving}
                disabled={!ready || binary && valueChanged || noChanges || (creating && !name.trim()) || conflict !== null}
                icon={canWrite ? <Save /> : <Lock />}
              >
                {creating ? "Create key" : "Save"}
              </Button>
            </div>
          </>
        ) : undefined
      }
    >
      {loading && (
        <div className="space-y-3">
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton h-48 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      )}
      {!loading && loadError && !creating && <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-[13px] text-danger">{loadError}</div>}

      {!loading && (creating || detail) && (
        <div className="space-y-6">
          {!canWrite && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5 text-[13px] text-fg-2">
              <span className="flex items-center gap-2"><Lock className="size-3.5" /> Read-only session</span>
              <Button size="sm" variant="secondary" onClick={() => openLogin("edit this key")}>Sign in to edit</Button>
            </div>
          )}

          {conflict && (
            <div role="alert" className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-[13px]">
              <div className="flex items-center gap-2 font-medium text-warn">
                <AlertTriangle className="size-4" />
                {conflict.kind === "gone" ? "This key no longer exists" : "Another client changed this key"}
              </div>
              <p className="mt-1 text-xs text-fg-2">
                {conflict.kind === "gone"
                  ? "It expired or was deleted while the editor was open. Saving now creates it again with your value."
                  : `Since you opened it, its value changed (${formatBytes(detail?.size ?? 0)} → ${formatBytes(conflict.latest.size)}). Saving would overwrite that change.`}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => doSave(true)} loading={saving}>
                  {conflict.kind === "gone" ? "Recreate key" : "Overwrite with my edit"}
                </Button>
                {conflict.kind === "changed" && (
                  <Button size="sm" variant="secondary" onClick={() => { apply(conflict.latest); setConflict(null); }}>
                    Load latest (discard my edit)
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>Keep editing</Button>
              </div>
            </div>
          )}

          {expired && !conflict && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-[13px] text-danger">
              The expiration time passed — the key no longer exists on the server. Saving will ask before recreating it.
            </div>
          )}

          {creating && (
            <div>
              <Label hint="namespace with colons">Key</Label>
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} autoFocus placeholder="user:42" className="field h-9 w-full px-3 font-mono text-[13px]" aria-label="Key name" />
            </div>
          )}

          <section>
            <SectionTitle
              right={
                <span className="flex items-center gap-2">
                  <span className="num text-[11px] text-fg-3">{new TextEncoder().encode(value).length} B</span>
                  {isJson && !binary && (
                    <>
                      <Segmented value={view} onChange={setView} options={[{ value: "preview", label: "Preview" }, { value: "edit", label: "Edit" }]} />
                      {view === "edit" && <Button size="sm" variant="ghost" onClick={formatJson} disabled={disabled} icon={<Braces />}>Format</Button>}
                    </>
                  )}
                </span>
              }
            >
              Value
            </SectionTitle>
            {binary ? (
              <div className="rounded-lg border border-line bg-canvas p-3 text-xs text-fg-2">
                Binary value, shown as base64. Edit it with the CLI; the expiration can still be changed here.
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-fg-3">{value}</pre>
              </div>
            ) : isJson && view === "preview" ? (
              <button onClick={() => setView("edit")} className="group relative block w-full rounded-lg border border-line bg-canvas p-3 text-left" aria-label="Edit value">
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[12.5px] leading-relaxed">
                  <JsonHighlight text={(() => { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } })()} />
                </pre>
                <span className="absolute right-2 top-2 hidden items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-fg-3 group-hover:flex"><Pencil className="size-3" /> edit</span>
              </button>
            ) : (
              <textarea
                value={value}
                onChange={(e) => { setValue(e.target.value); setSavedAt(null); }}
                disabled={disabled}
                rows={8}
                spellCheck={false}
                placeholder='any string — e.g. {"name": "Asha"}'
                className="field w-full resize-y px-3 py-2.5 font-mono text-[12.5px] leading-relaxed"
                aria-label="Value"
              />
            )}
            {detail?.truncated && <p className="mt-1.5 text-[11px] text-warn">Showing the first 1 MB.</p>}
          </section>

          <section>
            <SectionTitle right={<Segmented value={expiry} onChange={(v) => { setExpiry(v); setSavedAt(null); }} disabled={disabled} options={expiryOptions} />}>
              Expiration
            </SectionTitle>
            <div className="rounded-lg border border-line bg-canvas px-3 py-1">
              {expiry === "set" && (
                <div className="flex flex-wrap items-center gap-2 py-2">
                  <span className="text-xs text-fg-3">Expire in</span>
                  <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} disabled={disabled} className="field num h-8 w-24 px-2.5 text-[13px]" aria-label="Expiration amount" />
                  <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)} disabled={disabled} className="field h-8 px-2 text-[13px]" aria-label="Expiration unit">
                    <option value="s">seconds</option>
                    <option value="m">minutes</option>
                    <option value="h">hours</option>
                    <option value="d">days</option>
                  </select>
                </div>
              )}
              {!creating && detail && (
                <>
                  <Row label="Current">
                    {remaining == null ? <span className="text-fg-3">never expires</span> : expired ? <span className="text-danger">expired</span> : <span className="text-warn">{formatCountdown(remaining)} left</span>}
                  </Row>
                  {detail.expire_at_ms && <Row label="Deadline">{formatClock(detail.expire_at_ms)} <span className="text-fg-3">· {detail.expire_at_ms}</span></Row>}
                </>
              )}
              {creating && expiry === "keep" && <p className="py-2 text-xs text-fg-3">The key stays until it is deleted.</p>}
            </div>
            <p className="mt-2 text-[11px] text-fg-3">Deadlines are stored as absolute Unix-ms timestamps, so a restart never extends a key's lifetime.</p>
          </section>

          <section>
            <SectionTitle>Changes on save</SectionTitle>
            <div className="rounded-lg border border-line bg-canvas p-3">
              {noChanges ? (
                <p className="text-xs text-fg-3">Nothing to save yet — edit the value or choose a different expiration.</p>
              ) : (
                <>
                  <ul className="space-y-1 text-[13px] text-fg-2">
                    {plan.lines.map((l) => <li key={l}>• {l}</li>)}
                  </ul>
                  <div className="mt-2.5 flex items-start gap-2 border-t border-line pt-2.5">
                    <code className="flex-1 break-all font-mono text-xs leading-relaxed text-fg-2">
                      <span className="select-none text-fg-3">$ </span>
                      {cli(plan.args!)}
                    </code>
                    <button onClick={() => copy("cmd", cli(plan.args!))} className={cx("rounded-md p-1 hover:bg-surface-hover", copied === "cmd" ? "text-ok" : "text-fg-3 hover:text-fg")} aria-label="Copy command">
                      {copied === "cmd" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>

          {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-[13px] text-danger">{error}</p>}
        </div>
      )}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete key">
        <p className="text-[13px] text-fg-2">
          Runs <code className="font-mono text-fg">DEL {keyName}</code>. The deletion is written to the log, so it survives restarts.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={remove} loading={saving} icon={<Trash2 />}>Delete</Button>
        </div>
      </Modal>
    </Drawer>
  );
}
