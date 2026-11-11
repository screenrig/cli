import { formatLogfmtValue } from "../handlers/events.js";
import { redactEvent, redactText } from "../redact.js";
import type { LogEntry } from "./session.js";

/** One line for a person: logfmt, with the message redacted. */
export function formatDevLine(entry: LogEntry): string {
  const parts = [`at=${entry.at}`, `type=${entry.type}`];
  if (entry.level) parts.push(`level=${entry.level}`);
  if (entry.code) parts.push(`code=${formatLogfmtValue(entry.code)}`);
  if (entry.message) parts.push(`message=${formatLogfmtValue(redactText(entry.message))}`);
  for (const [key, value] of Object.entries(redactEvent(entry.detail ?? {}) as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") parts.push(`${key}=${formatLogfmtValue(typeof value === "string" ? redactText(value) : value)}`);
  }
  return parts.join(" ");
}

/** The data of one streamed envelope. */
export function devEventData(entry: LogEntry): Record<string, unknown> {
  return redactEvent({
    event: entry.type, at: entry.at,
    ...(entry.level ? { level: entry.level } : {}),
    ...(entry.code ? { code: entry.code } : {}),
    ...(entry.message ? { message: redactText(entry.message) } : {}),
    ...(entry.detail ?? {}),
  }) as Record<string, unknown>;
}
