/** Backend-owned offline cross-field checks. Run the generated PlaylistWrite
 * JSON Schema first. Neither pass resolves account-owned references, dynamic
 * selector cardinality, media durations, or DNS; those remain server checks. */
export interface PlaylistWriteIssue { path: string; message: string }
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function validCivil(value: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute] = parts.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute;
}

export function validatePlaylistWriteSemantics(value: unknown): PlaylistWriteIssue[] {
  const issues: PlaylistWriteIssue[] = [];
  const fail = (path: string, message: string): void => { issues.push({ path, message }); };
  const playlist = object(value);
  const pages = array(playlist.pages);
  if (typeof playlist.name === "string" && !playlist.name.trim()) fail("/name", "must not be blank");
  const pageIds = new Set<unknown>();
  let unscheduled = 0;
  for (const [index, raw] of pages.entries()) {
    const page = object(raw), path = `/pages/${index}`;
    if (pageIds.has(page.id)) fail(`${path}/id`, "must be unique within the playlist");
    pageIds.add(page.id);
    if (!Object.hasOwn(page, "visibility")) unscheduled++;
    else {
      const visibility = object(page.visibility);
      for (const key of ["from", "until"]) {
        if (typeof visibility[key] === "string" && !validCivil(visibility[key])) fail(`${path}/visibility/${key}`, "must be a valid civil date and time");
      }
      if (typeof visibility.from === "string" && typeof visibility.until === "string" && visibility.from >= visibility.until) fail(`${path}/visibility/until`, "must be later than from");
      if (visibility.enabled === true && visibility.from === undefined && visibility.until === undefined && visibility.windows === undefined) fail(`${path}/visibility`, "an always-visible page must omit visibility");
      for (const [windowIndex, rawWindow] of array(visibility.windows).entries()) {
        const window = object(rawWindow);
        if (Object.hasOwn(window, "start") !== Object.hasOwn(window, "end")) fail(`${path}/visibility/windows/${windowIndex}`, "start and end must both be present or both absent");
      }
    }
    const background = object(object(page.canvas).background);
    if (background.type === "linear") {
      const stops = array(background.stops).map(object);
      if (stops[0]?.at !== 0 || stops.at(-1)?.at !== 1) fail(`${path}/canvas/background/stops`, "must start at 0 and end at 1");
      for (let i = 1; i < stops.length; i++) if (Number(stops[i]?.at) <= Number(stops[i - 1]?.at)) fail(`${path}/canvas/background/stops/${i}/at`, "must be strictly increasing");
    }
    const mode = object(page.advance).mode;
    const primitives = array(page.primitives).map(object);
    const ids = new Set<unknown>();
    let controllers = 0, web = 0;
    for (const [primitiveIndex, primitive] of primitives.entries()) {
      const itemPath = `${path}/primitives/${primitiveIndex}`;
      if (ids.has(primitive.id)) fail(`${itemPath}/id`, "must be unique within the page");
      ids.add(primitive.id);
      if (primitive.primitive === "application" || primitive.primitive === "iframe") web++;
      if (primitive.controller === true) {
        controllers++;
        if (primitive.primitive !== "application" || mode !== "application") fail(`${itemPath}/controller`, "is valid only on an application in application advance mode");
      }
      if (primitive.primitive === "application" && typeof primitive.release_id === "string" && !primitive.release_id) fail(`${itemPath}/release_id`, "is required");
      if (primitive.primitive === "image" || primitive.primitive === "video") {
        if (mode === "duration" || mode === "application") {
          if (Object.hasOwn(primitive, "dwell_ms")) fail(`${itemPath}/dwell_ms`, "is forbidden on duration and application pages");
          const selector = object(primitive.selector);
          if (selector.by === "ids" && array(selector.media_ids).length > 1 && selector.one_at_a_time !== true) fail(`${itemPath}/selector/one_at_a_time`, "must be true for multiple media on duration or application pages");
        }
        if (mode === "media_end") {
          if (primitive.primitive === "image" && !Object.hasOwn(primitive, "dwell_ms")) fail(`${itemPath}/dwell_ms`, "is required for a media_end image");
          if (primitive.primitive === "video" && primitive.loop === true) fail(`${itemPath}/loop`, "must be false for media_end");
        }
      }
    }
    if (mode === "application" && controllers !== 1) fail(`${path}/primitives`, "application advance requires exactly one controller application");
    if (web > 2) fail(`${path}/primitives`, "must contain at most two application or iframe primitives");
    if (mode === "media_end" && (primitives.length !== 1 || !["image", "video"].includes(String(primitives[0]?.primitive)))) fail(`${path}/advance`, "media_end requires exactly one image or video primitive");
  }
  if (pages.length > 0 && unscheduled === 0) fail("/pages", "must retain at least one page without a visibility rule");
  return issues;
}
