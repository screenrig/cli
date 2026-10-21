/** Backend-owned offline cross-field checks. Run the generated PlaylistWrite
 * JSON Schema first. Neither pass resolves project-owned references, dynamic
 * selector cardinality, media durations, or DNS; those remain server checks. */
export interface PlaylistWriteIssue { path: string; message: string }
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function httpsWithoutCredentials(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    // WHATWG URL removes empty userinfo (https://@host), which the server
    // rejects too. Inspect the authored authority as well as parsed userinfo.
    return url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password
      && !/^https:\/\/[^/?#]*@/i.test(value);
  } catch { return false; }
}

function validCivil(value: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute] = parts.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute;
}

const LAYOUTS = ["full", "free", "center", "wide", "corner", "chip", "strip"];
const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const EDGES = ["top", "bottom", "left", "right"];

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
    const transition = object(page.transition);
    const stinger = object(transition.stinger);
    if (transition.type === "stinger" && typeof stinger.hang_ms === "number" && typeof transition.duration_ms === "number" && stinger.hang_ms * 5 > transition.duration_ms * 3) {
      fail(`${path}/transition/stinger/hang_ms`, "must be at most 60% of duration_ms");
    }
    const mode = object(page.advance).mode;
    const primitives = array(page.primitives).map(object);
    const ids = new Set<unknown>();
    let controllers = 0, web = 0, streams = 0;
    let mainCard: number | undefined;
    const corners = new Map<unknown, number>();
    for (const [primitiveIndex, primitive] of primitives.entries()) {
      const itemPath = `${path}/primitives/${primitiveIndex}`;
      if (ids.has(primitive.id)) fail(`${itemPath}/id`, "must be unique within the page");
      ids.add(primitive.id);
      if (primitive.primitive === "application" || primitive.primitive === "iframe") web++;
      if (primitive.primitive === "iframe" && !httpsWithoutCredentials(primitive.src)) {
        fail(`${itemPath}/src`, "must be a valid HTTPS URL without credentials");
      }
      if (primitive.primitive === "stream") {
        streams++;
        if (mode !== "duration") fail(`${itemPath}`, "streams require duration advance");
        const protocols = new Set<unknown>();
        for (const [sourceIndex, rawSource] of array(primitive.sources).entries()) {
          const source = object(rawSource), sourcePath = `${itemPath}/sources/${sourceIndex}`;
          if (protocols.has(source.protocol)) fail(sourcePath, "source protocols must be unique");
          protocols.add(source.protocol);
          if (source.protocol === "udp-mpegts" && (typeof source.group !== "string" || !/^239\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/.test(source.group) || source.group.split(".").some(part => Number(part) > 255))) fail(`${sourcePath}/group`, "must be an IPv4 multicast address in 239.0.0.0/8");
          if (source.protocol === "hls") {
            if (!httpsWithoutCredentials(source.url)) fail(`${sourcePath}/url`, "must be a valid HTTPS URL without credentials");
          }
        }
      }
      if (primitive.controller === true) {
        controllers++;
        if (primitive.primitive !== "application" || mode !== "application") fail(`${itemPath}/controller`, "is valid only on an application in application advance mode");
      }
      if (primitive.primitive === "application" && typeof primitive.release_id === "string" && !primitive.release_id) fail(`${itemPath}/release_id`, "is required");
      if (primitive.primitive === "card") {
        // Placement shape. The card's tier, the strip edges and the derived rect and layer stay server checks.
        const layout = primitive.layout;
        const anchors = layout === "corner" || layout === "chip" ? CORNERS : layout === "strip" ? EDGES : [];
        if (typeof layout !== "string" || !LAYOUTS.includes(layout)) fail(`${itemPath}/layout`, `is required and must be one of ${LAYOUTS.join(", ")}`);
        else if (anchors.length === 0 && Object.hasOwn(primitive, "anchor")) fail(`${itemPath}/anchor`, `is not allowed for layout ${layout}`);
        else if (anchors.length > 0 && !anchors.includes(primitive.anchor as string)) fail(`${itemPath}/anchor`, `is required for layout ${layout} and must be one of ${anchors.join(", ")}`);
        if (layout === "free") {
          if (!Object.hasOwn(primitive, "rect")) fail(`${itemPath}/rect`, "is required for layout free");
          if (!Object.hasOwn(primitive, "layer")) fail(`${itemPath}/layer`, "is required for layout free");
        }
        if (layout === "full" || layout === "center" || layout === "wide") {
          if (mainCard !== undefined) fail(`${itemPath}/layout`, "a page holds one full, center or wide card");
          mainCard = primitiveIndex;
        }
        if (layout === "corner" || layout === "chip") {
          if (corners.has(primitive.anchor)) fail(`${itemPath}/anchor`, "a page holds one corner or chip card per corner");
          corners.set(primitive.anchor, primitiveIndex);
        }
      }
      if (Object.hasOwn(primitive, "motion")) {
        const motionType = object(primitive.motion).type;
        if ((motionType === "spin" || motionType === "drift") && (primitive.primitive === "application" || primitive.primitive === "iframe" || primitive.primitive === "stream")) {
          fail(`${itemPath}/motion`, `${String(motionType)} is not allowed for application, iframe, and stream primitives`);
        }
      }
      if (primitive.primitive === "image" || primitive.primitive === "video") {
        const mediaSelector = object(primitive.selector);
        if (mediaSelector.by === "tag" && object(mediaSelector.tags) && mediaSelector.tags !== undefined && Object.keys(object(mediaSelector.tags)).length === 0) fail(`${itemPath}/selector/tags`, "must contain at least one filter");
        if (mediaSelector.one_at_a_time === true && mediaSelector.batch_size !== undefined && mediaSelector.batch_size !== 1) fail(`${itemPath}/selector/batch_size`, "one_at_a_time requires batch_size 1");
        if (mode === "duration" || mode === "application" || mode === "audio_end") {
          if (Object.hasOwn(primitive, "dwell_ms")) fail(`${itemPath}/dwell_ms`, "is forbidden on duration and application pages");
          const selector = object(primitive.selector);
          if ((selector.by === "all" || selector.by === "tag" || selector.by === "folder" || selector.by === "ids" && array(selector.media_ids).length > 1) && selector.one_at_a_time !== true) fail(`${itemPath}/selector/one_at_a_time`, "must be true for multiple media on duration or application pages");
        }
        if (mode === "media_end") {
          if (primitive.primitive === "image" && !Object.hasOwn(primitive, "dwell_ms")) fail(`${itemPath}/dwell_ms`, "is required for a media_end image");
          if (primitive.primitive === "video" && primitive.loop === true) fail(`${itemPath}/loop`, "must be false for media_end");
        }
      }
    }
    if (mode === "application" && controllers !== 1) fail(`${path}/primitives`, "application advance requires exactly one controller application");
    if (streams > 1) fail(`${path}/primitives`, "must contain at most one stream primitive");
    if (web > 2) fail(`${path}/primitives`, "must contain at most two application or iframe primitives");
    if (mode === "media_end") {
      if (web > 0) fail(`${path}/advance`, "media_end forbids application and iframe primitives");
      else if (primitives.filter((primitive) => primitive.primitive === "image" || primitive.primitive === "video").length !== 1) fail(`${path}/advance`, "media_end requires exactly one image or video primitive");
    }
  }
  if (pages.length > 0 && unscheduled === 0) fail("/pages", "must retain at least one page without a visibility rule");
  const trackIds = new Set<unknown>();
  for (const [index, raw] of array(object(playlist.audio).tracks).entries()) {
    const track = object(raw);
    if (trackIds.has(track.id)) fail(`/audio/tracks/${index}/id`, "must be unique within the playlist");
    trackIds.add(track.id);
  }
  for (const [index, raw] of pages.entries()) {
    const page = object(raw);
    if (!Object.hasOwn(page, "audio_cue")) {
      if (object(page.advance).mode === "audio_end") fail(`/pages/${index}/advance`, "audio_end requires an audio_cue on the same page");
      continue;
    }
    if (!Object.hasOwn(playlist, "audio")) fail(`/pages/${index}/audio_cue`, "requires a playlist audio soundtrack");
    else if (!trackIds.has(object(page.audio_cue).track)) fail(`/pages/${index}/audio_cue/track`, "must name a track id in audio.tracks");
  }
  return issues;
}
