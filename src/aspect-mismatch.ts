import type { Warning } from "./envelope.js";

export const ASPECT_MISMATCH_CODE = "aspect_mismatch";

type Orientation = "landscape" | "portrait";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function orientation(width: unknown, height: unknown): Orientation | undefined {
  if (
    typeof width !== "number"
    || typeof height !== "number"
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
    || width === height
  ) {
    return undefined;
  }
  return width > height ? "landscape" : "portrait";
}

/**
 * Warn when server-resolved playlist media has the opposite orientation from
 * the player's last reported playback surface. Incomplete or malformed data is
 * deliberately treated as unknown: assignment remains authoritative on the
 * server and this advisory must never block it.
 */
export function aspectMismatchWarnings(screenId: string, screenValue: unknown, playlistValue: unknown): Warning[] {
  const screen = record(screenValue);
  const observation = record(screen?.observation);
  const surfaces = observation?.surfaces;
  const surface = Array.isArray(surfaces) ? record(surfaces[0]) : undefined;
  const surfaceOrientation = orientation(surface?.width, surface?.height);
  if (!surface || !surfaceOrientation) {
    return [];
  }

  const playlist = record(playlistValue);
  const pages = playlist?.pages;
  if (!Array.isArray(pages)) {
    return [];
  }

  const warnings: Warning[] = [];
  const seen = new Set<string>();
  for (const pageValue of pages) {
    const page = record(pageValue);
    if (typeof page?.id !== "string" || !Array.isArray(page.primitives)) {
      continue;
    }
    for (const primitiveValue of page.primitives) {
      const primitive = record(primitiveValue);
      if (
        (primitive?.primitive !== "image" && primitive?.primitive !== "video")
        || !Array.isArray(primitive.resolved_media)
      ) {
        continue;
      }
      for (const mediaValue of primitive.resolved_media) {
        const media = record(mediaValue);
        const intrinsicSize = record(media?.intrinsic_size);
        const mediaOrientation = orientation(intrinsicSize?.width, intrinsicSize?.height);
        if (typeof media?.media_id !== "string" || !mediaOrientation || mediaOrientation === surfaceOrientation) {
          continue;
        }
        const key = `${page.id}\u0000${media.media_id}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        warnings.push({
          code: ASPECT_MISMATCH_CODE,
          message: `Page ${page.id} uses ${mediaOrientation} media ${media.media_id} on screen ${screenId}, whose player reported a ${surfaceOrientation} ${surface.width}x${surface.height} surface.`,
        });
      }
    }
  }
  return warnings;
}
