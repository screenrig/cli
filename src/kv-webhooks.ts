import type { Warning } from "./envelope.js";
import { CliError, usageError } from "./problems.js";
import type { CardKVWebhook, KVWebhook, KVWebhookDelivery } from "./adapters/protocol.js";

/** Backend KVWebhook.id and secret shapes (vendor/openapi.yaml). */
export const KV_WEBHOOK_ID_PATTERN = /^(?:(?:stage|qa|development)_)?kvw_[A-Za-z0-9_-]+$/;
export const KV_WEBHOOK_SECRET_PATTERN = /^srkw_[A-Za-z0-9_-]{43}$/;
/** KVWebhookCreate.key: the K/V key shape. */
const KV_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const KV_WEBHOOK_ID_MAX_BYTES = 200;
export const KV_WEBHOOKS_MAX = 20;
export const KV_WEBHOOK_DESCRIPTION_MAX_BYTES = 200;

/** Backend CardKVWebhookWithSecrets.signing_secret: whsec_ and 43 URL-safe characters. */
export const KV_WEBHOOK_SIGNING_SECRET_PATTERN = /^whsec_[A-Za-z0-9_-]{43}$/;
/** A mapping template is at most 64 KiB (backend docmap.MaxTemplateBytes). */
export const KV_WEBHOOK_MAPPING_MAX_BYTES = 64 * 1024;

/** What a webhook writes: one key of an application, or the data document of a card. */
export type KvWebhookTarget =
  | { kind: "app"; id: string }
  | { kind: "card"; id: string };

/** The flag that names the target in a command the CLI tells the caller to run. */
export function kvWebhookTargetFlag(target: KvWebhookTarget): string {
  return target.kind === "app" ? `--app-id ${target.id}` : `--card ${target.id}`;
}

export function kvWebhooksPath(target: KvWebhookTarget): string {
  const id = encodeURIComponent(target.id);
  return target.kind === "app" ? `/api/applications/${id}/kv-webhooks` : `/api/cards/${id}/kv-webhooks`;
}

export function kvWebhookId(value: string | undefined, command: string, target: KvWebhookTarget): string {
  if (!value) throw usageError(`kv webhook ${command} requires <webhook_id>.`);
  if (Buffer.byteLength(value) > KV_WEBHOOK_ID_MAX_BYTES || !KV_WEBHOOK_ID_PATTERN.test(value)) {
    throw usageError("A K/V webhook id looks like kvw_ followed by letters, digits, - or _.", {
      command: `screenrig kv webhook list ${kvWebhookTargetFlag(target)}`,
      reason: target.kind === "app" ? "List this application's K/V webhooks and their ids." : "List this card's webhooks and their ids.",
    });
  }
  return value;
}

/** A delivery log page is 1 to 100 rows. */
export function kvWebhookDeliveriesLimit(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw usageError("--limit must be a whole number from 1 to 100.");
  return value;
}

/** The mapping template a webhook builds a card's document from: a JSON object of at most 64 KiB. */
export function kvWebhookMapping(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > KV_WEBHOOK_MAPPING_MAX_BYTES) throw usageError("--map is larger than 64 KiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw usageError("--map must hold a JSON object: the template that builds the card's data document.", {
      command: "screenrig kv webhook create --help",
      reason: 'Example template: {"title":"{{body.alert.title}}","body":"{{body.alert.message}}"}.',
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError("--map must be a JSON object: the template that builds the card's data document.");
  }
  return parsed as Record<string, unknown>;
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

export function kvWebhookSecretWarning(id: string, target: KvWebhookTarget, action: "create" | "rotate", signing = false): Warning {
  if (target.kind === "card") return cardWebhookSecretWarning(id, target, action, signing);
  const applicationId = target.id;
  const send = "The sending system posts the key's new value to data.url with the header Authorization: Bearer <data.secret> (or HTTP Basic with data.id as the username and data.secret as the password); the raw body becomes the value and its Content-Type the content type.";
  return {
    code: "kv_webhook_secret_shown_once",
    message: action === "create"
      ? `data.secret is this webhook's secret and is shown only in this answer. Store it in the sending system now; screenrig does not save it in its config, logs, or recovery state. ${send} After an interrupted or ambiguous create, rerun the identical command within 24 hours to get this same answer and secret back. Replace a lost secret with screenrig kv webhook rotate-secret ${id} --app-id ${applicationId}.`
      : `data.secret is the webhook's new secret and is shown only in this answer. The previous secret stopped working: put the new one in the sending system now; screenrig does not save it. ${send} After an interrupted or ambiguous rotation, rerun the identical command within 24 hours to get this same secret back.`,
  };
}

/** Map K/V webhook problems to actionable guidance; exit codes stay status-derived (400 → 8, 404 → 4, 409 → 5). */
export function kvWebhookProblem(error: unknown, target: KvWebhookTarget, id?: string): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  const flag = kvWebhookTargetFlag(target);
  const owner = target.kind === "app" ? "application" : "card";
  if (problem.code === "kv_webhook_limit_reached") {
    return new CliError({
      ...problem,
      detail: `This ${owner} already has the maximum of ${KV_WEBHOOKS_MAX} ${target.kind === "app" ? "K/V webhooks" : "webhooks"}. Nothing was created.`,
      next: problem.next ?? {
        command: `screenrig kv webhook list ${flag}`,
        reason: `Delete a webhook you no longer need with screenrig kv webhook delete ID ${flag}, then rerun create.`,
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.next) return error;
  if (problem.code === "card_not_found") {
    return new CliError({ ...problem, next: { command: "screenrig card list", reason: "Find the card's current ID (crd_...), then rerun with --card." } }, error.exitCode, error.warnings);
  }
  if (problem.code === "not_found") {
    if (target.kind === "card") {
      return new CliError({
        ...problem,
        next: { command: `screenrig kv webhook list ${flag}`, reason: "List this card's webhooks; a deleted webhook does not come back." },
      }, error.exitCode, error.warnings);
    }
    return new CliError({
      ...problem,
      next: id
        ? { command: `screenrig kv webhook list ${flag}`, reason: "List this application's K/V webhooks; a deleted webhook does not come back." }
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

function cardWebhookSecretWarning(id: string, target: KvWebhookTarget, action: "create" | "rotate", signing: boolean): Warning {
  const flag = kvWebhookTargetFlag(target);
  const send = "The sending system posts a JSON or form body to data.url with the header Authorization: Bearer <data.secret> (or HTTP Basic with data.id as the username and data.secret as the password); the webhook's mapping, when it has one, builds the card's document from the body, and the card's own validation decides whether it is shown.";
  return {
    code: "kv_webhook_secret_shown_once",
    message: action === "create"
      ? `data.secret is this webhook's secret${signing ? " and data.signing_secret its signing secret" : ""}, shown only in this answer. Store ${signing ? "them" : "it"} in the sending system now; screenrig does not save ${signing ? "them" : "it"} in its config, logs, or recovery state. ${send} After an interrupted or ambiguous create, rerun the identical command within 24 hours to get this same answer back. Replace a lost secret with screenrig kv webhook rotate-secret ${id} ${flag}.`
      : `data.secret is the webhook's new secret and is shown only in this answer. The previous secret stopped working: put the new one in the sending system now; screenrig does not save it. ${send} After an interrupted or ambiguous rotation, rerun the identical command within 24 hours to get this same secret back.`,
  };
}

/** The signing secret is shown only by the request that issued it; this is the warning that goes with it. */
export function cardWebhookSigningWarning(id: string, target: KvWebhookTarget): Warning {
  return {
    code: "kv_webhook_signing_secret_shown_once",
    message: `data.signing_secret is shown only in this answer. Store it in the sending system now; screenrig does not save it. Every post then carries ScreenRig-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed with the signing secret>, and a post whose timestamp is more than five minutes from the server's clock, or whose signature does not match, is refused like a wrong secret. Replace a lost signing secret with screenrig kv webhook rotate-secret ${id} ${kvWebhookTargetFlag(target)} --signing.`,
  };
}

/** A command an operator can paste to post one JSON document to a card webhook; a signing webhook's example signs the body. */
export function cardWebhookExample(url: string, secret: string | undefined, signing: boolean): string {
  const bearer = secret ? `Bearer ${secret}` : "Bearer <secret>";
  if (!signing) return `curl -X POST "${url}" -H "Authorization: ${bearer}" -H "Content-Type: application/json" --data '{"message":"Hello"}'`;
  return `body='{"message":"Hello"}'; t=$(date +%s); sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" -hex | sed 's/^.* //'); `
    + `curl -X POST "${url}" -H "Authorization: ${bearer}" -H "ScreenRig-Signature: t=$t,v1=$sig" -H "Content-Type: application/json" --data "$body"`;
}

function mappingSummary(webhook: CardKVWebhook): string {
  return webhook.mapping === null || webhook.mapping === undefined ? "(none: the posted object is the document)" : `${Object.keys(webhook.mapping).length} top-level member${Object.keys(webhook.mapping).length === 1 ? "" : "s"}`;
}

/** Every field except the secrets, which only create, update and rotate-secret print under their own labels. */
export function cardWebhookLines(webhook: CardKVWebhook | undefined): string[] {
  if (!webhook) return [];
  return [
    `id: ${webhook.id}`,
    `card_id: ${webhook.card_id}`,
    ...when(webhook.description, "description"),
    `mapping: ${mappingSummary(webhook)}`,
    `enabled: ${webhook.enabled}`,
    `signing: ${webhook.signing}`,
    `url: ${webhook.url}`,
    ...when(webhook.created_at, "created_at"),
    ...when(webhook.last_used_at, "last_used_at"),
  ];
}

export function cardWebhookTableLines(items: CardKVWebhook[]): string[] {
  if (!items.length) return ["No card webhooks"];
  return table(["ID", "ENABLED", "SIGNING", "MAPPING", "LAST_USED", "URL", "DESCRIPTION"], items.map((item) => [
    item.id ?? "", String(item.enabled), String(item.signing), item.mapping === null || item.mapping === undefined ? "no" : "yes",
    item.last_used_at ?? "-", item.url ?? "", item.description ?? "",
  ]));
}

export function kvWebhookDeliveryTableLines(items: KVWebhookDelivery[]): string[] {
  if (!items.length) return ["No deliveries in the last seven days"];
  return table(["AT", "OUTCOME", "REASON", "STATUS", "BYTES", "REVISION", "DETAIL"], items.map((item) => [
    item.at ?? "", item.outcome ?? "", item.reason ?? "-", String(item.status ?? ""), String(item.bytes ?? ""),
    item.revision === undefined ? "-" : String(item.revision), item.detail ?? "",
  ]));
}
