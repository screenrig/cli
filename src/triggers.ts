import type { Warning } from "./envelope.js";
import { CliError, usageError } from "./problems.js";
import type { Trigger, TriggerAlert, TriggerDelivery, TriggerOverlay } from "./adapters/protocol.js";
import { isResourceID } from "./generated/resource-ids.js";
import { screenTag } from "./screen-fleet.js";

/** Backend Trigger.id shape (vendor/openapi.yaml). */
export const TRIGGER_ID_PATTERN = /^(?:(?:stage|qa|development)_)?trg_[A-Za-z0-9_-]{1,64}$/;
export const TRIGGER_PASSWORD_PATTERN = /^srtg_[A-Za-z0-9_-]{43}$/;
export const TRIGGERS_MAX = 20;
export const TRIGGER_LABEL_MAX = 80;
export const TRIGGER_SCREENS_MAX = 500;
export const TRIGGER_HOLD_MIN_SECONDS = 60;
export const TRIGGER_OVERLAY_HOLD_MIN_SECONDS = 10;
export const TRIGGER_HOLD_MAX_SECONDS = 604_800;
export const TRIGGER_SIGNING_SECRET_PATTERN = /^whsec_[A-Za-z0-9_-]{43}$/;
export const TRIGGER_MAPPING_MAX_BYTES = 64 * 1024;
export const TRIGGER_DELIVERIES_MAX = 100;

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

/**
 * --for: how long an alert holds the screens when it names no end of its own
 * (a CAP alert without <expires>, an overlay post without a duration), in whole
 * units (30m, 2h, 1d12h). A CAP trigger holds 1m to 7d, an overlay trigger
 * 10s to 7d. Returns seconds.
 */
export function triggerHoldSeconds(value: string, kind: "cap" | "overlay" = "cap"): number {
  const text = value.trim();
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  const seconds = match && text
    ? Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0)
    : NaN;
  const minimum = kind === "overlay" ? TRIGGER_OVERLAY_HOLD_MIN_SECONDS : TRIGGER_HOLD_MIN_SECONDS;
  if (!Number.isFinite(seconds) || seconds < minimum || seconds > TRIGGER_HOLD_MAX_SECONDS) {
    throw usageError(kind === "overlay" ? "--for takes a duration from 10s to 7d, such as 90s, 30m, 2h, or 1d." : "--for takes a duration from 1m to 7d, such as 30m, 2h, or 1d.");
  }
  return seconds;
}

/** The option-parse check: the widest range, since the kind is not known yet. */
export function triggerHoldOption(value: string): string {
  triggerHoldSeconds(value, "overlay");
  return value;
}

/** --map: the template that builds an overlay post from the body a sender posts, a JSON object of at most 64 KiB. */
export function triggerMapping(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > TRIGGER_MAPPING_MAX_BYTES) throw usageError("--map is larger than 64 KiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw usageError("--map must hold a JSON object: the template that builds the overlay post.", {
      command: "screenrig triggers create --help",
      reason: 'Example template: {"alert_id":"{{body.groupKey}}","title":"{{body.title}}","state":"{{body.status}}"}.',
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError("--map must be a JSON object: the template that builds the overlay post.");
  }
  return parsed as Record<string, unknown>;
}

/** --style: a JSON object of the text card's static params; the server checks every member. */
export function triggerStyle(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw usageError('--style must hold a JSON object, such as {"theme":"signal","accent":"#FFB000"}.');
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError('--style must be a JSON object, such as {"theme":"signal","accent":"#FFB000"}.');
  }
  return parsed as Record<string, unknown>;
}

export function triggerDeliveriesLimit(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > TRIGGER_DELIVERIES_MAX) throw usageError(`--limit takes a whole number from 1 to ${TRIGGER_DELIVERIES_MAX}.`);
  return value;
}

export function triggerPasswordWarning(id: string, action: "create" | "rotate", kind: "cap" | "overlay" = "cap"): Warning {
  const sender = kind === "overlay" ? "the sending system (Home Assistant, a sensor hub, an alerting tool)" : "the emergency notification system";
  const enter = kind === "overlay"
    ? `Enter data.url and data.password in ${sender} now: it posts to the url with Authorization: Bearer <password>, or HTTP Basic with data.username and the password.`
    : `Enter data.url, data.username and data.password in ${sender} now.`;
  return {
    code: "trigger_password_shown_once",
    message: action === "create"
      ? `data.password is this trigger's ${kind === "overlay" ? "secret" : "HTTP Basic password"} and is shown only in this answer. ${enter} screenrig does not save the password in its config, logs, or recovery state. After an interrupted or ambiguous create, rerun the identical command within 24 hours to get this same answer and password back. Replace a lost password with screenrig triggers rotate-secret ${id}.`
      : `data.password is the trigger's new ${kind === "overlay" ? "secret" : "HTTP Basic password"} and is shown only in this answer. The previous password stopped working: enter the new one in ${sender} now; screenrig does not save it. After an interrupted or ambiguous rotation, rerun the identical command within 24 hours to get this same password back.`,
  };
}

export function triggerSigningWarning(id: string): Warning {
  return {
    code: "trigger_signing_secret_shown_once",
    message: `data.signing_secret is shown only in this answer. Store it in the sending system now; screenrig does not save it. Every post then carries ScreenRig-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed with the signing secret>, and a post whose timestamp is more than five minutes from the server's clock, or whose signature does not match, is refused like a wrong secret. Replace a lost signing secret with screenrig triggers rotate-secret ${id} --signing.`,
  };
}

/** The post a sender makes, with placeholders in place of the secret. */
export function triggerExample(url: string, signing: boolean): string {
  const body = `'{"alert_id":"front-door","title":"Front door","message":"The front door is open","duration":"10m"}'`;
  const signed = signing ? ` -H "ScreenRig-Signature: t=<unix seconds>,v1=<hmac>"` : "";
  return `curl -X POST ${url} -H "Authorization: Bearer <password>"${signed} -H "Content-Type: application/json" -d ${body}`;
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

function untilText(until: string | null): string {
  return until === null ? "until cleared" : `until ${until}`;
}

/** One line on what the latest fan-out did to the target screens of an overlay trigger. */
export function overlayScreensText(overlay: TriggerOverlay): string {
  const screens = overlay.screens;
  const done = overlay.show === "bar" ? `${screens.holding} hold the bar` : `${screens.taken_over} taken over`;
  const edge = screens.edge_taken > 0 ? `, ${screens.edge_taken} with the edge taken` : "";
  const pending = overlay.pending ? "; still writing" : "";
  return `${done} of ${screens.targeted} targeted${edge}, ${screens.removed} removed, ${screens.skipped} skipped, ${screens.failed} failed${pending}`;
}

/** The overlay of a trigger: what it draws, how it is guarded, the alerts it holds. */
export function overlayLines(overlay: TriggerOverlay | undefined): string[] {
  if (!overlay) return [];
  const lines = [
    "",
    "Overlay",
    `show: ${overlay.show}${overlay.edge ? ` on the ${overlay.edge} edge` : ""}`,
    `enabled: ${overlay.enabled}`,
    `signing: ${overlay.signing}`,
    ...when(overlay.card_id, "card_id"),
    ...(overlay.mapping ? ["mapping: set"] : []),
    ...(Object.keys(overlay.style ?? {}).length ? [`style: ${JSON.stringify(overlay.style)}`] : []),
    `screens: ${overlayScreensText(overlay)}`,
    `alerts: ${overlay.alerts.length}`,
  ];
  for (const alert of overlay.alerts) {
    const words = [alert.label, alert.title, alert.message].filter(Boolean).join(" | ");
    lines.push(`  ${alert.id}  ${untilText(alert.until)}${words ? `  ${words}` : ""}`);
  }
  return lines;
}

/** Every field except the password, which only create and rotate print under their own label. */
export function triggerLines(trigger: Trigger | undefined): string[] {
  if (!trigger) return [];
  return [
    `id: ${trigger.id}`,
    `label: ${trigger.label}`,
    `target: ${triggerTargetText(trigger)}`,
    `kind: ${trigger.kind}`,
    `hold: ${holdText(trigger.default_for_seconds)} ${trigger.kind === "overlay" ? "when a post names no duration" : "when an alert has no <expires>"}`,
    `url: ${trigger.url}`,
    `username: ${trigger.username}`,
    ...when(trigger.playlist_id, "playlist_id"),
    ...when(trigger.last_received_at, "last_received_at"),
    `revision: ${trigger.revision}`,
    ...when(trigger.created_at, "created_at"),
    ...when(trigger.updated_at, "updated_at"),
  ];
}

function alertCell(item: Trigger): string {
  if (item.overlay) {
    const count = item.overlay.alerts.length;
    const shown = item.overlay.alerts[0];
    const state = `${item.overlay.show}${item.overlay.enabled ? "" : " (disabled)"}`;
    return count ? `${state}: ${count} alert${count === 1 ? "" : "s"}, ${shown?.title ?? shown?.id ?? ""}`.trim() : `${state}: none`;
  }
  const alert = item.alert;
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
  return table(["ID", "KIND", "LABEL", "TARGET", "ALERT", "LAST_RECEIVED"], items.map((item) => [
    item.id ?? "", item.kind ?? "", item.label ?? "", item.target?.tag ? `tag ${item.target.tag}` : `${item.target?.screen_ids?.length ?? 0} screens`,
    alertCell(item), item.last_received_at ?? "",
  ]));
}

export function triggerDeliveryTableLines(items: TriggerDelivery[]): string[] {
  if (!items.length) return ["No deliveries in the last seven days"];
  return table(["AT", "OUTCOME", "REASON", "STATUS", "BYTES", "ALERT", "DETAIL"], items.map((item) => [
    item.at ?? "", item.outcome ?? "", item.reason ?? "-", String(item.status ?? ""), String(item.bytes ?? ""), item.alert_id ?? "-", item.detail ?? "",
  ]));
}
