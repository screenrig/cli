import { bufferEntries, rethrowRule } from "./limits.js";
import { hoistInlineAssets as hoist } from "./release-core.js";
import type { ArchiveEntry } from "./types.js";

/**
 * Hoists HTML styles and executable inline scripts into deterministic files
 * beside each document (release-core.ts), refusing inline event handlers and
 * javascript: URLs as CLI problems.
 */
export async function hoistInlineAssets(entries: ArchiveEntry[]): Promise<ArchiveEntry[]> {
  return bufferEntries(await hoist(entries).catch(rethrowRule));
}
