import type { Screen, ScreenMaintenanceCommand } from "./adapters/protocol.js";
import { isResourceID } from "./generated/resource-ids.js";
import { CliError, usageError } from "./problems.js";
import { plainText } from "./reviews.js";
import { wallProblem } from "./screen-wall.js";

/**
 * Queued reboots, reloads, cache clears, app restarts and updates, identify,
 * suspend and replace (backend docs/player-compatibility.md §5.7, §6.3,
 * §6.3.2, §6.5, §6.5.1 and §6.9). Local checks
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

/** `--expires-in`: how long a queued command stays actionable, as expires_in_s (60 to 86400). */
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

/** One of the three remote maintenance commands: the CLI name, the wire type and capability, and the words around the answer. */
export interface MaintenanceSpec {
  /** The screen subcommand. */
  name: "clear-cache" | "restart-app" | "update-software";
  /** The route's command, the fleet action type and the host capability the Player declares. */
  type: ScreenMaintenanceCommand;
  /** The path segment under /api/screens/{id}/. */
  route: "clear-cache" | "restart-app" | "update";
  /** "Clear cache accepted" and "Fleet clear-cache" are built from these. */
  title: string;
  /** What the Player does on receipt, for the answer's closing sentence. */
  effect: string;
  /** What a fleet confirmation warns about. */
  fleetWarning: string;
}

export const MAINTENANCE: Record<MaintenanceSpec["name"], MaintenanceSpec> = {
  "clear-cache": {
    name: "clear-cache", type: "clear_cache", route: "clear-cache", title: "Clear cache",
    effect: "The Player deletes its downloaded media, application packages and data caches, keeps its pairing and settings, then fetches the manifest and content again; the screen can show its loading state while content refills.",
    fleetWarning: "each cleared screen downloads its content again.",
  },
  "restart-app": {
    name: "restart-app", type: "restart_app", route: "restart-app", title: "Restart app",
    effect: "The Player restarts its application, not the device, and reports from the restarted process.",
    fleetWarning: "each restarted Player is dark until its application is back.",
  },
  "update-software": {
    name: "update-software", type: "update", route: "update", title: "Update software",
    effect: "The Player checks for the newest Player release now and installs it; a Player that restarts to install reports from the new version.",
    fleetWarning: "each updating Player may restart.",
  },
};

/** The detail of one queued command in a fleet result: its delivery state, when the server named one, and its expiry. */
export function commandResultText(kind: string, result: { state?: unknown; expires_at?: unknown } | undefined): string | undefined {
  const expires = instant(result?.expires_at);
  if (!expires) return undefined;
  const state = result?.state === "queued" || result?.state === "sent" ? `${result.state}, ` : "";
  return `${kind} ${state}expires ${expires}`;
}

const COMMAND_STATES = new Set(["queued", "sent", "done", "failed", "expired", "cancelled", "superseded"]);
const COMMAND_TYPES = new Set(["reboot", "reload", "clear_cache", "restart_app", "update"]);
const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/;
const COMMAND_CAUSE = /^[a-z0-9_]{1,40}$/;
const COMMAND_DETAIL_MAX = 200;

/**
 * The `Commands` block of screen show: the screen's recent reboots, reloads,
 * cache clears, app restarts and updates, oldest first, as the server lists
 * them. Only token-shaped types, states, ids and causes and RFC 3339 times are
 * printed; the cause the Player reported joins the table as a CAUSE column and
 * its short detail follows as a line of text with control characters turned to
 * spaces. The JSON body carries whatever the server sent.
 */
export function commandLines(screen: Screen | undefined): string[] {
  const commands: unknown = screen?.commands;
  if (!Array.isArray(commands)) return [];
  const rows: string[][] = [];
  const notes: string[] = [];
  for (const item of commands) {
    const command = (item ?? {}) as Record<string, unknown>;
    const { type, state, id } = command;
    if (typeof type !== "string" || !COMMAND_TYPES.has(type) || typeof state !== "string" || !COMMAND_STATES.has(state) || typeof id !== "string" || !COMMAND_ID.test(id)) continue;
    const cause = typeof command.cause === "string" && COMMAND_CAUSE.test(command.cause) ? command.cause : "";
    rows.push([type, id, state, instant(command.expires_at) ?? "", instant(command.sent_at) ?? "", instant(command.done_at) ?? "", cause]);
    const detail = typeof command.detail === "string" ? plainText(command.detail).trim().slice(0, COMMAND_DETAIL_MAX) : "";
    if (detail) notes.push(`${id} ${state}${cause ? ` (${cause})` : ""}: ${detail}`);
  }
  if (!rows.length) return [];
  // The CAUSE column appears only when the Player reported one.
  const withCause = rows.some((row) => row[6] !== "");
  const header = ["TYPE", "ID", "STATE", "EXPIRES", "SENT", "DONE", ...(withCause ? ["CAUSE"] : [])];
  if (!withCause) for (const row of rows) row.pop();
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index]!.length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  const queued = rows.find((row) => row[2] === "queued");
  const screenId = typeof screen?.id === "string" && screen.id ? screen.id : "<id>";
  return [
    "Commands",
    render(header),
    ...rows.map(render),
    ...notes,
    ...(queued ? [`${queued[1]} is queued: it is sent when the screen comes online before it expires. Cancel it with screen command cancel ${screenId} ${queued[1]}.`] : []),
  ];
}

/**
 * clear-cache, restart-app and update-software refusals. 409 command_unsupported:
 * the Player did not declare the capability, so nothing was recorded or sent.
 * The pairing and archive refusals match reboot's.
 */
export function maintenanceProblem(error: unknown, id: string, spec: MaintenanceSpec): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code === "command_unsupported") {
    return guided(error, { command: `screenrig screen show ${id}`, reason: `Check the host capabilities. screen ${spec.name} reaches only a Player that declares ${spec.type}; to refresh content on any screen run screen reload.` },
      `${error.problem.detail} Nothing was sent. A Player that does not declare the ${spec.type} capability in its host report (screen show lists host capabilities) cannot do this; this device's Player did not.`);
  }
  if (error.problem.code === "resource_conflict") {
    return guided(error, { command: `screenrig screen show ${id}`, reason: `A screen still waiting to pair has no Player for ${spec.name}. Pair it first.` });
  }
  if (error.problem.code === "screen_archived") {
    return guided(error, { command: `screenrig screen unarchive ${id}`, reason: `An archived screen refuses ${spec.name}. Unarchive it first if it should play again.` });
  }
  return error;
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
    return guided(error, { command: `screenrig screen show ${id}`, reason: "commands lists each command's state. Only a queued command can be cancelled: a command that was sent is done or failed once the Player reports (a reboot is done once the device reports it booted), and a command that expired, was cancelled or was superseded is no longer queued." });
  }
  // Only an unknown command: a missing screen keeps the generic not_found guidance.
  if (error.problem.code === "not_found" && /command/i.test(error.problem.detail)) {
    return guided(error, { command: `screenrig screen show ${id}`, reason: "commands lists the screen's recent commands; the id is the one listed there, or the reboot_id, reload_id or command_id the request answered with." });
  }
  return error;
}
