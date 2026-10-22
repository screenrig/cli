import { playsInstant } from "./playback-export.js";
import { usageError } from "./problems.js";

/** Rows asked per page of the cursor-paged series reads (screen presence, screen health-history, project health-trend); the CLI reads every page. */
export const SERIES_PAGE_SIZE = "500";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The window a series read covers when --from/--since is absent: this long before the end. */
export const HEALTH_DEFAULT_WINDOW_MS = 24 * HOUR_MS;
export const PRESENCE_DEFAULT_WINDOW_MS = 30 * DAY_MS;
/** Longest windows: raw health reports, hourly health, presence transitions. */
export const HEALTH_RAW_MAX_DAYS = 31;
export const HEALTH_HOURLY_MAX_DAYS = 93;
export const PRESENCE_MAX_DAYS = 366;
/** Daily uptime rows span at most this many inclusive UTC days. */
export const UPTIME_MAX_DAYS = 366;

/**
 * Resolve a time window locally so every page of one read shares its bounds:
 * the end defaults to now and the start to `defaultMs` before the end. The
 * bounds are RFC 3339 instants, an age such as 7d, or now.
 */
export function seriesWindow(input: {
  from: string | undefined;
  to: string | undefined;
  fromFlag: string;
  toFlag: string;
  now: Date;
  defaultMs: number;
  maxDays: number;
  advice?: string;
}): { from: string; to: string } {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");
  const toMs = input.to === undefined ? input.now.getTime() : playsInstant(input.to, input.toFlag, input.now);
  const fromMs = input.from === undefined ? toMs - input.defaultMs : playsInstant(input.from, input.fromFlag, input.now);
  if (fromMs >= toMs) throw usageError(`${input.fromFlag} must be before ${input.toFlag}.`);
  if (toMs - fromMs > input.maxDays * DAY_MS) {
    throw usageError(`${input.fromFlag} to ${input.toFlag} must span at most ${input.maxDays} days${input.advice ?? ""}.`);
  }
  return { from: iso(fromMs), to: iso(toMs) };
}
