import { DEFAULT_ARCHIVE_LIMITS } from "../adapters/protocol.js";
import { CliError, makeProblem } from "../problems.js";
import { ExitCode } from "../exit-codes.js";
import { ReleaseRuleError, type ArchiveEntry as ReleaseEntry } from "./release-core.js";
import type { ArchiveEntry } from "./types.js";

export { DEFAULT_ARCHIVE_LIMITS };

export function packError(code: string, detail: string): CliError {
  return new CliError(
    makeProblem(code, "Application archive rejected", 400, detail, {
      hint: "The CLI checks the archive locally; nothing was sent. Fix the file, line or ignore rule detail names, then run the command again.",
      next: {
        command: "screenrig app pack <directory>",
        reason: "Fix the named path or ignore rule, then rebuild the archive locally.",
      },
    }),
    ExitCode.Usage,
  );
}

export function mergeLimits(
  overrides?: Partial<typeof DEFAULT_ARCHIVE_LIMITS>,
): typeof DEFAULT_ARCHIVE_LIMITS {
  return { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
}

/** Rethrows a refusal of release-core.ts as the CLI's problem; anything else unchanged. */
export function rethrowRule(error: unknown): never {
  if (error instanceof ReleaseRuleError) throw packError(error.code, error.detail);
  throw error;
}

/** Views release-core.ts entries' bytes as Buffers, without copying. */
export function bufferEntries(entries: ReleaseEntry[]): ArchiveEntry[] {
  return entries.map((entry) => entry.data === undefined || Buffer.isBuffer(entry.data)
    ? entry as ArchiveEntry
    : { ...entry, data: Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength) });
}
