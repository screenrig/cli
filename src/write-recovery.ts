import { createHash } from "node:crypto";
import { readConfigFile, withConfigLock, writeConfigAtomic, type ResolvedConfig, type ScreenRigConfig } from "./config.js";
import { isValidIdempotencyKey, newIdempotencyKey } from "./ids.js";
import { configError, usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";
import type { TransportRequest } from "./transport/types.js";

interface PendingWrite { fingerprint: string; key: string }
type Ledger = NonNullable<ScreenRigConfig["pending_writes"]>;
// Server replay records last 24 hours. Stop earlier rather than silently
// replaying a mutation after the server may have forgotten its key.
const SAFE_REPLAY_MS = 23 * 60 * 60 * 1000;
const commandGroups = new Set(["kv", "comment", "feedback", "operations", "app", "playlist", "media", "screen"]);
const commandActions = new Set(["create", "update", "delete", "upload", "set", "put", "assign", "pair", "unpair", "clear", "toast", "screenshot", "reload", "restart", "cancel", "submit", "set-timezone", "archive", "unarchive", "rotate-public-id", "bug", "feature"]);
function safeCommand(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.split(" ");
  return parts.length === 2 && commandGroups.has(parts[0]!) && commandActions.has(parts[1]!) ? value : null;
}

function ledger(config: ScreenRigConfig): Ledger {
  const value = config.pending_writes === undefined ? {} : config.pending_writes;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.entries(value).some(([hash, entry]) => !/^[a-f0-9]{64}$/.test(hash) ||
        !entry || typeof entry.idempotency_key !== "string" || !isValidIdempotencyKey(entry.idempotency_key) ||
        typeof entry.created_at !== "string" || !Number.isFinite(Date.parse(entry.created_at)))) {
    throw configError("Pending write recovery state is invalid; no request was sent.");
  }
  return value;
}

/** Per-invocation coordinator. Only hashes, keys, timestamps and command names reach disk. */
export class WriteRecovery {
  private readonly touched = new Map<string, PendingWrite>();
  constructor(private readonly resolved: ResolvedConfig, private readonly runtime: CliRuntime, private readonly command?: string) {}

  private async update<T>(work: (config: ScreenRigConfig, pending: Ledger) => T): Promise<T> {
    const fs = { ...this.runtime.fs, env: this.runtime.env, homedir: this.runtime.homedir };
    return withConfigLock(this.resolved.configPath, fs,
      { sleep: this.runtime.sleep, now: () => this.runtime.now().getTime() }, async () => {
        const config = await readConfigFile(this.resolved.configPath, fs);
        if (!config || config.token !== this.resolved.token) {
          throw configError("Agent credential changed during write recovery; retry with the current installation.");
        }
        const pending = ledger(config);
        const result = work(config, pending);
        const { pending_writes: _old, ...rest } = config;
        await writeConfigAtomic(this.resolved.configPath,
          { ...rest, ...(Object.keys(pending).length ? { pending_writes: pending } : {}) }, fs);
        return result;
      });
  }

  async prepare(request: Omit<TransportRequest, "headers"> & { headers?: Record<string, string> }, requestedKey?: string): Promise<PendingWrite> {
    const headers = Object.entries(request.headers ?? {})
      .filter(([name]) => !["x-request-id", "idempotency-key"].includes(name.toLowerCase()))
      .map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => a!.localeCompare(b!));
    const body = request.body === undefined ? undefined : request.body instanceof Uint8Array
      ? request.body : typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const hash = createHash("sha256").update(JSON.stringify([
      this.resolved.apiUrl, this.resolved.token, request.method, request.path,
      Object.entries(request.query ?? {}).sort(), headers, body === undefined ? "absent" : "present",
    ]));
    if (body !== undefined) hash.update(body);
    const fingerprint = hash.digest("hex");
    const pending = await this.update((_config, entries) => {
      const existing = entries[fingerprint];
      const reuse = existing && (!requestedKey || requestedKey === existing.idempotency_key);
      if (reuse && this.runtime.now().getTime() - Date.parse(existing.created_at) >= SAFE_REPLAY_MS) {
        throw usageError("This unresolved write is older than the safe replay window. Run screenrig recovery list and inspect the resource before using screenrig recovery reconcile ID or explicitly supplying a new --idempotency-key for a reconciled write.");
      }
      if (!existing && Object.keys(entries).length >= 256) {
        throw configError("Too many unresolved writes. Run screenrig recovery list, inspect the remote outcome, then use screenrig recovery reconcile ID before starting another mutation.");
      }
      const key = reuse ? existing.idempotency_key : requestedKey ?? newIdempotencyKey();
      entries[fingerprint] = reuse ? existing : { idempotency_key: key, created_at: this.runtime.now().toISOString(),
        ...(safeCommand(this.command) ? { command: safeCommand(this.command)! } : {}) };
      return { fingerprint, key };
    });
    this.touched.set(fingerprint, pending);
    return pending;
  }

  async clear(pending: PendingWrite): Promise<void> {
    await this.update((_config, entries) => {
      if (entries[pending.fingerprint]?.idempotency_key === pending.key) delete entries[pending.fingerprint];
    });
    this.touched.delete(pending.fingerprint);
  }

  get hasPending(): boolean { return this.touched.size > 0; }

  async finish(): Promise<void> {
    if (!this.touched.size) return;
    await this.update((_config, entries) => {
      for (const pending of this.touched.values()) {
        if (entries[pending.fingerprint]?.idempotency_key === pending.key) delete entries[pending.fingerprint];
      }
    });
    this.touched.clear();
  }
}


/** Public recovery identifiers bind one saved generation without exposing its key. */
function recoveryId(fingerprint: string, entry: Ledger[string]): string {
  return "wr_" + createHash("sha256").update(JSON.stringify([fingerprint, entry.idempotency_key, entry.created_at])).digest("hex");
}

export interface RecoveryEntry {
  id: string;
  command: string | null;
  created_at: string;
  replay_expires_at: string;
  replay_status: "within_window" | "expired";
}

function describeEntry(fingerprint: string, entry: Ledger[string], now: number): RecoveryEntry {
  const expiry = Date.parse(entry.created_at) + SAFE_REPLAY_MS;
  return {
    id: recoveryId(fingerprint, entry),
    command: safeCommand(entry.command),
    created_at: entry.created_at,
    replay_expires_at: new Date(expiry).toISOString(),
    replay_status: now >= expiry ? "expired" : "within_window",
  };
}

/** Local-only management; never replays or undoes a remote mutation. */
export async function manageWriteRecovery(
  resolved: ResolvedConfig, runtime: CliRuntime, action: "list" | "show" | "reconcile", id?: string,
): Promise<RecoveryEntry[]> {
  if (action !== "list" && (!id || !/^wr_[a-f0-9]{64}$/.test(id))) {
    throw usageError("Use a recovery ID returned by screenrig recovery list.");
  }
  const fs = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  return withConfigLock(resolved.configPath, fs,
    { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
      const config = await readConfigFile(resolved.configPath, fs);
      const pending = ledger(config ?? { api_url: resolved.apiUrl });
      const entries = Object.entries(pending).map(([fingerprint, entry]) => describeEntry(fingerprint, entry, runtime.now().getTime()));
      entries.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      if (action === "list") return entries;
      const entry = entries.find(entry => entry.id === id);
      if (!entry) throw usageError("Recovery entry is no longer pending. Run screenrig recovery list for current IDs; nothing was changed.");
      if (action === "reconcile") {
        const fingerprint = Object.keys(pending).find(hash => recoveryId(hash, pending[hash]!) === id)!;
        delete pending[fingerprint];
        const { pending_writes: _old, ...rest } = config!;
        await writeConfigAtomic(resolved.configPath,
          { ...rest, ...(Object.keys(pending).length ? { pending_writes: pending } : {}) }, fs);
      }
      return [entry];
    });
}
