import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MediaCommit, MediaUploadDeclaration, MediaUploadSession } from "./adapters/protocol.js";
import { isValidIdempotencyKey } from "./ids.js";
import { readWebpContainer } from "./media/webp.js";
import { networkError, usageError } from "./problems.js";
import type { SignedRawPut } from "./runtime.js";

const MEDIA_PUT_NOT_READY =
  "Private media upload did not complete because the service is not ready. Run screenrig --json doctor and check the ready result before retrying.";

export const SUPPORTED_MEDIA_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
] as const;

export type SupportedMediaContentType = (typeof SUPPORTED_MEDIA_CONTENT_TYPES)[number];

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
};

function supported(value: string): value is SupportedMediaContentType {
  return (SUPPORTED_MEDIA_CONTENT_TYPES as readonly string[]).includes(value);
}

export async function prepareMediaUpload(filePath: string, explicitContentType?: string, expectedSha256?: string): Promise<PreparedMediaUpload> {
  const filename = path.basename(filePath);
  if (!filename || Buffer.byteLength(filename, "utf8") > 255) throw usageError("Media filename must be 1 to 255 bytes.");
  const contentType = explicitContentType ?? EXTENSIONS[path.extname(filename).toLowerCase()];
  if (!contentType || !supported(contentType)) {
    throw usageError(`Unsupported media type; use one of: ${SUPPORTED_MEDIA_CONTENT_TYPES.join(", ")}.`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw usageError(`Cannot read media file: ${error instanceof Error ? error.message : "read failed"}`);
  }
  if (bytes.length < 1) throw usageError("Media file must not be empty.");
  if (contentType === "image/webp" && readWebpContainer(bytes)?.lossless) {
    throw usageError(
      "Lossless WebP (VP8L) is not accepted. Encode lossy WebP that keeps alpha, then upload with --no-transcode.",
    );
  }
  // 1 GiB is a plan-independent transport ceiling. The default plan has no
  // product storage cap. A custom ceiling, when present, is checked first and
  // rejected with quota_exceeded. Remaining prepaid credit of zero rejects
  // declare and commit with payment_required.
  if (bytes.length > 1_073_741_824) {
    throw usageError(
      "Media file exceeds the 1 GiB per-upload transport ceiling. Run screenrig account show " +
        "to inspect used_bytes, any content_limit_bytes ceiling, and credit_remaining.",
    );
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    throw usageError("Video bytes changed after delivery verification; retry the upload. No upload was started.");
  }
  const commit: MediaCommit = { content_type: contentType, bytes: bytes.length, sha256 };
  return { bytes, commit, declaration: { filename, ...commit } };
}

export function validateMediaUploadSession(input: MediaUploadSession, nowMs = Date.now()): ValidatedMediaUploadSession {
  if (!input || typeof input !== "object" || typeof input.id !== "string" || input.id.length === 0 ||
      !input.operation || typeof input.operation.id !== "string" || input.operation.id.length === 0) {
    throw usageError("Media upload declaration returned an invalid binding.");
  }
  if (input.method !== "PUT") throw usageError("Media upload declaration returned an unsupported method.");
  let parsed: URL;
  try { parsed = new URL(input.upload_url); } catch { throw usageError("Media upload declaration returned an invalid URL."); }
  if (!/^(https?:)$/.test(parsed.protocol) || !parsed.host || parsed.username || parsed.password) {
    throw usageError("Media upload declaration returned an unsafe URL.");
  }
  if (!input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) {
    throw usageError("Media upload declaration returned invalid signed headers.");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (!name || typeof value !== "string" || !value || /[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw usageError("Media upload declaration returned invalid signed headers.");
    }
    headers[name] = value;
  }
  const expiresAt = Date.parse(input.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) throw usageError("Media upload declaration is expired or invalid.");
  return { id: input.id, operationId: input.operation.id, uploadUrl: input.upload_url, headers, expiresAt };
}

export async function performSignedMediaPut(
  prepared: PreparedMediaUpload,
  session: ValidatedMediaUploadSession,
  signedRawPut: SignedRawPut,
): Promise<void> {
  return performSignedMediaBodyPut(prepared.bytes, session, signedRawPut);
}

export async function performSignedMediaFilePut(
  filePath: string,
  session: ValidatedMediaUploadSession,
  signedRawPut: SignedRawPut,
): Promise<void> {
  return performSignedMediaBodyPut(createReadStream(filePath), session, signedRawPut);
}

export async function performSignedMediaStreamPut(
  body: AsyncIterable<Uint8Array>,
  session: ValidatedMediaUploadSession,
  signedRawPut: SignedRawPut,
): Promise<void> {
  return performSignedMediaBodyPut(body, session, signedRawPut);
}

async function performSignedMediaBodyPut(
  body: Uint8Array | AsyncIterable<Uint8Array>,
  session: ValidatedMediaUploadSession,
  signedRawPut: SignedRawPut,
): Promise<void> {
  let response;
  try {
    response = await signedRawPut({
      url: session.uploadUrl,
      method: "PUT",
      headers: session.headers,
      body,
      credentials: "omit",
      redirect: "error",
    });
  } catch {
    throw networkError(MEDIA_PUT_NOT_READY);
  }
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 503) {
      throw networkError(MEDIA_PUT_NOT_READY);
    }
    throw networkError(`Private media upload returned HTTP ${response.status}.`);
  }
}

export function deriveCommitIdempotencyKey(base: string): string {
  if (!isValidIdempotencyKey(base)) throw usageError("Invalid base idempotency key for media commit.");
  const derived = createHash("sha256").update("screenrig.media.commit\0").update(base).digest("base64url");
  if (derived === base || !isValidIdempotencyKey(derived)) throw usageError("Could not derive media commit idempotency key.");
  return derived;
}
