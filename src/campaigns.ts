import { CliError, usageError } from "./problems.js";
import type {
  Campaign,
  CampaignAudience,
  CampaignReach,
  CampaignScreens,
  CampaignStatus,
  LevelDate,
  LevelMonthly,
  PageDataCondition,
  ScreenCampaigns,
  ScreenExplainAt,
  ScreenScheduleDay,
  ScreenVerdict,
  ScreenScheduleWindow,
} from "./adapters/protocol.js";
import { isResourceID } from "./generated/resource-ids.js";
import {
  effectivePlaylistText, instantInZone, isCivilDate, LEVEL_DISPLAYS_MAX, LEVEL_IDLE_DEFAULT_S, LEVEL_IDLE_MAX_S, LEVEL_IDLE_MIN_S, levelRuleParts,
  SCHEDULE_DATES_MAX, SCHEDULE_EXCEPT_MAX, SCHEDULE_MONTHLY_MAX, scheduleData, scheduleDate, scheduleMonthly, scheduleWindow,
} from "./screen-control.js";
import { SCREEN_TAG_PATTERN, screenFolderId } from "./screen-fleet.js";

/** Backend Campaign.id shape (vendor/openapi.yaml). Advertising campaigns share the cmp_ prefix but are a different resource. */
export const CAMPAIGN_ID_PATTERN = /^(?:(?:stage|qa|development)_)?cmp_[A-Za-z0-9_-]+$/;
export const CAMPAIGNS_MAX = 100;
export const CAMPAIGN_NAME_MAX = 120;
export const CAMPAIGN_PRIORITY_MAX = 100;
export const CAMPAIGN_WINDOWS_MAX = 16;
export const CAMPAIGN_SCREENS_LIMIT_MAX = 500;
/** An audience has at most 500 rules, groups included, so a group of N tags or screens is N + 1 rules. */
export const CAMPAIGN_AUDIENCE_RULES_MAX = 500;
const AUDIENCE_LEAVES_MAX = CAMPAIGN_AUDIENCE_RULES_MAX - 1;
/** The API reads a request body of at most 64 KiB. */
export const CAMPAIGN_AUDIENCE_INPUT_MAX_BYTES = 64 * 1024;
const CURSOR_MAX = 200;

const DAYS: readonly ScreenScheduleDay[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const CIVIL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

export function campaignId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`campaign ${command} requires <id>.`);
  if (!CAMPAIGN_ID_PATTERN.test(value)) {
    throw usageError("A campaign id looks like cmp_ followed by letters, digits, - or _.", {
      command: "screenrig campaign list",
      reason: "List this project's campaigns and their ids. Advertising campaigns (screenrig ads campaigns list) are a different resource.",
    });
  }
  return value;
}

export function campaignScreenId(value: string | undefined): string {
  if (!value) throw usageError("campaign explain requires <screen-id>.");
  if (!isResourceID(value, "screen")) {
    throw usageError("A screen id looks like scr_ followed by letters, digits, - or _.", {
      command: "screenrig screen list",
      reason: "List this project's screens and their ids.",
    });
  }
  return value;
}

/** Campaign.name: 1 to 120 characters after trimming, no control characters. */
export function campaignName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > CAMPAIGN_NAME_MAX || /\p{Cc}/u.test(value)) {
    throw usageError(`--name must contain 1 to ${CAMPAIGN_NAME_MAX} characters without controls.`);
  }
  return trimmed;
}

export function campaignPlaylistId(value: string): string {
  if (!isResourceID(value, "playlist")) {
    throw usageError("--playlist-id must be a playlist id (pl_…).", {
      command: "screenrig playlist list",
      reason: "List this project's playlists and their ids.",
    });
  }
  return value;
}

/** --priority: a whole number from 0 to 100; higher wins when two campaigns hold on one screen. */
export function campaignPriority(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) > CAMPAIGN_PRIORITY_MAX) {
    throw usageError(`--priority must be a whole number from 0 to ${CAMPAIGN_PRIORITY_MAX}.`);
  }
  return value;
}

export function campaignScreensLimit(value: string): string {
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < 1 || number > CAMPAIGN_SCREENS_LIMIT_MAX) {
    throw usageError(`--limit must be a whole number from 1 to ${CAMPAIGN_SCREENS_LIMIT_MAX}.`);
  }
  return value;
}

export function campaignScreensCursor(value: string): string {
  if (!value.trim() || value.length > CURSOR_MAX || /\p{Cc}/u.test(value)) {
    throw usageError("--cursor takes the data.next_cursor of the previous page.");
  }
  return value;
}

function accumulate(value: string, previous: string | undefined): string[] {
  return [...(previous ? previous.split(",") : []), ...value.split(",").map((item) => item.trim())];
}

export function tagList(value: string, previous: string | undefined, flag: string): string {
  const tags = accumulate(value, previous);
  if (tags.some((tag) => !SCREEN_TAG_PATTERN.test(tag))) {
    throw usageError(`${flag} takes tags of 1 to 32 letters or digits, repeated or comma-separated, for example ${flag} Lobby,Floor2.`);
  }
  if (new Set(tags).size !== tags.length) throw usageError(`${flag} lists a tag more than once.`);
  if (tags.length > AUDIENCE_LEAVES_MAX) throw usageError(`${flag} accepts at most ${AUDIENCE_LEAVES_MAX} tags: an audience has at most ${CAMPAIGN_AUDIENCE_RULES_MAX} rules.`);
  return tags.join(",");
}

/** Repeatable --tag: the screen carries every listed tag. Returns the accumulated list joined by commas. */
export function campaignTags(value: string, previous?: string): string {
  return tagList(value, previous, "--tag");
}

/** Repeatable --any-tag: the screen carries at least one listed tag. Returns the accumulated list joined by commas. */
export function campaignAnyTags(value: string, previous?: string): string {
  return tagList(value, previous, "--any-tag");
}

/** Repeatable --screen-id; each value may also list comma-separated ids. Returns the accumulated list joined by commas. */
export function campaignScreenIds(value: string, previous?: string): string {
  const ids = accumulate(value, previous);
  if (ids.some((id) => !isResourceID(id, "screen"))) {
    throw usageError("--screen-id takes screen ids (scr_…), repeated or comma-separated.", {
      command: "screenrig screen list",
      reason: "List this project's screens and their ids.",
    });
  }
  if (new Set(ids).size !== ids.length) throw usageError("--screen-id lists a screen more than once.");
  if (ids.length > AUDIENCE_LEAVES_MAX) {
    throw usageError(`--screen-id accepts at most ${AUDIENCE_LEAVES_MAX} screens: an audience has at most ${CAMPAIGN_AUDIENCE_RULES_MAX} rules. Tag the screens and use --tag for a larger fleet.`);
  }
  return ids.join(",");
}

/** --tag TAG[,TAG…] → {"tag": T}, or {"all": [{"tag": T}, …]} for several. */
export function campaignTagAudience(tags: readonly string[]): CampaignAudience {
  return tags.length === 1 ? { tag: tags[0]! } : { all: tags.map((tag) => ({ tag })) };
}

/** --any-tag TAG[,TAG…] → {"any": [{"tag": T}, …]}. */
export function campaignAnyTagAudience(tags: readonly string[]): CampaignAudience {
  return { any: tags.map((tag) => ({ tag })) };
}

/** --screen-id ID[,ID…] → {"screen_id": ID}, or {"any": [{"screen_id": ID}, …]} for several. */
export function campaignScreenAudience(ids: readonly string[]): CampaignAudience {
  return ids.length === 1 ? { screen_id: ids[0]! } : { any: ids.map((id) => ({ screen_id: id })) };
}

/** --folder: one screen folder (sfd_...); the audience is its screens and those of every folder inside it. */
export function campaignFolder(value: string): string {
  return screenFolderId(value, "--folder");
}

/** --folder ID → {"folder": ID}. */
export function campaignFolderAudience(id: string): CampaignAudience {
  return { folder: id };
}

/** --all-screens: {"all": []}, every screen of the project. */
export function campaignAllScreensAudience(): CampaignAudience {
  return { all: [] };
}

/** --audience as JSON text. The server checks the rule's members; this checks it is one JSON object. */
export function campaignAudienceJson(text: string): CampaignAudience {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageError('--audience is not valid JSON. Pass a rule such as {"tag":"Lobby"}, @FILE to read it from a file, or - for stdin.');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError('--audience must be a JSON object with exactly one of all, any, tag, screen_id or folder, such as {"all":[{"tag":"Lobby"},{"folder":"sfd_NORTH"}]}; {"all":[]} is every screen.');
  }
  return parsed as CampaignAudience;
}

/** --audience is inline JSON, @FILE or - (stdin); the handler reads the file or stdin. */
export function campaignAudienceOption(value: string): string {
  if (!value.trim() || value.trim() === "@") {
    throw usageError("--audience takes a JSON rule, @FILE to read it from a file, or - for stdin.");
  }
  return value;
}

/** Splits "HEAD@HH:MM-HH:MM" into HEAD and its two times; the times are optional, and `fail` words a malformed one. */
function splitTimes(spec: string, fail: (detail: string) => CliError): { head: string; start?: string; end?: string } {
  const text = spec.trim();
  const at = text.indexOf("@");
  if (at < 0) return { head: text };
  const times = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(text.slice(at + 1).trim());
  if (!times || !CLOCK.test(times[1]!) || !CLOCK.test(times[2]!)) {
    throw fail("The time of day after @ must be HH:MM-HH:MM in 24-hour time, such as 09:00-17:00.");
  }
  return { head: text.slice(0, at).trim(), start: times[1]!, end: times[2]! };
}

function windowError(spec: string, detail: string, flag = "--window"): CliError {
  return usageError(`${flag} ${JSON.stringify(spec)}: ${detail} A window is DAYS or DAYS@HH:MM-HH:MM (a space may stand for the @), such as mon-fri@09:00-17:00, "Mon-Fri 09:00-17:00", sat,sun or daily@22:00-06:00.`);
}

function dayIndex(name: string, spec: string, flag: string): number {
  const index = DAYS.indexOf(name as ScreenScheduleDay);
  if (index < 0) {
    throw windowError(spec, name === "" ? "A day is missing." : `${JSON.stringify(name)} is not a day; use mon, tue, wed, thu, fri, sat or sun (daily stands alone).`, flag);
  }
  return index;
}

function windowDays(text: string, spec: string, flag: string): ScreenScheduleDay[] {
  if (text === "daily") return [...DAYS];
  const selected = new Set<number>();
  for (const item of text.split(",")) {
    const bounds = item.split("-").map((name) => name.trim());
    if (bounds.length > 2) throw windowError(spec, `${JSON.stringify(item)} is not a day or a range such as mon-fri.`, flag);
    const first = dayIndex(bounds[0]!, spec, flag);
    const last = bounds.length === 2 ? dayIndex(bounds[1]!, spec, flag) : first;
    // A range runs forward from its first day and wraps past sun, so fri-mon is fri, sat, sun and mon.
    for (let index = first; ; index = (index + 1) % DAYS.length) {
      selected.add(index);
      if (index === last) break;
    }
  }
  return DAYS.filter((_, index) => selected.has(index));
}

/**
 * One --window: DAYS or DAYS@HH:MM-HH:MM. DAYS is daily, a day (mon), a range
 * (mon-fri; fri-mon wraps past the week's end) or a comma list (sat,sun).
 * Without a time the window is the whole day; an end at or before the start
 * crosses midnight and belongs to the start day. Days are returned in mon to
 * sun order without duplicates. A space may stand for the @ ("Mon-Fri 09:00-17:00").
 */
export function campaignWindow(spec: string, flag = "--window"): ScreenScheduleWindow {
  const written = spec.includes("@") ? spec : spec.replace(/^\s*(\S+)\s+(\d{2}:\d{2}\s*-\s*\d{2}:\d{2})\s*$/, "$1@$2");
  const { head, start, end } = splitTimes(written, (detail) => windowError(spec, detail, flag));
  const window: ScreenScheduleWindow = { days: windowDays(head.toLowerCase(), spec, flag) };
  if (start !== undefined) {
    window.start = start;
    window.end = end!;
  }
  // The same check screen schedules and display schedules apply to a window.
  return scheduleWindow(window, flag, (_path, message) => windowError(spec, message, flag)) as ScreenScheduleWindow;
}

/** The days of a window in --window spelling: daily, runs of three or more as ranges (mon-fri), the rest listed. */
function daysText(days: readonly string[]): string {
  const indexes = DAYS.flatMap((day, index) => (days.includes(day) ? [index] : []));
  if (indexes.length !== days.length) return days.join(",");
  if (indexes.length === DAYS.length) return "daily";
  const parts: string[] = [];
  for (let start = 0; start < indexes.length;) {
    let end = start;
    while (end + 1 < indexes.length && indexes[end + 1] === indexes[end]! + 1) end += 1;
    if (end - start >= 2) parts.push(`${DAYS[indexes[start]!]}-${DAYS[indexes[end]!]}`);
    else for (let index = start; index <= end; index += 1) parts.push(DAYS[indexes[index]!]!);
    start = end + 1;
  }
  return parts.join(",");
}

/** A window in --window spelling, such as mon-fri@09:00-17:00 or sat,sun. */
export function campaignWindowSpec(window: ScreenScheduleWindow): string {
  const days = daysText(window.days ?? []);
  return window.start !== undefined && window.end !== undefined ? `${days}@${window.start}-${window.end}` : days;
}

/** Repeatable --window (or another weekly-window flag); returns the accumulated canonical specs joined by semicolons. */
export function weeklyWindows(flag: string): (value: string, previous?: string) => string {
  return (value, previous) => {
    const specs = [...(previous ? previous.split(";") : []), campaignWindowSpec(campaignWindow(value, flag))];
    if (specs.length > CAMPAIGN_WINDOWS_MAX) throw usageError(`${flag} accepts at most ${CAMPAIGN_WINDOWS_MAX} windows.`);
    return specs.join(";");
  };
}

/** Repeatable --window; returns the accumulated canonical specs joined by semicolons. */
export const campaignWindows = weeklyWindows("--window");

/** The windows a --window accumulation names, in the order given. */
export function campaignWindowList(accumulated: string): ScreenScheduleWindow[] {
  return accumulated.split(";").map((spec) => campaignWindow(spec));
}

const ORDINALS: Readonly<Record<string, LevelMonthly["nth"]>> = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, last: -1 };

function monthlyError(spec: string, detail: string): CliError {
  return usageError(`--monthly ${JSON.stringify(spec)}: ${detail} A monthly rule is DAY or NTH-WEEKDAY with an optional @HH:MM-HH:MM, such as 15, day15, 1st-mon, 3rd-wed@18:00-21:00 or last-sun@09:00-14:00.`);
}

/**
 * One --monthly: a day of the month (15 or day15; a month without that day
 * skips it) or the nth weekday of the month (1st-mon, 2nd-tue, 3rd-wed,
 * 4th-thu, last-sun), each with an optional @HH:MM-HH:MM. Times read like a
 * window's: an end at or before the start crosses midnight and belongs to the
 * date it starts.
 */
export function campaignMonthly(spec: string): LevelMonthly {
  const fail = (detail: string) => monthlyError(spec, detail);
  const { head, start, end } = splitTimes(spec, fail);
  const text = head.toLowerCase();
  const day = /^(?:day\s*)?(\d{1,2})$/.exec(text);
  const nth = /^([a-z0-9]+)\s*-\s*([a-z]+)$/.exec(text);
  let monthly: LevelMonthly;
  if (day) {
    if (Number(day[1]) < 1 || Number(day[1]) > 31) throw fail(`${day[1]} is not a day of the month; use 1 to 31.`);
    monthly = { day: Number(day[1]) };
  } else if (nth) {
    const count = ORDINALS[nth[1]!];
    if (count === undefined) throw fail(`${JSON.stringify(nth[1])} is not an occurrence; use 1st, 2nd, 3rd, 4th or last.`);
    const weekday = DAYS.find((name) => name === nth[2]);
    if (!weekday) throw fail(`${JSON.stringify(nth[2])} is not a day; use mon, tue, wed, thu, fri, sat or sun.`);
    monthly = { nth: count, weekday };
  } else {
    throw fail(text === "" ? "The day or occurrence is missing." : `${JSON.stringify(head)} is not a day of the month or an occurrence such as 1st-mon.`);
  }
  if (start !== undefined) {
    monthly.start = start;
    monthly.end = end!;
  }
  return scheduleMonthly(monthly, "--monthly", (_path, message) => fail(message));
}

/** A monthly rule in --monthly spelling: day15, 1st-mon, last-sun@09:00-14:00. */
export function campaignMonthlySpec(item: LevelMonthly): string {
  const ordinal = Object.entries(ORDINALS).find(([, count]) => count === item.nth)?.[0] ?? String(item.nth);
  const head = item.day !== undefined ? `day${item.day}` : `${ordinal}-${item.weekday}`;
  return item.start !== undefined && item.end !== undefined ? `${head}@${item.start}-${item.end}` : head;
}

/** Repeatable --monthly; returns the accumulated canonical specs joined by semicolons. */
export function campaignMonthlies(value: string, previous?: string): string {
  const specs = [...(previous ? previous.split(";") : []), campaignMonthlySpec(campaignMonthly(value))];
  if (specs.length > SCHEDULE_MONTHLY_MAX) throw usageError(`--monthly accepts at most ${SCHEDULE_MONTHLY_MAX} rules.`);
  return specs.join(";");
}

/** The monthly rules a --monthly accumulation names, in the order given. */
export function campaignMonthlyList(accumulated: string): LevelMonthly[] {
  return accumulated.split(";").map(campaignMonthly);
}

function dateError(spec: string, detail: string): CliError {
  return usageError(`--date ${JSON.stringify(spec)}: ${detail} A date is YYYY-MM-DD with an optional @HH:MM-HH:MM, such as 2026-12-24 or 2026-12-24@18:00-22:00.`);
}

/** One --date: a real civil date, the whole day or between @HH:MM-HH:MM (an end at or before the start crosses midnight and belongs to the date it starts). */
export function campaignDate(spec: string): LevelDate {
  const fail = (detail: string) => dateError(spec, detail);
  const { head, start, end } = splitTimes(spec, fail);
  if (!isCivilDate(head)) throw fail(head === "" ? "The date is missing." : `${JSON.stringify(head)} is not a real calendar date written YYYY-MM-DD.`);
  return scheduleDate({ date: head, ...(start !== undefined ? { start, end } : {}) }, "--date", (_path, message) => fail(message));
}

/** A date in --date spelling: 2026-12-24 or 2026-12-24@18:00-22:00. */
export function campaignDateSpec(item: LevelDate): string {
  return item.start !== undefined && item.end !== undefined ? `${item.date}@${item.start}-${item.end}` : item.date;
}

/** Repeatable --date; returns the accumulated canonical specs joined by semicolons. */
export function campaignDates(value: string, previous?: string): string {
  const specs = [...(previous ? previous.split(";") : []), campaignDateSpec(campaignDate(value))];
  if (specs.length > SCHEDULE_DATES_MAX) throw usageError(`--date accepts at most ${SCHEDULE_DATES_MAX} dates.`);
  return specs.join(";");
}

/** The dates a --date accumulation names, in the order given. */
export function campaignDateList(accumulated: string): LevelDate[] {
  return accumulated.split(";").map(campaignDate);
}

/** Repeatable --except; each value may also list comma-separated dates. Returns the accumulated dates, ascending, joined by commas. */
export function campaignExceptDates(value: string, previous?: string): string {
  const dates = accumulate(value, previous);
  const bad = dates.find((date) => !isCivilDate(date));
  if (bad !== undefined) {
    throw usageError(`--except takes real calendar dates written YYYY-MM-DD, repeated or comma-separated, for example --except 2026-12-25,2027-01-01; ${JSON.stringify(bad)} is not one.`);
  }
  if (new Set(dates).size !== dates.length) throw usageError("--except lists a date more than once.");
  if (dates.length > SCHEDULE_EXCEPT_MAX) throw usageError(`--except accepts at most ${SCHEDULE_EXCEPT_MAX} dates.`);
  return dates.sort().join(",");
}

/** --displays: the video wall outputs the campaign plays on, 1 to 12, comma-separated. Returns them ascending, joined by commas. */
export function campaignDisplays(value: string): string {
  const displays = value.split(",").map((item) => (/^\d{1,2}$/.test(item.trim()) ? Number(item) : Number.NaN));
  if (displays.some((display) => !(display >= 1 && display <= LEVEL_DISPLAYS_MAX))) {
    throw usageError(`--displays takes display numbers from 1 to ${LEVEL_DISPLAYS_MAX}, comma-separated, for example --displays 1,2.`);
  }
  if (new Set(displays).size !== displays.length) throw usageError("--displays lists a display more than once.");
  return displays.sort((a, b) => a - b).join(",");
}

/** The display numbers a --displays value names. */
export function campaignDisplayList(value: string): number[] {
  return value.split(",").map(Number);
}

/** KEY[:PATH[=VALUE]]; escape a colon in KEY as \: and use an empty PATH for root equality. */
export function campaignData(value: string): PageDataCondition {
  let key = "";
  let rest: string | undefined;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "\\" && value[index + 1] === ":") {
      key += ":";
      index++;
    } else if (value[index] === ":") {
      rest = value.slice(index + 1);
      break;
    } else {
      key += value[index];
    }
  }
  const condition: Record<string, unknown> = { key };
  if (rest !== undefined) {
    const equals = rest.indexOf("=");
    condition.path = equals < 0 ? rest : rest.slice(0, equals);
    if (equals >= 0) {
      const text = rest.slice(equals + 1);
      try {
        condition.equals = JSON.parse(text) as unknown;
      } catch {
        if (/^["\[{]/.test(text.trimStart())) throw usageError("--data VALUE must be a JSON scalar or a bare string; quote strings with JSON syntax to preserve their type.");
        condition.equals = text;
      }
    }
  }
  return scheduleData(condition, "--data", (field, reason) => usageError(`${field} ${reason}`));
}

/** Validate the single data condition before resolving credentials or sending a request. */
export function campaignDataOption(value: string, previous?: string): string {
  if (previous !== undefined) throw usageError("--data may be given only once.");
  campaignData(value);
  return value;
}

/** --on-touch IDLE_S: the seconds without input before the screen counts as idle, a whole number from 5 to 3600. */
export function campaignOnTouch(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) < LEVEL_IDLE_MIN_S || Number(value) > LEVEL_IDLE_MAX_S) {
    throw usageError(`--on-touch takes the seconds without input before the screen counts as idle, a whole number from ${LEVEL_IDLE_MIN_S} to ${LEVEL_IDLE_MAX_S} (default: ${LEVEL_IDLE_DEFAULT_S}), for example --on-touch 90.`);
  }
  return value;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** --from and --until: a civil YYYY-MM-DDTHH:MM, read in each screen's timezone, on a real calendar day. */
export function campaignInstant(flag: "--from" | "--until"): (value: string) => string {
  return (value) => {
    const match = CIVIL.exec(value);
    const year = Number(match?.[1]);
    const month = Number(match?.[2]);
    const day = Number(match?.[3]);
    if (!match || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      throw usageError(`${flag} takes a civil date and time in each screen's timezone as YYYY-MM-DDTHH:MM, such as 2026-12-24T18:00 (no offset, no seconds).`);
    }
    return value;
  };
}

const EXPLAIN_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/**
 * --at and --to of campaign explain: an instant with a zone (2026-03-08T09:30:00Z,
 * 2026-03-08T01:30:00-08:00) or a time on the screen's own clock
 * (2026-03-08T09:30, optionally :SS). The server reads the second form in the
 * screen's timezone and refuses a time daylight saving skips or repeats.
 */
export function campaignExplainTime(flag: "--at" | "--to"): (value: string) => string {
  return (value) => {
    const match = EXPLAIN_INSTANT.exec(value) ?? /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
    const year = Number(match?.[1]);
    const month = Number(match?.[2]);
    const day = Number(match?.[3]);
    if (!match || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      throw usageError(`${flag} takes an instant with a zone, such as 2026-03-08T09:30:00Z or 2026-03-08T01:30:00-08:00, or a time on the screen's clock, such as 2026-03-08T09:30 (no zone).`);
    }
    return value;
  };
}

/** until is exclusive and must come after from. Civil minutes compare as text. */
export function campaignBounds(from: string | undefined, until: string | undefined): void {
  if (from !== undefined && until !== undefined && until <= from) throw usageError("--until must be later than --from.");
}

/**
 * Map campaign problems to actionable guidance; exit codes stay status-derived
 * (400 → 8, 404 → 4, 409 → 5, 412 → 6). `subject` names what a not_found id
 * was: a campaign, or the screen of campaign explain.
 */
export function campaignProblem(error: unknown, id?: string, subject: "campaign" | "screen" = "campaign"): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.code === "campaign_limit_reached") {
    return new CliError({
      ...problem,
      detail: `This project already has the maximum of ${CAMPAIGNS_MAX} campaigns. Nothing was created.`,
      next: problem.next ?? {
        command: "screenrig campaign list",
        reason: "Delete a campaign you no longer need with screenrig campaign delete ID, then rerun create.",
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.next) return error;
  if (problem.code === "revision_conflict" && id) {
    return new CliError({
      ...problem,
      next: { command: `screenrig campaign show ${id}`, reason: "Read the current revision and state, then rerun with --expect-rev REVISION if the change still applies." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "not_found" && id) {
    return new CliError({
      ...problem,
      next: subject === "screen"
        ? { command: "screenrig screen list", reason: "List this project's screens and their ids." }
        : { command: "screenrig campaign list", reason: "List this project's campaigns; a deleted campaign does not come back. An id from screenrig ads campaigns list names an advertising campaign, not this resource." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "playlist_not_approved") {
    return new CliError({
      ...problem,
      next: { command: "screenrig reviews list", reason: "A campaign shows only an approved playlist. Its review waits for a person; choose an approved playlist with --playlist-id, or rerun once the review is approved." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "invalid_request" && problem.errors.some((item) => (item as { field?: unknown } | null)?.field === "playlist_id")) {
    return new CliError({
      ...problem,
      next: { command: "screenrig playlist list", reason: "Choose a playlist id from this project for --playlist-id." },
    }, error.exitCode, error.warnings);
  }
  return error;
}

/** A refused promote names the revisions list, where the draft to copy is found. */
export function campaignPromoteProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next || error.problem.code !== "invalid_request") return error;
  return new CliError({
    ...error.problem,
    next: { command: `screenrig campaign revisions ${id}`, reason: "Promote copies the audience of a revision that was paused (a draft) while the campaign is published for its test. Pick that revision from the list, rerun with --revision N." },
  }, error.exitCode, error.warnings);
}

function when(value: string | number | undefined, label: string): string[] {
  return value === undefined || value === "" ? [] : [`${label}: ${value}`];
}

function clip(text: string, width: number): string {
  const characters = [...text];
  return characters.length <= width ? text : `${characters.slice(0, width - 1).join("")}…`;
}

/** "every screen", "tag Lobby", "tag Lobby and tag Floor2", "screen scr_A or screen scr_B", "folder sfd_NORTH". */
export function campaignAudienceText(audience: CampaignAudience | undefined, nested = false): string {
  if (!audience) return "";
  const group = (rules: CampaignAudience[], word: string): string => {
    const parts = rules.map((rule) => campaignAudienceText(rule, true));
    const text = parts.join(` ${word} `);
    return nested && parts.length > 1 ? `(${text})` : text;
  };
  if (audience.all) return audience.all.length ? group(audience.all, "and") : "every screen";
  if (audience.any) return group(audience.any, "or");
  if (audience.tag !== undefined) return `tag ${audience.tag}`;
  if (audience.screen_id !== undefined) return `screen ${audience.screen_id}`;
  if (audience.folder !== undefined) return `folder ${audience.folder}`;
  return JSON.stringify(audience);
}

/**
 * The campaign's clock: "always", or its bounds, windows and the other rule
 * members ("from …; until …; mon-fri@09:00-17:00; last Sunday 09:00–14:00;
 * except 2026-12-27; on touch (idle 60 s)").
 */
export function campaignWhenText(campaign: Pick<Campaign, "from" | "until" | "windows" | "monthly" | "dates" | "except" | "data" | "interaction">): string {
  const parts = [
    ...(campaign.from ? [`from ${campaign.from}`] : []),
    ...(campaign.until ? [`until ${campaign.until}`] : []),
    ...(campaign.windows ?? []).map(campaignWindowSpec),
    ...levelRuleParts(campaign),
  ];
  return parts.length ? parts.join("; ") : "always";
}

/** "7 of 10": the screens a campaign reaches now of the screens it reached when it was last published. */
export function campaignReachText(reach: CampaignReach | undefined): string {
  if (!reach || !Number.isSafeInteger(reach.current) || !Number.isSafeInteger(reach.published)) return "";
  return `${reach.current} of ${reach.published}`;
}

/** The reach line of show: the counts, when they were counted, a drop worth a look and the audience groups that match no screen. */
function reachLines(reach: CampaignReach | undefined): string[] {
  const text = campaignReachText(reach);
  if (!text || !reach) return [];
  const dropped = reach.current < reach.published ? ` (${reach.published - reach.current} fewer than when it was published)` : "";
  const empty = Array.isArray(reach.empty_groups) ? reach.empty_groups : [];
  return [
    `reach: ${text} screens${dropped}${reach.at ? `, counted ${reach.at}` : ""}`,
    ...(empty.length ? [`empty_groups: ${empty.join(", ")} (no screen matches)`] : []),
  ];
}

/** Every field of a campaign, one per line. */
export function campaignLines(campaign: Campaign | undefined): string[] {
  if (!campaign) return [];
  const clock = campaignWhenText(campaign);
  const civil = Boolean(campaign.from || campaign.until || campaign.windows?.length || campaign.monthly?.length || campaign.dates?.length || campaign.except?.length);
  return [
    `id: ${campaign.id}`,
    `name: ${campaign.name}`,
    `playlist_id: ${campaign.playlist_id}`,
    `audience: ${campaignAudienceText(campaign.audience)}`,
    ...reachLines(campaign.reach),
    `when: ${clock}${civil ? " (civil times in each screen's timezone)" : ""}`,
    ...(campaign.covers && campaign.covers !== "full" ? [`covers: ${campaign.covers}`] : []),
    ...(campaign.displays?.length ? [`displays: ${campaign.displays.join(", ")}`] : []),
    ...(campaign.start ? [`start: ${campaign.start === "on_time" ? "on time" : "next item"}`] : []),
    `priority: ${campaign.priority}`,
    `paused: ${campaign.paused}`,
    ...(campaign.reserved ? ["reserved: true (only a person who can approve changes it)"] : []),
    ...(campaign.editable === false ? ["editable: false (it reaches screens outside this caller's scope, so it is read-only here)"] : []),
    `revision: ${campaign.revision}`,
    ...when(campaign.created_at, "created_at"),
    ...when(campaign.updated_at, "updated_at"),
  ];
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [render(header), ...rows.map(render)];
}

/** The list table, in the precedence order the API returns. */
export function campaignTableLines(items: Campaign[]): string[] {
  if (!items.length) return ["No campaigns"];
  // REACH appears only when a listed campaign has been counted, so a project without counts keeps its table.
  const reach = items.some((item) => campaignReachText(item.reach) !== "");
  // RESERVED and EDITABLE appear only when some campaign is reserved or the caller is limited to screens.
  const reserved = items.some((item) => item.reserved);
  const scoped = items.some((item) => item.editable !== undefined);
  return table(["ID", "NAME", "PLAYLIST", "AUDIENCE", ...(reach ? ["REACH"] : []), "WHEN", "PRIORITY", "PAUSED", ...(reserved ? ["RESERVED"] : []), ...(scoped ? ["EDITABLE"] : [])], items.map((item) => [
    item.id ?? "", clip(item.name ?? "", 40), item.playlist_id ?? "", clip(campaignAudienceText(item.audience), 48),
    ...(reach ? [campaignReachText(item.reach)] : []),
    clip(campaignWhenText(item), 56), String(item.priority ?? 0), item.paused ? "yes" : "no",
    ...(reserved ? [item.reserved ? "yes" : "no"] : []), ...(scoped ? [item.editable === false ? "no" : "yes"] : []),
  ]));
}

/** A region, a display lock, interaction or a data condition is honored only by a Player that resolves its own stack. */
const STACK_ONLY_DETAIL = "needs a Player that resolves its own stack";
const REGION_DETAIL = "laid out on no display of this screen (a strip of the wrong orientation or over half the display, or a display lock naming none of its outputs)";

/** What a conditional level waits on: only the Player sees input and its card data. */
function conditionalDetail(reason: string | undefined): string {
  return reason === "interaction" ? "plays while someone is using the screen"
    : reason === "data" ? "plays while its data condition holds"
    : "plays while the Player's condition holds";
}

const STANDING_ORDER = ["playing", "pending", "waiting", "ended", "outranked", "conditional", "paused", "blocked", "not_in_audience"];

/** "8 playing, 2 waiting, 1 blocked": the per-standing counts of a campaign's audience. */
export function campaignCountsText(counts: Record<string, number> | undefined): string {
  const rank = (name: string) => { const index = STANDING_ORDER.indexOf(name); return index < 0 ? STANDING_ORDER.length : index; };
  return Object.entries(counts ?? {})
    .filter(([name, count]) => name !== "audience" && count > 0)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, count]) => `${count} ${name.replaceAll("_", " ")}`)
    .join(", ");
}

/** What a campaign's standing on a screen means, with the command that fixes it when the screen is known. */
export function campaignStandingDetail(status: CampaignStatus, screenId?: string): string {
  switch (status.status) {
    case "playing": return "";
    case "pending": return "the switch lands within a minute";
    case "waiting": return status.next_start ? `outside from, until and windows now; starts ${status.next_start}` : "outside from, until and windows now; no start within eight days";
    case "ended": return "until has passed";
    case "paused": return "the campaign is paused";
    case "not_in_audience": return "the screen is not in the audience";
    case "outranked":
      return status.reason === "takeover" ? "a screen takeover wins"
        : status.reason === "campaign" ? (status.by ? `campaign ${status.by} wins` : "another campaign wins")
        : "outranked";
    case "conditional": return conditionalDetail(status.reason);
    case "blocked":
      switch (status.reason) {
        case "no_default_playlist":
          return `the screen has no default playlist: screenrig screen assign ${screenId ?? "SCREEN_ID"} --playlist-id PLAYLIST_ID`;
        case "no_timezone":
          return `the screen has no timezone: screenrig screen set-timezone ${screenId ?? "SCREEN_ID"} --timezone ZONE`;
        case "playlist_unavailable":
          return "the playlist is missing, unapproved or does not fit the screen";
        case "region_not_laid_out":
          return REGION_DETAIL;
        case "stack_only":
          return STACK_ONLY_DETAIL;
        default:
          return "blocked";
      }
    default:
      return status.reason ?? "";
  }
}

/** campaign screens: the reach headline, the counts, one row per screen of the page, and the command for the next page. */
export function campaignScreensLines(id: string, page: CampaignScreens | undefined, limit?: string): string[] {
  const audience = page?.counts?.audience ?? 0;
  const items = Array.isArray(page?.items) ? page.items : [];
  const counts = campaignCountsText(page?.counts);
  const next = typeof page?.next_cursor === "string" ? page.next_cursor : undefined;
  return [
    `Campaign ${id} reaches ${audience} screen${audience === 1 ? "" : "s"}`,
    ...(counts ? [`counts: ${counts}`] : []),
    ...(items.length
      ? table(["SCREEN", "NAME", "STATUS", "DETAIL"], items.map((item) => [
        item.screen_id ?? "", clip(item.screen_name ?? "", 32), item.status ?? "", campaignStandingDetail(item),
      ]))
      : [audience === 0
        ? `No live screen is in the audience. screenrig campaign show ${id} prints the audience, and screenrig screen tag sets a screen's tags.`
        : "No screens on this page."]),
    ...(next ? [`next: screenrig campaign screens ${id} --cursor ${next}${limit ? ` --limit ${limit}` : ""}`] : []),
  ];
}

/** What a verdict means, with the command that fixes an off candidate when the screen is known. */
export function verdictDetail(verdict: ScreenVerdict, screenId: string, timezone: string | undefined): string {
  const next = verdict.next_start ? instantInZone(verdict.next_start, timezone) : undefined;
  switch (verdict.verdict) {
    case "won": return "";
    case "outranked": {
      const by = verdict.by;
      const who = !by ? "another candidate" : by.kind === "takeover" ? "the screen takeover" : by.kind === "campaign" ? `campaign ${by.id ?? ""}`.trim() : `schedule entry ${by.id ?? ""}`.trim();
      return `${who} wins`;
    }
    case "not_started": return next ? `before its from; starts ${next}` : "before its from";
    case "outside_hours": return next ? `outside its windows; holds again ${next}` : "outside its windows; no start within eight days";
    case "ended":
      return verdict.kind === "takeover" && verdict.until ? `ended ${instantInZone(verdict.until, timezone)}` : "until has passed";
    case "conditional": return conditionalDetail(verdict.reason);
    case "off":
      switch (verdict.reason) {
        case "paused": return verdict.kind === "schedule" ? "the schedule entry is paused (a draft)" : "the campaign is paused";
        case "not_in_audience": return "the screen is not in the audience";
        case "no_default_playlist": return `the screen has no default playlist: screenrig screen assign ${screenId} --playlist-id PLAYLIST_ID`;
        case "no_timezone": return `the screen has no timezone: screenrig screen set-timezone ${screenId} --timezone ZONE`;
        case "playlist_unavailable": return "the playlist is missing, unapproved or not in the stack this screen's Player receives";
        case "region_not_laid_out": return REGION_DETAIL;
        case "stack_only": return STACK_ONLY_DETAIL;
        default: return "does not apply";
      }
    default: return "";
  }
}

function candidateText(verdict: ScreenVerdict): string {
  return verdict.kind === "takeover" ? "takeover" : verdict.kind === "campaign" ? `campaign ${verdict.id ?? ""}`.trim() : `schedule entry ${verdict.id ?? ""}`.trim();
}

/** campaign explain --at: the playlist at that instant, a verdict per takeover, campaign and schedule entry, the switches to --to, and what is not judged. */
function campaignExplainAtLines(screenId: string, at: ScreenExplainAt): string[] {
  const zone = at.timezone || undefined;
  const effective = effectivePlaylistText(at.effective_playlist ?? undefined, undefined, zone);
  // The server's reading of the screen's clock is authoritative; the instant is shown beside it.
  const clock = at.local && zone ? `${at.local.replace("T", " ")} ${zone}` : instantInZone(at.instant, zone);
  const when = `${clock} (${at.instant})`;
  const lines = [effective ? `Screen ${screenId} at ${when} plays ${effective}` : `Screen ${screenId} at ${when} plays no playlist`];
  const verdicts = Array.isArray(at.verdicts) ? at.verdicts : [];
  lines.push(...(verdicts.length
    ? ["Takeover, campaigns and schedule entries, in the order the screen reads them", ...table(["CANDIDATE", "PLAYLIST", "VERDICT", "DETAIL"], verdicts.map((verdict) => [
      candidateText(verdict), verdict.playlist_id ?? "", verdict.verdict ?? "", verdictDetail(verdict, screenId, zone),
    ]))]
    : ["No takeover, campaigns or schedule entries apply to this screen"]));
  const timeline = Array.isArray(at.timeline) ? at.timeline : [];
  if (timeline.length) {
    const last = timeline[timeline.length - 1]!;
    lines.push(`Switches from ${instantInZone(timeline[0]!.from, zone)} to ${instantInZone(last.to, zone)}${at.timeline_truncated ? ` (stopped early; ask again with --at ${last.to})` : ""}`,
      ...table(["FROM", "TO", "PLAYS"], timeline.map((segment) => [
        instantInZone(segment.from, zone), instantInZone(segment.to, zone),
        segment.playlist_id ? `${segment.playlist_id} (${segment.source}${segment.entry_id ? ` ${segment.entry_id}` : ""})` : "no playlist",
      ])));
  }
  const notJudged = Array.isArray(at.not_judged) ? at.not_judged : [];
  if (notJudged.length) lines.push("Not judged", ...notJudged.map((item) => `  ${item.detail}`));
  return lines;
}

/** campaign explain: what the screen plays and every campaign's standing on it, in precedence order; with --at, the same asked of another instant. */
export function campaignExplainLines(screenId: string, view: ScreenCampaigns | undefined): string[] {
  if (view?.at) return campaignExplainAtLines(screenId, view.at);
  const effective = effectivePlaylistText(view?.effective_playlist ?? undefined);
  const items = Array.isArray(view?.items) ? view.items : [];
  return [
    effective ? `Screen ${screenId} plays ${effective}` : `Screen ${screenId} plays no playlist`,
    ...(items.length
      ? [`Campaigns, in precedence order (${items.length})`, ...table(["CAMPAIGN", "STATUS", "DETAIL"], items.map((item) => [
        item.campaign_id ?? "", item.status ?? "", campaignStandingDetail(item, screenId),
      ]))]
      : ["No campaigns in this project"]),
  ];
}
