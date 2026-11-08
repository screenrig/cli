import { readAuthoringText } from "./authoring-input.js";
import type { ApiClient } from "./client.js";
import { requireToken } from "./client.js";
import { clientFor, commandHandler, jsonBody } from "./commands.js";
import { flagBool, flagString } from "./command-input.js";
import type { ParsedArgs } from "./command-input.js";
import { successEnvelope, type Warning } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { quotedRevision } from "./if-match.js";
import { snoozeDurationMs } from "./notifications.js";
import { CliError, usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";
import { readServiceAccountKey } from "./service-account-key.js";
import { table } from "./webhooks.js";

// Media sync: a SharePoint, OneDrive for work, Dropbox or Google Drive folder kept
// in step with a media folder. /api/media-sync-accounts is what syncs read
// through: the project's own Microsoft Entra app (its client secret is sealed by
// the server and never returned), a Dropbox account that a person connects by
// opening a link in a browser (which the CLI only prints), or a Google Drive
// service account (screenRIG's, or the project's own key, sealed the same way);
// /api/media-syncs is one source. A folder selector on the media folder plays
// what the sync imports.

const ACCOUNTS_PATH = "/api/media-sync-accounts";
const SYNCS_PATH = "/api/media-syncs";
const DROPBOX_CALLBACK_PATH = "/api/dropbox/callback";

/** Backend MediaSyncAccount.id and MediaSync.id shapes (vendor/openapi.yaml). */
export const MEDIA_SYNC_ACCOUNT_ID_PATTERN = /^(?:(?:stage|qa|development)_)?msa_[A-Za-z0-9_-]+$/;
export const MEDIA_SYNC_ID_PATTERN = /^(?:(?:stage|qa|development)_)?msy_[A-Za-z0-9_-]+$/;
const MEDIA_FOLDER_ID_PATTERN = /^(?:(?:stage|qa|development)_)?mfd_[A-Za-z0-9]{1,64}$/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** MediaSyncAccountWrite.config.app_key: the app key of the customer's own Dropbox app. */
const DROPBOX_APP_KEY_PATTERN = /^[A-Za-z0-9]{1,64}$/;
/** A Google Drive folder's id, as the last segment of its address. */
const DRIVE_FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,4096}$/;
export const MEDIA_SYNC_EVERY_MIN_S = 300;
export const MEDIA_SYNC_EVERY_MAX_S = 86_400;
const SECRET_FILE_MAX_BYTES = 8192;
/** MediaSyncAccountWrite.secret for a google_drive account: the service account's JSON key, at most 8192 characters. */
const KEY_FILE_MAX_CHARACTERS = 8192;
const NAME_MAX = 80;
const URL_MAX = 4096;

export interface MediaSyncCheck { name: string; ok: boolean; warn?: boolean; detail?: string }
export interface MediaSyncTest { at: string; ok: boolean; checks: MediaSyncCheck[] }
export interface MediaSyncAccount {
  id: string; project_id?: string; kind: string; name: string;
  config: {
    tenant_id?: string; client_id?: string; connection_id?: string;
    /** Dropbox: who connected it, and the customer's own app, when the account has one. */
    display_name?: string; email?: string; dropbox_account_id?: string; app_key?: string;
    /** Google Drive: the address a folder is shared with. */
    service_account_email?: string;
  };
  secret: { set: boolean; hint: string };
  state: string; last_test?: MediaSyncTest | null;
  /** Only the answer of a write that made a consent link (add dropbox, connect). */
  authorize_url?: string; authorize_expires_at?: string;
  revision: number; created_at?: string; updated_at?: string;
}
export interface MediaSyncSkipped { name: string; reason: string; detail?: string }
export interface MediaSyncRun {
  at: string; status: string; added: number; updated: number; removed: number; pending_delete: number;
  skipped?: MediaSyncSkipped[]; skipped_total: number; error?: { code: string; detail: string };
}
export interface MediaSync {
  id: string; project_id?: string; account_id: string; provider: string; name: string; folder_id: string;
  every_s: number; state: string;
  source: { web_url?: string; drive_id?: string; item_id?: string; path?: string; shared_by?: string };
  next_run_at: string; last_run?: MediaSyncRun | null; revision: number; created_at?: string; updated_at?: string;
}
interface Page<T> { items: T[]; next_cursor: string | null }

export function mediaSyncAccountId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`media sync account ${command} requires <id>.`);
  if (!MEDIA_SYNC_ACCOUNT_ID_PATTERN.test(value)) {
    throw usageError("An account id looks like msa_ followed by letters, digits, - or _.", {
      command: "screenrig media sync account list",
      reason: "List this project's media sync accounts and their ids.",
    });
  }
  return value;
}

export function mediaSyncId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`media sync ${command} requires <id>.`);
  if (!MEDIA_SYNC_ID_PATTERN.test(value)) {
    throw usageError("A sync id looks like msy_ followed by letters, digits, - or _.", {
      command: "screenrig media sync list",
      reason: "List this project's media syncs and their ids.",
    });
  }
  return value;
}

/** --account-id: an msa_ id. */
export function mediaSyncAccountOption(value: string): string {
  if (!MEDIA_SYNC_ACCOUNT_ID_PATTERN.test(value)) {
    throw usageError("--account-id takes a media sync account id (msa_…).", {
      command: "screenrig media sync account list", reason: "List this project's media sync accounts and their ids.",
    });
  }
  return value;
}

/** --folder-id: an mfd_ media folder id. */
export function mediaSyncFolderOption(value: string): string {
  if (!MEDIA_FOLDER_ID_PATTERN.test(value)) {
    throw usageError("--folder-id takes a media folder id (mfd_…).", { command: "screenrig media folder list", reason: "List this project's media folders and their ids." });
  }
  return value;
}

export function mediaSyncName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > NAME_MAX || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw usageError(`--name must contain 1 to ${NAME_MAX} characters without controls.`);
  }
  return trimmed;
}

/** --tenant-id: the tenant's directory id (a GUID) or its primary domain; the multi-tenant authorities are refused. */
export function mediaSyncTenant(value: string): string {
  const tenant = value.trim();
  if (["common", "organizations", "consumers"].includes(tenant.toLowerCase())) {
    throw usageError("--tenant-id must be your organization's own tenant: its directory id or primary domain, not common, organizations or consumers.");
  }
  if (!GUID_PATTERN.test(tenant) && !TENANT_DOMAIN_PATTERN.test(tenant)) {
    throw usageError("--tenant-id takes the tenant's directory id (a GUID) or its primary domain, such as contoso.onmicrosoft.com.");
  }
  return tenant;
}

export function mediaSyncClientId(value: string): string {
  const client = value.trim();
  if (!GUID_PATTERN.test(client)) throw usageError("--client-id takes the app registration's application (client) id, a GUID.");
  return client;
}

/** An https address of at most URL_MAX characters, without controls. */
function isHttpsAddress(text: string): boolean {
  let address: URL | undefined;
  try {
    address = new URL(text);
  } catch {
    address = undefined;
  }
  return address !== undefined && address.protocol === "https:" && [...text].length <= URL_MAX && !/[\p{Cc}]/u.test(text);
}

/** --url of create sharepoint: a SharePoint folder address or sharing link. It is read by the server once and not stored. */
export function mediaSyncUrl(value: string): string {
  const text = value.trim();
  if (!isHttpsAddress(text)) throw usageError("--url takes the https address of a SharePoint folder, or its sharing link (Share → Copy link).");
  return text;
}

/** --url of create dropbox: the folder's address in Dropbox, a shared folder link the connected account has added, or a path that starts with /. */
export function mediaSyncDropboxUrl(value: string): string {
  const text = value.trim();
  const path = text.startsWith("/") && [...text].length <= URL_MAX && !/[\p{Cc}]/u.test(text);
  if (!path && !isHttpsAddress(text)) {
    throw usageError("--url takes the folder's address in Dropbox (https://www.dropbox.com/home/...), a shared folder link the connected account has added to its Dropbox, or a path that starts with /.");
  }
  return text;
}

/** --url of create google-drive: the folder's Google Drive address, or its id. */
export function mediaSyncDriveUrl(value: string): string {
  const text = value.trim();
  if (!isHttpsAddress(text) && !DRIVE_FOLDER_ID_PATTERN.test(text)) {
    throw usageError("--url takes the Google Drive folder's address (https://drive.google.com/drive/folders/ID) or its id.");
  }
  return text;
}

/** --app-key of add dropbox: the app key (never the app secret) of the customer's own Dropbox app. */
export function mediaSyncAppKey(value: string): string {
  const key = value.trim();
  if (!DROPBOX_APP_KEY_PATTERN.test(key)) {
    throw usageError("--app-key takes the app key of your own Dropbox app: 1 to 64 letters and digits, shown on its page in the Dropbox App Console.");
  }
  return key;
}

/** --every: seconds between runs, as 15m, 1h30m, 2h, 900s or plain seconds; 5 minutes through 24 hours. */
export function mediaSyncEvery(value: string): string {
  const text = value.trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : (snoozeDurationMs(text) ?? Number.NaN) / 1000;
  if (!Number.isInteger(seconds) || seconds < MEDIA_SYNC_EVERY_MIN_S || seconds > MEDIA_SYNC_EVERY_MAX_S) {
    throw usageError("--every takes a duration from 5 minutes to 24 hours, such as 15m, 1h or 6h (or plain seconds, 300 to 86400).");
  }
  return String(seconds);
}

async function readSecret(file: string, runtime: CliRuntime): Promise<string> {
  const text = (await readAuthoringText(file, runtime, SECRET_FILE_MAX_BYTES)).trim();
  const where = file === "-" ? "stdin" : file;
  if (!text) throw usageError(`${where} holds no secret.`);
  if (/\s/.test(text)) throw usageError(`${where} must hold only the client secret's value: one value without spaces or line breaks.`);
  return text;
}

/** Add the next step to the problems media sync is known to answer. */
export function mediaSyncProblem(error: unknown, id?: string): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.next) return error;
  const withNext = (command: string, reason: string) => new CliError({ ...problem, next: { command, reason } }, error.exitCode, error.warnings);
  const account = id !== undefined && MEDIA_SYNC_ACCOUNT_ID_PATTERN.test(id);
  if (problem.code === "media_sync_source_refused") {
    return withNext(account ? `screenrig media sync account test ${id}` : "screenrig media sync account list",
      "Fix what the detail says, then test the account and run the command again. Microsoft: the app's Sites.Selected grant on the site, or Files.Read.All, with admin consent, and a current client secret. Dropbox: the connected person must be able to open the folder, and a shared folder link must already be added to their Dropbox. Google Drive: share the folder with the account's service_account_email (Viewer is enough).");
  }
  if (problem.code === "media_sync_source_unavailable") {
    return withNext("screenrig media sync list", "The provider could not be reached. Nothing was changed; run the same command again in a moment.");
  }
  if (problem.code === "dropbox_reconnect_required") {
    return withNext(account ? `screenrig media sync account connect ${id}` : "screenrig media sync account list",
      "Dropbox no longer honors the account's connection. Make a new link and send it to the person who owns the Dropbox account; they open it signed in to Dropbox. Then run media sync account show until its state is ready.");
  }
  if (problem.code === "dropbox_not_configured") {
    return withNext("screenrig media sync account add dropbox --help",
      "This server has no screenRIG Dropbox app, so a Dropbox account needs the app key of your own Dropbox app: media sync account add dropbox --name NAME --app-key KEY.");
  }
  if (problem.code === "google_drive_not_configured") {
    return withNext("screenrig media sync account add google-drive --help",
      "This server has no screenRIG service account, so a Google Drive account needs the JSON key of your own Google Cloud service account: media sync account add google-drive --name NAME --key-file FILE.");
  }
  if (problem.code === "media_sync_sharer_not_member") {
    return withNext(account ? `screenrig media sync account show ${id}` : "screenrig media sync account list",
      "Share the folder with the account's service_account_email from the Google account of a member of this project whose email is verified, then create the sync again.");
  }
  if (problem.code === "resource_conflict" && account) {
    return withNext("screenrig media sync list", "Delete the syncs the detail names (media sync delete ID), then delete the account.");
  }
  if (problem.code === "revision_conflict" && id !== undefined) {
    return withNext(account ? `screenrig media sync account show ${id}` : `screenrig media sync show ${id}`,
      "Read the current revision, then run the command again with --expect-rev REVISION if the change still applies.");
  }
  if (problem.code === "not_found" && id !== undefined) {
    return account
      ? withNext("screenrig media sync account list", "List this project's accounts and their ids. An account belongs to one project.")
      : withNext("screenrig media sync list", "List this project's syncs and their ids. A sync belongs to one project.");
  }
  return error;
}

async function syncCall(client: ApiClient, request: Parameters<ApiClient["call"]>[0], id?: string): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw mediaSyncProblem(error, id);
  }
}

const dash = (value: string | undefined | null): string => (value && value.length ? value : "-");

function checkLines(checks: MediaSyncCheck[] | undefined): string[] {
  return (checks ?? []).map((check) => `  ${!check.ok ? "failed" : check.warn ? "warning" : "ok"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
}

const PROVIDER_NAMES: Record<string, string> = { microsoft365: "Microsoft", dropbox: "Dropbox", google_drive: "Google Drive" };
const providerName = (kind: string): string => PROVIDER_NAMES[kind] ?? kind;

/** Who connected a Dropbox account, or that no one has (its tokens are set once someone has). */
function dropboxPerson(account: MediaSyncAccount): string {
  const config = account.config ?? {};
  if (!config.display_name && !config.email) return account.secret?.set ? "connected" : "not connected";
  return `${config.display_name ?? config.email}${config.display_name && config.email ? ` (${config.email})` : ""}`;
}

/** What an account reads through: the lines that differ by kind. */
function accessLines(account: MediaSyncAccount): string[] {
  const config = account.config ?? {};
  if (account.kind === "dropbox") {
    return [`dropbox account: ${dropboxPerson(account)}`,
      `app: ${config.app_key ? `your own Dropbox app (app key ${config.app_key})` : "screenRIG's Dropbox app"}`];
  }
  if (account.kind === "google_drive") {
    return [`service account: ${dash(config.service_account_email)}`,
      `key: ${account.secret?.set ? `your own service account key${account.secret.hint ? ` (ends ${account.secret.hint})` : ""}` : "none of your own; the account reads through screenRIG's service account"}`];
  }
  if (account.kind !== "microsoft365") return [];
  return config.connection_id
    ? [`connection: ${config.connection_id} (a Microsoft connection signs in; this account holds no secret)`]
    : [`tenant: ${dash(config.tenant_id)}`, `client: ${dash(config.client_id)}`,
      `secret: ${account.secret?.set ? `set${account.secret.hint ? ` (ends ${account.secret.hint})` : ""}` : "not set"}`];
}

export function accountLines(account: MediaSyncAccount | undefined): string[] {
  if (!account) return [];
  const test = account.last_test;
  return [
    `id: ${account.id}`,
    `name: ${account.name}`,
    `kind: ${account.kind}`,
    ...accessLines(account),
    `state: ${account.state}`,
    `last test: ${test ? `${test.ok ? "ok" : "failed"} at ${test.at}` : "never"}`,
    ...(test ? checkLines(test.checks) : []),
    `revision: ${account.revision}`,
  ];
}

/** What to do about a Dropbox account that is not connected. */
function connectHintLines(account: MediaSyncAccount | undefined): string[] {
  if (account?.kind !== "dropbox") return [];
  if (account.state === "pending_consent") {
    return ["", `Waiting for the person who owns the Dropbox account to open the link: screenrig media sync account connect ${account.id} makes a new link to send them.`];
  }
  if (account.state === "reconnect_required") {
    return ["", `Dropbox no longer honors the connection: screenrig media sync account connect ${account.id} makes a new link for the person who owns the Dropbox account to open.`];
  }
  return [];
}

/** The address the customer's own Dropbox app lists as a redirect URI: the API origin this CLI talks to. */
function dropboxRedirectUri(apiUrl: string): string {
  return `${new URL(apiUrl).origin}${DROPBOX_CALLBACK_PATH}`;
}

/** The sentences that go with a consent link. The CLI prints the link and never opens a browser. ownApp: the command named the customer's own Dropbox app. */
function consentLines(account: MediaSyncAccount | undefined, apiUrl: string, ownApp = false): string[] {
  if (!account?.authorize_url) return [];
  const provider = providerName(account.kind);
  return [
    "",
    `Connect link, for the person who owns the ${provider} account. Send it to that person only, or open it yourself if that is you: it is the credential of one consent, and works once${account.authorize_expires_at ? ` until ${account.authorize_expires_at}` : ""}.`,
    `authorize_url: ${account.authorize_url}`,
    "",
    `They open it signed in to ${provider}${account.kind === "dropbox" ? " and allow screenRIG read-only access to the files in that Dropbox (files.metadata.read, files.content.read, account_info.read, sharing.read)" : ""}. The CLI never opens a browser.`,
    ...(ownApp || account.config?.app_key ? [`This account goes through your own Dropbox app, which must list ${dropboxRedirectUri(apiUrl)} as a redirect URI (Dropbox App Console, the app's Settings, OAuth 2) and have those permissions enabled.`] : []),
    `When they finish, screenrig media sync account show ${account.id} reads state ready. screenrig media sync account connect ${account.id} makes a new link, which replaces this one.`,
    ...(account.kind === "dropbox" ? [`Then: screenrig media sync create dropbox --account-id ${account.id} --url FOLDER`] : []),
  ];
}

function consentWarnings(account: MediaSyncAccount | undefined, apiUrl: string, ownApp = false): Warning[] {
  if (!account?.authorize_url) return [];
  const provider = providerName(account.kind);
  return [
    {
      code: "media_sync_consent_link",
      message: `data.authorize_url is the link of one consent: send it to the person who owns the ${provider} account, who opens it signed in to ${provider}${account.authorize_expires_at ? ` before ${account.authorize_expires_at}` : ""}. screenrig does not save it, and a read of the account never shows it. screenrig media sync account connect ${account.id} makes a new link, which replaces this one.`,
    },
    ...(ownApp || account.config?.app_key ? [{
      code: "media_sync_redirect_uri",
      message: `The account goes through your own Dropbox app, which must list ${dropboxRedirectUri(apiUrl)} as a redirect URI and have files.metadata.read, files.content.read, account_info.read and sharing.read enabled.`,
    }] : []),
  ];
}

/** What to do with a Google Drive account: share the folder with its address. */
function driveShareLines(account: MediaSyncAccount | undefined): string[] {
  const email = account?.config?.service_account_email;
  if (!account || !email) return [];
  return [
    "",
    `Share the Google Drive folder with ${email} (Viewer is enough).`,
    account.secret?.set
      ? "That is your own service account: a folder shared with it syncs."
      : "That is screenRIG's service account: a folder syncs through it only when a member of this project with a verified email shared it or owns it, so share it from that member's Google account.",
    `Then: screenrig media sync create google-drive --account-id ${account.id} --url FOLDER`,
  ];
}

function driveShareWarnings(account: MediaSyncAccount | undefined): Warning[] {
  const email = account?.config?.service_account_email;
  if (!account || !email) return [];
  return [{
    code: "media_sync_share_folder",
    message: `Share the Google Drive folder with ${email} (Viewer is enough), then run media sync create google-drive. ${account.secret?.set
      ? "That is your own service account: a folder shared with it syncs."
      : "That is screenRIG's service account: a folder syncs through it only when a member of this project with a verified email shared it or owns it."}`,
  }];
}

/** The account a row of the account table names, and the secret it holds, by kind. */
function accountSubject(item: MediaSyncAccount): string {
  const config = item.config ?? {};
  if (item.kind === "dropbox") return config.email ?? config.display_name ?? (item.secret?.set ? "connected" : "(not connected)");
  if (item.kind === "google_drive") return dash(config.service_account_email);
  return dash(config.tenant_id ?? config.connection_id);
}

function accountSecretCell(item: MediaSyncAccount): string {
  if (item.kind === "dropbox") return "-";
  if (item.config?.connection_id) return "via connection";
  if (item.kind === "google_drive" && !item.secret?.set) return "screenRIG's";
  return item.secret?.set ? (item.secret.hint ? `…${item.secret.hint}` : "set") : "not set";
}

function accountTableLines(items: MediaSyncAccount[]): string[] {
  if (!items.length) return ["No media sync accounts"];
  return table(["ID", "NAME", "KIND", "STATE", "ACCOUNT", "SECRET", "TEST"], items.map((item) => [
    item.id, item.name, item.kind, item.state, accountSubject(item), accountSecretCell(item),
    item.last_test ? (item.last_test.ok ? "ok" : "failed") : "never",
  ]));
}

function everyText(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function runLines(run: MediaSyncRun | null | undefined): string[] {
  if (!run) return ["last run: not yet"];
  const counts = `${run.added} added, ${run.updated} replaced, ${run.removed} removed${run.pending_delete ? `, ${run.pending_delete} held back` : ""}`;
  const lines = [`last run: ${run.status} at ${run.at} (${counts})`];
  if (run.error) lines.push(`  ${run.error.code}: ${run.error.detail}`);
  for (const skipped of run.skipped ?? []) lines.push(`  skipped ${skipped.name} (${skipped.reason})${skipped.detail ? `: ${skipped.detail}` : ""}`);
  if (run.skipped_total > (run.skipped?.length ?? 0)) lines.push(`  and ${run.skipped_total - (run.skipped?.length ?? 0)} more skipped`);
  return lines;
}

export function syncLines(sync: MediaSync | undefined): string[] {
  if (!sync) return [];
  return [
    `id: ${sync.id}`,
    `name: ${sync.name}`,
    `provider: ${sync.provider}`,
    `account: ${sync.account_id}`,
    `source: ${dash(sync.source?.web_url)}`,
    ...(sync.source?.path ? [`path: ${sync.source.path}`] : []),
    ...(sync.source?.shared_by ? [`shared by: ${sync.source.shared_by} (checked on every run)`] : []),
    `media folder: ${sync.folder_id}`,
    `every: ${everyText(sync.every_s)}`,
    `state: ${sync.state}`,
    `next run: ${sync.next_run_at}`,
    ...runLines(sync.last_run),
    `revision: ${sync.revision}`,
  ];
}

export function syncTableLines(items: MediaSync[]): string[] {
  if (!items.length) return ["No media syncs"];
  return table(["ID", "NAME", "PROVIDER", "FOLDER", "EVERY", "STATE", "LAST RUN"], items.map((item) => [
    item.id, item.name, item.provider, item.folder_id, everyText(item.every_s), item.state, item.last_run ? item.last_run.status : "not yet",
  ]));
}

const FOLDER_HINT = "Play it with a folder selector: {\"by\": \"folder\", \"folder_id\": \"FOLDER\"}.";

function listBody<T>(response: { body: unknown }): T[] {
  const items = (response.body as Page<T> | undefined)?.items;
  return Array.isArray(items) ? items : [];
}

/** A list command reads every page: the lists are not large, and an agent needs the whole set. */
async function allPages<T>(client: ApiClient, path: string, query?: Record<string, string>): Promise<{ items: T[]; response: Awaited<ReturnType<ApiClient["call"]>> }> {
  const items: T[] = [];
  let response = await syncCall(client, { method: "GET", path, ...(query ? { query } : {}) });
  for (let pages = 0; pages < 1000; pages++) {
    items.push(...listBody<T>(response));
    const cursor = (response.body as Page<T> | undefined)?.next_cursor ?? undefined;
    if (!cursor) break;
    response = await syncCall(client, { method: "GET", path, query: { ...(query ?? {}), cursor } });
  }
  return { items, response };
}

function revisionHeader(args: ParsedArgs): Record<string, string> | undefined {
  const revision = flagString(args.flags, "expect-rev");
  return revision ? { "if-match": quotedRevision(revision) } : undefined;
}

// ---- accounts (media sync account ...): path words are media sync account VERB [microsoft365|dropbox|google-drive] [ID]

export const handleMediaSyncAccountAdd = commandHandler(async (args, runtime, resolved) => {
  const name = flagString(args.flags, "name");
  const tenant = flagString(args.flags, "tenant-id");
  const client = flagString(args.flags, "client-id");
  const secretFile = flagString(args.flags, "secret-file");
  const connectionId = flagString(args.flags, "connection-id");
  if (name === undefined) throw usageError("media sync account add microsoft365 requires --name.");
  let body: Record<string, unknown>;
  if (connectionId !== undefined) {
    // A Microsoft connection of the project (either mode) signs in and holds the secret.
    if (tenant !== undefined || client !== undefined || secretFile !== undefined) {
      throw usageError("--connection-id replaces --tenant-id, --client-id and --secret-file: the Microsoft connection holds them.");
    }
    body = { kind: "microsoft365", name: mediaSyncName(name), config: { connection_id: connectionId } };
  } else {
    if (tenant === undefined || client === undefined || secretFile === undefined) {
      throw usageError("media sync account add microsoft365 requires --connection-id, or --tenant-id, --client-id and --secret-file.");
    }
    body = { kind: "microsoft365", name: mediaSyncName(name), config: { tenant_id: mediaSyncTenant(tenant), client_id: mediaSyncClientId(client) }, secret: await readSecret(secretFile, runtime) };
  }
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "POST", path: ACCOUNTS_PATH, idempotent: true, body });
  const created = response.body as MediaSyncAccount | undefined;
  return {
    envelope: jsonBody(response, api.requestId),
    exitCode: ExitCode.Success,
    human: [`Created media sync account ${created?.id ?? ""}`.trimEnd(), ...accountLines(created), "", `Next: screenrig media sync account test ${created?.id ?? "ID"}`].join("\n"),
  };
});

/** add dropbox: the account starts pending_consent and the answer carries the link a person opens to connect it. */
export const handleMediaSyncAccountAddDropbox = commandHandler(async (args, runtime, resolved) => {
  const name = flagString(args.flags, "name");
  const appKey = flagString(args.flags, "app-key");
  if (name === undefined) throw usageError("media sync account add dropbox requires --name.");
  const body = { kind: "dropbox", name: mediaSyncName(name), ...(appKey !== undefined ? { config: { app_key: mediaSyncAppKey(appKey) } } : {}) };
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "POST", path: ACCOUNTS_PATH, idempotent: true, body });
  const created = response.body as MediaSyncAccount | undefined;
  return {
    envelope: jsonBody(response, api.requestId, undefined, consentWarnings(created, resolved.apiUrl, appKey !== undefined)),
    exitCode: ExitCode.Success,
    human: [`Created media sync account ${created?.id ?? ""}`.trimEnd(), ...accountLines(created), ...consentLines(created, resolved.apiUrl, appKey !== undefined)].join("\n"),
  };
});

/** add google-drive: ready at once; the answer names the address a folder is shared with. */
export const handleMediaSyncAccountAddGoogleDrive = commandHandler(async (args, runtime, resolved) => {
  const name = flagString(args.flags, "name");
  const keyFile = flagString(args.flags, "key-file");
  if (name === undefined) throw usageError("media sync account add google-drive requires --name.");
  const body = { kind: "google_drive", name: mediaSyncName(name), ...(keyFile !== undefined ? { secret: await readServiceAccountKey(keyFile, runtime, KEY_FILE_MAX_CHARACTERS) } : {}) };
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "POST", path: ACCOUNTS_PATH, idempotent: true, body });
  const created = response.body as MediaSyncAccount | undefined;
  return {
    envelope: jsonBody(response, api.requestId, undefined, driveShareWarnings(created)),
    exitCode: ExitCode.Success,
    human: [`Created media sync account ${created?.id ?? ""}`.trimEnd(), ...accountLines(created), ...driveShareLines(created)].join("\n"),
  };
});

export const handleMediaSyncAccountConnect = commandHandler(async (args, runtime, resolved) => {
  const id = mediaSyncAccountId(args.positionals[4], "connect");
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "POST", path: `${ACCOUNTS_PATH}/${id}/connect`, idempotent: true }, id);
  const connecting = response.body as MediaSyncAccount | undefined;
  return {
    envelope: jsonBody(response, api.requestId, undefined, consentWarnings(connecting, resolved.apiUrl)),
    exitCode: ExitCode.Success,
    human: [`New connect link for media sync account ${id}. Any earlier link no longer works; a connected account stays connected until the new consent completes.`,
      ...accountLines(connecting), ...consentLines(connecting, resolved.apiUrl)].join("\n"),
  };
});

export const handleMediaSyncAccountList = commandHandler(async (args, runtime, resolved) => {
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const { items, response } = await allPages<MediaSyncAccount>(api, ACCOUNTS_PATH);
  return {
    envelope: jsonBody({ ...response, body: { items, next_cursor: null } }, api.requestId),
    exitCode: ExitCode.Success,
    human: [`Media sync accounts (${items.length})`, ...accountTableLines(items)].join("\n"),
  };
});

export const handleMediaSyncAccountShow = commandHandler(async (args, runtime, resolved) => {
  const id = mediaSyncAccountId(args.positionals[4], "show");
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "GET", path: `${ACCOUNTS_PATH}/${id}` }, id);
  const shown = response.body as MediaSyncAccount | undefined;
  return { envelope: jsonBody(response, api.requestId), exitCode: ExitCode.Success, human: ["Media sync account", ...accountLines(shown), ...connectHintLines(shown)].join("\n") };
});

export const handleMediaSyncAccountUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = mediaSyncAccountId(args.positionals[4], "update");
  const name = flagString(args.flags, "name");
  const tenant = flagString(args.flags, "tenant-id");
  const client = flagString(args.flags, "client-id");
  const secretFile = flagString(args.flags, "secret-file");
  const keyFile = flagString(args.flags, "key-file");
  if (name === undefined && tenant === undefined && client === undefined && secretFile === undefined && keyFile === undefined) {
    throw usageError("media sync account update requires --name, --tenant-id, --client-id, --secret-file or --key-file.");
  }
  const config = { ...(tenant !== undefined ? { tenant_id: mediaSyncTenant(tenant) } : {}), ...(client !== undefined ? { client_id: mediaSyncClientId(client) } : {}) };
  const body = {
    ...(name !== undefined ? { name: mediaSyncName(name) } : {}),
    ...(Object.keys(config).length ? { config } : {}),
    ...(secretFile !== undefined ? { secret: await readSecret(secretFile, runtime) }
      : keyFile !== undefined ? { secret: await readServiceAccountKey(keyFile, runtime, KEY_FILE_MAX_CHARACTERS) } : {}),
  };
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "PATCH", path: `${ACCOUNTS_PATH}/${id}`, idempotent: true, body, headers: revisionHeader(args) }, id);
  return {
    envelope: jsonBody(response, api.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated media sync account ${id}`, ...accountLines(response.body as MediaSyncAccount | undefined)].join("\n"),
  };
});

export const handleMediaSyncAccountTest = commandHandler(async (args, runtime, resolved) => {
  const id = mediaSyncAccountId(args.positionals[4], "test");
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "POST", path: `${ACCOUNTS_PATH}/${id}/test`, idempotent: true }, id);
  const report = response.body as MediaSyncTest | undefined;
  return {
    envelope: jsonBody(response, api.requestId),
    exitCode: ExitCode.Success,
    human: [`Media sync account ${id}: ${report?.ok ? "ok" : "failed"}`, ...checkLines(report?.checks),
      ...(report?.ok ? ["", "This checks the account's sign-in or connection and the permissions it holds. It does not judge a site's grant or a folder: media sync create reads the folder you name."] : [])].join("\n"),
  };
});

export const handleMediaSyncAccountDelete = commandHandler(async (args, runtime, resolved) => {
  const id = mediaSyncAccountId(args.positionals[4], "delete");
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "DELETE", path: `${ACCOUNTS_PATH}/${id}`, idempotent: true, headers: revisionHeader(args) }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? api.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted media sync account ${id}.`,
  };
});

// ---- syncs (media sync ...): path words are media sync VERB [sharepoint|dropbox|google-drive] [ID]

/** create sharepoint, create dropbox and create google-drive: the provider is the command's word after create, and each reads --url its own way. */
function createHandler(provider: "sharepoint" | "dropbox" | "google_drive", word: string, address: (url: string) => string) {
  return commandHandler(async (args, runtime, resolved) => {
    const accountId = flagString(args.flags, "account-id");
    const url = flagString(args.flags, "url");
    if (accountId === undefined || url === undefined) throw usageError(`media sync create ${word} requires --account-id and --url.`);
    const folderId = flagString(args.flags, "folder-id");
    const every = flagString(args.flags, "every");
    const name = flagString(args.flags, "name");
    const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
    const response = await syncCall(api, {
      method: "POST", path: SYNCS_PATH, idempotent: true,
      body: {
        provider, account_id: mediaSyncAccountOption(accountId), url: address(url),
        ...(folderId !== undefined ? { folder_id: mediaSyncFolderOption(folderId) } : {}),
        ...(every !== undefined ? { every: Number(mediaSyncEvery(every)) } : {}),
        ...(name !== undefined ? { name: mediaSyncName(name) } : {}),
      },
    }, accountId);
    const created = response.body as MediaSync | undefined;
    return {
      envelope: jsonBody(response, api.requestId),
      exitCode: ExitCode.Success,
      human: [`Created media sync ${created?.id ?? ""}`.trimEnd(), ...syncLines(created), "",
        `The first run starts within about 30 seconds. ${FOLDER_HINT.replace("FOLDER", created?.folder_id ?? "FOLDER")}`,
        `Next: screenrig media sync show ${created?.id ?? "ID"}`].join("\n"),
    };
  });
}

export const handleMediaSyncCreate = createHandler("sharepoint", "sharepoint", mediaSyncUrl);
export const handleMediaSyncCreateDropbox = createHandler("dropbox", "dropbox", mediaSyncDropboxUrl);
export const handleMediaSyncCreateGoogleDrive = createHandler("google_drive", "google-drive", mediaSyncDriveUrl);

export const handleMediaSyncList = commandHandler(async (args, runtime, resolved) => {
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const { items, response } = await allPages<MediaSync>(api, SYNCS_PATH);
  return {
    envelope: jsonBody({ ...response, body: { items, next_cursor: null } }, api.requestId),
    exitCode: ExitCode.Success,
    human: [`Media syncs (${items.length})`, ...syncTableLines(items)].join("\n"),
  };
});

export const handleMediaSyncShow = commandHandler(async (args, runtime, resolved) => {
  const id = mediaSyncId(args.positionals[3], "show");
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "GET", path: `${SYNCS_PATH}/${id}` }, id);
  const sync = response.body as MediaSync | undefined;
  return {
    envelope: jsonBody(response, api.requestId),
    exitCode: ExitCode.Success,
    human: ["Media sync", ...syncLines(sync), ...(sync ? ["", FOLDER_HINT.replace("FOLDER", sync.folder_id)] : [])].join("\n"),
  };
});

export const handleMediaSyncUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = mediaSyncId(args.positionals[3], "update");
  const name = flagString(args.flags, "name");
  const every = flagString(args.flags, "every");
  const folderId = flagString(args.flags, "folder-id");
  const pause = flagBool(args.flags, "pause");
  const resume = flagBool(args.flags, "resume");
  if (name === undefined && every === undefined && folderId === undefined && !pause && !resume) {
    throw usageError("media sync update requires --name, --every, --folder-id, --pause or --resume.");
  }
  const body = {
    ...(name !== undefined ? { name: mediaSyncName(name) } : {}),
    ...(every !== undefined ? { every: Number(mediaSyncEvery(every)) } : {}),
    ...(folderId !== undefined ? { folder_id: mediaSyncFolderOption(folderId) } : {}),
    ...(pause ? { state: "paused" } : {}),
    ...(resume ? { state: "active" } : {}),
  };
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "PATCH", path: `${SYNCS_PATH}/${id}`, idempotent: true, body, headers: revisionHeader(args) }, id);
  return {
    envelope: jsonBody(response, api.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated media sync ${id}`, ...syncLines(response.body as MediaSync | undefined)].join("\n"),
  };
});

export const handleMediaSyncRun = commandHandler(async (args, runtime, resolved) => {
  const id = mediaSyncId(args.positionals[3], "run");
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "POST", path: `${SYNCS_PATH}/${id}/run`, idempotent: true }, id);
  return {
    envelope: jsonBody(response, api.requestId),
    exitCode: ExitCode.Success,
    human: [`Media sync ${id} is due now; it runs within about 30 seconds.`, "", `Next: screenrig media sync show ${id}`].join("\n"),
  };
});

export const handleMediaSyncDelete = commandHandler(async (args, runtime, resolved) => {
  const id = mediaSyncId(args.positionals[3], "delete");
  const api = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await syncCall(api, { method: "DELETE", path: `${SYNCS_PATH}/${id}`, idempotent: true, headers: revisionHeader(args) }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? api.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted media sync ${id}. Its media and folder stay; nothing is imported or removed from now on.`,
  };
});
