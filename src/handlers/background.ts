// Command handlers for the background commands, loaded on demand.
import {
  BACKGROUNDS_PATH, DEFAULT_BACKGROUND_COLOR, backgroundColor, backgroundId, backgroundOrSetId, backgroundUrl, imageBackgroundOf, setBackgroundColor, withCanvasBackground,
  type BackgroundCategory, type BackgroundSet, type BackgroundSetDetail, type BackgroundShown,
} from "../backgrounds.js";
import { requireToken, type ApiClient } from "../client.js";
import { flagString, type ParsedArgs } from "../command-input.js";
import { clientFor, commandHandler, jsonBody } from "../commands.js";
import { ExitCode } from "../exit-codes.js";
import { authoringPage, putPage, storedPageOf } from "../playlist-page.js";
import { CliError, usageError } from "../problems.js";
import { table } from "../webhooks.js";

const APPLY_NEXT = "Next: screenrig background apply BACKGROUND_ID --playlist-id pl_PLAYLIST --page-id PAGE_ID";
const LAYOUT_HINT = "layout is where the decoration sits; keep content in the calm area outside it (on left-half, text goes on the right). tone is the image's lightness: light content reads on dark.";

/** A GET of the catalog; a 404 names the command that lists what exists. */
async function catalogGet(client: ApiClient, path: string, next: { command: string; reason: string }): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call({ method: "GET", path });
  } catch (error) {
    if (error instanceof CliError && error.problem.code === "not_found" && !error.problem.next) {
      throw new CliError({ ...error.problem, next }, error.exitCode, error.warnings);
    }
    throw error;
  }
}

const colors = (group: Pick<BackgroundSet, "colors">): string => (Array.isArray(group.colors) && group.colors.length ? group.colors.join(", ") : "(none)");

function categoryLines(items: BackgroundCategory[]): string[] {
  if (!items.length) return ["No background categories"];
  return table(["ID", "NAME", "SETS"], items.map((item) => [item.id, item.name, String(item.set_count)]));
}

function setLines(items: BackgroundSet[]): string[] {
  if (!items.length) return ["No matching background sets"];
  return table(["ID", "NAME", "CATEGORY", "LANDSCAPE", "PORTRAIT", "COLORS"],
    items.map((item) => [item.id, item.name, item.category, String(item.landscape_count), String(item.portrait_count), colors(item)]));
}

function setDetailLines(group: BackgroundSetDetail, apiUrl: string): string[] {
  const images = Array.isArray(group.backgrounds) ? group.backgrounds : [];
  return [
    `Background set ${group.id}`,
    `name: ${group.name}`,
    `category: ${group.category} (${group.category_name})`,
    `style: ${group.style}`,
    `colors: ${colors(group)}`,
    `images: ${group.landscape_count} landscape, ${group.portrait_count} portrait`,
    `thumbnail: ${backgroundUrl(group.thumbnail_path, apiUrl)}`,
    "",
    ...(images.length ? table(["ID", "ORIENTATION", "LAYOUT", "TONE", "IMAGE"], images.map((image) => [image.id, image.orientation, image.layout, image.tone, backgroundUrl(image.image_path, apiUrl)])) : ["No images"]),
    "",
    LAYOUT_HINT,
    APPLY_NEXT,
  ];
}

function backgroundLines(shown: BackgroundShown, apiUrl: string): string[] {
  const { background: image, set: group } = shown;
  return [
    `Background ${image.id}`,
    `set: ${group.id} (${group.name}); category: ${group.category} (${group.category_name})`,
    `orientation: ${image.orientation} (${image.width}x${image.height})`,
    `layout: ${image.layout} (${image.label})`,
    `tone: ${image.tone}`,
    `colors: ${colors(group)}`,
    `image: ${backgroundUrl(image.image_path, apiUrl)}`,
    "",
    LAYOUT_HINT,
    `Next: screenrig background apply ${image.id} --playlist-id pl_PLAYLIST --page-id PAGE_ID`,
  ];
}

export const handleBackgroundCategories = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${BACKGROUNDS_PATH}/categories` });
  const items = (response.body as { categories?: BackgroundCategory[] } | undefined)?.categories;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: [`Background categories (${list.length})`, ...categoryLines(list), "", "Next: screenrig background sets --category ID lists a category's sets."].join("\n"),
  };
});

export const handleBackgroundSets = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${BACKGROUNDS_PATH}/sets`, query: {
    category: flagString(args.flags, "category"), q: flagString(args.flags, "search"), orientation: flagString(args.flags, "orientation"),
  } });
  const items = (response.body as { sets?: BackgroundSet[] } | undefined)?.sets;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: [`Background sets (${list.length})`, ...setLines(list), "", "Next: screenrig background show SET_ID lists a set's images."].join("\n"),
  };
});

export const handleBackgroundShow = commandHandler(async (args, runtime, resolved) => {
  const id = backgroundOrSetId(args.positionals[2] ?? "");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (id.startsWith("bg_")) {
    const response = await catalogGet(client, `${BACKGROUNDS_PATH}/${encodeURIComponent(id)}`, { command: "screenrig background sets", reason: "List the sets, then background show SET_ID lists a set's image ids." });
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: backgroundLines(response.body as BackgroundShown, resolved.apiUrl).join("\n") };
  }
  const response = await catalogGet(client, `${BACKGROUNDS_PATH}/sets/${encodeURIComponent(id)}`, { command: "screenrig background sets", reason: "List the sets and their ids." });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: setDetailLines(response.body as BackgroundSetDetail, resolved.apiUrl).join("\n") };
});

/** The playlist and page a background command changes, from --playlist-id and --page-id as the option parsers checked them. */
function pageTarget(args: ParsedArgs): { playlistId: string; pageId: string } {
  const playlistId = flagString(args.flags, "playlist-id"), pageId = flagString(args.flags, "page-id");
  if (!playlistId || !pageId) throw usageError("Both --playlist-id and --page-id are required.");
  return { playlistId, pageId };
}

export const handleBackgroundApply = commandHandler(async (args, runtime, resolved) => {
  const id = backgroundId(args.positionals[2] ?? "");
  const { playlistId, pageId } = pageTarget(args);
  const explicit = flagString(args.flags, "color");
  const color = explicit === undefined ? undefined : backgroundColor(explicit);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // The image must exist; its set gives the colour it sits on when none is named.
  const found = await catalogGet(client, `${BACKGROUNDS_PATH}/${encodeURIComponent(id)}`, { command: "screenrig background sets", reason: "List the sets, then background show SET_ID lists a set's image ids." });
  const { stored, revision } = await storedPageOf(client, playlistId, pageId, resolved.token);
  const kept = imageBackgroundOf(stored)?.color;
  const background = { type: "image" as const, background_id: id, color: color ?? kept ?? setBackgroundColor((found.body as Partial<BackgroundShown> | undefined)?.set) };
  const page = withCanvasBackground(authoringPage(stored), background);
  // The page was derived from the stored one, so the write is held to the revision it was read at.
  return putPage(client, args, playlistId, pageId, page, revision, `Background ${id} set on page ${pageId} of ${playlistId} (color ${background.color}).`);
}, true);

export const handleBackgroundClear = commandHandler(async (args, runtime, resolved) => {
  const { playlistId, pageId } = pageTarget(args);
  const explicit = flagString(args.flags, "color");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const { stored, revision } = await storedPageOf(client, playlistId, pageId, resolved.token);
  const current = imageBackgroundOf(stored);
  if (explicit === undefined && !current) {
    throw usageError(`Page ${pageId} of ${playlistId} has no image background to clear; give --color to set a solid colour.`);
  }
  const color = explicit !== undefined ? backgroundColor(explicit) : current?.color ?? DEFAULT_BACKGROUND_COLOR;
  const page = withCanvasBackground(authoringPage(stored), color);
  return putPage(client, args, playlistId, pageId, page, revision, `Page ${pageId} of ${playlistId} has the solid background ${color}.`);
}, true);
