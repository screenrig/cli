// Command handlers for the alerts commands, loaded on demand.
import { alertEnd, alertId, alertMuteId, alertMuteLines, alertMuteTableLines, alertNote, alertProblem, alertScreenId, alertsCursor, alertsLimit, screenAlertLines, screenAlertListLines } from "../alerts.js";
import { type Alert, type AlertAcknowledge, type AlertList, type AlertMute, type AlertMuteList, type AlertMuteWrite } from "../adapters/protocol.js";
import { flagString } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import { clientFor, commandHandler, jsonBody, reportFileOf } from "../commands.js";


// Alerts: /api/alerts, one screen's condition while it lasts (acknowledge or
// snooze it while it is open), and /api/alert-mutes, screens muted for
// maintenance. Nothing here is secret. A snooze or mute made with --for derives
// its instant from the clock, so a rerun fingerprints differently; the obsolete
// saved key is superseded instead of left behind, as for notifications update
// --snooze.
export const ALERTS_PATH = "/api/alerts";
export const ALERT_MUTES_PATH = "/api/alert-mutes";

export async function alertCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw alertProblem(error, id);
  }
}

export const handleAlertsList = commandHandler(async (args, runtime, resolved) => {
  const state = flagString(args.flags, "state");
  const screenId = flagString(args.flags, "screen-id");
  const before = flagString(args.flags, "before");
  const limit = flagString(args.flags, "limit");
  const alertQuery = {
    ...(state !== undefined ? { state } : {}),
    ...(screenId !== undefined ? { screen_id: alertScreenId(screenId) } : {}),
    ...(before !== undefined ? { before: alertsCursor(before) } : {}),
    ...(limit !== undefined ? { limit: alertsLimit(limit) } : {}),
  };
  const file = await reportFileOf(args, runtime, resolved, ALERTS_PATH, alertQuery, "alerts", "alerts");
  if (file) return file;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, {
    method: "GET", path: ALERTS_PATH,
    query: alertQuery,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenAlertListLines(response.body as AlertList | undefined, runtime.now(), { state, screenId, limit }).join("\n"),
  };
});

export const handleAlertsShow = commandHandler(async (args, runtime, resolved) => {
  const id = alertId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, { method: "GET", path: `${ALERTS_PATH}/${id}` }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Alert", ...screenAlertLines(response.body as Alert | undefined, runtime.now())].join("\n"),
  };
});

export const handleAlertsAck = commandHandler(async (args, runtime, resolved) => {
  const id = alertId(args.positionals[2], "ack");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, { method: "POST", path: `${ALERTS_PATH}/${id}/acknowledge`, idempotent: true }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Acknowledged alert ${id}. It stays acknowledged until it resolves.`, ...screenAlertLines(response.body as Alert | undefined, runtime.now())].join("\n"),
  };
});

export const handleAlertsSnooze = commandHandler(async (args, runtime, resolved) => {
  const id = alertId(args.positionals[2], "snooze");
  const forValue = flagString(args.flags, "for");
  const until = alertEnd(forValue, flagString(args.flags, "until"), runtime.now());
  const body: AlertAcknowledge = { until };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, {
    method: "POST", path: `${ALERTS_PATH}/${id}/acknowledge`, idempotent: true, body,
    ...(forValue !== undefined ? { recoverySupersede: JSON.stringify(["alerts snooze", id]) } : {}),
  }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Snoozed alert ${id} until ${until}. It needs attention again then if it is still open.`, ...screenAlertLines(response.body as Alert | undefined, runtime.now())].join("\n"),
  };
});

export const handleAlertsMute = commandHandler(async (args, runtime, resolved) => {
  const screenIds = flagString(args.flags, "screen-id");
  const tags = flagString(args.flags, "tag");
  const note = flagString(args.flags, "note");
  const forValue = flagString(args.flags, "for");
  if (screenIds === undefined && tags === undefined) throw usageError("alerts mute requires --screen-id or --tag.");
  const body: AlertMuteWrite = {
    ...(screenIds !== undefined ? { screen_ids: screenIds.split(",") } : {}),
    ...(tags !== undefined ? { tags: tags.split(",") } : {}),
    until: alertEnd(forValue, flagString(args.flags, "until"), runtime.now()),
    ...(note !== undefined ? { note: alertNote(note) } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, {
    method: "POST", path: ALERT_MUTES_PATH, idempotent: true, body,
    ...(forValue !== undefined ? { recoverySupersede: JSON.stringify(["alerts mute", body.screen_ids ?? [], body.tags ?? [], body.note ?? null]) } : {}),
  });
  const created = response.body as AlertMute | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Created mute ${created?.id ?? ""}`.trimEnd(), ...alertMuteLines(created)].join("\n"),
  };
});

export const handleAlertsMutes = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, { method: "GET", path: ALERT_MUTES_PATH });
  const items = (response.body as AlertMuteList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Mutes (${list.length})`, ...alertMuteTableLines(list)].join("\n"),
  };
});

export const handleAlertsUnmute = commandHandler(async (args, runtime, resolved) => {
  const id = alertMuteId(args.positionals[2], "unmute");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, { method: "DELETE", path: `${ALERT_MUTES_PATH}/${id}`, idempotent: true }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Ended mute ${id}. Open alerts on its screens need attention again unless they are acknowledged or snoozed.`,
  };
});
