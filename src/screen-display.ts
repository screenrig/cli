import type { Screen, ScreenDisplay, ScreenScheduleWindow } from "./adapters/protocol.js";
import { CliError, usageError } from "./problems.js";
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Accept ScreenDisplayScheduleWrite `{enabled, windows}`, or a saved
 * `screen display-schedule show` envelope / view (its display_schedule is
 * unwrapped and updated_at dropped) so show output can be edited and sent back.
 */
export function displayScheduleWrite(document: unknown): { enabled: boolean; windows: ScreenScheduleWindow[] } {
  let value = document;
  const envelope = record(value);
  if (envelope && envelope.ok === true && record(envelope.data)) value = envelope.data;
  const view = record(value);
  if (view && "display_schedule" in view) value = view.display_schedule;
  const object = record(value);
  if (!object) {
    throw usageError("Display schedule file: must be an object {\"enabled\": true, \"windows\": [...]}. To remove a schedule, run screen display-schedule clear.", {
      command: "screenrig screen display-schedule clear <id>", reason: "Clearing is its own command.",
    });
  }
  const extra = Object.keys(object).find((key) => !["enabled", "windows", "updated_at"].includes(key));
  if (extra !== undefined) throw displayScheduleError("document", `has unknown field ${JSON.stringify(extra).slice(0, 80)}; allowed: enabled, windows.`);
  if (typeof object.enabled !== "boolean") throw displayScheduleError("enabled", "must be true or false (false keeps the windows and leaves the display on).");
  const windows = object.windows;
  if (!Array.isArray(windows) || windows.length < 1 || windows.length > DISPLAY_WINDOWS_MAX) {
    throw displayScheduleError("windows", `must list 1 to ${DISPLAY_WINDOWS_MAX} windows.`);
  }
  const parsed = windows.map((item, index) => scheduleWindow(item, `windows[${index}]`, displayScheduleError));
  return {
    enabled: object.enabled,
    windows: parsed.map((item) => ({ days: item.days, ...(item.start !== undefined ? { start: item.start, end: item.end } : {}) })),
  };
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
    lines.push(`Display reported: ${parts || "no power state"} at ${reported.reported_at}${reported.stale ? " (stale: no report for over 15 minutes)" : ""}`);
  }
  return lines;
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
