import { usageError } from "./problems.js";

// The page background catalog: platform-owned images any project sets as a
// page's canvas background without copying them into its media.
//
// TYPED BY HAND, NOT GENERATED. vendor/openapi.yaml carries no /api/backgrounds
// routes today, so this file types them itself, following the BackgroundCategory,
// BackgroundSet, BackgroundSetDetail and BackgroundImage schemas the backend
// publishes for them and the ImageCanvasBackground form of a page's
// canvas.background. Replace these types with the generated ones when the
// contract sync brings the routes.

export const BACKGROUNDS_PATH = "/api/backgrounds";
export const BACKGROUND_ID_PATTERN = /^bg_[a-z0-9][a-z0-9._-]*-[0-9a-f]{8}$/;
export const BACKGROUND_ID_MAX = 160;
export const BACKGROUND_COLOR_PATTERN = /^#[0-9A-F]{8}$/;
export const DEFAULT_BACKGROUND_COLOR = "#000000FF";
export const BACKGROUND_ORIENTATIONS = ["landscape", "portrait"] as const;
/** The most primitives a page holds beside an image background (the Player's 24 less the image itself). */
export const IMAGE_BACKGROUND_PRIMITIVES_MAX = 23;

export interface BackgroundCategory { id: string; name: string; set_count: number; thumbnail_path: string }
export interface BackgroundSet {
  id: string; name: string; category: string; category_name: string; style: string;
  /** Up to three #RRGGBB colours of the set. */
  colors: string[];
  thumbnail_path: string; landscape_count: number; portrait_count: number;
}
export interface BackgroundImage {
  id: string; set: string; orientation: "landscape" | "portrait"; layout: string; label: string;
  width: number; height: number; bytes: number; sha256: string; tone: "dark" | "light"; image_path: string;
}
export interface BackgroundSetDetail extends BackgroundSet { backgrounds: BackgroundImage[] }
export interface BackgroundShown { background: BackgroundImage; set: BackgroundSet }

/** The image form of a page's canvas.background. */
export interface ImageCanvasBackground { type: "image"; background_id: string; color?: string }

export function isBackgroundId(value: unknown): value is string {
  return typeof value === "string" && value.length <= BACKGROUND_ID_MAX && BACKGROUND_ID_PATTERN.test(value);
}

/** `background apply BACKGROUND_ID`: an id as the catalog writes one, bg_ then the image's name. */
export function backgroundId(value: string): string {
  if (!isBackgroundId(value)) {
    throw usageError("A background id starts with bg_ and names one image, such as bg_blockbuster-laser-rush__landscape__bottom-banner-73d2f112.", {
      command: "screenrig background sets", reason: "List the sets, then background show SET_ID lists a set's image ids.",
    });
  }
  return value;
}

/** `background show ID`: a background id (bg_...) or a set id, which is any other catalog name. */
export function backgroundOrSetId(value: string): string {
  if (value.startsWith("bg_")) return backgroundId(value);
  if (!value || value.length > BACKGROUND_ID_MAX) {
    throw usageError("Give a set id or a background id (bg_...).", { command: "screenrig background sets", reason: "List the sets and their ids." });
  }
  return value;
}

/** `--color`: #RRGGBBAA, kept in the canonical uppercase form the contract takes. */
export function backgroundColor(value: string): string {
  const color = value.toUpperCase();
  if (!BACKGROUND_COLOR_PATTERN.test(color)) {
    throw usageError("--color takes #RRGGBBAA, such as #09111BFF (quote it in a shell).");
  }
  return color;
}

/** The colour a set's image sits on by default: the set's first colour, opaque. */
export function setBackgroundColor(group: Pick<BackgroundSet, "colors"> | undefined): string {
  const first = Array.isArray(group?.colors) ? group.colors[0] : undefined;
  return typeof first === "string" && /^#[0-9A-Fa-f]{6}$/.test(first) ? `${first.toUpperCase()}FF` : DEFAULT_BACKGROUND_COLOR;
}

type JSONObject = Record<string, unknown>;
const isObject = (value: unknown): value is JSONObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** The image background a stored page holds, with its colour when it has one. */
export function imageBackgroundOf(page: unknown): { background_id: string; color?: string } | undefined {
  const canvas = isObject(page) && isObject(page.canvas) ? page.canvas : undefined;
  const background = canvas && isObject(canvas.background) ? canvas.background : undefined;
  if (!background || background.type !== "image" || typeof background.background_id !== "string") return undefined;
  const color = typeof background.color === "string" && BACKGROUND_COLOR_PATTERN.test(background.color) ? background.color : undefined;
  return { background_id: background.background_id, ...(color ? { color } : {}) };
}

/** The page with its canvas.background replaced; every other member stays as it is. */
export function withCanvasBackground(page: JSONObject, background: string | ImageCanvasBackground): JSONObject {
  if (!isObject(page.canvas)) {
    throw usageError(`Page ${String(page.id)} has no canvas, so it has no background to set.`);
  }
  return { ...page, canvas: { ...page.canvas, background } };
}

/** A root-relative path from the catalog as an absolute URL on the API origin; anything else is returned as it is. */
export function backgroundUrl(path: string | undefined, apiUrl: string): string {
  if (!path) return "";
  if (!path.startsWith("/")) return path;
  try { return new URL(path, apiUrl).toString(); } catch { return path; }
}
