import type { Screen } from "./adapters/protocol.js";

/** A server date-time that is safe to print: RFC 3339 shaped and parseable. */
function instant(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

function minutes(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds / 60));
  return whole >= 120 ? `${Math.round(whole / 60)} hours` : `${whole} minute${whole === 1 ? "" : "s"}`;
}

/**
 * The `Glass` block of screen show: the playback check's stalled verdict, which is
 * the one a person acts on. A screen the check never found stalled, or no longer
 * judges, prints nothing; the JSON body carries the whole member. The check
 * judges only an online screen with current content and a numbering Player, and
 * leaves a display that is off, a takeover, a single still and a video wall alone,
 * so a stalled verdict is not a guess about those.
 */
export function glassLines(screen: Screen | undefined): string[] {
  const playback = screen?.glass?.playback;
  if (!playback || playback.verdict !== "stalled") return [];
  const since = instant(playback.since);
  const last = instant(playback.last_media_start_at);
  const allowed = typeof playback.threshold_s === "number" && Number.isFinite(playback.threshold_s) && playback.threshold_s > 0 ? playback.threshold_s : undefined;
  const screenId = typeof screen?.id === "string" && screen.id ? screen.id : "<id>";
  return [
    `Playlist stalled${since ? ` since ${since}` : ""}: no media start has reached ScreenRig${allowed ? ` for more than ${minutes(allowed)}` : " for longer than the loop allows"}${last ? ` (the last was at ${last})` : ""}, although the screen is online and its content is current.`,
    `Look at the picture with screen screenshot ${screenId}, or restart the Player with screen reload ${screenId}. It clears when a media start arrives.`,
  ];
}
