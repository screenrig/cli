import { requireToken } from "./client.js";
import { flagString, type ParsedArgs } from "./command-input.js";
import { clientFor, commandHandler, jsonBody, playlistWriteResult, type CommandHandler } from "./commands.js";
import { ExitCode } from "./exit-codes.js";
import { isResourceID } from "./generated/resource-ids.js";
import { quotedRevision } from "./if-match.js";
import { usageError } from "./problems.js";
import { table } from "./webhooks.js";

/** PlaylistRevisionAuthor: who made a revision, as the project's event log names them. */
export interface PlaylistRevisionAuthor { type: "person" | "agent"; id?: string; name: string }
/** PlaylistRevision (vendor/openapi.yaml): one stored revision of a playlist. */
export interface PlaylistRevision {
  revision: number;
  created_at: string;
  change: "created" | "edited" | "promoted" | "baseline";
  restored_from?: number;
  name: string;
  page_count: number;
  current: boolean;
  author?: PlaylistRevisionAuthor;
}
export interface PlaylistRevisionList { items: PlaylistRevision[]; next_cursor?: string | null }
export interface PlaylistRevisionDetail { revision: PlaylistRevision; playlist: unknown }

const playlistRevisionsPath = (id: string): string => `/api/playlists/${encodeURIComponent(id)}/revisions`;

/** A promote copies a revision forward, so the row names the one it copied. */
function changeText(item: PlaylistRevision): string {
  return item.change === "promoted" && item.restored_from !== undefined ? `promoted from ${item.restored_from}` : item.change;
}

function authorText(author: PlaylistRevisionAuthor | undefined): string {
  return author ? `${author.name} (${author.type})` : "—";
}

/** The human page of `playlist revisions`: one row per revision and the command that reads the next page. */
export function playlistRevisionLines(playlistId: string, page: PlaylistRevisionList | undefined): string[] {
  const items = Array.isArray(page?.items) ? page.items : [];
  const next = typeof page?.next_cursor === "string" && page.next_cursor ? page.next_cursor : undefined;
  return [
    `Playlist ${playlistId} revisions (${items.length})`,
    ...(items.length
      ? table(["REVISION", "CHANGE", "PAGES", "CREATED", "AUTHOR", "NAME"], items.map((item) => [
        `${item.revision}${item.current ? " (current)" : ""}`, changeText(item), String(item.page_count), item.created_at, authorText(item.author), item.name,
      ]))
      : ["No revisions"]),
    ...(next ? [`next: screenrig playlist revisions ${playlistId} --after ${next}`] : []),
  ];
}

/** The human view of `playlist revision show`: the revision's facts, then the playlist as it stood. */
export function playlistRevisionDetailLines(playlistId: string, detail: PlaylistRevisionDetail | undefined): string[] {
  const revision = detail?.revision;
  if (!revision) return [`Playlist ${playlistId} revision\n${JSON.stringify(detail, null, 2)}`];
  return [
    `Playlist ${playlistId} revision ${revision.revision}${revision.current ? " (current)" : ""}`,
    `change: ${changeText(revision)}`,
    `created: ${revision.created_at}`,
    `author: ${authorText(revision.author)}`,
    `name: ${revision.name}`,
    `pages: ${revision.page_count}`,
    JSON.stringify(detail.playlist, null, 2),
  ];
}

export const handlePlaylistRevisions = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("playlist revisions requires <id>.");
  const after = flagString(args.flags, "after");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: playlistRevisionsPath(id), query: after !== undefined ? { after } : {} });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: playlistRevisionLines(id, response.body as PlaylistRevisionList | undefined).join("\n"),
  };
});

/** `--revision` is validated by the command; the path takes the number it names, never the raw text. */
function revisionNumber(args: ParsedArgs, command: string): number {
  const value = flagString(args.flags, "revision");
  const number = Number(value);
  if (value === undefined || !Number.isSafeInteger(number) || number < 1) throw usageError(`${command} requires --revision N, a whole number from 1.`);
  return number;
}

export const handlePlaylistRevisionShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("playlist revision show requires <id> and --revision N.");
  const number = revisionNumber(args, "playlist revision show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${playlistRevisionsPath(id)}/${number}` });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: playlistRevisionDetailLines(id, response.body as PlaylistRevisionDetail | undefined).join("\n"),
  };
});

export const handlePlaylistPromote = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const expected = flagString(args.flags, "if-match");
  if (!id) throw usageError("playlist promote requires <id>, --revision N and --expect-rev CURRENT.");
  const number = revisionNumber(args, "playlist promote");
  if (expected === undefined) throw usageError("playlist promote requires --expect-rev, the playlist's current revision.", {
    command: `screenrig playlist show ${id}`,
    reason: "Shows the playlist; its revision is the current revision to pass as --expect-rev.",
  });
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "POST", path: `${playlistRevisionsPath(id)}/${number}/promote`, idempotent: true,
    headers: { "if-match": quotedRevision(expected) },
  });
  // The answer is the playlist: a revision equal to the current one answers it unchanged.
  const current = (response.body as { revision?: unknown } | undefined)?.revision;
  const unchanged = current === Number(expected);
  return playlistWriteResult(response, client.requestId, unchanged
    ? `Revision ${number} holds the playlist's current content; nothing changed. ${id} stays at revision ${current}.`
    : `Promoted revision ${number} of ${id}: it is now the current revision ${current}. The name is unchanged and every screen showing the playlist updates.`);
}, true);

/** The two commands that listed and restored a screen's composition history; playlist revisions replaced them. */
const REMOVED_SCREEN_COMMANDS = {
  changes: "screen changes was removed: a screen's history is now its playlist's revision history. Read the screen's playlist_id with `screenrig screen show SCREEN_ID`, list the playlist's revisions with `screenrig playlist revisions PLAYLIST_ID` and read one with `screenrig playlist revision show PLAYLIST_ID --revision N`.",
  revert: "screen revert was removed: list the playlist's revisions with `screenrig playlist revisions PLAYLIST_ID` and make one current with `screenrig playlist promote PLAYLIST_ID --revision N --expect-rev CURRENT`.",
} as const;

/**
 * Hidden `screen changes` and `screen revert`, kept for one release: they send
 * nothing, need no credential, and fail with the replacement so a caller that
 * still runs them learns what to run instead.
 */
export const handleScreenCompositionRemoved: CommandHandler = async (args) => {
  const name = args.command[1] === "revert" ? "revert" : "changes";
  const screenId = args.positionals.slice(2).find((value) => isResourceID(value, "screen"));
  throw usageError(REMOVED_SCREEN_COMMANDS[name],
    screenId
      ? { command: `screenrig screen show ${screenId}`, argv: ["screen", "show", screenId], reason: "Shows the screen's playlist_id, the playlist whose revisions replace the screen's change history." }
      : { command: "screenrig playlist revisions --help", argv: ["playlist", "revisions", "--help"], reason: "Lists the arguments of the command that reads a playlist's revision history, with an example." },
    "Nothing was sent. Run the command named in detail instead.");
};
