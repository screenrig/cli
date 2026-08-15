import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packError } from "../pack/limits.js";
import type { ArchiveEntry } from "../pack/types.js";

export const SDK_PROTOCOL_VERSION = "1";
export const SDK_RUNTIME_PATH = "_screenrig/runtime.js";
export const SDK_MARKER = `data-screenrig-sdk="${SDK_PROTOCOL_VERSION}"`;
// This bootstrap must execute before any customer classic or module script.
// `defer` does not provide a cross-kind ordering guarantee with module scripts.
export const SDK_SCRIPT_TAG = `<script src="./${SDK_RUNTIME_PATH}" ${SDK_MARKER}></script>`;

export interface SdkInjectionRequest {
  sdk_version?: string;
  sdk_sha256?: string;
}

export interface SdkInjectionResult {
  entries: ArchiveEntry[];
  injected: boolean;
  reason: string;
  asset_path?: string;
  asset_sha256?: string;
}

export interface SdkInjector {
  inject(entries: ArchiveEntry[], request?: SdkInjectionRequest): Promise<SdkInjectionResult>;
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function injectTag(html: string): string {
  const rawMarkers = html.match(/data-screenrig-sdk/gi) ?? [];
  const markedScripts = [...html.matchAll(/<script\b[^>]*data-screenrig-sdk[^>]*>\s*<\/script\s*>/gi)];
  if (rawMarkers.length !== markedScripts.length) {
    throw packError("sdk_marker_invalid", "data-screenrig-sdk must appear only on a complete script element");
  }
  if (markedScripts.length > 1) {
    throw packError("sdk_marker_duplicate", "index.html contains more than one ScreenRig SDK marker");
  }
  if (markedScripts.length === 1) {
    const tag = markedScripts[0]?.[0] ?? "";
    const version = attribute(tag, "data-screenrig-sdk");
    const source = attribute(tag, "src")?.replace(/^\.\//, "");
    if (version !== SDK_PROTOCOL_VERSION || source !== SDK_RUNTIME_PATH || /\b(?:async|defer)\b/i.test(tag)) {
      throw packError("sdk_marker_incompatible", "Existing ScreenRig SDK marker has an incompatible version, source, or loading mode");
    }
    return html;
  }
  const closeHead = /<\/head\s*>/i.exec(html);
  if (closeHead?.index !== undefined) {
    return `${html.slice(0, closeHead.index)}${SDK_SCRIPT_TAG}\n${html.slice(closeHead.index)}`;
  }
  return `${SDK_SCRIPT_TAG}\n${html}`;
}

export class ArchiveSdkInjector implements SdkInjector {
  constructor(private readonly runtime: Buffer) {}

  async inject(entries: ArchiveEntry[], request: SdkInjectionRequest = {}): Promise<SdkInjectionResult> {
    const version = request.sdk_version ?? SDK_PROTOCOL_VERSION;
    if (version !== SDK_PROTOCOL_VERSION) {
      throw packError("sdk_version_incompatible", `Requested SDK protocol ${version}; this release supports ${SDK_PROTOCOL_VERSION}`);
    }
    if (entries.some((entry) => entry.path.toLocaleLowerCase("en-US") === SDK_RUNTIME_PATH.toLocaleLowerCase("en-US"))) {
      throw packError("sdk_path_collision", `${SDK_RUNTIME_PATH} is reserved for ScreenRig archive injection`);
    }
    const index = entries.findIndex((entry) => entry.path === "index.html" && entry.type === "file");
    if (index < 0) {
      throw packError("missing_index", "Application root must contain index.html");
    }
    const cloned = entries.map((entry) => ({ ...entry, data: entry.data ? Buffer.from(entry.data) : undefined }));
    const indexEntry = cloned[index];
    if (!indexEntry?.data) {
      throw packError("missing_index", "index.html has no readable contents");
    }
    const nextHtml = Buffer.from(injectTag(indexEntry.data.toString("utf8")), "utf8");
    cloned[index] = { ...indexEntry, data: nextHtml, size: nextHtml.length };
    const hash = createHash("sha256").update(this.runtime).digest("hex");
    if (request.sdk_sha256 && request.sdk_sha256 !== hash) {
      throw packError("sdk_hash_mismatch", "Pinned SDK runtime hash does not match the requested compatibility record");
    }
    cloned.push({ path: SDK_RUNTIME_PATH, type: "file", data: Buffer.from(this.runtime), size: this.runtime.length });
    return { entries: cloned, injected: true, reason: "Pinned ScreenRig browser runtime injected into archive only", asset_path: SDK_RUNTIME_PATH, asset_sha256: hash };
  }
}

class ReleaseLocalSdkInjector implements SdkInjector {
  async inject(entries: ArchiveEntry[], request?: SdkInjectionRequest): Promise<SdkInjectionResult> {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const configured = process.env.SCREENRIG_SDK_RUNTIME;
    const runtimePath = configured ? path.resolve(configured) : path.join(packageRoot, "assets", "screenrig.runtime.js");
    let runtime: Buffer;
    try {
      runtime = await readFile(runtimePath);
    } catch {
      throw packError("sdk_runtime_missing", `Pinned SDK runtime is missing at ${runtimePath}; reinstall the ScreenRig CLI from a verified release`);
    }
    return new ArchiveSdkInjector(runtime).inject(entries, request);
  }
}

export const defaultSdkInjector: SdkInjector = new ReleaseLocalSdkInjector();
