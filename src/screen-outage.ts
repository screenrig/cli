import type { Screen } from "./adapters/protocol.js";

/**
 * The `Last outage` block of `screen show --human`: the screen's latest
 * presence outage (`Screen.last_outage`) and, when the first health report
 * after it decided one, its likely cause. A cause the server does not give, or
 * one this list does not know, prints nothing: unknown stays unknown.
 */
const CAUSES: Record<string, string> = {
  device_restart: "the device restarted (power loss or reboot)",
  app_crash: "the Player crashed and restarted",
  app_restart: "the Player restarted",
  network: "the screen's network connection",
  platform: "a screenRIG service interruption",
};

/** A server date-time that is safe to print: RFC 3339 shaped and parseable. */
function instant(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function span(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** The likely cause as the sentence stem the dashboard and the alert mail use, or nothing for an unknown one. */
export function likelyCauseText(cause: unknown, rebootCommand = false): string | undefined {
  if (typeof cause !== "string" || !Object.hasOwn(CAUSES, cause)) return undefined;
  return cause === "device_restart" && rebootCommand ? "the device restarted after a reboot command" : CAUSES[cause];
}

export function outageLines(screen: Screen | undefined): string[] {
  const outage = screen?.last_outage;
  if (!outage || typeof outage !== "object") return [];
  const since = instant(outage.offline_since);
  if (!since) return [];
  const back = instant(outage.back_at);
  // An outage with no end is told only for a screen that is offline now.
  if (!back && screen?.online !== false) return [];
  const seconds = typeof outage.duration_s === "number" && Number.isSafeInteger(outage.duration_s) && outage.duration_s >= 0 ? outage.duration_s : undefined;
  const lines = [back ? `Last outage: offline from ${since} to ${back}${seconds === undefined ? "" : ` (${span(seconds)})`}` : `Last outage: offline since ${since}`];
  const evidence = outage.evidence && typeof outage.evidence === "object" ? (outage.evidence as Record<string, unknown>) : {};
  const cause = likelyCauseText(outage.likely_cause, evidence.reboot_command === true);
  if (cause) lines.push(`Likely cause: ${cause}.`);
  return lines;
}
