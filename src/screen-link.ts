import type { ScreenLink } from "./adapters/protocol.js";
import { flagString } from "./command-input.js";
import { requireToken } from "./client.js";
import { clientFor, commandHandler, jsonBody } from "./commands.js";
import type { Warning } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { quotedRevision } from "./if-match.js";
import { guardScreenLink, screenLinkLines, screenLinkProblem, screenLinkScreenId, screenLinkUrlLines } from "./screen-link-format.js";

/** The handlers of `screen link create|show|delete`. The rules they apply are in screen-link-format.ts. */

function linkPath(id: string): string {
  return `/api/screens/${id}/link`;
}

async function linkCall(client: ReturnType<typeof clientFor>, request: Parameters<ReturnType<typeof clientFor>["call"]>[0], id: string) {
  try {
    return await client.call(request);
  } catch (error) {
    throw screenLinkProblem(error, id);
  }
}

function revisionHeaders(revision: string | undefined): Record<string, string> | undefined {
  return revision ? { "if-match": quotedRevision(revision) } : undefined;
}

function linkResult(id: string, response: Awaited<ReturnType<ReturnType<typeof clientFor>["call"]>>, requestId: string, title: string) {
  const answered = response.body as ScreenLink | undefined;
  const { link, warnings } = answered && typeof answered === "object" ? guardScreenLink(id, answered) : { link: answered, warnings: [] as Warning[] };
  return {
    envelope: jsonBody({ ...response, body: { ...(link ?? {}), screen_id: id } }, requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: [
      title,
      ...screenLinkLines(id, link),
      ...screenLinkUrlLines(link, warnings.length > 0),
      ...warnings.map((warning) => `warning: ${warning.message}`),
    ].join("\n"),
  };
}

export const handleScreenLinkCreate = commandHandler(async (args, runtime, resolved) => {
  const id = screenLinkScreenId(args.positionals[3], "create");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await linkCall(client, {
    method: "POST", path: linkPath(id), idempotent: true, headers: revisionHeaders(flagString(args.flags, "if-match")),
  }, id);
  const replaced = (response.body as ScreenLink | undefined)?.replaced === true;
  return linkResult(id, response, client.requestId,
    replaced
      ? `Replaced the link of screen ${id}. The old URL stopped working at once; put the new URL in the browser source.`
      : `Created the link of screen ${id}. Put its URL in the browser source and open it in one place.`);
});

export const handleScreenLinkShow = commandHandler(async (args, runtime, resolved) => {
  const id = screenLinkScreenId(args.positionals[3], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await linkCall(client, { method: "GET", path: linkPath(id) }, id);
  return linkResult(id, response, client.requestId, `Link of screen ${id}`);
});

export const handleScreenLinkDelete = commandHandler(async (args, runtime, resolved) => {
  const id = screenLinkScreenId(args.positionals[3], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await linkCall(client, {
    method: "DELETE", path: linkPath(id), idempotent: true, headers: revisionHeaders(flagString(args.flags, "if-match")),
  }, id);
  return {
    envelope: jsonBody({ ...response, body: { screen_id: id, deleted: true } }, client.requestId),
    exitCode: ExitCode.Success,
    human: `Turned off the link of screen ${id}. Its URL stopped working at once; a browser source still showing it shows a notice and no content.`,
  };
});
