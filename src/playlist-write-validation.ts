import { isIP } from "node:net";
import { usageError } from "./problems.js";

interface JsonRecord { [key: string]: unknown }

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MEDIA_ID_PATTERN = /^med_[A-Za-z0-9_-]+$/;
const COLOR_PATTERN = /^#[0-9A-F]{8}$/;
const CIVIL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError(`${name} must be an object.`);
  return value as JsonRecord;
}

function exact(owner: JsonRecord, allowed: readonly string[], name: string): void {
  const extras = Object.keys(owner).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw usageError(`${name} contains unsupported fields: ${extras.join(", ")}.`);
}

function string(owner: JsonRecord, key: string, name: string, max: number, pattern?: RegExp): string {
  const value = owner[key];
  if (typeof value !== "string" || value.length < 1 || value.length > max || (pattern && !pattern.test(value))) {
    throw usageError(`${name}.${key} is invalid.`);
  }
  return value;
}

function number(owner: JsonRecord, key: string, name: string, options: { min?: number; max?: number; integer?: boolean } = {}): number {
  const value = owner[key];
  if (
    typeof value !== "number" || !Number.isFinite(value) ||
    (options.integer && !Number.isSafeInteger(value)) ||
    (options.min !== undefined && value < options.min) ||
    (options.max !== undefined && value > options.max)
  ) throw usageError(`${name}.${key} is invalid.`);
  return value;
}

function optionalBoolean(owner: JsonRecord, key: string, name: string): boolean | undefined {
  const value = owner[key];
  if (value !== undefined && typeof value !== "boolean") throw usageError(`${name}.${key} must be boolean.`);
  return value as boolean | undefined;
}

function validateBackground(value: unknown, name: string): void {
  if (typeof value === "string") {
    if (!COLOR_PATTERN.test(value)) throw usageError(`${name} must be an uppercase #RRGGBBAA color or linear gradient.`);
    return;
  }
  const background = record(value, name);
  exact(background, ["type", "stops"], name);
  if (background.type !== "linear" || !Array.isArray(background.stops) || background.stops.length < 2 || background.stops.length > 8) {
    throw usageError(`${name} must be a linear gradient with 2 to 8 stops.`);
  }
  let previous = -1;
  for (const [index, value] of background.stops.entries()) {
    const stopName = `${name}.stops[${index}]`;
    const stop = record(value, stopName);
    exact(stop, ["at", "color"], stopName);
    const at = number(stop, "at", stopName, { min: 0, max: 1 });
    string(stop, "color", stopName, 9, COLOR_PATTERN);
    if (at <= previous) throw usageError(`${name} stops must be strictly increasing.`);
    previous = at;
  }
  const stops = background.stops as JsonRecord[];
  if (stops[0]?.at !== 0 || stops.at(-1)?.at !== 1) throw usageError(`${name} must start at 0 and end at 1.`);
}

function validateCanvas(value: unknown, name: string): void {
  const canvas = record(value, name);
  exact(canvas, ["width", "height", "viewport_fit", "background"], name);
  number(canvas, "width", name, { min: Number.MIN_VALUE });
  number(canvas, "height", name, { min: Number.MIN_VALUE });
  if (canvas.viewport_fit !== undefined && !["contain", "cover", "fill"].includes(String(canvas.viewport_fit))) {
    throw usageError(`${name}.viewport_fit must be contain, cover, or fill.`);
  }
  validateBackground(canvas.background, `${name}.background`);
}

function validateTransition(value: unknown, name: string): void {
  const transition = record(value, name);
  exact(transition, ["type", "duration_ms"], name);
  if (!["crossfade", "swipe-left", "swipe-right", "swipe-up", "swipe-down"].includes(String(transition.type))) {
    throw usageError(`${name}.type is invalid.`);
  }
  number(transition, "duration_ms", name, { integer: true, min: 0, max: 60_000 });
}

function validCivil(value: string): boolean {
  const match = CIVIL_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute;
}

function validateVisibility(value: unknown, name: string): void {
  const visibility = record(value, name);
  exact(visibility, ["enabled", "from", "until", "windows"], name);
  if (typeof visibility.enabled !== "boolean") throw usageError(`${name}.enabled must be boolean.`);
  for (const key of ["from", "until"] as const) {
    if (visibility[key] !== undefined && (typeof visibility[key] !== "string" || !validCivil(visibility[key] as string))) {
      throw usageError(`${name}.${key} must be a valid civil YYYY-MM-DDTHH:MM value.`);
    }
  }
  if (typeof visibility.from === "string" && typeof visibility.until === "string" && visibility.from >= visibility.until) {
    throw usageError(`${name}.until must be later than from.`);
  }
  if (visibility.windows !== undefined) {
    if (!Array.isArray(visibility.windows) || visibility.windows.length < 1 || visibility.windows.length > 16) {
      throw usageError(`${name}.windows must contain 1 to 16 windows.`);
    }
    for (const [index, value] of visibility.windows.entries()) {
      const windowName = `${name}.windows[${index}]`;
      const window = record(value, windowName);
      exact(window, ["days", "start", "end"], windowName);
      if (!Array.isArray(window.days) || window.days.length < 1 || window.days.length > 7 ||
        new Set(window.days).size !== window.days.length || window.days.some((day) => typeof day !== "string" || !DAYS.has(day))) {
        throw usageError(`${windowName}.days must contain unique civil weekdays.`);
      }
      const hasStart = window.start !== undefined;
      const hasEnd = window.end !== undefined;
      if (hasStart !== hasEnd || (hasStart && (typeof window.start !== "string" || typeof window.end !== "string" ||
        !TIME_PATTERN.test(window.start) || !TIME_PATTERN.test(window.end)))) {
        throw usageError(`${windowName}.start and end must both be valid HH:MM values or both be absent.`);
      }
    }
  }
  if (visibility.enabled === true && visibility.from === undefined && visibility.until === undefined && visibility.windows === undefined) {
    throw usageError(`${name} with enabled true must bound visibility.`);
  }
}

function validateRect(value: unknown, name: string): void {
  const rect = record(value, name);
  exact(rect, ["x", "y", "width", "height"], name);
  number(rect, "x", name);
  number(rect, "y", name);
  number(rect, "width", name, { min: Number.MIN_VALUE });
  number(rect, "height", name, { min: Number.MIN_VALUE });
}

function validateEnter(value: unknown, name: string): void {
  const enter = record(value, name);
  exact(enter, ["type"], name);
  if (!["fade-up", "fade-down", "fade-left", "fade-right", "fade-in", "zoom-in", "zoom-out"].includes(String(enter.type))) {
    throw usageError(`${name}.type is invalid.`);
  }
}

function validateIframe(value: JsonRecord, name: string): void {
  exact(value, ["type", "src", "title"], name);
  const src = string(value, "src", name, 4096);
  string(value, "title", name, 200);
  let parsed: URL;
  try { parsed = new URL(src); } catch { throw usageError(`${name}.src must be a public HTTPS URL.`); }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = isIP(hostname) === 4 ? hostname.split(".").map(Number) : undefined;
  const privateIpv4 = ipv4 && (
    ipv4[0] === 10 || ipv4[0] === 127 ||
    (ipv4[0] === 169 && ipv4[1] === 254) ||
    (ipv4[0] === 172 && (ipv4[1] ?? 0) >= 16 && (ipv4[1] ?? 0) <= 31) ||
    (ipv4[0] === 192 && ipv4[1] === 168)
  );
  const privateIpv6 = isIP(hostname) === 6 && (
    hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || /^fe[89ab]/.test(hostname)
  );
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password || !hostname ||
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
    privateIpv4 || privateIpv6
  ) {
    throw usageError(`${name}.src must be a public HTTPS URL without credentials.`);
  }
}

function validateSelector(
  value: unknown,
  name: string,
  kind: "image" | "video",
  mediaKinds: ReadonlyMap<string, "image" | "video">,
  referenced: Set<string>,
): { count: number; oneAtATime: boolean } {
  const selector = record(value, name);
  let ids: string[];
  if (selector.by === "id") {
    exact(selector, ["by", "media_id", "one_at_a_time"], name);
    ids = [string(selector, "media_id", name, 256, MEDIA_ID_PATTERN)];
    if (selector.one_at_a_time !== undefined && selector.one_at_a_time !== false) throw usageError(`${name}.one_at_a_time must be false for by:id.`);
  } else if (selector.by === "ids") {
    exact(selector, ["by", "media_ids", "one_at_a_time"], name);
    if (!Array.isArray(selector.media_ids) || selector.media_ids.length < 1 || selector.media_ids.length > 32 ||
      new Set(selector.media_ids).size !== selector.media_ids.length ||
      selector.media_ids.some((id) => typeof id !== "string" || !MEDIA_ID_PATTERN.test(id))) {
      throw usageError(`${name}.media_ids must contain 1 to 32 unique media ids.`);
    }
    optionalBoolean(selector, "one_at_a_time", name);
    ids = selector.media_ids as string[];
  } else {
    throw usageError(`${name} must be snapshotted to by:id or by:ids.`);
  }
  for (const id of ids) {
    const actual = mediaKinds.get(id);
    if (!actual) throw usageError(`${name} references media missing from the bundle: ${id}.`);
    if (actual !== kind) throw usageError(`${name} references ${actual} media from an ${kind} placement: ${id}.`);
    referenced.add(id);
  }
  return { count: ids.length, oneAtATime: selector.one_at_a_time === true };
}

function validateAdvance(value: unknown, name: string): "duration" | "application" | "media_end" {
  const advance = record(value, name);
  if (advance.mode === "duration") {
    exact(advance, ["mode", "after_ms"], name);
    number(advance, "after_ms", name, { integer: true, min: 1000, max: 86_400_000 });
    return "duration";
  }
  if (advance.mode === "application") {
    exact(advance, ["mode", "max_ms"], name);
    number(advance, "max_ms", name, { integer: true, min: 1000, max: 86_400_000 });
    return "application";
  }
  if (advance.mode === "media_end") {
    exact(advance, ["mode", "max_ms"], name);
    if (advance.max_ms !== undefined) number(advance, "max_ms", name, { integer: true, min: 1000, max: 86_400_000 });
    return "media_end";
  }
  throw usageError(`${name}.mode is invalid.`);
}

export function validatePlaylistWrite(
  value: unknown,
  mediaKinds: ReadonlyMap<string, "image" | "video">,
): Set<string> {
  const playlist = record(value, "playlist.json");
  exact(playlist, ["name", "pages"], "playlist.json");
  string(playlist, "name", "playlist.json", 120);
  if (!Array.isArray(playlist.pages) || playlist.pages.length < 1 || playlist.pages.length > 100) {
    throw usageError("playlist.json.pages must contain 1 to 100 pages.");
  }
  const pageIds = new Set<string>();
  const referenced = new Set<string>();
  let unscheduled = 0;
  for (const [pageIndex, pageValue] of playlist.pages.entries()) {
    const pageName = `playlist.pages[${pageIndex}]`;
    const page = record(pageValue, pageName);
    exact(page, ["id", "canvas", "transition", "advance", "visibility", "placements"], pageName);
    const pageId = string(page, "id", pageName, 64, ID_PATTERN);
    if (pageIds.has(pageId)) throw usageError(`Playlist page id is duplicated: ${pageId}.`);
    pageIds.add(pageId);
    validateCanvas(page.canvas, `${pageName}.canvas`);
    validateTransition(page.transition, `${pageName}.transition`);
    const advance = validateAdvance(page.advance, `${pageName}.advance`);
    if (page.visibility === undefined) unscheduled += 1;
    else validateVisibility(page.visibility, `${pageName}.visibility`);
    if (!Array.isArray(page.placements) || page.placements.length < 1 || page.placements.length > 24) {
      throw usageError(`${pageName}.placements must contain 1 to 24 placements.`);
    }
    const placementIds = new Set<string>();
    const mediaPlacements: Array<{ type: "image" | "video"; content: JsonRecord; selector: { count: number; oneAtATime: boolean } }> = [];
    let iframeCount = 0;
    for (const [placementIndex, placementValue] of page.placements.entries()) {
      const placementName = `${pageName}.placements[${placementIndex}]`;
      const placement = record(placementValue, placementName);
      exact(placement, ["id", "content", "rect", "layer", "content_fit", "enter"], placementName);
      const placementId = string(placement, "id", placementName, 64, ID_PATTERN);
      if (placementIds.has(placementId)) throw usageError(`${pageName} placement id is duplicated: ${placementId}.`);
      placementIds.add(placementId);
      validateRect(placement.rect, `${placementName}.rect`);
      number(placement, "layer", placementName, { integer: true, min: 0, max: 1024 });
      if (placement.enter !== undefined) validateEnter(placement.enter, `${placementName}.enter`);
      const content = record(placement.content, `${placementName}.content`);
      if (content.type === "application") throw usageError("Playlist bundles do not support application placements.");
      if (content.type === "iframe") {
        validateIframe(content, `${placementName}.content`);
        if (placement.content_fit !== "fill") throw usageError(`${placementName}.content_fit must be fill for an iframe.`);
        iframeCount += 1;
        continue;
      }
      if (content.type !== "image" && content.type !== "video") throw usageError(`${placementName}.content.type is unsupported.`);
      if (!["contain", "cover", "fill"].includes(String(placement.content_fit))) throw usageError(`${placementName}.content_fit is invalid.`);
      const kind = content.type;
      exact(content, kind === "image" ? ["type", "selector", "alt", "dwell_ms"] : ["type", "selector", "muted", "loop"], `${placementName}.content`);
      const selector = validateSelector(content.selector, `${placementName}.content.selector`, kind, mediaKinds, referenced);
      if (kind === "image") {
        if (content.alt !== undefined && (typeof content.alt !== "string" || content.alt.length > 300)) throw usageError(`${placementName}.content.alt is invalid.`);
        if (content.dwell_ms !== undefined) number(content, "dwell_ms", `${placementName}.content`, { integer: true, min: 1000, max: 86_400_000 });
      } else {
        if (content.muted !== undefined && content.muted !== true) throw usageError(`${placementName}.content.muted must be true.`);
        optionalBoolean(content, "loop", `${placementName}.content`);
      }
      mediaPlacements.push({ type: kind, content, selector });
    }
    if (iframeCount > 2) throw usageError(`${pageName}.placements must contain at most 2 iframe placements.`);
    if (advance === "application") throw usageError(`${pageName} application advance is unsupported because bundles exclude applications.`);
    if (advance === "media_end") {
      if (page.placements.length !== 1 || mediaPlacements.length !== 1 || iframeCount > 0) throw usageError(`${pageName} media_end requires exactly one image or video placement.`);
      const only = mediaPlacements[0]!;
      if (only.type === "image" && only.content.dwell_ms === undefined) throw usageError(`${pageName} media_end image requires dwell_ms.`);
      if (only.type === "video" && only.content.loop === true) throw usageError(`${pageName} media_end video must not loop.`);
    } else {
      for (const media of mediaPlacements) {
        if (media.type === "image" && media.content.dwell_ms !== undefined) throw usageError(`${pageName} duration pages forbid image dwell_ms.`);
        if (media.selector.count > 1 && !media.selector.oneAtATime) throw usageError(`${pageName} multi-item selectors require one_at_a_time true.`);
      }
    }
  }
  if (unscheduled === 0) throw usageError("Every playlist must keep at least one page with no visibility field.");
  return referenced;
}
