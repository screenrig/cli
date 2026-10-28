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
 * The `Glass` block of screen show: the stalled playback verdict and the blank or
 * frozen picture verdict, the ones a person acts on. A screen the checks never
 * found in a problem, or no longer judge, prints nothing; the JSON body carries
 * the whole member. The checks judge only an online screen with current content
 * and leave a display that is off, a takeover, a single still and a video wall
 * alone, so a verdict is not a guess about those.
 */
export function glassLines(screen: Screen | undefined): string[] {
  return [...playbackLines(screen), ...pictureLines(screen)];
}

function playbackLines(screen: Screen | undefined): string[] {
  const playback = screen?.glass?.playback;
  if (!playback || playback.verdict !== "stalled") return [];
  const since = instant(playback.since);
  const last = instant(playback.last_media_start_at);
  const allowed = typeof playback.threshold_s === "number" && Number.isFinite(playback.threshold_s) && playback.threshold_s > 0 ? playback.threshold_s : undefined;
  const screenId = screenIdOf(screen);
  return [
    `Playlist stalled${since ? ` since ${since}` : ""}: no media start has reached ScreenRig${allowed ? ` for more than ${minutes(allowed)}` : " for longer than the loop allows"}${last ? ` (the last was at ${last})` : ""}, although the screen is online and its content is current.`,
    `Look at the picture with screen screenshot ${screenId}, or restart the Player with screen reload ${screenId}. It clears when a media start arrives.`,
  ];
}

function pictureLines(screen: Screen | undefined): string[] {
  const picture = screen?.glass?.picture;
  if (!picture || (picture.verdict !== "blank" && picture.verdict !== "frozen")) return [];
  const since = instant(picture.since);
  const screenId = screenIdOf(screen);
  const found = picture.verdict === "blank" ? "was one flat tone" : "was the same picture";
  return [
    `${picture.verdict === "blank" ? "Blank screen" : "Frozen picture"}${since ? ` since ${since}` : ""}: every screenshot ScreenRig took over a run that covers the whole loop ${found}, although the screen is online and its content is current.`,
    `Look at it with screen screenshot ${screenId}, or restart the Player with screen reload ${screenId}. It clears after two screenshots in a row that show a moving picture.`,
  ];
}

function screenIdOf(screen: Screen | undefined): string {
  return typeof screen?.id === "string" && screen.id ? screen.id : "<id>";
}

/**
 * The frame row of screen screenshot: whether this one image is a single flat
 * tone. It describes the image, not the screen.
 */
export function frameRow(frame: { flat?: unknown } | undefined): string | undefined {
  if (!frame || typeof frame.flat !== "boolean") return undefined;
  return frame.flat ? "flat (one tone)" : "not flat";
}

/**
 * What to say beside a flat frame. One flat frame can be a transition between
 * pages or a page that is black on purpose, so it is no verdict: ScreenRig calls a
 * screen blank only from screenshots that cover its whole loop.
 */
export function flatFrameNote(frame: { flat?: unknown } | undefined, screen: Screen | undefined): string[] {
  if (!frame || frame.flat !== true || screen?.glass?.picture?.verdict === "blank") return [];
  return ["This image is one flat tone. That alone is no verdict: a transition between pages, or a page that is black on purpose, looks the same. ScreenRig calls a screen blank (screen show, alerts) only when screenshots that cover its whole loop are all flat."];
}
