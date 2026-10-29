import type { Screen } from "./adapters/protocol.js";
import { isResourceID } from "./generated/resource-ids.js";
import { CliError, usageError } from "./problems.js";
import { plainText } from "./reviews.js";
import { wallProblem } from "./screen-wall.js";

/**
 * Queued reboots and reloads, identify, suspend and replace (backend
 * docs/player-compatibility.md §5.7, §6.3, §6.3.2, §6.5 and §6.9). Local checks
 * mirror ScreenCommandWrite, ScreenIdentifyWrite and ScreenSuspendWrite so a bad
 * value fails before any request; the server stays authoritative.
 */
export const COMMAND_EXPIRES_MIN_S = 60;
export const COMMAND_EXPIRES_MAX_S = 24 * 60 * 60;
export const IDENTIFY_DURATION_MIN_MS = 2_000;
export const IDENTIFY_DURATION_MAX_MS = 600_000;
export const SUSPEND_MESSAGE_MAX = 280;

const DURATION = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/** `90s`, `30m`, `2h`, `1h30m`, `1d`: whole units, as seconds. Undefined for any other spelling and for zero. */
function durationSeconds(value: string): number | undefined {
  const text = value.trim();
  const match = text ? DURATION.exec(text) : null;
  if (!match) return undefined;
  const total = Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

export function boundedSeconds(flag: string, value: string, min: number, max: number, forms: string, bounds: string): number {
  const total = durationSeconds(value);
  if (total === undefined) throw usageError(`${flag} takes a duration with a unit, such as ${forms}, from ${bounds}.`);
  if (total < min || total > max) throw usageError(`${flag} must be from ${bounds}.`);
  return total;
}

/** `--expires-in`: how long a reboot or reload stays actionable, as expires_in_s (60 to 86400). */
export function expiresInSeconds(value: string): number {
  return boundedSeconds("--expires-in", value, COMMAND_EXPIRES_MIN_S, COMMAND_EXPIRES_MAX_S, "90s, 30m, 2h, or 1d", "60s to 24h");
}

/** Commander parser: validate now, keep the string for the handler. */
export function expiresInOption(value: string): string {
  expiresInSeconds(value);
  return value;
}

/** `--duration` of screen identify, as duration_ms (2000 to 600000). */
export function identifyDurationMs(value: string): number {
  return boundedSeconds("--duration", value, IDENTIFY_DURATION_MIN_MS / 1000, IDENTIFY_DURATION_MAX_MS / 1000, "30s, 2m, or 1m30s", "2s to 10m") * 1000;
}

export function identifyDurationOption(value: string): string {
  identifyDurationMs(value);
  return value;
}

/** Trimmed; 1 to 280 characters; line feed is the only control character. */
export function suspendMessage(value: string): string {
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > SUSPEND_MESSAGE_MAX || /[^\P{Cc}\n]/u.test(trimmed)) {
    throw usageError(`--message must be 1 to ${SUSPEND_MESSAGE_MAX} characters, and line feed is the only control character.`);
  }
  return trimmed;
}

export function suspendMessageOption(value: string): string {
  suspendMessage(value);
  return value;
}

/** A server date-time that is safe to print: RFC 3339 shaped and parseable. */
function instant(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

/** The detail of one reboot or reload in a fleet result: its delivery state, when the server named one, and its expiry. */
export function commandResultText(kind: "reload" | "reboot", result: { state?: unknown; expires_at?: unknown } | undefined): string | undefined {
  const expires = instant(result?.expires_at);
  if (!expires) return undefined;
  const state = result?.state === "queued" || result?.state === "sent" ? `${result.state}, ` : "";
  return `${kind} ${state}expires ${expires}`;
}

const COMMAND_STATES = new Set(["queued", "sent", "done", "expired", "cancelled", "superseded"]);
const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The `Commands` block of screen show: the screen's recent reboots and reloads,
 * oldest first, as the server lists them. Only token-shaped types, states and
 * ids and RFC 3339 times are printed; the JSON body carries whatever the
 * server sent.
 */
export function commandLines(screen: Screen | undefined): string[] {
  const commands: unknown = screen?.commands;
  if (!Array.isArray(commands)) return [];
  const rows: string[][] = [];
  for (const item of commands) {
    const command = (item ?? {}) as Record<string, unknown>;
    const { type, state, id } = command;
    if ((type !== "reboot" && type !== "reload") || typeof state !== "string" || !COMMAND_STATES.has(state) || typeof id !== "string" || !COMMAND_ID.test(id)) continue;
    rows.push([type, id, state, instant(command.expires_at) ?? "", instant(command.sent_at) ?? "", instant(command.done_at) ?? "", command.source === "schedule" ? "schedule" : ""]);
  }
  if (!rows.length) return [];
  // SOURCE appears only when a listed command came from a reboot schedule, so plain lists keep their table.
  const withSource = rows.some((row) => row[6] !== "");
  const header = ["TYPE", "ID", "STATE", "EXPIRES", "SENT", "DONE", ...(withSource ? ["SOURCE"] : [])];
  for (const row of rows) { if (withSource) row[6] = row[6] || "manual"; else row.length = 6; }
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index]!.length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  const queued = rows.find((row) => row[2] === "queued");
  const screenId = typeof screen?.id === "string" && screen.id ? screen.id : "<id>";
  return [
    "Commands",
    render(header),
    ...rows.map(render),
    ...(queued ? [`${queued[1]} is queued: it is sent when the screen comes online before it expires. Cancel it with screen command cancel ${screenId} ${queued[1]}.`] : []),
  ];
}

/** The suspension notice screen show prints; the message is server text, so control characters become spaces. */
export function suspensionLines(screen: Screen | undefined): string[] {
  const suspension = screen?.suspension;
  if (!suspension || typeof suspension.message !== "string" || !suspension.message) return [];
  const since = instant(suspension.since);
  const screenId = typeof screen?.id === "string" && screen.id ? screen.id : "<id>";
  return [
    `Suspended${since ? ` since ${since}` : ""}: ${plainText(suspension.message)}`,
    `The screen shows this notice instead of its content; its playlist, schedule and settings are unchanged. screen resume ${screenId} ends it.`,
  ];
}

/** The screen a replaced screen's device moved to. Only a screen id is printed. */
export function replacedByLines(screen: Screen | undefined): string[] {
  const target = screen?.replaced_by;
  if (typeof target !== "string" || !isResourceID(target, "screen")) return [];
  return [`Replaced by ${target}: its device now opens that screen, and a browser that still opens this screen's public URL plays that screen.`];
}

function guided(error: CliError, next: { command: string; reason: string }, detail?: string): CliError {
  return new CliError({ ...error.problem, ...(detail === undefined ? {} : { detail }), next }, error.exitCode, error.warnings);
}

/** 409 identify_unsupported, and the pairing and archive refusals, explained. */
export function identifyProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code === "identify_unsupported") {
    return guided(error, { command: `screenrig screen show ${id}`, reason: "Check the host capabilities. Update the Player, then run the command again; screen toast shows the screen's name meanwhile." },
      `${error.problem.detail} Nothing was sent. Only a Player that declares the identify capability in its host report shows the overlay; update this device's Player, or show the name with screen toast.`);
  }
  if (error.problem.code === "resource_conflict") {
    return guided(error, { command: `screenrig screen show ${id}`, reason: "A screen still waiting to pair has no Player to show an overlay. Pair it first." });
  }
  if (error.problem.code === "screen_archived") {
    return guided(error, { command: `screenrig screen unarchive ${id}`, reason: "An archived screen refuses identify. Unarchive it first if it should play again." });
  }
  return error;
}

/** screen_archived on suspend and resume: an archived screen is already dark. */
export function suspendProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next || error.problem.code !== "screen_archived") return error;
  return guided(error, { command: `screenrig screen unarchive ${id}`, reason: "An archived screen is already dark and refuses suspend and resume. Unarchive it first if it should show content or a notice again." });
}

/**
 * The replace refusals: both screens must be active with a paired Player, a
 * video wall needs a replacement that declares display.wall, and neither id
 * may be another project's or the same screen.
 */
export function replaceProblem(error: unknown, id: string, withId: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code === "wall_unsupported") return wallProblem(error, withId);
  if (error.problem.code === "resource_conflict" || error.problem.code === "screen_archived") {
    return guided(error, {
      command: `screenrig screen show ${withId}`,
      reason: `Replace needs two active screens with a paired Player: ${id}, which keeps its settings, and ${withId}, whose device takes over. Check both with screen show; a screen still waiting to pair has no Player yet. An archived screen is refused, and one archived as replaced cannot be restored.`,
    });
  }
  return error;
}

/** screen command cancel: only a queued command can be cancelled. */
export function commandCancelProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code === "resource_conflict") {
    return guided(error, { command: `screenrig screen show ${id}`, reason: "commands lists each command's state. Only a queued command can be cancelled: a command that was sent is done once the device reports it booted (reboot), and a command that expired, was cancelled or was superseded is no longer queued." });
  }
  // Only an unknown command: a missing screen keeps the generic not_found guidance.
  if (error.problem.code === "not_found" && /command/i.test(error.problem.detail)) {
    return guided(error, { command: `screenrig screen show ${id}`, reason: "commands lists the screen's recent reboots and reloads; the id is the one listed there, or the reboot_id or reload_id the request answered with." });
  }
  return error;
}
