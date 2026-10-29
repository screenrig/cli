// Command handlers for the comment commands, loaded on demand.
import { flagString, type ParsedArgs } from "../command-input.js";
import { requireToken } from "../client.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { commentsWriteFromArgs } from "../comments-write.js";
import { clientFor, commandHandler, humanLines, isScreenId, jsonBody, requireFlagValue, simpleGet, type CommandResult, type ResolvedCommandConfig } from "../commands.js";

export const PLAYLIST_PAGE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function commentPath(target: "screen" | "playlist", id: string, pageId: string | undefined): string {
  if (target === "screen") {
    return `/api/comment/screen/${encodeURIComponent(id)}`;
  }
  if (pageId) {
    return `/api/comment/playlist/${encodeURIComponent(id)}/page/${encodeURIComponent(pageId)}`;
  }
  return `/api/comment/playlist/${encodeURIComponent(id)}`;
}

export function commentTarget(args: ParsedArgs, target: "screen" | "playlist") {
  const id = args.positionals[3];
  if (!id || (target === "screen" && !isScreenId(id))) {
    throw usageError(`comment ${target} requires <id>.`);
  }

  if (Object.hasOwn(args.flags, "expect-rev")) {
    throw usageError("comment commands do not take --expect-rev; last write wins and does not bump revision.");
  }
  requireFlagValue(args, "page", "poster");
  const pageId = flagString(args.flags, "page");
  if (target === "screen" && pageId !== undefined) {
    throw usageError("comment screen commands do not take --page; use comment playlist <id> --page PAGE_ID.");
  }
  if (pageId !== undefined && !PLAYLIST_PAGE_ID_PATTERN.test(pageId)) {
    throw usageError("--page must be a playlist page id: a letter, then up to 63 letters, digits, underscores, or hyphens.");
  }
  const pathName = commentPath(target, id, pageId);

  return { id, pageId, pathName };
}

export async function showComment(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, target: "screen" | "playlist"): Promise<CommandResult> {
  const { pathName } = commentTarget(args, target);
  return simpleGet(args, runtime, resolved, pathName, "Comments");

}

export const handleCommentShowScreen = commandHandler((args, runtime, resolved) => showComment(args, runtime, resolved, "screen"));
export const handleCommentShowPlaylist = commandHandler((args, runtime, resolved) => showComment(args, runtime, resolved, "playlist"));

export async function setComment(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, target: "screen" | "playlist"): Promise<CommandResult> {
  const { id, pageId, pathName } = commentTarget(args, target);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));

  const body = await commentsWriteFromArgs(args, runtime.cwd(), runtime);
  const response = await client.call({
    method: "PUT",
    path: pathName,
    idempotent: true,
    body,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Comments set", [
      [target, id],
      ["page", pageId],
    ]),
  };

}

export const handleCommentSetScreen = commandHandler((args, runtime, resolved) => setComment(args, runtime, resolved, "screen"));
export const handleCommentSetPlaylist = commandHandler((args, runtime, resolved) => setComment(args, runtime, resolved, "playlist"));

export async function deleteComment(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, target: "screen" | "playlist"): Promise<CommandResult> {
  const { id, pageId, pathName } = commentTarget(args, target);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));

  const response = await client.call({
    method: "DELETE",
    path: pathName,
    idempotent: true,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: pageId
      ? `Deleted comments on playlist ${id} page ${pageId}`
      : `Deleted comments on ${target} ${id}`,
  };

}

export const handleCommentDeleteScreen = commandHandler((args, runtime, resolved) => deleteComment(args, runtime, resolved, "screen"));
export const handleCommentDeletePlaylist = commandHandler((args, runtime, resolved) => deleteComment(args, runtime, resolved, "playlist"));
