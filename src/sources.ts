import { flagBool, flagString, type ParsedArgs } from "./command-input.js";
import { requireToken, type ApiClient } from "./client.js";
import { readAuthoringText } from "./authoring-input.js";
import { clientFor, commandHandler, jsonBody } from "./commands.js";
import { successEnvelope, type Warning } from "./envelope.js";
import { quotedRevision } from "./if-match.js";
import { ExitCode } from "./exit-codes.js";
import { CliError, usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";
import { table } from "./webhooks.js";

/** Backend Source.id (vendor/openapi.yaml). */
export const SOURCE_ID_PATTERN = /^(?:(?:stage|qa|development)_)?src_[A-Za-z0-9_-]+$/;
/** SourceKind: where the data comes from. `ics` reads iCalendar and webcal:// addresses. */
export const SOURCE_KINDS = ["ics", "sheets", "csv", "json", "microsoft365", "google_calendar", "square", "shopify", "momentus"] as const;
/** SourceCreate.refresh_seconds: half a minute to one day (a kind sets its own floor). */
export const SOURCE_REFRESH_MIN_S = 30;
export const SOURCE_REFRESH_MAX_S = 86_400;
/** SourceStaleAfter: one minute to seven days, or none. */
export const SOURCE_STALE_MIN_S = 60;
export const SOURCE_STALE_MAX_S = 604_800;
const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** Config, secrets and files a command reads are bounded like the request the server accepts. */
const INPUT_MAX_BYTES = 1 << 20;
const SOURCES_PATH = "/api/sources";

export interface SourceSecretView { set: boolean; hint: string; updated_at: string }
export interface SourceError { code: string; message: string; upstream_status?: number; at: string }
export interface SourceStatus {
  state: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_change_at: string | null;
  next_run_at: string | null;
  failures: number;
  /** True while the source is failing and the data it last wrote has expired. */
  stale: boolean;
  /** When the data the last good run wrote stops being served; null without a stale period. */
  data_expires_at: string | null;
  error: SourceError | null;
  warnings: string[];
  stats: Record<string, number>;
}
export interface Source {
  id: string;
  name: string;
  kind: string;
  target: { card_id: string };
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, SourceSecretView>;
  refresh_seconds: number;
  /** How long the card keeps the last good data when the source cannot refresh; null keeps it until the next refresh. */
  stale_after_seconds: number | null;
  revision: number;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
}
export interface SourceList { items: Source[]; next_cursor: string | null }
export interface SourceRoomRef { id: string; name: string }
export interface SourceRoom {
  key: string; code?: string; name?: string; floor?: string; area?: string; capacity?: number;
  status: "mapped" | "unmapped" | ""; screens: SourceRoomRef[];
}
export interface SourceArea { key: string; name: string; rooms: number; status: "mapped" | "unmapped" | ""; screens: SourceRoomRef[] }
export interface SourceRoomScreen {
  id: string; name: string; kind: "room" | "area"; field: string; value: string | null;
  status: "mapped" | "missing" | "unknown"; key?: string; suggestion?: string;
}
export interface SourceRooms {
  source_id: string;
  room_field: string; room_key_prefix: string; area_field: string; area_key_prefix: string;
  rooms_as_of: string | null;
  summary: { rooms: number; unmapped_rooms: number; areas: number; unmapped_areas: number; screens: number; missing_screens: number; unknown_screens: number };
  rooms: SourceRoom[]; areas: SourceArea[]; screens: SourceRoomScreen[]; warnings: string[];
}
export interface SourceTestResult {
  document: Record<string, unknown>;
  valid: boolean;
  validation_error?: { path: string; reason: string };
  warnings: string[];
  stats: Record<string, number>;
  fetched_at: string;
}

export function sourceId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`source ${command} requires <source_id>.`);
  if (!SOURCE_ID_PATTERN.test(value)) {
    throw usageError("A source id looks like src_ followed by letters, digits, - or _.", {
      command: "screenrig source list",
      reason: "List this project's data sources and their ids.",
    });
  }
  return value;
}

/** `--name`: 1 to 80 characters of text. */
export function sourceName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > 80 || /\p{Cc}/u.test(trimmed)) {
    throw usageError("--name must be 1 to 80 characters of text.");
  }
  return trimmed;
}

/** A duration as `90s`, `5m`, `1h` or `1h30m`, in whole seconds; NaN when it is not one. */
function durationSeconds(value: string): number {
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value.trim());
  return match && value.trim() !== ""
    ? Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0)
    : NaN;
}

/** `--stale-after`: one minute to 7 days, or `none` (null: keep the last good data until the next refresh). */
export function sourceStaleAfterSeconds(value: string): number | null {
  if (value.trim().toLowerCase() === "none") return null;
  const seconds = durationSeconds(value);
  if (!Number.isSafeInteger(seconds) || seconds < SOURCE_STALE_MIN_S || seconds > SOURCE_STALE_MAX_S) {
    throw usageError("--stale-after takes 1m to 7d, such as 30m, 2h or 1d, or none.");
  }
  return seconds;
}

export function sourceStaleAfterOption(value: string): string {
  sourceStaleAfterSeconds(value);
  return value;
}

/** `--refresh`: half a minute to 24 hours, as `30s`, `5m`, `1h` or `1h30m`. Returns the whole seconds. */
export function sourceRefreshSeconds(value: string): number {
  const seconds = /\d+d/.test(value) ? NaN : durationSeconds(value);
  if (!Number.isSafeInteger(seconds) || seconds < SOURCE_REFRESH_MIN_S || seconds > SOURCE_REFRESH_MAX_S) {
    throw usageError("--refresh takes 30s to 24h, such as 30s, 5m, 1h or 1h30m.");
  }
  return seconds;
}

export function sourceRefreshOption(value: string): string {
  sourceRefreshSeconds(value);
  return value;
}

/** An argParser that accumulates a repeatable option as a JSON array, so a value may hold any character. */
export function accumulate(check: (value: string) => void): (value: string, previous?: string) => string {
  return (value, previous) => {
    check(value);
    const list: string[] = previous === undefined ? [] : JSON.parse(previous) as string[];
    return JSON.stringify([...list, value]);
  };
}

function accumulated(flags: ParsedArgs["flags"], name: string): string[] {
  const raw = flagString(flags, name);
  return raw === undefined ? [] : JSON.parse(raw) as string[];
}

/** `--set KEY=VALUE`: the key is a top-level config member. */
export function setPairCheck(value: string): void {
  const at = value.indexOf("=");
  if (at < 1) throw usageError("--set takes KEY=VALUE, such as days=14 or time_zone=America/Vancouver.");
}

/** `--secret NAME=VALUE|NAME=@FILE|NAME=-`. */
export function secretPairCheck(value: string): void {
  const at = value.indexOf("=");
  if (at < 1) throw usageError("--secret takes NAME=VALUE, NAME=@FILE or NAME=-, such as calendar_url.lobby=@lobby.url.");
  const name = value.slice(0, at);
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw usageError("A secret name is lower-case letters, digits, . _ and -, up to 64 characters, such as calendar_url.lobby.");
  }
  if (value.slice(at + 1) === "") throw usageError(`--secret ${name}= has no value; use NAME=@FILE or NAME=- to read it, or --unset-secret ${name} to remove it.`);
}

export function unsetSecretCheck(value: string): void {
  if (!SECRET_NAME_PATTERN.test(value)) {
    throw usageError("A secret name is lower-case letters, digits, . _ and -, up to 64 characters, such as calendar_url.lobby.");
  }
}

/** A `--set` value: JSON when it parses (14, true, [..], {..}), else the text itself. */
export function setValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The input streams one invocation reads: stdin serves at most one option. */
class Inputs {
  private stdin: string | undefined;
  constructor(private readonly runtime: CliRuntime) {}

  async text(option: string, file: string): Promise<string> {
    if (file === "-") {
      if (this.stdin !== undefined) throw usageError(`${option} - cannot read stdin: another option already does. Give one option stdin and the others a file.`);
      this.stdin = option;
    }
    return readAuthoringText(file, this.runtime, INPUT_MAX_BYTES);
  }
}

/** `--settings JSON|@FILE|-` as an object. */
async function configFrom(source: string, inputs: Inputs): Promise<Record<string, unknown>> {
  const trimmed = source.trim();
  const text = trimmed === "-" ? await inputs.text("--settings", "-")
    : trimmed.startsWith("@") ? await inputs.text("--settings", trimmed.slice(1))
    : source;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageError("--settings is not valid JSON. Give a JSON object, @FILE or - for stdin.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw usageError("--settings must be a JSON object.");
  return parsed as Record<string, unknown>;
}

/** The `--set` pairs as members, rejecting a key given twice. */
export function setMembers(pairs: string[]): Record<string, unknown> {
  const members: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const key = pair.slice(0, at);
    if (Object.hasOwn(members, key)) throw usageError(`--set ${key} is given twice.`);
    members[key] = setValue(pair.slice(at + 1));
  }
  return { ...members };
}

/** The `--secret` pairs as the request's secrets, reading each @FILE or stdin. */
async function secretsFrom(pairs: string[], unset: string[], inputs: Inputs): Promise<Record<string, string | null> | undefined> {
  const secrets: Record<string, string | null> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    if (Object.hasOwn(secrets, name)) throw usageError(`--secret ${name} is given twice.`);
    const value = raw === "-" ? await inputs.text(`--secret ${name}=-`, "-")
      : raw.startsWith("@") ? await inputs.text(`--secret ${name}=@FILE`, raw.slice(1))
      : raw;
    const clean = value.trim();
    if (!clean) throw usageError(`The value for --secret ${name} is empty.`);
    secrets[name] = clean;
  }
  for (const name of unset) {
    if (Object.hasOwn(secrets, name)) throw usageError(`${name} is both set with --secret and removed with --unset-secret.`);
    secrets[name] = null;
  }
  return Object.keys(secrets).length ? secrets : undefined;
}

/** The config the command sends: `--settings` as given, else the saved one, then the `--set` members on top. */
async function mergedConfig(args: ParsedArgs, inputs: Inputs, saved: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown> | undefined> {
  const given = flagString(args.flags, "settings");
  const pairs = accumulated(args.flags, "set");
  if (given === undefined && !pairs.length) return undefined;
  const base = given !== undefined ? await configFrom(given, inputs) : await saved();
  return { ...base, ...setMembers(pairs) };
}

async function sourceCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw sourceProblem(error, id);
  }
}

function revisionHeaders(revision: string | undefined): Record<string, string> | undefined {
  return revision === undefined ? undefined : { "if-match": quotedRevision(revision) };
}

/** The secret a source_secret_required problem names: errors[].field is secrets.NAME. */
function namedSecret(problem: CliError["problem"]): string | undefined {
  for (const entry of problem.errors) {
    const field = (entry as { field?: unknown } | null)?.field;
    if (typeof field === "string" && field.startsWith("secrets.")) return field.slice("secrets.".length);
  }
  return undefined;
}

/** The source id a problem's errors name ("is written by src_…"). */
function namedSource(problem: CliError["problem"]): string | undefined {
  for (const entry of problem.errors) {
    const detail = (entry as { detail?: unknown } | null)?.detail;
    const match = typeof detail === "string" ? /\b((?:(?:stage|qa|development)_)?src_[A-Za-z0-9_-]+)/.exec(detail) : null;
    if (match) return match[1];
  }
  return undefined;
}

/** Add the next step to data source problems. The server's own `next` and `hint` stay. */
export function sourceProblem(error: unknown, id?: string): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.next) return error;
  const withNext = (command: string, reason: string) => new CliError({ ...problem, next: { command, reason } }, error.exitCode, error.warnings);
  switch (problem.code) {
    case "source_target_taken": {
      const owner = namedSource(problem);
      return withNext(owner ? `screenrig source show ${owner}` : "screenrig source list", "One source writes one card. Change or delete the source that has this card, or point this source at another card. Nothing was created.");
    }
    case "source_target_unsupported":
      return withNext("screenrig card list", "List this project's cards. The detail names the card types this kind of source can fill; point the source at one of those.");
    case "source_secret_required": {
      const name = namedSecret(problem);
      return id && name
        ? withNext(`screenrig source update ${id} --secret ${name}=@FILE`, `Enter ${name} again from a file (or - for stdin); a secret entered for one address or account is not carried to another.`)
        : withNext("screenrig help source create", name ? `Enter ${name} with --secret ${name}=@FILE (or - for stdin).` : "Enter each secret the kind needs with --secret NAME=@FILE.");
    }
    case "source_limit_reached":
      return withNext("screenrig source list", "A project has at most 200 data sources. Delete one with screenrig source delete SOURCE_ID, then rerun create. Nothing was created.");
    case "source_has_no_rooms":
      return withNext("screenrig source list", "Only a source that reads a booking system's rooms (kind momentus) has a room mapping. Pick one of that kind.");
    case "source_busy":
      return withNext(id ? `screenrig source show ${id}` : "screenrig source list", "A scheduled sync is running. Wait for the retry interval, then refresh again; the sync updates the status on its own.");
    case "revision_conflict":
      return id ? withNext(`screenrig source show ${id}`, "Read the current revision, then rerun with --expect-rev REVISION if the change still applies.") : error;
    case "not_found":
      return id ? withNext("screenrig source list", "List this project's data sources; a deleted source does not come back.") : error;
    default:
      return error;
  }
}

/** A cell clipped to a width. */
function clip(text: string, width: number): string {
  const chars = [...text];
  return chars.length > width ? `${chars.slice(0, width - 1).join("")}…` : text;
}

/** `5m`, `1h`, `1h 30m`: a refresh interval. */
export function refreshText(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function statsText(stats: Record<string, number> | undefined): string {
  return Object.entries(stats ?? {}).map(([name, value]) => `${name}=${value}`).join(", ");
}

function errorText(error: SourceError): string {
  return `${error.code}: ${error.message} (${error.at})`;
}

export function sourceLines(source: Source | undefined): string[] {
  if (!source) return [];
  const status = source.status;
  const secrets = Object.entries(source.secrets ?? {});
  return [
    `id: ${source.id}`,
    `name: ${source.name}`,
    `kind: ${source.kind}`,
    `card_id: ${source.target?.card_id}`,
    `enabled: ${source.enabled}`,
    `refresh: ${refreshText(source.refresh_seconds)}`,
    `stale_after: ${source.stale_after_seconds === null || source.stale_after_seconds === undefined ? "none (the last good data stays until the next refresh)" : refreshText(source.stale_after_seconds)}`,
    `revision: ${source.revision}`,
    `state: ${status.state}`,
    ...(status.stale ? ["stale: true (the data has expired on screens; pages that depend on it have fallen back)"] : []),
    ...(status.data_expires_at ? [`data_expires_at: ${status.data_expires_at}`] : []),
    ...(status.last_attempt_at ? [`last_attempt_at: ${status.last_attempt_at}`] : []),
    ...(status.last_success_at ? [`last_success_at: ${status.last_success_at}`] : []),
    ...(status.last_change_at ? [`last_change_at: ${status.last_change_at}`] : []),
    ...(status.next_run_at ? [`next_run_at: ${status.next_run_at}`] : []),
    `failures: ${status.failures}`,
    ...(status.error ? [`error: ${errorText(status.error)}`] : []),
    ...(Object.keys(status.stats ?? {}).length ? [`stats: ${statsText(status.stats)}`] : []),
    ...(status.warnings?.length ? ["warnings:", ...status.warnings.map((warning) => `  - ${warning}`)] : []),
    ...(secrets.length ? ["secrets:", ...secrets.map(([name, view]) => `  ${name}: ${view.hint}`)] : []),
    `config: ${clip(JSON.stringify(source.config ?? {}), 400)}`,
  ];
}

export function sourceTableLines(items: Source[]): string[] {
  if (!items.length) return ["No data sources"];
  return table(["ID", "NAME", "KIND", "CARD", "STATE", "LAST OK", "NEXT", "ERROR"], items.map((item) => [
    item.id, clip(item.name, 30), item.kind, item.target?.card_id ?? "", item.status.state,
    item.status.last_success_at ?? "", item.status.next_run_at ?? "", item.status.error?.code ?? "",
  ]));
}

const PREVIEW_LINES = 60;

export function sourceTestLines(result: SourceTestResult | undefined): string[] {
  if (!result) return [];
  const rendered = JSON.stringify(result.document ?? {}, null, 2).split("\n");
  return [
    result.valid
      ? "The card accepts this document."
      : `The card refuses this document at ${result.validation_error?.path || "the document"}: ${result.validation_error?.reason ?? "invalid"}`,
    `fetched_at: ${result.fetched_at}`,
    ...(Object.keys(result.stats ?? {}).length ? [`stats: ${statsText(result.stats)}`] : []),
    ...(result.warnings?.length ? ["warnings:", ...result.warnings.map((warning) => `  - ${warning}`)] : []),
    "document:",
    ...rendered.slice(0, PREVIEW_LINES).map((line) => `  ${line}`),
    ...(rendered.length > PREVIEW_LINES ? [`  … ${rendered.length - PREVIEW_LINES} more lines (the JSON envelope has the whole document)`] : []),
  ];
}

export function sourceListLines(page: SourceList | undefined): string[] {
  const items = Array.isArray(page?.items) ? page.items : [];
  const next = typeof page?.next_cursor === "string" && page.next_cursor ? page.next_cursor : undefined;
  return [`Data sources (${items.length})`, ...sourceTableLines(items), ...(next ? [`next: screenrig source list --after ${next}`] : [])];
}

// Handlers. Needs Manage access for writes; reads need Read access.

export const handleSourceList = commandHandler(async (args, runtime, resolved) => {
  const after = flagString(args.flags, "after");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await sourceCall(client, { method: "GET", path: SOURCES_PATH, query: after !== undefined ? { after } : {} });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: sourceListLines(response.body as SourceList | undefined).join("\n"),
  };
});

export const handleSourceShow = commandHandler(async (args, runtime, resolved) => {
  const id = sourceId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await sourceCall(client, { method: "GET", path: `${SOURCES_PATH}/${id}` }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Data source", ...sourceLines(response.body as Source | undefined)].join("\n"),
  };
});

export const handleSourceCreate = commandHandler(async (args, runtime, resolved) => {
  const inputs = new Inputs(runtime);
  const refresh = flagString(args.flags, "refresh");
  const staleAfter = flagString(args.flags, "stale-after");
  const config = await mergedConfig(args, inputs, async () => ({}));
  const secrets = await secretsFrom(accumulated(args.flags, "secret"), [], inputs);
  const body = {
    name: sourceName(flagString(args.flags, "name") ?? ""),
    kind: flagString(args.flags, "kind"),
    target: { card_id: flagString(args.flags, "card") },
    config: config ?? {},
    ...(secrets ? { secrets } : {}),
    ...(refresh !== undefined ? { refresh_seconds: sourceRefreshSeconds(refresh) } : {}),
    ...(staleAfter !== undefined ? { stale_after_seconds: sourceStaleAfterSeconds(staleAfter) } : {}),
    ...(flagBool(args.flags, "disabled") ? { enabled: false } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await sourceCall(client, { method: "POST", path: SOURCES_PATH, idempotent: true, body });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Created data source", ...sourceLines(response.body as Source | undefined)].join("\n"),
  };
});

export const handleSourceUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = sourceId(args.positionals[2], "update");
  const inputs = new Inputs(runtime);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const name = flagString(args.flags, "name");
  const card = flagString(args.flags, "card");
  const refresh = flagString(args.flags, "refresh");
  const staleAfter = flagString(args.flags, "stale-after");
  const expect = flagString(args.flags, "expect-rev");
  // --set edits the saved config: the whole config is read, merged and sent,
  // guarded by the revision read unless --expect-rev names another.
  let readRevision: number | undefined;
  const config = await mergedConfig(args, inputs, async () => {
    const response = await sourceCall(client, { method: "GET", path: `${SOURCES_PATH}/${id}` }, id);
    const saved = response.body as Source;
    readRevision = saved.revision;
    return saved.config ?? {};
  });
  const secrets = await secretsFrom(accumulated(args.flags, "secret"), accumulated(args.flags, "unset-secret"), inputs);
  const body = {
    ...(name !== undefined ? { name: sourceName(name) } : {}),
    ...(card !== undefined ? { target: { card_id: card } } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(secrets ? { secrets } : {}),
    ...(refresh !== undefined ? { refresh_seconds: sourceRefreshSeconds(refresh) } : {}),
    ...(staleAfter !== undefined ? { stale_after_seconds: sourceStaleAfterSeconds(staleAfter) } : {}),
    ...(flagBool(args.flags, "enable") ? { enabled: true } : {}),
    ...(flagBool(args.flags, "disable") ? { enabled: false } : {}),
  };
  if (!Object.keys(body).length) {
    throw usageError("source update requires at least one change: --name, --card, --settings, --set, --secret, --unset-secret, --refresh, --stale-after, --enable or --disable.");
  }
  const response = await sourceCall(client, {
    method: "PATCH", path: `${SOURCES_PATH}/${id}`, idempotent: true, body,
    headers: revisionHeaders(expect ?? (readRevision !== undefined ? String(readRevision) : undefined)),
    // A merge derives its guard from a fresh read, so a rerun fingerprints differently.
    ...(readRevision !== undefined ? { recoverySupersede: JSON.stringify(["source update", id]) } : {}),
  }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated data source ${id}`, ...sourceLines(response.body as Source | undefined)].join("\n"),
  };
});

export const handleSourceTest = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const kind = flagString(args.flags, "kind");
  const card = flagString(args.flags, "card");
  if (id !== undefined) sourceId(id, "test");
  else if (kind === undefined || card === undefined) {
    throw usageError("source test takes a saved <source_id>, or --kind and --card to preview a source that is not saved.");
  }
  const inputs = new Inputs(runtime);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const config = await mergedConfig(args, inputs, async () => {
    if (id === undefined) return {};
    const response = await sourceCall(client, { method: "GET", path: `${SOURCES_PATH}/${id}` }, id);
    return (response.body as Source).config ?? {};
  });
  const secrets = await secretsFrom(accumulated(args.flags, "secret"), [], inputs);
  const body = {
    ...(id !== undefined ? { source_id: id } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(card !== undefined ? { target: { card_id: card } } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(secrets ? { secrets } : {}),
  };
  const response = await sourceCall(client, { method: "POST", path: `${SOURCES_PATH}/test`, body }, id);
  const result = response.body as SourceTestResult | undefined;
  const warnings: Warning[] = result && !result.valid
    ? [{ code: "source_document_refused", message: `The card refuses this document at ${result.validation_error?.path || "the document"}: ${result.validation_error?.reason ?? "invalid"}. Nothing was written; fix the config or the card and test again.` }]
    : [];
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: ["Preview (nothing was saved or written)", ...sourceTestLines(result)].join("\n"),
  };
});

export const handleSourceRefresh = commandHandler(async (args, runtime, resolved) => {
  const id = sourceId(args.positionals[2], "refresh");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await sourceCall(client, { method: "POST", path: `${SOURCES_PATH}/${id}/refresh`, timeout_ms: 75_000 }, id);
  const source = response.body as Source | undefined;
  const failed = source?.status.state === "error";
  return {
    envelope: jsonBody(response, client.requestId, undefined, failed && source?.status.error
      ? [{ code: "source_sync_failed", message: `The sync failed: ${source.status.error.message} The card keeps its last good document.` }]
      : []),
    exitCode: ExitCode.Success,
    human: [failed ? `Synced data source ${id}: failed` : `Synced data source ${id}`, ...sourceLines(source)].join("\n"),
  };
});

/** The room mapping report as text: what no screen shows, and screens whose field names no room. */
export function sourceRoomsLines(report: SourceRooms | undefined): string[] {
  if (!report) return [];
  const summary = report.summary;
  const lines = [
    `source_id: ${report.source_id}`,
    ...(report.rooms_as_of ? [`rooms_as_of: ${report.rooms_as_of}`] : []),
    ...(report.room_key_prefix ? [`rooms: screens name a room in the ${report.room_field} field; a card's data key is ${report.room_key_prefix}{screen.field.${report.room_field}}`] : []),
    ...(report.area_key_prefix ? [`areas: screens name an area in the ${report.area_field} field; a card's data key is ${report.area_key_prefix}{screen.field.${report.area_field}}`] : []),
    `rooms ${summary.rooms} (${summary.unmapped_rooms} no screen shows), areas ${summary.areas} (${summary.unmapped_areas} no screen shows), screens ${summary.screens} (${summary.missing_screens} without a value, ${summary.unknown_screens} naming no room or area)`,
    ...(report.warnings.length ? ["warnings:", ...report.warnings.map((warning) => `  - ${warning}`)] : []),
  ];
  const unmappedRooms = report.rooms.filter((room) => room.status === "unmapped");
  if (unmappedRooms.length) {
    lines.push("", "Rooms no screen shows", ...table(["KEY", "NAME", "CODE", "AREA"], unmappedRooms.map((room) => [room.key, clip(room.name ?? "", 30), room.code ?? "", room.area ?? ""])));
  }
  const unmappedAreas = report.areas.filter((area) => area.status === "unmapped");
  if (unmappedAreas.length) {
    lines.push("", "Areas no screen shows", ...table(["KEY", "NAME", "ROOMS"], unmappedAreas.map((area) => [area.key, clip(area.name, 30), String(area.rooms)])));
  }
  const problems = report.screens.filter((screen) => screen.status !== "mapped");
  if (problems.length) {
    lines.push("", "Screens to fix", ...table(["SCREEN", "NAME", "FIELD", "VALUE", "PROBLEM", "SUGGESTION"], problems.map((screen) => [
      screen.id, clip(screen.name, 30), screen.field, screen.value ?? "", screen.status === "missing" ? "no value" : "no such " + screen.kind, screen.suggestion ?? "",
    ])));
  }
  if (!unmappedRooms.length && !unmappedAreas.length && !problems.length) lines.push("", "Every room is shown and every screen names one.");
  return lines;
}

export const handleSourceRooms = commandHandler(async (args, runtime, resolved) => {
  const id = sourceId(args.positionals[2], "rooms");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await sourceCall(client, { method: "GET", path: `${SOURCES_PATH}/${id}/rooms` }, id);
  const report = response.body as SourceRooms | undefined;
  const warnings: Warning[] = [];
  if (report && report.summary.unmapped_rooms > 0) warnings.push({ code: "source_rooms_unmapped", message: `${report.summary.unmapped_rooms} room(s) of the source are shown by no screen.` });
  if (report && report.summary.missing_screens + report.summary.unknown_screens > 0) warnings.push({ code: "source_screens_unmapped", message: `${report.summary.missing_screens + report.summary.unknown_screens} screen(s) read a room or area and have no room the source offers. Fix them with screen update SCREEN_ID --field NAME=VALUE.` });
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: ["Room mapping", ...sourceRoomsLines(report)].join("\n"),
  };
});

export const handleSourceDelete = commandHandler(async (args, runtime, resolved) => {
  const id = sourceId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await sourceCall(client, {
    method: "DELETE", path: `${SOURCES_PATH}/${id}`, idempotent: true, headers: revisionHeaders(flagString(args.flags, "expect-rev")),
  }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted data source ${id}. The card keeps the last document the source wrote.`,
  };
});
