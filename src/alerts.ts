import type { Alert, AlertActor, AlertList, AlertMute } from "./adapters/protocol.js";
import { fleetLinkTags } from "./fleet-links.js";
import { isResourceID } from "./generated/resource-ids.js";
import { NOTIFICATION_SNOOZE_MAX_MS, snoozeDurationMs } from "./notifications.js";
import { CliError, usageError } from "./problems.js";
import { normalizeInstant } from "./screen-control.js";
import { table } from "./webhooks.js";

/** Backend Alert.id and AlertMute.id shapes (vendor/openapi.yaml). */
export const ALERT_ID_PATTERN = /^(?:(?:stage|qa|development)_)?alr_[A-Za-z0-9_-]{16,24}$/;
export const ALERT_MUTE_ID_PATTERN = /^(?:(?:stage|qa|development)_)?amt_[A-Za-z0-9_-]{16,24}$/;
/** GET /api/alerts state: open is the default. */
export const ALERT_STATES = ["open", "resolved", "all"] as const;
export const ALERTS_LIMIT_MAX = 200;
const ALERTS_CURSOR_MAX = 200;
/** A project has at most this many current mutes. */
export const ALERT_MUTES_MAX = 50;
export const ALERT_MUTE_SCREENS_MAX = 100;
export const ALERT_NOTE_MAX = 200;

export function alertId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`alerts ${command} requires <id>.`);
  if (!ALERT_ID_PATTERN.test(value)) {
    throw usageError("An alert id looks like alr_ followed by 16 to 24 letters, digits, - or _.", {
      command: "screenrig alerts list",
      reason: "List this project's open alerts and their ids.",
    });
  }
  return value;
}

export function alertMuteId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`alerts ${command} requires <mute-id>.`);
  if (!ALERT_MUTE_ID_PATTERN.test(value)) {
    throw usageError("A mute id looks like amt_ followed by 16 to 24 letters, digits, - or _.", {
      command: "screenrig alerts mutes",
      reason: "List this project's current mutes and their ids.",
    });
  }
  return value;
}

export function alertsLimit(value: string): string {
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < 1 || number > ALERTS_LIMIT_MAX) {
    throw usageError(`--limit must be a whole number from 1 to ${ALERTS_LIMIT_MAX}.`);
  }
  return value;
}

/** The next_cursor of a previous alerts list page: opaque to the CLI, at most 200 characters. */
export function alertsCursor(value: string): string {
  if (!value || [...value].length > ALERTS_CURSOR_MAX) {
    throw usageError("--before takes the data.next_cursor of a previous alerts list page.");
  }
  return value;
}

/** alerts list --screen-id: one screen. */
export function alertScreenId(value: string): string {
  if (!isResourceID(value, "screen")) {
    throw usageError("--screen-id takes a screen id (scr_…).", {
      command: "screenrig screen list",
      reason: "List this project's screens and their ids.",
    });
  }
  return value;
}

/** Repeatable alerts mute --screen-id; each value may also list comma-separated ids. Returns the accumulated list joined by commas. */
export function alertMuteScreenIds(value: string, previous?: string): string {
  const ids = [...(previous ? previous.split(",") : []), ...value.split(",").map((id) => id.trim())];
  if (ids.some((id) => !isResourceID(id, "screen"))) {
    throw usageError("--screen-id takes screen ids (scr_…), repeated or comma-separated.", {
      command: "screenrig screen list",
      reason: "List this project's screens and their ids.",
    });
  }
  if (new Set(ids).size !== ids.length) throw usageError("--screen-id lists a screen more than once.");
  if (ids.length > ALERT_MUTE_SCREENS_MAX) throw usageError(`--screen-id accepts at most ${ALERT_MUTE_SCREENS_MAX} screens; mute a tag instead.`);
  return ids.join(",");
}

/** Repeatable alerts mute --tag; each value may also list comma-separated tags (1 to 32 letters or digits, at most 16). Returns the list joined by commas. */
export function alertMuteTags(value: string, previous?: string): string {
  return fleetLinkTags(value, previous);
}

export function alertNote(value: string): string {
  if ([...value].length > ALERT_NOTE_MAX) throw usageError(`--note must be at most ${ALERT_NOTE_MAX} characters.`);
  return value;
}

const FOR_FORMS = "--for takes a duration such as 30m, 1h, 4h or 2d (up to 30 days).";
const UNTIL_FORMS = "--until takes an RFC 3339 instant with seconds and an offset, such as 2026-11-01T09:00:00Z or 2026-11-01T09:00:00-07:00.";

/** --for counts from this computer's clock and is sent as an instant. */
export function alertForInstant(value: string, now: Date): string {
  const ms = snoozeDurationMs(value.trim());
  if (ms === undefined || ms <= 0) throw usageError(FOR_FORMS);
  if (ms > NOTIFICATION_SNOOZE_MAX_MS) {
    throw usageError("--for must be under 30 days (at most 29d23h59m), leaving a minute for clock differences with the server. Use --until for an exact end.");
  }
  return new Date(now.getTime() + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** --until is an RFC 3339 instant, sent normalized to UTC. The server owns the 30-day limit on an instant. */
export function alertUntilInstant(value: string): string {
  const instant = normalizeInstant(value.trim());
  if (instant === undefined) throw usageError(UNTIL_FORMS);
  return instant;
}

export function alertForOption(value: string): string {
  alertForInstant(value, new Date(0));
  return value;
}

export function alertUntilOption(value: string): string {
  alertUntilInstant(value);
  return value;
}

/** The instant a snooze or a mute lasts until, from exactly one of --for and --until. */
export function alertEnd(forValue: string | undefined, untilValue: string | undefined, now: Date): string {
  if ((forValue === undefined) === (untilValue === undefined)) throw usageError("Provide exactly one of --for or --until.");
  return forValue !== undefined ? alertForInstant(forValue, now) : alertUntilInstant(untilValue!);
}

/**
 * Add the next step to alert problems. The server's own `next` and `hint` stay;
 * exit codes stay status-derived (404 → 4, 409 → 5, 400 → 8).
 */
export function alertProblem(error: unknown, id?: string): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.next) return error;
  const withNext = (command: string, reason: string) => new CliError({ ...problem, next: { command, reason } }, error.exitCode, error.warnings);
  if (problem.code === "alert_not_open") {
    return withNext("screenrig alerts list", `${id ? `Alert ${id} has resolved` : "The alert has resolved"}, so there is nothing to acknowledge or snooze. List the open alerts and pick one of those.`);
  }
  if (problem.code === "alert_mute_limit_reached") {
    return withNext("screenrig alerts mutes", `A project has at most ${ALERT_MUTES_MAX} current mutes. End one with screenrig alerts unmute MUTE_ID, or cover more screens with one mute by tag, then rerun mute. Nothing was created.`);
  }
  if (problem.code === "not_found" && id !== undefined) {
    return ALERT_MUTE_ID_PATTERN.test(id)
      ? withNext("screenrig alerts mutes", "List the current mutes and their ids. A mute that has ended is no longer listed or found.")
      : withNext("screenrig alerts list --state all", "List the project's alerts and their ids. A resolved alert is kept only for the plan's event retention, so an old id is no longer found.");
  }
  return error;
}

const instantMs = (value: string | undefined): number | undefined => {
  const ms = value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

/** `45s`, `12m`, `3h 5m`, `2d 4h`: whole units, the two largest. */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** How long the condition has lasted so far (open) or in all (resolved); undefined when the answer lacks the instants to say. */
function lasted(alert: Alert, now: Date): string | undefined {
  const since = instantMs(alert.since);
  const end = alert.state === "resolved" ? instantMs(alert.resolved_at) : now.getTime();
  return since === undefined || end === undefined ? undefined : durationText(end - since);
}

/**
 * An open alert's standing: acknowledged until it resolves, snoozed until an
 * instant (or the snooze ended and it needs attention again), muted.
 */
export function screenAlertStateText(alert: Alert, now: Date): string {
  if (alert.state !== "open") return alert.state;
  const parts = ["open"];
  if (alert.snoozed_until !== undefined) {
    parts.push((instantMs(alert.snoozed_until) ?? 0) > now.getTime() ? `snoozed until ${alert.snoozed_until}` : "snooze ended");
  } else if (alert.acknowledged_at !== undefined) {
    parts.push("acknowledged");
  }
  if (alert.muted) parts.push("muted");
  return parts.join(", ");
}

function clip(text: string, width: number): string {
  const chars = [...text];
  return chars.length > width ? `${chars.slice(0, width - 1).join("")}…` : text;
}

function actorText(actor: AlertActor): string {
  const label = actor.kind === "person" || actor.kind === "agent" ? `${actor.kind} ${actor.id}` : actor.id;
  return actor.name ? `${actor.name} (${label})` : label;
}

function when(value: string | undefined, label: string): string[] {
  return value ? [`${label}: ${value}`] : [];
}

export function screenAlertLines(alert: Alert | undefined, now: Date): string[] {
  if (!alert) return [];
  const duration = lasted(alert, now);
  return [
    `id: ${alert.id}`,
    `screen_id: ${alert.screen_id}`,
    ...when(alert.screen_name, "screen_name"),
    `condition: ${alert.condition}`,
    `state: ${alert.state}`,
    `since: ${alert.since}`,
    ...(duration ? [`for: ${duration}`] : []),
    `attention: ${alert.attention}`,
    `muted: ${alert.muted}`,
    ...when(alert.acknowledged_at, "acknowledged_at"),
    ...(alert.acknowledged_by ? [`acknowledged_by: ${actorText(alert.acknowledged_by)}`] : []),
    ...when(alert.snoozed_until, "snoozed_until"),
    ...when(alert.resolved_at, "resolved_at"),
  ];
}

export function screenAlertTableLines(items: Alert[], now: Date, state?: string): string[] {
  if (!items.length) return [state === "all" ? "No alerts" : `No ${state ?? "open"} alerts`];
  return table(["ID", "SCREEN", "CONDITION", "SINCE", "FOR", "STATE"], items.map((item) => [
    item.id ?? "", clip(item.screen_name ?? item.screen_id ?? "", 40), item.condition ?? "", item.since ?? "", lasted(item, now) ?? "", screenAlertStateText(item, now),
  ]));
}

/** The whole project's open alerts, whatever the page and filters. */
export function screenAlertCountsLine(counts: AlertList["counts"] | undefined): string | undefined {
  if (!counts || typeof counts.open !== "number" || typeof counts.attention !== "number") return undefined;
  return `counts: ${counts.open} open, ${counts.attention} ${counts.attention === 1 ? "needs" : "need"} attention`;
}

/** What `alerts list` was asked, so its next-page command repeats the filters. */
export interface ScreenAlertListQuery {
  state?: string;
  screenId?: string;
  limit?: string;
}

export function screenAlertListLines(page: AlertList | undefined, now: Date, query: ScreenAlertListQuery): string[] {
  const items = Array.isArray(page?.items) ? page.items : [];
  const counts = screenAlertCountsLine(page?.counts);
  const next = typeof page?.next_cursor === "string" && page.next_cursor ? page.next_cursor : undefined;
  return [
    `Alerts (${items.length})`,
    ...screenAlertTableLines(items, now, query.state),
    ...(counts ? [counts] : []),
    ...(next ? [`next: screenrig alerts list${query.state ? ` --state ${query.state}` : ""}${query.screenId ? ` --screen-id ${query.screenId}` : ""} --before ${next}${query.limit ? ` --limit ${query.limit}` : ""}`] : []),
  ];
}

export function alertMuteLines(mute: AlertMute | undefined): string[] {
  if (!mute) return [];
  return [
    `id: ${mute.id}`,
    `screen_ids: ${(mute.screen_ids ?? []).join(", ") || "(none)"}`,
    `tags: ${(mute.tags ?? []).join(", ") || "(none)"}`,
    `until: ${mute.until}`,
    ...when(mute.note, "note"),
    ...(mute.created_by ? [`created_by: ${actorText(mute.created_by)}`] : []),
    ...when(mute.created_at, "created_at"),
  ];
}

/** A cell for a long list: the first three, then how many more. */
function listCell(values: string[] | undefined): string {
  const list = values ?? [];
  return list.length > 3 ? `${list.slice(0, 3).join(",")} +${list.length - 3} more` : list.join(",");
}

export function alertMuteTableLines(items: AlertMute[]): string[] {
  if (!items.length) return ["No current mutes"];
  return table(["ID", "UNTIL", "SCREENS", "TAGS", "BY", "NOTE"], items.map((item) => [
    item.id ?? "", item.until ?? "", listCell(item.screen_ids), listCell(item.tags),
    item.created_by ? item.created_by.name ?? item.created_by.id : "", clip(item.note ?? "", 60),
  ]));
}
