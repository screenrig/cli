import type {
  ScreenEffectivePlaylist,
  ScreenScheduleEntry,
  ScreenScheduleEntryWrite,
  ScreenScheduleWindow,
  ScreenTakeover,
} from "./adapters/protocol.js";
import { CliError, usageError } from "./problems.js";

/**
 * Playlist schedules and takeover (backend "Playlist schedules and takeover").
 * Local checks mirror ScreenPlaylistScheduleWrite / ScreenTakeoverWrite shape
 * rules so a malformed file fails fast with a path; the server stays
 * authoritative for everything else (ownership, readiness, timezone, ranges).
 */
export const SCHEDULE_ENTRIES_MAX = 32;
export const SCHEDULE_WINDOWS_MAX = 16;
export const TAKEOVER_REASON_MAX = 120;
export const TAKEOVER_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const CIVIL = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$/;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function scheduleError(path: string, message: string): CliError {
  return usageError(`Schedule file: ${path} ${message}`, {
    command: "screenrig screen schedule --help",
    reason: "The file is {\"entries\": [{\"id\"?, \"playlist_id\", \"from\"?, \"until\"?, \"windows\": [{\"days\": [...], \"start\"?, \"end\"?}]}]} in priority order.",
  });
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw scheduleError(path, `has unknown field ${JSON.stringify(extra).slice(0, 80)}; allowed: ${allowed.join(", ")}.`);
}

function window(value: unknown, path: string): ScreenScheduleWindow {
  const item = record(value);
  if (!item) throw scheduleError(path, "must be an object with days and optional start and end.");
  onlyKeys(item, ["days", "start", "end"], path);
  const days = item.days;
  if (!Array.isArray(days) || days.length < 1 || days.length > 7) throw scheduleError(`${path}.days`, "must list 1 to 7 days.");
  days.forEach((day, index) => {
    if (typeof day !== "string" || !(DAYS as readonly string[]).includes(day)) {
      throw scheduleError(`${path}.days[${index}]`, `must be one of ${DAYS.join(", ")}.`);
    }
  });
  if (new Set(days).size !== days.length) throw scheduleError(`${path}.days`, "must not repeat a day.");
  for (const key of ["start", "end"] as const) {
    if (item[key] !== undefined && (typeof item[key] !== "string" || !CLOCK.test(item[key] as string))) {
      throw scheduleError(`${path}.${key}`, "must be HH:MM in 24-hour time, such as 07:30.");
    }
  }
  if ((item.start === undefined) !== (item.end === undefined)) {
    throw scheduleError(path, "must set both start and end, or neither for the whole day.");
  }
  return item as unknown as ScreenScheduleWindow;
}

function entry(value: unknown, path: string): ScreenScheduleEntryWrite {
  const item = record(value);
  if (!item) throw scheduleError(path, "must be an object.");
  onlyKeys(item, ["id", "playlist_id", "from", "until", "windows"], path);
  if (item.id !== undefined && (typeof item.id !== "string" || !ENTRY_ID.test(item.id))) {
    throw scheduleError(`${path}.id`, "must be 1 to 64 letters, digits, - or _.");
  }
  if (typeof item.playlist_id !== "string" || !item.playlist_id) throw scheduleError(`${path}.playlist_id`, "is required.");
  for (const key of ["from", "until"] as const) {
    if (item[key] !== undefined && (typeof item[key] !== "string" || !CIVIL.test(item[key] as string))) {
      throw scheduleError(`${path}.${key}`, "must be a civil minute such as 2026-12-24T18:00 (screen timezone, no offset).");
    }
  }
  if (typeof item.from === "string" && typeof item.until === "string" && item.from >= item.until) {
    throw scheduleError(path, "from must be before until.");
  }
  const windows = item.windows;
  if (!Array.isArray(windows) || windows.length < 1 || windows.length > SCHEDULE_WINDOWS_MAX) {
    throw scheduleError(`${path}.windows`, `must list 1 to ${SCHEDULE_WINDOWS_MAX} windows.`);
  }
  windows.forEach((item, index) => window(item, `${path}.windows[${index}]`));
  return item as unknown as ScreenScheduleEntryWrite;
}

/**
 * Accept `{ "entries": [...] }` (ScreenPlaylistScheduleWrite) or a bare entry
 * array. `updated_at` and `effective_playlist` are dropped, and a saved
 * `screen schedule show` envelope is unwrapped, so its output can be edited
 * and sent back.
 */
export function scheduleEntries(document: unknown): ScreenScheduleEntryWrite[] {
  let entries: unknown = document;
  // A saved `screen schedule show` envelope is accepted as-is.
  const envelope = record(document);
  if (envelope && envelope.ok === true && record(envelope.data)) document = envelope.data;
  const object = record(document);
  entries = object ? undefined : document;
  if (object) {
    onlyKeys(object, ["entries", "updated_at", "effective_playlist"], "document");
    entries = object.entries;
  }
  if (!Array.isArray(entries)) throw scheduleError("entries", "must be an array of schedule entries.");
  if (entries.length < 1) {
    throw usageError("Schedule file: entries must list at least one entry. To remove a schedule, run screen schedule clear.", {
      command: "screenrig screen schedule clear <id>", reason: "Clearing is its own command.",
    });
  }
  if (entries.length > SCHEDULE_ENTRIES_MAX) throw scheduleError("entries", `must list at most ${SCHEDULE_ENTRIES_MAX} entries.`);
  const parsed = entries.map((item, index) => entry(item, `entries[${index}]`));
  const ids = parsed.map((item) => item.id).filter((id): id is string => id !== undefined);
  if (new Set(ids).size !== ids.length) throw scheduleError("entries", "must not repeat an entry id.");
  return parsed.map((item) => ({
    ...(item.id !== undefined ? { id: item.id } : {}),
    playlist_id: item.playlist_id,
    ...(item.from !== undefined ? { from: item.from } : {}),
    ...(item.until !== undefined ? { until: item.until } : {}),
    windows: item.windows.map((w) => ({ days: w.days, ...(w.start !== undefined ? { start: w.start, end: w.end } : {}) })),
  }));
}

/**
 * `--for` is converted with this computer's clock and the server refuses an
 * until more than 7 days ahead of its clock, so keep a minute of headroom.
 */
export const TAKEOVER_FOR_MAX_MS = TAKEOVER_MAX_MS - 60_000;

/** `2h`, `30m`, `1h30m`, `2d`, `90s`: whole units, up to 7 days (at most 6d23h59m). */
export function durationMs(value: string): number {
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value.trim());
  const ms = match && value.trim()
    ? (Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0)) * 1000
    : NaN;
  if (!Number.isFinite(ms) || ms <= 0) throw usageError("--for takes a duration such as 30m, 2h, 1h30m, or 3d.");
  if (ms > TAKEOVER_FOR_MAX_MS) {
    throw usageError("--for must be under 7 days (at most 6d23h59m), leaving a minute for clock differences with the server. Use --until for an exact end, or --until none to hold until cleared.");
  }
  return ms;
}

export function durationOption(value: string): string {
  durationMs(value);
  return value;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Strict RFC 3339 with seconds and an offset (uppercase T and Z), normalized
 * to UTC `YYYY-MM-DDTHH:MM:SS[.mmm]Z` so the request never depends on how the
 * input was spelled.
 */
export function normalizeInstant(value: string): string | undefined {
  const match = RFC3339.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return undefined;
  const offset = match[8]!;
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

/** `--until RFC3339` or `--until none` (held until cleared). */
export function takeoverUntilOption(value: string): string {
  if (value === "none") return value;
  if (normalizeInstant(value) === undefined) {
    throw usageError("--until takes an RFC 3339 instant with seconds and an offset, such as 2026-09-26T18:00:00Z or 2026-09-26T11:00:00-07:00, or none.");
  }
  return value;
}

/** undefined = omitted (held until cleared), null = explicit none. */
export function takeoverUntil(until: string | undefined, forValue: string | undefined, now: Date): string | null | undefined {
  if (until !== undefined && forValue !== undefined) throw usageError("Use --until or --for, not both.");
  if (forValue !== undefined) return new Date(now.getTime() + durationMs(forValue)).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (until === undefined) return undefined;
  if (until === "none") return null;
  takeoverUntilOption(until);
  return normalizeInstant(until)!;
}

/** Trimmed; at most 120 characters; no Unicode control characters. */
export function takeoverReason(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw usageError("--reason must not be empty.");
  if ([...trimmed].length > TAKEOVER_REASON_MAX) throw usageError(`--reason must be at most ${TAKEOVER_REASON_MAX} characters.`);
  if (/\p{Cc}/u.test(trimmed)) throw usageError("--reason must not contain control characters.");
  return trimmed;
}

/**
 * An instant shown in the screen's timezone with the zone name, for example
 * `2026-08-14 10:30 America/Los_Angeles`. Without a usable zone, UTC labelled.
 */
export function instantInZone(value: string, timezone: string | undefined): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const render = (zone: string) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${zone}`;
  };
  if (timezone) {
    try { return render(timezone); } catch { /* unknown zone: fall back to UTC */ }
  }
  return render("UTC");
}

/** "pl_X (takeover until …)", "pl_X (schedule entry lunch until …)", "pl_X (default)". */
export function effectivePlaylistText(effective: ScreenEffectivePlaylist | undefined, takeover?: ScreenTakeover, timezone?: string): string | undefined {
  if (!effective || typeof effective.id !== "string") return undefined;
  const until = typeof effective.until === "string" ? ` until ${instantInZone(effective.until, timezone)}` : "";
  if (effective.source === "takeover") {
    const end = until || (typeof takeover?.until === "string" ? ` until ${instantInZone(takeover.until, timezone)}` : " until cleared");
    return `${effective.id} (takeover${end})`;
  }
  if (effective.source === "schedule") {
    return `${effective.id} (schedule${effective.entry_id ? ` entry ${effective.entry_id}` : ""}${until})`;
  }
  return `${effective.id} (default${until ? `, schedule changes it${until}` : ""})`;
}

export function playingLine(effective: ScreenEffectivePlaylist | undefined, takeover?: ScreenTakeover, timezone?: string): string[] {
  const text = effectivePlaylistText(effective, takeover, timezone);
  return text ? [`Playing: ${text}`] : [];
}

export function takeoverLine(takeover: ScreenTakeover | undefined, timezone?: string): string[] {
  if (!takeover || typeof takeover.playlist_id !== "string") return [];
  const until = typeof takeover.until === "string" ? `until ${instantInZone(takeover.until, timezone)}` : "until cleared";
  return [`Takeover: ${takeover.playlist_id} ${until}${takeover.reason ? ` (${takeover.reason})` : ""}`];
}

function windowText(item: ScreenScheduleWindow): string {
  const days = (item.days ?? []).join(",");
  return item.start !== undefined ? `${days} ${item.start}-${item.end}` : `${days} all day`;
}

export function scheduleTableLines(entries: ScreenScheduleEntry[] | undefined, timezone?: string | null): string[] {
  if (!entries?.length) return ["No playlist schedule"];
  const zone = timezone === undefined ? [] : [`Windows and FROM/UNTIL are civil times (screen timezone ${timezone || "not set"}).`];
  const rows = entries.map((item) => [
    item.id ?? "", item.playlist_id ?? "", (item.windows ?? []).map(windowText).join("; "),
    item.from ?? "", item.until ?? "",
  ]);
  const header = ["ENTRY", "PLAYLIST", "WINDOWS", "FROM", "UNTIL"];
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index]!.length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [...zone, render(header), ...rows.map(render)];
}

/** Guidance for schedule/takeover refusals on one screen. Exit codes stay status-derived. */
export function screenControlProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  const problem = error.problem;
  if (problem.code === "invalid_request" && /^playlist_id:.*default playlist/i.test(problem.detail)) {
    return new CliError({
      ...problem,
      detail: `Assign the screen a default playlist first: ${problem.detail}`,
      next: {
        command: `screenrig screen assign ${id} --playlist-id PLAYLIST_ID`,
        reason: "A schedule or takeover falls back to the assigned default when it ends, so the screen needs one. Assign it, then rerun.",
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "invalid_request" && /^timezone: /.test(problem.detail)) {
    return new CliError({
      ...problem,
      detail: `Set the screen timezone first: ${problem.detail}`,
      next: {
        command: `screenrig screen set-timezone ${id} --timezone America/Los_Angeles`,
        reason: "Schedules are civil times read in the screen timezone. Set an IANA zone, then rerun.",
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "screen_archived") {
    return new CliError({
      ...problem,
      next: { command: `screenrig screen unarchive ${id}`, reason: "An archived screen refuses schedules and takeovers. Unarchive it first if it should play again." },
    }, error.exitCode, error.warnings);
  }
  return error;
}

/** A playlist delete refused because a screen can still show it. */
export function playlistInUseProblem(error: unknown): unknown {
  if (!(error instanceof CliError) || error.problem.next || error.problem.code !== "resource_conflict") return error;
  if (!/assigned|schedule|takeover/i.test(error.problem.detail)) return error;
  return new CliError({
    ...error.problem,
    next: {
      command: "screenrig screen list",
      reason: "A screen can still show this playlist: it is assigned, named by a playlist schedule entry, held by a takeover, or effective. screen show ID reports playlist_id, playlist_schedule, takeover, and effective_playlist; change those first.",
    },
  }, error.exitCode, error.warnings);
}

/**
 * --for is converted with this computer's clock; when the server still
 * refuses the resulting until, its clock differs. Suggest a shorter --for.
 */
export function takeoverForProblem(error: unknown): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code !== "invalid_request" || !/^until: /.test(error.problem.detail)) return error;
  return new CliError({
    ...error.problem,
    next: {
      command: "rerun with a shorter --for, such as --for 6d23h",
      reason: "--for is converted with this computer's clock, which may differ from the server's. Check the clock, shorten --for, or pass --until as an exact instant.",
    },
  }, error.exitCode, error.warnings);
}
