import { DEFAULT_ARCHIVE_LIMITS } from "../adapters/protocol.js";
import { CliError, makeProblem } from "../problems.js";
import { ExitCode } from "../exit-codes.js";

export { DEFAULT_ARCHIVE_LIMITS };

export function packError(code: string, detail: string): CliError {
  return new CliError(
    makeProblem(code, "Application archive rejected", 400, detail, {
      next: {
        command: "screenrig app pack <directory> --json",
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
