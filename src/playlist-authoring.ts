import { assertPlaylistValid } from "./playlist-validate.js";
import type { Warning } from "./envelope.js";
import { usageError } from "./problems.js";

/** Default hold for an image or iframe page when `--duration-ms` is omitted. */
export const DEFAULT_PAGE_DURATION_MS = 8000;
/**
 * Default hold for a pinned application release: the contract maximum
 * (`advance.after_ms` is 1 second through 24 hours). The contract has no
 * untimed mode, and an app that rotates internally and keeps state restarts
 * whenever its page advances, so the longest allowed hold is the default.
 */
export const APPLICATION_PAGE_DURATION_MS = 86_400_000;
/** An application page timed below this is warned about, never refused. */
export const APPLICATION_SHORT_PAGE_MS = 60_000;

type RecordValue = Record<string, any>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("Expected a playlist object.");
  return value as RecordValue;
}

/** Preserve authored selectors; strip only fields the backend derives on reads. */
export function editablePlaylist(value: unknown): RecordValue {
  const resource = object(value);
  // PUT replaces the whole document, so a soundtrack read here must be written
  // back or an edit would silently remove it.
  const document = structuredClone({
    name: resource.name,
    ...(resource.audio !== undefined && resource.audio !== null ? { audio: resource.audio } : {}),
    pages: resource.pages,
  });
  if (!Array.isArray(document.pages)) throw usageError("Playlist pages are missing.");
  for (const page of document.pages) {
    object(page);
    // An adslot page is a whole-page reference: id, type, adslot_id, visibility.
    // It carries no canvas or primitives, so nothing is stripped or rewrapped.
    if (page.type === "adslot") continue;
    // Page comments are read-only here; updates carry them over by page id.
    delete page.comments;
    // The server resolves max_ms for media_end and audio_end pages; a read value is not authoring input.
    if (page.advance?.mode === "media_end" || page.advance?.mode === "audio_end") delete page.advance.max_ms;
    if (!Array.isArray(page.primitives)) throw usageError("Playlist primitives are missing.");
    for (const primitive of page.primitives) {
      object(primitive);
      // Reads report controller on every primitive; writes accept it only as
      // true on an application.
      if (primitive.primitive !== "application" || primitive.controller !== true) delete primitive.controller;
      if (["image", "video", "stream"].includes(primitive.primitive)) {
        delete primitive.resolved_media;
        // Omit the server-inserted false default without changing selector behavior.
        if (primitive.selector?.by === "id" && primitive.selector.one_at_a_time === false) delete primitive.selector.one_at_a_time;
      }
      if (primitive.primitive === "card") {
        delete primitive.feed;
        delete primitive.resolved_media;
      }
    }
  }
  assertPlaylistValid(document);
  return document;
}

/**
 * An ad-slot page: a whole-page slot reference (`id`, `type`, `adslot_id`,
 * optional `visibility`) with no canvas, primitives, creative, duration, or price.
 */
export function isAdSlotPage(page: unknown): boolean {
  if (typeof page !== "object" || page === null || Array.isArray(page)) return false;
  return "type" in page && page.type === "adslot";
}

/**
 * Warn when an application sits on a page that advances in under a minute: the
 * app is restarted each time the page returns. Explicit short durations stay
 * legitimate, so this never blocks.
 */
export function shortApplicationPageWarning(document: unknown): Warning | undefined {
  const pages = (document as RecordValue | undefined)?.pages;
  if (!Array.isArray(pages)) return undefined;
  const short: string[] = [];
  for (const page of pages) {
    if (!page || typeof page !== "object" || isAdSlotPage(page) || !Array.isArray(page.primitives)) continue;
    if (!page.primitives.some((primitive: unknown) => (primitive as RecordValue | null)?.primitive === "application")) continue;
    const ms = page.advance?.mode === "duration" ? page.advance.after_ms : page.advance?.mode === "application" ? page.advance.max_ms : undefined;
    if (typeof ms === "number" && ms < APPLICATION_SHORT_PAGE_MS) short.push(`${typeof page.id === "string" ? page.id : "(unnamed)"} (${ms} ms)`);
  }
  if (short.length === 0) return undefined;
  return {
    code: "application_page_short",
    message: `Application page ${short.join(", ")} advances in under ${APPLICATION_SHORT_PAGE_MS / 1000} seconds, so the app restarts each time the page returns and loses its state. For an app-driven board set advance after_ms (or --duration-ms) to a long hold; applications default to ${APPLICATION_PAGE_DURATION_MS} ms.`,
  };
}

export function initializePlaylist(options: {
  name: string; media: RecordValue[]; width: number; height: number; durationMs?: number; fit: string;
}): RecordValue {
  return preparePlaylist({ ...options, content: options.media });
}

/** Build the backend-owned write document; target metadata stays outside it. */
export function preparePlaylist(options: {
  name: string; content: RecordValue[]; width: number; height: number; durationMs?: number; fit: string;
}): RecordValue {
  // Ready audio inputs become the soundtrack in input order; every other input
  // is one page.
  const tracks = options.content.filter((media) => media.primitive === "audio").map((media, index) => {
    if (media.state !== "ready") throw usageError("Every media item must be a ready image, video, or audio object.");
    return { id: `track_${index + 1}`, media_id: media.id };
  });
  const pageContent = options.content.filter((media) => media.primitive !== "audio");
  if (pageContent.length === 0) throw usageError("A playlist needs at least one page; audio inputs only become its soundtrack.");
  const document = { name: options.name, ...(tracks.length > 0 ? { audio: { tracks } } : {}), pages: pageContent.map((media, index) => {
    const live = media.primitive === "iframe" || media.primitive === "application";
    if (!live && (media.state !== "ready" || !["image", "video"].includes(media.primitive))) throw usageError("Every media item must be a ready image, video, or audio object.");
    const video = media.primitive === "video";
    return {
      id: `page_${index + 1}`,
      canvas: { width: options.width, height: options.height, viewport_fit: "contain", background: "#000000FF" },
      transition: { type: "crossfade", duration_ms: 200 },
      // An explicit duration applies to every non-video page; an omitted one
      // holds an application for the contract maximum and other pages for 8 s.
      advance: video ? { mode: "media_end" }
        : { mode: "duration", after_ms: options.durationMs ?? (media.primitive === "application" ? APPLICATION_PAGE_DURATION_MS : DEFAULT_PAGE_DURATION_MS) },
      primitives: [{ id: "content", primitive: media.primitive,
        ...(media.primitive === "iframe" ? { src: media.src, title: media.title }
          : media.primitive === "application" ? { release_id: media.release_id }
          : { selector: { by: "id", media_id: media.id } }),
        rect: { x: 0, y: 0, width: options.width, height: options.height }, layer: 0, content_fit: live ? "fill" : options.fit,
        ...(video ? { muted: true, loop: false } : {}),
      }],
    };
  }) };
  assertPlaylistValid(document);
  return document;
}

export function targetDimensions(screen: unknown, width?: number, height?: number): { width: number; height: number } {
  if ((width === undefined) !== (height === undefined)) throw usageError("Provide both --target-width and --target-height.");
  if (width === undefined) {
    const surfaces = (screen as RecordValue | undefined)?.observation?.surfaces;
    if (!Array.isArray(surfaces) || surfaces.length !== 1) throw usageError("Screen dimensions are unknown or ambiguous; provide --target-width and --target-height.");
    width = surfaces[0]?.width; height = surfaces[0]?.height;
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! <= 0 || height! <= 0) throw usageError("Provide positive whole-number target dimensions.");
  return { width: width!, height: height! };
}
