// Command handlers for the playback commands, loaded on demand.
import { isResourceID } from "../generated/resource-ids.js";
import { screenTag } from "../screen-fleet.js";
import { formatResultContext } from "../project-context.js";
import { normalizeInstant } from "../screen-control.js";
import { AGGREGATE_MAX_DAYS, CsvStreamFailure, PLAYBACK_CSV_IDLE_TIMEOUT_MS, PLAYS_SETTLE_MS, unusedPath, PLAYS_ALL_MAX_PAGES, PLAYS_LIMIT_MAX, playbackExportBudget, playsCursor, playsLimit, playsRange, requireCsvResponse, writeCsvFile, writeCsvStdout } from "../playback-export.js";
import { shellQuote } from "../temp-file.js";
import { type PlaybackPlay, type PlaybackPlayList } from "../adapters/protocol.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { resolveConfig } from "../config.js";
import { successEnvelope, type ProblemNext, type Warning } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, networkError, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { PLAYBACK_DAY_PATTERN, aggregateDays, clientFor, commandHandler, humanLines, playbackFormat, reportFileOf, requireFlagValue, resolveDownloadOutput, simpleGet, type CommandResult } from "../commands.js";


export const handlePlaybackList = commandHandler(playbackList);
export const handlePlaybackPlays = commandHandler(playbackPlays);

export function playbackFilterFlags(args: ParsedArgs): { screenId?: string; mediaId?: string } {
  requireFlagValue(args, "screen-id", "scr_01");
  requireFlagValue(args, "media-id", "med_01");
  const screenId = flagString(args.flags, "screen-id");
  const mediaId = flagString(args.flags, "media-id");
  if (screenId !== undefined && !isResourceID(screenId, "screen")) {
    throw usageError("--screen-id must be a screen identifier.");
  }
  if (mediaId !== undefined && !isResourceID(mediaId, "media")) {
    throw usageError("--media-id must start with med_.");
  }
  return { screenId, mediaId };
}

export async function playbackList(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const { screenId, mediaId } = playbackFilterFlags(args);
  for (const name of ["day", "day-from", "day-to"]) requireFlagValue(args, name, "2026-08-14");
  const day = flagString(args.flags, "day");
  if (day !== undefined && !PLAYBACK_DAY_PATTERN.test(day)) {
    throw usageError("--day must be a UTC calendar day as YYYY-MM-DD.");
  }
  const days = aggregateDays(flagString(args.flags, "day-from"), flagString(args.flags, "day-to"));
  if (day !== undefined && (days.day_from !== undefined || days.day_to !== undefined)) {
    throw usageError("Use --day for one UTC day, or --day-from/--day-to for a range, not both.");
  }
  const query = { screen_id: screenId, media_id: mediaId, day, ...days };
  const aggregateFile = await reportFileOf(args, runtime, resolved, "/api/playback", query, "play-aggregates", "playback aggregates", true);
  if (aggregateFile) return aggregateFile;
  if (playbackFormat(args, "playback list") === "csv") {
    return playbackCsvExport(args, runtime, resolved, {
      path: "/api/playback", query, what: "playback aggregates", defaultFile: "./playback-aggregates.csv",
    });
  }
  return simpleGet(args, runtime, resolved, "/api/playback", "Playback", query);
}

/**
 * `playback plays` binds GET /api/playback/plays. The received_at window is
 * resolved locally (to = now, from = to - 24h by default, at most 31 days) and
 * sent explicitly, so every page of one export shares the same bounds.
 */
export async function playbackPlays(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const { screenId, mediaId } = playbackFilterFlags(args);
  for (const [name, example] of [["from", "7d"], ["to", "now"], ["tag", "Lobby"], ["cursor", "pc_NEXT"], ["limit", "500"]] as const) {
    requireFlagValue(args, name, example);
  }
  const tagValue = flagString(args.flags, "tag");
  const tag = tagValue === undefined ? undefined : screenTag(tagValue);
  const cursorValue = flagString(args.flags, "cursor");
  const cursor = cursorValue === undefined ? undefined : playsCursor(cursorValue);
  const limitValue = flagString(args.flags, "limit") ?? (typeof args.flags.limit === "number" ? String(args.flags.limit) : undefined);
  const limit = limitValue === undefined ? undefined : playsLimit(limitValue);
  if (args.flags.all !== undefined && args.flags.all !== true) throw usageError("--all takes no value.");
  const all = flagBool(args.flags, "all");
  const range = playsRange(flagString(args.flags, "from"), flagString(args.flags, "to"), runtime.now());
  const filters = { screen_id: screenId, media_id: mediaId, tag };
  const query = { from: range.from, to: range.to, ...filters };
  const playsFile = await reportFileOf(args, runtime, resolved, "/api/playback/plays", query, "plays", "plays", true);
  if (playsFile) return playsFile;
  const format = playbackFormat(args, "playback plays");
  // The server never returns the newest 5 seconds: report the effective end.
  const now = runtime.now().getTime();
  const reported = { from: range.from, to: Date.parse(range.to) > now - PLAYS_SETTLE_MS ? new Date(now - PLAYS_SETTLE_MS).toISOString().replace(/\.000Z$/, "Z") : range.to };

  if (format === "csv") {
    if (limit !== undefined) throw usageError("--limit is JSON-only; --format csv streams the whole range in one request.");
    if (all) throw usageError("--all is JSON-only; --format csv already streams the whole range in one request.");
    return playbackCsvExport(args, runtime, resolved, {
      path: "/api/playback/plays", query: { ...query, cursor }, what: "playback plays", defaultFile: "./playback-plays.csv",
      range: reported, filters,
    });
  }

  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const pageLimit = limit ?? (all ? String(PLAYS_LIMIT_MAX) : undefined);
  const items: PlaybackPlay[] = [];
  const warnings: Warning[] = [];
  let next: string | null = cursor ?? null;
  let pages = 0;
  while (true) {
    let response: Awaited<ReturnType<ApiClient["call"]>>;
    try {
      response = await client.call({
        method: "GET", path: "/api/playback/plays",
        query: { ...query, ...(next ? { cursor: next } : {}), ...(pageLimit ? { limit: pageLimit } : {}) },
      });
    } catch (error) {
      // --all keeps the pages it already has when the export budget runs out.
      if (pages === 0 || !(error instanceof CliError) || error.problem.code !== "rate_limited") throw error;
      const wait = error.problem.retry_after_seconds;
      warnings.push({ code: "playback_export_rate_limited", message: `--all stopped after ${pages} pages: the playback export budget is spent${wait === undefined ? "" : ` for ${wait} s`}. Continue with data.next after that.` });
      break;
    }
    const page = response.body as Partial<PlaybackPlayList> | undefined;
    items.push(...(Array.isArray(page?.items) ? page.items : []));
    next = typeof page?.next_cursor === "string" ? page.next_cursor : null;
    pages += 1;
    if (!all || !next) break;
    if (pages >= PLAYS_ALL_MAX_PAGES) {
      warnings.push({ code: "playback_plays_truncated", message: `--all stopped after ${PLAYS_ALL_MAX_PAGES} pages (${items.length} plays). Continue with data.next, or export the range with --format csv.` });
      break;
    }
    const budget = playbackExportBudget(response.headers.ratelimit);
    if (budget !== undefined && budget.remaining === 0) {
      warnings.push({ code: "playback_export_rate_limited", message: `--all stopped after ${pages} pages: the playback export budget is spent for ${budget.resetSeconds} s. Continue with data.next after that.` });
      break;
    }
  }

  const nextArgv = next ? playsNextArgv(reported, filters, next, limit, all) : undefined;
  const data = {
    items, next_cursor: next, from: reported.from, to: reported.to, pages,
    ...(nextArgv ? { next: { command: `screenrig ${shellQuote(nextArgv)}`, argv: nextArgv } } : {}),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings }),
    exitCode: ExitCode.Success,
    human: [
      `Playback plays ${reported.from} to ${reported.to} (${items.length}${pages > 1 ? ` in ${pages} pages` : ""})`,
      ...items.map((play) => [play.received_at, play.screen_id, play.media_id, play.primitive, play.page_id, play.playlist_id ?? "-"].join("  ")),
      ...(nextArgv ? [`next: screenrig ${shellQuote(nextArgv)}`] : []),
      ...warnings.map((warning) => `warning: ${warning.message}`),
    ].join("\n"),
  };
}

/**
 * `playback totals` binds GET /api/playback/totals. A day series spans at most
 * 366 days (92 narrowed to a screen or media), a ranking at most 92; top ranks
 * at most 100 screens or media (10 for screen_day) and never applies to a day series.
 */
export const handlePlaybackTotals = commandHandler(async (args, runtime, resolved) => {
  const { screenId, mediaId } = playbackFilterFlags(args);
  for (const [name, example] of [["by", "screen"], ["day-from", "2026-09-01"], ["day-to", "2026-09-30"], ["top", "5"]] as const) {
    requireFlagValue(args, name, example);
  }
  const by = flagString(args.flags, "by") ?? "day";
  if (by !== "day" && by !== "screen" && by !== "media" && by !== "screen_day") throw usageError("--by must be day, screen, media or screen_day.");
  const top = flagString(args.flags, "top");
  let maxDays = 92;
  let scope = " for a ranking";
  if (by === "day") {
    if (top !== undefined) throw usageError("--top ranks screens or media: use it with --by screen, media or screen_day.");
    if (screenId === undefined && mediaId === undefined) {
      maxDays = AGGREGATE_MAX_DAYS;
      scope = "";
    } else {
      scope = " with --screen-id or --media-id";
    }
  } else {
    if (screenId !== undefined || mediaId !== undefined) throw usageError("--screen-id and --media-id narrow only --by day.");
    const topMax = by === "screen_day" ? 10 : 100;
    if (top !== undefined && (!/^\d+$/.test(top) || Number(top) < 1 || Number(top) > topMax)) {
      throw usageError(`--top must be a whole number from 1 to ${topMax} with --by ${by}.`);
    }
  }
  const days = aggregateDays(flagString(args.flags, "day-from"), flagString(args.flags, "day-to"), maxDays, scope);
  return simpleGet(args, runtime, resolved, "/api/playback/totals", "Playback totals", {
    by: flagString(args.flags, "by"), screen_id: screenId, media_id: mediaId, top, ...days,
  });
}, true);

/**
 * `playback completeness` binds GET /api/playback/completeness: how many of the
 * plays Players numbered reached screenRIG, per UTC day and for the window, and
 * the gaps where numbered plays went missing (newest first). A window spans at
 * most 92 days; --limit caps the gaps listed.
 */
export const handlePlaybackCompleteness = commandHandler(async (args, runtime, resolved) => {
  const { screenId } = playbackFilterFlags(args);
  for (const [name, example] of [["day-from", "2026-09-01"], ["day-to", "2026-09-30"], ["limit", "100"]] as const) {
    requireFlagValue(args, name, example);
  }
  const limit = flagString(args.flags, "limit");
  if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 500)) {
    throw usageError("--limit must be a whole number from 1 to 500.");
  }
  const days = aggregateDays(flagString(args.flags, "day-from"), flagString(args.flags, "day-to"), 92, "");
  return simpleGet(args, runtime, resolved, "/api/playback/completeness", "Playback completeness", {
    screen_id: screenId, limit, ...days,
  });
}, true);

export function playsNextArgv(
  range: { from: string; to: string },
  filters: { screen_id?: string; media_id?: string; tag?: string },
  cursor: string,
  limit: string | undefined,
  all: boolean,
): string[] {
  return [
    "playback", "plays", "--from", range.from, "--to", range.to,
    ...(filters.screen_id ? ["--screen-id", filters.screen_id] : []),
    ...(filters.media_id ? ["--media-id", filters.media_id] : []),
    ...(filters.tag ? ["--tag", filters.tag] : []),
    "--cursor", cursor,
    ...(limit ? ["--limit", limit] : []),
    ...(all ? ["--all"] : []),
  ];
}

/**
 * One CSV stream (one billed request) into a file via temp + rename, or to
 * stdout only with an explicit --output -. The envelope reports the path,
 * bytes, rows, and SHA-256, never the CSV itself. A stream that fails after
 * the 200 never lands on the target path.
 */
export async function playbackCsvExport(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  spec: {
    path: string; query: Record<string, string | undefined>; what: string; defaultFile: string;
    range?: { from: string; to: string }; filters?: { screen_id?: string; media_id?: string; tag?: string };
  },
): Promise<CommandResult> {
  const toStdout = flagString(args.flags, "output") === "-";
  const outputPath = toStdout ? undefined : await resolveDownloadOutput(runtime.cwd(), spec.defaultFile, args.flags);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // No whole-transfer deadline: the stream fails after --timeout (default 60 s) without a byte.
  const idle = flagNumber(args.flags, "timeout") ?? PLAYBACK_CSV_IDLE_TIMEOUT_MS;
  const response = await client.download({
    method: "GET", path: spec.path, query: { ...spec.query, format: "csv" }, timeout_ms: 0, idle_timeout_ms: idle, label: "Playback export",
  });
  try {
    requireCsvResponse(response.headers, spec.what, client.requestId);
    if (!response.body) throw networkError(`The ${spec.what} export returned no body.`, client.requestId);
  } catch (error) {
    await response.body?.cancel?.();
    throw error;
  }
  // The same export again, flag for query parameter (format and cursor included).
  const rerun = (output: string, from?: string): ProblemNext => {
    const query: Record<string, string | undefined> = { ...spec.query, ...(from ? { from, cursor: undefined } : {}) };
    const argv = [...args.command];
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && key !== "format") argv.push(`--${key.replaceAll("_", "-")}`, value);
    }
    argv.push("--format", "csv", "--output", output);
    return from
      ? { command: `screenrig ${shellQuote(argv)}`, argv, reason: `Export the rest of the range from ${from}, the last received_at received. Rows received at that instant appear in both files; drop the repeats when joining them.` }
      : { command: `screenrig ${shellQuote(argv)}`, argv, reason: "Rerun the same export; nothing was written." };
  };
  // A plays export resumes from the last received_at it wrote (inclusive, so
  // rows at that instant repeat). Aggregates have no cursor: rerun the command.
  const resume = (failure: CsvStreamFailure, output: string): ProblemNext => {
    const index = failure.header.indexOf("received_at");
    const last = index >= 0 ? failure.lastRow?.[index] : undefined;
    const from = spec.range && last !== undefined ? normalizeInstant(last) : undefined;
    return rerun(output, from);
  };
  if (toStdout) {
    try {
      if (formatResultContext(runtime)) runtime.stderr.write(`${formatResultContext(runtime)}\n`);
      await writeCsvStdout(response.body, runtime.stdout, spec.what, client.requestId);
    } catch (error) {
      // CSV bytes may already be on stdout; the error goes to stderr instead of an envelope.
      const lines = [`error: ${error instanceof CliError ? error.problem.detail : `the ${spec.what} CSV could not be written to stdout.`} stdout holds an incomplete export.`];
      if (error instanceof CsvStreamFailure) lines.push(`next: ${resume(error, "-").command}`);
      try {
        runtime.stderr.write(`${lines.join("\n")}\n`);
      } catch {
        // stderr may be gone too; the exit code still reports the failure.
      }
      return { envelope: successEnvelope({}), exitCode: error instanceof CliError ? error.exitCode : ExitCode.Unexpected, human: "", output: "stream" };
    }
    return { envelope: successEnvelope({}), exitCode: ExitCode.Success, human: "", output: "stream" };
  }
  let file: Awaited<ReturnType<typeof writeCsvFile>>;
  try {
    file = await writeCsvFile(response.body, outputPath!, spec.what, client.requestId, spec.range !== undefined);
  } catch (error) {
    if (!(error instanceof CsvStreamFailure)) throw error;
    const kept = error.partialPath
      ? ` The ${error.rows} complete rows received are in ${error.partialPath}; ${outputPath} was not written.`
      : ` Nothing was written to ${outputPath}.`;
    const next = error.partialPath
      ? resume(error, await unusedPath(`${outputPath!.replace(/\.csv$/i, "")}-rest.csv`, ".csv"))
      : rerun(outputPath!);
    throw new CliError(
      {
        ...error.problem,
        detail: `The ${spec.what} CSV stream failed after the export started: ${error.problem.detail}${kept}`,
        hint: error.partialPath
          ? "Run the next command to export the rows that were not received; the complete rows already received stay in the partial file."
          : "Run the next command to start the export again.",
        next,
      },
      error.exitCode,
      error.warnings,
    );
  }
  const receivedIndex = file.header.indexOf("received_at");
  const lastReceivedAt = receivedIndex >= 0 ? file.last?.[receivedIndex] : undefined;
  const data = {
    path: file.path,
    bytes: file.bytes,
    rows: file.rows,
    sha256: file.sha256,
    content_type: "text/csv",
    ...(spec.range ? { from: spec.range.from, to: spec.range.to } : {}),
    ...(lastReceivedAt ? { last_received_at: lastReceivedAt } : {}),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines(`${spec.what[0]!.toUpperCase()}${spec.what.slice(1)} exported`, [
      ["path", file.path],
      ["rows", String(file.rows)],
      ["bytes", String(file.bytes)],
      ["sha256", file.sha256],
      ["range", spec.range ? `${spec.range.from} to ${spec.range.to}` : undefined],
      ["last_received_at", lastReceivedAt],
    ]),
  };
}
