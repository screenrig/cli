// Command handlers for the notifications commands, loaded on demand.
import { webhookDeliveriesLimit, webhookDescription, webhookEventTypes, webhookUrl } from "../webhooks.js";
import { NOTIFICATION_CHAT_CHANNELS, NOTIFICATION_ID_PATTERN, notificationConditions, notificationDeliveryCursor, notificationDeliveryTableLines, notificationDestination, notificationHold, notificationId, notificationLines, notificationProblem, notificationRecipients, notificationUserId, notificationSecretWarning, notificationTableLines, snoozedUntil } from "../notifications.js";
import { type Notification, type NotificationDelivery, type NotificationDeliveryList, type NotificationList, type NotificationPatch, type NotificationWithSecret, type NotificationWrite } from "../adapters/protocol.js";
import { flagBool, flagString } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, makeProblem, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { clientFor, commandHandler, humanLines, jsonBody, webhookRevisionHeaders, writeRecoveries, type CommandResult } from "../commands.js";


// Notifications: /api/notifications, email, webhook, Slack, Teams, PagerDuty
// and Telegram channels. A webhook's signing secret is printed once in
// data.secret (create, rotate-secret) and never reaches config, logs, or the
// write-recovery ledger, as for webhooks; the other channels have no secret. A
// chat or pager credential (destination) is only ever sent, never printed back:
// the notification shows a masked destination_hint. Every channel shares the
// 20-per-project limit and the revision guard (webhookRevisionHeaders).
export const NOTIFICATIONS_PATH = "/api/notifications";

export async function notificationCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw notificationProblem(error, id);
  }
}

/**
 * A 2xx without a secret is a completed write: a replay of the same key would
 * return the same secretless answer, so clear the saved key and point at
 * rotate-secret instead of suggesting a rerun.
 */
export async function notificationWithSecret(body: unknown, action: "create" | "rotate", runtime: CliRuntime): Promise<NotificationWithSecret> {
  const notification = body as NotificationWithSecret | undefined;
  if (!notification || typeof notification.id !== "string" || typeof notification.secret !== "string" || !notification.secret) {
    await writeRecoveries.get(runtime)?.finish();
    const id = notification && typeof notification.id === "string" && NOTIFICATION_ID_PATTERN.test(notification.id) ? notification.id : undefined;
    throw new CliError(makeProblem("unexpected_response", "Unexpected response", 502,
      `The ${action === "create" ? "notifications create" : "rotate-secret"} request completed, but its answer did not carry a signing secret. Do not rerun it.`, {
        next: id
          ? { command: `screenrig notifications rotate-secret ${id}`, reason: "Issue a new signing secret; it is shown once in data.secret." }
          : { command: "screenrig notifications list", reason: "Find the notification, then run screenrig notifications rotate-secret ID to receive a new signing secret." },
      }), ExitCode.Unexpected);
  }
  return notification;
}

export async function notificationSecretResult(response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, action: "create" | "rotate", runtime: CliRuntime): Promise<CommandResult> {
  const notification = await notificationWithSecret(response.body, action, runtime);
  const warning = notificationSecretWarning(notification.id, action);
  return {
    envelope: jsonBody(response, client.requestId, undefined, [warning]),
    exitCode: ExitCode.Success,
    human: [
      action === "create" ? `Created notification ${notification.id}` : `Rotated the signing secret of notification ${notification.id}`,
      ...notificationLines(notification),
      `secret: ${notification.secret}`,
      `warning: ${warning.message}`,
    ].join("\n"),
    keepRecoveryUntilOutput: true,
  };
}

export const handleNotificationsCreate = commandHandler(async (args, runtime, resolved) => {
  const email = flagString(args.flags, "email");
  const webhook = flagString(args.flags, "webhook");
  const chat = NOTIFICATION_CHAT_CHANNELS.flatMap(({ channel, flag }) => {
    const value = flagString(args.flags, flag);
    return value === undefined ? [] : [{ channel, flag: `--${flag}`, value }];
  });
  if ((email === undefined ? 0 : 1) + (webhook === undefined ? 0 : 1) + chat.length !== 1) {
    throw usageError("notifications create requires exactly one of --email, --webhook, --slack, --teams, --pagerduty or --telegram.");
  }
  const telegramChat = flagString(args.flags, "telegram-chat");
  if ((chat[0]?.channel === "telegram") !== (telegramChat !== undefined)) {
    throw usageError("--telegram and --telegram-chat go together: the bot token and the chat it posts to.");
  }
  const conditions = flagString(args.flags, "conditions");
  const events = flagString(args.flags, "events");
  const tags = flagString(args.flags, "tag");
  const hold = flagString(args.flags, "hold");
  const description = flagString(args.flags, "description");
  const body: NotificationWrite = {
    channel: email !== undefined ? "email" : webhook !== undefined ? "webhook" : chat[0]!.channel,
    ...(email !== undefined ? { recipients: notificationRecipients(email) } : {}),
    ...(webhook !== undefined ? { url: webhookUrl(webhook, "--webhook") } : {}),
    ...(chat.length ? { destination: await notificationDestination(chat[0]!.value, chat[0]!.flag, runtime) } : {}),
    ...(telegramChat !== undefined ? { telegram_chat_id: telegramChat } : {}),
    ...(conditions !== undefined ? { conditions: notificationConditions(conditions) } : {}),
    ...(events !== undefined ? { event_types: webhookEventTypes(events, "--events") } : {}),
    ...(tags !== undefined ? { screen_tags: tags.split(",") } : {}),
    ...(hold !== undefined ? { hold_minutes: Number(notificationHold(hold)) } : {}),
    ...(description !== undefined ? { description: webhookDescription(description) } : {}),
    ...(flagBool(args.flags, "disabled") ? { enabled: false } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, { method: "POST", path: NOTIFICATIONS_PATH, idempotent: true, body });
  if (body.channel === "webhook") return notificationSecretResult(response, client, "create", runtime);
  const created = response.body as Notification | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Created notification ${created?.id ?? ""}`.trimEnd(), ...notificationLines(created)].join("\n"),
  };
});

export const handleNotificationsList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, { method: "GET", path: NOTIFICATIONS_PATH });
  const items = (response.body as NotificationList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Notifications (${list.length})`, ...notificationTableLines(list)].join("\n"),
  };
});

export const handleNotificationsShow = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, { method: "GET", path: `${NOTIFICATIONS_PATH}/${id}` }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Notification", ...notificationLines(response.body as Notification | undefined)].join("\n"),
  };
});

export const handleNotificationsUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "update");
  const email = flagString(args.flags, "email");
  const url = flagString(args.flags, "url");
  const destination = flagString(args.flags, "destination");
  const telegramChat = flagString(args.flags, "telegram-chat");
  const conditions = flagString(args.flags, "conditions");
  const events = flagString(args.flags, "events");
  const tags = flagString(args.flags, "tag");
  const hold = flagString(args.flags, "hold");
  const description = flagString(args.flags, "description");
  const snooze = flagString(args.flags, "snooze");
  const patch: NotificationPatch = {
    ...(email !== undefined ? { recipients: notificationRecipients(email) } : {}),
    ...(url !== undefined ? { url: webhookUrl(url) } : {}),
    ...(destination !== undefined ? { destination: await notificationDestination(destination, "--destination", runtime) } : {}),
    ...(telegramChat !== undefined ? { telegram_chat_id: telegramChat } : {}),
    ...(conditions !== undefined ? { conditions: notificationConditions(conditions) } : {}),
    ...(flagBool(args.flags, "clear-conditions") ? { conditions: [] } : {}),
    ...(events !== undefined ? { event_types: webhookEventTypes(events, "--events") } : {}),
    ...(flagBool(args.flags, "clear-events") ? { event_types: [] } : {}),
    ...(tags !== undefined ? { screen_tags: tags.split(",") } : {}),
    ...(flagBool(args.flags, "all-screens") ? { screen_tags: [] } : {}),
    ...(hold !== undefined ? { hold_minutes: Number(notificationHold(hold)) } : {}),
    ...(description !== undefined ? { description: webhookDescription(description) } : {}),
    ...(flagBool(args.flags, "clear-description") ? { description: "" } : {}),
    ...(flagBool(args.flags, "enable") ? { enabled: true } : {}),
    ...(flagBool(args.flags, "disable") ? { enabled: false } : {}),
    ...(snooze !== undefined ? { snoozed_until: snoozedUntil(snooze, runtime.now()) } : {}),
  };
  if (!Object.keys(patch).length) {
    throw usageError("notifications update requires at least one change: --email, --url, --destination, --telegram-chat, --conditions, --clear-conditions, --events, --clear-events, --tag, --all-screens, --hold, --description, --clear-description, --enable, --disable, or --snooze.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // --snooze derives its instant from the clock, so a rerun fingerprints
  // differently; drop the obsolete saved key instead of leaving it behind.
  const response = await notificationCall(client, {
    method: "PATCH", path: `${NOTIFICATIONS_PATH}/${id}`, idempotent: true, body: patch, headers: webhookRevisionHeaders(args),
    ...(snooze !== undefined ? { recoverySupersede: JSON.stringify(["notifications update --snooze", id]) } : {}),
  }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated notification ${id}`, ...notificationLines(response.body as Notification | undefined)].join("\n"),
  };
});

export const handleNotificationsDelete = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, {
    method: "DELETE", path: `${NOTIFICATIONS_PATH}/${id}`, idempotent: true, headers: webhookRevisionHeaders(args),
  }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted notification ${id}. Its pending notices fail with webhook_deleted and its delivery log is no longer addressable.`,
  };
});

export const handleNotificationsRotateSecret = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "rotate-secret");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, {
    method: "POST", path: `${NOTIFICATIONS_PATH}/${id}/rotate-secret`, idempotent: true, headers: webhookRevisionHeaders(args),
  }, id);
  return notificationSecretResult(response, client, "rotate", runtime);
});

export const handleNotificationsTest = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "test");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, { method: "POST", path: `${NOTIFICATIONS_PATH}/${id}/test`, idempotent: true }, id);
  const delivery = response.body as NotificationDelivery | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines(`Queued a test delivery to notification ${id}`, [
      ["delivery_id", delivery?.id],
      ["event_type", delivery?.event_type],
      ["event_id", delivery?.event_id],
      ["state", delivery?.state],
      ["next", `screenrig notifications deliveries ${id} --limit 1 shows its outcome; a test is attempted once, without retries.`],
    ]),
  };
});

export const handleNotificationsResubscribe = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "resubscribe");
  const user = notificationUserId(flagString(args.flags, "user") ?? "");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, {
    method: "DELETE", path: `${NOTIFICATIONS_PATH}/${id}/unsubscribed/${encodeURIComponent(user)}`, idempotent: true,
  }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Notification ${id} emails ${user} again, if they had unsubscribed.`, ...notificationLines(response.body as Notification | undefined)].join("\n"),
  };
});

export const handleNotificationsDeliveries = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "deliveries");
  const before = flagString(args.flags, "before");
  const limit = flagString(args.flags, "limit");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, {
    method: "GET", path: `${NOTIFICATIONS_PATH}/${id}/deliveries`,
    query: {
      ...(before !== undefined ? { before: notificationDeliveryCursor(before) } : {}),
      ...(limit !== undefined ? { limit: webhookDeliveriesLimit(limit) } : {}),
    },
  }, id);
  const page = response.body as NotificationDeliveryList | undefined;
  const items = Array.isArray(page?.items) ? page.items : [];
  const next = typeof page?.next_cursor === "string" ? page.next_cursor : undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      `Notification ${id} deliveries (${items.length})`,
      ...notificationDeliveryTableLines(items),
      ...(next ? [`next: screenrig notifications deliveries ${id} --before ${next}${limit ? ` --limit ${limit}` : ""}`] : []),
    ].join("\n"),
  };
});
