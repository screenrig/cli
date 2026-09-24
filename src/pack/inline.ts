import { createHash } from "node:crypto";
import { packError } from "./limits.js";
import type { ArchiveEntry } from "./types.js";

// The release host serves applications under `script-src 'self'; style-src
// 'self'`, so inline `<style>` and executable inline `<script>` are dropped by
// the browser with no error. The packer hoists them into deterministic external
// files inside the archive and rewrites the tags, so a one-file static app
// renders as authored. Inline event handlers and `javascript:` URLs cannot be
// hoisted safely and are refused at pack time.
const HOIST_DIRECTORY = "_screenrig/inline";
const HTML_PATH = /\.html?$/i;
const RAW_TEXT_ELEMENTS: Readonly<Record<string, true>> = { style: true, script: true, textarea: true, title: true };
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
}

interface ScannedTag {
  name: string;
  /** Offset of the opening `<`. */
  start: number;
  /** Offset just past the closing `>`. */
  end: number;
  attributes: ScannedAttribute[];
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
  let index = start + nameMatch[0].length;
  while (index < html.length) {
    while (index < html.length && isSpace(html[index])) index += 1;
    if (index >= html.length) break;
    if (html[index] === ">") {
      index += 1;
      break;
    }
    if (html[index] === "/" && html[index + 1] === ">") {
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
    attributes.push({ name: attributeName.toLowerCase(), value, offset: attributeStart });
  }
  return { name, start, end: Math.min(index, html.length), attributes };
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

function serializeAttributes(tag: ScannedTag, dropped: Set<string> = new Set()): string {
  let out = "";
  for (const attribute of tag.attributes) {
    if (dropped.has(attribute.name)) continue;
    out += attribute.value === undefined ? ` ${attribute.name}` : ` ${attribute.name}="${attribute.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`;
  }
  return out;
}

function rejectUnsafeAttributes(path: string, html: string, tag: ScannedTag): void {
  for (const attribute of tag.attributes) {
    const line = lineAt(html, attribute.offset);
    if (/^on[a-z]+$/.test(attribute.name)) {
      throw packError(
        "inline_event_handler",
        `${path}:${line}: inline event handler attribute '${attribute.name}' cannot be hoisted; the release host blocks inline script. Move the handler into an external script.`,
      );
    }
    if (attribute.value !== undefined && URL_ATTRIBUTES[attribute.name] === true) {
      const normalized = decodeEntities(attribute.value).replace(/[\u0000-\u0020]/g, "").toLowerCase();
      if (normalized.startsWith("javascript:")) {
        throw packError(
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

function emitAsset(generated: Map<string, ArchiveEntry>, existing: Set<string>, path: string, extension: "css" | "js", content: string): string {
  const hash = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32);
  const assetPath = `${HOIST_DIRECTORY}/${hash}.${extension}`;
  if (existing.has(assetPath)) {
    throw packError("inline_asset_conflict", `${path} inline ${extension} hoists onto the reserved asset ${assetPath}; rename or remove that file.`);
  }
  if (!generated.has(assetPath)) {
    const data = Buffer.from(content, "utf8");
    generated.set(assetPath, { path: assetPath, type: "file", data, size: data.length });
  }
  // Reference the asset relative to the HTML document so nested pages resolve
  // it too; `./` matches the SDK runtime tag the injector writes.
  const depth = path.split("/").length - 1;
  return `${depth === 0 ? "./" : "../".repeat(depth)}${assetPath}`;
}

function transformHtml(path: string, html: string, generated: Map<string, ArchiveEntry>, existing: Set<string>): string {
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
    if (next === "/" || next === "?") {
      index = open + 1;
      continue;
    }
    const tag = scanTag(html, open);
    if (!tag) {
      index = open + 1;
      continue;
    }
    rejectUnsafeAttributes(path, html, tag);
    if (RAW_TEXT_ELEMENTS[tag.name] === true) {
      const close = findRawClose(html, tag.end, tag.name);
      if (!close) {
        throw packError("inline_unterminated", `${path}:${lineAt(html, tag.start)}: unterminated <${tag.name}> element.`);
      }
      if (tag.name === "style") {
        out += html.slice(cursor, tag.start);
        const href = emitAsset(generated, existing, path, "css", html.slice(tag.end, close.index));
        out += `<link rel="stylesheet" href="${href}"${serializeAttributes(tag)}>`;
        cursor = close.end;
      } else if (tag.name === "script" && attributeValue(tag, "src") === undefined && EXECUTABLE_SCRIPT_TYPES[scriptTypeName(attributeValue(tag, "type"))] === true) {
        out += html.slice(cursor, tag.start);
        const href = emitAsset(generated, existing, path, "js", html.slice(tag.end, close.index));
        out += `<script${serializeAttributes(tag, SCRIPT_ATTRIBUTES_DROPPED)} src="${href}"></script>`;
        cursor = close.end;
      }
      index = close.end;
      continue;
    }
    index = tag.end;
  }
  if (cursor < html.length) out += html.slice(cursor);
  if (out === "") return html;
  return out;
}

/**
 * Hoists inline styles and executable inline scripts from every HTML entry into
 * deterministic files under `_screenrig/inline`, rewriting the tags so the
 * application renders under the release Content-Security-Policy. Inline event
 * handlers and `javascript:` URLs are refused with the file and line.
 */
export function hoistInlineAssets(entries: ArchiveEntry[]): ArchiveEntry[] {
  const existing = new Set(entries.map((entry) => entry.path));
  const generated = new Map<string, ArchiveEntry>();
  const rewritten = entries.map((entry) => {
    if (entry.type !== "file" || !entry.data || !HTML_PATH.test(entry.path)) return entry;
    const html = entry.data.toString("utf8");
    const transformed = transformHtml(entry.path, html, generated, existing);
    if (transformed === html) return entry;
    const data = Buffer.from(transformed, "utf8");
    return { ...entry, data, size: data.length };
  });
  return [...rewritten, ...generated.values()];
}
