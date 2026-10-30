/** Backend-owned offline cross-field checks. Run the generated PlaylistWrite
 * JSON Schema first. Neither pass resolves project-owned references, dynamic
 * selector cardinality, media durations, or DNS; those remain server checks. */
export interface PlaylistWriteIssue { path: string; message: string }
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Whether any page has civil-time bounds that require a screen timezone. */
export function playlistNeedsTimezone(value: unknown): boolean {
  return array(object(value).pages).some(rawPage => {
    const visibility = object(object(rawPage).visibility);
    return ["from", "until", "windows"].some(key => Object.hasOwn(visibility, key));
  });
}

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

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The src of the first iframe of a pasted embed code, entities decoded (server embeddedSource); any other value is returned as it is. */
function embeddedSource(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 4096 || !/^\s*<iframe\b/i.test(value)) return value;
  const match = /<iframe\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/is.exec(value);
  const source = match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
  if (source === undefined) return value;
  return source.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (entity, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? "", 16);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }).trim();
}

/** A screen token in an iframe src or an application param (server screenfacts.urlTokenPattern). */
const SCREEN_TOKEN = /\{screen\.(?:id|name|timezone|field\.[a-z0-9_]{1,32}|location\.(?:lat|lon|name|address))\}/g;
const hasScreenToken = (value: string): boolean => value.includes("{screen.") && new RegExp(SCREEN_TOKEN.source).test(value);
/** The src with one letter in each token's place, the stand-in the server checks (screenfacts.URLPlaceholder). */
const screenTokenStandIn = (value: string): string => value.replace(SCREEN_TOKEN, "x");

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const DOCUMENT_HOSTS = new Set(["docs.google.com", "onedrive.live.com", "view.officeapps.live.com", "1drv.ms"]);

/**
 * Why an iframe src with screen tokens cannot be a template, or undefined (server screenfacts.CheckURLTemplate and
 * documentLinks.templateRefusal): tokens stand only in the path, query and fragment of an http(s) URL, and never in a YouTube,
 * Google or Microsoft document or BI view address, which the server rewrites or appends to.
 */
function screenTemplateRefusal(source: string): string | undefined {
  const origin = /^https?:\/\/[^/?#]*/i.exec(source)?.[0];
  if (origin === undefined) return "must start with http:// or https:// to carry {screen.…} tokens";
  if (hasScreenToken(origin)) return "{screen.…} tokens may stand only in the path, query or fragment, not in the scheme, credentials, host or port";
  if (source.includes("\\")) return "cannot carry {screen.…} tokens together with a backslash";
  let host: string;
  try { host = new URL(screenTokenStandIn(source)).hostname.toLowerCase().replace(/\.$/, ""); } catch { return undefined; }
  if (YOUTUBE_HOSTS.has(host)) return "cannot carry {screen.…} tokens: a YouTube link is rewritten to its embed form";
  if (DOCUMENT_HOSTS.has(host) || /^[a-z0-9-]+\.sharepoint\.com$/.test(host) || host.startsWith("doc.apps.")) return "cannot carry {screen.…} tokens: a Google or Microsoft document link is rebuilt for the screen";
  if (/^bi-[0-9a-f]{20}\.apps\./.test(host)) return "cannot carry {screen.…} tokens: a BI view's address carries the screen's embed ticket";
  return undefined;
}

/** An iframe page a sign shows: http or https, any host, credentials allowed (server signageWebURL). */
function signageUrl(value: unknown, protocols: readonly string[]): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && url.hostname !== "";
  } catch { return false; }
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** The rule a bracketed IPv6 host breaks, or undefined (server splitNavigationAuthority). */
function ipv6Issue(address: string): string | undefined {
  let canonical: string;
  try { canonical = new URL(`http://[${address}]/`).hostname; } catch { return "host is not a valid IPv6 address"; }
  return canonical.startsWith("[::ffff:") ? "host must not be an IPv4-mapped IPv6 address: write the IPv4 address" : undefined;
}

/** The rule a host (not an IPv6 address) breaks: a name, an IPv4 address, `*.name` or `*`. */
function navigationHostIssue(host: string): string | undefined {
  if (host === "*" || host.startsWith("[")) return undefined;
  const wildcard = host.startsWith("*.");
  const name = (wildcard ? host.slice(2) : host).toLowerCase();
  if (name.includes("*")) return "host may use * only alone or as a leading *. (as in *.example.com)";
  if (name === "") return "host is required";
  if (name.length > 253) return "host must be at most 253 characters";
  const labels = name.split(".");
  for (const label of labels) {
    if (label === "") return "host has an empty label (a leading, trailing or doubled dot)";
    if (label.length > 63) return "host labels must be at most 63 characters";
    if (!/^[a-z0-9-]+$/.test(label)) return "host may contain only letters, digits, hyphens and dots";
  }
  // A host whose last label is a number is an IPv4 address to a URL parser: only the four-part form is unambiguous.
  if (/^\d+$/.test(labels[labels.length - 1]!)) {
    if (!IPV4.test(name)) return "host must be a name or an IPv4 address written as four decimal parts (a.b.c.d)";
    if (wildcard) return "a wildcard needs a domain name, not an IP address";
  }
  return undefined;
}

function navigationPathIssue(path: string): string | undefined {
  if (path === "" || path === "/*") return undefined;
  if (path.endsWith("/*")) path = path.slice(0, -1);
  if (path.includes("*")) return "path may use * only as a final /*";
  for (let index = 0; index < path.length; index++) {
    const char = path[index]!;
    if (char === "%") {
      if (!/^[0-9a-fA-F]{2}$/.test(path.slice(index + 1, index + 3))) return "path has a % that is not a %XX escape";
      index += 2;
    } else if (!/^[A-Za-z0-9\-._~!$&()+=:@/]$/.test(char)) {
      return "path may contain only letters, digits, - . _ ~ ! $ & ( ) + = : @ / and %XX escapes";
    }
  }
  return undefined;
}

/**
 * The rule an iframe navigation_allowlist entry breaks, or undefined: a CSP3
 * host-source, [scheme "://"] host [":" port] [path], mirroring the server's
 * NormalizeNavigationEntry (internal/playlists/navigation_allowlist.go) rule for rule.
 */
function navigationEntryIssue(entry: string): string | undefined {
  if (entry === "") return "must not be empty";
  if (entry.length > 2048) return "must be at most 2048 characters";
  for (const char of entry) {
    const code = char.codePointAt(0)!;
    if (code > 0x7f) return "must be ASCII: write a host in punycode (xn--) and a path percent-encoded";
    if (code <= 0x20 || code === 0x7f) return "must not contain spaces or control characters";
    if (char === "?" || char === "#") return "must not have a query or a fragment: they never count";
    if (char === ";" || char === "," || char === "'" || char === '"') return "must not contain ; , ' or \": they end a CSP source";
  }
  let rest = entry;
  const schemeEnd = rest.indexOf("://");
  if (schemeEnd >= 0 && !rest.slice(0, schemeEnd).includes("/")) {
    const scheme = rest.slice(0, schemeEnd).toLowerCase();
    if (scheme !== "http" && scheme !== "https") return "scheme must be http or https";
    rest = rest.slice(schemeEnd + 3);
  }
  const slash = rest.indexOf("/");
  const authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash) : "";
  if (authority.includes("@")) return "must not include credentials (user:pass@)";

  let host: string, port: string | undefined;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return "an IPv6 host needs its closing ]";
    const issue = ipv6Issue(authority.slice(1, end));
    if (issue !== undefined) return issue;
    host = "[";
    const after = authority.slice(end + 1);
    if (after.startsWith(":")) port = after.slice(1);
    else if (after !== "") return "an IPv6 host may be followed only by :port or a path";
  } else {
    const colon = authority.indexOf(":");
    host = colon < 0 ? authority : authority.slice(0, colon);
    port = colon < 0 ? undefined : authority.slice(colon + 1);
    if (port?.includes(":")) return "an IPv6 host must be written in brackets, as [::1]";
  }
  const hostIssue = navigationHostIssue(host);
  if (hostIssue !== undefined) return hostIssue;
  if (port !== undefined && port !== "*" && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) return "port must be 1 to 65535 or *";
  return navigationPathIssue(path);
}

// A stream source that names no protocol takes it from its URL's scheme.
function impliedStreamProtocol(value: unknown): string | undefined {
  const scheme = typeof value === "string" ? /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase() : undefined;
  return scheme === "https" ? "hls" : scheme === "rtsp" || scheme === "rtsps" ? "rtsp" : undefined;
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

/** columns is the tiles across: displays for a row, 1 for a column, the format's columns for a grid. */
interface WallFormat { displays: number; arrangement: "row" | "column" | "grid"; orientation: "landscape" | "portrait"; columns: number }
/** The displays a primitive covers: ascending, unique, 1-based. */
type Frame = number[];

const MAX_DISPLAYS = 12;

/** The wall a format names, or why its columns are refused. The JSON Schema holds the other members; the columns rules are cross-field. */
function readFormat(value: unknown): { format?: WallFormat; columnsReason?: string } {
  const { displays, arrangement, orientation, columns } = object(value);
  if (typeof displays !== "number" || !Number.isInteger(displays) || displays < 2 || displays > MAX_DISPLAYS) return {};
  if (orientation !== "landscape" && orientation !== "portrait") return {};
  if (arrangement === "row" || arrangement === "column") {
    return columns === undefined ? { format: { displays, arrangement, orientation, columns: arrangement === "row" ? displays : 1 } } : { columnsReason: "is only for arrangement grid" };
  }
  if (arrangement !== "grid") return {};
  if (columns === undefined) return { columnsReason: "is required for arrangement grid: the displays per row" };
  // A grid holds whole rows: at least two columns of them and at least two rows.
  if (typeof columns !== "number" || !Number.isInteger(columns) || columns < 2 || displays % columns !== 0 || displays / columns < 2) {
    return { columnsReason: "must be an integer of at least 2 that divides displays into at least 2 rows" };
  }
  return { format: { displays, arrangement, orientation, columns } };
}

/** The format in words, as the server says it: "3 landscape displays in a row", "12 landscape displays in a 4-column grid". */
const describeFormat = (format: WallFormat): string =>
  `${format.displays} ${format.orientation} displays in ${format.arrangement === "grid" ? `a ${format.columns}-column grid` : `a ${format.arrangement}`}`;

/** One display: 1920 x 1080 landscape, 1080 x 1920 portrait. */
const tileOf = (format: WallFormat): [number, number] => format.orientation === "portrait" ? [1080, 1920] : [1920, 1080];

/** The canvas every ordinary page of the format has: a tile times the columns across and the rows down. */
function canvasOf(format: WallFormat): [number, number] {
  const [width, height] = tileOf(format);
  return [width * format.columns, height * (format.displays / format.columns)];
}

/** The first and last column and row of the tiles of a frame. Display n sits at column (n - 1) mod columns, row floor((n - 1) / columns). */
function spanOf(format: WallFormat, frame: Frame): { left: number; right: number; top: number; bottom: number } {
  const columns = frame.map(display => (display - 1) % format.columns), rows = frame.map(display => Math.floor((display - 1) / format.columns));
  return { left: Math.min(...columns), right: Math.max(...columns), top: Math.min(...rows), bottom: Math.max(...rows) };
}

/** The bounding box of the tiles of a frame, in canvas units. */
function frameRect(format: WallFormat, frame: Frame): { x: number; y: number; width: number; height: number } {
  const [width, height] = tileOf(format), { left, right, top, bottom } = spanOf(format, frame);
  return { x: left * width, y: top * height, width: (right - left + 1) * width, height: (bottom - top + 1) * height };
}

/** Whether the frame is exactly the tiles of one rectangle of the wall, none of the rectangle missing. */
function fillsRectangle(format: WallFormat, frame: Frame): boolean {
  const { left, right, top, bottom } = spanOf(format, frame);
  return (right - left + 1) * (bottom - top + 1) === frame.length;
}

const DISPLAYS_REASON = "must be ascending display numbers that fill a rectangle of the wall, such as [2] or [1, 2]";

/** Ascending, unique 1-based display numbers such as [2] or [1, 2, 5, 6]; undefined for anything else. Which fill a rectangle depends on the format. */
function readDisplays(value: unknown): Frame | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DISPLAYS) return undefined;
  let previous = 0;
  for (const display of value as unknown[]) {
    if (typeof display !== "number" || !Number.isInteger(display) || display < 1 || display > MAX_DISPLAYS || display <= previous) return undefined;
    previous = display;
  }
  return value as number[];
}

const framesShare = (a: Frame, b: Frame): boolean => a.some(display => b.includes(display));
const sameNumber = (a: unknown, b: number): boolean => typeof a === "number" && Math.abs(a - b) < 1e-6;

const LAYOUTS = ["full", "free", "center", "wide", "header", "footer", "corner", "chip", "strip"];
const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const EDGES = ["top", "bottom", "left", "right"];

const RESERVED_LAUNCH_PARAMS = ["ticket", "policy"];

/** An application's launch params beyond their schema: the launch URL sets ticket and policy itself, and a value has no control character (server validateLaunchParams). Returns the text members. */
function launchParams(value: unknown, path: string, fail: (path: string, message: string) => void): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const params: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (RESERVED_LAUNCH_PARAMS.includes(name)) fail(`${path}/${name}`, "is set by the launch URL and cannot be a parameter");
    else if (typeof item === "string" && /\p{Cc}/u.test(item)) fail(`${path}/${name}`, "must be text without control characters");
    if (typeof item === "string") params[name] = item;
  }
  // The params as the launch URL carries them, a token counted as one letter (server validateLaunchParams).
  const length = launchQueryLength(Object.fromEntries(Object.entries(params).map(([name, item]) => [name, screenTokenStandIn(item)])));
  if (length > MAX_LAUNCH_QUERY) fail(path, `must encode to at most ${MAX_LAUNCH_QUERY} characters in the launch URL, not ${length}`);
  return params;
}

/** The longest the params may be in the launch URL, "&name=value" for each (server playlists.MaxLaunchQuery). */
const MAX_LAUNCH_QUERY = 4096;
const textEncoder = new TextEncoder();

/** How many characters params take in the launch URL: every UTF-8 byte but a letter, digit or - . _ ~ becomes %XX (server playlists.LaunchQueryLength). */
function launchQueryLength(params: Record<string, string>): number {
  let length = 0;
  for (const [name, value] of Object.entries(params)) {
    length += 2 + name.length;
    for (const byte of textEncoder.encode(value)) {
      const unreserved = byte >= 0x61 && byte <= 0x7a || byte >= 0x41 && byte <= 0x5a || byte >= 0x30 && byte <= 0x39 || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e;
      length += unreserved ? 1 : 3;
    }
  }
  return length;
}

export function validatePlaylistWriteSemantics(value: unknown): PlaylistWriteIssue[] {
  const issues: PlaylistWriteIssue[] = [];
  const fail = (path: string, message: string): void => { issues.push({ path, message }); };
  const playlist = object(value);
  const pages = array(playlist.pages);
  const { format, columnsReason } = readFormat(playlist.format);
  if (columnsReason !== undefined) fail("/format/columns", columnsReason);
  if (typeof playlist.name === "string" && !playlist.name.trim()) fail("/name", "must not be blank");
  const pageIds = new Set<unknown>();
  const releaseParams = new Map<string, string | undefined>();
  let unscheduled = 0;
  for (const [index, raw] of pages.entries()) {
    const page = object(raw), path = `/pages/${index}`;
    if (pageIds.has(page.id)) fail(`${path}/id`, "must be unique within the playlist");
    pageIds.add(page.id);
    if (format !== undefined && page.type !== "adslot") {
      const canvas = object(page.canvas), [wantWidth, wantHeight] = canvasOf(format);
      if (typeof canvas.width === "number" && typeof canvas.height === "number" && (canvas.width !== wantWidth || canvas.height !== wantHeight)) {
        fail(`${path}/canvas`, `must be ${wantWidth} x ${wantHeight} canvas units, the canvas of ${describeFormat(format)}`);
      }
    }
    if (!Object.hasOwn(page, "visibility")) unscheduled++;
    else {
      const visibility = object(page.visibility);
      for (const key of ["from", "until"]) {
        if (typeof visibility[key] === "string" && !validCivil(visibility[key])) fail(`${path}/visibility/${key}`, "must be a valid civil date and time");
      }
      if (typeof visibility.from === "string" && typeof visibility.until === "string" && visibility.from >= visibility.until) fail(`${path}/visibility/until`, "must be later than from");
      if (visibility.enabled === true && visibility.from === undefined && visibility.until === undefined && visibility.windows === undefined && visibility.data === undefined) fail(`${path}/visibility`, "an always-visible page must omit visibility");
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
    // The slots cards hold, with the displays each holder covers: two cards conflict only when their frames
    // share a display. A card without displays covers every display of the playlist format.
    const mainCards: Frame[] = [];
    const corners = new Map<unknown, Frame[]>();
    const bars = new Map<unknown, Frame[]>();
    const takes = (held: Frame[] | undefined, frame: Frame): boolean => held?.some(other => framesShare(other, frame)) === true;
    for (const [primitiveIndex, primitive] of primitives.entries()) {
      const itemPath = `${path}/primitives/${primitiveIndex}`;
      if (ids.has(primitive.id)) fail(`${itemPath}/id`, "must be unique within the page");
      ids.add(primitive.id);
      if (primitive.primitive === "application" || primitive.primitive === "iframe") web++;
      if (primitive.primitive === "iframe") {
        for (const key of ["src", "fallback_src"] as const) {
          // fallback_src takes the forms and rules of src; an empty string is not "none" (omit the key).
          if (key === "fallback_src" && !Object.hasOwn(primitive, key)) continue;
          // An address with screen tokens is stored as written and checked with a letter in each token's place.
          const source = embeddedSource(primitive[key]);
          const templated = typeof source === "string" && hasScreenToken(source);
          const refusal = templated ? screenTemplateRefusal(source) : undefined;
          if (refusal !== undefined) fail(`${itemPath}/${key}`, refusal);
          else if (!signageUrl(templated ? screenTokenStandIn(source) : source, ["http:", "https:"])) fail(`${itemPath}/${key}`, "must be an http or https URL");
        }
        // The schema bounds reload_s to 0 through 86400; the gap between 0 and 60 is the rule it cannot state.
        if (typeof primitive.reload_s === "number" && primitive.reload_s !== 0 && (primitive.reload_s < 60 || primitive.reload_s > 86400)) {
          fail(`${itemPath}/reload_s`, "must be 0 (no reload) or 60 to 86400 seconds");
        }
        // The schema bounds the list to 1 through 64 strings; the entry grammar is the rule it cannot state.
        if (Object.hasOwn(primitive, "navigation_allowlist")) {
          const list = primitive.navigation_allowlist, listPath = `${itemPath}/navigation_allowlist`;
          if (!Array.isArray(list)) fail(listPath, "must be an array of 1 to 64 strings");
          else if (list.length === 0) fail(listPath, "must not be empty: omit it for no restriction");
          else if (list.length > 64) fail(listPath, "must have at most 64 entries");
          else {
            for (const [entryIndex, entry] of list.entries()) {
              const issue = typeof entry === "string" ? navigationEntryIssue(entry) : "must be a string";
              if (issue !== undefined) fail(`${listPath}/${entryIndex}`, issue);
            }
          }
        }
      }
      if (primitive.primitive === "application") {
        const release = typeof primitive.release_id === "string" ? primitive.release_id : undefined;
        const params = Object.hasOwn(primitive, "params") ? launchParams(primitive.params, `${itemPath}/params`, fail) : undefined;
        if (release !== undefined && release !== "") {
          // The launch route is keyed by release, so every primitive that pins it carries the same params.
          // An empty object is no params, as on the server.
          const canonical = params === undefined || Object.keys(params).length === 0 ? undefined : JSON.stringify(Object.keys(params).sort().map(name => [name, params[name]]));
          if (releaseParams.has(release) && releaseParams.get(release) !== canonical) {
            fail(`${itemPath}/params`, "must match the params of the other primitive that pins this release: the launch route is keyed by release, so a release launches with one set of params");
          }
          releaseParams.set(release, canonical);
        }
      }
      if (primitive.primitive === "stream") {
        streams++;
        if (mode !== "duration") fail(`${itemPath}`, "streams require duration advance");
        const protocols = new Set<unknown>();
        for (const [sourceIndex, rawSource] of array(primitive.sources).entries()) {
          const source = object(rawSource), sourcePath = `${itemPath}/sources/${sourceIndex}`;
          const protocol = Object.hasOwn(source, "protocol") ? source.protocol : impliedStreamProtocol(source.url);
          if (protocols.has(protocol)) fail(sourcePath, "source protocols must be unique");
          protocols.add(protocol);
          if (protocol === "udp-mpegts" && (typeof source.group !== "string" || !/^239\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/.test(source.group) || source.group.split(".").some(part => Number(part) > 255))) fail(`${sourcePath}/group`, "must be an IPv4 multicast address in 239.0.0.0/8");
          if (protocol === "hls") {
            if (!httpsWithoutCredentials(source.url)) fail(`${sourcePath}/url`, "must be a valid HTTPS URL without credentials");
          }
          if (protocol === "rtsp" && !signageUrl(source.url, ["rtsp:", "rtsps:"])) fail(`${sourcePath}/url`, "must be an rtsp or rtsps URL");
        }
      }
      if (primitive.controller === true) {
        controllers++;
        if (primitive.primitive !== "application" || mode !== "application") fail(`${itemPath}/controller`, "is valid only on an application in application advance mode");
      }
      if (primitive.primitive === "application" && typeof primitive.release_id === "string" && !primitive.release_id) fail(`${itemPath}/release_id`, "is required");
      const named = Object.hasOwn(primitive, "displays") ? readDisplays(primitive.displays) : undefined;
      if (Object.hasOwn(primitive, "displays") && Array.isArray(primitive.displays)) {
        if (named === undefined) fail(`${itemPath}/displays`, DISPLAYS_REASON);
        else if (format === undefined) fail(`${itemPath}/displays`, "needs a playlist format");
        else if (Math.max(...named) > format.displays) fail(`${itemPath}/displays`, `must name displays 1 through ${format.displays}, the displays of the playlist format`);
        else if (!fillsRectangle(format, named)) fail(`${itemPath}/displays`, DISPLAYS_REASON);
        else if (primitive.primitive !== "card" && typeof object(primitive.rect).x === "number") {
          const rect = object(primitive.rect), want = frameRect(format, named);
          if (!sameNumber(rect.x, want.x) || !sameNumber(rect.y, want.y) || !sameNumber(rect.width, want.width) || !sameNumber(rect.height, want.height)) {
            fail(`${itemPath}/rect`, `is derived from displays on this format; omit it or send x ${want.x}, y ${want.y}, width ${want.width}, height ${want.height}`);
          }
        }
      }
      if (primitive.primitive !== "card" && !Object.hasOwn(primitive, "rect") && !Object.hasOwn(primitive, "displays")) {
        fail(`${itemPath}/rect`, "is required unless displays is set");
      }
      if (primitive.primitive === "card") {
        const frame: Frame = named ?? Array.from({ length: format?.displays ?? 1 }, (_, index) => index + 1);
        // Placement shape. The card's tier, the strip edges (a header takes the top edge's normal strip slot and a footer the
        // bottom edge's; a strip's presence is server knowledge) and the derived rect and layer stay server checks.
        const layout = primitive.layout;
        const anchors = layout === "corner" || layout === "chip" ? CORNERS : layout === "strip" ? EDGES : [];
        if (typeof layout !== "string" || !LAYOUTS.includes(layout)) fail(`${itemPath}/layout`, `is required and must be one of ${LAYOUTS.join(", ")}`);
        else if (anchors.length === 0 && Object.hasOwn(primitive, "anchor")) fail(`${itemPath}/anchor`, `is not allowed for layout ${layout}`);
        else if (anchors.length > 0 && !anchors.includes(primitive.anchor as string)) fail(`${itemPath}/anchor`, `is required for layout ${layout} and must be one of ${anchors.join(", ")}`);
        if (layout === "free") {
          if (Object.hasOwn(primitive, "displays")) fail(`${itemPath}/displays`, "is not allowed for layout free");
          if (!Object.hasOwn(primitive, "rect")) fail(`${itemPath}/rect`, "is required for layout free");
          if (!Object.hasOwn(primitive, "layer")) fail(`${itemPath}/layer`, "is required for layout free");
        }
        if (layout === "full" || layout === "center" || layout === "wide") {
          if (takes(mainCards, frame)) fail(`${itemPath}/layout`, "a page holds one full, center or wide card");
          mainCards.push(frame);
        }
        if (layout === "header" || layout === "footer") {
          if (takes(bars.get(layout), frame)) fail(`${itemPath}/layout`, `a page holds one ${layout} card`);
          bars.set(layout, [...bars.get(layout) ?? [], frame]);
        }
        if (layout === "corner" || layout === "chip") {
          if (takes(corners.get(primitive.anchor), frame)) fail(`${itemPath}/anchor`, "a page holds one corner or chip card per corner");
          corners.set(primitive.anchor, [...corners.get(primitive.anchor) ?? [], frame]);
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
        if (mediaSelector.order === "weighted") {
          if (mediaSelector.weights === undefined) fail(`${itemPath}/selector/weights`, "is required with order weighted");
          if (mediaSelector.one_at_a_time !== true && mediaSelector.batch_size !== 1) fail(`${itemPath}/selector/order`, "weighted plays one item per visit: set one_at_a_time or batch_size 1");
        } else if (mediaSelector.weights !== undefined) fail(`${itemPath}/selector/weights`, "is allowed only with order weighted");
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
