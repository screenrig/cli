import type { ScreenFolder, ScreenFolderCreate, ScreenFolderList, ScreenFolderPatch, ScreenLevelChange, ScreenLevelChanges, ScreenMove, ScreenMoveResult } from "./adapters/protocol.js";
import { requireToken } from "./client.js";
import { flagBool, flagString } from "./command-input.js";
import { clientFor, commandHandler, jsonBody } from "./commands.js";
import { ExitCode } from "./exit-codes.js";
import { isResourceID } from "./generated/resource-ids.js";
import { quotedRevision } from "./if-match.js";
import { CliError, usageError } from "./problems.js";
import { SCREEN_FOLDER_ID_PATTERN, screenFolderId } from "./screen-fleet.js";

/** Screen folders: `screen folder list|show|create|update|delete` and `screen move`. */

export const SCREEN_FOLDER_NAME_MAX = 100;
/** One move names at most this many screens and folders in all. */
export const SCREEN_MOVE_IDS_MAX = 1000;
const FOLDERS_PATH = "/api/screen-folders";

/** ScreenFolder.name: trimmed, 1 to 100 characters, no controls, not "." or "..". */
export function screenFolderName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > SCREEN_FOLDER_NAME_MAX || /\p{Cc}/u.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw usageError(`--name must hold 1 to ${SCREEN_FOLDER_NAME_MAX} characters without controls, and not be . or ..`);
  }
  return trimmed;
}

/** A Commander parser for a flag that takes one screen folder ID (sfd_...). */
export function screenFolderIdOption(flag: string): (value: string) => string {
  return (value) => screenFolderId(value, flag);
}

/** `screen list --folder`: a folder ID, or root for the screens outside every folder. */
export function screenListFolderOption(value: string): string {
  return value === "root" ? value : screenFolderId(value, "--folder");
}

/** --default-playlist-id: an approved playlist the folder's screens show when they have none of their own. */
export function screenFolderPlaylistOption(value: string): string {
  if (!isResourceID(value, "playlist")) {
    throw usageError("--default-playlist-id must be a playlist id (pl_...).", {
      command: "screenrig playlist list",
      reason: "List this project's playlists and their ids.",
    });
  }
  return value;
}

/** Server text reaches a table cell or a line only without control characters. */
function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export interface FolderRow {
  folder: ScreenFolder;
  /** Names from the project root down, joined with /. */
  path: string;
}

/**
 * The folders in tree order: each root folder, then everything inside it,
 * siblings in the order the server listed them (by name). A folder whose parent
 * is not in the list is treated as a root so nothing disappears.
 */
export function folderRows(items: readonly ScreenFolder[]): FolderRow[] {
  const known = new Set(items.map((item) => item.id));
  const children = new Map<string | null, ScreenFolder[]>();
  for (const item of items) {
    const parent = item.parent_id !== null && known.has(item.parent_id) ? item.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const rows: FolderRow[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, prefix: string): void => {
    for (const folder of children.get(parent) ?? []) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      const path = prefix ? `${prefix}/${printable(folder.name)}` : printable(folder.name);
      rows.push({ folder, path });
      visit(folder.id, path);
    }
  };
  visit(null, "");
  // A cycle has no root; list what it holds rather than hide it.
  for (const item of items) if (!seen.has(item.id)) visit(item.parent_id, "");
  return rows;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [render(header), ...rows.map(render)];
}

/** screen folder list: the tree as one row per folder, with the live screens directly inside it and its default playlist. */
export function folderListLines(items: readonly ScreenFolder[]): string[] {
  if (!items.length) return ["No screen folders"];
  return [
    `Screen folders (${items.length})`,
    ...table(["PATH", "ID", "SCREENS", "DEFAULT_PLAYLIST"], folderRows(items).map(({ folder, path }) => [
      path, folder.id, folder.screens === undefined ? "" : String(folder.screens), folder.default_playlist_id ?? "",
    ])),
  ];
}

/** Every field of a folder, one per line. */
export function folderLines(folder: ScreenFolder | undefined): string[] {
  if (!folder) return [];
  return [
    `id: ${folder.id}`,
    `name: ${printable(folder.name)}`,
    `parent_id: ${folder.parent_id ?? "(project root)"}`,
    `default_playlist_id: ${folder.default_playlist_id ?? "(none)"}`,
    ...(folder.screens === undefined ? [] : [`screens: ${folder.screens}`]),
    `revision: ${folder.revision}`,
    ...(folder.created_at ? [`created_at: ${folder.created_at}`] : []),
    ...(folder.updated_at ? [`updated_at: ${folder.updated_at}`] : []),
  ];
}

function levelLine(level: ScreenLevelChange): string {
  const name = level.name ? ` ${JSON.stringify(printable(level.name))}` : "";
  const what = level.source === "folder" ? "default playlist" : "playlist";
  return `  ${level.source} ${level.id}${name}: ${what} ${level.playlist_id}, ${plural(level.screens, "screen")}`;
}

/**
 * What a folder change did to the schedules of the screens it moved: the
 * campaigns whose folder audience they entered or left (campaign) and the
 * folder default playlists that started or stopped being their default (folder).
 */
export function levelsLines(levels: ScreenLevelChanges | undefined): string[] {
  if (!levels) return [];
  const gained = Array.isArray(levels.gained) ? levels.gained : [];
  const lost = Array.isArray(levels.lost) ? levels.lost : [];
  if (!gained.length && !lost.length) return ["No levels gained or lost: no campaign or folder default playlist changed for these screens."];
  return [
    ...(gained.length ? ["Levels gained:", ...gained.map(levelLine)] : []),
    ...(lost.length ? ["Levels lost:", ...lost.map(levelLine)] : []),
  ];
}

/** Guidance on the problems the folder routes answer; a problem that already says what to do passes through. */
export function screenFolderProblem(error: unknown, id?: string, action?: "delete"): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  const problem = error.problem;
  const next = problem.code === "not_found"
    ? { command: "screenrig screen folder list", reason: "List this project's screen folders and their ids; a deleted folder does not come back." }
    : problem.code === "revision_conflict" && id
      ? { command: `screenrig screen folder show ${id}`, reason: "Read the folder's current revision, then rerun with --expect-rev REVISION if the change still applies." }
      : problem.code === "resource_conflict" && action === "delete"
        ? { command: "screenrig campaign list", reason: "A campaign audience still names this folder. Change those campaigns (campaign update ID --folder OTHER, or campaign delete ID), then delete the folder." }
        : problem.code === "resource_conflict"
          ? { command: "screenrig screen folder list", reason: "Sibling folders need different names; list the folders to see what the destination already holds." }
          : undefined;
  return next ? new CliError({ ...problem, next }, error.exitCode, error.warnings) : error;
}

async function folderCall(client: ReturnType<typeof clientFor>, request: Parameters<ReturnType<typeof clientFor>["call"]>[0], id?: string, action?: "delete") {
  try {
    return await client.call(request);
  } catch (error) {
    throw screenFolderProblem(error, id, action);
  }
}

function folderResult(response: Awaited<ReturnType<ReturnType<typeof clientFor>["call"]>>, requestId: string, title: string) {
  const folder = response.body as ScreenFolder | undefined;
  return {
    envelope: jsonBody(response, requestId),
    exitCode: ExitCode.Success,
    human: [title, ...folderLines(folder), ...levelsLines(folder?.levels)].join("\n"),
  };
}

export const handleScreenFolderList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await folderCall(client, { method: "GET", path: FOLDERS_PATH });
  const items = (response.body as ScreenFolderList | undefined)?.items;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: folderListLines(Array.isArray(items) ? items : []).join("\n"),
  };
});

export const handleScreenFolderShow = commandHandler(async (args, runtime, resolved) => {
  const id = screenFolderId(args.positionals[3], "screen folder show <id>");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await folderCall(client, { method: "GET", path: `${FOLDERS_PATH}/${id}` }, id);
  return folderResult(response, client.requestId, "Screen folder");
});

export const handleScreenFolderCreate = commandHandler(async (args, runtime, resolved) => {
  const parent = flagString(args.flags, "parent");
  const playlist = flagString(args.flags, "default-playlist-id");
  const body: ScreenFolderCreate = {
    name: screenFolderName(flagString(args.flags, "name") ?? ""),
    ...(parent !== undefined ? { parent_id: screenFolderId(parent, "--parent") } : {}),
    ...(playlist !== undefined ? { default_playlist_id: screenFolderPlaylistOption(playlist) } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await folderCall(client, { method: "POST", path: FOLDERS_PATH, idempotent: true, body });
  const id = (response.body as ScreenFolder | undefined)?.id ?? "";
  return folderResult(response, client.requestId, `Created screen folder ${id} ${parent === undefined ? "at the project root" : `inside ${parent}`}. screenrig screen move SCREEN_ID --folder ${id} puts screens in it.`);
});

export const handleScreenFolderUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = screenFolderId(args.positionals[3], "screen folder update <id>");
  const name = flagString(args.flags, "name");
  const parent = flagString(args.flags, "parent");
  const root = flagBool(args.flags, "root");
  const playlist = flagString(args.flags, "default-playlist-id");
  const clearDefault = flagBool(args.flags, "clear-default");
  const revision = flagString(args.flags, "expect-rev");
  if (name === undefined && parent === undefined && !root && playlist === undefined && !clearDefault) {
    throw usageError("screen folder update requires --name NAME, --parent ID, --root, --default-playlist-id ID or --clear-default.");
  }
  if (parent !== undefined && root) throw usageError("Give --parent ID or --root, not both.");
  if (playlist !== undefined && clearDefault) throw usageError("Give --default-playlist-id ID or --clear-default, not both.");
  const body: ScreenFolderPatch = {
    ...(name !== undefined ? { name: screenFolderName(name) } : {}),
    ...(parent !== undefined ? { parent_id: screenFolderId(parent, "--parent") } : {}),
    ...(root ? { parent_id: null } : {}),
    ...(playlist !== undefined ? { default_playlist_id: screenFolderPlaylistOption(playlist) } : {}),
    ...(clearDefault ? { default_playlist_id: null } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await folderCall(client, {
    method: "PATCH", path: `${FOLDERS_PATH}/${id}`, idempotent: true, body,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  }, id);
  return folderResult(response, client.requestId, `Updated screen folder ${id}. The screens inside re-resolve their playlist within about 15 seconds.`);
});

export const handleScreenFolderDelete = commandHandler(async (args, runtime, resolved) => {
  const id = screenFolderId(args.positionals[3], "screen folder delete <id>");
  const revision = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await folderCall(client, {
    method: "DELETE", path: `${FOLDERS_PATH}/${id}`, idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  }, id, "delete");
  return {
    envelope: jsonBody({ ...response, body: { id, deleted: true } }, client.requestId),
    exitCode: ExitCode.Success,
    human: `Deleted screen folder ${id}; its screens and folders moved up into its parent (the project root when it had none) and the screens re-resolve their playlist.`,
  };
});

export const handleScreenMove = commandHandler(async (args, runtime, resolved) => {
  const destination = flagString(args.flags, "folder");
  const toRoot = flagBool(args.flags, "root");
  if ((destination === undefined) === !toRoot) throw usageError("screen move requires exactly one of --folder ID or --root.");
  const screen_ids: string[] = [];
  const folder_ids: string[] = [];
  const ids = args.positionals.slice(2);
  for (const id of ids) {
    if (SCREEN_FOLDER_ID_PATTERN.test(id)) folder_ids.push(id);
    else if (isResourceID(id, "screen")) screen_ids.push(id);
    else throw usageError(`screen move takes screen IDs (scr_...) and screen folder IDs (sfd_...), not ${JSON.stringify(id)}.`);
  }
  if (!ids.length) throw usageError("screen move requires at least one screen or folder ID.");
  if (new Set(ids).size !== ids.length) throw usageError("screen move lists an ID more than once.");
  if (ids.length > SCREEN_MOVE_IDS_MAX) throw usageError(`screen move takes at most ${SCREEN_MOVE_IDS_MAX} IDs in one request; split the move.`);
  const folder = destination === undefined ? null : screenFolderId(destination, "--folder");
  if (folder !== null && folder_ids.includes(folder)) throw usageError("A folder cannot move into itself.");
  const body: ScreenMove = {
    folder_id: folder,
    ...(screen_ids.length ? { screen_ids } : {}),
    ...(folder_ids.length ? { folder_ids } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await folderCall(client, { method: "POST", path: "/api/screens/move", idempotent: true, body });
  const moved = response.body as ScreenMoveResult | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      `Moved ${plural(moved?.screens ?? 0, "screen")} and ${plural(moved?.folders ?? 0, "folder")} ${folder === null ? "to the project root" : `into ${folder}`}.`,
      ...levelsLines(moved?.levels),
    ].join("\n"),
  };
});
