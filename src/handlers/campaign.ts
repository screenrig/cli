// Command handlers for the campaign commands, loaded on demand.
import { readAuthoringText } from "../authoring-input.js";
import { LEVEL_IDLE_DEFAULT_S } from "../screen-control.js";
import { CAMPAIGN_AUDIENCE_INPUT_MAX_BYTES, campaignPromoteProblem, campaignAllScreensAudience, campaignAnyTagAudience, campaignAudienceJson, campaignFolder, campaignFolderAudience, campaignBounds, campaignExplainLines, campaignId, campaignLines, campaignName, campaignPlaylistId, campaignProblem, campaignScreenAudience, campaignScreenId, campaignScreensLines, campaignTableLines, campaignTagAudience, campaignWindowList, campaignDateList, campaignDisplayList, campaignMonthlyList } from "../campaigns.js";
import { type Campaign, type CampaignAudience, type CampaignList, type CampaignPatch, type CampaignPreviewRequest, type CampaignPromote, type CampaignRevision, type CampaignScreens, type CampaignWrite, type LevelCovers, type RevisionPage, type SchedulePreview, type ScreenCampaigns } from "../adapters/protocol.js";
import { campaignRevisionLines, schedulePreviewLines } from "../change-control.js";
import { revisionNumber } from "../playlist-revisions.js";
import { flagBool, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { unexpectedResponseError, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { quotedRevision } from "../if-match.js";
import { pendingReviewOf } from "../reviews.js";
import { clientFor, commandHandler, jsonBody, pendingReviewResult, reviewNoteFrom, type CommandResult, type ResolvedCommandConfig } from "../commands.js";


// Content campaigns: /api/campaigns switch every screen of an audience to a
// playlist while from, until and windows hold in each screen's timezone.
// campaign explain reads /api/screens/{id}/campaigns. Advertising campaigns
// (ads campaigns) are a different resource that shares the cmp_ id prefix.
export const CAMPAIGNS_PATH = "/api/campaigns";

export async function campaignCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
  subject: "campaign" | "screen" = "campaign",
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw campaignProblem(error, id, subject);
  }
}

/** The revision guard and the review note of a campaign write. */
export function campaignRevisionHeaders(args: ParsedArgs): Record<string, string> | undefined {
  const revision = flagString(args.flags, "expect-rev");
  const headers = { ...reviewNoteFrom(args), ...(revision ? { "if-match": quotedRevision(revision) } : {}) };
  return Object.keys(headers).length ? headers : undefined;
}


/**
 * The audience the flags name, or undefined when none is given: --tag (every
 * listed tag), --any-tag (at least one), --screen-id, --folder (a screen
 * folder and every folder inside it), --all-screens, or --audience (a raw
 * rule: inline JSON, @FILE, or - for stdin).
 */
export async function campaignAudienceFlag(args: ParsedArgs, runtime: CliRuntime): Promise<CampaignAudience | undefined> {
  const tags = flagString(args.flags, "tag");
  const anyTags = flagString(args.flags, "any-tag");
  const screenIds = flagString(args.flags, "screen-id");
  const folder = flagString(args.flags, "folder");
  const raw = flagString(args.flags, "audience");
  const all = flagBool(args.flags, "all-screens");
  if ([tags, anyTags, screenIds, folder, raw].filter((value) => value !== undefined).length + (all ? 1 : 0) > 1) {
    throw usageError("Provide at most one of --tag, --any-tag, --screen-id, --folder, --all-screens or --audience.");
  }
  if (tags !== undefined) return campaignTagAudience(tags.split(","));
  if (anyTags !== undefined) return campaignAnyTagAudience(anyTags.split(","));
  if (screenIds !== undefined) return campaignScreenAudience(screenIds.split(","));
  if (folder !== undefined) return campaignFolderAudience(campaignFolder(folder));
  if (all) return campaignAllScreensAudience();
  if (raw === undefined) return undefined;
  const source = raw.trim();
  const text = source === "-" || source.startsWith("@")
    ? await readAuthoringText(source === "-" ? source : source.slice(1), runtime, CAMPAIGN_AUDIENCE_INPUT_MAX_BYTES)
    : raw;
  return campaignAudienceJson(text);
}

/**
 * The level members the flags set: --monthly, --date, --except, --on-touch
 * (60 seconds without a value), --displays and --start. A member the flags do
 * not name stays out of the body.
 */
export function campaignLevelFlags(args: ParsedArgs): Pick<CampaignWrite, "monthly" | "dates" | "except" | "interaction" | "covers" | "displays" | "start"> {
  const monthly = flagString(args.flags, "monthly");
  const dates = flagString(args.flags, "date");
  const except = flagString(args.flags, "except");
  const covers = flagString(args.flags, "covers");
  const displays = flagString(args.flags, "displays");
  const start = flagString(args.flags, "start");
  const onTouch = args.flags["on-touch"];
  return {
    ...(monthly !== undefined ? { monthly: campaignMonthlyList(monthly) } : {}),
    ...(dates !== undefined ? { dates: campaignDateList(dates) } : {}),
    ...(except !== undefined ? { except: except.split(",") } : {}),
    ...(onTouch !== undefined && onTouch !== false ? { interaction: { idle_s: typeof onTouch === "string" ? Number(onTouch) : LEVEL_IDLE_DEFAULT_S } } : {}),
    ...(covers !== undefined ? { covers: covers as LevelCovers } : {}),
    ...(displays !== undefined ? { displays: campaignDisplayList(displays) } : {}),
    ...(start !== undefined ? { start: start === "on-time" ? "on_time" as const : "next_item" as const } : {}),
  };
}

export function campaignResult(response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, title: string): CommandResult {
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [title, ...campaignLines(response.body as Campaign | undefined)].join("\n"),
  };
}

/** The body of a new campaign from the create flags (campaign preview without an ID reads the same flags). */
export async function campaignCreateBody(args: ParsedArgs, runtime: CliRuntime, command: string): Promise<CampaignWrite> {
  const name = campaignName(flagString(args.flags, "name") ?? "");
  const playlistId = campaignPlaylistId(flagString(args.flags, "playlist-id") ?? "");
  const audience = await campaignAudienceFlag(args, runtime);
  if (!audience) throw usageError(`${command} takes exactly one of --tag, --any-tag, --screen-id, --folder, --all-screens or --audience.`);
  const from = flagString(args.flags, "from");
  const until = flagString(args.flags, "until");
  campaignBounds(from, until);
  const windows = flagString(args.flags, "window");
  const priority = flagString(args.flags, "priority");
  const paused = flagBool(args.flags, "paused");
  return {
    name,
    playlist_id: playlistId,
    audience,
    ...(from !== undefined ? { from } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(windows !== undefined ? { windows: campaignWindowList(windows) } : {}),
    ...campaignLevelFlags(args),
    ...(priority !== undefined ? { priority: Number(priority) } : {}),
    ...(paused ? { paused: true } : {}),
  };
}

export const handleCampaignCreate = commandHandler(async (args, runtime, resolved) => {
  const body = await campaignCreateBody(args, runtime, "campaign create");
  const paused = body.paused === true;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, { method: "POST", path: CAMPAIGNS_PATH, idempotent: true, body, headers: campaignRevisionHeaders(args) });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  const id = (response.body as Campaign | undefined)?.id ?? "";
  return campaignResult(response, client, paused
    ? `Created campaign ${id}, paused. No screen changes until screenrig campaign resume ${id}.`
    : `Created campaign ${id}. Screens in its audience switch to the playlist within a minute while it holds; screenrig campaign screens ${id} shows each screen's standing.`);
});

export const handleCampaignList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, { method: "GET", path: CAMPAIGNS_PATH });
  const items = (response.body as CampaignList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Campaigns (${list.length}), in the order screens read them`, ...campaignTableLines(list)].join("\n"),
  };
});

export const handleCampaignShow = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, { method: "GET", path: `${CAMPAIGNS_PATH}/${id}` }, id);
  return campaignResult(response, client, "Campaign");
});

/** The members the update flags change; campaign preview with an ID reads the same flags. */
export async function campaignPatchBody(args: ParsedArgs, runtime: CliRuntime): Promise<CampaignPatch> {
  const name = flagString(args.flags, "name");
  const playlistId = flagString(args.flags, "playlist-id");
  const from = flagString(args.flags, "from");
  const until = flagString(args.flags, "until");
  const windows = flagString(args.flags, "window");
  const priority = flagString(args.flags, "priority");
  const clears = (["clear-from", "clear-until", "clear-windows", "clear-monthly", "clear-dates", "clear-except", "clear-on-touch", "clear-displays"] as const).filter((flag) => flagBool(args.flags, flag));
  const audience = await campaignAudienceFlag(args, runtime);
  campaignBounds(from, until);
  const patch: CampaignPatch = {
    ...(name !== undefined ? { name: campaignName(name) } : {}),
    ...(playlistId !== undefined ? { playlist_id: campaignPlaylistId(playlistId) } : {}),
    ...(audience ? { audience } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(clears.includes("clear-from") ? { from: null } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(clears.includes("clear-until") ? { until: null } : {}),
    ...(windows !== undefined ? { windows: campaignWindowList(windows) } : {}),
    ...(clears.includes("clear-windows") ? { windows: null } : {}),
    ...campaignLevelFlags(args),
    ...(clears.includes("clear-monthly") ? { monthly: null } : {}),
    ...(clears.includes("clear-dates") ? { dates: null } : {}),
    ...(clears.includes("clear-except") ? { except: null } : {}),
    ...(clears.includes("clear-on-touch") ? { interaction: null } : {}),
    ...(clears.includes("clear-displays") ? { displays: null } : {}),
    ...(priority !== undefined ? { priority: Number(priority) } : {}),
  };
  return patch;
}

export const handleCampaignUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "update");
  const patch = await campaignPatchBody(args, runtime);
  if (!Object.keys(patch).length) {
    throw usageError("campaign update requires at least one of --name, --playlist-id, an audience (--tag, --any-tag, --screen-id, --folder, --all-screens or --audience), --from, --clear-from, --until, --clear-until, --window, --clear-windows, --monthly, --clear-monthly, --date, --clear-dates, --except, --clear-except, --on-touch, --clear-on-touch, --displays, --clear-displays, --start, or --priority.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, {
    method: "PATCH", path: `${CAMPAIGNS_PATH}/${id}`, idempotent: true, body: patch, headers: campaignRevisionHeaders(args),
  }, id);
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return campaignResult(response, client, `Updated campaign ${id}. Every screen of its old and new audience re-resolves within a minute.`);
});

export async function campaignPaused(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, paused: boolean): Promise<CommandResult> {
  const id = campaignId(args.positionals[2], paused ? "pause" : "resume");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const body: CampaignPatch = { paused };
  const response = await campaignCall(client, {
    method: "PATCH", path: `${CAMPAIGNS_PATH}/${id}`, idempotent: true, body, headers: campaignRevisionHeaders(args),
  }, id);
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return campaignResult(response, client, paused
    ? `Paused campaign ${id}. Screens that showed it return to what they would show without it within a minute; screenrig campaign resume ${id} starts it again.`
    : `Resumed campaign ${id}. Screens in its audience switch to the playlist within a minute while it holds; screenrig campaign screens ${id} shows each screen's standing.`);
}

export const handleCampaignPause = commandHandler((args, runtime, resolved) => campaignPaused(args, runtime, resolved, true));

export const handleCampaignResume = commandHandler((args, runtime, resolved) => campaignPaused(args, runtime, resolved, false));

export const handleCampaignDelete = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, {
    method: "DELETE", path: `${CAMPAIGNS_PATH}/${id}`, idempotent: true, headers: campaignRevisionHeaders(args),
  }, id);
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted campaign ${id}. Screens that showed it return to what they would show without it within a minute.`,
  };
});

export const handleCampaignScreens = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "screens");
  const limit = flagString(args.flags, "limit");
  const cursor = flagString(args.flags, "cursor");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, {
    method: "GET", path: `${CAMPAIGNS_PATH}/${id}/screens`,
    query: { ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) },
  }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: campaignScreensLines(id, response.body as CampaignScreens | undefined, limit).join("\n"),
  };
});

export const handleCampaignExplain = commandHandler(async (args, runtime, resolved) => {
  const screenId = campaignScreenId(args.positionals[2]);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const at = flagString(args.flags, "at");
  const to = flagString(args.flags, "to");
  const response = await campaignCall(client, {
    method: "GET", path: `/api/screens/${screenId}/campaigns`,
    ...(at !== undefined || to !== undefined ? { query: { ...(at !== undefined ? { at } : {}), ...(to !== undefined ? { to } : {}) } } : {}),
  }, screenId, "screen");
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: campaignExplainLines(screenId, response.body as ScreenCampaigns | undefined).join("\n"),
  };
});

/** The current revision for If-Match: the one the caller names, else the campaign's own, read just before the write. */
async function campaignGuard(client: ApiClient, args: ParsedArgs, id: string): Promise<string> {
  const given = flagString(args.flags, "expect-rev");
  if (given !== undefined) return given;
  const response = await campaignCall(client, { method: "GET", path: `${CAMPAIGNS_PATH}/${id}` }, id);
  const current = (response.body as Campaign | undefined)?.revision;
  if (typeof current !== "number") throw unexpectedResponseError("The campaign answer lacks its revision.", client.requestId);
  return String(current);
}

export const handleCampaignPublish = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "publish");
  const folder = flagString(args.flags, "test-folder");
  const screens = flagString(args.flags, "test-screen");
  const test = folder !== undefined ? campaignFolderAudience(campaignFolder(folder)) : screens !== undefined ? campaignScreenAudience(screens.split(",")) : undefined;
  const body: CampaignPatch = { paused: false, ...(test ? { audience: test } : {}) };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, {
    method: "PATCH", path: `${CAMPAIGNS_PATH}/${id}`, idempotent: true, body, headers: campaignRevisionHeaders(args),
  }, id);
  return campaignResult(response, client, test
    ? `Published campaign ${id} to a test audience. Only the screens named here switch to the playlist within a minute; screenrig campaign revisions ${id} lists the draft to copy to the real audience with screenrig campaign promote ${id} --revision N.`
    : `Published campaign ${id}. Screens in its audience switch to the playlist within a minute while it holds; screenrig campaign screens ${id} shows each screen's standing.`);
});

export const handleCampaignPromote = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "promote");
  const number = revisionNumber(args, "campaign promote");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const expected = await campaignGuard(client, args, id);
  const body: CampaignPromote = { revision: number };
  let response;
  try {
    response = await campaignCall(client, {
      method: "POST", path: `${CAMPAIGNS_PATH}/${id}/promote`, idempotent: true, body, headers: { "if-match": quotedRevision(expected) },
    }, id);
  } catch (error) {
    throw campaignPromoteProblem(error, id);
  }
  // A draft whose audience is already the campaign's changes nothing and answers the campaign as it was.
  const unchanged = (response.body as Campaign | undefined)?.revision === Number(expected);
  return campaignResult(response, client, unchanged
    ? `Revision ${number} holds the audience campaign ${id} already has; nothing changed.`
    : `Promoted revision ${number} of campaign ${id}: its audience is now the campaign's. Every screen of the old and the new audience re-resolves within a minute; screenrig campaign screens ${id} shows each screen's standing.`);
});

export const handleCampaignRevisions = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "revisions");
  const after = flagString(args.flags, "after");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, { method: "GET", path: `${CAMPAIGNS_PATH}/${id}/revisions`, ...(after !== undefined ? { query: { after } } : {}) }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: campaignRevisionLines(id, response.body as RevisionPage<CampaignRevision> | undefined).join("\n"),
  };
});

export const handleCampaignRestore = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "restore");
  const number = revisionNumber(args, "campaign restore");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const expected = await campaignGuard(client, args, id);
  const response = await campaignCall(client, {
    method: "POST", path: `${CAMPAIGNS_PATH}/${id}/revisions/${number}/restore`, idempotent: true, headers: { "if-match": quotedRevision(expected) },
  }, id);
  const unchanged = (response.body as Campaign | undefined)?.revision === Number(expected);
  return campaignResult(response, client, unchanged
    ? `Revision ${number} holds the content campaign ${id} already has; nothing changed.`
    : `Restored revision ${number} of campaign ${id} as a new revision. Every screen of the old and the new audience re-resolves within a minute.`);
});

const PREVIEW_CLEARS = ["clear-from", "clear-until", "clear-windows", "clear-monthly", "clear-dates", "clear-except", "clear-on-touch", "clear-displays"] as const;

export const handleCampaignPreview = commandHandler(async (args, runtime, resolved) => {
  const given = args.positionals[2];
  const id = given === undefined ? undefined : campaignId(given, "preview");
  const publish = flagBool(args.flags, "publish");
  let body: CampaignPreviewRequest["body"];
  if (id === undefined) {
    // Without an ID the flags describe a new campaign, as campaign create reads them.
    const clear = PREVIEW_CLEARS.find((flag) => flagBool(args.flags, flag));
    if (publish || clear) throw usageError(`campaign preview without an ID previews a new campaign; --${publish ? "publish" : clear} changes an existing one. Name the campaign: campaign preview ID.`);
    body = await campaignCreateBody(args, runtime, "campaign preview without an ID");
  } else {
    const patch = await campaignPatchBody(args, runtime);
    if (publish) patch.paused = false;
    else if (flagBool(args.flags, "paused")) patch.paused = true;
    if (!Object.keys(patch).length) {
      throw usageError("campaign preview ID requires at least one change to preview: the flags of campaign update, --publish or --paused.");
    }
    body = patch;
  }
  const from = flagString(args.flags, "calendar-from");
  const to = flagString(args.flags, "calendar-to");
  const request: CampaignPreviewRequest = { ...(id !== undefined ? { id } : {}), body, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, { method: "POST", path: `${CAMPAIGNS_PATH}/preview`, body: request }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: schedulePreviewLines(id === undefined ? "a new campaign" : `the change to campaign ${id}`, response.body as SchedulePreview | undefined).join("\n"),
  };
});
