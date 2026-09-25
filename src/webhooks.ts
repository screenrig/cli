import type { Warning } from "./envelope.js";
import { CliError, usageError } from "./problems.js";
import type { Webhook, WebhookDelivery } from "./adapters/protocol.js";

/** Backend Webhook.id and WebhookDelivery cursor shapes (vendor/openapi.yaml). */
export const WEBHOOK_ID_PATTERN = /^(?:(?:stage|qa|development)_)?whk_[A-Za-z0-9_-]{16,24}$/;
export const WEBHOOK_DELIVERY_CURSOR_PATTERN = /^whc1_[0-9a-z]{1,16}$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63})*(\.\*|\.[a-z][a-z0-9_]{0,63})$/;
export const WEBHOOK_EVENT_TYPES_MAX = 32;
const EVENT_TYPE_MAX_LENGTH = 200;
const URL_MAX_LENGTH = 2048;
export const WEBHOOK_DESCRIPTION_MAX = 200;
export const WEBHOOK_DELIVERIES_LIMIT_MAX = 200;

export function webhookId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`webhooks ${command} requires <id>.`);
  if (!WEBHOOK_ID_PATTERN.test(value)) {
    throw usageError("A webhook id looks like whk_ followed by 16 to 24 letters, digits, - or _.", {
      command: "screenrig webhooks list",
      reason: "List this project's webhooks and their ids.",
    });
  }
  return value;
}

/** Comma-separated exact types (screen.online) or prefixes ending in .* (screen.*), 1 to 32, unique. */
export function webhookEventTypes(value: string): string[] {
  const types = value.split(",").map((item) => item.trim());
  if (types.some((item) => !item)) throw usageError("--event-types takes comma-separated event types with no empty entries.");
  if (types.length > WEBHOOK_EVENT_TYPES_MAX) throw usageError(`--event-types takes at most ${WEBHOOK_EVENT_TYPES_MAX} event types.`);
  for (const type of types) {
    if (type.length > EVENT_TYPE_MAX_LENGTH || !EVENT_TYPE_PATTERN.test(type)) {
      throw usageError("--event-types entries must be event types such as screen.online or prefixes such as screen.*.");
    }
  }
  if (new Set(types).size !== types.length) throw usageError("--event-types must not repeat an event type.");
  return types;
}

/**
 * Only the scheme, userinfo, fragment, and length are checked locally. The server owns the port rule
 * and the public-address check (it resolves the host), and its reason is shown
 * verbatim on webhook_url_rejected.
 */
export function webhookUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw usageError("--url must be an absolute https URL.");
  }
  if (parsed.protocol !== "https:") throw usageError("--url must be an absolute https URL.");
  if (parsed.username || parsed.password || /^https:\/\/[^/?#]*@/i.test(value)) throw usageError("--url must not carry credentials (user:password@).");
  if (value.includes("#")) throw usageError("--url must not carry a fragment (#…).");
  if (value.length > URL_MAX_LENGTH) throw usageError(`--url must be at most ${URL_MAX_LENGTH} characters.`);
  return value;
}

export function webhookDescription(value: string): string {
  if ([...value].length > WEBHOOK_DESCRIPTION_MAX) throw usageError(`--description must be at most ${WEBHOOK_DESCRIPTION_MAX} characters.`);
  return value;
}

export function webhookDeliveryCursor(value: string): string {
  if (!WEBHOOK_DELIVERY_CURSOR_PATTERN.test(value)) {
    throw usageError("--before takes the next_cursor of a previous webhooks deliveries page (whc1_…).");
  }
  return value;
}

export function webhookDeliveriesLimit(value: string): string {
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < 1 || number > WEBHOOK_DELIVERIES_LIMIT_MAX) {
    throw usageError(`--limit must be a whole number from 1 to ${WEBHOOK_DELIVERIES_LIMIT_MAX}.`);
  }
  return value;
}

export function webhookSecretWarning(id: string, action: "create" | "rotate"): Warning {
  return {
    code: "webhook_secret_shown_once",
    message: action === "create"
      ? `data.secret is this webhook's signing secret and is shown only in this answer. Store it in the receiver's secret store now; screenrig does not save it in its config, logs, or recovery state. After an interrupted or ambiguous create, rerun the identical command within 24 hours to get this same answer and secret back. Replace a lost secret with screenrig webhooks rotate-secret ${id}.`
      : `data.secret is the new signing secret and is shown only in this answer. Store it in the receiver's secret store now; screenrig does not save it. The previous secret stopped signing, but at most one attempt already in flight may still arrive signed with it, so accept both briefly. After an interrupted or ambiguous rotation, rerun the identical command within 24 hours to get this same secret back.`,
  };
}

/** Map webhook problems to actionable guidance; exit codes stay status-derived (400 → 8, 409 → 5, 412 → 6). */
export function webhookProblem(error: unknown, id?: string): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.code === "webhook_url_rejected") {
    const reason = problem.detail.trim().replace(/\.$/, "");
    return new CliError({
      ...problem,
      detail: `The webhook URL was rejected: ${reason}.`,
      next: problem.next ?? {
        command: "screenrig webhooks create --url https://HOST/PATH --event-types TYPES",
        reason: "Use an https URL on port 443 (the default) or 8443 whose host resolves only to public Internet addresses. Nothing was created or changed.",
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "webhook_limit_reached") {
    return new CliError({
      ...problem,
      detail: "This project already has the maximum of 10 webhooks. Nothing was created.",
      next: problem.next ?? {
        command: "screenrig webhooks list",
        reason: "Delete a webhook you no longer need with screenrig webhooks delete ID, then rerun create.",
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "revision_conflict" && id && !problem.next) {
    return new CliError({
      ...problem,
      next: { command: `screenrig webhooks show ${id}`, reason: "Read the current revision and state, then rerun with --expect-rev REVISION if the change still applies." },
    }, error.exitCode, error.warnings);
  }
  return error;
}

function when(value: string | undefined, label: string): string[] {
  return value ? [`${label}: ${value}`] : [];
}

export function webhookLines(webhook: Webhook | undefined): string[] {
  if (!webhook) return [];
  return [
    `id: ${webhook.id}`,
    `url: ${webhook.url}`,
    `event_types: ${(webhook.event_types ?? []).join(", ")}`,
    `enabled: ${webhook.enabled}`,
    `status: ${webhook.status}`,
    `revision: ${webhook.revision}`,
    ...when(webhook.description, "description"),
    ...when(webhook.failing_since, "failing_since"),
    ...when(webhook.disabled_reason, "disabled_reason"),
    ...when(webhook.disabled_at, "disabled_at"),
    ...when(webhook.last_success_at, "last_success_at"),
    ...when(webhook.last_failure_at, "last_failure_at"),
  ];
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [render(header), ...rows.map(render)];
}

export function webhookTableLines(items: Webhook[]): string[] {
  if (!items.length) return ["No webhooks"];
  return table(["ID", "STATUS", "ENABLED", "EVENT_TYPES", "URL"], items.map((item) => [
    item.id ?? "", item.status ?? "", String(item.enabled), (item.event_types ?? []).join(","), item.url ?? "",
  ]));
}

export function deliveryTableLines(items: WebhookDelivery[]): string[] {
  if (!items.length) return ["No deliveries"];
  return table(["ID", "EVENT_TYPE", "STATE", "ATTEMPTS", "LAST_STATUS", "LAST_ERROR", "CREATED_AT"], items.map((item) => [
    item.id ?? "", `${item.event_type ?? ""}${item.test ? " (test)" : ""}`, item.state ?? "", String(item.attempts ?? 0),
    item.last_status === undefined ? "" : String(item.last_status), item.last_error ?? "", item.created_at ?? "",
  ]));
}
