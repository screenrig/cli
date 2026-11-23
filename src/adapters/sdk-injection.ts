import { processSettings } from "../host-settings.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readAsset } from "../assets.js";
import { bufferEntries, packError, rethrowRule } from "../pack/limits.js";
import { injectRuntime, SDK_PROTOCOL_VERSION, SDK_RUNTIME_PATH } from "../pack/release-core.js";
import type { ArchiveEntry } from "../pack/types.js";

export { SDK_MARKER, SDK_PROTOCOL_VERSION, SDK_RUNTIME_PATH, SDK_SCRIPT_TAG } from "../pack/release-core.js";

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

export class ArchiveSdkInjector implements SdkInjector {
  constructor(private readonly runtime: Buffer) {}

  async inject(entries: ArchiveEntry[], request: SdkInjectionRequest = {}): Promise<SdkInjectionResult> {
    const version = request.sdk_version ?? SDK_PROTOCOL_VERSION;
    if (version !== SDK_PROTOCOL_VERSION) {
      throw packError("sdk_version_incompatible", `Requested SDK protocol ${version}; this release supports ${SDK_PROTOCOL_VERSION}`);
    }
    const injected = await injectRuntime(entries, this.runtime).catch(rethrowRule);
    if (request.sdk_sha256 && request.sdk_sha256 !== injected.asset_sha256) {
      throw packError("sdk_hash_mismatch", "Pinned SDK runtime hash does not match the requested compatibility record");
    }
    return { entries: bufferEntries(injected.entries), injected: true, reason: "Pinned ScreenRig browser runtime injected into archive only", asset_path: SDK_RUNTIME_PATH, asset_sha256: injected.asset_sha256 };
  }
}

class ReleaseLocalSdkInjector implements SdkInjector {
  async inject(entries: ArchiveEntry[], request?: SdkInjectionRequest): Promise<SdkInjectionResult> {
    const configured = processSettings().SCREENRIG_SDK_RUNTIME;
    let runtime: Buffer;
    try {
      runtime = configured ? await readFile(path.resolve(configured)) : readAsset("screenrig.runtime.js");
    } catch {
      const where = configured ? path.resolve(configured) : "assets/screenrig.runtime.js";
      throw packError("sdk_runtime_missing", `Pinned SDK runtime is missing at ${where}; reinstall the ScreenRig CLI from a verified release`);
    }
    return new ArchiveSdkInjector(runtime).inject(entries, request);
  }
}

export const defaultSdkInjector: SdkInjector = new ReleaseLocalSdkInjector();
