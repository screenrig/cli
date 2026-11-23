import { defaultSdkInjector } from "../adapters/sdk-injection.js";
import { bufferEntries, mergeLimits, packError, rethrowRule } from "./limits.js";
import { finishRelease } from "./release-core.js";
import { gzipDeterministic, sha256Hex, writeTar } from "./archive.js";
import type { ArchiveEntry, PackOptions, PackResult } from "./types.js";
import { walkDirectory } from "./walk.js";
import { hoistInlineAssets } from "./inline.js";

export interface ReleaseEntries {
  /** Every file and directory of the release, sorted by path: the application's files with inline assets hoisted, plus the injected runtime. */
  entries: ArchiveEntry[];
  sdk_injection: PackResult["sdk_injection"];
  file_count: number;
  expanded_bytes: number;
}

/**
 * What `app pack` and `app dev` share: walk the directory, hoist inline styles
 * and scripts (refusing inline event handlers and javascript: URLs), inject the
 * pinned runtime and enforce the archive's file and size limits. The archive
 * itself is the caller's: pack compresses it, dev serves it from memory.
 */
export async function releaseEntries(root: string, options: Pick<PackOptions, "limits" | "logger" | "injector"> = {}): Promise<ReleaseEntries> {
  const logger = options.logger;
  const limits = mergeLimits(options.limits);
  const walked = logger
    ? await logger.withLocal({ op: "pack.walk", message: `walk ${root}` }, async (span) => {
        const result = await walkDirectory(root, limits);
        span.finish({ file_count: result.filter((entry) => entry.type === "file").length });
        return result;
      })
    : await walkDirectory(root, limits);
  const hoisted = await hoistInlineAssets(walked);
  const injector = options.injector ?? defaultSdkInjector;
  const injected = await injector.inject(hoisted);
  const enforceLimits = () => {
    try {
      return finishRelease(injected.entries, limits);
    } catch (error) {
      return rethrowRule(error);
    }
  };
  const release = logger?.enabled
    ? await logger.withLocal({ op: "pack.limits", message: "enforce archive limits" }, async (span) => {
        const finished = enforceLimits();
        span.finish({
          file_count: finished.file_count,
          expanded_bytes: finished.expanded_bytes,
          application_file_count: limits.application_file_count,
          application_expanded_bytes: limits.application_expanded_bytes,
        });
        return finished;
      })
    : enforceLimits();
  return {
    entries: bufferEntries(release.entries),
    file_count: release.file_count,
    expanded_bytes: release.expanded_bytes,
    sdk_injection: {
      injected: injected.injected,
      reason: injected.reason,
      asset_path: injected.asset_path,
      asset_sha256: injected.asset_sha256,
    },
  };
}

export async function packDirectory(root: string, options: PackOptions = {}): Promise<PackResult> {
  const logger = options.logger;
  const limits = mergeLimits(options.limits);
  const run = async (): Promise<PackResult> => {
    const release = await releaseEntries(root, options);
    const { entries, expanded_bytes: expandedBytes, file_count: fileCount } = release;
    const packed = logger
      ? await logger.withLocal({ op: "pack.archive", message: "write gzip archive" }, async (span) => {
          const tar = writeTar(entries);
          const archive = gzipDeterministic(tar);
          span.finish({
            compressed_bytes: archive.length,
            expanded_bytes: expandedBytes,
            file_count: fileCount,
            sha256: sha256Hex(archive),
          });
          return archive;
        })
      : gzipDeterministic(writeTar(entries));
    if (packed.length > limits.application_archive_bytes) {
      throw packError(
        "compressed_too_large",
        `Compressed archive ${packed.length} exceeds ${limits.application_archive_bytes}`,
      );
    }
    return {
      archive: packed,
      sha256: sha256Hex(packed),
      compressed_bytes: packed.length,
      expanded_bytes: expandedBytes,
      file_count: fileCount,
      entries: entries.map((entry) => ({ path: entry.path, type: entry.type, size: entry.size })),
      sdk_injection: release.sdk_injection,
    };
  };
  if (!logger?.enabled) {
    return run();
  }
  return logger.withLocal({ op: "pack.directory", message: `pack ${root}` }, async (span) => {
    const result = await run();
    span.finish({
      compressed_bytes: result.compressed_bytes,
      expanded_bytes: result.expanded_bytes,
      file_count: result.file_count,
      sha256: result.sha256,
    });
    return result;
  });
}
