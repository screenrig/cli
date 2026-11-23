// The platform-neutral half of `app pack`: the path rules, inline style and
// script hoisting, runtime injection, archive limits and the ustar writer. It
// imports nothing and uses only what Node and browsers both have (Uint8Array,
// TextEncoder, TextDecoder, crypto.subtle), so the dashboard vendors this file
// (its contracts.toml) and prepares a web app in the browser exactly as the CLI
// does. Node-only work (the directory walk, gzip, CLI problems) stays beside it.

export interface ArchiveLimits {
  application_archive_bytes: number;
  application_expanded_bytes: number;
  application_file_count: number;
  application_file_bytes: number;
  application_path_depth: number;
  application_path_bytes: number;
}

/** What the server takes when the capabilities document names nothing else. */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  application_archive_bytes: 100 * 1024 * 1024,
  application_expanded_bytes: 250 * 1024 * 1024,
  application_file_count: 5000,
  application_file_bytes: 32 * 1024 * 1024,
  application_path_depth: 16,
  application_path_bytes: 255,
};

export interface ArchiveEntry {
  path: string;
  type: "file" | "directory";
  data?: Uint8Array;
  size: number;
}

/** A refusal with the CLI's problem code; the CLI wraps it as a CliError. */
export class ReleaseRuleError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(detail);
    this.name = "ReleaseRuleError";
  }
}

function refuse(code: string, detail: string): never {
  throw new ReleaseRuleError(code, detail);
}

const encoder = new TextEncoder();
// ignoreBOM keeps a leading byte-order mark, as Buffer#toString does.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/** Orders by UTF-8 bytes, as Buffer.compare of the encoded strings does. */
export function compareUtf8(a: string, b: string): number {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

// --- Paths ------------------------------------------------------------------

export function posixNormalize(relativePath: string): string {
  const replaced = relativePath.replaceAll("\\", "/").normalize("NFC");
  const parts: string[] = [];
  for (const part of replaced.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function caseFold(relativePath: string): string {
  return posixNormalize(relativePath).toLocaleLowerCase("en-US");
}

export function hasTraversal(relativePath: string): boolean {
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
    return true;
  }
  return relativePath.split(/[/\\]/).some((part) => part === "..");
}

export function pathDepth(relativePath: string): number {
  const normalized = posixNormalize(relativePath);
  if (!normalized) {
    return 0;
  }
  return normalized.split("/").length;
}

export function hasIllegalChars(relativePath: string): boolean {
  if (relativePath.includes("\0")) {
    return true;
  }
  return /[\u0000-\u001f\u007f]/.test(relativePath);
}

/**
 * gitignore-inspired matcher for `.screenrigignore`.
 * Built-in rules are applied separately and cannot be negated.
 */
export function compileIgnore(patterns: string[]): (posixPath: string, isDir: boolean) => boolean {
  const rules = patterns
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      const raw = negated ? line.slice(1) : line;
      const directoryOnly = raw.endsWith("/");
      const pattern = directoryOnly ? raw.slice(0, -1) : raw;
      return { negated, directoryOnly, regex: globToRegExp(pattern) };
    });

  return (posixPath: string, isDir: boolean): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.directoryOnly && !isDir) {
        continue;
      }
      if (rule.regex.test(posixPath) || rule.regex.test(posixPath.split("/").pop() ?? "")) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  };
}

function globToRegExp(pattern: string): RegExp {
  const anchored = pattern.startsWith("/");
  const body = anchored ? pattern.slice(1) : pattern;
  let regex = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "*" && body[i + 1] === "*") {
      if (body[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 2;
      } else {
        regex += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      regex += "[^/]*";
      continue;
    }
    if (ch === "?") {
      regex += "[^/]";
      continue;
    }
    if (ch && "\\^$+{}[]()|.".includes(ch)) {
      regex += `\\${ch}`;
      continue;
    }
    regex += ch ?? "";
  }
  const source = anchored ? `^${regex}(?:/.*)?$` : `(^|/)${regex}(?:/.*)?$`;
  return new RegExp(source);
}

export const BUILTIN_IGNORE_PATTERNS = [
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "vendor/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".tox/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".eggs/",
  ".idea/",
  ".vscode/",
  ".vs/",
  ".yarn/",
  ".git/",
  ".svn/",
  ".hg/",
  ".bzr/",
  "CVS/",
  "*.map",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.crt",
  "*.cer",
  // SSH private keys: id_ followed by the key type.
  ...["rsa", "dsa", "ecdsa", "ed25519"].map((type) => `id_${type}`),
  "credentials.json",
  "secrets.json",
  "*.swp",
  "*.swo",
  "*~",
  "Thumbs.db",
  "desktop.ini",
];

const builtinMatcher = compileIgnore(BUILTIN_IGNORE_PATTERNS);

export function isDotComponentPath(posixPath: string): boolean {
  return posixNormalize(posixPath)
    .split("/")
    .some((part) => part.startsWith("."));
}

export function isBuiltinIgnored(posixPath: string, isDir: boolean): boolean {
  if (isDotComponentPath(posixPath)) {
    return true;
  }
  return builtinMatcher(posixPath, isDir);
}

/**
 * Admits one normalized path of the application: refuses traversal, control
 * characters, an over-long or over-deep path and a duplicate (exact or
 * case-folded), and answers false for a path the built-in or the extra ignore
 * rules leave out. `seen` carries the admitted paths across calls.
 */
export function admitPath(
  posixPath: string,
  isDir: boolean,
  limits: ArchiveLimits,
  seen: { normalized: Set<string>; folded: Set<string> },
  extraIgnore: (posixPath: string, isDir: boolean) => boolean = () => false,
): boolean {
  if (hasTraversal(posixPath) || posixPath.startsWith("/") || hasIllegalChars(posixPath)) {
    refuse("path_traversal", `Rejected path ${posixPath}`);
  }
  if (utf8Bytes(posixPath) > limits.application_path_bytes) {
    refuse("path_too_long", `Path exceeds ${limits.application_path_bytes} bytes: ${posixPath}`);
  }
  if (pathDepth(posixPath) > limits.application_path_depth) {
    refuse("path_too_deep", `Path exceeds depth ${limits.application_path_depth}: ${posixPath}`);
  }
  if (isBuiltinIgnored(posixPath, isDir) || extraIgnore(posixPath, isDir)) {
    return false;
  }
  if (seen.normalized.has(posixPath)) {
    refuse("duplicate_path", `Duplicate normalized path: ${posixPath}`);
  }
  const folded = caseFold(posixPath);
  if (seen.folded.has(folded)) {
    refuse("duplicate_path", `Duplicate case-folded path: ${posixPath}`);
  }
  seen.normalized.add(posixPath);
  seen.folded.add(folded);
  return true;
}

// --- Inline hoisting ----------------------------------------------------------

// Hoist HTML styles and executable inline scripts into deterministic external
// files. SVG styles keep their namespace and authored bytes: an HTML <link>
// inserted there is an SVG element, not a stylesheet, and can swallow following
// shapes. The release Content-Security-Policy permits these inline styles.
// Inline event handlers and `javascript:` URLs cannot be hoisted safely and are
// refused at pack time.
const HOIST_PREFIX = "_screenrig-inline-";
const HTML_PATH = /\.html?$/i;
const RAW_TEXT_ELEMENTS: Readonly<Record<string, true>> = { style: true, script: true, textarea: true, title: true };
const HTML_VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const SVG_HTML_INTEGRATION_POINTS = new Set(["foreignobject", "desc", "title"]);
const EXECUTABLE_SCRIPT_TYPES: Readonly<Record<string, true>> = {
  "": true,
  "application/ecmascript": true,
  "application/javascript": true,
  "module": true,
  "text/ecmascript": true,
  "text/javascript": true,
};
const URL_ATTRIBUTES: Readonly<Record<string, true>> = {
  href: true,
  src: true,
  "xlink:href": true,
  action: true,
  formaction: true,
};
const SCRIPT_ATTRIBUTES_DROPPED = new Set(["src", "async", "defer"]);

interface ScannedAttribute {
  name: string;
  value?: string;
  /** Offset of the attribute name within the HTML document. */
  offset: number;
  /** Offset just past the authored attribute, including its value and quotes. */
  end: number;
}

interface ScannedTag {
  name: string;
  /** Offset of the opening `<`. */
  start: number;
  /** Offset just past the closing `>`. */
  end: number;
  attributes: ScannedAttribute[];
  selfClosing: boolean;
}

interface OpenElement {
  name: string;
  namespace: "html" | "svg";
}

interface HoistedAsset {
  assetPath: string;
  content: string;
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

function lineAt(html: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < html.length; index += 1) {
    if (html[index] === "\n") line += 1;
  }
  return line;
}

function scanTag(html: string, start: number): ScannedTag | null {
  const nameMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(start));
  if (!nameMatch) return null;
  const name = nameMatch[1]!.toLowerCase();
  const attributes: ScannedAttribute[] = [];
  let selfClosing = false;
  let index = start + nameMatch[0].length;
  while (index < html.length) {
    while (index < html.length && isSpace(html[index])) index += 1;
    if (index >= html.length) break;
    if (html[index] === ">") {
      index += 1;
      break;
    }
    if (html[index] === "/" && html[index + 1] === ">") {
      selfClosing = true;
      index += 2;
      break;
    }
    const attributeStart = index;
    while (index < html.length && !isSpace(html[index]) && html[index] !== "=" && html[index] !== ">" && html[index] !== "/") {
      index += 1;
    }
    const attributeName = html.slice(attributeStart, index);
    if (attributeName === "") {
      index += 1;
      continue;
    }
    while (index < html.length && isSpace(html[index])) index += 1;
    let value: string | undefined;
    if (html[index] === "=") {
      index += 1;
      while (index < html.length && isSpace(html[index])) index += 1;
      const quote = html[index];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, index + 1);
        if (close < 0) {
          value = html.slice(index + 1);
          index = html.length;
        } else {
          value = html.slice(index + 1, close);
          index = close + 1;
        }
      } else {
        const valueStart = index;
        while (index < html.length && !isSpace(html[index]) && html[index] !== ">") index += 1;
        value = html.slice(valueStart, index);
      }
    }
    const end = value === undefined ? attributeStart + attributeName.length : index;
    attributes.push({ name: attributeName.toLowerCase(), value, offset: attributeStart, end });
  }
  return { name, start, end: Math.min(index, html.length), attributes, selfClosing };
}

function attributeValue(tag: ScannedTag, name: string): string | undefined {
  return tag.attributes.find((attribute) => attribute.name === name)?.value;
}

function scriptTypeName(value: string | undefined): string {
  if (value === undefined) return "";
  return value.split(";")[0]!.trim().toLowerCase();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(colon|tab|newline);/gi, (_match, name: string) => ({ colon: ":", tab: "\t", newline: "\n" })[name.toLowerCase()] ?? "");
}

function serializeAttributes(html: string, tag: ScannedTag, dropped: Set<string> = new Set()): string {
  let out = "";
  for (const attribute of tag.attributes) {
    if (dropped.has(attribute.name)) continue;
    // Keep the original attribute context: the browser decodes references once.
    // Re-escaping the scanned source changes values such as R&amp;D to R&amp;amp;D.
    out += ` ${html.slice(attribute.offset, attribute.end)}`;
  }
  return out;
}

function rejectUnsafeAttributes(path: string, html: string, tag: ScannedTag): void {
  for (const attribute of tag.attributes) {
    const line = lineAt(html, attribute.offset);
    if (/^on[a-z]+$/.test(attribute.name)) {
      refuse(
        "inline_event_handler",
        `${path}:${line}: inline event handler attribute '${attribute.name}' cannot be hoisted; the release host blocks inline script. Move the handler into an external script.`,
      );
    }
    if (attribute.value !== undefined && URL_ATTRIBUTES[attribute.name] === true) {
      const normalized = decodeEntities(attribute.value).replace(/[\u0000- ]/g, "").toLowerCase();
      if (normalized.startsWith("javascript:")) {
        refuse(
          "javascript_url",
          `${path}:${line}: '${attribute.name}' uses a javascript: URL, which the release host blocks. Use an external script and an event listener instead.`,
        );
      }
    }
  }
}

function findRawClose(html: string, from: number, name: string): { index: number; end: number } | null {
  const pattern = new RegExp(`</${name}\\s*>`, "gi");
  pattern.lastIndex = from;
  const match = pattern.exec(html);
  if (!match) return null;
  return { index: match.index, end: match.index + match[0].length };
}

function findCommentEnd(html: string, from: number): number {
  const close = html.indexOf("-->", from);
  return close < 0 ? html.length : close + 3;
}

async function emitAsset(generated: Map<string, ArchiveEntry>, existing: Set<string>, path: string, extension: "css" | "js", content: string): Promise<string> {
  const hash = (await sha256Hex(content)).slice(0, 32);
  const filename = `${HOIST_PREFIX}${hash}.${extension}`;
  // CSS URLs and module imports resolve from the external file's directory.
  // Keep it beside the document so authored references retain their base,
  // including dynamic imports and URL expressions we cannot rewrite statically.
  // The directory also scopes deduplication: identical modules in different
  // directories can import different dependencies.
  const assetPath = `${path.slice(0, path.lastIndexOf("/") + 1)}${filename}`;
  if (existing.has(assetPath)) {
    refuse("inline_asset_conflict", `${path} inline ${extension} hoists onto the reserved asset ${assetPath}; rename or remove that file.`);
  }
  if (!generated.has(assetPath)) {
    const data = encoder.encode(content);
    generated.set(assetPath, { path: assetPath, type: "file", data, size: data.length });
  }
  return `./${filename}`;
}

async function transformHtml(path: string, html: string, generated: Map<string, ArchiveEntry>, existing: Set<string>): Promise<string> {
  const elements: OpenElement[] = [];
  let out = "";
  let cursor = 0;
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) break;
    const next = html[open + 1];
    if (next === undefined) break;
    if (next === "!") {
      index = html.startsWith("<!--", open) ? findCommentEnd(html, open + 4) : open + 1;
      continue;
    }
    if (next === "/") {
      const close = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)\s*>/.exec(html.slice(open));
      if (close) {
        const name = close[1]!.toLowerCase();
        for (let depth = elements.length - 1; depth >= 0; depth -= 1) {
          if (elements[depth]!.name === name) {
            elements.length = depth;
            break;
          }
        }
        index = open + close[0].length;
      } else {
        index = open + 1;
      }
      continue;
    }
    if (next === "?") {
      index = open + 1;
      continue;
    }
    const tag = scanTag(html, open);
    if (!tag) {
      index = open + 1;
      continue;
    }
    rejectUnsafeAttributes(path, html, tag);
    const parent = elements.at(-1);
    const namespace = tag.name === "svg" || (parent?.namespace === "svg" && !SVG_HTML_INTEGRATION_POINTS.has(parent.name)) ? "svg" : "html";
    // In foreign content, the slash closes an element. HTML ignores it except
    // on void elements. SVG title/desc/foreignObject contain HTML children.
    const selfClosing = namespace === "svg" && tag.selfClosing;
    if (!selfClosing && RAW_TEXT_ELEMENTS[tag.name] === true && (namespace === "html" || tag.name === "style" || tag.name === "script")) {
      const close = findRawClose(html, tag.end, tag.name);
      if (!close) {
        refuse("inline_unterminated", `${path}:${lineAt(html, tag.start)}: unterminated <${tag.name}> element.`);
      }
      if (tag.name === "style" && namespace === "html") {
        out += html.slice(cursor, tag.start);
        const href = await emitAsset(generated, existing, path, "css", html.slice(tag.end, close.index));
        out += `<link rel="stylesheet" href="${href}"${serializeAttributes(html, tag)}>`;
        cursor = close.end;
      } else if (tag.name === "script" && attributeValue(tag, "src") === undefined && EXECUTABLE_SCRIPT_TYPES[scriptTypeName(attributeValue(tag, "type"))] === true) {
        out += html.slice(cursor, tag.start);
        const href = await emitAsset(generated, existing, path, "js", html.slice(tag.end, close.index));
        out += `<script${serializeAttributes(html, tag, SCRIPT_ATTRIBUTES_DROPPED)} src="${href}"></script>`;
        cursor = close.end;
      }
      index = close.end;
      continue;
    }
    if (!selfClosing && !(namespace === "html" && HTML_VOID_ELEMENTS.has(tag.name))) {
      elements.push({ name: tag.name, namespace });
    }
    index = tag.end;
  }
  if (cursor < html.length) out += html.slice(cursor);
  if (out === "") return html;
  return out;
}

/**
 * Hoists HTML styles and executable inline scripts from every HTML entry into
 * deterministic files beside each document, preserving relative resource and
 * module paths. SVG styles stay in their
 * original namespace under the release Content-Security-Policy. Inline event
 * handlers and `javascript:` URLs are refused with the file and line.
 */
export async function hoistInlineAssets(entries: ArchiveEntry[]): Promise<ArchiveEntry[]> {
  const existing = new Set(entries.map((entry) => entry.path));
  const generated = new Map<string, ArchiveEntry>();
  const rewritten: ArchiveEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.data || !HTML_PATH.test(entry.path)) {
      rewritten.push(entry);
      continue;
    }
    const html = decoder.decode(entry.data);
    const transformed = await transformHtml(entry.path, html, generated, existing);
    if (transformed === html) {
      rewritten.push(entry);
      continue;
    }
    const data = encoder.encode(transformed);
    rewritten.push({ ...entry, data, size: data.length });
  }
  return [...rewritten, ...generated.values()];
}

// --- Runtime injection ---------------------------------------------------------

export const SDK_PROTOCOL_VERSION = "1";
export const SDK_RUNTIME_PATH = "_screenrig/runtime.js";
export const SDK_MARKER = `data-screenrig-sdk="${SDK_PROTOCOL_VERSION}"`;
// This bootstrap must execute before any customer classic or module script.
// `defer` does not provide a cross-kind ordering guarantee with module scripts.
export const SDK_SCRIPT_TAG = `<script src="./${SDK_RUNTIME_PATH}" ${SDK_MARKER}></script>`;

function markerAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function injectSdkTag(html: string): string {
  const rawMarkers = html.match(/data-screenrig-sdk/gi) ?? [];
  const markedScripts = [...html.matchAll(/<script\b[^>]*data-screenrig-sdk[^>]*>\s*<\/script\s*>/gi)];
  if (rawMarkers.length !== markedScripts.length) {
    refuse("sdk_marker_invalid", "data-screenrig-sdk must appear only on a complete script element");
  }
  if (markedScripts.length > 1) {
    refuse("sdk_marker_duplicate", "index.html contains more than one ScreenRig SDK marker");
  }
  if (markedScripts.length === 1) {
    const tag = markedScripts[0]?.[0] ?? "";
    const version = markerAttribute(tag, "data-screenrig-sdk");
    const source = markerAttribute(tag, "src")?.replace(/^\.\//, "");
    if (version !== SDK_PROTOCOL_VERSION || source !== SDK_RUNTIME_PATH || /\b(?:async|defer)\b/i.test(tag)) {
      refuse("sdk_marker_incompatible", "Existing ScreenRig SDK marker has an incompatible version, source, or loading mode");
    }
    return html;
  }
  // Keep the prologue and inert head metadata (including charset, CSP and base)
  // ahead of the runtime, then stop before any script or body content. Matching
  // whole comments, quoted attributes and raw-text elements avoids fake tags.
  // This also leaves the DOCTYPE first when the document omits <head>.
  const tagEnd = `(?:[^"'<>]|"[^"]*"|'[^']*')*>`;
  const prefix = new RegExp(
    `(?:\\s+|<!--[\\s\\S]*?-->|<!doctype\\b${tagEnd}`
      + `|<(?:html|head|meta|base|link)(?=[\\s/>])${tagEnd}`
      + `|<(title|style|noscript)(?=[\\s/>])${tagEnd}[\\s\\S]*?<\\/\\1\\s*>)`,
    "iy",
  );
  let offset = 0;
  while (prefix.exec(html)) offset = prefix.lastIndex;
  return `${html.slice(0, offset)}${SDK_SCRIPT_TAG}\n${html.slice(offset)}`;
}

/**
 * Adds the pinned browser runtime at SDK_RUNTIME_PATH and its script tag to
 * index.html, ahead of every customer script.
 */
export async function injectRuntime(entries: ArchiveEntry[], runtime: Uint8Array): Promise<{ entries: ArchiveEntry[]; asset_sha256: string }> {
  if (entries.some((entry) => entry.path.toLocaleLowerCase("en-US") === SDK_RUNTIME_PATH.toLocaleLowerCase("en-US"))) {
    refuse("sdk_path_collision", `${SDK_RUNTIME_PATH} is reserved for ScreenRig archive injection`);
  }
  const index = entries.findIndex((entry) => entry.path === "index.html" && entry.type === "file");
  if (index < 0) {
    refuse("missing_index", "Application root must contain index.html");
  }
  const cloned = entries.map((entry) => ({ ...entry, data: entry.data ? entry.data.slice() : undefined }));
  const indexEntry = cloned[index];
  if (!indexEntry?.data) {
    refuse("missing_index", "index.html has no readable contents");
  }
  const nextHtml = encoder.encode(injectSdkTag(decoder.decode(indexEntry.data)));
  cloned[index] = { ...indexEntry, data: nextHtml, size: nextHtml.length };
  cloned.push({ path: SDK_RUNTIME_PATH, type: "file", data: runtime.slice(), size: runtime.length });
  return { entries: cloned, asset_sha256: await sha256Hex(runtime) };
}

// --- Release -----------------------------------------------------------------

export interface ReleaseSummary {
  /** Every file and directory of the release, sorted by UTF-8 path bytes. */
  entries: ArchiveEntry[];
  file_count: number;
  expanded_bytes: number;
}

/** Sorts a prepared release and holds it to the archive's file and size limits. */
export function finishRelease(entries: ArchiveEntry[], limits: ArchiveLimits): ReleaseSummary {
  const sorted = entries.slice().sort((a, b) => compareUtf8(a.path, b.path));
  const files = sorted.filter((entry) => entry.type === "file");
  const expandedBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  if (files.length > limits.application_file_count) {
    refuse("too_many_files", `Archive contains ${files.length} files; limit is ${limits.application_file_count}`);
  }
  if (expandedBytes > limits.application_expanded_bytes) {
    refuse("expanded_too_large", `Expanded archive ${expandedBytes} exceeds ${limits.application_expanded_bytes}`);
  }
  return { entries: sorted, file_count: files.length, expanded_bytes: expandedBytes };
}

// --- Tar ---------------------------------------------------------------------

const BLOCK = 512;
const USTAR_MAGIC = "ustar\0";
const USTAR_VERSION = "00";

function putString(buf: Uint8Array, offset: number, length: number, value: string): void {
  buf.fill(0, offset, offset + length);
  if (value.length > length) {
    refuse("path_too_long", `USTAR field overflow: ${value}`);
  }
  buf.set(encoder.encode(value).subarray(0, buf.length - offset), offset);
}

function putOctal(buf: Uint8Array, offset: number, length: number, value: number): void {
  const oct = value.toString(8).padStart(length - 1, "0");
  buf.fill(0, offset, offset + length);
  buf.set(encoder.encode(oct).subarray(0, length - 1), offset);
}

function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += header[i] ?? 0;
  }
  return sum;
}

function splitName(posixPath: string): { name: string; prefix: string } {
  if (utf8Bytes(posixPath) <= 100) {
    return { name: posixPath, prefix: "" };
  }
  const parts = posixPath.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (utf8Bytes(prefix) <= 155 && utf8Bytes(name) <= 100) {
      return { name, prefix };
    }
  }
  refuse("path_too_long", `Path cannot be encoded in ustar: ${posixPath}`);
}

function headerFor(entry: ArchiveEntry): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const split = splitName(entry.path);
  putString(header, 0, 100, split.name);
  putOctal(header, 100, 8, entry.type === "directory" ? 0o755 : 0o644);
  putOctal(header, 108, 8, 0);
  putOctal(header, 116, 8, 0);
  putOctal(header, 124, 12, entry.type === "file" ? entry.size : 0);
  putOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory" ? 0x35 : 0x30;
  putString(header, 257, 6, USTAR_MAGIC);
  putString(header, 263, 2, USTAR_VERSION);
  putString(header, 265, 32, "");
  putString(header, 297, 32, "");
  putOctal(header, 329, 8, 0);
  putOctal(header, 337, 8, 0);
  putString(header, 345, 155, split.prefix);
  const sum = checksum(header);
  header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return header;
}

function padToBlock(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

/** Writes the release as an uncompressed ustar archive. */
export function writeTar(entries: ArchiveEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const entry of entries) {
    const header = headerFor(entry);
    chunks.push(header);
    total += header.length;
    if (entry.type === "file") {
      const data = entry.data ?? new Uint8Array(0);
      chunks.push(data);
      total += data.length + padToBlock(data.length);
      if (padToBlock(data.length) > 0) chunks.push(new Uint8Array(padToBlock(data.length)));
    }
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  total += BLOCK * 2;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
