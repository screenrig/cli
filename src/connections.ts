import { readAuthoringText } from "./authoring-input.js";
import { biClientId, biName, biTenantId } from "./bi.js";
import { requireToken, type ApiClient } from "./client.js";
import { CONNECTION_ID_PATTERN } from "./connection-ids.js";
import { clientFor, commandHandler, jsonBody } from "./commands.js";
import { flagString, type ParsedArgs } from "./command-input.js";
import { successEnvelope, type Warning } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { quotedRevision } from "./if-match.js";
import { CliError, usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";
import { readServiceAccountKey } from "./service-account-key.js";
import { table } from "./webhooks.js";

// Project connections: /api/connections. A connection is the project's reusable
// access to Microsoft or Google for sources that run unattended. A microsoft365
// or google_calendar data source, a Power BI connection and a SharePoint media
// sync account name one (connection_id) instead of carrying credentials of
// their own. Mode own_app holds the customer's own application (a sealed secret
// the server never returns); mode screenrig_app uses screenRIG's application,
// which a person consents to through a one-time link.

const CONNECTIONS_PATH = "/api/connections";
export const CONNECTION_PROVIDERS = ["microsoft", "google"] as const;
export const CONNECTION_MODES = ["own_app", "screenrig_app"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];
export type ConnectionMode = (typeof CONNECTION_MODES)[number];
const SECRET_FILE_MAX_BYTES = 20 * 1024;
/** ConnectionWrite.secret: a Microsoft client secret is at most 1024 characters, a Google key file at most 16384. */
const CLIENT_SECRET_MAX_CHARACTERS = 1024;
const KEY_FILE_MAX_CHARACTERS = 16_384;

export interface ConnectionCheck { name: string; ok: boolean; warn?: boolean; detail?: string }
export interface ConnectionTest { at: string; ok: boolean; checks: ConnectionCheck[] }
export interface Connection {
  id: string; project_id?: string; provider: ConnectionProvider; mode: ConnectionMode; name: string;
  status: "pending_consent" | "ready" | "error";
  last_error: { code: string; message: string; at: string } | null;
  /** Never a secret: the Microsoft tenant and app, the Google service account, or the account that granted access. */
  config: { tenant_id?: string; client_id?: string; service_account?: string; account?: string };
  secret: { set: boolean; hint: string };
  last_test: ConnectionTest | null;
  revision: number; created_at?: string; updated_at?: string;
  /** Only the answer of a write that made a consent link (create in mode screenrig_app, connect). */
  consent_url?: string; consent_expires_at?: string;
}
interface Page<T> { items: T[]; next_cursor: string | null }

export function connectionId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`connection ${command} requires <id>.`);
  if (!CONNECTION_ID_PATTERN.test(value)) {
    throw usageError("A connection id looks like pcn_ followed by letters, digits, - or _.", {
      command: "screenrig connection list",
      reason: "List this project's connections and their ids.",
    });
  }
  return value;
}

/** The Microsoft client secret's value from a file or stdin: one value, never spaces or line breaks. */
async function readClientSecret(file: string, runtime: CliRuntime): Promise<string> {
  const where = file === "-" ? "stdin" : file;
  const text = (await readAuthoringText(file, runtime, SECRET_FILE_MAX_BYTES)).trim();
  if (!text) throw usageError(`${where} holds no client secret.`);
  if (/\s/.test(text)) throw usageError(`${where} must hold only the client secret's Value: one value without spaces or line breaks.`);
  if ([...text].length > CLIENT_SECRET_MAX_CHARACTERS) throw usageError(`The client secret in ${where} is longer than ${CLIENT_SECRET_MAX_CHARACTERS} characters.`);
  return text;
}

/** The next step of the problems a connection call is known to answer. */
export function connectionProblem(error: unknown, id?: string): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.next) return error;
  const withNext = (command: string, reason: string) => new CliError({ ...problem, next: { command, reason } }, error.exitCode, error.warnings);
  switch (problem.code) {
    case "connection_app_not_configured":
      return withNext("screenrig connection create --help", "This server has no screenRIG application for that provider, so a screenrig_app connection cannot be made here. An own_app connection (your own Microsoft Entra app or Google service account key) works. Nothing was created.");
    case "connection_limit_reached":
      return withNext("screenrig connection list", "An organization has at most 50 connections across its projects. Delete one that nothing reads through (screenrig connection delete ID), then run create again. Nothing was created.");
    case "resource_conflict":
      return id ? withNext("screenrig source list", "A data source, a Power BI connection (bi connection list) or a media sync account (media sync account list) still reads through this connection; the detail names them. Move or delete those first, then delete the connection.") : error;
    case "revision_conflict":
      return id ? withNext(`screenrig connection show ${id}`, "Read the current revision, then run the command again with --expect-rev REVISION if the change still applies.") : error;
    case "not_found":
      return id ? withNext("screenrig connection list", "List this project's connections and their ids. A connection belongs to one project.") : error;
    default:
      return error;
  }
}

async function connectionCall(client: ApiClient, request: Parameters<ApiClient["call"]>[0], id?: string): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw connectionProblem(error, id);
  }
}

function revisionHeader(args: ParsedArgs): Record<string, string> | undefined {
  const revision = flagString(args.flags, "expect-rev");
  return revision ? { "if-match": quotedRevision(revision) } : undefined;
}

const dash = (value: string | undefined | null): string => (value && value.length ? value : "-");

function checkLines(checks: ConnectionCheck[] | undefined): string[] {
  return (checks ?? []).map((check) => `  ${!check.ok ? "failed" : check.warn ? "warning" : "ok"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
}

export function connectionLines(connection: Connection | undefined): string[] {
  if (!connection) return [];
  const test = connection.last_test;
  const config = connection.config ?? {};
  const own = connection.mode === "own_app";
  return [
    `id: ${connection.id}`,
    `name: ${connection.name}`,
    `provider: ${connection.provider}`,
    `mode: ${connection.mode}${own ? " (your own application)" : " (screenRIG's application)"}`,
    `status: ${connection.status}`,
    ...(connection.provider === "microsoft"
      ? [`tenant: ${dash(config.tenant_id)}${!own && !config.tenant_id ? " (set when the administrator has consented)" : ""}`, ...(own ? [`app (client id): ${dash(config.client_id)}`] : [])]
      : own ? [`service account: ${dash(config.service_account)}`] : [`account: ${dash(config.account)}${config.account ? " (a calendar source reads the calendars this account can see)" : ""}`]),
    ...(own ? [`secret: ${connection.secret?.set ? `set${connection.secret.hint ? ` (${connection.secret.hint})` : ""}` : "not set"}`] : []),
    ...(connection.last_error ? [`error: ${connection.last_error.code}: ${connection.last_error.message} (${connection.last_error.at})`] : []),
    `last test: ${test ? `${test.ok ? "ok" : "failed"} at ${test.at}` : "never"}`,
    ...(test ? checkLines(test.checks) : []),
    `revision: ${connection.revision}`,
  ];
}

export function connectionTableLines(items: Connection[]): string[] {
  if (!items.length) return ["No connections"];
  return table(["ID", "PROVIDER", "MODE", "NAME", "STATUS", "TENANT OR ACCOUNT", "TEST"], items.map((item) => [
    item.id, item.provider, item.mode, item.name, item.status,
    dash(item.config?.tenant_id ?? item.config?.account ?? item.config?.service_account), item.last_test ? (item.last_test.ok ? "ok" : "failed") : "never",
  ]));
}

/** What opening the consent link of a connection asks of the person who does. */
function consentWho(provider: ConnectionProvider): string {
  return provider === "microsoft"
    ? "the Microsoft 365 administrator, who consents to screenRIG's application for the tenant and then signs in to it"
    : "the holder of the Google account, who signs in and grants read-only access to the calendars the account can see";
}

/** The consent link of a connection that has one, as the lines a person sends on. */
function consentLines(connection: Connection | undefined): string[] {
  if (!connection?.consent_url) return [];
  return [
    "",
    `Consent link, for ${consentWho(connection.provider)}. Send it to that person only: it is the credential of one consent, and works once${connection.consent_expires_at ? ` until ${connection.consent_expires_at}` : ""}.`,
    `consent_url: ${connection.consent_url}`,
    "",
    `When they finish the connection is ready: screenrig connection show ${connection.id} reads its status and last_error. screenrig connection connect ${connection.id} makes a new link.`,
  ];
}

function consentWarnings(connection: Connection | undefined): Warning[] {
  if (!connection?.consent_url) return [];
  return [{
    code: "connection_consent_link",
    message: `data.consent_url is the link of one consent: send it to ${consentWho(connection.provider)}, who opens it${connection.consent_expires_at ? ` before ${connection.consent_expires_at}` : ""}. screenrig does not save it, and a read of the connection never shows it. screenrig connection connect ${connection.id} makes a new link, which replaces this one.`,
  }];
}

function listBody(response: { body: unknown }): Connection[] {
  const items = (response.body as Page<Connection> | undefined)?.items;
  return Array.isArray(items) ? items : [];
}

export const handleConnectionList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response: Awaited<ReturnType<ApiClient["call"]>>;
  try {
    response = await client.listAll(CONNECTIONS_PATH);
  } catch (error) {
    throw connectionProblem(error);
  }
  const items = listBody(response);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Connections (${items.length})`, ...connectionTableLines(items)].join("\n"),
  };
});

export const handleConnectionShow = commandHandler(async (args, runtime, resolved) => {
  const id = connectionId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await connectionCall(client, { method: "GET", path: `${CONNECTIONS_PATH}/${id}` }, id);
  const connection = response.body as Connection | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Connection", ...connectionLines(connection),
      ...(connection?.status === "pending_consent" ? ["", `No one has consented yet. screenrig connection connect ${connection.id} makes a consent link to send to the person who can.`] : [])].join("\n"),
  };
});

/** create microsoft and create google: the provider is the command's word after create. */
function createHandler(provider: ConnectionProvider) {
  return commandHandler(async (args, runtime, resolved) => {
    const mode = flagString(args.flags, "mode") as ConnectionMode | undefined;
    if (mode === undefined) throw usageError(`connection create ${provider} requires --mode own_app or --mode screenrig_app.`);
    const name = biName(flagString(args.flags, "name") ?? (provider === "microsoft" ? "Microsoft 365" : "Google Calendar"));
    let body: Record<string, unknown>;
    if (provider === "microsoft") {
      const tenant = flagString(args.flags, "tenant-id");
      const clientId = flagString(args.flags, "client-id");
      const secretFile = flagString(args.flags, "secret-file");
      if (mode === "screenrig_app") {
        if (tenant !== undefined || clientId !== undefined || secretFile !== undefined) {
          throw usageError("--mode screenrig_app uses screenRIG's own application, so it takes no --tenant-id, --client-id or --secret-file: the administrator who consents names the tenant.");
        }
        body = { provider, mode, name };
      } else {
        if (tenant === undefined || clientId === undefined || secretFile === undefined) {
          throw usageError("--mode own_app needs --tenant-id, --client-id and --secret-file: your Microsoft Entra app registration and the Value of one of its client secrets.");
        }
        body = { provider, mode, name, config: { tenant_id: biTenantId(tenant), client_id: biClientId(clientId) }, secret: await readClientSecret(secretFile, runtime) };
      }
    } else {
      const keyFile = flagString(args.flags, "service-account-key-file");
      if (mode === "screenrig_app") {
        if (keyFile !== undefined) throw usageError("--mode screenrig_app uses screenRIG's own application, so it takes no --service-account-key-file: the account holder who signs in grants access.");
        body = { provider, mode, name };
      } else {
        if (keyFile === undefined) throw usageError("--mode own_app needs --service-account-key-file: the service account's JSON key file.");
        body = { provider, mode, name, secret: await readServiceAccountKey(keyFile, runtime, KEY_FILE_MAX_CHARACTERS) };
      }
    }
    const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
    const response = await connectionCall(client, { method: "POST", path: CONNECTIONS_PATH, idempotent: true, body });
    const created = response.body as Connection | undefined;
    return {
      envelope: jsonBody(response, client.requestId, undefined, consentWarnings(created)),
      exitCode: ExitCode.Success,
      human: [`Created connection ${created?.id ?? ""}`.trimEnd(), ...connectionLines(created), ...consentLines(created),
        ...(created && !created.consent_url ? ["", `Next: screenrig connection test ${created.id}`] : [])].join("\n"),
    };
  });
}

export const handleConnectionCreateMicrosoft = createHandler("microsoft");
export const handleConnectionCreateGoogle = createHandler("google");

export const handleConnectionUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = connectionId(args.positionals[2], "update");
  const name = flagString(args.flags, "name");
  const tenant = flagString(args.flags, "tenant-id");
  const clientId = flagString(args.flags, "client-id");
  const secretFile = flagString(args.flags, "secret-file");
  const keyFile = flagString(args.flags, "service-account-key-file");
  if ([name, tenant, clientId, secretFile, keyFile].every((value) => value === undefined)) {
    throw usageError("connection update requires --name, --tenant-id, --client-id, --secret-file or --service-account-key-file.");
  }
  if (secretFile === "-" && keyFile === "-") throw usageError("--secret-file and --service-account-key-file cannot both read stdin.");
  const config = { ...(tenant !== undefined ? { tenant_id: biTenantId(tenant) } : {}), ...(clientId !== undefined ? { client_id: biClientId(clientId) } : {}) };
  const body = {
    ...(name !== undefined ? { name: biName(name) } : {}),
    ...(Object.keys(config).length ? { config } : {}),
    ...(secretFile !== undefined ? { secret: await readClientSecret(secretFile, runtime) }
      : keyFile !== undefined ? { secret: await readServiceAccountKey(keyFile, runtime, KEY_FILE_MAX_CHARACTERS) } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await connectionCall(client, { method: "PATCH", path: `${CONNECTIONS_PATH}/${id}`, idempotent: true, body, headers: revisionHeader(args) }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated connection ${id}`, ...connectionLines(response.body as Connection | undefined)].join("\n"),
  };
});

export const handleConnectionDelete = commandHandler(async (args, runtime, resolved) => {
  const id = connectionId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await connectionCall(client, { method: "DELETE", path: `${CONNECTIONS_PATH}/${id}`, idempotent: true, headers: revisionHeader(args) }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted connection ${id}. This does not end the vendor's side: a Microsoft 365 tenant keeps screenRIG's application until its administrator removes it, and a Google account keeps its grant until its holder revokes it.`,
  };
});

export const handleConnectionTest = commandHandler(async (args, runtime, resolved) => {
  const id = connectionId(args.positionals[2], "test");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await connectionCall(client, { method: "POST", path: `${CONNECTIONS_PATH}/${id}/test`, idempotent: true }, id);
  const report = response.body as ConnectionTest | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Connection ${id}: ${report?.ok ? "ok" : "failed"}`, ...checkLines(report?.checks),
      ...(report?.ok ? ["", "This signs in and checks the permissions the token carries. It does not judge a calendar's sharing, a mailbox access policy or a site grant: a source or a sync proves those when it runs."] : [])].join("\n"),
  };
});

export const handleConnectionConnect = commandHandler(async (args, runtime, resolved) => {
  const id = connectionId(args.positionals[2], "connect");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await connectionCall(client, { method: "POST", path: `${CONNECTIONS_PATH}/${id}/connect`, idempotent: true }, id);
  const connection = response.body as Connection | undefined;
  return {
    envelope: jsonBody(response, client.requestId, undefined, consentWarnings(connection)),
    exitCode: ExitCode.Success,
    human: [`Made a new consent link for connection ${id}. Any earlier link no longer works; a connection that works stays as it is until the new consent completes.`, ...connectionLines(connection), ...consentLines(connection)].join("\n"),
  };
});
