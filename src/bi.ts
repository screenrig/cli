import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readAuthoringText } from "./authoring-input.js";
import type { ApiClient } from "./client.js";
import { requireToken } from "./client.js";
import { clientFor, commandHandler, jsonBody } from "./commands.js";
import { flagString } from "./command-input.js";
import { quotedRevision } from "./if-match.js";
import { successEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { snoozeDurationMs } from "./notifications.js";
import { CliError, usageError } from "./problems.js";
import { table } from "./webhooks.js";

// BI dashboards on screens: /api/bi-connections (a project's access to a BI
// system, with a sealed secret the server never returns) and /api/bi-views (one
// dashboard, panel or public link). A view plays through an iframe primitive
// that shows its embed_url. Only Grafana exists so far.

const CONNECTIONS_PATH = "/api/bi-connections";
const VIEWS_PATH = "/api/bi-views";

/** Backend BIConnection.id and BIView.id shapes (vendor/openapi.yaml). */
export const BI_CONNECTION_ID_PATTERN = /^(?:(?:stage|qa|development)_)?bic_[A-Za-z0-9_-]+$/;
export const BI_VIEW_ID_PATTERN = /^(?:(?:stage|qa|development)_)?biv_[A-Za-z0-9_-]+$/;
export const BI_FITS = ["contain", "cover", "fill"] as const;
export const BI_THEMES = ["dark", "light"] as const;
export const BI_REFRESH_MIN_S = 30;
export const BI_REFRESH_MAX_S = 86_400;
const TOKEN_FILE_MAX_BYTES = 8192;
const NAME_MAX = 80;

export interface BiCheck { name: string; ok: boolean; warn?: boolean; detail?: string }
export interface BiTestReport { at: string; ok: boolean; checks: BiCheck[]; width?: number; height?: number; bytes?: number }
export interface BiConnection {
  id: string; project_id?: string; kind: string; name: string;
  config: { url?: string; org_id?: number };
  embed_origin: string | null;
  secret: { set: boolean; hint: string };
  last_test: BiTestReport | null;
  revision: number; created_at?: string; updated_at?: string;
}
export interface BiTarget {
  dashboard_uid?: string; panel_id?: number; org_id?: number; from?: string; to?: string;
  vars?: Record<string, string>; theme?: string; timezone?: string; public_url?: string;
}
export interface BiView {
  id: string; project_id?: string; connection_id?: string; kind: string; name: string; target: BiTarget;
  refresh_s: number; fit: string; revision: number;
  status: { last_ok_at: string | null; last_error: { at: string; code: string; detail: string } | null };
  embed_url: string | null; created_at?: string; updated_at?: string;
}
interface BiList<T> { items: T[]; next_cursor: string | null }

export function biConnectionId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`bi connection ${command} requires <id>.`);
  if (!BI_CONNECTION_ID_PATTERN.test(value)) {
    throw usageError("A connection id looks like bic_ followed by letters, digits, - or _.", {
      command: "screenrig bi connection list",
      reason: "List this project's connections and their ids.",
    });
  }
  return value;
}

export function biViewId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`bi view ${command} requires <id>.`);
  if (!BI_VIEW_ID_PATTERN.test(value)) {
    throw usageError("A view id looks like biv_ followed by letters, digits, - or _.", {
      command: "screenrig bi view list",
      reason: "List this project's views and their ids.",
    });
  }
  return value;
}

/** --connection-id: a bic_ id. */
export function biConnectionOption(value: string): string {
  if (!BI_CONNECTION_ID_PATTERN.test(value)) {
    throw usageError("--connection-id takes a connection id (bic_…).", { command: "screenrig bi connection list", reason: "List this project's connections and their ids." });
  }
  return value;
}

export function biName(value: string): string {
  const name = value.trim();
  if (!name || [...name].length > NAME_MAX || /\p{Cc}/u.test(name)) throw usageError(`--name takes 1 to ${NAME_MAX} characters without control characters.`);
  return name;
}

/** --url on a connection: Grafana's address; the server validates it against the public Internet. */
export function biAddress(value: string): string {
  const text = value.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(text)) throw usageError("--url takes Grafana's address, such as https://grafana.example.com or https://example.com/grafana.");
  return text;
}

export function biOrgId(value: string): string {
  if (!/^[1-9]\d{0,9}$/.test(value)) throw usageError("--org-id takes a Grafana organization id: a whole number from 1.");
  return value;
}

export function biPanelId(value: string): string {
  if (!/^\d{1,10}$/.test(value)) throw usageError("--panel takes a panel id: a whole number, as in the dashboard's viewPanel.");
  return value;
}

export function biPixels(value: string): string {
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 10_000) throw usageError("--width and --height take a size in pixels, 1 to 10000.");
  return value;
}

export function biDashboardUid(value: string): string {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(value)) throw usageError("--dashboard takes a dashboard uid, the part after /d/ in its address.", { command: "screenrig bi connection browse ID", reason: "List the dashboards the connection can show, with their uids." });
  return value;
}

/** Grafana times such as now-6h, now/d or an epoch in milliseconds. */
export function biTime(value: string): string {
  if (!/^[A-Za-z0-9:+\-/_.,]{1,64}$/.test(value)) throw usageError("--from and --to take a Grafana time such as now-6h, now/d, or an epoch in milliseconds.");
  return value;
}

/** Repeatable --var NAME=VALUE (also var-NAME=VALUE): returns a JSON object of var-NAME keys. */
export function biVar(value: string, previous?: string): string {
  const at = value.indexOf("=");
  const rawName = at < 0 ? value : value.slice(0, at);
  const name = rawName.startsWith("var-") ? rawName : `var-${rawName}`;
  if (at < 0 || !/^var-[A-Za-z0-9_-]{1,64}$/.test(name)) throw usageError("--var takes NAME=VALUE, such as --var host=web1; NAME is the dashboard variable's name.");
  const text = value.slice(at + 1);
  if ([...text].length > 200 || /\p{Cc}/u.test(text)) throw usageError("--var values are at most 200 characters without control characters.");
  const vars: Record<string, string> = previous ? JSON.parse(previous) as Record<string, string> : {};
  vars[name] = text;
  return JSON.stringify(vars);
}

export function biRefreshOption(value: string): string {
  biRefreshSeconds(value);
  return value;
}

/** --refresh: seconds, or a duration such as 30s, 5m or 1h, from 30 seconds to 24 hours. */
export function biRefreshSeconds(value: string): number {
  const text = value.trim();
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : snoozeDurationMs(text);
  const seconds = ms === undefined ? NaN : Math.round(ms / 1000);
  if (!Number.isFinite(seconds) || seconds < BI_REFRESH_MIN_S || seconds > BI_REFRESH_MAX_S) {
    throw usageError("--refresh takes a cadence from 30s to 24h, such as 30s, 5m, 1h or a number of seconds.");
  }
  return seconds;
}

type Handler = Parameters<typeof commandHandler>[0];
type Args = Parameters<Handler>[0];
type Runtime = Parameters<Handler>[1];

/** Read the secret from a file or stdin, never an argument. */
async function readToken(file: string, runtime: Runtime): Promise<string> {
  const text = (await readAuthoringText(file, runtime, TOKEN_FILE_MAX_BYTES)).trim();
  if (!text) throw usageError(`${file === "-" ? "stdin" : file} holds no token.`);
  if (/\s/.test(text)) throw usageError(`${file === "-" ? "stdin" : file} must hold only the token: one value without spaces or line breaks.`);
  return text;
}

/** Add the next step to the problems a BI call is known to answer. */
export function biProblem(error: unknown, id?: string): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.next) return error;
  const withNext = (command: string, reason: string) => new CliError({ ...problem, next: { command, reason } }, error.exitCode, error.warnings);
  const connection = id !== undefined && BI_CONNECTION_ID_PATTERN.test(id);
  if (problem.code === "bi_upstream_refused") {
    return withNext(connection ? `screenrig bi connection test ${id}` : "screenrig bi connection list",
      "Fix the connection as the detail says (a Viewer service-account token for the Grafana organization), update it with bi connection update, then test it.");
  }
  if (problem.code === "bi_upstream_unavailable") {
    return withNext(connection ? `screenrig bi connection test ${id}` : "screenrig bi connection list",
      "Check the Grafana address and that it has the Image Renderer plugin or a remote rendering service, then test the connection again. Nothing was changed.");
  }
  if (problem.code === "resource_conflict" && connection) {
    return withNext("screenrig bi view list", "Delete the views the detail names (bi view delete ID), then delete the connection.");
  }
  if (problem.code === "not_found" && id !== undefined) {
    return connection
      ? withNext("screenrig bi connection list", "List this project's connections and their ids. A connection belongs to one project.")
      : withNext("screenrig bi view list", "List this project's views and their ids. A view belongs to one project.");
  }
  return error;
}

async function biCall(client: ApiClient, request: Parameters<ApiClient["call"]>[0], id?: string): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw biProblem(error, id);
  }
}

const dash = (value: string | undefined | null): string => (value && value.length ? value : "-");

function checkLines(checks: BiCheck[] | undefined): string[] {
  return (checks ?? []).map((check) => `  ${!check.ok ? "failed" : check.warn ? "warning" : "ok"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
}

export function connectionLines(connection: BiConnection | undefined): string[] {
  if (!connection) return [];
  const test = connection.last_test;
  return [
    `id: ${connection.id}`,
    `name: ${connection.name}`,
    `kind: ${connection.kind}`,
    `url: ${dash(connection.config?.url)}`,
    `org: ${connection.config?.org_id ?? 1}`,
    `secret: ${connection.secret?.set ? `set${connection.secret.hint ? ` (ends ${connection.secret.hint})` : ""}` : "not set"}`,
    ...(connection.embed_origin ? [`embed origin: ${connection.embed_origin}`] : []),
    `last test: ${test ? `${test.ok ? "ok" : "failed"} at ${test.at}` : "never"}`,
    ...(test ? checkLines(test.checks) : []),
    `revision: ${connection.revision}`,
  ];
}

export function connectionTableLines(items: BiConnection[]): string[] {
  if (!items.length) return ["No connections"];
  return table(["ID", "KIND", "NAME", "URL", "TEST"], items.map((item) => [
    item.id, item.kind, item.name, dash(item.config?.url), item.last_test ? (item.last_test.ok ? "ok" : "failed") : "never",
  ]));
}

function targetText(view: BiView): string {
  const target = view.target ?? {};
  if (target.public_url) return `public link ${target.public_url}`;
  const parts = [`dashboard ${target.dashboard_uid ?? "?"}`];
  if (target.panel_id !== undefined) parts.push(`panel ${target.panel_id}`);
  if (target.from || target.to) parts.push(`${target.from ?? "default"} to ${target.to ?? "default"}`);
  for (const [name, value] of Object.entries(target.vars ?? {})) parts.push(`${name}=${value}`);
  if (target.theme) parts.push(target.theme);
  return parts.join(", ");
}

export function viewLines(view: BiView | undefined): string[] {
  if (!view) return [];
  const status = view.status ?? { last_ok_at: null, last_error: null };
  return [
    `id: ${view.id}`,
    `name: ${view.name}`,
    `connection: ${view.connection_id ?? "(public link)"}`,
    `shows: ${targetText(view)}`,
    `refresh: every ${view.refresh_s}s`,
    `fit: ${view.fit}`,
    `status: ${status.last_error ? `${status.last_error.code} (${status.last_error.detail})` : status.last_ok_at ? `ok since ${status.last_ok_at}` : "not shown yet"}`,
    `embed_url: ${view.embed_url ?? "(none: this server has no embed host)"}`,
    `revision: ${view.revision}`,
  ];
}

export function viewTableLines(items: BiView[]): string[] {
  if (!items.length) return ["No views"];
  return table(["ID", "NAME", "SHOWS", "REFRESH", "STATUS"], items.map((item) => [
    item.id, item.name, targetText(item), `${item.refresh_s}s`, item.status?.last_error ? item.status.last_error.code : item.status?.last_ok_at ? "ok" : "new",
  ]));
}

const EMBED_HINT = "Put this URL in an iframe primitive (content_fit fill).";

function listBody<T>(response: { body: unknown }): T[] {
  const items = (response.body as BiList<T> | undefined)?.items;
  return Array.isArray(items) ? items : [];
}

/** A list command pages through every page: the lists are not large, and an agent needs the whole set. */
async function allPages<T>(client: ApiClient, path: string, id?: string): Promise<{ items: T[]; response: Awaited<ReturnType<ApiClient["call"]>> }> {
  const items: T[] = [];
  let cursor: string | undefined;
  let response = await biCall(client, { method: "GET", path }, id);
  for (let pages = 0; pages < 1000; pages++) {
    items.push(...listBody<T>(response));
    cursor = (response.body as BiList<T> | undefined)?.next_cursor ?? undefined;
    if (!cursor) break;
    response = await biCall(client, { method: "GET", path, query: { cursor } }, id);
  }
  return { items, response };
}

// ---- connections

export const handleBiConnectionCreate = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const url = flagString(args.flags, "url");
  const tokenFile = flagString(args.flags, "token-file");
  if (url === undefined || tokenFile === undefined) throw usageError("bi connection create grafana requires --url and --token-file.");
  const name = flagString(args.flags, "name") ?? biHostName(url);
  const orgId = flagString(args.flags, "org-id");
  const secret = await readToken(tokenFile, runtime);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await biCall(client, {
    method: "POST", path: CONNECTIONS_PATH, idempotent: true,
    body: { name: biName(name), kind: "grafana", config: { url, ...(orgId !== undefined ? { org_id: Number(orgId) } : {}) }, secret },
  });
  const created = response.body as BiConnection | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Created connection ${created?.id ?? ""}`.trimEnd(), ...connectionLines(created),
      "", `Next: screenrig bi connection test ${created?.id ?? "ID"}`].join("\n"),
  };
});

function biHostName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "Grafana";
  }
}

export const handleBiConnectionList = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const { items, response } = await allPages<BiConnection>(client, CONNECTIONS_PATH);
  return {
    envelope: jsonBody({ ...response, body: { items, next_cursor: null } }, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Connections (${items.length})`, ...connectionTableLines(items)].join("\n"),
  };
});

export const handleBiConnectionShow = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const id = biConnectionId(args.positionals[3], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await biCall(client, { method: "GET", path: `${CONNECTIONS_PATH}/${id}` }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Connection", ...connectionLines(response.body as BiConnection | undefined)].join("\n"),
  };
});

export const handleBiConnectionUpdate = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const id = biConnectionId(args.positionals[3], "update");
  const name = flagString(args.flags, "name");
  const url = flagString(args.flags, "url");
  const orgId = flagString(args.flags, "org-id");
  const tokenFile = flagString(args.flags, "token-file");
  if (name === undefined && url === undefined && orgId === undefined && tokenFile === undefined) {
    throw usageError("bi connection update requires --name, --url, --org-id or --token-file.");
  }
  const config = { ...(url !== undefined ? { url } : {}), ...(orgId !== undefined ? { org_id: Number(orgId) } : {}) };
  const body = {
    ...(name !== undefined ? { name: biName(name) } : {}),
    ...(Object.keys(config).length ? { config } : {}),
    ...(tokenFile !== undefined ? { secret: await readToken(tokenFile, runtime) } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await biCall(client, { method: "PATCH", path: `${CONNECTIONS_PATH}/${id}`, idempotent: true, body, headers: revisionHeader(args) }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated connection ${id}`, ...connectionLines(response.body as BiConnection | undefined)].join("\n"),
  };
});

function revisionHeader(args: Args): Record<string, string> | undefined {
  const revision = flagString(args.flags, "if-match");
  return revision ? { "if-match": quotedRevision(revision) } : undefined;
}

export const handleBiConnectionDelete = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const id = biConnectionId(args.positionals[3], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await biCall(client, { method: "DELETE", path: `${CONNECTIONS_PATH}/${id}`, idempotent: true, headers: revisionHeader(args) }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted connection ${id}.`,
  };
});

export const handleBiConnectionTest = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const id = biConnectionId(args.positionals[3], "test");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await biCall(client, { method: "POST", path: `${CONNECTIONS_PATH}/${id}/test`, idempotent: true }, id);
  const report = response.body as BiTestReport | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Connection ${id}: ${report?.ok ? "ok" : "failed"}`, ...checkLines(report?.checks),
      ...(report?.ok ? ["", "This does not judge a dashboard's permissions or a remote renderer: run screenrig bi view test ID to render for real."] : [])].join("\n"),
  };
});

export const handleBiConnectionBrowse = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const id = biConnectionId(args.positionals[3], "browse");
  const query = flagString(args.flags, "query");
  const dashboard = flagString(args.flags, "dashboard");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const items: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  let response = await biCall(client, { method: "GET", path: `${CONNECTIONS_PATH}/${id}/browse`, query: { ...(query !== undefined ? { query } : {}), ...(dashboard !== undefined ? { dashboard } : {}) } }, id);
  for (let pages = 0; pages < 100; pages++) {
    items.push(...listBody<Record<string, unknown>>(response));
    cursor = (response.body as BiList<unknown> | undefined)?.next_cursor ?? undefined;
    if (!cursor) break;
    response = await biCall(client, { method: "GET", path: `${CONNECTIONS_PATH}/${id}/browse`, query: { ...(query !== undefined ? { query } : {}), cursor } }, id);
  }
  const heading = (response.body as { dashboard?: { uid: string; title: string } } | undefined)?.dashboard;
  const lines = dashboard !== undefined
    ? [`Panels of ${heading?.title ?? dashboard} (${items.length})`, ...table(["PANEL", "TYPE", "TITLE"], items.map((item) => [String(item.id ?? ""), String(item.type ?? ""), String(item.title ?? "")]))]
    : [`Dashboards (${items.length})`, ...table(["UID", "FOLDER", "TITLE"], items.map((item) => [String(item.uid ?? ""), String(item.folder ?? ""), String(item.title ?? "")]))];
  return {
    envelope: jsonBody({ ...response, body: { ...(heading ? { dashboard: heading } : {}), items, next_cursor: null } }, client.requestId),
    exitCode: ExitCode.Success,
    human: lines.join("\n"),
  };
});

// ---- views

function nameFromAddress(url: string | undefined, dashboard: string | undefined): string {
  const uid = dashboard ?? (url ? /\/d(?:-solo)?\/([^/?#]+)/.exec(url)?.[1] : undefined);
  return uid ? `Grafana ${uid}` : "Grafana dashboard";
}

/** The target flags a create or update can carry besides --url, --dashboard and --public-url. */
const TARGET_FLAGS = ["panel", "from", "to", "var", "theme", "timezone"] as const;

function targetFromFlags(args: Args, base: BiTarget | undefined): BiTarget {
  const target: BiTarget = { ...(base ?? {}), ...(base?.vars ? { vars: { ...base.vars } } : {}) };
  const dashboard = flagString(args.flags, "dashboard");
  if (dashboard !== undefined) {
    for (const key of Object.keys(target) as Array<keyof BiTarget>) delete target[key];
    target.dashboard_uid = dashboard;
  }
  const panel = flagString(args.flags, "panel");
  if (panel !== undefined) target.panel_id = Number(panel);
  const from = flagString(args.flags, "from");
  if (from !== undefined) target.from = from;
  const to = flagString(args.flags, "to");
  if (to !== undefined) target.to = to;
  const theme = flagString(args.flags, "theme");
  if (theme !== undefined) target.theme = theme;
  const timezone = flagString(args.flags, "timezone");
  if (timezone !== undefined) target.timezone = timezone;
  const vars = flagString(args.flags, "var");
  if (vars !== undefined) target.vars = { ...(target.vars ?? {}), ...(JSON.parse(vars) as Record<string, string>) };
  return target;
}

function viewTargetFlagsGiven(args: Args): string[] {
  return TARGET_FLAGS.filter((flag) => flagString(args.flags, flag) !== undefined).map((flag) => `--${flag}`);
}

export const handleBiViewCreate = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const connectionId = flagString(args.flags, "connection-id");
  const url = flagString(args.flags, "url");
  const dashboard = flagString(args.flags, "dashboard");
  const publicUrl = flagString(args.flags, "public-url");
  const refresh = flagString(args.flags, "refresh");
  const fit = flagString(args.flags, "fit");
  const given = viewTargetFlagsGiven(args);
  let body: Record<string, unknown>;
  if (publicUrl !== undefined) {
    if (connectionId !== undefined || url !== undefined || dashboard !== undefined || given.length) {
      throw usageError("--public-url needs no connection: give it alone, with --name, --refresh and --fit.");
    }
    body = { kind: "grafana", name: flagString(args.flags, "name") ?? "Grafana public dashboard", target: { public_url: publicUrl } };
  } else {
    if (connectionId === undefined) throw usageError("bi view create requires --connection-id with --url or --dashboard, or --public-url alone.");
    if (url !== undefined && (dashboard !== undefined || given.length)) {
      throw usageError(`With --url the dashboard's settings come from the address; to set ${given.join(", ") || "--dashboard"} use --dashboard UID instead.`);
    }
    if (url === undefined && dashboard === undefined) throw usageError("bi view create requires --url or --dashboard with --connection-id.");
    body = {
      connection_id: connectionId,
      name: flagString(args.flags, "name") ?? nameFromAddress(url, dashboard),
      ...(url !== undefined ? { url } : { target: targetFromFlags(args, undefined) }),
    };
  }
  body.name = biName(String(body.name));
  if (refresh !== undefined) body.refresh_s = biRefreshSeconds(refresh);
  if (fit !== undefined) body.fit = fit;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await biCall(client, { method: "POST", path: VIEWS_PATH, idempotent: true, body }, connectionId);
  const created = response.body as BiView | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Created view ${created?.id ?? ""}`.trimEnd(), ...viewLines(created), ...(created?.embed_url ? ["", EMBED_HINT] : []),
      "", `Next: screenrig bi view test ${created?.id ?? "ID"}`].join("\n"),
  };
});

export const handleBiViewList = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const { items, response } = await allPages<BiView>(client, VIEWS_PATH);
  return {
    envelope: jsonBody({ ...response, body: { items, next_cursor: null } }, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Views (${items.length})`, ...viewTableLines(items)].join("\n"),
  };
});

export const handleBiViewShow = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const id = biViewId(args.positionals[3], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await biCall(client, { method: "GET", path: `${VIEWS_PATH}/${id}` }, id);
  const view = response.body as BiView | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["View", ...viewLines(view), ...(view?.embed_url ? ["", EMBED_HINT] : [])].join("\n"),
  };
});

export const handleBiViewUpdate = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const id = biViewId(args.positionals[3], "update");
  const name = flagString(args.flags, "name");
  const url = flagString(args.flags, "url");
  const dashboard = flagString(args.flags, "dashboard");
  const publicUrl = flagString(args.flags, "public-url");
  const refresh = flagString(args.flags, "refresh");
  const fit = flagString(args.flags, "fit");
  const given = viewTargetFlagsGiven(args);
  const changesTarget = url !== undefined || dashboard !== undefined || publicUrl !== undefined || given.length > 0;
  if (name === undefined && refresh === undefined && fit === undefined && !changesTarget) {
    throw usageError("bi view update requires something to change: --name, --refresh, --fit, --url, --dashboard, --public-url or a target flag.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const body: Record<string, unknown> = {};
  if (name !== undefined) body.name = biName(name);
  if (refresh !== undefined) body.refresh_s = biRefreshSeconds(refresh);
  if (fit !== undefined) body.fit = fit;
  if (publicUrl !== undefined) {
    if (url !== undefined || dashboard !== undefined || given.length) throw usageError("--public-url replaces the whole target: give it without the other target flags.");
    body.target = { public_url: publicUrl };
  } else if (url !== undefined) {
    if (dashboard !== undefined || given.length) throw usageError("--url replaces the whole target from the address: give it without the other target flags.");
    body.url = url;
  } else if (dashboard !== undefined || given.length) {
    // --dashboard starts a new target; the other flags change the current one.
    const current = dashboard !== undefined ? undefined : ((await biCall(client, { method: "GET", path: `${VIEWS_PATH}/${id}` }, id)).body as BiView).target;
    if (current?.public_url) throw usageError("This view shows a public link: change it with --public-url, or create a view of a connection.");
    body.target = targetFromFlags(args, current);
  }
  const response = await biCall(client, { method: "PATCH", path: `${VIEWS_PATH}/${id}`, idempotent: true, body, headers: revisionHeader(args) }, id);
  const view = response.body as BiView | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated view ${id}`, ...viewLines(view)].join("\n"),
  };
});

export const handleBiViewDelete = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const id = biViewId(args.positionals[3], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await biCall(client, { method: "DELETE", path: `${VIEWS_PATH}/${id}`, idempotent: true, headers: revisionHeader(args) }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted view ${id}. A screen still showing its embed_url answers not_found until its playlist changes.`,
  };
});

export const handleBiViewTest = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const id = biViewId(args.positionals[3], "test");
  const output = flagString(args.flags, "output");
  const width = flagString(args.flags, "width");
  const height = flagString(args.flags, "height");
  if (output === undefined && (width !== undefined || height !== undefined)) throw usageError("--width and --height set the size of the image --output saves.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (output === undefined) {
    const response = await biCall(client, { method: "POST", path: `${VIEWS_PATH}/${id}/test`, idempotent: true }, id);
    const report = response.body as BiTestReport | undefined;
    return {
      envelope: jsonBody(response, client.requestId),
      exitCode: ExitCode.Success,
      human: [`View ${id}: ${report?.ok ? "ok" : "failed"}`, ...checkLines(report?.checks),
        ...(report?.ok ? [] : ["", `Next: screenrig bi connection test ${"CONNECTION_ID"} checks the token and the Image Renderer plugin.`])].join("\n"),
    };
  }
  const query = { width: width ?? "1920", height: height ?? "1080" };
  let download: Awaited<ReturnType<ApiClient["download"]>>;
  try {
    download = await client.download({ method: "GET", path: `${VIEWS_PATH}/${id}/image`, query });
  } catch (error) {
    throw biProblem(error, id);
  }
  const file = path.resolve(runtime.cwd(), output);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    if (!download.body) throw usageError("The server returned no image.");
    for await (const chunk of download.body) {
      bytes += chunk.byteLength;
      if (bytes > 16 * 1024 * 1024) throw usageError("The image is larger than 16 MiB; nothing was written.");
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    await download.body?.cancel?.();
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, Buffer.concat(chunks));
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true });
    throw usageError("Cannot write the image; check that the output directory is writable.");
  }
  return {
    envelope: successEnvelope({ id, file, bytes, width: Number(query.width), height: Number(query.height) }, { request_id: download.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Rendered view ${id} at ${query.width}x${query.height}: ${file} (${bytes} bytes).\nOpen and inspect this image before publishing.`,
  };
});
