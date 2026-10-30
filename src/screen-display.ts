import type { Screen, ScreenDisplay, ScreenRebootSchedule, ScreenScheduleWindow } from "./adapters/protocol.js";
import { CliError, usageError } from "./problems.js";
import { campaignWindow, campaignWindowSpec, CAMPAIGN_WINDOWS_MAX } from "./campaigns.js";
import { durationMs, instantInZone, normalizeInstant, scheduleWindow } from "./screen-control.js";

/**
 * Reboot and display power (backend "Reboot and display power",
 * docs/player-compatibility.md §6.5). Local checks mirror ScreenDisplayWrite
 * and ScreenDisplayScheduleWrite; the server stays authoritative.
 */
export const DISPLAY_WINDOWS_MAX = 16;

function displayScheduleError(path: string, message: string): CliError {
  return usageError(`Display schedule file: ${path} ${message}`, {
    command: "screenrig screen display-schedule set --help",
    reason: "The file is {\"enabled\": true, \"windows\": [{\"days\": [...], \"start\"?, \"end\"?}]}: the windows when the display is ON, in the screen timezone.",
  });
}

function rebootScheduleError(path: string, message: string): CliError {
  return usageError(`Reboot schedule file: ${path} ${message}`, {
    command: "screenrig screen reboot-schedule set --help",
    reason: "The file is {\"enabled\": true, \"windows\": [{\"days\": [...], \"start\"?, \"end\"?}]}: the windows in which the screen reboots, at the start of each, in the screen timezone.",
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

interface ScheduleKind {
  /** The member of a saved show envelope that holds the schedule. */
  member: "display_schedule" | "reboot_schedule";
  noun: string;
  group: string;
  fail: (path: string, message: string) => CliError;
  disabled: string;
}

function scheduleWrite(document: unknown, kind: ScheduleKind): { enabled: boolean; windows: ScreenScheduleWindow[] } {
  let value = document;
  const envelope = record(value);
  if (envelope && envelope.ok === true && record(envelope.data)) value = envelope.data;
  const view = record(value);
  if (view && kind.member in view) value = view[kind.member];
  const object = record(value);
  if (!object) {
    throw usageError(`${kind.noun} file: must be an object {"enabled": true, "windows": [...]}. To remove a schedule, run ${kind.group} clear.`, {
      command: `screenrig ${kind.group} clear <id>`, reason: "Clearing is its own command.",
    });
  }
  const extra = Object.keys(object).find((key) => !["enabled", "windows", "updated_at"].includes(key));
  if (extra !== undefined) throw kind.fail("document", `has unknown field ${JSON.stringify(extra).slice(0, 80)}; allowed: enabled, windows.`);
  if (typeof object.enabled !== "boolean") throw kind.fail("enabled", `must be true or false (false keeps the windows and ${kind.disabled}).`);
  const windows = object.windows;
  if (!Array.isArray(windows) || windows.length < 1 || windows.length > DISPLAY_WINDOWS_MAX) {
    throw kind.fail("windows", `must list 1 to ${DISPLAY_WINDOWS_MAX} windows.`);
  }
  const parsed = windows.map((item, index) => scheduleWindow(item, `windows[${index}]`, kind.fail));
  return {
    enabled: object.enabled,
    windows: parsed.map((item) => ({ days: item.days, ...(item.start !== undefined ? { start: item.start, end: item.end } : {}) })),
  };
}

/**
 * Accept ScreenDisplayScheduleWrite `{enabled, windows}`, or a saved
 * `screen display-schedule show` envelope / view (its display_schedule is
 * unwrapped and updated_at dropped) so show output can be edited and sent back.
 */
export function displayScheduleWrite(document: unknown): { enabled: boolean; windows: ScreenScheduleWindow[] } {
  return scheduleWrite(document, { member: "display_schedule", noun: "Display schedule", group: "screen display-schedule", fail: displayScheduleError, disabled: "leaves the display on" });
}

/** Accept ScreenRebootScheduleWrite `{enabled, windows}`, or a saved `screen reboot-schedule show` envelope / view, the way displayScheduleWrite does. */
export function rebootScheduleWrite(document: unknown): { enabled: boolean; windows: ScreenScheduleWindow[] } {
  return scheduleWrite(document, { member: "reboot_schedule", noun: "Reboot schedule", group: "screen reboot-schedule", fail: rebootScheduleError, disabled: "reboots nothing" });
}

/** `on`/`off` from --power, or a trailing positional on|off. */
export function displayPower(value: string | undefined): "on" | "off" {
  if (value === "on" || value === "off") return value;
  throw usageError("screen display requires the power: --power on or --power off (or a trailing on|off).");
}

const DISPLAY_FOR_MAX_MS = 7 * 24 * 60 * 60 * 1000 - 60_000;

/** --until RFC 3339 (normalized to UTC) or --for DURATION; undefined = until the schedule's next boundary, else until replaced. */
export function displayUntil(until: string | undefined, forValue: string | undefined, now: Date): string | undefined {
  if (until !== undefined && forValue !== undefined) throw usageError("Use --until or --for, not both.");
  if (forValue !== undefined) {
    let ms: number;
    try {
      ms = durationMs(forValue);
    } catch {
      throw usageError("--for takes a duration such as 30m, 2h, 1h30m, or 3d, under 7 days (at most 6d23h59m, leaving a minute for clock differences with the server).");
    }
    if (ms > DISPLAY_FOR_MAX_MS) throw usageError("--for must be at most 6d23h59m.");
    return new Date(now.getTime() + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  if (until === undefined) return undefined;
  const normalized = normalizeInstant(until);
  if (normalized === undefined) {
    throw usageError("--until takes an RFC 3339 instant with seconds and an offset, such as 2026-09-26T18:00:00Z or 2026-09-26T11:00:00-07:00, strictly in the future and at most 7 days ahead.");
  }
  return normalized;
}

export function untilOption(value: string): string {
  if (normalizeInstant(value) === undefined) displayUntil(value, undefined, new Date());
  return value;
}

/** `Display:` lines for screen show --human; nothing when the screen has no display state. */
export function displayLines(display: ScreenDisplay | undefined, timezone: string | undefined): string[] {
  if (!display || typeof display !== "object" || (display.requested !== "on" && display.requested !== "off")) return [];
  const source = display.source === "override" ? "manual override" : display.source === "schedule" ? "display schedule" : "default";
  const until = typeof display.until === "string" ? ` until ${instantInZone(display.until, timezone)}` : display.source === "override" ? " until replaced" : "";
  const lines = [`Display: ${display.requested} (${source}${until})`];
  const schedule = display.schedule;
  if (schedule && Array.isArray(schedule.windows)) {
    lines.push(`Display schedule: ${schedule.enabled ? "enabled" : "disabled (display stays on)"}, ${schedule.windows.length} window${schedule.windows.length === 1 ? "" : "s"}${timezone ? ` in ${timezone}` : ""}`);
    for (const window of schedule.windows) {
      lines.push(`  ${window.days.join(",")} ${window.start !== undefined ? `${window.start}-${window.end}` : "all day"}`);
    }
  }
  const reported = display.reported;
  if (reported && typeof reported.reported_at === "string") {
    const parts = [
      reported.power ? `power ${reported.power}` : undefined,
      reported.connected === true ? "connected" : reported.connected === false ? "disconnected" : undefined,
    ].filter(Boolean).join(", ");
    lines.push(`Display reported: ${parts || "no power state"} at ${reported.reported_at}${reported.stale ? " (stale: no report for over 35 minutes)" : ""}`);
  }
  return lines;
}

/** A reboot window lasts 5 minutes to 24 hours; the end of one at or before its start crosses midnight, and a window without edges is the whole day. */
const REBOOT_WINDOW_MIN_MINUTES = 5;

function windowMinutes(window: ScreenScheduleWindow): number {
  if (window.start === undefined || window.end === undefined) return 24 * 60;
  const clock = (text: string): number => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
  const length = (clock(window.end) - clock(window.start) + 24 * 60) % (24 * 60);
  return length === 0 ? 24 * 60 : length;
}

/** One --window of a reboot schedule: DAYS HH:MM-HH:MM such as "Mon-Sun 04:00-04:30", or the DAYS@HH:MM-HH:MM spelling of campaigns, at least 5 minutes long. */
export function rebootWindowOption(value: string, previous?: string): string {
  const window = campaignWindow(value, "--window");
  if (windowMinutes(window) < REBOOT_WINDOW_MIN_MINUTES) {
    throw usageError(`--window ${JSON.stringify(value)}: a reboot window lasts 5 minutes to 24 hours; the reboot goes out at its start.`);
  }
  const specs = [...(previous ? previous.split(";") : []), campaignWindowSpec(window)];
  if (specs.length > CAMPAIGN_WINDOWS_MAX) throw usageError(`--window accepts at most ${CAMPAIGN_WINDOWS_MAX} windows.`);
  return specs.join(";");
}

/** The windows a --window accumulation names, in the order given. */
export function rebootWindowList(accumulated: string): ScreenScheduleWindow[] {
  return accumulated.split(";").map((spec) => campaignWindow(spec));
}

/** A window in the spelling the lines of show use: "mon,tue 07:00-19:00" or "sat all day". */
function windowText(window: ScreenScheduleWindow): string {
  return `${window.days.join(",")} ${window.start !== undefined ? `${window.start}-${window.end}` : "all day"}`;
}

/**
 * `Reboot schedule:` lines for screen show --human and screen reboot-schedule show: the
 * windows in the screen's zone and, while an enabled schedule has one, the next reboot.
 * Nothing when the screen has no schedule.
 */
export function rebootScheduleLines(schedule: ScreenRebootSchedule | null | undefined, nextRebootAt: string | null | undefined, timezone: string | undefined): string[] {
  if (!schedule || !Array.isArray(schedule.windows)) return [];
  const lines = [`Reboot schedule: ${schedule.enabled ? "enabled" : "disabled (no reboots)"}, ${schedule.windows.length} window${schedule.windows.length === 1 ? "" : "s"}${timezone ? ` in ${timezone}` : ""}`];
  for (const window of schedule.windows) lines.push(`  ${windowText(window)}`);
  if (typeof nextRebootAt === "string" && nextRebootAt) lines.push(`Next reboot: ${instantInZone(nextRebootAt, timezone)}`);
  return lines;
}

/** 409 reboot_unsupported on a reboot schedule write: nothing is stored until the Player declares reboot. */
export function rebootScheduleProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code === "reboot_unsupported") {
    return new CliError({
      ...error.problem,
      detail: `${error.problem.detail} Nothing was stored. A reboot schedule needs a Player that declares the reboot capability in its host report (screen show lists host capabilities); this device's Player did not.`,
      next: { command: `screenrig screen show ${id}`, reason: "Check the host capabilities. A schedule can be set once the Player declares reboot." },
    }, error.exitCode, error.warnings);
  }
  if (error.problem.code === "invalid_request" && /timezone/i.test(error.problem.detail)) {
    return new CliError({
      ...error.problem,
      next: { command: `screenrig screen set-timezone ${id} --timezone ZONE`, reason: "A reboot schedule reads its windows in the screen's timezone. Set it first, then rerun." },
    }, error.exitCode, error.warnings);
  }
  return rebootProblem(error, id);
}

export function hostDeclaresReboot(screen: Screen | undefined): boolean {
  return Array.isArray(screen?.host?.capabilities) && screen.host.capabilities.includes("reboot");
}

/** 409 reboot_unsupported, explained: the Player must declare the reboot capability. */
export function rebootProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code === "reboot_unsupported") {
    return new CliError({
      ...error.problem,
      detail: `${error.problem.detail} Nothing was sent. A reboot reaches only a Player that declares the reboot capability in its host report (screen show lists host capabilities); this device's Player did not.`,
      next: { command: `screenrig screen show ${id}`, reason: "Check the host capabilities. To refresh content without a device reboot, run screen reload." },
    }, error.exitCode, error.warnings);
  }
  if (error.problem.code === "resource_conflict") {
    return new CliError({
      ...error.problem,
      next: { command: `screenrig screen show ${id}`, reason: "A screen still waiting to pair has no Player to reboot. Pair it first." },
    }, error.exitCode, error.warnings);
  }
  if (error.problem.code === "screen_archived") {
    return new CliError({
      ...error.problem,
      next: { command: `screenrig screen unarchive ${id}`, reason: "An archived screen refuses reboot and display control. Unarchive it first if it should play again." },
    }, error.exitCode, error.warnings);
  }
  return error;
}

/** 409 page_not_on_screen and play_page_unsupported, explained. */
export function playPageProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code === "page_not_on_screen") {
    return new CliError({
      ...error.problem,
      next: { command: `screenrig screen show ${id}`, reason: "The page must belong to the playlist the screen is playing now (its takeover, else a campaign that holds, else its schedule, else its assigned playlist). The detail names that playlist; use one of its page ids." },
    }, error.exitCode, error.warnings);
  }
  if (error.problem.code === "play_page_unsupported") {
    return new CliError({
      ...error.problem,
      detail: `${error.problem.detail} Nothing was sent. Only a Player that declares the play_page capability in its host report starts a page on demand; update this device's Player.`,
      next: { command: `screenrig screen show ${id}`, reason: "Check the host capabilities. Update the Player, then run the command again." },
    }, error.exitCode, error.warnings);
  }
  if (error.problem.code === "resource_conflict") {
    return new CliError({
      ...error.problem,
      next: { command: `screenrig screen show ${id}`, reason: "A screen still waiting to pair has no Player to start a page. Pair it first." },
    }, error.exitCode, error.warnings);
  }
  if (error.problem.code === "screen_archived") {
    return new CliError({
      ...error.problem,
      next: { command: `screenrig screen unarchive ${id}`, reason: "An archived screen refuses page control. Unarchive it first if it should play again." },
    }, error.exitCode, error.warnings);
  }
  return error;
}

/** Display override refusals: a pending screen has no paired Player yet; an archived one must be unarchived. */
export function displayProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code === "resource_conflict") {
    return new CliError({
      ...error.problem,
      next: { command: `screenrig screen show ${id}`, reason: "This screen has no paired Player yet, so there is no display to turn on or off. Pair it first; a display schedule can be set before pairing." },
    }, error.exitCode, error.warnings);
  }
  return rebootProblem(error, id);
}
