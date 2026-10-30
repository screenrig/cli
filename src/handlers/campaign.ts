// Command handlers for the campaign commands, loaded on demand.
import { readAuthoringText } from "../authoring-input.js";
import { LEVEL_IDLE_DEFAULT_S } from "../screen-control.js";
import { CAMPAIGN_AUDIENCE_INPUT_MAX_BYTES, campaignAllScreensAudience, campaignAnyTagAudience, campaignAudienceJson, campaignFolder, campaignFolderAudience, campaignBounds, campaignExplainLines, campaignId, campaignLines, campaignName, campaignPlaylistId, campaignProblem, campaignScreenAudience, campaignScreenId, campaignScreensLines, campaignTableLines, campaignTagAudience, campaignWindowList, campaignDateList, campaignDisplayList, campaignMonthlyList } from "../campaigns.js";
import { type Campaign, type CampaignAudience, type CampaignList, type CampaignPatch, type CampaignScreens, type CampaignWrite, type ScreenCampaigns } from "../adapters/protocol.js";
import { flagBool, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
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
export function campaignLevelFlags(args: ParsedArgs): Pick<CampaignWrite, "monthly" | "dates" | "except" | "interaction" | "displays" | "start"> {
  const monthly = flagString(args.flags, "monthly");
  const dates = flagString(args.flags, "date");
  const except = flagString(args.flags, "except");
  const displays = flagString(args.flags, "displays");
  const start = flagString(args.flags, "start");
  const onTouch = args.flags["on-touch"];
  return {
    ...(monthly !== undefined ? { monthly: campaignMonthlyList(monthly) } : {}),
    ...(dates !== undefined ? { dates: campaignDateList(dates) } : {}),
    ...(except !== undefined ? { except: except.split(",") } : {}),
    ...(onTouch !== undefined && onTouch !== false ? { interaction: { idle_s: typeof onTouch === "string" ? Number(onTouch) : LEVEL_IDLE_DEFAULT_S } } : {}),
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

export const handleCampaignCreate = commandHandler(async (args, runtime, resolved) => {
  const name = campaignName(flagString(args.flags, "name") ?? "");
  const playlistId = campaignPlaylistId(flagString(args.flags, "playlist-id") ?? "");
  const audience = await campaignAudienceFlag(args, runtime);
  if (!audience) throw usageError("campaign create takes exactly one of --tag, --any-tag, --screen-id, --folder, --all-screens or --audience.");
  const from = flagString(args.flags, "from");
  const until = flagString(args.flags, "until");
  campaignBounds(from, until);
  const windows = flagString(args.flags, "window");
  const priority = flagString(args.flags, "priority");
  const paused = flagBool(args.flags, "paused");
  const body: CampaignWrite = {
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

export const handleCampaignUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "update");
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
