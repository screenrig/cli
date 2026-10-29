// Command handlers for the reports commands, loaded on demand.
import { flagBool, flagString, type ParsedArgs } from "../command-input.js";
import { requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import { quotedRevision } from "../if-match.js";
import { reportCatalogLines, reportFilters, reportKind, reportQuery, reportRecipients, reportSchedule, reportSubscriptionId, reportTableLines, subscriptionLines, subscriptionListLines } from "../reports.js";
import { clientFor, commandHandler, jsonBody, reportFileOf } from "../commands.js";


// Reports: GET /api/reports builds rollups and statements from the project's
// aggregates (folder, screen and tag groups, alert history, proof of play) and
// writes any of them as JSON, CSV, XLSX or PDF. Report subscriptions mail a
// report to project members on a schedule.
export const REPORTS_PATH = "/api/reports";
export const REPORT_SUBSCRIPTIONS_PATH = "/api/report-subscriptions";

export const handleReportsList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: REPORTS_PATH });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reportCatalogLines(response.body as Parameters<typeof reportCatalogLines>[0]).join("\n"),
  };
});

export const handleReportsShow = commandHandler(async (args, runtime, resolved) => {
  const kind = reportKind(args.positionals[2], "reports show");
  const query = reportQuery(args);
  const file = await reportFileOf(args, runtime, resolved, `${REPORTS_PATH}/${kind}`, query, `${kind.replaceAll("_", "-")}${query.to ? `-${query.to}` : ""}`, `${kind} report`);
  if (file) return file;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${REPORTS_PATH}/${kind}`, query });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reportTableLines(response.body as Parameters<typeof reportTableLines>[0]).join("\n"),
  };
});

export const handleReportSubscriptionsList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: REPORT_SUBSCRIPTIONS_PATH });
  const body = response.body as { items?: Parameters<typeof subscriptionListLines>[0] } | undefined;
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: subscriptionListLines(body?.items).join("\n") };
});

export const handleReportSubscriptionsShow = commandHandler(async (args, runtime, resolved) => {
  const id = reportSubscriptionId(args.positionals[3], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${REPORT_SUBSCRIPTIONS_PATH}/${id}` });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: subscriptionLines(response.body as Parameters<typeof subscriptionLines>[0]).join("\n") };
});

/** The write body the subscription flags name: only the members given. */
export function reportSubscriptionBody(args: ParsedArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const name = flagString(args.flags, "name");
  const format = flagString(args.flags, "format");
  const recipients = flagString(args.flags, "recipients");
  const filters = reportFilters(flagString(args.flags, "filter"));
  const schedule = reportSchedule(args);
  if (name !== undefined) body.name = name;
  if (format !== undefined) body.format = format;
  if (recipients !== undefined) body.recipients = reportRecipients(recipients);
  if (filters !== undefined) body.filters = filters;
  if (schedule !== undefined) body.schedule = schedule;
  if (flagBool(args.flags, "pause")) body.enabled = false;
  if (flagBool(args.flags, "resume")) body.enabled = true;
  return body;
}

export const handleReportSubscriptionsCreate = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const body = { ...reportSubscriptionBody(args), kind: reportKind(flagString(args.flags, "kind"), "reports subscriptions create --kind") };
  const response = await client.call({ method: "POST", path: REPORT_SUBSCRIPTIONS_PATH, body, idempotent: true });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: ["Created", ...subscriptionLines(response.body as Parameters<typeof subscriptionLines>[0])].join("\n") };
});

export const handleReportSubscriptionsUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = reportSubscriptionId(args.positionals[3], "update");
  const body = reportSubscriptionBody(args);
  if (Object.keys(body).length === 0) throw usageError("reports subscriptions update needs at least one change: --name, --cadence, --format, --recipients, --filter, --pause or --resume.");
  const revision = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "PATCH", path: `${REPORT_SUBSCRIPTIONS_PATH}/${id}`, body, idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: ["Updated", ...subscriptionLines(response.body as Parameters<typeof subscriptionLines>[0])].join("\n") };
});

export const handleReportSubscriptionsDelete = commandHandler(async (args, runtime, resolved) => {
  const id = reportSubscriptionId(args.positionals[3], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "DELETE", path: `${REPORT_SUBSCRIPTIONS_PATH}/${id}`, idempotent: true });
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted report subscription ${id}. Nothing more is sent.`,
  };
});

export const handleReportSubscriptionsSend = commandHandler(async (args, runtime, resolved) => {
  const id = reportSubscriptionId(args.positionals[3], "send");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: `${REPORT_SUBSCRIPTIONS_PATH}/${id}/send`, idempotent: true });
  const sent = response.body as Parameters<typeof subscriptionLines>[0];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [sent?.last_status === "delivered" ? "Sent now" : "Not delivered", ...subscriptionLines(sent)].join("\n"),
  };
});
