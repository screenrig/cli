import { flagString } from "./command-input.js";
import { usageError } from "./problems.js";

export function cardTtl(value: string): string {
  const match = /^([1-9][0-9]*)(s|m|h|d)?$/.exec(value);
  const seconds = match ? Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? "s"] ?? 1) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 31536000) throw usageError("--ttl takes 1s to 365d, for example 30m or 12h.");
  return String(seconds);
}

export function cardExpiry(flags: Record<string, string | boolean>): { expires_at?: string; ttl_seconds?: number } {
  const at = flagString(flags, "expires-at");
  const ttl = flagString(flags, "ttl");
  if (at && ttl) throw usageError("Provide --expires-at or --ttl.");
  if (ttl) return { ttl_seconds: Number(cardTtl(ttl)) };
  if (!at) return {};
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at))) throw usageError("--expires-at requires an ISO timestamp with a timezone.");
  return { expires_at: new Date(at).toISOString() };
}
