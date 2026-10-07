import type { ApiClient } from "./client.js";
import type { TransportResponse } from "./transport/types.js";

/**
 * One request against a playlist.
 *
 * Reads carry no idempotency key, exactly like every other GET in the client.
 * Mutations keep one durable key per invocation, reused when the same write
 * is retried.
 */
export async function callPlaylist(
  client: ApiClient,
  options: {
    method: "GET" | "PUT" | "DELETE";
    id: string;
    body?: unknown;
    headers?: Record<string, string>;
    /** Overrides the per-invocation key when a caller derives its own durable key. */
    idempotencyKey?: string;
  },
): Promise<TransportResponse> {
  const target = encodeURIComponent(options.id);
  const idempotent = options.method !== "GET";
  return client.call({
    method: options.method,
    path: `/api/playlists/${target}`,
    idempotent,
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}
