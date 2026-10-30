// Command handlers for a screen's playlist schedule history, restore and preview, loaded on demand.
import type { RevisionPage, SchedulePreview, Screen, ScreenSchedulePreviewRequest, ScreenScheduleRevision } from "../adapters/protocol.js";
import { readAuthoringJson } from "../authoring-input.js";
import { ApiClient, requireToken } from "../client.js";
import { screenScheduleRevisionLines, schedulePreviewLines } from "../change-control.js";
import { flagString, type ParsedArgs } from "../command-input.js";
import { clientFor, commandHandler, jsonBody, pendingReviewResult } from "../commands.js";
import { ExitCode } from "../exit-codes.js";
import { revisionNumber } from "../playlist-revisions.js";
import { unexpectedResponseError, usageError } from "../problems.js";
import { pendingReviewOf } from "../reviews.js";
import { scheduleEntries } from "../screen-control.js";
import { screenControlCall, screenControlHeaders, screenControlHuman } from "./screen.js";

const schedulePath = (id: string): string => `/api/screens/${encodeURIComponent(id)}/playlist-schedule`;

/** The screen's id from `screen schedule COMMAND ID`: a history belongs to one screen. */
function singleScreen(args: ParsedArgs, command: string): string {
  const id = args.positionals[3];
  if (!id) throw usageError(`${command} requires <id>.`);
  return id;
}

export const handleScreenScheduleRevisions = commandHandler(async (args, runtime, resolved) => {
  const id = singleScreen(args, "screen schedule revisions");
  const after = flagString(args.flags, "after");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await screenControlCall(client, id, { method: "GET", path: `${schedulePath(id)}/revisions`, ...(after !== undefined ? { query: { after } } : {}) });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenScheduleRevisionLines(id, response.body as RevisionPage<ScreenScheduleRevision> | undefined).join("\n"),
  };
});

/** The revision for If-Match: the one the caller names, else the screen's own, read just before the write. */
async function screenGuard(client: ApiClient, id: string, given: string | undefined): Promise<string> {
  if (given !== undefined) return given;
  const response = await screenControlCall(client, id, { method: "GET", path: `/api/screens/${encodeURIComponent(id)}` });
  const current = (response.body as Screen | undefined)?.revision;
  if (typeof current !== "number") throw unexpectedResponseError("The screen answer lacks its revision.", client.requestId);
  return String(current);
}

export const handleScreenScheduleRestore = commandHandler(async (args, runtime, resolved) => {
  const id = singleScreen(args, "screen schedule restore");
  const number = revisionNumber(args, "screen schedule restore");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const expected = await screenGuard(client, id, flagString(args.flags, "expect-rev"));
  const response = await screenControlCall(client, id, {
    method: "POST", path: `${schedulePath(id)}/revisions/${number}/restore`, idempotent: true,
    headers: screenControlHeaders(args, expected),
  });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenControlHuman(`Restored revision ${number} of the playlist schedule on ${id}${screen?.revision === Number(expected) ? "; it already held that content, so nothing changed" : ""}`, screen),
  };
});

export const handleScreenSchedulePreview = commandHandler(async (args, runtime, resolved) => {
  const file = flagString(args.flags, "file");
  if (!file) throw usageError("screen schedule preview requires --file FILE (or --file - for stdin).");
  const id = singleScreen(args, "screen schedule preview");
  const entries = scheduleEntries(await readAuthoringJson(file, runtime));
  const from = flagString(args.flags, "calendar-from");
  const to = flagString(args.flags, "calendar-to");
  const body: ScreenSchedulePreviewRequest = { entries, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await screenControlCall(client, id, { method: "POST", path: `${schedulePath(id)}/preview`, body });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: schedulePreviewLines(`a ${entries.length}-entry playlist schedule on ${id}`, response.body as SchedulePreview | undefined).join("\n"),
  };
});
