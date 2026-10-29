// Command handlers for the kv commands, loaded on demand.
import { readAuthoringText } from "../authoring-input.js";
import { KV_WEBHOOK_ID_PATTERN, KV_WEBHOOK_MAPPING_MAX_BYTES, KV_WEBHOOK_SECRET_PATTERN, KV_WEBHOOK_SIGNING_SECRET_PATTERN, type KvWebhookTarget, cardWebhookExample, cardWebhookLines, cardWebhookSigningWarning, cardWebhookTableLines, kvWebhookDeliveryTableLines, kvWebhookDescription, kvWebhookExample, kvWebhookId, kvWebhookKey, kvWebhookLines, kvWebhookMapping, kvWebhookProblem, kvWebhookSecretWarning, kvWebhookTableLines, kvWebhookTargetFlag, kvWebhooksPath } from "../kv-webhooks.js";
import { type KVEntry, type CardKVWebhook, type CardKVWebhookCreate, type CardKVWebhookList, type CardKVWebhookUpdate, type CardKVWebhookWithSecrets, type KVWebhook, type KVWebhookCreate, type KVWebhookDeliveryList, type KVWebhookList, type KVWebhookWithSecret } from "../adapters/protocol.js";
import { flagBool, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { successEnvelope, type Warning } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, makeProblem, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { kvWriteFromArgs } from "../kv-write.js";
import { quotedRevision } from "../if-match.js";
import { cardUid } from "../cards.js";
import { clientFor, commandHandler, humanLines, jsonBody, simpleGet, simpleList, writeRecoveries, type CommandResult } from "../commands.js";


export const handleKvList = commandHandler(async (args, runtime, resolved) => {
  const applicationId = flagString(args.flags, "app-id");
  if (!applicationId) throw usageError("kv commands require --app-id.");
  const key = args.positionals[2];

  return simpleList(args, runtime, resolved, `/api/applications/${applicationId}/kv`, "K/V");
}, true);

export const handleKvGet = commandHandler(async (args, runtime, resolved) => {
  const applicationId = flagString(args.flags, "app-id");
  if (!applicationId) throw usageError("kv commands require --app-id.");
  const key = args.positionals[2];

  if (!key) throw usageError("kv get requires a key.");
  return simpleGet(args, runtime, resolved, `/api/applications/${applicationId}/kv/${encodeURIComponent(key)}`, "K/V");
}, true);

export const handleKvSet = commandHandler(async (args, runtime, resolved) => {
  const applicationId = flagString(args.flags, "app-id");
  if (!applicationId) throw usageError("kv commands require --app-id.");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const key = args.positionals[2];

  if (!key) throw usageError("kv set requires a key.");
  const body = await kvWriteFromArgs(args, runtime.cwd(), runtime);
  const revision = flagString(args.flags, "expect-rev");
  const response = await client.call({
    method: "PUT",
    path: `/api/applications/${applicationId}/kv/${encodeURIComponent(key)}`,
    idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
    body,
  });
  const entry = response.body as KVEntry;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("K/V value set", [
      ["key", entry.key],
      ["content_type", entry.content_type],
      ["bytes", String(entry.bytes)],
      ["sha256", entry.sha256],
      ["revision", String(entry.revision)],
    ]),
  };
}, true);

export const handleKvDelete = commandHandler(async (args, runtime, resolved) => {
  const applicationId = flagString(args.flags, "app-id");
  if (!applicationId) throw usageError("kv commands require --app-id.");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const key = args.positionals[2];

  if (!key) throw usageError("kv delete requires a key.");
  const ifMatch = flagString(args.flags, "expect-rev");
  const response = await client.call({
    method: "DELETE",
    path: `/api/applications/${applicationId}/kv/${encodeURIComponent(key)}`,
    idempotent: true,
    headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted ${key}` };
}, true);

// Incoming K/V webhooks: /api/applications/{id}/kv-webhooks write one key of
// an application, /api/cards/{id}/kv-webhooks write a card's data document. url
// is not secret; the secrets are returned only by create, rotate-secret and the
// update that turns signing on, printed once, and kept out of the operation log
// (client.ts privateBodies).
export function kvWebhookTarget(args: ParsedArgs, command: string): KvWebhookTarget {
  const applicationId = flagString(args.flags, "app-id");
  const card = flagString(args.flags, "card");
  if (applicationId && card) throw usageError("Pass --app-id or --card, not both.");
  if (card) return { kind: "card", id: cardUid(card) };
  if (!applicationId) throw usageError(`kv webhook ${command} requires --app-id (a key of an application) or --card (a card's data document).`);
  return { kind: "app", id: applicationId };
}

export async function kvWebhookCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  target: KvWebhookTarget,
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw kvWebhookProblem(error, target, id);
  }
}

export async function kvWebhookWithSecret(body: unknown, action: "create" | "rotate", target: KvWebhookTarget, runtime: CliRuntime, signing = false): Promise<KVWebhookWithSecret | CardKVWebhookWithSecrets> {
  const webhook = body as (KVWebhookWithSecret | CardKVWebhookWithSecrets) | undefined;
  const secret = webhook?.secret;
  const signingSecret = (webhook as CardKVWebhookWithSecrets | undefined)?.signing_secret;
  const secretOk = typeof secret === "string" && KV_WEBHOOK_SECRET_PATTERN.test(secret);
  const signingOk = signingSecret === undefined ? !signing : KV_WEBHOOK_SIGNING_SECRET_PATTERN.test(signingSecret);
  // A signing rotation answers the signing secret alone; every other create or
  // rotation answers the webhook secret.
  const shapeOk = signing && action === "rotate" ? typeof signingSecret === "string" && signingOk : secretOk && signingOk;
  if (!webhook || typeof webhook.id !== "string" || !shapeOk) {
    await writeRecoveries.get(runtime)?.finish();
    const id = webhook && typeof webhook.id === "string" && KV_WEBHOOK_ID_PATTERN.test(webhook.id) ? webhook.id : undefined;
    const flag = kvWebhookTargetFlag(target);
    throw new CliError(makeProblem("unexpected_response", "Unexpected response", 502,
      `The ${action === "create" ? "kv webhook create" : "rotate-secret"} request completed, but its answer did not carry a secret. Do not rerun it.`, {
        next: id
          ? { command: `screenrig kv webhook rotate-secret ${id} ${flag}${signing ? " --signing" : ""}`, reason: "Issue a new secret; it is shown once in the answer." }
          : { command: `screenrig kv webhook list ${flag}`, reason: "Find the webhook, then run screenrig kv webhook rotate-secret ID to receive a new secret." },
      }), ExitCode.Unexpected);
  }
  return webhook;
}

export async function kvWebhookSecretResult(
  response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, action: "create" | "rotate", target: KvWebhookTarget, runtime: CliRuntime, signing = false,
): Promise<CommandResult> {
  const webhook = await kvWebhookWithSecret(response.body, action, target, runtime, signing);
  if (target.kind === "card") return cardWebhookSecretResult(response, client, webhook as CardKVWebhookWithSecrets, action, target, signing);
  const secretWebhook = webhook as KVWebhookWithSecret;
  const warning = kvWebhookSecretWarning(webhook.id, target, action);
  return {
    envelope: jsonBody(response, client.requestId, undefined, [warning]),
    exitCode: ExitCode.Success,
    human: [
      action === "create" ? `Created K/V webhook ${webhook.id}` : `Rotated the secret of K/V webhook ${webhook.id}`,
      ...kvWebhookLines(webhook as KVWebhookWithSecret),
      "",
      "Sensitive webhook secret (store it only in the system that posts to the url above)",
      `secret: ${secretWebhook.secret}`,
      `example: ${kvWebhookExample(webhook.url, secretWebhook.secret)}`,
      `warning: ${warning.message}`,
    ].join("\n"),
    keepRecoveryUntilOutput: true,
  };
}

/** The answer of a card webhook request that issued a secret, a signing secret, or both. */
export function cardWebhookSecretResult(
  response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, webhook: CardKVWebhookWithSecrets,
  action: "create" | "rotate" | "update", target: KvWebhookTarget, signingRotation = false,
): CommandResult {
  const warnings: Warning[] = [];
  if (webhook.secret) warnings.push(kvWebhookSecretWarning(webhook.id, target, action === "update" ? "create" : action, Boolean(webhook.signing_secret)));
  if (webhook.signing_secret) warnings.push(cardWebhookSigningWarning(webhook.id, target));
  const title = action === "create" ? `Created card webhook ${webhook.id}`
    : action === "update" ? `Updated card webhook ${webhook.id}`
    : signingRotation ? `Rotated the signing secret of card webhook ${webhook.id}` : `Rotated the secret of card webhook ${webhook.id}`;
  const lines = [title, ...cardWebhookLines(webhook)];
  if (webhook.secret || webhook.signing_secret) {
    lines.push("", "Sensitive webhook secrets (store them only in the system that posts to the url above)");
    if (webhook.secret) lines.push(`secret: ${webhook.secret}`);
    if (webhook.signing_secret) lines.push(`signing_secret: ${webhook.signing_secret}`);
    lines.push(`example: ${cardWebhookExample(webhook.url, webhook.secret, webhook.signing)}`);
    for (const warning of warnings) lines.push(`warning: ${warning.message}`);
  }
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings.length ? warnings : undefined),
    exitCode: ExitCode.Success,
    human: lines.join("\n"),
    ...(webhook.secret || webhook.signing_secret ? { keepRecoveryUntilOutput: true } : {}),
  };
}

export const handleKvWebhookCreate = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "create");
  const description = flagString(args.flags, "description");
  const key = args.positionals[3];
  let body: KVWebhookCreate | CardKVWebhookCreate;
  if (target.kind === "app") {
    if (flagString(args.flags, "map") !== undefined || flagBool(args.flags, "signing")) {
      throw usageError("--map and --signing apply to a card webhook: pass --card CARD_ID instead of --app-id.");
    }
    body = { key: kvWebhookKey(key), ...(description !== undefined ? { description: kvWebhookDescription(description) } : {}) };
  } else {
    if (key !== undefined) throw usageError("A card webhook writes the card's data document, not a key: omit <key>.");
    const map = flagString(args.flags, "map");
    body = {
      ...(description !== undefined ? { description: kvWebhookDescription(description) } : {}),
      ...(map !== undefined ? { mapping: kvWebhookMapping(await readAuthoringText(map, runtime, KV_WEBHOOK_MAPPING_MAX_BYTES)) } : {}),
      ...(flagBool(args.flags, "signing") ? { signing: true } : {}),
    };
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, { method: "POST", path: kvWebhooksPath(target), idempotent: true, body }, target);
  return kvWebhookSecretResult(response, client, "create", target, runtime, target.kind === "card" && flagBool(args.flags, "signing"));
}, true);

export const handleKvWebhookList = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "list");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, { method: "GET", path: kvWebhooksPath(target) }, target);
  const items = (response.body as KVWebhookList | CardKVWebhookList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: target.kind === "card"
      ? [`Card webhooks (${list.length})`, ...cardWebhookTableLines(list as CardKVWebhook[])].join("\n")
      : [`K/V webhooks (${list.length})`, ...kvWebhookTableLines(list as KVWebhook[])].join("\n"),
  };
}, true);

export const handleKvWebhookRotateSecret = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "rotate-secret");
  const id = kvWebhookId(args.positionals[3], "rotate-secret", target);
  const signing = flagBool(args.flags, "signing");
  if (signing && target.kind === "app") throw usageError("--signing rotates a card webhook's signing secret: pass --card CARD_ID.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, {
    method: "POST", path: `${kvWebhooksPath(target)}/${id}/rotate-secret`, idempotent: true,
    ...(signing ? { body: { signing: true } } : {}),
  }, target, id);
  return kvWebhookSecretResult(response, client, "rotate", target, runtime, signing);
}, true);

export const handleKvWebhookUpdate = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "update");
  if (target.kind !== "card") throw usageError("kv webhook update changes a card webhook: pass --card CARD_ID.");
  const id = kvWebhookId(args.positionals[3], "update", target);
  const description = flagString(args.flags, "description");
  const map = flagString(args.flags, "map");
  const body: CardKVWebhookUpdate = {
    ...(description !== undefined ? { description: kvWebhookDescription(description) } : {}),
    ...(map !== undefined ? { mapping: kvWebhookMapping(await readAuthoringText(map, runtime, KV_WEBHOOK_MAPPING_MAX_BYTES)) } : {}),
    ...(flagBool(args.flags, "clear-map") ? { mapping: null } : {}),
    ...(flagBool(args.flags, "enable") ? { enabled: true } : {}),
    ...(flagBool(args.flags, "disable") ? { enabled: false } : {}),
    ...(flagBool(args.flags, "signing") ? { signing: true } : {}),
    ...(flagBool(args.flags, "no-signing") ? { signing: false } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, { method: "PATCH", path: `${kvWebhooksPath(target)}/${id}`, idempotent: true, body }, target, id);
  return cardWebhookSecretResult(response, client, response.body as CardKVWebhookWithSecrets, "update", target);
}, true);

export const handleKvWebhookDeliveries = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "deliveries");
  if (target.kind !== "card") throw usageError("kv webhook deliveries reads a card webhook's log: pass --card CARD_ID.");
  const id = kvWebhookId(args.positionals[3], "deliveries", target);
  const limit = flagString(args.flags, "limit");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, {
    method: "GET", path: `${kvWebhooksPath(target)}/${id}/deliveries`, ...(limit ? { query: { limit } } : {}),
  }, target, id);
  const items = (response.body as KVWebhookDeliveryList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Deliveries of ${id} (${list.length})`, ...kvWebhookDeliveryTableLines(list)].join("\n"),
  };
}, true);

export const handleKvWebhookDelete = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "delete");
  const id = kvWebhookId(args.positionals[3], "delete", target);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, {
    method: "DELETE", path: `${kvWebhooksPath(target)}/${id}`, idempotent: true,
  }, target, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: target.kind === "card"
      ? `Deleted card webhook ${id}. Its URL stopped working; the card keeps its document.`
      : `Deleted K/V webhook ${id}. Its URL stopped working; the key it wrote keeps its value.`,
  };
}, true);
