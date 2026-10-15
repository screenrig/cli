import type { Warning } from "./envelope.js";
import { CliError, usageError } from "./problems.js";
import type { Trigger, TriggerAlert } from "./adapters/protocol.js";
import { isResourceID } from "./generated/resource-ids.js";
import { screenTag } from "./screen-fleet.js";

/** Backend Trigger.id shape (vendor/openapi.yaml). */
export const TRIGGER_ID_PATTERN = /^(?:(?:stage|qa|development)_)?trg_[A-Za-z0-9_-]{1,64}$/;
export const TRIGGER_PASSWORD_PATTERN = /^srtg_[A-Za-z0-9_-]{43}$/;
export const TRIGGERS_MAX = 20;
export const TRIGGER_LABEL_MAX = 80;
export const TRIGGER_SCREENS_MAX = 500;
export const TRIGGER_HOLD_MIN_SECONDS = 60;
export const TRIGGER_HOLD_MAX_SECONDS = 604_800;

export function triggerId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`triggers ${command} requires <id>.`);
  if (!TRIGGER_ID_PATTERN.test(value)) {
    throw usageError("A trigger id looks like trg_ followed by letters, digits, - or _.", {
      command: "screenrig triggers list",
      reason: "List this project's triggers and their ids.",
    });
  }
  return value;
}

/** The trigger's display name (Trigger.label): 1 to 80 characters after trimming, no controls. */
export function triggerName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > TRIGGER_LABEL_MAX || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw usageError(`--name must contain 1 to ${TRIGGER_LABEL_MAX} characters without controls.`);
  }
  return trimmed;
}

export function triggerTag(value: string): string {
  return screenTag(value.trim(), "--tag");
}

/** Repeatable --screen-id; each value may also list comma-separated ids. Returns the accumulated list joined by commas. */
export function triggerScreenIds(value: string, previous?: string): string {
  const ids = [...(previous ? previous.split(",") : []), ...value.split(",").map((id) => id.trim())];
  if (ids.some((id) => !isResourceID(id, "screen"))) {
    throw usageError("--screen-id takes screen ids (scr_…), repeated or comma-separated.", {
      command: "screenrig screen list",
      reason: "List this project's screens and their ids.",
    });
  }
  if (new Set(ids).size !== ids.length) throw usageError("--screen-id lists a screen more than once.");
  if (ids.length > TRIGGER_SCREENS_MAX) throw usageError(`--screen-id accepts at most ${TRIGGER_SCREENS_MAX} screens; target a tag instead.`);
  return ids.join(",");
}

/** --for: how long an alert without <expires> holds the screens, 1m to 7d in whole units (30m, 2h, 1d12h). Returns seconds. */
export function triggerHoldSeconds(value: string): number {
  const text = value.trim();
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  const seconds = match && text
    ? Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0)
    : NaN;
  if (!Number.isFinite(seconds) || seconds < TRIGGER_HOLD_MIN_SECONDS || seconds > TRIGGER_HOLD_MAX_SECONDS) {
    throw usageError("--for takes a duration from 1m to 7d, such as 30m, 2h, or 1d.");
  }
  return seconds;
}

export function triggerHoldOption(value: string): string {
  triggerHoldSeconds(value);
  return value;
}

export function triggerPasswordWarning(id: string, action: "create" | "rotate"): Warning {
  return {
    code: "trigger_password_shown_once",
    message: action === "create"
      ? `data.password is this trigger's HTTP Basic password and is shown only in this answer. Enter data.url, data.username and data.password in the emergency notification system now; screenrig does not save the password in its config, logs, or recovery state. After an interrupted or ambiguous create, rerun the identical command within 24 hours to get this same answer and password back. Replace a lost password with screenrig triggers rotate-secret ${id}.`
      : `data.password is the trigger's new HTTP Basic password and is shown only in this answer. The previous password stopped working: enter the new one in the emergency notification system now; screenrig does not save it. After an interrupted or ambiguous rotation, rerun the identical command within 24 hours to get this same password back.`,
  };
}

/** Map trigger problems to actionable guidance; exit codes stay status-derived (400 → 8, 404 → 4, 409 → 5, 412 → 6). */
export function triggerProblem(error: unknown, id?: string): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.code === "trigger_limit_reached") {
    return new CliError({
      ...problem,
      detail: `This project already has the maximum of ${TRIGGERS_MAX} triggers. Nothing was created.`,
      next: problem.next ?? {
        command: "screenrig triggers list",
        reason: "Delete a trigger you no longer need with screenrig triggers delete ID, then rerun create.",
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.next) return error;
  if (problem.code === "resource_conflict" && id) {
    return new CliError({
      ...problem,
      next: { command: `screenrig triggers clear ${id}`, reason: "An alert is showing. Clear it first; its screens go back to what they played before." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "revision_conflict" && id) {
    return new CliError({
      ...problem,
      next: { command: `screenrig triggers show ${id}`, reason: "Read the current revision, then rerun with --expect-rev REVISION if the change still applies." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "not_found" && id) {
    return new CliError({
      ...problem,
      next: { command: "screenrig triggers list", reason: "List this project's triggers; a deleted trigger does not come back." },
    }, error.exitCode, error.warnings);
  }
  return error;
}

function when(value: string | number | undefined, label: string): string[] {
  return value === undefined || value === "" ? [] : [`${label}: ${value}`];
}

/** "tag Lobby" or "3 screens: scr_a, scr_b, scr_c". */
export function triggerTargetText(trigger: Pick<Trigger, "target"> | undefined): string {
  const target = trigger?.target;
  if (target?.tag) return `tag ${target.tag}`;
  const ids = target?.screen_ids ?? [];
  return `${ids.length} screen${ids.length === 1 ? "" : "s"}${ids.length ? `: ${ids.join(", ")}` : ""}`;
}

function holdText(seconds: number | undefined): string {
  if (seconds === undefined) return "";
  const parts: string[] = [];
  let rest = seconds;
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]] as const) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  return parts.join("") || "0s";
}

/** One line on what the alert did to its screens. */
export function alertScreensText(alert: TriggerAlert): string {
  const screens = alert.screens;
  const changed = alert.state === "ended" ? `${screens.cleared} cleared` : `${screens.taken_over} taken over`;
  const pending = screens.pending ? "; still writing screens" : "";
  return `${changed} of ${screens.targeted} targeted, ${screens.skipped} skipped, ${screens.failed} failed${pending}`;
}

export function alertLines(alert: TriggerAlert | undefined): string[] {
  if (!alert) return [];
  return [
    "",
    "Alert",
    `id: ${alert.id}`,
    `state: ${alert.state}${alert.ended_reason ? ` (${alert.ended_reason})` : ""}`,
    `status: ${alert.status}`,
    `msg_type: ${alert.msg_type}`,
    ...when(alert.event, "event"),
    ...when(alert.headline, "headline"),
    ...when(alert.severity, "severity"),
    `sender: ${alert.sender}`,
    `identifier: ${alert.identifier}`,
    `until: ${alert.until}`,
    `screens: ${alertScreensText(alert)}`,
    ...when(alert.media_id, "media_id"),
    `started_at: ${alert.started_at}`,
    ...when(alert.ended_at, "ended_at"),
  ];
}

/** Every field except the password, which only create and rotate print under their own label. */
export function triggerLines(trigger: Trigger | undefined): string[] {
  if (!trigger) return [];
  return [
    `id: ${trigger.id}`,
    `label: ${trigger.label}`,
    `target: ${triggerTargetText(trigger)}`,
    `hold: ${holdText(trigger.default_for_seconds)} when an alert has no <expires>`,
    `url: ${trigger.url}`,
    `username: ${trigger.username}`,
    ...when(trigger.playlist_id, "playlist_id"),
    ...when(trigger.last_received_at, "last_received_at"),
    `revision: ${trigger.revision}`,
    ...when(trigger.created_at, "created_at"),
    ...when(trigger.updated_at, "updated_at"),
  ];
}

function alertCell(alert: TriggerAlert | undefined): string {
  if (!alert) return "-";
  if (alert.state === "ended") return `ended (${alert.ended_reason ?? "ended"})`;
  return `${alert.status === "Exercise" ? "exercise" : "active"} ${alert.severity ?? ""} until ${alert.until}`.replace(/\s+/g, " ");
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [render(header), ...rows.map(render)];
}

export function triggerTableLines(items: Trigger[]): string[] {
  if (!items.length) return ["No triggers"];
  return table(["ID", "LABEL", "TARGET", "ALERT", "LAST_RECEIVED"], items.map((item) => [
    item.id ?? "", item.label ?? "", item.target?.tag ? `tag ${item.target.tag}` : `${item.target?.screen_ids?.length ?? 0} screens`,
    alertCell(item.alert), item.last_received_at ?? "",
  ]));
}
