import type { Warning } from "./envelope.js";
import { CliError, usageError } from "./problems.js";
import type { KVWebhook } from "./adapters/protocol.js";

/** Backend KVWebhook.id and secret shapes (vendor/openapi.yaml). */
export const KV_WEBHOOK_ID_PATTERN = /^(?:(?:stage|qa|development)_)?kvw_[A-Za-z0-9_-]+$/;
export const KV_WEBHOOK_SECRET_PATTERN = /^srkw_[A-Za-z0-9_-]{43}$/;
/** KVWebhookCreate.key: the K/V key shape. */
const KV_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const KV_WEBHOOK_ID_MAX_BYTES = 200;
export const KV_WEBHOOKS_MAX = 20;
export const KV_WEBHOOK_DESCRIPTION_MAX_BYTES = 200;

export function kvWebhookId(value: string | undefined, command: string, applicationId: string): string {
  if (!value) throw usageError(`kv webhook ${command} requires <webhook_id>.`);
  if (Buffer.byteLength(value) > KV_WEBHOOK_ID_MAX_BYTES || !KV_WEBHOOK_ID_PATTERN.test(value)) {
    throw usageError("A K/V webhook id looks like kvw_ followed by letters, digits, - or _.", {
      command: `screenrig kv webhook list --app-id ${applicationId}`,
      reason: "List this application's K/V webhooks and their ids.",
    });
  }
  return value;
}

/** The key every post writes: 1 to 256 characters of letters, digits and . _ : / -, starting with a letter or digit. */
export function kvWebhookKey(value: string | undefined): string {
  if (!value) throw usageError("kv webhook create requires <key>.");
  if (!KV_KEY_PATTERN.test(value)) {
    throw usageError("<key> must be 1 to 256 characters of letters, digits and . _ : / -, starting with a letter or digit.");
  }
  return value;
}

/** At most 200 bytes after trimming and no control characters; the server also refuses one that holds a credential. */
export function kvWebhookDescription(value: string): string {
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed) > KV_WEBHOOK_DESCRIPTION_MAX_BYTES || /\p{Cc}/u.test(trimmed)) {
    throw usageError(`--description must be at most ${KV_WEBHOOK_DESCRIPTION_MAX_BYTES} bytes after trimming, without control characters.`);
  }
  return trimmed;
}

export function kvWebhookSecretWarning(id: string, applicationId: string, action: "create" | "rotate"): Warning {
  const send = "The sending system posts the key's new value to data.url with the header Authorization: Bearer <data.secret> (or HTTP Basic with data.id as the username and data.secret as the password); the raw body becomes the value and its Content-Type the content type.";
  return {
    code: "kv_webhook_secret_shown_once",
    message: action === "create"
      ? `data.secret is this webhook's secret and is shown only in this answer. Store it in the sending system now; screenrig does not save it in its config, logs, or recovery state. ${send} After an interrupted or ambiguous create, rerun the identical command within 24 hours to get this same answer and secret back. Replace a lost secret with screenrig kv webhook rotate-secret ${id} --app-id ${applicationId}.`
      : `data.secret is the webhook's new secret and is shown only in this answer. The previous secret stopped working: put the new one in the sending system now; screenrig does not save it. ${send} After an interrupted or ambiguous rotation, rerun the identical command within 24 hours to get this same secret back.`,
  };
}

/** Map K/V webhook problems to actionable guidance; exit codes stay status-derived (400 → 8, 404 → 4, 409 → 5). */
export function kvWebhookProblem(error: unknown, applicationId: string, id?: string): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.code === "kv_webhook_limit_reached") {
    return new CliError({
      ...problem,
      detail: `This application already has the maximum of ${KV_WEBHOOKS_MAX} K/V webhooks. Nothing was created.`,
      next: problem.next ?? {
        command: `screenrig kv webhook list --app-id ${applicationId}`,
        reason: `Delete a webhook you no longer need with screenrig kv webhook delete ID --app-id ${applicationId}, then rerun create.`,
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.next) return error;
  if (problem.code === "not_found") {
    return new CliError({
      ...problem,
      next: id
        ? { command: `screenrig kv webhook list --app-id ${applicationId}`, reason: "List this application's K/V webhooks; a deleted webhook does not come back." }
        : { command: "screenrig app list", reason: "Find the application's current ID, then rerun with --app-id." },
    }, error.exitCode, error.warnings);
  }
  return error;
}

/** A command an operator can paste to post one JSON value, built from the returned url. */
export function kvWebhookExample(url: string, secret: string): string {
  return `curl -X POST "${url}" -H "Authorization: Bearer ${secret}" -H "Content-Type: application/json" --data '{"message":"Hello"}'`;
}

function when(value: string | undefined, label: string): string[] {
  return value === undefined || value === "" ? [] : [`${label}: ${value}`];
}

/** Every field except the secret, which only create and rotate-secret print under their own label. */
export function kvWebhookLines(webhook: KVWebhook | undefined): string[] {
  if (!webhook) return [];
  return [
    `id: ${webhook.id}`,
    `application_id: ${webhook.application_id}`,
    `key: ${webhook.key}`,
    ...when(webhook.description, "description"),
    `url: ${webhook.url}`,
    ...when(webhook.created_at, "created_at"),
    ...when(webhook.last_used_at, "last_used_at"),
  ];
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [render(header), ...rows.map(render)];
}

export function kvWebhookTableLines(items: KVWebhook[]): string[] {
  if (!items.length) return ["No K/V webhooks"];
  return table(["ID", "KEY", "LAST_USED", "URL", "DESCRIPTION"], items.map((item) => [
    item.id ?? "", item.key ?? "", item.last_used_at ?? "-", item.url ?? "", item.description ?? "",
  ]));
}
