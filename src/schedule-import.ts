import { createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { assertOutputAvailable, readInputBytes } from "./authoring-input.js";
import { type ApiClient, requireToken } from "./client.js";
import { type CommandResult, clientFor, commandHandler, jsonBody } from "./commands.js";
import { flagBool, flagString, type ParsedArgs } from "./command-input.js";
import { successEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { isValidIdempotencyKey } from "./ids.js";
import { CliError, usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";
import type { TransportResponse } from "./transport/types.js";

/** The backend reads a sheet of at most 8 MiB and 5,000 rows. */
export const SCHEDULE_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const SCHEDULE_IMPORT_MAX_ROWS = 5000;
export const SCHEDULE_IMPORT_NAME_MAX = 80;
const SOURCE_MAX = 200;
const PREVIEW_PATH = "/api/schedule/imports/preview";
const COMMIT_PATH = "/api/schedule/imports";
const TEMPLATE_PATH = "/api/schedule/imports/template";
const CSV_TYPE = "text/csv";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** A preview or commit reads and checks every row against the project, which can outlast the default request timeout. */
const IMPORT_TIMEOUT_MS = 120_000;
/** A preview whose rows have errors: the closest existing code is the one a refused request with HTTP 422 earns. */
export const SCHEDULE_IMPORT_NEEDS_CORRECTIONS = ExitCode.Client;

/** The parts of the API's ScheduleImport* documents this command reads (vendor/openapi.yaml). */
export interface ImportRowError { column?: string; code: string; message: string }
interface ImportResolved { kind: string; id: string; name: string; screens?: number }
export interface ImportRow {
  row: number;
  status: "ok" | "error";
  errors?: ImportRowError[];
  warnings?: ImportRowError[];
  target?: ImportResolved;
  content?: ImportResolved;
  level?: string;
}
export interface ImportLevel {
  key: string;
  action: "create" | "update" | "unchanged";
  home: "screen" | "shared";
  screen_id?: string;
  entry_id?: string;
  campaign_id?: string;
  name?: string;
  content: ImportResolved;
  screens: number;
  priority: number;
  from?: string;
  until?: string;
  rows: number[];
}
export interface ImportRemoval { home: "screen" | "shared"; screen_id?: string; entry_id?: string; campaign_id?: string; name?: string }
export interface ImportSummary {
  rows: number; rows_with_errors: number; levels: number; creates: number; updates: number; unchanged: number; removes: number; screens: number; playlists: number;
}
interface CalendarLevel { id: string; record_id?: string; name?: string }
interface CalendarSpan { level_id: string; from: string; to: string; state: string }
interface CalendarGroup { screens: number; timezone?: string; levels?: CalendarLevel[]; spans?: CalendarSpan[]; conflicts?: unknown[] }
export interface ImportPreview {
  name: string;
  source?: string;
  valid: boolean;
  fingerprint: string;
  summary: ImportSummary;
  errors?: ImportRowError[];
  rows: ImportRow[];
  levels: ImportLevel[];
  removals: ImportRemoval[];
  calendar?: { groups?: CalendarGroup[]; truncated?: boolean };
}
export interface ImportCommitted { preview: ImportPreview; applied: ImportSummary }

/** How the sheet reaches the API: raw CSV or XLSX bytes with query parameters, or JSON rows. */
export interface ImportSheet {
  kind: "csv" | "xlsx" | "json";
  /** The file's base name; absent for stdin. */
  source?: string;
  /** The name `--name` defaults to. */
  defaultName?: string;
  bytes?: Uint8Array;
  rows?: Array<Record<string, unknown>>;
}

/** --name: 1 to 80 characters after trimming, no control characters. */
export function scheduleImportName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > SCHEDULE_IMPORT_NAME_MAX || /\p{Cc}/u.test(trimmed)) {
    throw usageError(`--name must contain 1 to ${SCHEDULE_IMPORT_NAME_MAX} characters without controls.`);
  }
  return trimmed;
}

/** --timezone: an IANA zone name such as America/New_York or UTC. */
export function scheduleImportTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    throw usageError("--timezone takes an IANA time zone name such as America/New_York, Europe/London or UTC.");
  }
  return value;
}

/** --code-field: the name of a screen field such as code or room_id. */
export function scheduleImportCodeField(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > 64 || /\p{Cc}/u.test(trimmed)) {
    throw usageError("--code-field takes the name of a screen field, such as code or room_id.");
  }
  return trimmed;
}

function fileReadError(file: string, error: unknown): unknown {
  if (error instanceof CliError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return usageError(`${file} does not exist.`);
  if (code === "EISDIR") return usageError(`${file} is a directory; pass a .csv, .xlsx or .json file.`);
  if (code === "EACCES") return usageError(`${file} cannot be read (permission denied).`);
  return usageError(`Cannot read ${file}; provide a readable file within the 8 MiB limit.`);
}

/** The rows of a JSON sheet: an array of row objects, or {"rows": [...]}. */
export function importRowsFromJson(text: string): Array<Record<string, unknown>> {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw usageError("The JSON sheet is not valid JSON. Give an array of row objects or {\"rows\": [...]}.");
  }
  const rows = Array.isArray(document) ? document : (document && typeof document === "object" ? (document as { rows?: unknown }).rows : undefined);
  if (!Array.isArray(rows)) throw usageError("The JSON sheet must be an array of row objects or {\"rows\": [...]}.");
  if (!rows.length) throw usageError("The JSON sheet lists no rows.");
  if (rows.length > SCHEDULE_IMPORT_MAX_ROWS) throw usageError(`A sheet holds at most ${SCHEDULE_IMPORT_MAX_ROWS} rows; split it.`);
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw usageError(`JSON row ${index + 1} must be an object keyed by column name.`);
    for (const [column, cell] of Object.entries(row)) {
      if (cell !== null && !["string", "number", "boolean"].includes(typeof cell)) {
        throw usageError(`JSON row ${index + 1}, column ${column}: a cell is text, a number, true, false or null.`);
      }
    }
  });
  return rows as Array<Record<string, unknown>>;
}

/** Read FILE (or stdin for -) as raw bytes and decide how the API reads it. */
export async function readImportSheet(file: string, runtime: CliRuntime): Promise<ImportSheet> {
  if (!file) throw usageError("schedule import requires <file>: a .csv, .xlsx or .json sheet, or - to read one from stdin.");
  let bytes: Buffer;
  try {
    bytes = await readInputBytes(file, runtime.cwd(), runtime, SCHEDULE_IMPORT_MAX_BYTES);
  } catch (error) {
    throw file === "-" ? (error instanceof CliError ? error : usageError("Cannot read stdin; pipe a sheet within the 8 MiB limit.")) : fileReadError(file, error);
  }
  if (!bytes.length) throw usageError(file === "-" ? "Stdin held no sheet." : `${file} is empty.`);
  let kind: ImportSheet["kind"];
  if (file === "-") {
    if (bytes.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "latin1"))) kind = "xlsx";
    else {
      const first = bytes.toString("utf8", 0, Math.min(bytes.length, 64)).replace(/^﻿/, "").trimStart()[0];
      kind = first === "[" || first === "{" ? "json" : "csv";
    }
  } else {
    const extension = path.extname(file).toLowerCase();
    if (extension === ".csv") kind = "csv";
    else if (extension === ".xlsx") kind = "xlsx";
    else if (extension === ".json") kind = "json";
    else throw usageError(`${file} is not a .csv, .xlsx or .json file. Save the sheet as CSV UTF-8 or XLSX, or pipe it in with -.`);
  }
  const base = file === "-" ? undefined : path.basename(file);
  const source = base ? [...base].slice(0, SOURCE_MAX).join("") : undefined;
  const defaultName = base ? path.basename(base, path.extname(base)) : undefined;
  if (kind === "json") return { kind, source, defaultName, rows: importRowsFromJson(bytes.toString("utf8").replace(/^﻿/, "")) };
  return { kind, source, defaultName, bytes };
}

interface ImportParameters { name?: string; timezone?: string; codeField?: string }

/** The request that previews, and with a fingerprint commits, one sheet. */
export function importRequest(sheet: ImportSheet, parameters: ImportParameters, fingerprint?: string): { body: unknown; headers: Record<string, string>; query?: Record<string, string | undefined> } {
  if (sheet.kind === "json") {
    return {
      headers: { "content-type": "application/json" },
      body: {
        ...(parameters.name ? { name: parameters.name } : {}),
        ...(sheet.source ? { source: sheet.source } : {}),
        ...(parameters.timezone ? { timezone: parameters.timezone } : {}),
        ...(parameters.codeField ? { code_field: parameters.codeField } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        rows: sheet.rows,
      },
    };
  }
  return {
    headers: { "content-type": sheet.kind === "xlsx" ? XLSX_TYPE : CSV_TYPE },
    body: sheet.bytes,
    query: { name: parameters.name, timezone: parameters.timezone, source: sheet.source, code_field: parameters.codeField, fingerprint },
  };
}

const COLUMN_TITLES: Record<string, string> = {
  target: "Screen", content: "File", start: "Start", end: "End", timezone: "Timezone", days: "Days", daily_start: "Daily start",
  daily_end: "Daily end", priority: "Priority", name: "Name", display: "Display", region: "Region",
};

function columnTitle(column: string): string {
  return COLUMN_TITLES[column] ?? column.charAt(0).toUpperCase() + column.slice(1).replaceAll("_", " ");
}

/** `row 7 · File · No file or playlist is named "x.jpg".` Row 0 or absent is the file itself. */
export function rowProblemLine(row: number | undefined, problem: ImportRowError, warning = false): string {
  const parts = [row ? `row ${row}` : "file", ...(problem.column ? [columnTitle(problem.column)] : []), `${warning ? "warning: " : ""}${problem.message}`];
  return parts.join(" · ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => [...(row[index] ?? "")].length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [render(header), ...rows.map(render)];
}

function clip(text: string, width: number): string {
  const characters = [...text];
  return characters.length <= width ? text : `${characters.slice(0, width - 1).join("")}…`;
}

/** Long lists stop at `limit` lines and say how many more the JSON envelope holds. */
function capped(lines: string[], limit: number, noun: string): string[] {
  return lines.length <= limit ? lines : [...lines.slice(0, limit), `… and ${lines.length - limit} more ${noun}; --json lists every one.`];
}

function whenText(level: ImportLevel): string {
  const civil = (value: string) => value.replace("T", " ");
  if (!level.from && !level.until) return "always";
  return `${level.from ? civil(level.from) : "…"} → ${level.until ? civil(level.until) : "…"}`;
}

/** The screen's name for each screen-home level, from the rows that feed it. */
function screenNames(preview: ImportPreview): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of preview.rows) {
    if (row.level && row.target?.kind === "screen" && !names.has(row.level)) names.set(row.level, row.target.name);
  }
  return names;
}

function removalText(removal: ImportRemoval): string {
  if (removal.home === "screen") return `screen ${removal.screen_id ?? ""}${removal.entry_id ? ` (entry ${removal.entry_id})` : ""}`.trimEnd();
  return `shared ${removal.name ? `"${removal.name}"` : removal.campaign_id ?? ""}`.trimEnd();
}

/** A calendar instant on the group's clock, YYYY-MM-DD HH:MM. */
function clockText(instant: string, timezone: string | undefined): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  const zone = timezone || "UTC";
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${timezone ? "" : " UTC"}`;
  } catch {
    return instant;
  }
}

/** Per group of screens: the first span in which a level this import makes plays. */
function calendarLines(preview: ImportPreview): string[] {
  const groups = preview.calendar?.groups ?? [];
  if (!groups.length) return [];
  const made = new Map<string, ImportLevel>();
  for (const level of preview.levels) {
    if (level.entry_id) made.set(level.entry_id, level);
    if (level.campaign_id) made.set(level.campaign_id, level);
    made.set(`import_${level.key}`, level);
  }
  const lines = groups.map((group) => {
    const record = new Map((group.levels ?? []).map((level) => [level.id, level.record_id ?? ""]));
    const first = [...(group.spans ?? [])]
      .filter((span) => (span.state === "plays" || span.state === "partial") && made.has(record.get(span.level_id) ?? ""))
      .sort((a, b) => a.from.localeCompare(b.from))[0];
    const conflicts = group.conflicts?.length ? `; ${plural(group.conflicts.length, "conflict")}` : "";
    const where = `${plural(group.screens, "screen")}${group.timezone ? ` (${group.timezone})` : ""}`;
    if (!first) return `  ${where}: no imported level plays in the window${conflicts}`;
    const level = made.get(record.get(first.level_id) ?? "");
    return `  ${where}: ${level ? `${clip(level.content.name, 40)} ` : ""}plays ${clockText(first.from, group.timezone)} → ${clockText(first.to, group.timezone)}${conflicts}`;
  });
  return ["Calendar (the first span an imported level plays, per group of screens)", ...capped(lines, 12, "groups"), ...(preview.calendar?.truncated ? ["  More groups exist than the calendar lists."] : [])];
}

export interface PreviewContext {
  /** The file argument as typed, for the next-step command. */
  file: string;
  /** The --name in effect. */
  name: string;
  commit: boolean;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command that previews again, or with commit true commits. */
export function importCommand(context: Pick<PreviewContext, "file" | "name">, flags: { timezone?: string; codeField?: string }, commit: boolean): string {
  return [
    "screenrig schedule import", shellWord(context.file), "--name", shellWord(context.name),
    ...(flags.timezone ? ["--timezone", shellWord(flags.timezone)] : []),
    ...(flags.codeField ? ["--code-field", shellWord(flags.codeField)] : []),
    ...(commit ? ["--commit"] : []),
  ].join(" ");
}

/** The human text of a preview: header, row problems, levels, removals, calendar and the next step. */
export function previewLines(preview: ImportPreview, next: string): string[] {
  const summary = preview.summary;
  const counts = [
    summary.creates ? `${summary.creates} create` : "", summary.updates ? `${summary.updates} update` : "",
    summary.unchanged ? `${summary.unchanged} unchanged` : "", summary.removes ? `${summary.removes} remove` : "",
  ].filter(Boolean).join(", ");
  const lines = [
    `Import "${preview.name}": ${plural(summary.rows, "row")}, ${plural(summary.levels, "level")}${counts ? ` (${counts})` : ""}, ${plural(summary.screens, "screen")}${summary.playlists ? `, ${plural(summary.playlists, "playlist")} made` : ""}${summary.rows_with_errors ? `, ${plural(summary.rows_with_errors, "row")} with errors` : ""}`,
  ];
  const problems = [
    ...(preview.errors ?? []).map((problem) => rowProblemLine(undefined, problem)),
    ...[...preview.rows].sort((a, b) => a.row - b.row).flatMap((row) => [
      ...(row.errors ?? []).map((problem) => rowProblemLine(row.row, problem)),
      ...(row.warnings ?? []).map((problem) => rowProblemLine(row.row, problem, true)),
    ]),
  ];
  if (problems.length) lines.push("", ...capped(problems, 200, "problems"));
  if (preview.levels.length) {
    const names = screenNames(preview);
    lines.push("", ...capped(table(["ACTION", "WHERE", "CONTENT", "WHEN", "PRIORITY"], preview.levels.map((level) => [
      level.action,
      level.home === "screen" ? `screen ${clip(names.get(level.key) ?? level.screen_id ?? "", 40)}` : `shared (${plural(level.screens, "screen")})`,
      clip(level.content.name, 40), whenText(level), String(level.priority),
    ])), 101, "levels"));
  }
  if (preview.removals.length) {
    lines.push("", "Removed because the sheet no longer has them:", ...capped(preview.removals.map((removal) => `  ${removalText(removal)}`), 50, "removals"));
  }
  const calendar = calendarLines(preview);
  if (calendar.length) lines.push("", ...calendar);
  lines.push("", next);
  return lines;
}

/** The human text of an applied commit. */
export function appliedLine(name: string, applied: ImportSummary): string {
  if (!applied.creates && !applied.updates && !applied.removes) {
    return `Import "${name}" applied: nothing changed, every level already matches the sheet.`;
  }
  return `Import "${name}" applied: ${applied.creates} created, ${applied.updates} updated, ${applied.unchanged} unchanged, ${applied.removes} removed; ${plural(applied.screens, "screen")} written${applied.playlists ? `, ${plural(applied.playlists, "playlist")} made` : ""}. Screens switch within a minute.`;
}

/** The idempotency key of a commit: the same name and previewed fingerprint always send the same key, so a rerun of an interrupted run is safe. */
export function importIdempotencyKey(name: string, fingerprint: string): string {
  return `sch-imp-${createHash("sha256").update(`schedule-import\0${name}\0${fingerprint}`).digest("hex").slice(0, 48)}`;
}

/** Map the import problems to actionable guidance; exit codes stay status-derived (409 → 5, 422 → 8). */
export function scheduleImportProblem(error: unknown, rerun: string, stdin: boolean): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.next) return error;
  if (problem.code === "schedule_import_stale") {
    return new CliError({
      ...problem,
      next: {
        command: rerun,
        reason: stdin
          ? "The screens, media or levels changed since the preview, so nothing was written. Pipe the same sheet again with --commit: the run previews again first."
          : "The screens, media or levels changed since the preview, so nothing was written. Run it again: the run previews again before it commits.",
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "schedule_import_invalid") {
    return new CliError({
      ...problem,
      next: { command: rerun.replace(/ --commit$/, ""), reason: "Some rows have errors, so nothing was written. Run it without --commit to list the rows to correct." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "invalid_request") {
    return new CliError({
      ...problem,
      next: { command: "screenrig schedule template --output schedule.csv", reason: "The sheet could not be read. Start from the template: one row per screen and file, with a header row." },
    }, error.exitCode, error.warnings);
  }
  return error;
}

async function importCall(client: ApiClient, request: Parameters<ApiClient["call"]>[0], rerun: string, stdin: boolean): Promise<TransportResponse> {
  try {
    return await client.call(request);
  } catch (error) {
    throw scheduleImportProblem(error, rerun, stdin);
  }
}

export const handleScheduleImport = commandHandler(async (args: ParsedArgs, runtime: CliRuntime, resolved) => {
  const file = args.positionals[2] ?? "";
  const commit = flagBool(args.flags, "commit");
  const flagName = flagString(args.flags, "name");
  const timezone = flagString(args.flags, "timezone");
  const codeField = flagString(args.flags, "code-field");
  if (flagName !== undefined) scheduleImportName(flagName);
  const sheet = await readImportSheet(file, runtime);
  let name = flagName?.trim();
  if (name === undefined && sheet.defaultName) {
    try {
      name = scheduleImportName(sheet.defaultName);
    } catch {
      throw usageError(`The file name ${sheet.defaultName} cannot be the import's name (1 to ${SCHEDULE_IMPORT_NAME_MAX} characters). Pass --name NAME.`);
    }
  }
  const stdin = file === "-";
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const parameters: ImportParameters = { name, timezone, codeField };
  const label = name ?? "import";
  const rerun = importCommand({ file, name: label }, { timezone, codeField }, true);
  const timeout_ms = (typeof args.flags.timeout === "string" ? Number(args.flags.timeout) : 0) || IMPORT_TIMEOUT_MS;

  runtime.stderr.write(`Checking ${file === "-" ? "the sheet from stdin" : file} against the project...\n`);
  const previewRequest = importRequest(sheet, parameters);
  const previewResponse = await importCall(client, { method: "POST", path: PREVIEW_PATH, timeout_ms, ...previewRequest }, rerun, stdin);
  const preview = previewResponse.body as ImportPreview;
  const importName = preview.name || label;
  const context = { file, name: importName };
  const flags = { timezone, codeField };

  if (!preview.valid) {
    return {
      envelope: jsonBody(previewResponse, client.requestId, {
        ...(commit ? { committed: false } : {}),
        next: { command: importCommand(context, flags, commit), reason: "Correct the rows listed in rows[].errors and errors, then run it again." },
      }),
      exitCode: SCHEDULE_IMPORT_NEEDS_CORRECTIONS,
      human: [...previewLines(preview, `Fix the rows above and run again.${commit ? " Nothing was committed." : ""}`)].join("\n"),
    };
  }

  const commitCommand = importCommand(context, flags, true);
  if (!commit) {
    return {
      envelope: jsonBody(previewResponse, client.requestId, { next: { command: commitCommand, reason: "The sheet is valid. Commit applies every level in one step, or none." } }),
      exitCode: ExitCode.Success,
      human: previewLines(preview, `Valid. Commit with: ${commitCommand}`).join("\n"),
    };
  }

  runtime.stderr.write(`The sheet is valid; committing import ${importName}...\n`);
  const request = importRequest(sheet, parameters, preview.fingerprint);
  const key = flagString(args.flags, "idempotency-key");
  const idempotencyKey = key && isValidIdempotencyKey(key) ? key : importIdempotencyKey(importName, preview.fingerprint);
  const response = await importCall(client, { method: "POST", path: COMMIT_PATH, timeout_ms, idempotent: true, idempotencyKey, ...request }, commitCommand, stdin);
  const committed = response.body as ImportCommitted;
  return {
    envelope: jsonBody(response, client.requestId, { committed: true }),
    exitCode: ExitCode.Success,
    human: [...previewLines(preview, appliedLine(importName, committed.applied))].join("\n"),
  };
});

async function writeOutputBytes(output: string, bytes: Uint8Array, overwrite: boolean): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  await assertOutputAvailable(output, overwrite);
  const temporary = `${output}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    await rename(temporary, output);
  } catch {
    throw usageError("Cannot create output; check that the directory is writable.");
  } finally {
    await rm(temporary, { force: true });
  }
}

export const handleScheduleTemplate = commandHandler(async (args: ParsedArgs, runtime: CliRuntime, resolved): Promise<CommandResult> => {
  const format = flagString(args.flags, "format") ?? "csv";
  const outputFlag = flagString(args.flags, "output");
  const overwrite = flagBool(args.flags, "overwrite");
  if (format === "xlsx" && !outputFlag) throw usageError("--format xlsx writes a workbook: give --output FILE.");
  const output = outputFlag ? path.resolve(runtime.cwd(), outputFlag) : undefined;
  if (output) await assertOutputAvailable(output, overwrite);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "GET", path: TEMPLATE_PATH, query: { format }, binary: true,
    headers: { accept: `${CSV_TYPE}, ${XLSX_TYPE};q=0.9, */*;q=0.1` },
  });
  const bytes = response.body instanceof Uint8Array ? response.body : new TextEncoder().encode(String(response.body ?? ""));
  const requestId = response.headers["x-request-id"] ?? client.requestId;
  if (!output) {
    const content = new TextDecoder().decode(bytes);
    return {
      envelope: successEnvelope({ format, content }, { request_id: requestId }),
      exitCode: ExitCode.Success,
      human: content.trimEnd(),
    };
  }
  await writeOutputBytes(output, bytes, overwrite);
  return {
    envelope: successEnvelope({ format, output, bytes: bytes.length, next: { command: `screenrig schedule import ${shellWord(output)}`, reason: "Fill one row per screen and file, then preview the sheet." } }, { request_id: requestId }),
    exitCode: ExitCode.Success,
    human: `Wrote the ${format.toUpperCase()} template to ${output}. Fill one row per screen and file, then run: screenrig schedule import ${shellWord(output)}`,
  };
});
