// Command handlers for the webhooks commands, loaded on demand.
import { WEBHOOK_ID_PATTERN, deliveryTableLines, webhookDeliveriesLimit, webhookDeliveryCursor, webhookDescription, webhookEventTypes, webhookId, webhookLines, webhookProblem, webhookSecretWarning, webhookTableLines, webhookUrl } from "../webhooks.js";
import { type Webhook, type WebhookDelivery, type WebhookDeliveryList, type WebhookList, type WebhookPatch, type WebhookWithSecret, type WebhookWrite } from "../adapters/protocol.js";
import { flagBool, flagString } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, makeProblem, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { clientFor, commandHandler, humanLines, jsonBody, webhookRevisionHeaders, writeRecoveries, type CommandResult } from "../commands.js";


// Customer webhooks: /api/webhooks. The signing secret is printed once in
// data.secret (create, rotate-secret) and never reaches config, logs, or the
// write-recovery ledger; an identical rerun after an ambiguous failure reuses
// the saved Idempotency-Key and the server replays the same secret for 24 h.
export const WEBHOOKS_PATH = "/api/webhooks";

export async function webhookCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw webhookProblem(error, id);
  }
}

/**
 * A 2xx without a secret is a completed write: a replay of the same key would
 * return the same secretless answer, so clear the saved key and point at
 * rotate-secret instead of suggesting a rerun.
 */
export async function webhookWithSecret(body: unknown, action: "create" | "rotate", runtime: CliRuntime): Promise<WebhookWithSecret> {
  const webhook = body as WebhookWithSecret | undefined;
  if (!webhook || typeof webhook.id !== "string" || typeof webhook.secret !== "string" || !webhook.secret) {
    await writeRecoveries.get(runtime)?.finish();
    const id = webhook && typeof webhook.id === "string" && WEBHOOK_ID_PATTERN.test(webhook.id) ? webhook.id : undefined;
    throw new CliError(makeProblem("unexpected_response", "Unexpected response", 502,
      `The ${action === "create" ? "webhook create" : "rotate-secret"} request completed, but its answer did not carry a signing secret. Do not rerun it.`, {
        next: id
          ? { command: `screenrig webhooks rotate-secret ${id}`, reason: "Issue a new signing secret; it is shown once in data.secret." }
          : { command: "screenrig webhooks list", reason: "Find the webhook, then run screenrig webhooks rotate-secret ID to receive a new signing secret." },
      }), ExitCode.Unexpected);
  }
  return webhook;
}

export async function webhookSecretResult(response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, action: "create" | "rotate", runtime: CliRuntime): Promise<CommandResult> {
  const webhook = await webhookWithSecret(response.body, action, runtime);
  const warning = webhookSecretWarning(webhook.id, action);
  return {
    envelope: jsonBody(response, client.requestId, undefined, [warning]),
    exitCode: ExitCode.Success,
    human: [
      action === "create" ? `Created webhook ${webhook.id}` : `Rotated the signing secret of webhook ${webhook.id}`,
      ...webhookLines(webhook),
      `secret: ${webhook.secret}`,
      `warning: ${warning.message}`,
    ].join("\n"),
    keepRecoveryUntilOutput: true,
  };
}

export const handleWebhooksCreate = commandHandler(async (args, runtime, resolved) => {
  const url = webhookUrl(flagString(args.flags, "url") ?? "");
  const eventTypes = webhookEventTypes(flagString(args.flags, "event-types") ?? "");
  const description = flagString(args.flags, "description");
  const body: WebhookWrite = {
    url,
    event_types: eventTypes,
    ...(flagBool(args.flags, "disabled") ? { enabled: false } : {}),
    ...(description !== undefined ? { description: webhookDescription(description) } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, { method: "POST", path: WEBHOOKS_PATH, idempotent: true, body });
  return webhookSecretResult(response, client, "create", runtime);
});

export const handleWebhooksList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, { method: "GET", path: WEBHOOKS_PATH });
  const items = (response.body as WebhookList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Webhooks (${list.length})`, ...webhookTableLines(list)].join("\n"),
  };
});

export const handleWebhooksShow = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, { method: "GET", path: `${WEBHOOKS_PATH}/${id}` }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Webhook", ...webhookLines(response.body as Webhook | undefined)].join("\n"),
  };
});

export const handleWebhooksUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "update");
  const url = flagString(args.flags, "url");
  const eventTypes = flagString(args.flags, "event-types");
  const description = flagString(args.flags, "description");
  const patch: WebhookPatch = {
    ...(url !== undefined ? { url: webhookUrl(url) } : {}),
    ...(eventTypes !== undefined ? { event_types: webhookEventTypes(eventTypes) } : {}),
    ...(description !== undefined ? { description: webhookDescription(description) } : {}),
    ...(flagBool(args.flags, "clear-description") ? { description: "" } : {}),
    ...(flagBool(args.flags, "enable") ? { enabled: true } : {}),
    ...(flagBool(args.flags, "disable") ? { enabled: false } : {}),
  };
  if (!Object.keys(patch).length) {
    throw usageError("webhooks update requires at least one of --url, --event-types, --description, --clear-description, --enable, or --disable.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, {
    method: "PATCH", path: `${WEBHOOKS_PATH}/${id}`, idempotent: true, body: patch, headers: webhookRevisionHeaders(args),
  }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated webhook ${id}`, ...webhookLines(response.body as Webhook | undefined)].join("\n"),
  };
});

export const handleWebhooksDelete = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, {
    method: "DELETE", path: `${WEBHOOKS_PATH}/${id}`, idempotent: true, headers: webhookRevisionHeaders(args),
  }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted webhook ${id}. Its pending deliveries fail with webhook_deleted.`,
  };
});

export const handleWebhooksRotateSecret = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "rotate-secret");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, {
    method: "POST", path: `${WEBHOOKS_PATH}/${id}/rotate-secret`, idempotent: true, headers: webhookRevisionHeaders(args),
  }, id);
  return webhookSecretResult(response, client, "rotate", runtime);
});

export const handleWebhooksTest = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "test");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, { method: "POST", path: `${WEBHOOKS_PATH}/${id}/test`, idempotent: true }, id);
  const delivery = response.body as WebhookDelivery | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines(`Queued a test delivery to webhook ${id}`, [
      ["delivery_id", delivery?.id],
      ["event_type", delivery?.event_type],
      ["event_id", delivery?.event_id],
      ["state", delivery?.state],
      ["next", `screenrig webhooks deliveries ${id} --limit 1 shows its outcome; a test is attempted once, without retries.`],
    ]),
  };
});

export const handleWebhooksDeliveries = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "deliveries");
  const before = flagString(args.flags, "before");
  const limit = flagString(args.flags, "limit");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, {
    method: "GET", path: `${WEBHOOKS_PATH}/${id}/deliveries`,
    query: {
      ...(before !== undefined ? { before: webhookDeliveryCursor(before) } : {}),
      ...(limit !== undefined ? { limit: webhookDeliveriesLimit(limit) } : {}),
    },
  }, id);
  const page = response.body as WebhookDeliveryList | undefined;
  const items = Array.isArray(page?.items) ? page.items : [];
  const next = typeof page?.next_cursor === "string" ? page.next_cursor : undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      `Webhook ${id} deliveries (${items.length})`,
      ...deliveryTableLines(items),
      ...(next ? [`next: screenrig webhooks deliveries ${id} --before ${next}${limit ? ` --limit ${limit}` : ""}`] : []),
    ].join("\n"),
  };
});
