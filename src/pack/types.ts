import type { OperationLogger } from "../log/types.js";

export interface ArchiveLimits {
  application_archive_bytes: number;
  application_expanded_bytes: number;
  application_file_count: number;
  application_file_bytes: number;
  application_path_depth: number;
  application_path_bytes: number;
}

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
