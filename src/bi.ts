import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readAuthoringText } from "./authoring-input.js";
import type { ApiClient } from "./client.js";
import { requireToken } from "./client.js";
import { clientFor, commandHandler, jsonBody } from "./commands.js";
import { flagBool, flagString } from "./command-input.js";
import { quotedRevision } from "./if-match.js";
import { successEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { snoozeDurationMs } from "./notifications.js";
import { CliError, usageError } from "./problems.js";
import { table } from "./webhooks.js";

// BI dashboards on screens: /api/bi-connections (a project's access to a BI
// system, with a sealed secret the server never returns) and /api/bi-views (one
// dashboard, panel, report or public link). A view plays through an iframe
// primitive that shows its embed_url. Kinds: Grafana, Power BI and Tableau.

const CONNECTIONS_PATH = "/api/bi-connections";
const VIEWS_PATH = "/api/bi-views";

/** Backend BIConnection.id and BIView.id shapes (vendor/openapi.yaml). */
export const BI_CONNECTION_ID_PATTERN = /^(?:(?:stage|qa|development)_)?bic_[A-Za-z0-9_-]+$/;
export const BI_VIEW_ID_PATTERN = /^(?:(?:stage|qa|development)_)?biv_[A-Za-z0-9_-]+$/;
export const BI_FITS = ["contain", "cover", "fill"] as const;
export const BI_THEMES = ["dark", "light"] as const;
export const BI_REFRESH_MIN_S = 30;
export const BI_REFRESH_MAX_S = 86_400;
export const BI_ROTATE_MIN_S = 10;
export const BI_ROTATE_MAX_S = 3_600;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TENANT_DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const TOKEN_FILE_MAX_BYTES = 8192;
const NAME_MAX = 80;
const APP_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SITE = /^[A-Za-z0-9_.~-]{1,255}$/;
const VIEW_SEGMENT = /^[A-Za-z0-9_.%~-]{1,200}$/;

export interface BiCheck { name: string; ok: boolean; warn?: boolean; detail?: string }
export interface BiTestReport { at: string; ok: boolean; checks: BiCheck[]; width?: number; height?: number; bytes?: number }
export interface BiConnection {
  id: string; project_id?: string; kind: string; name: string;
  config: { url?: string; org_id?: number; tenant_id?: string; client_id?: string; site?: string; secret_id?: string; username?: string };
  embed_origin: string | null;
  secret: { set: boolean; hint: string };
  last_test: BiTestReport | null;
  revision: number; created_at?: string; updated_at?: string;
}
export interface BiTarget {
  dashboard_uid?: string; panel_id?: number; org_id?: number; from?: string; to?: string;
  vars?: Record<string, string>; theme?: string; timezone?: string; public_url?: string;
  workspace_id?: string; report_id?: string; pages?: string[]; rotate_all_pages?: boolean;
  view?: string; rotate_sheets?: boolean;
}
export interface BiView {
  id: string; project_id?: string; connection_id?: string; kind: string; name: string; target: BiTarget;
  refresh_s: number; rotate_s?: number; fit: string; revision: number;
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

/** --url on a connection: the system's address; the server validates it against the public Internet. */
export function biAddress(value: string): string {
  const text = value.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(text)) throw usageError("--url takes the system's address, such as https://grafana.example.com, https://example.com/grafana or https://tableau.example.com.");
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

/** --tenant-id: the Entra tenant's Directory ID (a GUID) or its domain, not common, organizations or consumers. */
export function biTenantId(value: string): string {
  const text = value.trim();
  if (!GUID.test(text) && !(text.length <= 253 && TENANT_DOMAIN.test(text))) {
    throw usageError("--tenant-id takes your Microsoft Entra Directory (tenant) ID, a GUID, or its domain such as contoso.onmicrosoft.com.");
  }
  return text;
}

/** --client-id, --workspace and --report: a GUID. */
export function biGuid(flag: string, what: string): (value: string) => string {
  return (value: string) => {
    const text = value.trim();
    if (!GUID.test(text)) throw usageError(`${flag} takes ${what}, a GUID.`);
    return text;
  };
}
export const biClientId = biGuid("--client-id", "the Application (client) ID of your Microsoft Entra app registration");
export const biWorkspaceId = biGuid("--workspace", "a Power BI workspace id, the part after /groups/ in a report's address");
export const biReportId = biGuid("--report", "a Power BI report id, the part after /reports/ in its address");

/** --client-id and --secret-id of a Tableau connected app: ids as Tableau shows them; Tableau judges the rest. */
function biAppId(flag: string, what: string): (value: string) => string {
  return (value: string) => {
    const text = value.trim();
    if (!APP_ID.test(text)) throw usageError(`${flag} takes ${what}.`);
    return text;
  };
}
export const biAppClientId = biAppId("--client-id", "the Client ID of the connected app (Tableau: Settings > Connected Apps)");
export const biSecretId = biAppId("--secret-id", "the Secret ID of a secret generated for the connected app, not the secret value");

/** --url on a Tableau connection: https, the server or the Tableau Cloud pod; the server checks the host is public. */
export function biTableauAddress(value: string): string {
  const text = value.trim();
  if (!/^https:\/\/[^\s]+$/i.test(text)) throw usageError("--url takes the https address of Tableau Server or your Tableau Cloud pod, such as https://tableau.example.com or https://10ay.online.tableau.com.");
  return text;
}

/** --site: the site's content URL (the part after /site/ or /t/ in a view's address). */
export function biSite(value: string): string {
  const text = value.trim();
  if (text !== "" && !SITE.test(text)) throw usageError("--site takes the site's content URL, the part after /site/ or /t/ in a view's address (--default-site is Tableau Server's default site).");
  return text;
}

/** --username: the Tableau user the screens' views are shown as. */
export function biUsername(value: string): string {
  const text = value.trim();
  if (!text || [...text].length > 320 || /\p{Cc}/u.test(text)) throw usageError("--username takes the Tableau user the screens' views are shown as (an email address on Tableau Cloud).");
  return text;
}

/** --view: Workbook/View, the names after /views/ in a Tableau view's address. */
export function biViewPath(value: string): string {
  const text = value.trim();
  const at = text.indexOf("/");
  const workbook = at < 0 ? "" : text.slice(0, at);
  const sheet = at < 0 ? "" : text.slice(at + 1);
  const valid = (segment: string) => VIEW_SEGMENT.test(segment) && segment !== "." && segment !== "..";
  if (!valid(workbook) || !valid(sheet)) {
    throw usageError("--view takes Workbook/View, the names after /views/ in the view's address.", { command: "screenrig bi connection browse ID", reason: "List the views the connection can show, with their paths." });
  }
  return text;
}

/** Repeatable --page NAME: returns a JSON array of the page names, in order. */
export function biPage(value: string, previous?: string): string {
  const name = value.trim();
  if (!name || [...name].length > 200 || /\p{Cc}/u.test(name)) throw usageError("--page takes a page name or display name of 1 to 200 characters without control characters.");
  const pages: string[] = previous ? JSON.parse(previous) as string[] : [];
  pages.push(name);
  return JSON.stringify(pages);
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

/** --refresh: seconds, or a duration such as 30s, 5m or 1h, from 30 seconds to 24 hours; 0 or off for a Power BI view that updates itself. The server judges the range of the view's kind. */
export function biRefreshSeconds(value: string): number {
  const text = value.trim();
  if (text === "0" || text.toLowerCase() === "off") return 0;
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : snoozeDurationMs(text);
  const seconds = ms === undefined ? NaN : Math.round(ms / 1000);
  if (!Number.isFinite(seconds) || seconds < BI_REFRESH_MIN_S || seconds > BI_REFRESH_MAX_S) {
    throw usageError("--refresh takes a cadence from 30s to 24h, such as 30s, 5m, 1h or a number of seconds, or 0 for none (a Power BI or Tableau view that updates itself).");
  }
  return seconds;
}

export function biRotateOption(value: string): string {
  biRotateSeconds(value);
  return value;
}

/** --rotate: how long each page (Power BI) or sheet (Tableau) shows, 10 seconds to 1 hour; 0 or off shows one. */
export function biRotateSeconds(value: string): number {
  const text = value.trim();
  if (text === "0" || text.toLowerCase() === "off") return 0;
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : snoozeDurationMs(text);
  const seconds = ms === undefined ? NaN : Math.round(ms / 1000);
  if (!Number.isFinite(seconds) || seconds < BI_ROTATE_MIN_S || seconds > BI_ROTATE_MAX_S) {
    throw usageError("--rotate takes how long each page or sheet shows, from 10s to 1h, such as 30s or 2m, or 0 for one.");
  }
  return seconds;
}

type Handler = Parameters<typeof commandHandler>[0];
type Args = Parameters<Handler>[0];
type Runtime = Parameters<Handler>[1];

/** Read the secret from a file or stdin, never an argument. */
async function readToken(file: string, runtime: Runtime, what = "token"): Promise<string> {
  const text = (await readAuthoringText(file, runtime, TOKEN_FILE_MAX_BYTES)).trim();
  if (!text) throw usageError(`${file === "-" ? "stdin" : file} holds no ${what}.`);
  if (/\s/.test(text)) throw usageError(`${file === "-" ? "stdin" : file} must hold only the ${what}: one value without spaces or line breaks.`);
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
      "Fix the connection as the detail says (Grafana: a Viewer service-account token; Power BI: the app's client secret value, the Embed content in apps and Service principals can call Fabric public APIs tenant settings and the app's role in the workspace; Tableau: the connected app is enabled, its client id, secret id and secret value belong together, and the user exists on the site), update it with bi connection update, then test it.");
  }
  if (problem.code === "bi_upstream_unavailable") {
    return withNext(connection ? `screenrig bi connection test ${id}` : "screenrig bi connection list",
      "Check that the system is reachable (Grafana: its address and the Image Renderer plugin or a remote rendering service; Tableau: the server or Tableau Cloud pod address), then test the connection again. Nothing was changed.");
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
    ...(connection.kind === "powerbi"
      ? [`tenant: ${dash(connection.config?.tenant_id)}`, `app (client id): ${dash(connection.config?.client_id)}`]
      : connection.kind === "tableau"
        ? [`url: ${dash(connection.config?.url)}`, `site: ${connection.config?.site || "(default site)"}`, `app (client id): ${dash(connection.config?.client_id)}`,
          `secret id: ${dash(connection.config?.secret_id)}`, `user: ${dash(connection.config?.username)}`]
        : [`url: ${dash(connection.config?.url)}`, `org: ${connection.config?.org_id ?? 1}`]),
    `secret: ${connection.secret?.set ? `set${connection.secret.hint ? ` (ends ${connection.secret.hint})` : ""}` : "not set"}`,
    ...(connection.embed_origin ? [`embed origin: ${connection.embed_origin}`] : []),
    `last test: ${test ? `${test.ok ? "ok" : "failed"} at ${test.at}` : "never"}`,
    ...(test ? checkLines(test.checks) : []),
    `revision: ${connection.revision}`,
  ];
}

export function connectionTableLines(items: BiConnection[]): string[] {
  if (!items.length) return ["No connections"];
  return table(["ID", "KIND", "NAME", "URL OR TENANT", "TEST"], items.map((item) => [
    item.id, item.kind, item.name, dash(item.kind === "powerbi" ? item.config?.tenant_id : item.config?.url), item.last_test ? (item.last_test.ok ? "ok" : "failed") : "never",
  ]));
}

function targetText(view: BiView): string {
  const target = view.target ?? {};
  if (view.kind === "tableau") {
    const parts = [target.public_url ? `Tableau Public ${target.public_url}` : `view ${target.view ?? "?"}`];
    if (target.rotate_sheets) parts.push(view.rotate_s ? `every sheet each ${view.rotate_s}s` : "every sheet");
    return parts.join(", ");
  }
  if (target.public_url) return `public link ${target.public_url}`;
  if (view.kind === "powerbi" || target.report_id) {
    const parts = [`report ${target.report_id ?? "?"}`, `workspace ${target.workspace_id ?? "?"}`];
    if (target.pages?.length) parts.push(`pages ${target.pages.join(", ")}`);
    if (target.rotate_all_pages) parts.push("every page");
    if (view.rotate_s) parts.push(`each ${view.rotate_s}s`);
    return parts.join(", ");
  }
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
    `refresh: ${view.refresh_s === 0 ? "never" : `every ${view.refresh_s}s`}`,
    ...(view.kind === "powerbi" || view.kind === "tableau" ? [] : [`fit: ${view.fit}`]),
    `status: ${status.last_error ? `${status.last_error.code} (${status.last_error.detail})` : status.last_ok_at ? `ok since ${status.last_ok_at}` : "not shown yet"}`,
    `embed_url: ${view.embed_url ?? "(none: this server has no embed host)"}`,
    `revision: ${view.revision}`,
  ];
}

export function viewTableLines(items: BiView[]): string[] {
  if (!items.length) return ["No views"];
  return table(["ID", "NAME", "SHOWS", "REFRESH", "STATUS"], items.map((item) => [
    item.id, item.name, targetText(item), item.refresh_s === 0 ? "never" : `${item.refresh_s}s`, item.status?.last_error ? item.status.last_error.code : item.status?.last_ok_at ? "ok" : "new",
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

export const handleBiConnectionCreatePowerBI = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const tenant = flagString(args.flags, "tenant-id");
  const clientId = flagString(args.flags, "client-id");
  const secretFile = flagString(args.flags, "secret-file");
  if (tenant === undefined || clientId === undefined || secretFile === undefined) {
    throw usageError("bi connection create powerbi requires --tenant-id, --client-id and --secret-file.");
  }
  const secret = await readToken(secretFile, runtime, "client secret");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await biCall(client, {
    method: "POST", path: CONNECTIONS_PATH, idempotent: true,
    body: { name: biName(flagString(args.flags, "name") ?? "Power BI"), kind: "powerbi", config: { tenant_id: tenant, client_id: clientId }, secret },
  });
  const created = response.body as BiConnection | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Created connection ${created?.id ?? ""}`.trimEnd(), ...connectionLines(created),
      "", `Next: screenrig bi connection test ${created?.id ?? "ID"}`].join("\n"),
  };
});

export const handleBiConnectionCreateTableau = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const url = flagString(args.flags, "url");
  const site = flagText(args.flags, "site");
  const clientId = flagString(args.flags, "client-id");
  const secretId = flagString(args.flags, "secret-id");
  const username = flagString(args.flags, "username");
  const secretFile = flagString(args.flags, "secret-file");
  if (url === undefined || clientId === undefined || secretId === undefined || username === undefined || secretFile === undefined) {
    throw usageError("bi connection create tableau requires --url, --client-id, --secret-id, --username and --secret-file.");
  }
  const secret = await readToken(secretFile, runtime, "secret value");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await biCall(client, {
    method: "POST", path: CONNECTIONS_PATH, idempotent: true,
    body: {
      name: biName(flagString(args.flags, "name") ?? biHostName(url, "Tableau")), kind: "tableau",
      config: { url, ...(site ? { site } : {}), client_id: clientId, secret_id: secretId, username }, secret,
    },
  });
  const created = response.body as BiConnection | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Created connection ${created?.id ?? ""}`.trimEnd(), ...connectionLines(created),
      ...(created?.embed_origin ? ["", `Add ${created.embed_origin} to the connected app's domain allowlist in Tableau.`] : []),
      "", `Next: screenrig bi connection test ${created?.id ?? "ID"}`].join("\n"),
  };
});

/** A flag's value even when it is empty (--site "" is Tableau Server's default site). */
function flagText(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function biHostName(url: string, fallback = "Grafana"): string {
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
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
  const tenant = flagString(args.flags, "tenant-id");
  const clientId = flagString(args.flags, "client-id");
  const site = flagBool(args.flags, "default-site") ? "" : flagText(args.flags, "site");
  const secretId = flagString(args.flags, "secret-id");
  const username = flagString(args.flags, "username");
  const tokenFile = flagString(args.flags, "token-file");
  const secretFile = flagString(args.flags, "secret-file");
  if (tokenFile !== undefined && secretFile !== undefined) throw usageError("Give --token-file or --secret-file, not both: each is the connection's secret.");
  const secretSource = tokenFile ?? secretFile;
  if ([name, url, orgId, tenant, clientId, site, secretId, username, secretSource].every((value) => value === undefined)) {
    throw usageError("bi connection update requires --name, --url, --org-id, --tenant-id, --client-id, --site, --default-site, --secret-id, --username, --token-file or --secret-file.");
  }
  const config = {
    ...(url !== undefined ? { url } : {}), ...(orgId !== undefined ? { org_id: Number(orgId) } : {}),
    ...(tenant !== undefined ? { tenant_id: tenant } : {}), ...(clientId !== undefined ? { client_id: clientId } : {}),
    ...(site !== undefined ? { site } : {}), ...(secretId !== undefined ? { secret_id: secretId } : {}), ...(username !== undefined ? { username } : {}),
  };
  const body = {
    ...(name !== undefined ? { name: biName(name) } : {}),
    ...(Object.keys(config).length ? { config } : {}),
    ...(secretSource !== undefined ? { secret: await readToken(secretSource, runtime, secretFile !== undefined ? "client secret" : "token") } : {}),
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
  const workspace = flagString(args.flags, "workspace");
  if (dashboard !== undefined && workspace !== undefined) throw usageError("Give --dashboard (Grafana) or --workspace (Power BI), not both.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const items: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  const scope = { ...(dashboard !== undefined ? { dashboard } : {}), ...(workspace !== undefined ? { workspace } : {}) };
  let response = await biCall(client, { method: "GET", path: `${CONNECTIONS_PATH}/${id}/browse`, query: { ...(query !== undefined ? { query } : {}), ...scope } }, id);
  for (let pages = 0; pages < 100; pages++) {
    items.push(...listBody<Record<string, unknown>>(response));
    cursor = (response.body as BiList<unknown> | undefined)?.next_cursor ?? undefined;
    if (!cursor) break;
    response = await biCall(client, { method: "GET", path: `${CONNECTIONS_PATH}/${id}/browse`, query: { ...(query !== undefined ? { query } : {}), cursor } }, id);
  }
  const heading = (response.body as { dashboard?: { uid: string; title: string } } | undefined)?.dashboard;
  const text = (item: Record<string, unknown>, key: string) => String(item[key] ?? "");
  let lines: string[];
  if (dashboard !== undefined) {
    lines = [`Panels of ${heading?.title ?? dashboard} (${items.length})`, ...table(["PANEL", "TYPE", "TITLE"], items.map((item) => [text(item, "id"), text(item, "type"), text(item, "title")]))];
  } else if (workspace !== undefined) {
    lines = [`Reports in workspace ${workspace} (${items.length})`, ...table(["REPORT", "NAME"], items.map((item) => [text(item, "id"), text(item, "name")])),
      ...(items.length ? ["", `Next: screenrig bi view create --connection-id ${id} --workspace ${workspace} --report REPORT`] : [])];
  } else if (items.some((item) => "uid" in item)) {
    lines = [`Dashboards (${items.length})`, ...table(["UID", "FOLDER", "TITLE"], items.map((item) => [text(item, "uid"), text(item, "folder"), text(item, "title")]))];
  } else if (items.some((item) => "path" in item)) {
    lines = [`Views (${items.length})`, ...table(["VIEW", "NAME"], items.map((item) => [text(item, "path"), text(item, "name")])),
      "", `Next: screenrig bi view create --connection-id ${id} --view WORKBOOK/VIEW`];
  } else {
    lines = [`Workspaces (${items.length})`, ...table(["WORKSPACE", "NAME"], items.map((item) => [text(item, "id"), text(item, "name")])),
      ...(items.length ? ["", `Next: screenrig bi connection browse ${id} --workspace WORKSPACE`] : [])];
  }
  return {
    envelope: jsonBody({ ...response, body: { ...(heading ? { dashboard: heading } : {}), ...((response.body as { workspace?: unknown } | undefined)?.workspace ? { workspace: (response.body as { workspace: unknown }).workspace } : {}), items, next_cursor: null } }, client.requestId),
    exitCode: ExitCode.Success,
    human: lines.join("\n"),
  };
});

// ---- views

/** The Workbook/View a Tableau address or a bare Workbook/View names, if it does. */
function tableauPath(url: string): string | undefined {
  const named = /\/(?:views|viz|vizhome)\/([^/?#]+)\/([^/?#]+)/.exec(url);
  if (named) return `${named[1]}/${named[2]}`;
  return /^[^/:\s]+\/[^/:\s]+$/.test(url.trim()) ? url.trim() : undefined;
}

function nameFromAddress(url: string | undefined, dashboard: string | undefined, report: string | undefined, view?: string): string {
  const path = view ?? (url !== undefined ? tableauPath(url) : undefined);
  if (path !== undefined) return [..."Tableau " + path].slice(0, NAME_MAX).join("");
  if (report !== undefined || (url !== undefined && /\/reports\/|reportEmbed/i.test(url))) return "Power BI report";
  const uid = dashboard ?? (url ? /\/d(?:-solo)?\/([^/?#]+)/.exec(url)?.[1] : undefined);
  return uid ? `Grafana ${uid}` : "Grafana dashboard";
}

/** The kind of a view of a public link: Power BI links are on powerbi.com, Tableau Public links on public.tableau.com, anything else is Grafana. */
export function publicLinkKind(link: string): "powerbi" | "tableau" | "grafana" {
  try {
    const host = new URL(link).hostname.toLowerCase();
    if (host === "public.tableau.com") return "tableau";
    return host === "powerbi.com" || host.endsWith(".powerbi.com") ? "powerbi" : "grafana";
  } catch {
    return "grafana";
  }
}

/** The target flags a create or update can carry besides --url, --dashboard and --public-url. */
const TARGET_FLAGS = ["panel", "from", "to", "var", "theme", "timezone", "workspace", "report", "page", "view"] as const;

function targetFromFlags(args: Args, base: BiTarget | undefined): BiTarget {
  const target: BiTarget = { ...(base ?? {}), ...(base?.vars ? { vars: { ...base.vars } } : {}), ...(base?.pages ? { pages: [...base.pages] } : {}) };
  const dashboard = flagString(args.flags, "dashboard");
  if (dashboard !== undefined) {
    for (const key of Object.keys(target) as Array<keyof BiTarget>) delete target[key];
    target.dashboard_uid = dashboard;
  }
  const workspace = flagString(args.flags, "workspace");
  const report = flagString(args.flags, "report");
  if (workspace !== undefined || report !== undefined) {
    // A new report starts a new target; the one it replaces keeps its workspace if only --report is given.
    const keptWorkspace = base?.workspace_id;
    for (const key of Object.keys(target) as Array<keyof BiTarget>) delete target[key];
    const chosen = workspace ?? keptWorkspace;
    if (chosen !== undefined) target.workspace_id = chosen;
    if (report !== undefined) target.report_id = report;
  }
  const tableauView = flagString(args.flags, "view");
  if (tableauView !== undefined) {
    // A new view starts a new target; whether it turns sheets stays as it was.
    const rotating = target.rotate_sheets;
    for (const key of Object.keys(target) as Array<keyof BiTarget>) delete target[key];
    target.view = tableauView;
    if (rotating) target.rotate_sheets = true;
  }
  if (flagBool(args.flags, "rotate-sheets")) target.rotate_sheets = true;
  const pages = flagString(args.flags, "page");
  if (pages !== undefined) {
    target.pages = JSON.parse(pages) as string[];
    delete target.rotate_all_pages;
  }
  if (flagBool(args.flags, "all-pages")) {
    target.rotate_all_pages = true;
    delete target.pages;
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
  return [
    ...TARGET_FLAGS.filter((flag) => flagString(args.flags, flag) !== undefined),
    ...(flagBool(args.flags, "all-pages") ? ["all-pages" as const] : []),
    ...(flagBool(args.flags, "rotate-sheets") ? ["rotate-sheets" as const] : []),
  ].map((flag) => `--${flag}`);
}

export const handleBiViewCreate = commandHandler(async (args: Args, runtime: Runtime, resolved) => {
  const connectionId = flagString(args.flags, "connection-id");
  const url = flagString(args.flags, "url");
  const dashboard = flagString(args.flags, "dashboard");
  const report = flagString(args.flags, "report");
  const workspace = flagString(args.flags, "workspace");
  const publicUrl = flagString(args.flags, "public-url");
  const tableauView = flagString(args.flags, "view");
  const rotateSheets = flagBool(args.flags, "rotate-sheets");
  const refresh = flagString(args.flags, "refresh");
  const rotate = flagString(args.flags, "rotate");
  const fit = flagString(args.flags, "fit");
  // --rotate-sheets sits beside --url and --public-url: the address names the view, the flag turns its sheets.
  const given = viewTargetFlagsGiven(args).filter((flag) => flag !== "--rotate-sheets");
  let body: Record<string, unknown>;
  if (publicUrl !== undefined) {
    if (connectionId !== undefined || url !== undefined || dashboard !== undefined || given.length) {
      throw usageError("--public-url needs no connection: give it alone, with --name, --refresh, --fit and --rotate-sheets.");
    }
    const kind = publicLinkKind(publicUrl);
    const named = kind === "tableau" ? `Tableau Public ${tableauPath(publicUrl) ?? "viz"}` : kind === "powerbi" ? "Power BI public report" : "Grafana public dashboard";
    body = { kind, name: flagString(args.flags, "name") ?? [...named].slice(0, NAME_MAX).join(""), target: { public_url: publicUrl, ...(rotateSheets ? { rotate_sheets: true } : {}) } };
  } else {
    if (connectionId === undefined) throw usageError("bi view create requires --connection-id with --url, --dashboard, --view or --workspace and --report, or --public-url alone.");
    if (url !== undefined && (dashboard !== undefined || given.length)) {
      throw usageError(`With --url the target comes from the address; to set ${given.join(", ") || "--dashboard"} give --dashboard UID (Grafana), --workspace and --report (Power BI) or --view (Tableau) instead.`);
    }
    if (url === undefined && dashboard === undefined && report === undefined && workspace === undefined && tableauView === undefined) {
      throw usageError("bi view create requires --url, --dashboard (Grafana), --workspace and --report (Power BI) or --view (Tableau) with --connection-id.");
    }
    if ((workspace === undefined) !== (report === undefined)) throw usageError("--workspace and --report are given together: the workspace and the report in it.");
    if (dashboard !== undefined && report !== undefined) throw usageError("Give --dashboard (Grafana), --workspace and --report (Power BI) or --view (Tableau), not several.");
    body = {
      connection_id: connectionId,
      name: flagString(args.flags, "name") ?? nameFromAddress(url, dashboard, report, tableauView),
      ...(url !== undefined ? { url, ...(rotateSheets ? { target: { rotate_sheets: true } } : {}) } : { target: targetFromFlags(args, undefined) }),
    };
  }
  body.name = biName(String(body.name));
  if (refresh !== undefined) body.refresh_s = biRefreshSeconds(refresh);
  if (rotate !== undefined) body.rotate_s = biRotateSeconds(rotate);
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
  const workspace = flagString(args.flags, "workspace");
  const report = flagString(args.flags, "report");
  const publicUrl = flagString(args.flags, "public-url");
  const rotateSheets = flagBool(args.flags, "rotate-sheets");
  const refresh = flagString(args.flags, "refresh");
  const rotate = flagString(args.flags, "rotate");
  const fit = flagString(args.flags, "fit");
  // --rotate-sheets sits beside --url and --public-url, and on its own turns the current view's sheets.
  const given = viewTargetFlagsGiven(args).filter((flag) => flag !== "--rotate-sheets");
  const changesTarget = url !== undefined || dashboard !== undefined || publicUrl !== undefined || given.length > 0 || rotateSheets;
  if (name === undefined && refresh === undefined && rotate === undefined && fit === undefined && !changesTarget) {
    throw usageError("bi view update requires something to change: --name, --refresh, --rotate, --fit, --url, --dashboard, --workspace, --report, --view, --page, --all-pages, --rotate-sheets, --public-url or a target flag.");
  }
  if (dashboard !== undefined && (workspace !== undefined || report !== undefined)) throw usageError("Give --dashboard (Grafana), --workspace and --report (Power BI) or --view (Tableau), not several.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const body: Record<string, unknown> = {};
  if (name !== undefined) body.name = biName(name);
  if (refresh !== undefined) body.refresh_s = biRefreshSeconds(refresh);
  if (rotate !== undefined) body.rotate_s = biRotateSeconds(rotate);
  if (fit !== undefined) body.fit = fit;
  if (publicUrl !== undefined) {
    if (url !== undefined || dashboard !== undefined || given.length) throw usageError("--public-url replaces the whole target: give it without the other target flags.");
    body.target = { public_url: publicUrl, ...(rotateSheets ? { rotate_sheets: true } : {}) };
  } else if (url !== undefined) {
    if (dashboard !== undefined || given.length) throw usageError("--url replaces the whole target from the address: give it without the other target flags.");
    body.url = url;
    if (rotateSheets) body.target = { rotate_sheets: true };
  } else if (dashboard !== undefined || given.length || rotateSheets) {
    // --dashboard starts a new target; --workspace and --report start a new report; the other flags change the current target.
    const current = dashboard !== undefined ? undefined : ((await biCall(client, { method: "GET", path: `${VIEWS_PATH}/${id}` }, id)).body as BiView).target;
    if (current?.public_url && given.length) throw usageError("This view shows a public link: change it with --public-url, or create a view of a connection.");
    body.target = targetFromFlags(args, current);
  } else if (rotate !== undefined && biRotateSeconds(rotate) === 0) {
    // Turning rotation off also stops a Tableau view from turning its sheets.
    const current = ((await biCall(client, { method: "GET", path: `${VIEWS_PATH}/${id}` }, id)).body as BiView).target;
    if (current?.rotate_sheets) {
      const { rotate_sheets: _turning, ...kept } = current;
      body.target = kept;
    }
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
        ...(report?.ok ? [] : ["", "Next: screenrig bi connection test ID, with the view's connection, checks the credentials themselves."])].join("\n"),
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
