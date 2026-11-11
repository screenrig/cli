import { defaultSdkInjector } from "../adapters/sdk-injection.js";
import { mergeLimits, packError } from "./limits.js";
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
  const hoisted = hoistInlineAssets(walked);
  const injector = options.injector ?? defaultSdkInjector;
  const injected = await injector.inject(hoisted);
  const entries = injected.entries
    .slice()
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));

  const files = entries.filter((entry) => entry.type === "file");
  const expandedBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  const enforceLimits = () => {
    if (files.length > limits.application_file_count) {
      throw packError("too_many_files", `Archive contains ${files.length} files; limit is ${limits.application_file_count}`);
    }
    if (expandedBytes > limits.application_expanded_bytes) {
      throw packError("expanded_too_large", `Expanded archive ${expandedBytes} exceeds ${limits.application_expanded_bytes}`);
    }
  };
  if (logger?.enabled) {
    await logger.withLocal({ op: "pack.limits", message: "enforce archive limits" }, async (span) => {
      enforceLimits();
      span.finish({
        file_count: files.length,
        expanded_bytes: expandedBytes,
        application_file_count: limits.application_file_count,
        application_expanded_bytes: limits.application_expanded_bytes,
      });
    });
  } else {
    enforceLimits();
  }
  return {
    entries,
    file_count: files.length,
    expanded_bytes: expandedBytes,
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
