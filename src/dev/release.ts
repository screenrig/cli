import { createHash } from "node:crypto";
import { CliError } from "../problems.js";
import { releaseEntries } from "../pack/index.js";
import type { PackOptions } from "../pack/types.js";

export interface ServedFile {
  path: string;
  data: Buffer;
  type: string;
  etag: string;
}

export interface DevRelease {
  /** Increases with every successful build. */
  revision: number;
  files: Map<string, ServedFile>;
  file_count: number;
  expanded_bytes: number;
  sdk_sha256?: string;
  built_at: string;
}

/** What `app pack` would refuse, with the file and line when the refusal names them. */
export interface Refusal {
  code: string;
  detail: string;
  file?: string;
  line?: number;
}

export type BuildResult = { ok: true; release: DevRelease } | { ok: false; refusal: Refusal };

const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8", svg: "image/svg+xml", webmanifest: "application/manifest+json",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  wasm: "application/wasm", pdf: "application/pdf",
};

export function contentTypeOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return (dot < 0 ? undefined : TYPES[file.slice(dot + 1).toLowerCase()]) ?? "application/octet-stream";
}

/** `path:line: message` is how the packer names a refusal's location. */
function located(detail: string): Pick<Refusal, "file" | "line"> {
  const match = /^([^\n:]+):(\d+): /.exec(detail);
  return match ? { file: match[1]!, line: Number(match[2]) } : {};
}

export function refusalOf(error: unknown): Refusal {
  if (error instanceof CliError) return { code: error.problem.code, detail: error.problem.detail, ...located(error.problem.detail) };
  const detail = error instanceof Error ? error.message : String(error);
  return { code: "unreadable", detail };
}

/**
 * Builds the release `app pack` would build from `directory`, in memory: the
 * same walk, inline-asset hoisting and runtime injection (`releaseEntries`),
 * and the same refusals.
 */
export async function buildDevRelease(directory: string, revision: number, options: Pick<PackOptions, "injector" | "limits"> = {}): Promise<BuildResult> {
  try {
    const built = await releaseEntries(directory, options);
    const files = new Map<string, ServedFile>();
    for (const entry of built.entries) {
      if (entry.type !== "file" || !entry.data) continue;
      files.set(entry.path, {
        path: entry.path, data: entry.data, type: contentTypeOf(entry.path),
        etag: `"${createHash("sha256").update(entry.data).digest("hex").slice(0, 32)}"`,
      });
    }
    return { ok: true, release: { revision, files, file_count: built.file_count, expanded_bytes: built.expanded_bytes, sdk_sha256: built.sdk_injection.asset_sha256, built_at: new Date().toISOString() } };
  } catch (error) {
    return { ok: false, refusal: refusalOf(error) };
  }
}

/** The file a request path names in a release: `/` and a directory path serve its index.html. */
export function lookupFile(release: DevRelease, requestPath: string): ServedFile | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const parts = decoded.split("/").filter((part) => part !== "");
  if (parts.some((part) => part === "." || part === "..")) return undefined;
  const joined = parts.join("/");
  if (joined !== "" && !decoded.endsWith("/")) {
    const direct = release.files.get(joined);
    if (direct) return direct;
  }
  return release.files.get(joined === "" ? "index.html" : `${joined}/index.html`);
}
