import { randomBytes } from "node:crypto";
import type { ScreenWallArrangement } from "./adapters/protocol.js";
import { requireToken } from "./client.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "./command-input.js";
import {
  clientFor, commandHandler, pendingReviewResult, playlistWriteResult, reviewNoteFrom,
} from "./commands.js";
import { isResourceID } from "./generated/resource-ids.js";
import { quotedRevision } from "./if-match.js";
import { readAuthoringJson } from "./authoring-input.js";
import { CliError, usageError } from "./problems.js";
import { pendingReviewOf } from "./reviews.js";
import { wallSize } from "./screen-wall.js";

/**
 * One page of a playlist at a time (`playlist page add|replace|remove`): the
 * way an uploader changes a playlist, and available to anyone. The media page
 * builder here is the rule the dashboard follows too: one full-canvas image or
 * video, dated by the page's own visibility.
 */

const PAGE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const DEFAULT_CANVAS = { width: 1920, height: 1080, background: "#000000FF" } as const;
const DEFAULT_TRANSITION = { type: "crossfade", duration_ms: 600 } as const;
const DEFAULT_SECONDS = 10;

type JSONObject = Record<string, unknown>;

const isObject = (value: unknown): value is JSONObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** `up-` and eight characters from a-z and 0-9: the id of a page this CLI builds. */
export function newPageId(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(8);
  let id = "up-";
  for (let index = 0; index < 8; index += 1) id += ID_ALPHABET[bytes[index]! % ID_ALPHABET.length];
  return id;
}

/**
 * A civil time as the page's visibility holds it. `YYYY-MM-DDTHH:MM` is kept.
 * A date alone means that day at 00:00 for a start, and the next day at 00:00
 * for an end, so the day named is the last day shown. The times are those of
 * each screen's timezone.
 */
export function civilTime(value: string, edge: "from" | "until", flag: string): string {
  const text = value.trim();
  const full = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const match = full ?? day;
  if (!match) throw usageError(`${flag} takes YYYY-MM-DDTHH:MM or YYYY-MM-DD, a time in each screen's timezone.`);
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const hours = full ? Number(match[4]) : 0, minutes = full ? Number(match[5]) : 0;
  const check = new Date(Date.UTC(year, month - 1, date, hours, minutes));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date || hours > 23 || minutes > 59) {
    throw usageError(`${flag} ${text} is not a real date and time.`);
  }
  if (full || edge === "from") return `${match[1]}-${match[2]}-${match[3]}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}T00:00`;
}

/** The canvas of a video wall format: a tile is 1920 x 1080, or 1080 x 1920 in portrait, and a row is that many tiles wide, a column that many high, a grid its columns wide. */
export function formatCanvas(format: unknown): { width: number; height: number } | undefined {
  if (!isObject(format)) return undefined;
  const displays = Number(format.displays);
  if (!Number.isInteger(displays) || displays < 2) return undefined;
  const columns = Number(format.columns);
  if (format.arrangement === "grid" && !(Number.isInteger(columns) && columns > 0 && displays % columns === 0)) return undefined;
  return wallSize(displays, format.arrangement as ScreenWallArrangement, format.orientation === "portrait", columns);
}

/** The first page of a playlist that is an ordinary page (not an ad slot). */
function firstOrdinaryPage(playlist: unknown): JSONObject | undefined {
  const pages = isObject(playlist) && Array.isArray(playlist.pages) ? playlist.pages : [];
  return pages.find((page): page is JSONObject => isObject(page) && page.type === undefined && isObject(page.canvas));
}

/** The canvas new media pages use: the format's, else the first ordinary page's, else 1920 x 1080 on black. */
export function pageCanvas(playlist: unknown): { width: number; height: number; background: unknown } {
  const first = firstOrdinaryPage(playlist);
  const fromFormat = formatCanvas(isObject(playlist) ? playlist.format : undefined);
  const canvas = isObject(first?.canvas) ? first.canvas : undefined;
  const background = canvas?.background ?? DEFAULT_CANVAS.background;
  if (fromFormat) return { ...fromFormat, background };
  if (canvas && Number.isFinite(Number(canvas.width)) && Number.isFinite(Number(canvas.height))) {
    return { width: Number(canvas.width), height: Number(canvas.height), background };
  }
  return { ...DEFAULT_CANVAS };
}

/** The transition new media pages use: the first ordinary page's, else a 600 ms crossfade. */
export function pageTransition(playlist: unknown): unknown {
  const first = firstOrdinaryPage(playlist);
  return isObject(first?.transition) ? first.transition : { ...DEFAULT_TRANSITION };
}

/** The media a stinger transition shows as its logo (`media:med_...`), undefined for any other transition. */
export function stingerLogo(transition: unknown): string | undefined {
  const stinger = isObject(transition) && transition.type === "stinger" && isObject(transition.stinger) ? transition.stinger : undefined;
  const logo = stinger?.logo;
  return typeof logo === "string" && logo.startsWith("media:") ? logo.slice("media:".length) : undefined;
}

/**
 * The transition a new media page takes: the playlist's own, unless it is a
 * stinger whose logo this credential cannot read. An uploader's page may show
 * only media of its folders, and a stinger's logo is media, so that page gets
 * the 600 ms crossfade instead of a refusal.
 */
async function transitionFor(client: ReturnType<typeof clientFor>, playlist: unknown): Promise<unknown> {
  const transition = pageTransition(playlist);
  const logo = stingerLogo(transition);
  if (logo === undefined) return transition;
  try {
    await client.call({ method: "GET", path: `/api/media/${encodeURIComponent(logo)}` });
    return transition;
  } catch (error) {
    const code = error instanceof CliError ? error.problem.code : undefined;
    if (code === "outside_upload_scope" || code === "not_found") return { ...DEFAULT_TRANSITION };
    // A credential that may not read media at all is no uploader's: the playlist's transition stays.
    if (code === "forbidden" || code === "insufficient_access") return transition;
    throw error;
  }
}

export interface MediaPageInput {
  id: string;
  mediaId: string;
  kind: "image" | "video";
  fit: "contain" | "cover";
  seconds: number;
  playlist: unknown;
  /** The page's transition; absent takes the playlist's (pageTransition). */
  transition?: unknown;
  from?: string;
  until?: string;
}

/**
 * The page an upload becomes: one full-canvas image or video primitive named by
 * id, contained or covered. An image advances after `seconds`; a video at its
 * own end. `from` and `until` are the page's visibility, civil times in each
 * screen's timezone with `until` exclusive; neither means the page is always
 * shown.
 */
export function buildMediaPage(input: MediaPageInput): JSONObject {
  const canvas = pageCanvas(input.playlist);
  const primitive: JSONObject = {
    id: "media", primitive: input.kind, selector: { by: "id", media_id: input.mediaId },
    rect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, layer: 0, content_fit: input.fit,
  };
  if (input.kind === "video") primitive.muted = true;
  const page: JSONObject = {
    id: input.id, canvas, transition: input.transition ?? pageTransition(input.playlist),
    advance: input.kind === "image" ? { mode: "duration", after_ms: Math.round(input.seconds * 1000) } : { mode: "media_end" },
    primitives: [primitive],
  };
  const visibility = visibilityOf(undefined, input.from, input.until);
  if (visibility) page.visibility = visibility;
  return page;
}

/** The visibility with from and until set; a bound not given stays as it was. Undefined when nothing bounds the page. */
export function visibilityOf(existing: unknown, from?: string, until?: string): JSONObject | undefined {
  const base: JSONObject = isObject(existing) ? { ...existing } : { enabled: true };
  if (from !== undefined) base.from = from;
  if (until !== undefined) base.until = until;
  const bounded = base.from !== undefined || base.until !== undefined || base.windows !== undefined || base.data !== undefined;
  return bounded ? base : undefined;
}

/**
 * The visibility with its dates (`from` and `until`) removed: whether the page is
 * switched off, its weekly windows and its data condition stay as the project
 * set them. Undefined when nothing else limits the page, and a page that is
 * switched off stays off.
 */
export function withoutDates(existing: unknown): JSONObject | undefined {
  if (!isObject(existing)) return undefined;
  const { from: _from, until: _until, ...rest } = existing;
  return rest.windows !== undefined || rest.data !== undefined || rest.enabled === false ? rest : undefined;
}

/** The authoring form of a stored page: what the server resolved is not sent back, nor are the comments an agent attached. */
export function authoringPage(stored: JSONObject): JSONObject {
  const page: JSONObject = {};
  for (const [key, value] of Object.entries(stored)) {
    if (key === "comments") continue;
    page[key] = key === "primitives" && Array.isArray(value)
      ? value.map((primitive) => {
        if (!isObject(primitive)) return primitive;
        const { resolved_media: _resolved, ...rest } = primitive;
        return rest;
      })
      : value;
  }
  return page;
}

export interface ReplaceMediaInput {
  stored: JSONObject;
  /** The new media; absent keeps the stored media and changes only the dates, seconds or fit. */
  mediaId?: string;
  kind?: "image" | "video";
  fit?: "contain" | "cover";
  seconds?: number;
  playlist: unknown;
  from?: string;
  until?: string;
  always: boolean;
}

/**
 * The stored page with its dates changed or media swapped. The same media kind
 * keeps every other member, dates included. A different kind is rebuilt as
 * a media page on the playlist's canvas, keeping the stored dates and id. A
 * date flag changes only its bound; `always` removes the dates and keeps the
 * rest of the visibility the project set.
 */
export function replaceMedia(input: ReplaceMediaInput): JSONObject {
  const page = authoringPage(input.stored);
  let result = page;
  if (input.mediaId !== undefined || input.fit !== undefined || input.seconds !== undefined) {
    const primitives = Array.isArray(page.primitives) ? page.primitives : [];
    const only = primitives.length === 1 && isObject(primitives[0]) ? primitives[0] : undefined;
    if (!only) {
      throw usageError(`Page ${String(input.stored.id)} holds ${primitives.length} primitives, so its media cannot be swapped by itself. Send the whole page with --file.`);
    }
    if (input.mediaId === undefined || input.kind === undefined || only.primitive === input.kind) {
      const primitive: JSONObject = { ...only };
      if (input.mediaId !== undefined) primitive.selector = { by: "id", media_id: input.mediaId };
      if (input.fit) primitive.content_fit = input.fit;
      result = { ...page, primitives: [primitive] };
      if (only.primitive === "image" && input.seconds !== undefined) result.advance = { mode: "duration", after_ms: Math.round(input.seconds * 1000) };
    } else {
      const rebuilt = buildMediaPage({ id: String(input.stored.id), mediaId: input.mediaId, kind: input.kind, fit: input.fit ?? "contain", seconds: input.seconds ?? DEFAULT_SECONDS, playlist: input.playlist });
      result = { ...page, canvas: rebuilt.canvas, advance: rebuilt.advance, primitives: rebuilt.primitives };
    }
  }
  if (input.always) {
    const visibility = withoutDates(page.visibility);
    if (visibility) result.visibility = visibility;
    else delete result.visibility;
    return result;
  }
  const visibility = visibilityOf(page.visibility, input.from, input.until);
  if (visibility) result.visibility = visibility;
  return result;
}

function playlistId(args: ParsedArgs, command: string): string {
  const id = args.positionals[3];
  if (!id || !isResourceID(id, "playlist")) throw usageError(`playlist page ${command} requires the playlist ID (pl_...).`);
  return id;
}

function pageIdArg(args: ParsedArgs, command: string): string {
  const id = args.positionals[4];
  if (!id || !PAGE_ID_PATTERN.test(id)) throw usageError(`playlist page ${command} requires the page ID (a letter, then letters, digits, - or _).`);
  return id;
}

function seconds(args: ParsedArgs): number | undefined {
  const value = flagNumber(args.flags, "seconds");
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 1 || value > 86_400) throw usageError("--seconds takes 1 to 86400.");
  return value;
}

function fit(args: ParsedArgs): "contain" | "cover" | undefined {
  const value = flagString(args.flags, "fit");
  if (value === undefined) return undefined;
  if (value !== "contain" && value !== "cover") throw usageError("--fit takes contain or cover.");
  return value;
}

function dates(args: ParsedArgs): { from?: string; until?: string; always: boolean } {
  const from = flagString(args.flags, "from"), until = flagString(args.flags, "until");
  const always = flagBool(args.flags, "always");
  if (always && (from !== undefined || until !== undefined)) throw usageError("--always removes the dates; it cannot be used with --from or --until.");
  return {
    ...(from !== undefined ? { from: civilTime(from, "from", "--from") } : {}),
    ...(until !== undefined ? { until: civilTime(until, "until", "--until") } : {}),
    always,
  };
}

async function pageFromFile(file: string, runtime: Parameters<typeof readAuthoringJson>[1]): Promise<JSONObject> {
  let parsed: unknown;
  try { parsed = await readAuthoringJson(file, runtime); } catch (error) {
    throw usageError(`Cannot read the page JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  if (!isObject(parsed)) throw usageError("The page file must hold one page object.");
  return parsed;
}

/** The media a page is built from: its id must be one the project holds, and an image or a video. */
async function mediaOf(client: ReturnType<typeof clientFor>, mediaId: string): Promise<"image" | "video"> {
  if (!isResourceID(mediaId, "media")) throw usageError("--media takes a media ID (med_...); media list shows them.");
  const media = (await client.call({ method: "GET", path: `/api/media/${encodeURIComponent(mediaId)}` })).body;
  const kind = isObject(media) ? media.primitive : undefined;
  if (kind !== "image" && kind !== "video") throw usageError(`Media ${mediaId} is ${typeof kind === "string" ? `a ${kind} file` : "not a file a page can show"}; a page shows an image or a video.`);
  return kind;
}

async function playlistOf(client: ReturnType<typeof clientFor>, id: string): Promise<{ playlist: JSONObject; revision: number }> {
  const response = await client.call({ method: "GET", path: `/api/playlists/${encodeURIComponent(id)}` });
  const playlist = response.body;
  if (!isObject(playlist) || !Number.isSafeInteger(playlist.revision)) throw usageError("The playlist answer does not match the generated contract.");
  return { playlist, revision: playlist.revision as number };
}

function pageWrite(client: ReturnType<typeof clientFor>, args: ParsedArgs, request: { method: "POST" | "PUT" | "DELETE"; path: string; body?: unknown; revision?: string }) {
  const expected = request.revision ?? flagString(args.flags, "expect-rev");
  return client.call({
    method: request.method, path: request.path, idempotent: true,
    ...(request.body === undefined ? {} : { body: request.body }),
    headers: { ...reviewNoteFrom(args), ...(expected !== undefined ? { "if-match": quotedRevision(expected) } : {}) },
  });
}

function pageResult(response: Awaited<ReturnType<typeof pageWrite>>, requestId: string, title: string) {
  const pending = pendingReviewOf(response);
  return pending ? pendingReviewResult(response, pending, requestId) : playlistWriteResult(response, requestId, title);
}

const pagesPath = (id: string): string => `/api/playlists/${encodeURIComponent(id)}/pages`;

export const handlePlaylistPageAdd = commandHandler(async (args, runtime, resolved) => {
  const id = playlistId(args, "add");
  const file = flagString(args.flags, "file"), media = flagString(args.flags, "media");
  if ((file === undefined) === (media === undefined)) throw usageError("playlist page add requires exactly one of --file PAGE.json or --media MED_ID.");
  const when = dates(args);
  if (when.always) throw usageError("--always belongs to playlist page replace: a new page is always shown unless --from or --until bound it.");
  const before = flagString(args.flags, "before");
  if (before !== undefined && !PAGE_ID_PATTERN.test(before)) throw usageError("--before takes a page ID.");
  const requestedId = flagString(args.flags, "page-id");
  if (requestedId !== undefined && !PAGE_ID_PATTERN.test(requestedId)) throw usageError("--page-id takes a letter, then letters, digits, - or _ (at most 64).");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let page: JSONObject;
  if (file !== undefined) {
    if (seconds(args) !== undefined || fit(args) !== undefined) throw usageError("--seconds and --fit shape a page built from --media; a --file page is sent as written.");
    page = await pageFromFile(file, runtime);
    if (requestedId !== undefined) page.id = requestedId;
    const visibility = visibilityOf(page.visibility, when.from, when.until);
    if (visibility) page.visibility = visibility;
  } else {
    const kind = await mediaOf(client, media!);
    const { playlist } = await playlistOf(client, id);
    const transition = await transitionFor(client, playlist);
    page = buildMediaPage({ id: requestedId ?? newPageId(), mediaId: media!, kind, fit: fit(args) ?? "contain", seconds: seconds(args) ?? DEFAULT_SECONDS, playlist, transition, ...(when.from ? { from: when.from } : {}), ...(when.until ? { until: when.until } : {}) });
  }
  const response = await pageWrite(client, args, { method: "POST", path: pagesPath(id), body: { page, ...(before !== undefined ? { before } : {}) } });
  return pageResult(response, client.requestId, `Page ${String(page.id)} added to ${id}.`);
}, true);

export const handlePlaylistPageReplace = commandHandler(async (args, runtime, resolved) => {
  const id = playlistId(args, "replace");
  const pageId = pageIdArg(args, "replace");
  const file = flagString(args.flags, "file"), media = flagString(args.flags, "media");
  if (file !== undefined && media !== undefined) throw usageError("playlist page replace takes --file PAGE.json or --media MED_ID, not both.");
  const when = dates(args);
  if (file === undefined && media === undefined && when.from === undefined && when.until === undefined && !when.always) {
    throw usageError("playlist page replace requires --file PAGE.json, --media MED_ID, or a date change (--from, --until or --always).");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let page: JSONObject;
  let revision: string | undefined;
  if (file !== undefined) {
    if (seconds(args) !== undefined || fit(args) !== undefined) throw usageError("--seconds and --fit shape a page built from --media; a --file page is sent as written.");
    page = await pageFromFile(file, runtime);
    if (page.id !== undefined && page.id !== pageId) throw usageError(`The page file's id ${String(page.id)} is not ${pageId}; a replace keeps the page's id.`);
    page.id = pageId;
    if (when.always) {
      const visibility = withoutDates(page.visibility);
      if (visibility) page.visibility = visibility;
      else delete page.visibility;
    } else {
      const visibility = visibilityOf(page.visibility, when.from, when.until);
      if (visibility) page.visibility = visibility;
    }
  } else {
    const { playlist, revision: current } = await playlistOf(client, id);
    const stored = (Array.isArray(playlist.pages) ? playlist.pages : []).find((candidate): candidate is JSONObject => isObject(candidate) && candidate.id === pageId);
    if (!stored) throw usageError(`Playlist ${id} has no page ${pageId}; playlist show ${id} lists its pages.`);
    const kind = media !== undefined ? await mediaOf(client, media) : undefined;
    page = replaceMedia({ stored, ...(media !== undefined ? { mediaId: media, kind: kind! } : {}), ...(fit(args) ? { fit: fit(args)! } : {}), ...(seconds(args) !== undefined ? { seconds: seconds(args)! } : {}), playlist, ...(when.from ? { from: when.from } : {}), ...(when.until ? { until: when.until } : {}), always: when.always });
    // The page was derived from the stored one, so the write is held to the revision it was read at.
    revision = String(current);
  }
  const response = await pageWrite(client, args, { method: "PUT", path: `${pagesPath(id)}/${encodeURIComponent(pageId)}`, body: page, ...(revision && flagString(args.flags, "expect-rev") === undefined ? { revision } : {}) });
  return pageResult(response, client.requestId, `Page ${pageId} of ${id} replaced.`);
}, true);

export const handlePlaylistPageRemove = commandHandler(async (args, runtime, resolved) => {
  const id = playlistId(args, "remove");
  const pageId = pageIdArg(args, "remove");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await pageWrite(client, args, { method: "DELETE", path: `${pagesPath(id)}/${encodeURIComponent(pageId)}` });
  return pageResult(response, client.requestId, `Page ${pageId} removed from ${id}.`);
}, true);
