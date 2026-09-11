import { assertPlaylistValid } from "./playlist-validate.js";
import { usageError } from "./problems.js";

type RecordValue = Record<string, any>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("Expected a playlist object.");
  return value as RecordValue;
}
/** Preserve authored selectors; strip only fields the backend derives on reads. */
export function editablePlaylist(value: unknown): RecordValue {
  const resource = object(value);
  const document = structuredClone({ name: resource.name, pages: resource.pages });
  if (!Array.isArray(document.pages)) throw usageError("Playlist pages are missing.");
  for (const page of document.pages) {
    object(page);
    if (page.advance?.mode === "media_end") delete page.advance.max_ms;
    if (!Array.isArray(page.primitives)) throw usageError("Playlist primitives are missing.");
    for (const primitive of page.primitives) {
      object(primitive);
      if (["image", "video", "stream"].includes(primitive.primitive)) {
        delete primitive.resolved_media;
        // Omit the server-inserted false default without changing selector behavior.
        if (primitive.selector?.by === "id" && primitive.selector.one_at_a_time === false) delete primitive.selector.one_at_a_time;
      }
    }
  }
  assertPlaylistValid(document);
  return document;
}

export function initializePlaylist(options: {
  name: string; media: RecordValue[]; width: number; height: number; durationMs: number; fit: string;
}): RecordValue {
  return preparePlaylist({ ...options, content: options.media });
}

/** Build the backend-owned write document; target metadata stays outside it. */
export function preparePlaylist(options: {
  name: string; content: RecordValue[]; width: number; height: number; durationMs: number; fit: string;
}): RecordValue {
  const document = { name: options.name, pages: options.content.map((media, index) => {
    const live = media.primitive === "iframe" || media.primitive === "application";
    if (!live && (media.state !== "ready" || !["image", "video"].includes(media.primitive))) throw usageError("Every media item must be a ready image or video.");
    const video = media.primitive === "video";
    return {
      id: `page_${index + 1}`,
      canvas: { width: options.width, height: options.height, viewport_fit: "contain", background: "#000000FF" },
      transition: { type: "crossfade", duration_ms: 200 },
      advance: video ? { mode: "media_end" } : { mode: "duration", after_ms: options.durationMs },
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
