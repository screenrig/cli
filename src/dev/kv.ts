import { createHash } from "node:crypto";
import { watch as watchPath, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** A problem as the bridge answers it: the code and status the Player's runtime route would send. */
export interface KvProblem {
  code: string;
  status: number;
  detail: string;
  request_id: string;
  current_revision?: number;
}

export type KvResult<T> = { ok: true; value: T } | { ok: false; problem: KvProblem };

export interface KvSummary {
  application_id: string;
  key: string;
  content_type: string;
  bytes: number;
  sha256: string;
  revision: number;
}

export interface KvEntry extends KvSummary {
  value_base64: string;
}

/** One key of the application changed: a write by the application, an edit of the file, or a delete. */
export interface KvChange {
  key: string;
  revision?: number;
  deleted: boolean;
}

export interface KvWrite {
  valueBase64: string;
  contentType: string;
  expectedRevision?: number;
  idempotencyKey: string;
}

export interface KvDelete {
  expectedRevision?: number;
  idempotencyKey: string;
}

/** The application's stored values as the bridge's kv.* kinds see them. */
export interface KvStore {
  get(key: string): Promise<KvResult<KvEntry>>;
  list(): Promise<KvResult<KvSummary[]>>;
  set(key: string, input: KvWrite): Promise<KvResult<KvEntry>>;
  delete(key: string, input: KvDelete): Promise<KvResult<null>>;
  subscribe(listener: (change: KvChange) => void): () => void;
  close(): Promise<void>;
}

export const KV_FILE_SCHEMA = "screenrig.dev-kv/v1";
export const MAX_KV_VALUE_BYTES = 1 << 20;
const MAX_LIST = 200;
const IDEMPOTENCY_MEMORY = 1000;

let problemSerial = 0;
export function kvProblem(code: string, status: number, detail: string, extra: { current_revision?: number } = {}): KvProblem {
  problemSerial += 1;
  return { code, status, detail, request_id: `dev_${problemSerial.toString(36).padStart(6, "0")}`, ...extra };
}

export function kvFailure(code: string, status: number, detail: string, extra: { current_revision?: number } = {}): { ok: false; problem: KvProblem } {
  return { ok: false, problem: kvProblem(code, status, detail, extra) };
}

/** The key grammar the store enforces: 1 to 256 UTF-8 characters, not the reserved prefix, not a dot segment. */
export function validKvKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 1 && key.length <= 256 && Buffer.from(key, "utf8").toString("utf8") === key
    && !key.startsWith("_screenrig/") && key !== "." && key !== "..";
}

/** A media type the store keeps: lower-cased `type/subtype` with its parameters, at most 127 bytes. */
export function normalizeContentType(value: string): string | undefined {
  const text = value.trim();
  const match = /^([A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*)\/([A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*)((?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*)$/.exec(text);
  if (!match) return undefined;
  // Parameter names are lower-cased with the type, as the real store's media type parser does; values keep their case.
  const parameters = match[3]!.replace(/\s*;\s*([^=;\s]+)=/g, (_whole, name: string) => `; ${name.toLowerCase()}=`);
  const normalized = `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}${parameters}`;
  return normalized.length <= 127 ? normalized : undefined;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Stored {
  value: Buffer;
  contentType: string;
  revision: number;
}

function summary(applicationId: string, key: string, entry: Stored): KvSummary {
  return { application_id: applicationId, key, content_type: entry.contentType, bytes: entry.value.length, sha256: sha256(entry.value), revision: entry.revision };
}

function sameValue(left: Stored, right: Stored): boolean {
  return left.contentType === right.contentType && left.value.equals(right.value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textual(contentType: string): boolean {
  return /^text\//.test(contentType) || /^application\/(?:[a-z.+-]*\+)?json(?:;|$)/.test(contentType);
}

/**
 * The value as the file shows it: a string for text, the JSON value itself for
 * compact JSON, else base64. Reading it back yields the same bytes, so the
 * store's own writes never look like outside edits.
 */
function fileEntry(entry: Stored): Record<string, unknown> {
  const out: Record<string, unknown> = { content_type: entry.contentType };
  const text = textual(entry.contentType) ? entry.value.toString("utf8") : undefined;
  const exact = text !== undefined && Buffer.from(text, "utf8").equals(entry.value);
  if (exact && /json/.test(entry.contentType)) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (JSON.stringify(parsed) === text) out.value = parsed;
      else out.value = text;
    } catch {
      out.value = text;
    }
  } else if (exact) {
    out.value = text;
  } else {
    out.value_base64 = entry.value.toString("base64");
  }
  out.revision = entry.revision;
  return out;
}

/** Reads one entry of the file; `reason` names what is wrong when it cannot be one. */
function readFileEntry(raw: unknown): { entry: Omit<Stored, "revision"> & { revision?: number } } | { reason: string } {
  if (!isRecord(raw)) return { reason: "an entry must be an object" };
  let value: Buffer;
  let contentType: string | undefined;
  if (typeof raw.value_base64 === "string") {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.value_base64)) return { reason: "value_base64 is not base64" };
    value = Buffer.from(raw.value_base64, "base64");
  } else if (typeof raw.value === "string") {
    value = Buffer.from(raw.value, "utf8");
    contentType = "text/plain";
  } else if ("value" in raw && raw.value !== undefined) {
    value = Buffer.from(JSON.stringify(raw.value), "utf8");
    contentType = "application/json";
  } else {
    return { reason: "an entry needs value or value_base64" };
  }
  if (typeof raw.content_type === "string") contentType = raw.content_type;
  else if (raw.content_type !== undefined) return { reason: "content_type must be a string" };
  const normalized = normalizeContentType(contentType ?? "application/octet-stream");
  if (!normalized) return { reason: "content_type is not a media type" };
  if (value.length > MAX_KV_VALUE_BYTES) return { reason: "a value is at most 1 MiB" };
  if (raw.revision !== undefined && (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1)) return { reason: "revision must be a positive integer" };
  return { entry: { value, contentType: normalized, ...(raw.revision === undefined ? {} : { revision: raw.revision as number }) } };
}

export interface FileKvOptions {
  /** Watch the file and push edits made from outside. Off in tests that drive `reload()` themselves. */
  watch?: boolean;
  /** Called with a plain sentence when the file cannot be read; the previous values stay in force. */
  onProblem?: (message: string) => void;
}

/**
 * The default store: one JSON file. Every key keeps its revision, so
 * `expected_revision` conflicts behave as they do against the real store, and a
 * deleted key's next revision continues from the last one. Edits made to the
 * file from outside are noticed, diffed against what the store holds and
 * pushed as changes.
 */
export class FileKvStore implements KvStore {
  private readonly entries = new Map<string, Stored>();
  private readonly fences = new Map<string, number>();
  private readonly listeners = new Set<(change: KvChange) => void>();
  private readonly idempotent = new Map<string, { hash: string; result: KvResult<KvEntry | null> }>();
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private invalid?: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string, private readonly applicationId: string, private readonly options: FileKvOptions = {}) {}

  /** Reads the file (when it exists) and starts watching it. */
  async open(): Promise<void> {
    await this.reload();
    if (this.options.watch !== false) this.startWatching();
  }

  private startWatching(): void {
    const directory = path.dirname(this.file);
    const name = path.basename(this.file);
    const attach = (): void => {
      try {
        this.watcher = watchPath(directory, { persistent: false }, (_event, changed) => {
          if (changed && changed !== name) return;
          clearTimeout(this.timer);
          this.timer = setTimeout(() => { void this.reload(); }, 60);
        });
        this.watcher.on("error", () => undefined);
      } catch {
        // The directory does not exist yet: the first write creates it and re-attaches.
        this.watcher = undefined;
      }
    };
    attach();
    this.reattach = attach;
  }

  private reattach?: () => void;

  /** Serializes work on the file: the application's writes and an outside edit never interleave. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  subscribe(listener: (change: KvChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(change: KvChange): void {
    for (const listener of this.listeners) {
      try { listener(change); } catch { /* a listener never breaks the store */ }
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
    await this.queue;
  }

  /** Re-reads the file and pushes what an outside edit changed. */
  reload(): Promise<void> {
    return this.exclusive(async () => {
      let text: string;
      try {
        text = await readFile(this.file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.invalid = undefined;
          this.applyDisk(new Map(), new Map());
          return;
        }
        this.refuse(`cannot read ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = text.trim() === "" ? { entries: {} } : JSON.parse(text);
      } catch (error) {
        this.refuse(`${this.file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); the previous values stay in force and writes are refused until it is fixed`);
        return;
      }
      if (!isRecord(parsed) || (parsed.entries !== undefined && !isRecord(parsed.entries))) {
        this.refuse(`${this.file} must be an object with an entries object; the previous values stay in force and writes are refused until it is fixed`);
        return;
      }
      const incoming = new Map<string, Omit<Stored, "revision"> & { revision?: number }>();
      for (const [key, raw] of Object.entries(parsed.entries ?? {})) {
        const read = readFileEntry(raw);
        if (!validKvKey(key)) { this.refuse(`${this.file}: ${JSON.stringify(key)} is not a valid key`); return; }
        if ("reason" in read) { this.refuse(`${this.file}: entry ${JSON.stringify(key)}: ${read.reason}`); return; }
        incoming.set(key, read.entry);
      }
      const fences = new Map<string, number>();
      if (isRecord(parsed.deleted)) {
        for (const [key, revision] of Object.entries(parsed.deleted)) {
          if (typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0) fences.set(key, revision);
        }
      }
      this.invalid = undefined;
      const normalized = this.applyDisk(incoming, fences);
      if (normalized) await this.persist();
    });
  }

  private refuse(message: string): void {
    this.invalid = message;
    this.options.onProblem?.(message);
  }

  /**
   * Replaces memory with the file's values, assigning revisions to what the
   * file did not number or changed without numbering, and pushing the changes.
   * Returns whether the file needs rewriting to say what memory now holds.
   */
  private applyDisk(incoming: Map<string, Omit<Stored, "revision"> & { revision?: number }>, fences: Map<string, number>): boolean {
    const changes: KvChange[] = [];
    let rewrite = false;
    for (const [key, fence] of fences) this.fences.set(key, Math.max(this.fences.get(key) ?? 0, fence));
    for (const [key, old] of [...this.entries]) {
      if (incoming.has(key)) continue;
      this.entries.delete(key);
      this.fences.set(key, Math.max(this.fences.get(key) ?? 0, old.revision));
      changes.push({ key, deleted: true });
      rewrite = true;
    }
    for (const [key, next] of incoming) {
      const old = this.entries.get(key);
      const fence = this.fences.get(key) ?? 0;
      if (!old) {
        const revision = next.revision !== undefined && next.revision > fence ? next.revision : fence + 1;
        this.entries.set(key, { value: next.value, contentType: next.contentType, revision });
        changes.push({ key, revision, deleted: false });
        if (revision !== next.revision) rewrite = true;
        continue;
      }
      const edited = !sameValue(old, { ...next, revision: old.revision });
      let revision = old.revision;
      if (edited) revision = next.revision !== undefined && next.revision > old.revision ? next.revision : old.revision + 1;
      else if (next.revision !== undefined && next.revision > old.revision) revision = next.revision;
      if (revision !== next.revision) rewrite = true;
      if (revision === old.revision && !edited) continue;
      this.entries.set(key, { value: next.value, contentType: next.contentType, revision });
      changes.push({ key, revision, deleted: false });
    }
    for (const change of changes) this.publish(change);
    return rewrite;
  }

  private async persist(): Promise<void> {
    const entries: Record<string, unknown> = {};
    for (const key of [...this.entries.keys()].sort()) entries[key] = fileEntry(this.entries.get(key)!);
    const deleted: Record<string, number> = {};
    for (const [key, revision] of [...this.fences].sort(([a], [b]) => (a < b ? -1 : 1))) if (!this.entries.has(key)) deleted[key] = revision;
    const document = { schema: KV_FILE_SCHEMA, entries, ...(Object.keys(deleted).length ? { deleted } : {}) };
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    if (this.options.watch !== false && !this.watcher) this.reattach?.();
  }

  private blocked(): { ok: false; problem: KvProblem } | undefined {
    return this.invalid ? kvFailure("internal_error", 500, this.invalid) : undefined;
  }

  async get(key: string): Promise<KvResult<KvEntry>> {
    return this.exclusive(async () => {
      const entry = this.entries.get(key);
      if (!entry) return kvFailure("not_found", 404, "Key/value entry not found.");
      return { ok: true as const, value: { ...summary(this.applicationId, key, entry), value_base64: entry.value.toString("base64") } };
    });
  }

  async list(): Promise<KvResult<KvSummary[]>> {
    return this.exclusive(async () => {
      const keys = [...this.entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_LIST);
      return { ok: true as const, value: keys.map((key) => summary(this.applicationId, key, this.entries.get(key)!)) };
    });
  }

  private replay<T>(key: string, hash: string): KvResult<T> | undefined {
    const known = this.idempotent.get(key);
    if (!known) return undefined;
    if (known.hash !== hash) return kvFailure("idempotency_mismatch", 409, "This idempotency key was used for a different request.");
    return known.result as KvResult<T>;
  }

  private remember(key: string, hash: string, result: KvResult<KvEntry | null>): void {
    if (this.idempotent.size >= IDEMPOTENCY_MEMORY) this.idempotent.delete(this.idempotent.keys().next().value!);
    this.idempotent.set(key, { hash, result });
  }

  async set(key: string, input: KvWrite): Promise<KvResult<KvEntry>> {
    return this.exclusive(async () => {
      if (!validKvKey(key)) return kvFailure("invalid_request", 400, "The key is not a valid key.");
      if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) return kvFailure("invalid_request", 400, "An idempotency key of 8 to 200 characters is required.");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.valueBase64)) return kvFailure("invalid_request", 400, "value_base64 is invalid.");
      const value = Buffer.from(input.valueBase64, "base64");
      const contentType = normalizeContentType(input.contentType);
      if (value.length > MAX_KV_VALUE_BYTES) return kvFailure("invalid_request", 400, "A value is at most 1 MiB.");
      if (!contentType) return kvFailure("invalid_request", 400, "content_type is not a media type.");
      const hash = createHash("sha256").update(JSON.stringify(["set", key, input.valueBase64, contentType, input.expectedRevision ?? null])).digest("hex");
      const replayed = this.replay<KvEntry>(input.idempotencyKey, hash);
      if (replayed) return replayed;
      const blocked = this.blocked();
      if (blocked) return blocked;
      const current = this.entries.get(key);
      const expected = input.expectedRevision;
      let result: KvResult<KvEntry>;
      if (expected !== undefined && current && expected !== current.revision) {
        result = kvFailure("revision_conflict", 412, "Resource revision does not match.", { current_revision: current.revision });
      } else if (expected !== undefined && !current && expected !== 0) {
        result = kvFailure("revision_conflict", 412, "Resource revision does not match.");
      } else {
        const revision = current ? current.revision + 1 : (this.fences.get(key) ?? 0) + 1;
        const stored: Stored = { value, contentType, revision };
        this.entries.set(key, stored);
        try {
          await this.persist();
        } catch (error) {
          if (current) this.entries.set(key, current); else this.entries.delete(key);
          return kvFailure("internal_error", 500, `cannot write ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.publish({ key, revision, deleted: false });
        result = { ok: true, value: { ...summary(this.applicationId, key, stored), value_base64: value.toString("base64") } };
      }
      this.remember(input.idempotencyKey, hash, result);
      return result;
    });
  }

  async delete(key: string, input: KvDelete): Promise<KvResult<null>> {
    return this.exclusive(async () => {
      if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) return kvFailure("invalid_request", 400, "An idempotency key of 8 to 200 characters is required.");
      const hash = createHash("sha256").update(JSON.stringify(["delete", key, input.expectedRevision ?? null])).digest("hex");
      const replayed = this.replay<null>(input.idempotencyKey, hash);
      if (replayed) return replayed;
      const blocked = this.blocked();
      if (blocked) return blocked;
      const current = this.entries.get(key);
      let result: KvResult<null>;
      if (!current) {
        result = kvFailure("not_found", 404, "Key/value entry not found.");
      } else if (input.expectedRevision !== undefined && input.expectedRevision > 0 && input.expectedRevision !== current.revision) {
        result = kvFailure("revision_conflict", 412, "Resource revision does not match.", { current_revision: current.revision });
      } else {
        this.entries.delete(key);
        this.fences.set(key, Math.max(this.fences.get(key) ?? 0, current.revision));
        try {
          await this.persist();
        } catch (error) {
          this.entries.set(key, current);
          return kvFailure("internal_error", 500, `cannot write ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.publish({ key, deleted: true });
        result = { ok: true, value: null };
      }
      this.remember(input.idempotencyKey, hash, result);
      return result;
    });
  }
}

/** Reads one path of the signed-in API and returns its JSON body; a refusal comes back as a problem. */
export type KvRead = (path: string) => Promise<{ ok: true; body: unknown } | { ok: false; problem: Omit<KvProblem, "request_id"> & { request_id?: string } }>;

/**
 * The application's real store, read through the signed-in CLI and never
 * written, as the dashboard's preview reads it: every write is refused
 * `forbidden`.
 */
export class RemoteKvStore implements KvStore {
  constructor(private readonly applicationId: string, private readonly read: KvRead) {}

  private async fetch<T>(apiPath: string): Promise<KvResult<T>> {
    const answer = await this.read(apiPath);
    if (!answer.ok) return { ok: false, problem: { ...answer.problem, request_id: answer.problem.request_id ?? kvProblem("", 0, "").request_id } };
    return { ok: true, value: answer.body as T };
  }

  async get(key: string): Promise<KvResult<KvEntry>> {
    return this.fetch<KvEntry>(`/api/applications/${encodeURIComponent(this.applicationId)}/kv/${encodeURIComponent(key)}`);
  }

  async list(): Promise<KvResult<KvSummary[]>> {
    const page = await this.fetch<{ items?: KvSummary[] }>(`/api/applications/${encodeURIComponent(this.applicationId)}/kv`);
    if (!page.ok) return page;
    return { ok: true, value: Array.isArray(page.value.items) ? page.value.items : [] };
  }

  async set(): Promise<KvResult<KvEntry>> {
    return kvFailure("forbidden", 403, "Stored values are read-only: this run reads the application's real store (--kv-from).");
  }

  async delete(): Promise<KvResult<null>> {
    return kvFailure("forbidden", 403, "Stored values are read-only: this run reads the application's real store (--kv-from).");
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    return undefined;
  }
}
