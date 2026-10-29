import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { MediaCommit, MediaUploadDeclaration, MediaUploadSession, Operation } from "./adapters/protocol.js";
import type { ApiClient } from "./client.js";
import { ExitCode } from "./exit-codes.js";
import { quotedRevision } from "./if-match.js";
import { isValidIdempotencyKey, newIdempotencyKey } from "./ids.js";
import { lowInformationFilenameWarning } from "./media-filename.js";
import type { ProgressReporter } from "./media/progress.js";
import { classifySource, transcodeForUpload, type TranscodeOptions, type TranscodeResult } from "./media/transcode.js";
import { assertDeclaredTypeMatchesBytes } from "./media/sniff.js";
import { projectVideoBytes, videoLimitText } from "./media/video-limit.js";
import { readWebpContainer } from "./media/webp.js";
import { CliError, makeProblem, usageError } from "./problems.js";
import {
  fetchSignedRawPut, SIGNED_PUT_ANSWER_MS, SIGNED_PUT_IDLE_MS, type CliRuntime, type SignedRawPut, type SignedRawPutResponse,
} from "./runtime.js";

/** How many times a declared upload's bytes are sent before the failure is reported. */
const PUT_ATTEMPTS = 4;

/** The stall limits of `fetchSignedRawPut`, in words. */
const PUT_STALLS: Record<string, string> = {
  UPLOAD_STALLED: `the transfer stalled: no bytes moved for ${SIGNED_PUT_IDLE_MS / 60_000} minutes`,
  UPLOAD_UNANSWERED: `storage did not answer within ${SIGNED_PUT_ANSWER_MS / 60_000} minutes of the last byte`,
};

/** Plain words for the connection error codes a failed PUT reports. */
const PUT_FAILURES: Record<string, string> = {
  ECONNRESET: "the connection was reset",
  EPIPE: "the connection was closed",
  UND_ERR_SOCKET: "the connection was closed",
  ECONNREFUSED: "the connection was refused",
  ETIMEDOUT: "the connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
  UND_ERR_HEADERS_TIMEOUT: "storage did not answer in time",
  ENOTFOUND: "the storage host was not found",
  EAI_AGAIN: "the storage host was not found",
  ENETUNREACH: "the network is unreachable",
  EHOSTUNREACH: "the network is unreachable",
};

/**
 * Why a PUT failed, from the error codes in its cause chain. The messages are
 * never used: they can carry the host or the signed URL.
 */
function putFailure(error: unknown): string {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 8; depth += 1) {
    const code = (current as { code?: unknown }).code;
    const stall = typeof code === "string" ? PUT_STALLS[code] : undefined;
    if (stall) return stall;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return `${PUT_FAILURES[code] ?? "the connection failed"} (${code})`;
    if ((current as { name?: unknown }).name === "AbortError") return "the transfer was stopped";
    current = (current as { cause?: unknown }).cause;
  }
  return "the connection failed";
}

/** Storage answers worth sending the same PUT again: a server error, a timeout or a rate limit. */
function retryablePutStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** What storage answered: the status, with its error code and message when it sent them. */
function storageAnswer(response: SignedRawPutResponse): string {
  return `HTTP ${response.status}${response.errorCode ? ` ${response.errorCode}` : ""}${response.errorMessage ? `: ${response.errorMessage}` : ""}`;
}

/**
 * A signed PUT that did not finish. It never reached the API, so the API's
 * network guidance (screenrig doctor) does not apply. The operation id names
 * the declared upload.
 */
function putFailed(detail: string, operationId: string): CliError {
  return new CliError(makeProblem("transport_error", "Upload to storage failed", 503, detail, {
    operation_id: operationId,
    hint: "Run the same command again to upload it again.",
  }), ExitCode.Network);
}

export const SUPPORTED_MEDIA_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
] as const;

export type SupportedMediaContentType = (typeof SUPPORTED_MEDIA_CONTENT_TYPES)[number];

/** Every type is held to this transport bound; a video is held to its project's plan limit (`media_video_bytes`). */
const MAX_TRANSPORT_BYTES = 1_073_741_824;

interface UploadCeiling {
  bytes: number;
  message: string;
}

const TRANSPORT_CEILING: UploadCeiling = {
  bytes: MAX_TRANSPORT_BYTES,
  message:
    "Media file exceeds the 1 GiB per-upload transport ceiling. Run screenrig project show " +
    "to inspect used_bytes, any content_limit_bytes ceiling, and credit_remaining.",
};

/** The size ceiling for one upload of this content type; a video's is the project's plan limit, read before the upload is prepared. */
function uploadCeiling(contentType: string, videoBytes: number | undefined): UploadCeiling {
  if (!contentType.startsWith("video/")) return TRANSPORT_CEILING;
  if (videoBytes === undefined) throw new Error("A video upload needs the project's video limit.");
  return {
    bytes: videoBytes,
    message: `Video exceeds the ${videoLimitText(videoBytes)} limit for one video upload on this project's plan. Trim the video to a shorter clip, then run the upload again.`,
  };
}

export interface PreparedMediaUpload {
  bytes: Buffer;
  declaration: MediaUploadDeclaration;
  commit: MediaCommit;
}

export interface ValidatedMediaUploadSession {
  id: string;
  operationId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: number;
}

const EXTENSIONS: Record<string, SupportedMediaContentType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};

function supported(value: string): value is SupportedMediaContentType {
  return (SUPPORTED_MEDIA_CONTENT_TYPES as readonly string[]).includes(value);
}

export async function prepareMediaUpload(
  filePath: string,
  explicitContentType?: string,
  expectedSha256?: string,
  videoBytes?: number,
): Promise<PreparedMediaUpload> {
  const filename = path.basename(filePath);
  if (!filename || Buffer.byteLength(filename, "utf8") > 255) throw usageError("Media filename must be 1 to 255 bytes.");
  const contentType = explicitContentType ?? EXTENSIONS[path.extname(filename).toLowerCase()];
  if (!contentType || !supported(contentType)) {
    throw usageError(`Unsupported media type; use one of: ${SUPPORTED_MEDIA_CONTENT_TYPES.join(", ")}.`);
  }
  const bytes = await readMediaSnapshot(filePath, uploadCeiling(contentType, videoBytes));
  if (contentType === "image/webp" && readWebpContainer(bytes)?.lossless) {
    throw usageError(
      "Lossless WebP (VP8L) is not accepted. Encode lossy WebP that keeps alpha, then upload with --no-transcode.",
    );
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    throw usageError("Media bytes changed after delivery verification; retry the upload. No upload was started.");
  }
  const commit: MediaCommit = { content_type: contentType, bytes: bytes.length, sha256 };
  return { bytes, commit, declaration: { filename, ...commit } };
}

async function readMediaSnapshot(filePath: string, ceiling: UploadCeiling = TRANSPORT_CEILING): Promise<Buffer> {
  // Open first so admission and reads address the same file. NONBLOCK lets us
  // reject FIFOs without waiting for a writer; regular file reads are unaffected.
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw usageError("Cannot open media file for reading.");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw usageError("Media input must be a regular file.");
    if (before.size < 1) throw usageError("Media file must not be empty.");
    if (before.size > ceiling.bytes) throw usageError(ceiling.message);
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(256 * 1024, bytes.length - offset), offset);
      if (bytesRead === 0) throw usageError("Media file changed while reading; retry the upload.");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw usageError("Media file changed while reading; retry the upload.");
    }
    return bytes;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw usageError("Cannot read media file.");
  } finally {
    await handle.close();
  }
}

/**
 * Checks a declared upload's signed PUT session. Application package uploads
 * get the same session shape; `label` names the upload in errors.
 */
export function validateMediaUploadSession(input: MediaUploadSession, nowMs = Date.now(), label = "Media upload"): ValidatedMediaUploadSession {
  if (!input || typeof input !== "object" || typeof input.id !== "string" || input.id.length === 0 ||
      !input.operation || typeof input.operation.id !== "string" || input.operation.id.length === 0) {
    throw usageError(`${label} declaration returned an invalid binding.`);
  }
  if (input.method !== "PUT") throw usageError(`${label} declaration returned an unsupported method.`);
  let parsed: URL;
  try { parsed = new URL(input.upload_url); } catch { throw usageError(`${label} declaration returned an invalid URL.`); }
  if (!/^(https?:)$/.test(parsed.protocol) || !parsed.host || parsed.username || parsed.password) {
    throw usageError(`${label} declaration returned an unsafe URL.`);
  }
  if (!input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) {
    throw usageError(`${label} declaration returned invalid signed headers.`);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (!name || typeof value !== "string" || !value || /[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw usageError(`${label} declaration returned invalid signed headers.`);
    }
    headers[name] = value;
  }
  const expiresAt = Date.parse(input.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) throw usageError(`${label} declaration is expired or invalid.`);
  return { id: input.id, operationId: input.operation.id, uploadUrl: input.upload_url, headers, expiresAt };
}

export async function performSignedMediaPut(
  prepared: PreparedMediaUpload,
  session: ValidatedMediaUploadSession,
  signedRawPut: SignedRawPut,
  options: SignedPutOptions = {},
): Promise<void> {
  return performSignedBodyPut(prepared.bytes, session, signedRawPut, options);
}

export async function performSignedMediaFilePut(
  filePath: string,
  session: ValidatedMediaUploadSession,
  signedRawPut: SignedRawPut,
): Promise<void> {
  return performSignedBodyPut(createReadStream(filePath), session, signedRawPut);
}

export async function performSignedMediaStreamPut(
  body: AsyncIterable<Uint8Array>,
  session: ValidatedMediaUploadSession,
  signedRawPut: SignedRawPut,
): Promise<void> {
  return performSignedBodyPut(body, session, signedRawPut);
}

export interface SignedPutOptions {
  /** Names the upload in errors ("Private media upload"). */
  label?: string;
  /** Waits between attempts; the runtime's sleep in commands. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The signed PUT of a declared upload's bytes. A dropped connection or a
 * storage server error sends the whole PUT again, with a growing wait, while
 * the bytes are buffered and the URL is valid: a PUT that never finished
 * stored nothing, so sending it again is safe. A failure names the declared
 * upload's operation and says to run the same command again.
 */
export async function performSignedBodyPut(
  body: Uint8Array | AsyncIterable<Uint8Array>,
  session: ValidatedMediaUploadSession,
  signedRawPut: SignedRawPut,
  options: SignedPutOptions = {},
): Promise<void> {
  const label = options.label ?? "Private media upload";
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  // One-shot streams cannot be sent again; their own recovery path stays in charge.
  const maxAttempts = body instanceof Uint8Array ? PUT_ATTEMPTS : 1;
  const failed = (reason: string, attempts: number) =>
    `${label} to storage was interrupted: ${reason}.${attempts > 1 ? ` It did not finish after ${attempts} attempts.` : ""}`;
  let reason: string | undefined;
  for (let attempt = 1; ; attempt += 1) {
    if (Date.now() >= session.expiresAt) {
      throw putFailed(reason === undefined
        ? `${label} could not start: its upload URL had expired.`
        : `${failed(reason, attempt - 1)} Its upload URL expired before it could be sent again.`, session.operationId);
    }
    let response: SignedRawPutResponse | undefined;
    try {
      response = await signedRawPut({
        url: session.uploadUrl,
        method: "PUT",
        headers: session.headers,
        body,
        credentials: "omit",
        redirect: "error",
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      reason = putFailure(error);
    }
    if (response) {
      if (response.status >= 200 && response.status < 300) return;
      if (!retryablePutStatus(response.status)) {
        throw putFailed(`${label} was refused by storage: ${storageAnswer(response)}.`, session.operationId);
      }
      reason = `storage answered ${storageAnswer(response)}`;
    }
    const why = reason ?? "the connection failed";
    if (attempt >= maxAttempts) throw putFailed(failed(why, attempt), session.operationId);
    const waitMs = Math.ceil(1000 * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5));
    if (Date.now() + waitMs >= session.expiresAt) {
      throw putFailed(`${failed(why, attempt)} Its upload URL expired before it could be sent again.`, session.operationId);
    }
    await sleep(waitMs);
  }
}

/**
 * A declared upload holds its bytes against the project's storage until it is
 * committed, cancelled, or swept after 24 hours. When running the same command
 * again declares a new upload, cancel the one whose bytes could not be sent,
 * so the two never both count. Best effort: a refused cancel is reported in
 * the hint, never thrown.
 */
async function cancelInterruptedUpload(client: ApiClient, error: CliError): Promise<CliError> {
  const id = error.problem.operation_id;
  if (!id) return error;
  let hint: string;
  let next = error.problem.next;
  try {
    await client.call({ method: "POST", path: `/api/operations/${encodeURIComponent(id)}/cancel`, idempotent: true, idempotencyKey: newIdempotencyKey() });
    hint = `Upload ${id} was cancelled, so it holds no storage. Run the same command again to upload it again.`;
  } catch (cancelError) {
    if (cancelError instanceof CliError && cancelError.problem.status === 409) {
      hint = `Upload ${id} had already ended, so it holds no storage. Run the same command again to upload it again.`;
    } else {
      const code = cancelError instanceof CliError ? cancelError.problem.code : "unexpected_error";
      hint = `Run the same command again to upload it again. Upload ${id} could not be cancelled (${code}), so it keeps its storage reserved until it is cancelled or the server releases it after 24 hours.`;
      next = { command: `screenrig operations cancel ${id}`, argv: ["operations", "cancel", id], reason: "Releases the storage the interrupted upload still holds." };
    }
  }
  return new CliError({ ...error.problem, hint, ...(next ? { next } : {}) }, error.exitCode, error.warnings);
}

export function deriveCommitIdempotencyKey(base: string): string {
  return deriveStepIdempotencyKey(base, "commit");
}

/** The key of the request that finishes a declared upload: the commit, or for a replacement the replace. */
function deriveStepIdempotencyKey(base: string, step: "commit" | "replace"): string {
  if (!isValidIdempotencyKey(base)) throw usageError(`Invalid base idempotency key for media ${step}.`);
  const derived = createHash("sha256").update(`screenrig.media.${step}\0`).update(base).digest("base64url");
  if (derived === base || !isValidIdempotencyKey(derived)) throw usageError(`Could not derive media ${step} idempotency key.`);
  return derived;
}

/** The primitive (image, video or audio) a file of this content type is. */
export function mediaPrimitiveOf(contentType: string): "image" | "video" | "audio" | undefined {
  const kind = contentType.split("/")[0];
  return kind === "image" || kind === "video" || kind === "audio" ? kind : undefined;
}

/** A replacement of another kind than the media it replaces: refused before any transfer. */
export function replaceKindError(mediaId: string, primitive: "image" | "video" | "audio", file: string): CliError {
  return usageError(
    `${file} is not ${primitive === "image" ? "an" : "a"} ${primitive} file, and ${mediaId} is ${primitive === "image" ? "an" : "a"} ${primitive}: a replacement must be the same kind of file as the media it replaces. Nothing was uploaded.`,
    { command: "screenrig media upload FILE", reason: "Add a file of another kind as new media instead; then point the playlist at it." },
  );
}

/**
 * The primitive a local file will upload as, from the declared content type or
 * its extension, before any transcode or read. Undefined when neither names a
 * supported type: the upload pipeline reports that itself.
 */
export function mediaPrimitiveOfFile(filePath: string, explicitContentType?: string): "image" | "video" | "audio" | undefined {
  const contentType = explicitContentType ?? EXTENSIONS[path.extname(filePath).toLowerCase()];
  return contentType && supported(contentType) ? mediaPrimitiveOf(contentType) : undefined;
}

/** SHA-256 of the local source bytes. Batch resume keys this, not the transcoded digest. */
export async function hashLocalMediaFile(filePath: string): Promise<string> {
  const bytes = await readMediaSnapshot(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export function readyMediaId(operation: Operation): string | undefined {
  const mediaId = operation.result?.media_id;
  return typeof mediaId === "string" && mediaId.length > 0 ? mediaId : undefined;
}

export interface MediaFileUploadInput {
  runtime: CliRuntime;
  client: ApiClient;
  sourcePath: string;
  explicitContentType?: string;
  tag?: string;
  /** The media folder the file is declared into (folder_id at declare); it lands there when ready, with no move afterwards. */
  folderId?: string;
  transcodeOptions: TranscodeOptions;
  noTranscode: boolean;
  reporter: ProgressReporter;
  noWait?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  /** Declare key; commit is derived from this. Defaults to `client.idempotencyKey`. */
  idempotencyKey?: string;
  /**
   * Running the same command again reuses this upload's keys (an explicit
   * --idempotency-key, or a batch state file), and with them the declared
   * upload. A failed transfer then keeps that upload instead of cancelling it.
   */
  resumable?: boolean;
  /** Called after declare succeeds and before the signed PUT. */
  onDeclared?: (session: ValidatedMediaUploadSession) => Promise<void>;
  /**
   * Replace this media's file with the upload instead of committing it as new
   * media: the same declare and signed PUT, then POST /api/media/{id}/replace.
   */
  replace?: MediaReplaceTarget;
}

export interface MediaReplaceTarget {
  mediaId: string;
  /** The primitive of the media being replaced; the new file must be the same kind. */
  primitive?: "image" | "video" | "audio";
  /** If-Match: the media revision the caller read. */
  ifMatch?: string;
  note?: string;
}

/**
 * Wall-clock milliseconds per upload stage, so a slow upload shows where the
 * time went. processing_ms runs from the commit response to the ready media
 * and is only as fine as the polling interval; absent with --no-wait.
 */
export interface MediaUploadTiming {
  prepare_ms: number;
  declare_ms?: number;
  transfer_ms?: number;
  commit_ms?: number;
  processing_ms?: number;
}

export interface MediaFileUploadResult {
  mediaId?: string;
  operation: Operation;
  /** True when ready media with identical bytes, name and tag already existed, so nothing uploaded. */
  reused: boolean;
  timing: MediaUploadTiming;
  upload: {
    /**
     * The stored name. Read back from the ready media object, because the
     * server derives it from `source_filename` (photo.png sent as WebP is
     * stored as photo.png.webp) and only the server knows the result.
     */
    filename: string;
    /** The name the CLI put on the wire, before the server derived the stored one. */
    declared_filename: string;
    /** `server` when `filename` came from the ready object, `declared` when it could not be read back. */
    filename_source: "server" | "declared";
    /** The caller's original file name, declared so the ready object keeps the handle. */
    source_filename?: string;
    content_type: string;
    bytes: number;
    sha256: string;
    tag?: string;
    folder_id?: string;
  };
  transcode: {
    applied: boolean;
    stage?: string;
    reason: string;
    source_bytes?: number;
    output_bytes?: number;
    width?: number;
    height?: number;
    /** Probed source dimensions before any bound; present when the transcoder ran. */
    source_width?: number;
    source_height?: number;
    dimensions_measured?: boolean;
    duration_ms?: number;
    video?: TranscodeResult["video"];
  };
  warnings: { code: string; message: string }[];
}

export interface PreparedMediaFile {
  prepared: PreparedMediaUpload;
  transcode?: TranscodeResult;
}

/**
 * Transcode (unless `--no-transcode`) and snapshot the bytes that will be
 * declared. The caller must `cleanupPreparedMediaFile` after submit/failure.
 */
export async function prepareMediaFileForUpload(input: MediaFileUploadInput): Promise<PreparedMediaFile> {
  // The declared type is a claim; the bytes are the fact. Refuse a contradiction
  // before ffmpeg or the server sees the file.
  await assertDeclaredTypeMatchesBytes(input.sourcePath, input.explicitContentType);
  const sourceFilename = path.basename(input.sourcePath);
  if (!sourceFilename || Buffer.byteLength(sourceFilename, "utf8") > 255) {
    throw usageError("Media filename must be 1 to 255 bytes.");
  }
  // Only a video is held to the plan's size limit, so only a video asks for it.
  const sourceType = input.explicitContentType ?? EXTENSIONS[path.extname(sourceFilename).toLowerCase()];
  const isVideo = input.noTranscode ? sourceType?.startsWith("video/") === true : classifySource(input.sourcePath, input.explicitContentType) === "video";
  const videoBytes = isVideo ? await projectVideoBytes(input.client) : undefined;
  let transcode: TranscodeResult | undefined;
  if (!input.noTranscode) {
    transcode = await transcodeForUpload({
      runtime: input.runtime,
      filePath: input.sourcePath,
      explicitContentType: input.explicitContentType,
      options: input.transcodeOptions,
      reporter: input.reporter,
      videoBytes,
    });
  }
  try {
    const prepared = transcode
      ? await prepareMediaUpload(transcode.filePath, transcode.contentType, transcode.verifiedSha256, videoBytes)
      : await prepareMediaUpload(input.sourcePath, input.explicitContentType, undefined, videoBytes);
    // Always declare the caller's file name. The server derives the stored
    // filename from it (photo.png uploaded as WebP becomes photo.png.webp), so
    // distinct sources no longer collide, and `media list` keeps the handle.
    prepared.declaration.source_filename = sourceFilename;
    if (input.tag !== undefined) {
      prepared.declaration.tag = input.tag;
    }
    if (input.folderId !== undefined) {
      prepared.declaration.folder_id = input.folderId;
    }
    return { prepared, transcode };
  } catch (error) {
    if (transcode?.cleanupDir) {
      await rm(transcode.cleanupDir, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function cleanupPreparedMediaFile(prepared: PreparedMediaFile | undefined): Promise<void> {
  if (prepared?.transcode?.cleanupDir) {
    await rm(prepared.transcode.cleanupDir, { recursive: true, force: true });
  }
}

function transcodeEnvelope(transcode: TranscodeResult | undefined): MediaFileUploadResult["transcode"] {
  if (!transcode) {
    return { applied: false, reason: "--no-transcode uploaded the source bytes unchanged" };
  }
  return {
    applied: !transcode.passthrough,
    stage: transcode.stage,
    reason: transcode.reason,
    source_bytes: transcode.sourceBytes,
    output_bytes: transcode.outputBytes,
    width: transcode.width,
    height: transcode.height,
    source_width: transcode.sourceWidth,
    source_height: transcode.sourceHeight,
    dimensions_measured: transcode.dimensionsMeasured,
    duration_ms: transcode.durationMs,
    ...(transcode.video ? { video: transcode.video } : {}),
  };
}

function uploadWarnings(prepared: PreparedMediaUpload, transcode: TranscodeResult | undefined): MediaFileUploadResult["warnings"] {
  const warnings: MediaFileUploadResult["warnings"] = (transcode?.warnings ?? []).map((message) => ({ code: "transcode_warning", message }));
  if (transcode?.resized) {
    const { sourceWidth, sourceHeight, width, height, maxEdge } = transcode.resized;
    warnings.push({
      code: "image_resized",
      message:
        `${prepared.declaration.source_filename ?? prepared.declaration.filename} was ${sourceWidth}x${sourceHeight} and was ` +
        `scaled down to ${width}x${height} to fit the ${maxEdge} px bound on each edge. The stored still is smaller ` +
        "than the source; pass --max-edge to tighten the bound further, or supply a smaller source to keep control of the result.",
    });
  }
  // Quote the name the caller chose. After a transcode the declared name is a
  // local derivative (photo.png sent as photo.webp) and quoting that reads as a
  // name the caller never typed.
  const filenameWarning = lowInformationFilenameWarning(
    prepared.declaration.source_filename ?? prepared.declaration.filename,
  );
  if (filenameWarning) warnings.push({ code: "generic_filename", message: filenameWarning });
  return warnings;
}

/** Declare, signed PUT, commit, and optionally wait. Same path as `media upload`. */
export async function submitPreparedMedia(
  input: MediaFileUploadInput,
  preparedFile: PreparedMediaFile,
): Promise<Pick<MediaFileUploadResult, "mediaId" | "operation"> & { timing: Omit<MediaUploadTiming, "prepare_ms"> }> {
  const { runtime, client } = input;
  const { prepared } = preparedFile;
  const declareKey = input.idempotencyKey ?? client.idempotencyKey;
  if (input.replace?.primitive && mediaPrimitiveOf(prepared.declaration.content_type) !== input.replace.primitive) {
    throw replaceKindError(input.replace.mediaId, input.replace.primitive, prepared.declaration.source_filename ?? prepared.declaration.filename);
  }
  let mark = runtime.now().getTime();
  const lap = () => { const now = runtime.now().getTime(); const elapsed = now - mark; mark = now; return elapsed; };
  const declarationResponse = await client.call({
    method: "POST",
    path: "/api/media/uploads",
    idempotent: true,
    idempotencyKey: declareKey,
    body: prepared.declaration,
  });
  if (declarationResponse.headers["cache-control"] !== "private, no-store") {
    throw usageError("Media upload declaration did not return the required private, no-store cache policy.");
  }
  const session = validateMediaUploadSession(declarationResponse.body as MediaUploadSession, runtime.now().getTime());
  const declare_ms = lap();
  if (input.onDeclared) {
    await input.onDeclared(session);
  }
  lap();
  try {
    await performSignedMediaPut(prepared, session, runtime.signedRawPut ?? fetchSignedRawPut(), { sleep: runtime.sleep });
  } catch (error) {
    if (input.resumable || !(error instanceof CliError)) throw error;
    throw await cancelInterruptedUpload(client, error);
  }
  const transfer_ms = lap();
  const commitResponse = input.replace
    ? await requestReplace(input, input.replace, session, declareKey)
    : await client.call({
      method: "POST",
      path: `/api/media/uploads/${session.id}/commit`,
      idempotent: true,
      idempotencyKey: deriveCommitIdempotencyKey(declareKey),
      body: prepared.commit,
    });
  let operation = commitResponse.body as Operation;
  const timing: Omit<MediaUploadTiming, "prepare_ms"> = { declare_ms, transfer_ms, commit_ms: lap() };
  if (!input.noWait) {
    operation = await client.waitForOperation(operation.id, {
      timeoutMs: input.timeoutMs ?? 120_000,
      pollMs: input.pollMs ?? 1000,
      sleep: runtime.sleep,
    });
    timing.processing_ms = lap();
  }
  return { mediaId: readyMediaId(operation) ?? input.replace?.mediaId, operation, timing };
}

/**
 * The replace request of a declared and written upload. A refusal (a stale
 * If-Match, a file of another kind) leaves the upload usable but not wanted:
 * unless the caller resumes it by key, cancel it so it holds no storage.
 */
async function requestReplace(
  input: MediaFileUploadInput,
  target: MediaReplaceTarget,
  session: ValidatedMediaUploadSession,
  declareKey: string,
) {
  try {
    return await input.client.call({
      method: "POST",
      path: `/api/media/${encodeURIComponent(target.mediaId)}/replace`,
      idempotent: true,
      idempotencyKey: deriveStepIdempotencyKey(declareKey, "replace"),
      ...(target.ifMatch !== undefined ? { headers: { "if-match": quotedRevision(target.ifMatch) } } : {}),
      body: { upload_id: session.id, ...(target.note !== undefined ? { note: target.note } : {}) },
    });
  } catch (error) {
    const status = error instanceof CliError ? error.problem.status : undefined;
    if (input.resumable || !(error instanceof CliError) || typeof status !== "number" || status >= 500 || status === 408 || status === 429) throw error;
    throw await releaseRefusedUpload(input.client, session.operationId, error);
  }
}

/** Cancels the declared upload a refused replace left behind; a cancel that fails changes nothing (the server releases it after 24 hours). */
async function releaseRefusedUpload(client: ApiClient, operationId: string, error: CliError): Promise<CliError> {
  try {
    await client.call({ method: "POST", path: `/api/operations/${encodeURIComponent(operationId)}/cancel`, idempotent: true, idempotencyKey: newIdempotencyKey() });
  } catch {
    return error;
  }
  return error.problem.hint
    ? error
    : new CliError({ ...error.problem, hint: `Upload ${operationId} was cancelled, so it holds no storage.` }, error.exitCode, error.warnings);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * The name the caller needs after an upload is the one the project now holds,
 * not the local pre-transcode guess: photo.png, photo.jpg, and photo.webp all
 * declare photo.webp but are stored as three distinct rows. Only the ready
 * object carries the derived name, so read it back.
 */
async function storedMediaFilename(
  client: ApiClient,
  mediaId: string,
): Promise<{ filename?: string; source_filename?: string }> {
  try {
    const response = await client.call({ method: "GET", path: `/api/media/${mediaId}` });
    const body = asRecord(response.body);
    const filename = typeof body?.filename === "string" && body.filename.length > 0 ? body.filename : undefined;
    const sourceFilename =
      typeof body?.source_filename === "string" && body.source_filename.length > 0 ? body.source_filename : undefined;
    return { ...(filename ? { filename } : {}), ...(sourceFilename ? { source_filename: sourceFilename } : {}) };
  } catch {
    // The bytes are already stored and billed. A failed read-back downgrades the
    // reported name; it does not fail the upload.
    return {};
  }
}

/**
 * Ready media this exact upload already produced: the same bytes, declared
 * name and tag. Rerunning an interrupted upload then returns that media ID
 * instead of storing a second copy. Best effort: any failure means upload.
 */
async function existingUpload(
  client: ApiClient,
  declaration: MediaUploadDeclaration,
): Promise<{ mediaId: string; operation: Operation; filename?: string; source_filename?: string } | undefined> {
  try {
    const primitive = declaration.content_type.split("/")[0];
    const response = await client.listAll("/api/media", { primitive });
    const items = asRecord(response.body)?.items;
    if (!Array.isArray(items)) return undefined;
    const match = items.map(asRecord).find((item) => {
      if (!item || item.state !== "ready" || typeof item.id !== "string" || typeof item.operation_id !== "string") return false;
      const source = asRecord(item.upload_source) ?? item;
      return source.sha256 === declaration.sha256 && source.bytes === declaration.bytes &&
        source.content_type === declaration.content_type &&
        source.source_filename === declaration.source_filename && item.tag === declaration.tag &&
        (declaration.folder_id === undefined || item.folder_id === declaration.folder_id);
    });
    if (!match) return undefined;
    const operation = await client.getOperation(match.operation_id as string);
    if (operation.state !== "succeeded" || readyMediaId(operation) !== match.id) return undefined;
    return {
      mediaId: match.id as string,
      operation,
      ...(typeof match.filename === "string" ? { filename: match.filename } : {}),
      ...(typeof match.source_filename === "string" ? { source_filename: match.source_filename } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function uploadMediaFile(input: MediaFileUploadInput): Promise<MediaFileUploadResult> {
  const started = input.runtime.now().getTime();
  // A file of another kind cannot replace the media: say so before any transcode work.
  if (input.replace?.primitive) {
    const local = mediaPrimitiveOfFile(input.sourcePath, input.explicitContentType);
    if (local !== undefined && local !== input.replace.primitive) {
      throw replaceKindError(input.replace.mediaId, input.replace.primitive, path.basename(input.sourcePath));
    }
  }
  const preparedFile = await prepareMediaFileForUpload(input);
  const prepare_ms = input.runtime.now().getTime() - started;
  try {
    // A replacement is never "already uploaded": the server answers one that carries the same bytes itself.
    const existing = input.replace ? undefined : await existingUpload(input.client, preparedFile.prepared.declaration);
    const submitted = existing
      ? { mediaId: existing.mediaId, operation: existing.operation, reused: true, timing: { prepare_ms } }
      : await submitPreparedMedia(input, preparedFile).then(({ timing, ...rest }) => ({ ...rest, reused: false, timing: { prepare_ms, ...timing } }));
    const stored = existing ?? (submitted.mediaId && !input.replace ? await storedMediaFilename(input.client, submitted.mediaId) : {});
    return {
      ...submitted,
      upload: {
        filename: stored.filename ?? preparedFile.prepared.declaration.filename,
        declared_filename: preparedFile.prepared.declaration.filename,
        filename_source: stored.filename ? "server" : "declared",
        ...(stored.source_filename ?? preparedFile.prepared.declaration.source_filename
          ? { source_filename: stored.source_filename ?? preparedFile.prepared.declaration.source_filename }
          : {}),
        content_type: preparedFile.prepared.declaration.content_type,
        bytes: preparedFile.prepared.declaration.bytes,
        sha256: preparedFile.prepared.declaration.sha256,
        ...(preparedFile.prepared.declaration.tag ? { tag: preparedFile.prepared.declaration.tag } : {}),
        ...(preparedFile.prepared.declaration.folder_id ? { folder_id: preparedFile.prepared.declaration.folder_id } : {}),
      },
      transcode: transcodeEnvelope(preparedFile.transcode),
      warnings: uploadWarnings(preparedFile.prepared, preparedFile.transcode),
    };
  } finally {
    await cleanupPreparedMediaFile(preparedFile);
  }
}
