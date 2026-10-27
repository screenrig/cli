import type { Warning } from "./envelope.js";
import { CliError, usageError } from "./problems.js";
import type { Notification, NotificationDelivery } from "./adapters/protocol.js";
import { fleetLinkTags } from "./fleet-links.js";
import { normalizeInstant } from "./screen-control.js";
import { table } from "./webhooks.js";

/** Backend Notification.id shape (vendor/openapi.yaml): ntf_ for an email notification, whk_ for a webhook. */
export const NOTIFICATION_ID_PATTERN = /^(?:(?:stage|qa|development)_)?(?:whk|ntf)_[A-Za-z0-9_-]{16,24}$/;
export const NOTIFICATIONS_MAX = 20;
/** NotificationCondition (vendor/openapi.yaml): the screen state changes a notification fires on. */
export const NOTIFICATION_CONDITIONS = ["screen_offline", "display_disconnected", "running_hot", "storage_full", "content_stuck", "crashing"] as const;
export const NOTIFICATION_RECIPIENTS_MAX = 20;
const RECIPIENT_MAX_LENGTH = 200;
export const NOTIFICATION_HOLD_MAX = 1440;
/** The server allows a snooze at most 30 days ahead of its clock; --snooze DURATION keeps a minute of headroom. */
export const NOTIFICATION_SNOOZE_MAX_MS = 30 * 86_400_000 - 60_000;

export function notificationId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`notifications ${command} requires <id>.`);
  if (!NOTIFICATION_ID_PATTERN.test(value)) {
    throw usageError("A notification id looks like ntf_ (email) or whk_ (webhook) followed by 16 to 24 letters, digits, - or _.", {
      command: "screenrig notifications list",
      reason: "List this project's notifications and their ids.",
    });
  }
  return value;
}

/** Comma-separated NotificationCondition values, each at most once. */
export function notificationConditions(value: string): string[] {
  const names = NOTIFICATION_CONDITIONS.join(", ");
  const conditions = value.split(",").map((item) => item.trim());
  if (conditions.some((item) => !item)) throw usageError(`--conditions takes comma-separated conditions with no empty entries: ${names}.`);
  const unknown = conditions.find((item) => !(NOTIFICATION_CONDITIONS as readonly string[]).includes(item));
  if (unknown !== undefined) throw usageError(`--conditions does not take ${JSON.stringify(unknown)}; use ${names}.`);
  if (new Set(conditions).size !== conditions.length) throw usageError("--conditions must not repeat a condition.");
  return conditions;
}

/** Comma-separated recipients: owner, or the user id of a project member. The server checks membership. */
export function notificationRecipients(value: string): string[] {
  const recipients = value.split(",").map((item) => item.trim());
  if (recipients.some((item) => !item)) {
    throw usageError("--email takes comma-separated recipients with no empty entries: owner, or the user id of a project member.");
  }
  if (recipients.some((item) => [...item].length > RECIPIENT_MAX_LENGTH || /\s/.test(item))) {
    throw usageError(`--email recipients are owner or a project member's user id: no spaces, at most ${RECIPIENT_MAX_LENGTH} characters each.`);
  }
  if (new Set(recipients).size !== recipients.length) throw usageError("--email must not repeat a recipient.");
  if (recipients.length > NOTIFICATION_RECIPIENTS_MAX) throw usageError(`--email takes at most ${NOTIFICATION_RECIPIENTS_MAX} recipients.`);
  return recipients;
}

/** Repeatable --tag; each value may also list comma-separated tags (1 to 32 letters or digits, at most 16). Returns the list joined by commas. */
export function notificationTags(value: string, previous?: string): string {
  return fleetLinkTags(value, previous);
}

/** Minutes a condition must last before it notifies, 0 to 1440. */
export function notificationHold(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) > NOTIFICATION_HOLD_MAX) {
    throw usageError(`--hold must be a whole number of minutes from 0 to ${NOTIFICATION_HOLD_MAX}.`);
  }
  return value;
}

const SNOOZE_FORMS = "--snooze takes a duration such as 30m, 1h, 4h or 2d (up to 30 days), an RFC 3339 instant with seconds and an offset such as 2026-11-01T09:00:00Z, or off.";

/** `30m`, `1h30m`, `2d`, `90s`: whole units; undefined when the text is not a duration. */
function snoozeDurationMs(text: string): number | undefined {
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!match || !text) return undefined;
  return (Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0)) * 1000;
}

/**
 * --snooze: `off` ends the snooze (null), a duration counts from this
 * computer's clock, and an instant is sent normalized to UTC. The server owns
 * the 30-day limit on an instant.
 */
export function snoozedUntil(value: string, now: Date): string | null {
  const text = value.trim();
  if (text === "off") return null;
  const ms = snoozeDurationMs(text);
  if (ms !== undefined) {
    if (ms <= 0) throw usageError(SNOOZE_FORMS);
    if (ms > NOTIFICATION_SNOOZE_MAX_MS) {
      throw usageError("--snooze must be under 30 days (at most 29d23h59m), leaving a minute for clock differences with the server. Use an RFC 3339 instant for an exact end, or off to end a snooze.");
    }
    return new Date(now.getTime() + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  const instant = normalizeInstant(text);
  if (instant === undefined) throw usageError(SNOOZE_FORMS);
  return instant;
}

export function notificationSnooze(value: string): string {
  snoozedUntil(value, new Date(0));
  return value;
}

export function notificationSecretWarning(id: string, action: "create" | "rotate"): Warning {
  return {
    code: "webhook_secret_shown_once",
    message: action === "create"
      ? `data.secret is this webhook's signing secret and is shown only in this answer. Store it in the receiver's secret store now; screenrig does not save it in its config, logs, or recovery state. After an interrupted or ambiguous create, rerun the identical command within 24 hours to get this same answer and secret back. Replace a lost secret with screenrig notifications rotate-secret ${id}.`
      : `data.secret is the new signing secret and is shown only in this answer. Store it in the receiver's secret store now; screenrig does not save it. The previous secret stopped signing, but at most one attempt already in flight may still arrive signed with it, so accept both briefly. After an interrupted or ambiguous rotation, rerun the identical command within 24 hours to get this same secret back.`,
  };
}

/** Map notification problems to actionable guidance; exit codes stay status-derived (400 → 8, 409 → 5, 412 → 6). */
export function notificationProblem(error: unknown, id?: string): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.code === "webhook_url_rejected") {
    const reason = problem.detail.trim().replace(/\.$/, "");
    return new CliError({
      ...problem,
      detail: `The webhook URL was rejected: ${reason}.`,
      next: problem.next ?? {
        command: id ? `screenrig notifications update ${id} --url https://HOST/PATH` : "screenrig notifications create --webhook https://HOST/PATH --conditions screen_offline",
        reason: "Use an https URL on port 443 (the default) or 8443 whose host resolves only to public Internet addresses. Nothing was created or changed.",
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "notification_limit_reached") {
    return new CliError({
      ...problem,
      detail: `This project already has the maximum of ${NOTIFICATIONS_MAX} notifications, email and webhook together. Nothing was created.`,
      next: problem.next ?? {
        command: "screenrig notifications list",
        reason: "Delete a notification you no longer need with screenrig notifications delete ID, then rerun create.",
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "revision_conflict" && id && !problem.next) {
    return new CliError({
      ...problem,
      next: { command: `screenrig notifications show ${id}`, reason: "Read the current revision and state, then rerun with --expect-rev REVISION if the change still applies." },
    }, error.exitCode, error.warnings);
  }
  return error;
}

function when(value: string | undefined, label: string): string[] {
  return value ? [`${label}: ${value}`] : [];
}

/** A receiver URL withheld from a Read only credential: said, never printed as the URL. */
const READ_ONLY_URL = "withheld from a Read only credential. A Manage sign-in (screenrig login --access manage) receives it.";

function withheld(notification: Notification): boolean {
  return notification.url_redacted === true && !notification.url;
}

export function notificationLines(notification: Notification | undefined): string[] {
  if (!notification) return [];
  return [
    `id: ${notification.id}`,
    `channel: ${notification.channel}`,
    ...(notification.recipients ? [`recipients: ${notification.recipients.join(", ")}`] : []),
    ...(notification.url !== undefined || notification.url_redacted ? [`url: ${withheld(notification) ? READ_ONLY_URL : notification.url ?? ""}`] : []),
    `conditions: ${(notification.conditions ?? []).join(", ") || "none"}`,
    ...(notification.event_types?.length ? [`event_types: ${notification.event_types.join(", ")}`] : []),
    `screen_tags: ${(notification.screen_tags ?? []).join(", ") || "(every screen)"}`,
    `hold_minutes: ${notification.hold_minutes}`,
    `enabled: ${notification.enabled}`,
    `status: ${notification.status}`,
    `revision: ${notification.revision}`,
    ...when(notification.description, "description"),
    ...when(notification.snoozed_until, "snoozed_until"),
    ...when(notification.failing_since, "failing_since"),
    ...when(notification.disabled_reason, "disabled_reason"),
    ...when(notification.disabled_at, "disabled_at"),
    ...when(notification.last_success_at, "last_success_at"),
    ...when(notification.last_failure_at, "last_failure_at"),
  ];
}

function destination(notification: Notification): string {
  if (notification.recipients) return notification.recipients.join(",");
  return withheld(notification) ? "(withheld)" : notification.url ?? "";
}

/** SNOOZED_UNTIL and EVENTS appear only when a listed notification has them. */
export function notificationTableLines(items: Notification[]): string[] {
  if (!items.length) return ["No notifications"];
  const snoozed = items.some((item) => item.snoozed_until);
  const events = items.some((item) => item.event_types?.length);
  const lines = table(
    ["ID", "CHANNEL", "STATUS", "ENABLED", ...(snoozed ? ["SNOOZED_UNTIL"] : []), "CONDITIONS", ...(events ? ["EVENTS"] : []), "TO"],
    items.map((item) => [
      item.id ?? "", item.channel ?? "", item.status ?? "", String(item.enabled),
      ...(snoozed ? [item.snoozed_until ?? ""] : []),
      (item.conditions ?? []).join(","),
      ...(events ? [(item.event_types ?? []).join(",")] : []),
      destination(item),
    ]),
  );
  return items.some(withheld)
    ? [...lines, "", "URLs: withheld from a Read only credential. A Manage sign-in (screenrig login --access manage) receives them."]
    : lines;
}

/** CONDITION, PHASE, SCREEN and EMAILED appear only when a listed delivery has them (screen notices, email). */
export function notificationDeliveryTableLines(items: NotificationDelivery[]): string[] {
  if (!items.length) return ["No deliveries"];
  const columns: Array<[string, (item: NotificationDelivery) => string | undefined, boolean]> = [
    ["ID", (item) => item.id ?? "", true],
    ["EVENT_TYPE", (item) => `${item.event_type ?? ""}${item.test ? " (test)" : ""}`, true],
    ["CONDITION", (item) => item.condition, false],
    ["PHASE", (item) => item.phase, false],
    ["SCREEN", (item) => item.screen_name ?? item.screen_id, false],
    ["STATE", (item) => item.state ?? "", true],
    ["ATTEMPTS", (item) => String(item.attempts ?? 0), true],
    ["LAST_STATUS", (item) => (item.last_status === undefined ? "" : String(item.last_status)), true],
    ["LAST_ERROR", (item) => item.last_error ?? "", true],
    ["EMAILED", (item) => (item.emailed === undefined ? undefined : String(item.emailed)), false],
    ["CREATED_AT", (item) => item.created_at ?? "", true],
  ];
  const shown = columns.filter(([, cell, always]) => always || items.some((item) => cell(item) !== undefined));
  return table(shown.map(([name]) => name), items.map((item) => shown.map(([, cell]) => cell(item) ?? "")));
}
