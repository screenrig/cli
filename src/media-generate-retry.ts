import { createHash } from "node:crypto";
import { readConfigFile, withConfigLock, writeConfigAtomic, type ResolvedConfig } from "./config.js";
import { isValidIdempotencyKey, newIdempotencyKey } from "./ids.js";
import type { EnrollmentRuntime } from "./enrollment.js";
import { usageError } from "./problems.js";

/**
 * `media generate` is one blocking, billed call. When it times out or the
 * connection drops, the caller cannot tell whether the still was created and
 * billed. The key that made the request is therefore persisted before the
 * request goes out, so re-running the identical command retries under the same
 * Idempotency-Key and the server replays the original MediaGeneration instead
 * of generating and billing a second still. The record is cleared as soon as a
 * generation returns.
 */
export interface GenerateRetryState {
  idempotency_key: string;
  /** Hash of the billable request. The prompt itself never lands in the config. */
  request_hash: string;
}

export interface GenerateRequestFingerprint {
  prompt: string;
  aspect_ratio?: string;
  quality?: string;
  tag?: string;
}

export function generateRequestHash(request: GenerateRequestFingerprint): string {
  return createHash("sha256")
    .update(JSON.stringify([request.prompt, request.aspect_ratio ?? "", request.quality ?? "", request.tag ?? ""]))
    .digest("hex");
}

/**
 * Reuse the pending key when the request is identical to the one that did not
 * resolve, and start a fresh key otherwise. A different request never inherits
 * a previous key: replay is only correct for a byte-identical generation.
 */
export async function generateRetryState(options: {
  resolved: ResolvedConfig;
  runtime: EnrollmentRuntime;
  requestHash: string;
  requestedKey?: string;
  generateIdempotencyKey?: () => string;
}): Promise<{ state: GenerateRetryState; reused: boolean }> {
  return withConfigLock(
    options.resolved.configPath,
    options.runtime.fs,
    { sleep: options.runtime.sleep, now: () => options.runtime.now().getTime() },
    async () => {
      const current = await readConfigFile(options.resolved.configPath, options.runtime.fs);
      const pending = current?.media_generate;
      const reused =
        pending !== undefined &&
        pending.request_hash === options.requestHash &&
        (options.requestedKey === undefined || options.requestedKey === pending.idempotency_key);
      const idempotencyKey = reused
        ? pending.idempotency_key
        : options.requestedKey ?? (options.generateIdempotencyKey ?? newIdempotencyKey)();
      if (!isValidIdempotencyKey(idempotencyKey)) {
        throw usageError("media generate idempotency key is invalid.");
      }
      const state: GenerateRetryState = { idempotency_key: idempotencyKey, request_hash: options.requestHash };
      if (!reused || pending.idempotency_key !== idempotencyKey) {
        await writeConfigAtomic(
          options.resolved.configPath,
          {
            ...(current ?? { api_url: options.resolved.apiUrl }),
            media_generate: state,
            updated_at: options.runtime.now().toISOString(),
          },
          options.runtime.fs,
        );
      }
      return { state, reused };
    },
  );
}

export async function clearGenerateRetryState(
  resolved: ResolvedConfig,
  runtime: EnrollmentRuntime,
  idempotencyKey: string,
): Promise<void> {
  await withConfigLock(
    resolved.configPath,
    runtime.fs,
    { sleep: runtime.sleep, now: () => runtime.now().getTime() },
    async () => {
      const current = await readConfigFile(resolved.configPath, runtime.fs);
      if (!current || current.media_generate?.idempotency_key !== idempotencyKey) return;
      const { media_generate: _resolvedGeneration, ...rest } = current;
      await writeConfigAtomic(resolved.configPath, rest, runtime.fs);
    },
  );
}
