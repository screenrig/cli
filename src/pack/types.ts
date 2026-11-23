import type { OperationLogger } from "../log/types.js";

import type { ArchiveLimits } from "./release-core.js";

export type { ArchiveLimits };

export interface ArchiveEntry {
  path: string;
  type: "file" | "directory";
  data?: Buffer;
  size: number;
}

export interface PackResult {
  archive: Buffer;
  sha256: string;
  compressed_bytes: number;
  expanded_bytes: number;
  file_count: number;
  entries: Array<{ path: string; type: "file" | "directory"; size: number }>;
  sdk_injection: { injected: boolean; reason: string; asset_path?: string; asset_sha256?: string };
}

export interface PackOptions {
  limits?: Partial<ArchiveLimits>;
  logger?: OperationLogger;
  injector?: {
    inject(entries: ArchiveEntry[]): Promise<{
      entries: ArchiveEntry[];
      injected: boolean;
      reason: string;
      asset_path?: string;
      asset_sha256?: string;
    }>;
  };
}
