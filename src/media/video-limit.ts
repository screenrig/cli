import type { ApiClient } from "../client.js";
import { usageError } from "../problems.js";

/**
 * The most bytes the server takes for one video upload from this project: its
 * plan's `media_video_bytes`, read from `GET /api/project/capabilities`. A
 * source over it is refused before it is read and never passed through
 * unchanged. The answer is kept for the client, so a batch asks once.
 */
const limits = new WeakMap<ApiClient, Promise<number>>();

export function projectVideoBytes(client: ApiClient): Promise<number> {
  let limit = limits.get(client);
  if (limit === undefined) {
    limit = readVideoBytes(client);
    limits.set(client, limit);
    // A failed read is asked again by the next upload.
    limit.catch(() => limits.delete(client));
  }
  return limit;
}

async function readVideoBytes(client: ApiClient): Promise<number> {
  const response = await client.call({ method: "GET", path: "/api/project/capabilities" });
  const bytes = (response.body as { media_video_bytes?: unknown } | undefined)?.media_video_bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw usageError("The project capabilities response does not state media_video_bytes, the video size limit of this project's plan.");
  }
  return bytes;
}

/** A video limit as the refusal words it: `500,000,000-byte (500 MB)`, `1,000,000,000-byte (1 GB)`. */
export function videoLimitText(bytes: number): string {
  const size = bytes % 1_000_000_000 === 0 ? `${bytes / 1_000_000_000} GB` : `${Math.round(bytes / 1_000_000)} MB`;
  return `${bytes.toLocaleString("en-US")}-byte (${size})`;
}
