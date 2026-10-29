// Command handlers for the fleet-links commands, loaded on demand.
import { fieldMap } from "../screen-facts.js";
import { androidProvisioning, fetchManagedArtifact, fleetLinkSecret, PROVISIONING_NOTICE, siteOrigin, unsupportedSiteError } from "../android-provisioning.js";
import { fleetLinkExpiresAt, fleetLinkId, fleetLinkLines, fleetLinkMaxScreens, fleetLinkName, fleetLinkPlaylistId, fleetLinkProblem, fleetLinkRedactedNote, fleetLinkTableLines, fleetLinkUrlLines, fleetLinkUrlProblem, guardFleetLink, guardFleetLinks } from "../fleet-links.js";
import { type FleetLink, type FleetLinkList, type FleetLinkPatch, type FleetLinkWrite } from "../adapters/protocol.js";
import { flagBool, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, makeProblem, unexpectedResponseError, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { quotedRevision } from "../if-match.js";
import { clientFor, commandHandler, jsonBody, type CommandResult } from "../commands.js";


// Fleet links: /api/fleet-links. url is a credential that creates screens; it
// is checked before it is printed, never shown in the human list, and kept out
// of the operation log (client.ts privateBodies).
export const FLEET_LINKS_PATH = "/api/fleet-links";

export async function fleetLinkCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw fleetLinkProblem(error, id);
  }
}

export function fleetLinkRevisionHeaders(args: ParsedArgs): Record<string, string> | undefined {
  const revision = flagString(args.flags, "expect-rev");
  return revision ? { "if-match": quotedRevision(revision) } : undefined;
}

export function fleetLinkTagList(args: ParsedArgs): string[] | undefined {
  const tags = flagString(args.flags, "tag");
  return tags === undefined ? undefined : tags.split(",");
}

export function fleetLinkResult(response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, title: string, withUrl: boolean, now: Date): CommandResult {
  const answered = response.body as FleetLink | undefined;
  const { link, warnings } = answered && typeof answered === "object" ? guardFleetLink(answered) : { link: answered, warnings: [] };
  return {
    envelope: jsonBody({ ...response, body: link }, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: [
      title,
      ...fleetLinkLines(link, now),
      ...(withUrl ? fleetLinkUrlLines(link, warnings.length > 0) : []),
      ...warnings.map((warning) => `warning: ${warning.message}`),
    ].join("\n"),
  };
}

export const handleFleetLinksCreate = commandHandler(async (args, runtime, resolved) => {
  const label = fleetLinkName(flagString(args.flags, "name") ?? "");
  const tags = fleetLinkTagList(args);
  const fields = fieldMap(flagString(args.flags, "field"));
  const playlistId = flagString(args.flags, "playlist-id");
  const maxScreens = flagString(args.flags, "max-screens");
  const expiresAt = flagString(args.flags, "expires-at");
  const body: FleetLinkWrite = {
    label,
    ...(flagBool(args.flags, "disabled") ? { enabled: false } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(playlistId !== undefined ? { playlist_id: fleetLinkPlaylistId(playlistId) } : {}),
    ...(maxScreens !== undefined ? { max_screens: Number(fleetLinkMaxScreens(maxScreens)) } : {}),
    ...(expiresAt !== undefined ? { expires_at: fleetLinkExpiresAt(expiresAt) } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, { method: "POST", path: FLEET_LINKS_PATH, idempotent: true, body });
  const id = (response.body as FleetLink | undefined)?.id;
  return fleetLinkResult(response, client, `Created fleet link ${id ?? ""}`.trimEnd(), true, runtime.now());
});

export const handleFleetLinksList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, { method: "GET", path: FLEET_LINKS_PATH });
  const listed = (response.body as FleetLinkList | undefined)?.items;
  const { items, warnings } = guardFleetLinks(Array.isArray(listed) ? listed : []);
  return {
    envelope: jsonBody({ ...response, body: { ...(response.body as object | undefined), items } }, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: [`Fleet links (${items.length})`, ...fleetLinkTableLines(items, runtime.now()), ...fleetLinkRedactedNote(items), ...warnings.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
});

export const handleFleetLinksShow = commandHandler(async (args, runtime, resolved) => {
  const id = fleetLinkId(args.positionals[2], "show");
  const wantsProvisioning = flagBool(args.flags, "android-provisioning");
  const origin = wantsProvisioning ? siteOrigin(resolved.apiUrl) : undefined;
  if (wantsProvisioning && origin === undefined) throw unsupportedSiteError();
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, { method: "GET", path: `${FLEET_LINKS_PATH}/${id}` }, id);
  if (origin === undefined) return fleetLinkResult(response, client, "Fleet link", true, runtime.now());
  return fleetLinkAndroidProvisioning(response, client, origin, runtime);
});

/**
 * `fleet-links show --android-provisioning`: the payload the dashboard's QR code
 * encodes, from the link's secret and the site's `managed` Android build. The
 * secret comes from the link as returned (a Read only credential gets none) and
 * the payload is printed once, under a sensitive label, never logged.
 */
export async function fleetLinkAndroidProvisioning(response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, origin: string, runtime: CliRuntime): Promise<CommandResult> {
  const answered = response.body as FleetLink | undefined;
  const secret = answered && typeof answered === "object" && !fleetLinkUrlProblem(answered.url) ? fleetLinkSecret(answered.url) : undefined;
  if (secret === undefined) {
    throw new CliError(makeProblem("fleet_link_secret_unavailable", "Fleet link secret unavailable", 403,
      answered?.url_redacted === true
        ? "A Read only credential receives no fleet link URL, so the provisioning payload cannot carry the link's secret."
        : "The fleet link was returned without a usable URL, so the provisioning payload cannot carry its secret.",
      { next: { command: "screenrig login --access manage", reason: "A Manage sign-in receives the fleet link URL." } }));
  }
  const artifact = await fetchManagedArtifact(origin, runtime.siteFetch ?? globalThis.fetch);
  const provisioning = androidProvisioning(artifact, origin, secret);
  if (provisioning === undefined) {
    throw unexpectedResponseError(`The managed Android build lists a path outside ${origin}/android/, so no download location is built for it.`);
  }
  const id = String(answered?.id ?? "");
  return {
    envelope: successEnvelope({ id, provisioning }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: [`Android device owner provisioning for fleet link ${id}`, PROVISIONING_NOTICE, "", JSON.stringify(provisioning)].join("\n"),
  };
}

export const handleFleetLinksUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = fleetLinkId(args.positionals[2], "update");
  const name = flagString(args.flags, "name");
  const tags = fleetLinkTagList(args);
  const fields = fieldMap(flagString(args.flags, "field"));
  const playlistId = flagString(args.flags, "playlist-id");
  const maxScreens = flagString(args.flags, "max-screens");
  const expiresAt = flagString(args.flags, "expires-at");
  const patch: FleetLinkPatch = {
    ...(name !== undefined ? { label: fleetLinkName(name) } : {}),
    ...(flagBool(args.flags, "enable") ? { enabled: true } : {}),
    ...(flagBool(args.flags, "disable") ? { enabled: false } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(flagBool(args.flags, "clear-tags") ? { tags: [] } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(flagBool(args.flags, "clear-fields") ? { fields: null } : {}),
    ...(playlistId !== undefined ? { playlist_id: fleetLinkPlaylistId(playlistId) } : {}),
    ...(flagBool(args.flags, "clear-playlist") ? { playlist_id: null } : {}),
    ...(maxScreens !== undefined ? { max_screens: Number(fleetLinkMaxScreens(maxScreens)) } : {}),
    ...(flagBool(args.flags, "clear-max-screens") ? { max_screens: null } : {}),
    ...(expiresAt !== undefined ? { expires_at: fleetLinkExpiresAt(expiresAt) } : {}),
    ...(flagBool(args.flags, "clear-expires-at") ? { expires_at: null } : {}),
  };
  if (!Object.keys(patch).length) {
    throw usageError("fleet-links update requires at least one of --name, --enable, --disable, --tag, --clear-tags, --field, --clear-fields, --playlist-id, --clear-playlist, --max-screens, --clear-max-screens, --expires-at, or --clear-expires-at.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, {
    method: "PATCH", path: `${FLEET_LINKS_PATH}/${id}`, idempotent: true, body: patch, headers: fleetLinkRevisionHeaders(args),
  }, id);
  return fleetLinkResult(response, client, `Updated fleet link ${id}. Screens it already created are unchanged.`, false, runtime.now());
});

export const handleFleetLinksRotate = commandHandler(async (args, runtime, resolved) => {
  const id = fleetLinkId(args.positionals[2], "rotate");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, {
    method: "POST", path: `${FLEET_LINKS_PATH}/${id}/rotate`, idempotent: true, headers: fleetLinkRevisionHeaders(args),
  }, id);
  return fleetLinkResult(response, client,
    `Rotated fleet link ${id}. The old URL stopped working; screens it already created keep playing. Put the new URL in your device manager.`, true, runtime.now());
});

export const handleFleetLinksDelete = commandHandler(async (args, runtime, resolved) => {
  const id = fleetLinkId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, {
    method: "DELETE", path: `${FLEET_LINKS_PATH}/${id}`, idempotent: true, headers: fleetLinkRevisionHeaders(args),
  }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted fleet link ${id}. Its URL stopped working; screens it created stay, with their playlists and tags.`,
  };
});
