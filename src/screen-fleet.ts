import type { ParsedArgs } from "./command-input.js";
import { flagString } from "./command-input.js";
import type { Warning } from "./envelope.js";
import { ExitCode, exitCodeForStatus } from "./exit-codes.js";
import type { ScreenActionResult, ScreenActionScreenResult, ScreenActionSelector, ScreenActionType } from "./adapters/protocol.js";
import { usageError } from "./problems.js";

/** Screen tags share the media tag grammar. */
export const SCREEN_TAG_PATTERN = /^[A-Za-z0-9]{1,32}$/;
export const SCREEN_TAGS_MAX = 16;
/** Server bound for both selector forms. */
export const FLEET_SCREENS_MAX = 500;

export type ScreenTarget =
  | { kind: "single"; id: string }
  | { kind: "fleet"; selector: ScreenActionSelector };

export function screenTag(value: string, flag = "--tag"): string {
  if (!SCREEN_TAG_PATTERN.test(value)) throw usageError(`${flag} must be 1 to 32 letters or digits.`);
  return value;
}

/** A comma-separated tag list: each tag validated, no duplicates, at most 16. */
export function screenTagList(value: string, flag: string): string[] {
  const tags = value.split(",").map((tag) => tag.trim());
  if (tags.some((tag) => !SCREEN_TAG_PATTERN.test(tag))) {
    throw usageError(`${flag} takes comma-separated tags of 1 to 32 letters or digits, for example ${flag} Lobby,Floor2.`);
  }
  if (new Set(tags).size !== tags.length) throw usageError(`${flag} lists a tag more than once.`);
  if (tags.length > SCREEN_TAGS_MAX) throw usageError(`${flag} accepts at most ${SCREEN_TAGS_MAX} tags.`);
  return tags;
}

/**
 * Resolve `<id>`, several `<id>`s, or `--tag TAG`. Exactly one screen id keeps
 * the single-screen route and its envelope; several ids or a tag select the
 * fleet actions route.
 */
export function screenTarget(args: ParsedArgs, command: string): ScreenTarget {
  const ids = args.positionals.slice(2);
  if (args.flags.tag === true) throw usageError("--tag requires a value, such as --tag Lobby.");
  const tag = flagString(args.flags, "tag");
  if (tag !== undefined && ids.length) throw usageError(`${command} takes screen ids or --tag TAG, not both.`);
  if (tag !== undefined) return { kind: "fleet", selector: { by: "tag", tag: screenTag(tag) } };
  if (!ids.length) throw usageError(`${command} requires <id> or --tag TAG.`);
  if (ids.some((id) => id.length < 1 || id.length > 200)) throw usageError(`${command} screen ids must be 1 to 200 characters.`);
  if (new Set(ids).size !== ids.length) throw usageError(`${command} lists a screen id more than once.`);
  if (ids.length > FLEET_SCREENS_MAX) throw usageError(`${command} accepts at most ${FLEET_SCREENS_MAX} screen ids; use --tag for a larger fleet.`);
  if (ids.length === 1) return { kind: "single", id: ids[0]! };
  return { kind: "fleet", selector: { by: "ids", screen_ids: ids } };
}

/** Revision guards are per screen; the fleet route has none. */
export function rejectFleetRevision(args: ParsedArgs, command: string): void {
  if (args.flags["if-match"] !== undefined) {
    throw usageError(`${command} with several screens or --tag does not take --expect-rev: revision guards are per screen. Target one screen id to use --expect-rev.`);
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= FLEET_SCREENS_MAX;
}

/** Validate a POST /api/v1/screens/actions answer against the generated ScreenActionResult contract. */
export function screenActionResult(body: unknown, action: ScreenActionType): ScreenActionResult {
  const result = body as Partial<ScreenActionResult> | undefined;
  const results = result?.results;
  const valid = result !== undefined && result !== null && typeof result === "object"
    && result.action === action
    && isCount(result.matched) && isCount(result.succeeded) && isCount(result.failed)
    && Array.isArray(results)
    && results.length === result.matched
    && result.succeeded + result.failed === result.matched
    && results.every((item: ScreenActionScreenResult) => item && typeof item.screen_id === "string" && (item.status === "ok" || item.status === "failed"))
    && results.filter((item) => item.status === "failed").length === result.failed;
  if (!valid) throw usageError("Screen actions response does not match the generated ScreenActionResult contract.");
  return result as ScreenActionResult;
}

export interface FleetItem {
  screen_id: string;
  status: "ok" | "failed";
  problem?: { status?: number; code?: string };
}

export interface FleetSummary<T extends FleetItem = FleetItem> {
  matched: number;
  succeeded: number;
  failed: number;
  results: T[];
}

/**
 * Partial success is a normal answer, so the envelope stays `ok: true` and
 * `data` carries every per-screen result. The exit code is 0 only when every
 * matched screen succeeded; otherwise it is the exit code the first failed
 * screen's problem would have produced on its single-screen route. For a
 * server answer that is derived from the problem status; a client-side
 * fan-out passes each failure's own CliError exit code through exitCodeOf.
 */
export function fleetOutcome<T extends FleetItem>(summary: FleetSummary<T>, exitCodeOf?: (item: T) => ExitCode | undefined): { exitCode: ExitCode; warnings: Warning[] } {
  const warnings: Warning[] = [];
  if (summary.matched === 0) {
    warnings.push({ code: "fleet_no_match", message: "No screen matched the selector; nothing was changed." });
    return { exitCode: ExitCode.Success, warnings };
  }
  if (summary.failed === 0) return { exitCode: ExitCode.Success, warnings };
  warnings.push({
    code: "fleet_partial_failure",
    message: `${summary.failed} of ${summary.matched} screens failed; ${summary.succeeded} succeeded. See data.results[].problem for each failed screen.`,
  });
  const first = summary.results.find((item) => item.status === "failed");
  // A locally produced failure (client-side fan-out) keeps its CliError exit code.
  const known = first ? exitCodeOf?.(first) : undefined;
  if (known !== undefined) return { exitCode: known, warnings };
  const status = first?.problem?.status;
  const exitCode = typeof status === "number" && status >= 400 ? exitCodeForStatus(status) : ExitCode.Client;
  return { exitCode, warnings };
}

function problemLabel(problem: { status?: number; code?: string } | undefined): string {
  const code = typeof problem?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(problem.code) ? problem.code : "failed";
  return typeof problem?.status === "number" ? `${code}/${problem.status}` : code;
}

/** Human summary: one count line, then one row per screen in selector order. */
export function fleetHumanLines<T extends FleetItem>(title: string, summary: FleetSummary<T>, detail?: (item: T) => string | undefined): string {
  const rows = summary.results.map((item) => [
    item.screen_id,
    item.status,
    item.status === "failed" ? problemLabel(item.problem) : (detail?.(item) ?? ""),
  ]);
  const widths = [0, 1].map((index) => Math.max(0, ...rows.map((row) => row[index]!.length)));
  return [
    `${title}: matched ${summary.matched}, succeeded ${summary.succeeded}, failed ${summary.failed}`,
    ...rows.map((row) => row.map((cell, index) => index < widths.length ? cell.padEnd(widths[index]!) : cell).join("  ").trimEnd()),
  ].join("\n");
}
