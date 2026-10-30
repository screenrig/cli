import type {
  LevelDate,
  LevelInteraction,
  LevelMembers,
  LevelMonthly,
  PageDataCondition,
  ScreenEffectivePlaylist,
  ScreenScheduleDay,
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
export const SCHEDULE_MONTHLY_MAX = 16;
export const SCHEDULE_DATES_MAX = 100;
export const SCHEDULE_EXCEPT_MAX = 100;
export const LEVEL_DISPLAYS_MAX = 12;
export const LEVEL_IDLE_MIN_S = 5;
export const LEVEL_IDLE_MAX_S = 3600;
export const LEVEL_IDLE_DEFAULT_S = 60;
export const TAKEOVER_REASON_MAX = 120;
export const TAKEOVER_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const CIVIL = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$/;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NTHS: readonly unknown[] = [1, 2, 3, 4, -1];
const COVERS: readonly unknown[] = ["full", "main", "header", "footer", "side"];
const STARTS: readonly unknown[] = ["next_item", "on_time"];
/** The data key of a card, or the {screen.weather} template; feed keys are not accepted. */
const DATA_KEY = /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}|\{screen\.weather\})$/;
const ENTRY_KEYS = ["id", "playlist_id", "from", "until", "windows", "monthly", "dates", "except", "data", "interaction", "covers", "displays", "start", "paused"];
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function scheduleError(path: string, message: string): CliError {
  return usageError(`Schedule file: ${path} ${message}`, {
    command: "screenrig screen schedule --help",
    reason: "The file is {\"entries\": [{\"id\"?, \"playlist_id\", \"from\"?, \"until\"?, \"windows\"?, \"monthly\"?, \"dates\"?, \"except\"?, \"data\"?, \"interaction\"?, \"covers\"?, \"displays\"?, \"start\"?}]} in priority order, each entry with at least one of from, until, windows, monthly, dates, except, data or interaction.",
  });
}

type Fail = (path: string, message: string) => CliError;

function onlyKeys(value: Record<string, unknown>, allowed: string[], path: string, fail: Fail = scheduleError): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw fail(path, `has unknown field ${JSON.stringify(extra).slice(0, 80)}; allowed: ${allowed.join(", ")}.`);
}

/** start and end are HH:MM together, or both absent for the whole day. */
function clockEdges(item: Record<string, unknown>, path: string, fail: Fail): void {
  for (const key of ["start", "end"] as const) {
    if (item[key] !== undefined && (typeof item[key] !== "string" || !CLOCK.test(item[key] as string))) {
      throw fail(`${path}.${key}`, "must be HH:MM in 24-hour time, such as 07:30.");
    }
  }
  if ((item.start === undefined) !== (item.end === undefined)) {
    throw fail(path, "must set both start and end, or neither for the whole day.");
  }
}

/** One screenrig.schedule/v1 window; `fail` names the file kind in the error. */
export function scheduleWindow(value: unknown, path: string, fail: Fail = scheduleError): ScreenScheduleWindow {
  const item = record(value);
  if (!item) throw fail(path, "must be an object with days and optional start and end.");
  const extra = Object.keys(item).find((key) => !["days", "start", "end"].includes(key));
  if (extra !== undefined) throw fail(path, `has unknown field ${JSON.stringify(extra).slice(0, 80)}; allowed: days, start, end.`);
  const days = item.days;
  if (!Array.isArray(days) || days.length < 1 || days.length > 7) throw fail(`${path}.days`, "must list 1 to 7 days.");
  days.forEach((day, index) => {
    if (typeof day !== "string" || !(DAYS as readonly string[]).includes(day)) {
      throw fail(`${path}.days[${index}]`, `must be one of ${DAYS.join(", ")}.`);
    }
  });
  if (new Set(days).size !== days.length) throw fail(`${path}.days`, "must not repeat a day.");
  clockEdges(item, path, fail);
  return item as unknown as ScreenScheduleWindow;
}

/** A real calendar day written YYYY-MM-DD. */
export function isCivilDate(value: unknown): value is string {
  const match = typeof value === "string" ? CIVIL_DATE.exec(value) : null;
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 && Number(match[3]) >= 1 && Number(match[3]) <= daysInMonth(Number(match[1]), month);
}

/** One monthly occurrence: day (1 to 31), or nth (1 to 4, -1 the last) and weekday, with optional start and end. */
export function scheduleMonthly(value: unknown, path: string, fail: Fail = scheduleError): LevelMonthly {
  const item = record(value);
  if (!item) throw fail(path, "must be an object with day, or nth and weekday, and optional start and end.");
  onlyKeys(item, ["day", "nth", "weekday", "start", "end"], path, fail);
  if (item.day !== undefined) {
    if (item.nth !== undefined || item.weekday !== undefined) throw fail(path, "must set either day, or nth and weekday, not both.");
    if (typeof item.day !== "number" || !Number.isInteger(item.day) || item.day < 1 || item.day > 31) {
      throw fail(`${path}.day`, "must be a day of the month from 1 to 31.");
    }
  } else {
    if (item.nth === undefined && item.weekday === undefined) throw fail(path, "must set day, or nth and weekday.");
    if (!NTHS.includes(item.nth)) throw fail(`${path}.nth`, "must be 1, 2, 3, 4 or -1 for the last, with weekday.");
    if (typeof item.weekday !== "string" || !(DAYS as readonly string[]).includes(item.weekday)) {
      throw fail(`${path}.weekday`, `must be one of ${DAYS.join(", ")}, with nth.`);
    }
  }
  clockEdges(item, path, fail);
  return {
    ...(item.day !== undefined ? { day: item.day as number } : { nth: item.nth as LevelMonthly["nth"], weekday: item.weekday as ScreenScheduleDay }),
    ...(item.start !== undefined ? { start: item.start as string, end: item.end as string } : {}),
  };
}

/** One specific civil date with optional start and end. */
export function scheduleDate(value: unknown, path: string, fail: Fail = scheduleError): LevelDate {
  const item = record(value);
  if (!item) throw fail(path, "must be an object with date and optional start and end.");
  onlyKeys(item, ["date", "start", "end"], path, fail);
  if (!isCivilDate(item.date)) throw fail(`${path}.date`, "must be a real civil date such as 2026-12-24.");
  clockEdges(item, path, fail);
  return { date: item.date, ...(item.start !== undefined ? { start: item.start as string, end: item.end as string } : {}) };
}

/** Exception dates: 1 to 100 real civil dates, each once; returned ascending, the order the server stores. */
export function scheduleExcept(value: unknown, path: string, fail: Fail = scheduleError): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SCHEDULE_EXCEPT_MAX) throw fail(path, `must list 1 to ${SCHEDULE_EXCEPT_MAX} dates.`);
  value.forEach((date, index) => {
    if (!isCivilDate(date)) throw fail(`${path}[${index}]`, "must be a real civil date such as 2026-12-25.");
  });
  const dates = [...value as string[]].sort();
  const repeated = dates.find((date, index) => index > 0 && date === dates[index - 1]);
  if (repeated !== undefined) throw fail(path, `must not repeat ${repeated}.`);
  return dates;
}

/** A card-data condition: key, and optionally an RFC 6901 path and a scalar to equal. */
export function scheduleData(value: unknown, path: string, fail: Fail = scheduleError): PageDataCondition {
  const item = record(value);
  if (!item) throw fail(path, "must be an object with key and optional path and equals.");
  onlyKeys(item, ["key", "path", "equals"], path, fail);
  if (typeof item.key !== "string" || !DATA_KEY.test(item.key) || item.key.startsWith("feed:")) {
    throw fail(`${path}.key`, "must name card data (a project data key or card instance ID, or {screen.weather}), not a feed.");
  }
  const pointer = item.path;
  if (pointer !== undefined && (typeof pointer !== "string" || Buffer.byteLength(pointer, "utf8") > 256 || (pointer !== "" && !pointer.startsWith("/"))
    || /~(?:[^01]|$)/.test(pointer) || pointer.split("/").length > 17)) {
    throw fail(`${path}.path`, "must be an RFC 6901 pointer of at most 256 bytes and 16 segments.");
  }
  if (Object.hasOwn(item, "equals")) {
    const expected = item.equals;
    if (expected !== null && typeof expected !== "string" && typeof expected !== "boolean" && !(typeof expected === "number" && Number.isFinite(expected))) {
      throw fail(`${path}.equals`, "must be a string, number, boolean or null.");
    }
    if (typeof expected === "string" && Buffer.byteLength(expected, "utf8") > 1024) throw fail(`${path}.equals`, "must be at most 1024 bytes.");
  }
  return {
    key: item.key,
    ...(pointer !== undefined ? { path: pointer as string } : {}),
    ...(Object.hasOwn(item, "equals") ? { equals: item.equals as PageDataCondition["equals"] } : {}),
  };
}

/** Interaction: the level holds while someone uses the screen; idle_s is 5 to 3600 seconds (60 when omitted). */
export function scheduleInteraction(value: unknown, path: string, fail: Fail = scheduleError): LevelInteraction {
  const item = record(value);
  if (!item) throw fail(path, "must be an object with an optional idle_s.");
  onlyKeys(item, ["idle_s"], path, fail);
  if (item.idle_s !== undefined && (typeof item.idle_s !== "number" || !Number.isInteger(item.idle_s) || item.idle_s < LEVEL_IDLE_MIN_S || item.idle_s > LEVEL_IDLE_MAX_S)) {
    throw fail(`${path}.idle_s`, `must be a whole number of seconds from ${LEVEL_IDLE_MIN_S} to ${LEVEL_IDLE_MAX_S}.`);
  }
  return item.idle_s !== undefined ? { idle_s: item.idle_s } : {};
}

/** Video wall outputs: 1 to 12 unique whole numbers from 1 to 12; returned ascending. */
export function scheduleDisplays(value: unknown, path: string, fail: Fail = scheduleError): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > LEVEL_DISPLAYS_MAX) throw fail(path, `must list 1 to ${LEVEL_DISPLAYS_MAX} displays.`);
  value.forEach((display, index) => {
    if (typeof display !== "number" || !Number.isInteger(display) || display < 1 || display > LEVEL_DISPLAYS_MAX) {
      throw fail(`${path}[${index}]`, `must be a display number from 1 to ${LEVEL_DISPLAYS_MAX}.`);
    }
  });
  if (new Set(value).size !== value.length) throw fail(path, "must not repeat a display.");
  return [...value as number[]].sort((a, b) => a - b);
}

function memberList<T>(value: unknown, path: string, max: number, noun: string, each: (item: unknown, path: string) => T, fail: Fail): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw fail(path, `must list 1 to ${max} ${noun}.`);
  return value.map((item, index) => each(item, `${path}[${index}]`));
}

/**
 * The rule and placement members of a schedule entry (windows, monthly, dates,
 * except, data, interaction, covers, displays, start), each checked and
 * normalized; a member the item does not set stays absent. from and until are
 * the caller's.
 */
export function scheduleLevelMembers(item: Record<string, unknown>, path: string, fail: Fail = scheduleError): LevelMembers {
  const members: LevelMembers = {};
  if (item.windows !== undefined) {
    members.windows = memberList(item.windows, `${path}.windows`, SCHEDULE_WINDOWS_MAX, "windows", (window, windowPath) => {
      const checked = scheduleWindow(window, windowPath, fail);
      return { days: checked.days, ...(checked.start !== undefined ? { start: checked.start, end: checked.end } : {}) };
    }, fail);
  }
  if (item.monthly !== undefined) members.monthly = memberList(item.monthly, `${path}.monthly`, SCHEDULE_MONTHLY_MAX, "monthly rules", (monthly, monthlyPath) => scheduleMonthly(monthly, monthlyPath, fail), fail);
  if (item.dates !== undefined) members.dates = memberList(item.dates, `${path}.dates`, SCHEDULE_DATES_MAX, "dates", (date, datePath) => scheduleDate(date, datePath, fail), fail);
  if (item.except !== undefined) members.except = scheduleExcept(item.except, `${path}.except`, fail);
  if (item.data !== undefined) members.data = scheduleData(item.data, `${path}.data`, fail);
  if (item.interaction !== undefined) members.interaction = scheduleInteraction(item.interaction, `${path}.interaction`, fail);
  if (item.covers !== undefined) {
    if (!COVERS.includes(item.covers)) throw fail(`${path}.covers`, "must be full, main, header, footer or side.");
    members.covers = item.covers as LevelMembers["covers"];
  }
  if (item.displays !== undefined) members.displays = scheduleDisplays(item.displays, `${path}.displays`, fail);
  if (item.start !== undefined) {
    if (!STARTS.includes(item.start)) throw fail(`${path}.start`, "must be next_item or on_time.");
    members.start = item.start as LevelMembers["start"];
  }
  return members;
}

function entry(value: unknown, path: string): ScreenScheduleEntryWrite {
  const item = record(value);
  if (!item) throw scheduleError(path, "must be an object.");
  onlyKeys(item, ENTRY_KEYS, path);
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
  const members = scheduleLevelMembers(item, path);
  if (item.paused !== undefined && typeof item.paused !== "boolean") throw scheduleError(`${path}.paused`, "must be true (a draft) or false.");
  // An entry holds while its rule members hold, so it needs at least one.
  if (item.from === undefined && item.until === undefined && !["windows", "monthly", "dates", "except", "data", "interaction"].some((key) => item[key] !== undefined)) {
    throw scheduleError(path, "must set at least one rule: windows, monthly, dates, except, from, until, data or interaction.");
  }
  return {
    ...(item.id !== undefined ? { id: item.id } : {}),
    playlist_id: item.playlist_id,
    ...(item.from !== undefined ? { from: item.from as string } : {}),
    ...(item.until !== undefined ? { until: item.until as string } : {}),
    ...members,
    ...(item.paused !== undefined ? { paused: item.paused as boolean } : {}),
  };
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
  return parsed;
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

/**
 * What a screen plays and why, in the server's order of precedence: "pl_X
 * (takeover until …)", "pl_X (campaign cmp_Y until …)", "pl_X (schedule entry
 * lunch until …)", "pl_X (default)". A default carries until when a campaign or
 * schedule boundary is next to change it.
 */
export function effectivePlaylistText(effective: ScreenEffectivePlaylist | undefined, takeover?: ScreenTakeover, timezone?: string): string | undefined {
  if (!effective || typeof effective.id !== "string") return undefined;
  const until = typeof effective.until === "string" ? ` until ${instantInZone(effective.until, timezone)}` : "";
  if (effective.source === "takeover") {
    const end = until || (typeof takeover?.until === "string" ? ` until ${instantInZone(takeover.until, timezone)}` : " until cleared");
    return `${effective.id} (takeover${end})`;
  }
  if (effective.source === "campaign") {
    return `${effective.id} (campaign${effective.entry_id ? ` ${effective.entry_id}` : ""}${until})`;
  }
  if (effective.source === "schedule") {
    return `${effective.id} (schedule${effective.entry_id ? ` entry ${effective.entry_id}` : ""}${until})`;
  }
  // No playlist of its own: the default of the nearest screen folder holding the screen (entry_id is that folder).
  if (effective.source === "folder") {
    return `${effective.id} (folder${effective.entry_id ? ` ${effective.entry_id}` : ""} default${until ? `, a campaign or schedule changes it${until}` : ""})`;
  }
  return `${effective.id} (default${until ? `, a campaign or schedule changes it${until}` : ""})`;
}

export function assignmentLine(effective: ScreenEffectivePlaylist | undefined, takeover?: ScreenTakeover, timezone?: string): string[] {
  const text = effectivePlaylistText(effective, takeover, timezone);
  return text ? [`Assigned: ${text}`] : [];
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

const WEEKDAY_NAMES: Record<ScreenScheduleDay, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};
const NTH_NAMES = new Map<number, string>([[1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [-1, "last"]]);

function timesText(item: { start?: string; end?: string }): string {
  return item.start !== undefined && item.end !== undefined ? ` ${item.start}–${item.end}` : "";
}

/** A monthly rule in words: "day 15", "2nd Tuesday", "last Sunday 09:00–14:00". */
export function monthlyText(item: LevelMonthly): string {
  const what = item.day !== undefined
    ? `day ${item.day}`
    : `${NTH_NAMES.get(item.nth ?? 0) ?? String(item.nth)} ${item.weekday ? WEEKDAY_NAMES[item.weekday] ?? item.weekday : ""}`.trimEnd();
  return `${what}${timesText(item)}`;
}

/** A specific date: "2026-12-24" or "2026-12-24 18:00–22:00". */
export function dateText(item: LevelDate): string {
  return `${item.date}${timesText(item)}`;
}

/** A card-data condition: "data {screen.weather} /condition = "rain"", or "data KEY exists" without equals. */
export function dataConditionText(item: PageDataCondition): string {
  return `data ${item.key}${item.path ? ` ${item.path}` : ""}${Object.hasOwn(item, "equals") ? ` = ${JSON.stringify(item.equals)}` : " exists"}`;
}

/** "on touch (idle 60 s)": the level holds while someone uses the screen. */
export function interactionText(item: LevelInteraction): string {
  return `on touch (idle ${item.idle_s ?? LEVEL_IDLE_DEFAULT_S} s)`;
}

/** The rule members beyond from, until and windows, as phrases: monthly, "on DATE", "except DATES", data, "on touch (idle N s)". */
export function levelRuleParts(level: LevelMembers): string[] {
  return [
    ...(level.monthly ?? []).map(monthlyText),
    ...(level.dates ?? []).map((item) => `on ${dateText(item)}`),
    ...(level.except?.length ? [`except ${level.except.join(", ")}`] : []),
    ...(level.data ? [dataConditionText(level.data)] : []),
    ...(level.interaction ? [interactionText(level.interaction)] : []),
  ];
}

/** Where and how a level plays when that is not the default: "covers header", "displays 1, 2", "starts on time". */
export function levelPlacementParts(level: LevelMembers): string[] {
  return [
    ...(level.covers && level.covers !== "full" ? [`covers ${level.covers}`] : []),
    ...(level.displays?.length ? [`displays ${level.displays.join(", ")}`] : []),
    ...(level.start === "on_time" ? ["starts on time"] : []),
  ];
}

export function scheduleTableLines(entries: ScreenScheduleEntry[] | undefined, timezone?: string | null): string[] {
  if (!entries?.length) return ["No playlist schedule"];
  // A paused entry is a draft: stored, but on no stack until it is published.
  const rules = entries.map((item) => [...(item.paused ? ["draft (paused)"] : []), ...levelRuleParts(item), ...levelPlacementParts(item)].join("; "));
  const withRules = rules.some((text) => text !== "");
  const zone = timezone === undefined ? [] : [`${withRules ? "Windows, FROM/UNTIL and the monthly and date rules" : "Windows and FROM/UNTIL"} are civil times (screen timezone ${timezone || "not set"}).`];
  const rows = entries.map((item, index) => [
    item.id ?? "", item.playlist_id ?? "", (item.windows ?? []).map(windowText).join("; "),
    item.from ?? "", item.until ?? "", ...(withRules ? [rules[index]!] : []),
  ]);
  const header = ["ENTRY", "PLAYLIST", "WINDOWS", "FROM", "UNTIL", ...(withRules ? ["RULES"] : [])];
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
        command: `screenrig screen set-timezone ${id} --timezone ZONE`,
        reason: "Schedules are civil times read in the screen timezone. Replace ZONE with the IANA name of where the screen is (for example Europe/London or America/New_York; ask the user if unsure), then rerun.",
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
      reason: "A screen can still show this playlist: it is assigned, named by a playlist schedule entry, held by a takeover, shown by a campaign, or effective. screen show ID reports playlist_id, playlist_schedule, takeover, and effective_playlist, and campaign explain ID names the campaign a screen plays; change those first.",
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
