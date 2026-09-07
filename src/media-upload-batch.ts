import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Account, Operation } from "./adapters/protocol.js";
import type { ApiClient } from "./client.js";
import type { ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { loggerOf } from "./log/logger.js";
import {
  cleanupPreparedMediaFile,
  hashLocalMediaFile,
  prepareMediaFileForUpload,
  readyMediaId,
  submitPreparedMedia,
  SUPPORTED_MEDIA_CONTENT_TYPES,
  type MediaFileUploadInput,
  type PreparedMediaFile,
} from "./media-upload.js";
import { silentProgressReporter, type ProgressReporter } from "./media/progress.js";
import type { TranscodeOptions } from "./media/transcode.js";
import { CliError, usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";

export const UPLOAD_BATCH_MIN_ITEMS = 1;
export const UPLOAD_BATCH_MAX_ITEMS = 1000;
export const UPLOAD_BATCH_MAX_ATTEMPTS = 8;
export const UPLOAD_BATCH_BACKOFF_START_MS = 1000;
export const UPLOAD_BATCH_BACKOFF_CAP_MS = 30_000;
export const UPLOAD_BATCH_DEFAULT_CONCURRENCY = 4;
export const UPLOAD_BATCH_MIN_CONCURRENCY = 1;
export const UPLOAD_BATCH_MAX_CONCURRENCY = 8;

const MEDIA_TAG_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_NAMESPACE = "screenrig.media.upload-batch.v1\0";

export interface UploadBatchManifestItem {
  /** Absolute path used to read bytes. */
  path: string;
  /** Path as written in the manifest, for reports. */
  displayPath: string;
  tag?: string;
  content_type?: string;
}

export interface UploadBatchStateRecord {
  media_id?: string;
  revision?: number;
  completed_at?: string;
  operation_id?: string;
  idempotency_key?: string;
  attempt?: number;
}

export interface UploadBatchState {
  api_url: string;
  account_id: string;
  items: Record<string, UploadBatchStateRecord>;
}

export interface UploadBatchFailedItem {
  path: string;
  sha256?: string;
  problem: {
    code: string;
    status: number;
    title: string;
    detail: string;
    retry_after_seconds?: number;
  };
}

/**
 * One row per item that reached the account, in manifest order. Counts alone
 * force a second `media list --tag` call to learn what a batch created, and a
 * batch without a tag has no way back to its ids at all.
 */
export interface UploadBatchItem {
  path: string;
  source_filename: string;
  sha256: string;
  outcome: "accepted" | "resumed";
  media_id?: string;
  revision?: number;
}

export interface UploadBatchEnvelopeData {
  attempts: number;
  rate_limited: number;
  wait_ms: number;
  transfer_ms: number;
  accepted: number;
  resumed: number;
  items: UploadBatchItem[];
  failed: UploadBatchFailedItem[];
}

export interface MediaUploadBatchResult {
  data: UploadBatchEnvelopeData;
  warnings: { code: string; message: string }[];
  exitCode: ExitCode;
  human: string;
}

export interface RunMediaUploadBatchInput {
  runtime: CliRuntime;
  client: ApiClient;
  manifestPath: string;
  statePath: string;
  apiUrl: string;
  accountId?: string;
  concurrency: number;
  defaultTag?: string;
  transcodeOptions: TranscodeOptions;
  noTranscode: boolean;
  reporter: ProgressReporter;
  json: boolean;
  noProgress: boolean;
  timeoutMs?: number;
  pollMs?: number;
  random?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function deriveBatchIdempotencyKey(contentSha256: string, attempt = 0): string {
  const hash = createHash("sha256").update(IDEMPOTENCY_NAMESPACE).update(contentSha256);
  if (attempt > 0) {
    hash.update("\0").update(String(attempt));
  }
  return hash.digest("base64url");
}

export function computeBackoffMs(options: {
  attemptIndex: number;
  retryAfterSeconds?: number;
  random?: () => number;
}): number {
  if (options.retryAfterSeconds !== undefined) {
    return Math.max(0, Math.ceil(options.retryAfterSeconds * 1000));
  }
  const exp = Math.min(
    UPLOAD_BATCH_BACKOFF_CAP_MS,
    UPLOAD_BATCH_BACKOFF_START_MS * 2 ** Math.max(0, options.attemptIndex),
  );
  const unit = options.random?.() ?? Math.random();
  const clamped = Number.isFinite(unit) ? Math.min(1, Math.max(0, unit)) : 0;
  // Equal jitter: at least half the exponential delay, never a fixed 30 s.
  return Math.floor(exp * (0.5 + 0.5 * clamped));
}

function isRetryableUploadError(error: unknown): error is CliError {
  if (!(error instanceof CliError)) {
    return false;
  }
  const status = error.problem.status;
  return status === 429 || status >= 500;
}

function compactProblem(error: CliError): UploadBatchFailedItem["problem"] {
  return {
    code: error.problem.code,
    status: error.problem.status,
    title: error.problem.title,
    detail: error.problem.detail,
    ...(typeof error.problem.retry_after_seconds === "number"
      ? { retry_after_seconds: error.problem.retry_after_seconds }
      : {}),
  };
}

function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  return usageError(error instanceof Error ? error.message : "Media upload-batch item failed.");
}

export function parseUploadBatchManifest(input: unknown, manifestDir: string): UploadBatchManifestItem[] {
  const rec = asRecord(input);
  if (!rec || !Array.isArray(rec.items) || Object.keys(rec).some((key) => key !== "items")) {
    throw usageError('media upload-batch manifest must be { "items": [ { "path": "./a.png" } ] }.');
  }
  if (rec.items.length < UPLOAD_BATCH_MIN_ITEMS || rec.items.length > UPLOAD_BATCH_MAX_ITEMS) {
    throw usageError(`media upload-batch manifest must contain ${UPLOAD_BATCH_MIN_ITEMS} to ${UPLOAD_BATCH_MAX_ITEMS} items.`);
  }
  const items: UploadBatchManifestItem[] = [];
  for (const [index, raw] of rec.items.entries()) {
    const item = asRecord(raw);
    if (!item || typeof item.path !== "string" || item.path.trim().length === 0) {
      throw usageError(`media upload-batch item ${index + 1} requires a non-empty path.`);
    }
    for (const key of Object.keys(item)) {
      if (key !== "path" && key !== "tag" && key !== "content_type") {
        throw usageError(`media upload-batch item ${index + 1} has an unsupported field.`);
      }
    }
    let tag: string | undefined;
    if (item.tag !== undefined) {
      if (typeof item.tag !== "string" || !MEDIA_TAG_PATTERN.test(item.tag)) {
        throw usageError(`media upload-batch item ${index + 1} tag must be 1 to 32 letters or digits.`);
      }
      tag = item.tag;
    }
    let contentType: string | undefined;
    if (item.content_type !== undefined) {
      if (typeof item.content_type !== "string" || !(SUPPORTED_MEDIA_CONTENT_TYPES as readonly string[]).includes(item.content_type)) {
        throw usageError(`media upload-batch item ${index + 1} content_type is not a supported media type.`);
      }
      contentType = item.content_type;
    }
    const resolved = path.resolve(manifestDir, item.path);
    items.push({
      path: resolved,
      displayPath: item.path,
      ...(tag ? { tag } : {}),
      ...(contentType ? { content_type: contentType } : {}),
    });
  }
  return items;
}

function parseStateRecord(value: unknown): UploadBatchStateRecord | undefined {
  const rec = asRecord(value);
  if (!rec) {
    return undefined;
  }
  const record: UploadBatchStateRecord = {};
  if (typeof rec.media_id === "string" && rec.media_id.length > 0) {
    record.media_id = rec.media_id;
  }
  if (typeof rec.completed_at === "string" && rec.completed_at.length > 0) {
    record.completed_at = rec.completed_at;
  }
  if (typeof rec.revision === "number" && Number.isInteger(rec.revision)) {
    record.revision = rec.revision;
  }
  if (typeof rec.operation_id === "string" && rec.operation_id.length > 0) {
    record.operation_id = rec.operation_id;
  }
  if (typeof rec.idempotency_key === "string" && rec.idempotency_key.length > 0) {
    record.idempotency_key = rec.idempotency_key;
  }
  if (typeof rec.attempt === "number" && Number.isInteger(rec.attempt) && rec.attempt >= 0) {
    record.attempt = rec.attempt;
  }
  if (record.media_id && record.completed_at) {
    return record;
  }
  if (record.operation_id || record.idempotency_key) {
    return record;
  }
  return undefined;
}

export function parseUploadBatchState(input: unknown): UploadBatchState {
  const rec = asRecord(input);
  if (!rec || typeof rec.api_url !== "string" || rec.api_url.length === 0) {
    throw usageError("media upload-batch state file is missing api_url.");
  }
  if (typeof rec.account_id !== "string" || rec.account_id.length === 0) {
    throw usageError("media upload-batch state file is missing account_id.");
  }
  const itemsRec = asRecord(rec.items);
  if (!itemsRec) {
    throw usageError("media upload-batch state file must map content SHA-256 digests under items.");
  }
  const items: Record<string, UploadBatchStateRecord> = {};
  for (const [digest, raw] of Object.entries(itemsRec)) {
    if (!SHA256_PATTERN.test(digest)) {
      throw usageError("media upload-batch state file has a key that is not a SHA-256 digest.");
    }
    const record = parseStateRecord(raw);
    if (!record) {
      throw usageError("media upload-batch state file has an incomplete item record.");
    }
    items[digest] = record;
  }
  return { api_url: rec.api_url.replace(/\/+$/, ""), account_id: rec.account_id, items };
}

function emptyState(apiUrl: string, accountId: string): UploadBatchState {
  return { api_url: apiUrl.replace(/\/+$/, ""), account_id: accountId, items: {} };
}

async function readStateFile(statePath: string, fsLike: ConfigFs): Promise<UploadBatchState | undefined> {
  let handle;
  try {
    handle = await fsLike.open(statePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw usageError("Cannot read media upload-batch state file.");
  }
  try {
    const body = await handle.readFile("utf8");
    if (body.trim().length === 0) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw usageError("media upload-batch state file is not valid JSON.");
    }
    return parseUploadBatchState(parsed);
  } finally {
    await handle.close();
  }
}

async function fsyncDir(dir: string, fsLike: ConfigFs): Promise<void> {
  const handle = await fsLike.open(dir, "r");
  try {
    await handle.sync();
  } catch {
    // Directory fsync is best-effort on filesystems that reject it.
  } finally {
    await handle.close();
  }
}

export async function writeUploadBatchStateAtomic(
  statePath: string,
  state: UploadBatchState,
  fsLike: ConfigFs,
  nowMs: number,
): Promise<void> {
  const dir = path.dirname(statePath);
  await fsLike.mkdir(dir, { recursive: true });
  const tmp = `${statePath}.${process.pid}.${nowMs}.tmp`;
  const body = `${JSON.stringify(state, null, 2)}\n`;
  try {
    const handle = await fsLike.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsLike.chmod(tmp, 0o600);
    await fsLike.rename(tmp, statePath);
    await fsLike.chmod(statePath, 0o600);
    await fsyncDir(dir, fsLike);
  } catch (error) {
    await fsLike.rm(tmp, { force: true }).catch(() => undefined);
    if (error instanceof CliError) {
      throw error;
    }
    throw usageError("Cannot write media upload-batch state file.");
  }
}

class WriteMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

async function resolveAccountId(client: ApiClient, configured?: string): Promise<string> {
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  const response = await client.call({ method: "GET", path: "/api/v1/account" });
  const id = (response.body as Account | undefined)?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw usageError("Cannot bind the upload-batch state file because the account id is unavailable.");
  }
  return id;
}

async function mapPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) {
    return;
  }
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      await worker(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}

function writeBatchProgress(
  input: RunMediaUploadBatchInput,
  data: UploadBatchEnvelopeData,
  total: number,
): void {
  if (input.noProgress) {
    return;
  }
  if (input.json) {
    input.runtime.stderr.write(
      `${JSON.stringify({
        event: "upload_batch_progress",
        accepted: data.accepted,
        resumed: data.resumed,
        failed: data.failed.length,
        total,
        attempts: data.attempts,
        rate_limited: data.rate_limited,
      })}\n`,
    );
    return;
  }
  input.runtime.stderr.write(
    `screenrig: media upload-batch accepted ${data.accepted}/${total} resumed ${data.resumed} failed ${data.failed.length}\n`,
  );
}

function humanReport(data: UploadBatchEnvelopeData): string {
  const lines = [
    "Media upload-batch",
    `accepted: ${data.accepted}`,
    `resumed: ${data.resumed}`,
    `failed: ${data.failed.length}`,
    `attempts: ${data.attempts}`,
    `rate_limited: ${data.rate_limited}`,
    `wait_ms: ${data.wait_ms}`,
    `transfer_ms: ${data.transfer_ms}`,
  ];
  for (const item of data.items) {
    lines.push(`item: ${item.source_filename} ${item.media_id ?? "(no id)"} ${item.outcome}`);
  }
  for (const item of data.failed) {
    lines.push(`failed_item: ${path.basename(item.path)} ${item.problem.code}/${item.problem.status}`);
  }
  return lines.join("\n");
}

function exitCodeForFailures(failed: UploadBatchFailedItem[]): ExitCode {
  if (failed.length === 0) {
    return ExitCode.Success;
  }
  const last = failed[failed.length - 1];
  if (!last) {
    return ExitCode.Unexpected;
  }
  if (last.problem.status === 429) {
    return ExitCode.RateLimited;
  }
  if (last.problem.status >= 500) {
    return ExitCode.Server;
  }
  if (last.problem.code === "usage_error") {
    return ExitCode.Usage;
  }
  return ExitCode.Client;
}

interface PendingItem {
  sourcePath: string;
  displayPath: string;
  sha256: string;
  tag?: string;
  content_type?: string;
  operationId?: string;
  idempotencyKey?: string;
  attempt?: number;
}

function isTerminalOperationConflict(error: CliError): boolean {
  return error.problem.code === "resource_conflict" && error.problem.status === 409 && /terminal/i.test(error.problem.detail);
}

function mediaMatchFromList(body: unknown, sha256: string): { mediaId: string; revision?: number } | undefined {
  const rec = asRecord(body);
  if (!rec || !Array.isArray(rec.items)) {
    return undefined;
  }
  for (const item of rec.items) {
    const row = asRecord(item);
    if (!row || row.sha256 !== sha256 || typeof row.id !== "string" || !row.id.startsWith("med_")) {
      continue;
    }
    const revision = typeof row.revision === "number" && Number.isInteger(row.revision) ? row.revision : undefined;
    return { mediaId: row.id, ...(revision !== undefined ? { revision } : {}) };
  }
  return undefined;
}

function acceptedFromOperation(operation: Operation | undefined): { mediaId: string; revision?: number } | undefined {
  if (!operation) {
    return undefined;
  }
  const mediaId = readyMediaId(operation);
  if (!mediaId) {
    return undefined;
  }
  const revisionRaw = operation.result?.revision;
  const revision = typeof revisionRaw === "number" && Number.isInteger(revisionRaw) ? revisionRaw : undefined;
  return { mediaId, ...(revision !== undefined ? { revision } : {}) };
}

async function recoverMediaId(
  client: ApiClient,
  options: { operationId?: string; sha256?: string },
): Promise<{ mediaId: string; revision?: number } | undefined> {
  if (options.operationId) {
    try {
      const operation = await client.getOperation(options.operationId);
      const accepted = acceptedFromOperation(operation);
      if (accepted) {
        return accepted;
      }
    } catch {
      // Fall through to list-by-hash. A missing or failed operation is not fatal.
    }
  }
  if (options.sha256) {
    try {
      const response = await client.call({ method: "GET", path: "/api/v1/media" });
      return mediaMatchFromList(response.body, options.sha256);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function runMediaUploadBatch(input: RunMediaUploadBatchInput): Promise<MediaUploadBatchResult> {
  const logger = loggerOf(input.runtime);
  return logger.withLocal({ op: "media.upload.batch", message: "media upload-batch" }, async () => {
    const manifestText = await readManifestFile(input.manifestPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText);
    } catch {
      throw usageError("Cannot parse media upload-batch manifest JSON.");
    }
    const manifestDir = path.dirname(input.manifestPath);
    const manifestItems = parseUploadBatchManifest(parsed, manifestDir);
    const accountId = await resolveAccountId(input.client, input.accountId);
    const apiUrl = input.apiUrl.replace(/\/+$/, "");
    const existing = await readStateFile(input.statePath, input.runtime.fs);
    if (existing && (existing.api_url !== apiUrl || existing.account_id !== accountId)) {
      throw usageError(
        "media upload-batch state file belongs to a different account or API URL. Use a separate --state file; do not share one across accounts.",
      );
    }
    const state = existing ?? emptyState(apiUrl, accountId);
    const mutex = new WriteMutex();
    await mutex.run(() => writeUploadBatchStateAtomic(input.statePath, state, input.runtime.fs, input.runtime.now().getTime()));

    const data: UploadBatchEnvelopeData = {
      attempts: 0,
      rate_limited: 0,
      wait_ms: 0,
      transfer_ms: 0,
      accepted: 0,
      resumed: 0,
      items: [],
      failed: [],
    };
    // Manifest order, filled as outcomes land so concurrency does not shuffle it.
    const itemsByPath = new Map<string, UploadBatchItem>();
    const manifestOrder: string[] = [];
    const pending: PendingItem[] = [];
    const seen = new Set<string>();
    const total = manifestItems.length;
    const warnings: { code: string; message: string }[] = [];

    for (const item of manifestItems) {
      let sha256: string;
      try {
        sha256 = await hashLocalMediaFile(item.path);
      } catch (error) {
        const problem = toCliError(error);
        data.failed.push({ path: item.displayPath, problem: compactProblem(problem) });
        await logger.withLocal(
          { op: "media.upload.batch.item", message: path.basename(item.path), quiet: true },
          async (span) => {
            span.error(problem);
          },
        );
        continue;
      }
      const record = state.items[sha256];
      manifestOrder.push(item.displayPath);
      if (record?.media_id || seen.has(sha256)) {
        data.resumed += 1;
        itemsByPath.set(item.displayPath, {
          path: item.displayPath,
          source_filename: path.basename(item.path),
          sha256,
          outcome: "resumed",
          ...(record?.media_id ? { media_id: record.media_id } : {}),
          ...(record?.revision !== undefined ? { revision: record.revision } : {}),
        });
        await logger.withLocal(
          {
            op: "media.upload.batch.item",
            message: path.basename(item.path),
            quiet: true,
            ...(record?.media_id ? { id: record.media_id } : {}),
          },
          async (span) => {
            span.finish({
              ...(record?.media_id ? { id: record.media_id } : {}),
              params: { outcome: "resumed" },
            });
          },
        );
        continue;
      }
      seen.add(sha256);
      pending.push({
        sourcePath: item.path,
        displayPath: item.displayPath,
        sha256,
        tag: item.tag ?? input.defaultTag,
        content_type: item.content_type,
        ...(record?.operation_id ? { operationId: record.operation_id } : {}),
        ...(record?.idempotency_key ? { idempotencyKey: record.idempotency_key } : {}),
        ...(record?.attempt !== undefined ? { attempt: record.attempt } : {}),
      });
    }
    writeBatchProgress(input, data, total);

    await mapPool(pending, input.concurrency, async (item) => {
      await logger.withLocal(
        { op: "media.upload.batch.item", message: path.basename(item.sourcePath), quiet: true },
        async (span) => {
          const outcome = await uploadPendingItem(input, item, data, state, mutex);
          if (outcome.kind === "accepted") {
            const completedAt = input.runtime.now().toISOString();
            await mutex.run(async () => {
              state.items[item.sha256] = {
                media_id: outcome.mediaId,
                completed_at: completedAt,
                ...(outcome.revision !== undefined ? { revision: outcome.revision } : {}),
                ...(outcome.operationId ? { operation_id: outcome.operationId } : {}),
              };
              await writeUploadBatchStateAtomic(input.statePath, state, input.runtime.fs, input.runtime.now().getTime());
            });
            data.accepted += 1;
            itemsByPath.set(item.displayPath, {
              path: item.displayPath,
              source_filename: path.basename(item.sourcePath),
              sha256: item.sha256,
              outcome: "accepted",
              media_id: outcome.mediaId,
              ...(outcome.revision !== undefined ? { revision: outcome.revision } : {}),
            });
            span.finish({ id: outcome.mediaId, params: { outcome: "accepted" } });
            for (const warning of outcome.warnings) {
              warnings.push({ code: warning.code, message: `${path.basename(item.sourcePath)}: ${warning.message}` });
            }
          } else {
            data.failed.push({
              path: item.displayPath,
              sha256: item.sha256,
              problem: compactProblem(outcome.error),
            });
            span.error(outcome.error);
          }
          writeBatchProgress(input, data, total);
        },
      );
    });

    for (const displayPath of manifestOrder) {
      const row = itemsByPath.get(displayPath);
      if (row) data.items.push(row);
    }
    return {
      data,
      warnings,
      exitCode: exitCodeForFailures(data.failed),
      human: humanReport(data),
    };
  });
}

async function readManifestFile(manifestPath: string): Promise<string> {
  try {
    return await readFile(manifestPath, "utf8");
  } catch {
    throw usageError("Cannot read media upload-batch manifest.");
  }
}

type ItemOutcome =
  | { kind: "accepted"; mediaId: string; revision?: number; operationId?: string; warnings: { code: string; message: string }[] }
  | { kind: "failed"; error: CliError };

async function persistInFlight(
  input: RunMediaUploadBatchInput,
  state: UploadBatchState,
  mutex: WriteMutex,
  sha256: string,
  patch: UploadBatchStateRecord,
): Promise<void> {
  await mutex.run(async () => {
    const current = state.items[sha256] ?? {};
    state.items[sha256] = { ...current, ...patch };
    await writeUploadBatchStateAtomic(input.statePath, state, input.runtime.fs, input.runtime.now().getTime());
  });
}

async function uploadPendingItem(
  input: RunMediaUploadBatchInput,
  item: PendingItem,
  data: UploadBatchEnvelopeData,
  state: UploadBatchState,
  mutex: WriteMutex,
): Promise<ItemOutcome> {
  const transcodeWarnings = (messages: string[] | undefined): { code: string; message: string }[] =>
    (messages ?? []).map((message) => ({ code: "transcode_warning", message }));
  const uploadInput: MediaFileUploadInput = {
    runtime: input.runtime,
    client: input.client,
    sourcePath: item.sourcePath,
    explicitContentType: item.content_type,
    tag: item.tag,
    transcodeOptions: input.transcodeOptions,
    noTranscode: input.noTranscode,
    reporter: input.noProgress ? silentProgressReporter() : input.reporter,
    noWait: false,
    timeoutMs: input.timeoutMs,
    pollMs: input.pollMs,
  };
  let prepared: PreparedMediaFile | undefined;
  try {
    prepared = await prepareMediaFileForUpload(uploadInput);
  } catch (error) {
    return { kind: "failed", error: toCliError(error) };
  }
  if (!prepared) {
    return { kind: "failed", error: usageError("Media upload-batch item produced no prepared bytes.") };
  }
  let attempt = item.attempt ?? 0;
  let idempotencyKey = item.idempotencyKey ?? deriveBatchIdempotencyKey(item.sha256, attempt);
  let operationId = item.operationId;
  try {
    if (operationId) {
      const recoveredEarly = await recoverMediaId(input.client, { operationId });
      if (recoveredEarly) {
        return {
          kind: "accepted",
          mediaId: recoveredEarly.mediaId,
          revision: recoveredEarly.revision,
          operationId,
          warnings: transcodeWarnings(prepared.transcode?.warnings),
        };
      }
    }
    let lastError: CliError | undefined;
    for (let loop = 0; loop < UPLOAD_BATCH_MAX_ATTEMPTS; loop += 1) {
      data.attempts += 1;
      const started = input.runtime.now().getTime();
      try {
        const submitted = await submitPreparedMedia(
          {
            ...uploadInput,
            idempotencyKey,
            onDeclared: async (session) => {
              operationId = session.operationId;
              await persistInFlight(input, state, mutex, item.sha256, {
                operation_id: session.operationId,
                idempotency_key: idempotencyKey,
                attempt,
              });
            },
          },
          prepared,
        );
        data.transfer_ms += Math.max(0, input.runtime.now().getTime() - started);
        if (!submitted.mediaId) {
          return { kind: "failed", error: usageError("Media upload-batch item completed without a media id.") };
        }
        const revisionRaw = submitted.operation.result?.revision;
        const revision = typeof revisionRaw === "number" && Number.isInteger(revisionRaw) ? revisionRaw : undefined;
        return {
          kind: "accepted",
          mediaId: submitted.mediaId,
          revision,
          operationId: submitted.operation.id,
          warnings: transcodeWarnings(prepared.transcode?.warnings),
        };
      } catch (error) {
        data.transfer_ms += Math.max(0, input.runtime.now().getTime() - started);
        const wrapped = toCliError(error);
        lastError = wrapped;
        if (isTerminalOperationConflict(wrapped)) {
          const recovered = await recoverMediaId(input.client, {
            operationId,
            sha256: prepared.prepared.declaration.sha256,
          });
          if (recovered) {
            return {
              kind: "accepted",
              mediaId: recovered.mediaId,
              revision: recovered.revision,
              operationId,
              warnings: transcodeWarnings(prepared.transcode?.warnings),
            };
          }
          if (loop + 1 >= UPLOAD_BATCH_MAX_ATTEMPTS) {
            return { kind: "failed", error: wrapped };
          }
          attempt += 1;
          idempotencyKey = deriveBatchIdempotencyKey(item.sha256, attempt);
          await persistInFlight(input, state, mutex, item.sha256, {
            idempotency_key: idempotencyKey,
            attempt,
            ...(operationId ? { operation_id: operationId } : {}),
          });
          continue;
        }
        if (wrapped.problem.status === 429) {
          data.rate_limited += 1;
        }
        const retryable = isRetryableUploadError(wrapped) && loop + 1 < UPLOAD_BATCH_MAX_ATTEMPTS;
        if (!retryable) {
          return { kind: "failed", error: wrapped };
        }
        const waitMs = computeBackoffMs({
          attemptIndex: loop,
          retryAfterSeconds: wrapped.problem.retry_after_seconds,
          random: input.random,
        });
        data.wait_ms += waitMs;
        if (waitMs > 0) {
          await input.runtime.sleep(waitMs);
        }
      }
    }
    return { kind: "failed", error: lastError ?? usageError("Media upload-batch item exhausted retry attempts.") };
  } finally {
    await cleanupPreparedMediaFile(prepared);
  }
}


