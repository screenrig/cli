import { createHash } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import type { Writable } from "node:stream";
import { CliError, fileError, networkError, unexpectedResponseError, usageError } from "./problems.js";
import { openTempFile } from "./temp-file.js";
import { normalizeInstant } from "./screen-control.js";
import type { TransportByteStream } from "./transport/types.js";

/** GET /api/v1/playback/plays: to - from is at most 31 days (PlaysTo). */
export const PLAYS_MAX_RANGE_MS = 31 * 86_400_000;
/** Server default when from is omitted: 24 hours before to. */
export const PLAYS_DEFAULT_RANGE_MS = 86_400_000;
export const PLAYS_LIMIT_MAX = 1000;
/** GET /api/v1/playback day_from to day_to spans at most 366 days (PlaybackDayFrom). */
export const AGGREGATE_MAX_DAYS = 366;
/** --all follows next_cursor for at most this many pages (each one billed request). */
export const PLAYS_ALL_MAX_PAGES = 50;
export const PLAYS_CURSOR_PATTERN = /^pc_[A-Za-z0-9_-]{1,512}$/;
/**
 * A CSV stream fails after this long without a byte (headers included), not
 * after a whole-transfer deadline; the global --timeout overrides it.
 */
export const PLAYBACK_CSV_IDLE_TIMEOUT_MS = 60_000;
/** The server holds back the newest plays: effective to is at most now - 5 s. */
export const PLAYS_SETTLE_MS = 5_000;

const RELATIVE = /^(\d{1,4})([dhm])$/;
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

/**
 * `--from`/`--to`: an RFC 3339 instant with seconds and an offset, normalized
 * to UTC, `now`, or a relative age such as 7d, 12h, or 30m before now.
 */
export function playsInstant(value: string, flag: "--from" | "--to", now: Date): number {
  const trimmed = value.trim();
  if (trimmed === "now") return now.getTime();
  const relative = RELATIVE.exec(trimmed);
  if (relative) {
    return now.getTime() - Number(relative[1]) * UNIT_MS[relative[2] as keyof typeof UNIT_MS];
  }
  const normalized = normalizeInstant(trimmed);
  if (normalized === undefined) {
    throw usageError(`${flag} takes an RFC 3339 instant with seconds and an offset (2026-09-01T00:00:00Z or 2026-09-01T00:00:00-07:00), now, or an age before now such as 7d, 12h, or 30m.`);
  }
  return Date.parse(normalized);
}

export function playsInstantOption(flag: "--from" | "--to"): (value: string) => string {
  return (value: string) => {
    playsInstant(value, flag, new Date());
    return value;
  };
}

/**
 * Resolve the received_at window locally so every page of one export uses the
 * same bounds: to defaults to now, from to 24 hours before to.
 */
export function playsRange(from: string | undefined, to: string | undefined, now: Date): { from: string; to: string } {
  const toMs = to === undefined ? now.getTime() : playsInstant(to, "--to", now);
  const fromMs = from === undefined ? toMs - PLAYS_DEFAULT_RANGE_MS : playsInstant(from, "--from", now);
  if (fromMs >= toMs) throw usageError("--from must be before --to.");
  if (toMs - fromMs > PLAYS_MAX_RANGE_MS) {
    throw usageError("--from to --to must span at most 31 days. Export a longer period as several ranges.");
  }
  return { from: isoUtc(fromMs), to: isoUtc(toMs) };
}

export function playsCursor(value: string): string {
  if (!PLAYS_CURSOR_PATTERN.test(value)) throw usageError("--cursor takes the data.next_cursor value of the previous page (pc_…).");
  return value;
}

export function playsLimit(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > PLAYS_LIMIT_MAX) {
    throw usageError(`--limit must be a whole number from 1 to ${PLAYS_LIMIT_MAX}.`);
  }
  return value;
}

/** Split one CSV record (without its line ending) into cells, RFC 4180 quoting. */
export function csvCells(record: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const char = record[index]!;
    if (quoted) {
      if (char === "\"" && record[index + 1] === "\"") { cell += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else cell += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell);
  return cells;
}

/**
 * Counts records in a streamed RFC 4180 body and keeps the header and the last
 * complete record. A newline inside a quoted cell does not end a record.
 */
export class CsvRecordCounter {
  records = 0;
  header: string | undefined;
  last: string | undefined;
  /** Bytes seen, and the offset just past the last complete record. */
  bytes = 0;
  completeBytes = 0;
  private current: number[] = [];
  private quoted = false;

  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      this.bytes += 1;
      if (byte === 0x22) this.quoted = !this.quoted;
      if (byte === 0x0a && !this.quoted) {
        const bytes = this.current.at(-1) === 0x0d ? this.current.slice(0, -1) : this.current;
        const text = Buffer.from(bytes).toString("utf8");
        if (this.records === 0) this.header = text;
        this.last = text;
        this.records += 1;
        this.current = [];
        this.completeBytes = this.bytes;
        continue;
      }
      this.current.push(byte);
    }
  }

  /** True when the body ended on a record boundary (the backend ends every record with CRLF). */
  get complete(): boolean {
    return this.records > 0 && this.completeBytes === this.bytes;
  }

  get rows(): number {
    return Math.max(0, this.records - 1);
  }

  /** Cells of the last complete data row (not the header). */
  lastRow(): string[] | undefined {
    return this.rows > 0 && this.last !== undefined ? csvCells(this.last) : undefined;
  }

  headerCells(): string[] {
    return csvCells(this.header ?? "");
  }
}

export interface CsvFileResult {
  path: string;
  bytes: number;
  rows: number;
  sha256: string;
  header: string[];
  last: string[] | undefined;
}

/**
 * The stream failed after the 200: the server aborts the connection on a
 * mid-stream failure, and a body that stops mid-row is never complete.
 * Carries what was received so the caller can say how to resume.
 */
export class CsvStreamFailure extends CliError {
  constructor(
    readonly failure: CliError,
    readonly rows: number,
    readonly header: string[],
    readonly lastRow: string[] | undefined,
    /** File holding the complete rows received, never the requested path. */
    readonly partialPath?: string,
  ) {
    super(failure.problem, failure.exitCode, failure.warnings);
  }
}

function endedMidRow(what: string, requestId: string | undefined): CliError {
  return networkError(`The ${what} CSV stream ended in the middle of a row.`, requestId);
}

/** Refuse a success that is not the CSV the contract names (a proxy page, JSON). */
export function requireCsvResponse(headers: Record<string, string>, what: string, requestId?: string): void {
  const type = (headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (type !== "text/csv") throw unexpectedResponseError(`The ${what} export answered ${type || "without a Content-Type"}, not text/csv.`, requestId);
}

/**
 * `file` when it does not exist, else the first free `stem-2ext`, `stem-3ext`, ...
 * (`plays.csv.partial` → `plays.csv.partial-2`; `plays-rest.csv` → `plays-rest-2.csv`).
 */
export async function unusedPath(file: string, extension = ""): Promise<string> {
  const stem = extension && file.endsWith(extension) ? file.slice(0, -extension.length) : file;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? file : `${stem}-${index}${extension && file.endsWith(extension) ? extension : ""}`;
    try {
      await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw usageError(`Too many earlier exports named ${file}; move them away and rerun.`);
}

/**
 * Stream the CSV body into a 0600 temp file beside the target, then rename it
 * into place only after a clean end on a record boundary. A transport failure
 * never renames onto the target: with `keepPartial` and at least one complete
 * row, the complete rows move to `<target>.partial`; otherwise the temp file is
 * removed. Bytes never reach stdout or the log.
 */
export async function writeCsvFile(
  body: TransportByteStream,
  outputPath: string,
  what: string,
  requestId: string | undefined,
  keepPartial = false,
): Promise<CsvFileResult> {
  const hash = createHash("sha256");
  const counter = new CsvRecordCounter();
  let failure: CliError | undefined;
  let temp: Awaited<ReturnType<typeof openTempFile>> | undefined;
  try {
    try {
      temp = await openTempFile(outputPath);
    } catch (error) {
      throw fileError(`Cannot create a temporary file beside ${outputPath}.`, error);
    }
    const { handle } = temp;
    try {
      try {
        for await (const chunk of body) {
          counter.push(chunk);
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const written = await handle.write(chunk, offset, chunk.byteLength - offset);
            offset += written.bytesWritten;
          }
        }
        if (!counter.complete) failure = endedMidRow(what, requestId);
      } catch (error) {
        if (!(error instanceof CliError)) throw fileError(`Cannot write the ${what} CSV beside ${outputPath}.`, error);
        failure = error;
      }
      if (failure && keepPartial && counter.rows > 0) await handle.truncate(counter.completeBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (failure) {
      if (keepPartial && counter.rows > 0) {
        let partialPath: string | undefined;
        try {
          partialPath = await unusedPath(`${outputPath}.partial`);
          await rename(temp.path, partialPath);
        } catch {
          // Keep reporting the stream failure, not the rescue attempt.
          partialPath = undefined;
        }
        throw new CsvStreamFailure(failure, counter.rows, counter.headerCells(), counter.lastRow(), partialPath);
      }
      throw new CsvStreamFailure(failure, counter.rows, counter.headerCells(), counter.lastRow());
    }
    try {
      await rename(temp.path, outputPath);
    } catch (error) {
      throw fileError(`Cannot move the ${what} CSV into place at ${outputPath}.`, error);
    }
  } catch (error) {
    if (temp) await rm(temp.path, { force: true });
    if (error instanceof CliError) throw error;
    throw fileError(`Cannot write the ${what} CSV to ${outputPath}.`, error);
  } finally {
    temp?.release();
    await body.cancel?.();
  }
  return {
    path: outputPath,
    bytes: counter.bytes,
    rows: counter.rows,
    sha256: hash.digest("hex"),
    header: counter.headerCells(),
    last: counter.lastRow(),
  };
}

function writeChunk(stream: Writable, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown) => reject(error);
    stream.once("error", onError);
    stream.write(chunk, (error?: Error | null) => {
      stream.removeListener("error", onError);
      if (error) reject(error);
      else resolve();
    });
  });
}

/** `--output -`: the CSV bytes are the whole of stdout. */
export async function writeCsvStdout(body: TransportByteStream, stdout: Writable, what: string, requestId: string | undefined): Promise<void> {
  const counter = new CsvRecordCounter();
  let failure: CliError | undefined;
  try {
    for await (const chunk of body) {
      counter.push(chunk);
      await writeChunk(stdout, chunk);
    }
    if (!counter.complete) failure = endedMidRow(what, requestId);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    failure = error;
  } finally {
    await body.cancel?.();
  }
  if (failure) throw new CsvStreamFailure(failure, counter.rows, counter.headerCells(), counter.lastRow());
}

/**
 * The tightest playback-export budget from a RateLimit response header
 * (`"playback-export-project";r=29;t=60, ...`): remaining requests and the
 * reset delay in seconds. Undefined when the response disclosed none.
 */
export function playbackExportBudget(header: string | undefined): { remaining: number; resetSeconds: number } | undefined {
  if (!header) return undefined;
  let budget: { remaining: number; resetSeconds: number } | undefined;
  for (const member of header.split(",")) {
    const match = /^\s*"?(playback-export-[a-z]+)"?((?:;[a-z]+=\d+)*)\s*$/.exec(member);
    if (!match) continue;
    const remaining = /;r=(\d+)/.exec(match[2]!)?.[1];
    const reset = /;t=(\d+)/.exec(match[2]!)?.[1];
    if (remaining === undefined) continue;
    const next = { remaining: Number(remaining), resetSeconds: reset === undefined ? 0 : Number(reset) };
    if (!budget || next.remaining < budget.remaining) budget = next;
  }
  return budget;
}
