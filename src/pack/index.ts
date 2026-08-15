import { defaultSdkInjector } from "../adapters/sdk-injection.js";
import { mergeLimits, packError } from "./limits.js";
import { gzipDeterministic, sha256Hex, writeTar } from "./archive.js";
import type { PackOptions, PackResult } from "./types.js";
import { walkDirectory } from "./walk.js";

export async function packDirectory(root: string, options: PackOptions = {}): Promise<PackResult> {
  const limits = mergeLimits(options.limits);
  const walked = await walkDirectory(root, limits);
  const injector = options.injector ?? defaultSdkInjector;
  const injected = await injector.inject(walked);
  const entries = injected.entries
    .slice()
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));

  const files = entries.filter((entry) => entry.type === "file");
  const expandedBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  if (files.length > limits.application_file_count) {
    throw packError("too_many_files", `Archive contains ${files.length} files; limit is ${limits.application_file_count}`);
  }
  if (expandedBytes > limits.application_expanded_bytes) {
    throw packError("expanded_too_large", `Expanded archive ${expandedBytes} exceeds ${limits.application_expanded_bytes}`);
  }

  const tar = writeTar(entries);
  const archive = gzipDeterministic(tar);
  if (archive.length > limits.application_archive_bytes) {
    throw packError(
      "compressed_too_large",
      `Compressed archive ${archive.length} exceeds ${limits.application_archive_bytes}`,
    );
  }
  return {
    archive,
    sha256: sha256Hex(archive),
    compressed_bytes: archive.length,
    expanded_bytes: expandedBytes,
    file_count: files.length,
    entries: entries.map((entry) => ({ path: entry.path, type: entry.type, size: entry.size })),
    sdk_injection: {
      injected: injected.injected,
      reason: injected.reason,
      asset_path: injected.asset_path,
      asset_sha256: injected.asset_sha256,
    },
  };
}

export { writeTar, gzipDeterministic, sha256Hex, parseTar } from "./archive.js";
export { walkDirectory } from "./walk.js";
export { DEFAULT_ARCHIVE_LIMITS, mergeLimits } from "./limits.js";
