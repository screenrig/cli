import { createHash } from "node:crypto";
import { CliError } from "../problems.js";
import { assertPlaylistValid } from "../playlist-validate.js";
import { validatePlaylistWrite, type BundleMediaPrimitive } from "../playlist-write-validation.js";
import type { ScreenScheduleWindow } from "../adapters/protocol.js";
import type { MediaKind, SourceItem, SourceLayout, SourcePlaylist, SourceSchedule, SourceZone, Weekday } from "./types.js";

/**
 * Pure mapping from vendor shapes to screenRIG documents. `scan` runs it with
 * stand-in media ids to say what can come over; `apply` runs it again with the
 * ids the uploads returned. Nothing here touches the network or the disk.
 */

export const DEFAULT_CANVAS = { width: 1920, height: 1080 } as const;
export const DEFAULT_PAGE_MS = 8000;
export const PLAYLIST_NAME_MAX = 120;
export const CAMPAIGN_NAME_MAX = 120;
export const PLACEHOLDER_LABEL_MAX = 80;
export const PLACEHOLDER_TAGS_MAX = 16;
export const TAG_MAX = 32;
const PAGE_MS_MIN = 1000;
const PAGE_MS_MAX = 86_400_000;

// ---- file kinds and names ------------------------------------------------------------------

const IMAGE = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif", "heic", "heif"]);
const VIDEO = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi", "ogv", "mpg", "mpeg", "ts", "m2ts", "wmv", "flv", "3gp"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "opus", "wma"]);

/** The kind of media a MIME type or a file name names, or undefined when it is neither. MIME wins over the extension. */
export function kindOf(input: { mime?: string | undefined; filename?: string | undefined }): MediaKind | undefined {
  const mime = input.mime?.toLowerCase().split(";")[0]?.trim();
  if (mime) {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
  }
  const extension = /\.([A-Za-z0-9]{1,6})$/.exec(input.filename ?? "")?.[1]?.toLowerCase();
  if (!extension) return undefined;
  if (IMAGE.has(extension)) return "image";
  if (VIDEO.has(extension)) return "video";
  if (AUDIO.has(extension)) return "audio";
  return undefined;
}

/** Code points, not UTF-16 units. */
export function truncate(text: string, max: number): { text: string; cut: boolean } {
  const points = [...text];
  return points.length <= max ? { text, cut: false } : { text: points.slice(0, max).join(""), cut: true };
}

/** A name safe to send as a label, playlist or campaign name: controls and format characters become spaces, ends trimmed. */
export function cleanName(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * The file name an upload carries: the media's name plus the extension of its
 * original file name, at most 255 bytes, never a path. Declaring it is what
 * lets a rerun recognise the same media.
 */
export function uploadName(media: { name: string; filename: string }): string {
  const last = media.filename.split(/[\\/]/).pop() ?? "";
  const extension = /(\.[A-Za-z0-9]{1,8})$/.exec(last)?.[1] ?? "";
  let stem = cleanName(media.name.split(/[\\/]/).pop() ?? "") || cleanName(last.slice(0, last.length - extension.length)) || "media";
  if (extension && stem.toLowerCase().endsWith(extension.toLowerCase())) stem = stem.slice(0, stem.length - extension.length) || "media";
  const room = 255 - Buffer.byteLength(extension, "utf8");
  while (Buffer.byteLength(stem, "utf8") > room) stem = [...stem].slice(0, -1).join("");
  return `${stem}${extension}`;
}

// ---- tags -----------------------------------------------------------------------------------

/** A group or screen name as a tag: `[A-Za-z0-9]` words joined and capitalised, at most 32 characters. Empty when nothing is left. */
export function tagFromName(name: string): string {
  const words = name.normalize("NFKD").replace(/\p{M}+/gu, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((word) => {
    const mixed = /[a-z]/.test(word) && /[A-Z]/.test(word);
    return word[0]!.toUpperCase() + (mixed ? word.slice(1) : word.slice(1).toLowerCase());
  }).join("");
  return joined.slice(0, TAG_MAX);
}

export interface TagWant {
  /** `group:ID` or `screen:ID`. */
  key: string;
  name: string;
  /** Prefix for the name-less fallback: `Group` or `Screen`. */
  fallback: string;
  id: string;
}

/**
 * Allocates a tag for every want that has none. A tag never repeats another
 * allocation and never equals one in `taken` (the tags existing, non-migrated
 * screens carry), compared without regard to case: a collision gets 2, 3, and so
 * on. Allocations already in `existing` are kept as they are.
 */
export function allocateTags(wants: readonly TagWant[], taken: Iterable<string>, existing: Readonly<Record<string, string>> = {}): Record<string, string> {
  const reserved = new Set<string>([...taken].map((tag) => tag.toLowerCase()));
  for (const tag of Object.values(existing)) reserved.add(tag.toLowerCase());
  const allocated: Record<string, string> = {};
  for (const want of wants) {
    if (existing[want.key] !== undefined) continue;
    const base = tagFromName(want.name) || `${want.fallback}${createHash("sha256").update(want.id).digest("hex").slice(0, 6)}`;
    let candidate = base;
    for (let n = 2; reserved.has(candidate.toLowerCase()); n += 1) {
      candidate = `${base.slice(0, TAG_MAX - String(n).length)}${n}`;
    }
    reserved.add(candidate.toLowerCase());
    allocated[want.key] = candidate;
  }
  return allocated;
}

// ---- civil time ------------------------------------------------------------------------------

const DAY_NAMES: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const CIVIL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Civil {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function realDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseCivil(text: string | undefined): Civil | undefined {
  const match = text === undefined ? null : CIVIL.exec(text);
  if (!match) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (!realDay(year, month, day) || hour > 23 || minute > 59) return undefined;
  return { year, month, day, hour, minute };
}

function dayNumber(date: { year: number; month: number; day: number }): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
}

function fromDayNumber(days: number): { year: number; month: number; day: number } {
  const date = new Date(days * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

const two = (n: number): string => String(n).padStart(2, "0");
const dateText = (d: { year: number; month: number; day: number }): string => `${String(d.year).padStart(4, "0")}-${two(d.month)}-${two(d.day)}`;
const clock = (c: Civil): string => `${two(c.hour)}:${two(c.minute)}`;

/** The calendar date `days` after `date` (YYYY-MM-DD); civil arithmetic, no time zone involved. */
export function addDays(date: string, days: number): string {
  const match = DATE.exec(date);
  const parts = { year: Number(match?.[1]), month: Number(match?.[2]), day: Number(match?.[3]) };
  return dateText(fromDayNumber(dayNumber(parts) + days));
}

function weekdayOf(date: { year: number; month: number; day: number }): Weekday {
  return DAY_NAMES[(new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7]!;
}

// ---- schedules to campaigns ------------------------------------------------------------------

export interface CampaignTiming {
  from?: string;
  until?: string;
  windows?: ScreenScheduleWindow[];
  /** What changed, one sentence each. */
  lossy: string[];
}

export type TimingResult = ({ ok: true } & CampaignTiming) | { ok: false; reason: string };

function minutes(c: Civil): number {
  return dayNumber(c) * 1440 + c.hour * 60 + c.minute;
}

/** The campaign timing a schedule maps to, or the reason it cannot come over. */
export function campaignTiming(schedule: SourceSchedule): TimingResult {
  const lossy: string[] = [];
  if (schedule.always) return { ok: true, lossy };
  const start = parseCivil(schedule.start);
  const end = parseCivil(schedule.end);
  if ((schedule.start !== undefined && !start) || (schedule.end !== undefined && !end)) {
    return { ok: false, reason: "Its start or end time could not be read." };
  }
  const repeat = schedule.repeat;
  if (!repeat) {
    const from = schedule.start;
    const until = schedule.end;
    if (from !== undefined && until !== undefined && until <= from) return { ok: false, reason: "It ends before it starts." };
    return { ok: true, ...(from !== undefined ? { from } : {}), ...(until !== undefined ? { until } : {}), lossy };
  }
  if (repeat.every === "month" || repeat.every === "year" || repeat.every === "hour" || repeat.every === "minute") {
    return { ok: false, reason: `It repeats by the ${repeat.every}, which campaigns cannot express: they repeat on days of the week.` };
  }
  if (repeat.nth_weekday) return { ok: false, reason: "It repeats on the same numbered weekday of a month, which campaigns cannot express." };
  if (!start) return { ok: false, reason: "It repeats but has no start time." };
  const interval = repeat.interval !== undefined && repeat.interval > 1 ? Math.floor(repeat.interval) : 1;
  const unit = repeat.every === "day" ? "day" : "week";
  if (interval > 1) lossy.push(`It repeated every ${interval} ${unit}s; it now repeats every ${unit}.`);
  const weekdays: Weekday[] = repeat.weekdays?.length
    ? DAY_NAMES.filter((day) => repeat.weekdays!.includes(day))
    : repeat.every === "day" ? [...DAY_NAMES] : [weekdayOf(start)];
  const window: ScreenScheduleWindow = { days: weekdays };
  if (!end) {
    lossy.push("It had no end time; it now runs all day on its days.");
  } else {
    const length = minutes(end) - minutes(start);
    if (length <= 0) return { ok: false, reason: "It ends before it starts." };
    if (length >= 1440) {
      // Midnight to the next midnight is exactly a whole day on its days: nothing changed, so nothing is said.
      const wholeDay = length === 1440 && start.hour === 0 && start.minute === 0;
      if (!wholeDay) lossy.push("Each occurrence lasted 24 hours or more; it now runs all day on its days.");
    } else {
      window.start = clock(start);
      window.end = clock(end);
    }
  }
  const startDate = dateText(start);
  let last: string | undefined;
  if (repeat.until !== undefined) {
    if (!DATE.test(repeat.until) || !realDay(Number(repeat.until.slice(0, 4)), Number(repeat.until.slice(5, 7)), Number(repeat.until.slice(8, 10)))) {
      return { ok: false, reason: "The date its repeat ends on could not be read." };
    }
    last = repeat.until;
  }
  if (repeat.count !== undefined && repeat.count >= 1) {
    const counted = lastOccurrence(start, repeat.every === "day" ? "day" : "week", interval, weekdays, Math.floor(repeat.count), repeat.weekdays?.length ? true : repeat.every === "week");
    if (last === undefined || counted < last) last = counted;
  }
  if (last !== undefined && last < startDate) return { ok: false, reason: "Its repeat ends before it starts." };
  return {
    ok: true,
    from: `${startDate}T00:00`,
    ...(last !== undefined ? { until: `${addDays(last, 1)}T00:00` } : {}),
    windows: [window],
    lossy,
  };
}

/** The date of the `count`th occurrence of a repeat that starts at `start`. */
function lastOccurrence(start: Civil, unit: "day" | "week", interval: number, weekdays: readonly Weekday[], count: number, byWeekday: boolean): string {
  const first = dayNumber(start);
  if (unit === "day" && !byWeekday) return dateText(fromDayNumber(first + (count - 1) * interval));
  if (unit === "day") {
    let seen = 0;
    for (let day = first; ; day += 1) {
      if (weekdays.includes(weekdayOf(fromDayNumber(day))) && (seen += 1) === count) return dateText(fromDayNumber(day));
    }
  }
  const monday = first - ((new Date(first * 86_400_000).getUTCDay() + 6) % 7);
  let seen = 0;
  for (let week = 0; ; week += 1) {
    for (const day of weekdays) {
      const date = monday + week * interval * 7 + DAY_NAMES.indexOf(day);
      if (date >= first && (seen += 1) === count) return dateText(fromDayNumber(date));
    }
  }
}

/** The campaign audience over a set of tags: one tag, or any of several. */
export function tagAudience(tags: readonly string[]): { tag: string } | { any: Array<{ tag: string }> } {
  return tags.length === 1 ? { tag: tags[0]! } : { any: tags.map((tag) => ({ tag })) };
}

// ---- playlists and layouts -------------------------------------------------------------------

export interface MediaRef {
  id: string;
  kind: MediaKind;
  /** The uploaded video's length, once known. */
  duration_ms?: number;
}

export interface BuildContext {
  /** The media that came over, by source id. A source id missing here was not imported. */
  media: ReadonlyMap<string, MediaRef>;
  playlists: ReadonlyMap<string, SourcePlaylist>;
  layouts: ReadonlyMap<string, SourceLayout>;
  /** The canvas of plain playlists. */
  canvas: { width: number; height: number };
}

type Doc = Record<string, unknown>;

export type Built =
  | { ok: true; document: Doc; lossy: string[] }
  | { ok: false; reason: string; lossy: string[] };

type Leaf =
  | { type: "media"; ref: MediaRef; seconds?: number }
  | { type: "url"; url: string; title: string; seconds?: number };

interface Tally {
  missingMedia: number;
  badUrls: number;
  cycles: string[];
  lossy: Set<string>;
}

const newTally = (): Tally => ({ missingMedia: 0, badUrls: 0, cycles: [], lossy: new Set() });

function tallyLossy(tally: Tally): string[] {
  const lossy = [...tally.lossy];
  if (tally.missingMedia > 0) lossy.push(`${tally.missingMedia} item${tally.missingMedia === 1 ? " was" : "s were"} left out because ${tally.missingMedia === 1 ? "its" : "their"} media did not come over.`);
  if (tally.badUrls > 0) lossy.push(`${tally.badUrls} web page${tally.badUrls === 1 ? " was" : "s were"} left out because the address is not an http or https address.`);
  for (const name of tally.cycles) lossy.push(`${name} contains itself; the repeat was left out.`);
  return lossy;
}

function milliseconds(seconds: number | undefined, tally: Tally): number {
  if (seconds === undefined || !(seconds > 0)) return DEFAULT_PAGE_MS;
  const ms = Math.round(seconds * 1000);
  if (ms < PAGE_MS_MIN || ms > PAGE_MS_MAX) tally.lossy.add("A duration outside 1 second to 24 hours was moved to the nearest limit.");
  return Math.min(PAGE_MS_MAX, Math.max(PAGE_MS_MIN, ms));
}

function leafOf(item: SourceItem, ctx: BuildContext, tally: Tally): Leaf | undefined {
  if ("media_id" in item) {
    const ref = ctx.media.get(item.media_id);
    if (!ref) {
      tally.missingMedia += 1;
      return undefined;
    }
    return { type: "media", ref, ...(item.duration_s !== undefined ? { seconds: item.duration_s } : {}) };
  }
  if ("url" in item) {
    let host = "";
    try {
      const url = new URL(item.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
      host = url.hostname;
    } catch {
      tally.badUrls += 1;
      return undefined;
    }
    const title = truncate(cleanName(item.title ?? "") || host, 200).text;
    return { type: "url", url: item.url, title, ...(item.duration_s !== undefined ? { seconds: item.duration_s } : {}) };
  }
  return undefined;
}

/** The media and web-page items a list holds, with nested playlists inlined. A nested layout is not a leaf. */
function leaves(items: readonly SourceItem[], ctx: BuildContext, stack: readonly string[], tally: Tally, nestedLayout: (id: string) => void): Leaf[] {
  const out: Leaf[] = [];
  for (const item of items) {
    if ("playlist_id" in item) {
      const nested = ctx.playlists.get(item.playlist_id);
      if (!nested) continue;
      const key = `playlist:${nested.id}`;
      if (stack.includes(key)) {
        tally.cycles.push(`Playlist ${nested.name}`);
        continue;
      }
      out.push(...leaves(nested.items, ctx, [...stack, key], tally, nestedLayout));
    } else if ("layout_id" in item) {
      nestedLayout(item.layout_id);
    } else {
      const leaf = leafOf(item, ctx, tally);
      if (leaf) out.push(leaf);
    }
  }
  return out;
}

const CANVAS = (width: number, height: number): Doc => ({ width, height, viewport_fit: "contain", background: "#000000FF" });
const TRANSITION: Doc = { type: "crossfade", duration_ms: 200 };

function clampRect(zone: SourceZone, canvas: { width: number; height: number }): Doc {
  const x = Math.min(canvas.width - 1, Math.max(0, Math.round(zone.x)));
  const y = Math.min(canvas.height - 1, Math.max(0, Math.round(zone.y)));
  const width = Math.max(1, Math.min(canvas.width - x, Math.round(zone.width)));
  const height = Math.max(1, Math.min(canvas.height - y, Math.round(zone.height)));
  return { x, y, width, height };
}

function primitive(id: string, leaf: Leaf, rect: Doc, layer: number, options: { loop?: boolean }): Doc {
  if (leaf.type === "url") {
    return { id, primitive: "iframe", src: leaf.url, title: leaf.title, rect, layer, content_fit: "fill" };
  }
  const selector = { by: "id", media_id: leaf.ref.id };
  return leaf.ref.kind === "video"
    ? { id, primitive: "video", selector, rect, layer, content_fit: "contain", muted: true, loop: options.loop === true }
    : { id, primitive: "image", selector, rect, layer, content_fit: "contain" };
}

/** One page for one item that fills the canvas. */
function leafPage(leaf: Leaf, canvas: { width: number; height: number }, tally: Tally): Doc {
  const rect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const isVideo = leaf.type === "media" && leaf.ref.kind === "video";
  const advance = isVideo && leaf.seconds === undefined
    ? { mode: "media_end" }
    : { mode: "duration", after_ms: milliseconds(leaf.seconds, tally) };
  return {
    canvas: CANVAS(canvas.width, canvas.height),
    transition: TRANSITION,
    advance,
    primitives: [primitive("content", leaf, rect, 0, { loop: isVideo && leaf.seconds !== undefined })],
  };
}

function layoutPages(layout: SourceLayout, ctx: BuildContext, stack: readonly string[], tally: Tally): { pages: Doc[]; reason?: string } {
  const canvas = layout.width !== undefined && layout.height !== undefined && layout.width > 0 && layout.height > 0
    ? { width: Math.round(layout.width), height: Math.round(layout.height) }
    : DEFAULT_CANVAS;
  const zones: Array<{ zone: SourceZone; leaves: Leaf[]; order: number }> = [];
  layout.zones.forEach((zone, order) => {
    const found = leaves(zone.items, ctx, stack, tally, () => tally.lossy.add(`A layout inside zone ${zone.name} was left out.`));
    if (found.length > 0) zones.push({ zone, leaves: found, order });
    else if (zone.items.length > 0) tally.lossy.add(`Zone ${zone.name} had nothing that could be imported and was left out.`);
  });
  if (zones.length === 0) return { pages: [], reason: "None of its zones holds anything that can be imported." };
  const area = (zone: SourceZone): number => Math.max(0, zone.width) * Math.max(0, zone.height);
  const main = [...zones].sort((a, b) => area(b.zone) - area(a.zone) || a.zone.z - b.zone.z || a.order - b.order)[0]!;
  // Layers follow z, ties in the vendor's order.
  const layers = new Map([...zones].sort((a, b) => a.zone.z - b.zone.z || a.order - b.order).map((entry, index) => [entry, index]));
  const single = zones.length === 1;
  for (const entry of zones) {
    if (entry === main) continue;
    if (entry.leaves.length > 1) tally.lossy.add(`Zone ${entry.zone.name} advances together with the main zone ${main.zone.name}, not on its own timing.`);
    if (entry.leaves.length > main.leaves.length) {
      tally.lossy.add(`Items past ${main.leaves.length} in zone ${entry.zone.name} never show: the layout has ${main.leaves.length} page${main.leaves.length === 1 ? "" : "s"}, one per item of ${main.zone.name}.`);
    }
  }
  const pages = main.leaves.map((mainLeaf, index): Doc => {
    const video = mainLeaf.type === "media" && mainLeaf.ref.kind === "video" ? mainLeaf.ref : undefined;
    const mediaEnd = single && video !== undefined;
    const primitives = zones.map((entry): Doc => {
      const leaf = entry === main ? mainLeaf : entry.leaves[index % entry.leaves.length]!;
      return primitive(`zone_${entry.order + 1}`, leaf, clampRect(entry.zone, canvas), layers.get(entry)!, {
        loop: entry === main ? !mediaEnd && leaf.type === "media" && leaf.ref.kind === "video" && leaf.seconds !== undefined : true,
      });
    });
    let advance: Doc;
    if (mediaEnd) advance = { mode: "media_end" };
    else if (mainLeaf.seconds !== undefined) advance = { mode: "duration", after_ms: milliseconds(mainLeaf.seconds, tally) };
    else if (video?.duration_ms !== undefined) advance = { mode: "duration", after_ms: Math.min(PAGE_MS_MAX, Math.max(PAGE_MS_MIN, video.duration_ms)) };
    else advance = { mode: "duration", after_ms: DEFAULT_PAGE_MS };
    return { canvas: CANVAS(canvas.width, canvas.height), transition: TRANSITION, advance, primitives };
  });
  return { pages };
}

function finish(name: string, pages: Doc[], tracks: string[], tally: Tally, ctx: BuildContext): Built {
  const lossy = tallyLossy(tally);
  if (pages.length === 0) {
    return { ok: false, reason: tracks.length > 0 ? "It holds only audio, and a playlist needs at least one page." : "Nothing in it can be imported.", lossy };
  }
  if (tracks.length > 0) lossy.push("Audio items now play as the playlist's soundtrack, not at their place in the list.");
  const cut = truncate(cleanName(name) || "Imported", PLAYLIST_NAME_MAX);
  if (cut.cut) lossy.push(`The name was longer than ${PLAYLIST_NAME_MAX} characters and was shortened.`);
  const document: Doc = {
    name: cut.text,
    ...(tracks.length > 0 ? { audio: { tracks: tracks.map((media_id, index) => ({ id: `track_${index + 1}`, media_id })) } } : {}),
    pages: pages.map((page, index) => ({ id: `page_${index + 1}`, ...page })),
  };
  try {
    assertPlaylistValid(document);
    const primitives = new Map<string, BundleMediaPrimitive>();
    for (const ref of ctx.media.values()) primitives.set(ref.id, ref.kind);
    validatePlaylistWrite(document, primitives);
  } catch (error) {
    const first = error instanceof CliError ? (error.problem.errors[0] as { path?: string; message?: string } | undefined) : undefined;
    const why = first?.message ? `${first.path ?? ""} ${first.message}`.trim() : error instanceof Error ? error.message : "the document is not valid";
    return { ok: false, reason: `The playlist it becomes would be refused: ${why}.`, lossy };
  }
  return { ok: true, document, lossy };
}

/** A plain playlist: one page per item, nested playlists and layouts inlined, audio as the soundtrack. */
export function buildPlaylist(playlist: SourcePlaylist, ctx: BuildContext): Built {
  const tally = newTally();
  const pages: Doc[] = [];
  const tracks: string[] = [];
  const walk = (items: readonly SourceItem[], stack: readonly string[]): void => {
    for (const item of items) {
      if ("playlist_id" in item) {
        const nested = ctx.playlists.get(item.playlist_id);
        if (!nested) continue;
        const key = `playlist:${nested.id}`;
        if (stack.includes(key)) tally.cycles.push(`Playlist ${nested.name}`);
        else walk(nested.items, [...stack, key]);
      } else if ("layout_id" in item) {
        const layout = ctx.layouts.get(item.layout_id);
        if (!layout) continue;
        const key = `layout:${layout.id}`;
        if (stack.includes(key)) {
          tally.cycles.push(`Layout ${layout.name}`);
          continue;
        }
        pages.push(...layoutPages(layout, ctx, [...stack, key], tally).pages);
      } else {
        const leaf = leafOf(item, ctx, tally);
        if (!leaf) continue;
        if (leaf.type === "media" && leaf.ref.kind === "audio") {
          if (!tracks.includes(leaf.ref.id)) tracks.push(leaf.ref.id);
        } else {
          pages.push(leafPage(leaf, ctx.canvas, tally));
        }
      }
    }
  };
  walk(playlist.items, [`playlist:${playlist.id}`]);
  if (playlist.shuffle) tally.lossy.add("It played in random order; it now plays in order.");
  return finish(playlist.name, pages, tracks, tally, ctx);
}

/** A layout: one playlist on the layout's canvas, one page per item of the main zone. */
export function buildLayout(layout: SourceLayout, ctx: BuildContext): Built {
  const tally = newTally();
  const built = layoutPages(layout, ctx, [`layout:${layout.id}`], tally);
  const result = finish(layout.name, built.pages, [], tally, ctx);
  return built.reason !== undefined && !result.ok ? { ...result, reason: built.reason } : result;
}

// ---- placeholders ------------------------------------------------------------------------------

export interface PlaceholderBody {
  label: string;
  tags: string[];
  lossy: string[];
}

/** The label and tags of a screen's fleet-link placeholder. The own tag comes first so the cap never drops it. */
export function placeholderBody(screen: { name: string; group_ids: readonly string[] }, tagOfGroup: (id: string) => string | undefined, ownTag: string | undefined): PlaceholderBody {
  const lossy: string[] = [];
  const label = truncate(cleanName(screen.name) || "Imported screen", PLACEHOLDER_LABEL_MAX);
  if (label.cut) lossy.push(`The name was longer than ${PLACEHOLDER_LABEL_MAX} characters and was shortened.`);
  const all: string[] = [];
  for (const tag of [ownTag, ...screen.group_ids.map(tagOfGroup)]) {
    if (tag !== undefined && !all.includes(tag)) all.push(tag);
  }
  if (all.length > PLACEHOLDER_TAGS_MAX) lossy.push(`It was in ${all.length} groups; a screen carries at most ${PLACEHOLDER_TAGS_MAX} tags, so ${all.length - PLACEHOLDER_TAGS_MAX} were left off.`);
  return { label: label.text, tags: all.slice(0, PLACEHOLDER_TAGS_MAX), lossy };
}
