import { requireToken } from "./client.js";
import { flagBool, flagString, type ParsedArgs } from "./command-input.js";
import { clientFor, commandHandler, jsonBody, pendingReviewResult, playlistWriteResult, reviewNoteFrom, type CommandResult } from "./commands.js";
import type { CliRuntime } from "./runtime.js";
import type { ResolvedConfig as ResolvedCommandConfig } from "./config.js";
import { isResourceID } from "./generated/resource-ids.js";
import { quotedRevision } from "./if-match.js";
import { usageError } from "./problems.js";
import { pendingReviewOf } from "./reviews.js";
import { successEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";

/**
 * Playlist templates: a playlist that declares `fields` is a template, read as
 * `{field.NAME}` tokens; a playlist made from one stores its values. The
 * server owns the semantics; this module is the commands
 * (playlist-template-check.ts is the offline check).
 */

type JSONObject = Record<string, unknown>;
const isObject = (value: unknown): value is JSONObject => typeof value === "object" && value !== null && !Array.isArray(value);

const FIELD_NAME = /^[a-z0-9_]{1,32}$/;
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

// --- options -----------------------------------------------------------

/** A repeatable --set NAME=VALUE: the entries accumulate as a JSON object, so a value may hold line feeds. */
export function templateSetOption(input: string, previous?: string): string {
  const at = input.indexOf("=");
  const name = at < 0 ? "" : input.slice(0, at).trim();
  if (!FIELD_NAME.test(name)) throw usageError("--set takes NAME=VALUE with a field name of 1 to 32 lower case letters, digits or underscores, such as --set headline=\"Closed today\".");
  const value = input.slice(at + 1);
  if (CONTROL.test(value)) throw usageError(`--set ${name} takes a value without control characters.`);
  const held = previous === undefined ? {} : JSON.parse(previous) as Record<string, string>;
  if (Object.hasOwn(held, name)) throw usageError(`--set ${name} is given more than once.`);
  return JSON.stringify({ ...held, [name]: value });
}

/** A repeatable --clear NAME: names accumulate as a JSON array. */
export function templateClearOption(input: string, previous?: string): string {
  const name = input.trim();
  if (!FIELD_NAME.test(name)) throw usageError("--clear takes a field name of 1 to 32 lower case letters, digits or underscores.");
  const held = previous === undefined ? [] : JSON.parse(previous) as string[];
  if (held.includes(name)) throw usageError(`--clear ${name} is given more than once.`);
  return JSON.stringify([...held, name]);
}

const setValues = (args: ParsedArgs): Record<string, string> => {
  const raw = flagString(args.flags, "set");
  return raw === undefined ? {} : JSON.parse(raw) as Record<string, string>;
};
const clearedNames = (args: ParsedArgs): string[] => {
  const raw = flagString(args.flags, "clear");
  return raw === undefined ? [] : JSON.parse(raw) as string[];
};

// --- commands ----------------------------------------------------------

const playlistPath = (id: string): string => `/api/playlists/${encodeURIComponent(id)}`;

function playlistIdArg(args: ParsedArgs, command: string): string {
  const id = args.positionals[2];
  if (!id || !isResourceID(id, "playlist")) throw usageError(`playlist ${command} requires a playlist ID (pl_...); playlist list shows them.`);
  return id;
}

/** playlist create --from-template ID --name NAME [--set NAME=VALUE...] [--dry-run], or --starter urgent-notice [--name NAME]. */
export async function createFromTemplate(args: ParsedArgs, client: ReturnType<typeof clientFor>) {
  const from = flagString(args.flags, "from-template");
  const starter = flagString(args.flags, "starter");
  const name = flagString(args.flags, "name");
  const values = setValues(args);
  if ((from === undefined) === (starter === undefined)) throw usageError("playlist create takes a file, --from-template ID or --starter KEY, one of them.");
  if (args.positionals[2] !== undefined) throw usageError("playlist create takes a file, --from-template ID or --starter KEY, not a file with either.");
  if (starter !== undefined) {
    if (Object.keys(values).length || flagBool(args.flags, "dry-run")) throw usageError("--starter takes no --set or --dry-run: fill the template with --from-template afterwards.");
    return client.call({ method: "POST", path: "/api/playlists", idempotent: true, body: { ...(name ? { name } : {}), starter }, headers: reviewNoteFrom(args) });
  }
  if (!isResourceID(from!, "playlist")) throw usageError("--from-template takes a template's playlist ID (pl_...); playlist list --templates shows them.");
  if (flagBool(args.flags, "dry-run")) {
    return client.call({ method: "POST", path: `${playlistPath(from!)}/expand`, body: { values } });
  }
  if (!name) throw usageError("playlist create --from-template requires --name: the new playlist's name.");
  return client.call({
    method: "POST", path: "/api/playlists", idempotent: true,
    body: { name, from_template: { playlist_id: from, values } }, headers: reviewNoteFrom(args),
  });
}

/** The result of playlist create --from-template or --starter; playlist create calls it once it has resolved its configuration. */
export async function playlistCreateFromTemplate(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await createFromTemplate(args, client);
  if (flagBool(args.flags, "dry-run")) {
    const pages = isObject(response.body) && Array.isArray(response.body.pages) ? response.body.pages : [];
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
      human: `The playlist would hold ${pages.length} page(s). Nothing was created; run again without --dry-run to create it.` };
  }
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return playlistWriteResult(response, client.requestId, "Playlist created.");
}

const describe = (field: JSONObject): string =>
  `${String(field.name)}\t${String(field.type)}${field.required === true ? "\trequired" : "\toptional"}${typeof field.max_length === "number" ? `\tmax ${field.max_length}` : ""}\t${String(field.label)}`;

/** playlist fields ID: show a template's fields or a copy's values; --set, --clear or --refresh change a copy. */
export const handlePlaylistFields = commandHandler(async (args, runtime, resolved) => {
  const id = playlistIdArg(args, "fields");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const sets = setValues(args), clears = clearedNames(args);
  const changing = Object.keys(sets).length > 0 || clears.length > 0 || flagBool(args.flags, "refresh");
  for (const name of clears) if (Object.hasOwn(sets, name)) throw usageError(`${name} is both --set and --clear.`);
  if (changing) {
    const expected = flagString(args.flags, "if-match");
    const response = await client.call({
      method: "PATCH", path: `${playlistPath(id)}/values`, idempotent: true,
      body: { values: { ...sets, ...Object.fromEntries(clears.map((name) => [name, null])) } },
      headers: { ...reviewNoteFrom(args), ...(expected !== undefined ? { "if-match": quotedRevision(expected) } : {}) },
    });
    const pending = pendingReviewOf(response);
    if (pending) return pendingReviewResult(response, pending, client.requestId);
    return playlistWriteResult(response, client.requestId, "Playlist values updated.");
  }
  const playlist = (await client.call({ method: "GET", path: playlistPath(id) })).body;
  if (!isObject(playlist)) throw usageError("The playlist answer does not match the generated contract.");
  if (Array.isArray(playlist.fields) && playlist.fields.length > 0) {
    const instances = (await client.call({ method: "GET", path: `${playlistPath(id)}/instances` })).body;
    const count = isObject(instances) && Array.isArray(instances.items) ? instances.items.length : 0;
    const data = { playlist_id: id, kind: "template", name: playlist.name, revision: playlist.revision, fields: playlist.fields, instances: count };
    return { envelope: successEnvelope(data, { request_id: client.requestId }), exitCode: ExitCode.Success,
      human: [`Template ${String(playlist.name)} (revision ${String(playlist.revision)}), ${count} playlist(s) made from it`, "Name\tType\tRequired\tLabel",
        ...(playlist.fields as unknown[]).filter(isObject).map(describe)].join("\n") };
  }
  const source = typeof playlist.template_id === "string" ? playlist.template_id : undefined;
  if (!source) throw usageError(`Playlist ${id} is neither a template (it declares no fields) nor made from one.`);
  const values = isObject(playlist.values) ? playlist.values : {};
  const template = (await client.call({ method: "GET", path: playlistPath(source) }).catch(() => undefined))?.body;
  const current = isObject(template) && typeof template.revision === "number" ? template.revision : undefined;
  const built = typeof playlist.template_revision === "number" ? playlist.template_revision : undefined;
  const outdated = current !== undefined && built !== undefined && built < current;
  const labels = new Map((isObject(template) && Array.isArray(template.fields) ? template.fields : []).filter(isObject).map((field) => [String(field.name), String(field.label)]));
  const data = { playlist_id: id, kind: "instance", name: playlist.name, revision: playlist.revision, template_id: source, template_revision: built, template_current_revision: current, outdated, values };
  return { envelope: successEnvelope(data, { request_id: client.requestId }), exitCode: ExitCode.Success,
    human: [`${String(playlist.name)} was made from ${source} at revision ${String(built)}${outdated ? ` (the template is now at revision ${String(current)}: playlist fields ${id} --refresh brings this copy up to date)` : ""}`,
      ...Object.entries(values).map(([name, value]) => `${name}\t${labels.get(name) ?? ""}\t${String(value)}`)].join("\n") };
}, true);

/** playlist instances ID: the playlists made from a template. */
export const handlePlaylistInstances = commandHandler(async (args, runtime, resolved) => {
  const id = playlistIdArg(args, "instances");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${playlistPath(id)}/instances` });
  const items = isObject(response.body) && Array.isArray(response.body.items) ? response.body.items.filter(isObject) : [];
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: ["Playlists made from the template", "ID\tRevision\tTemplate revision\tState\tName",
      ...items.map((item) => `${String(item.id)}\t${String(item.revision)}\t${String(item.template_revision)}\t${item.outdated === true ? "outdated" : "current"}\t${String(item.name)}`)].join("\n") };
}, true);
