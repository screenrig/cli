import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help.js";
import { run, type CliRuntime } from "./main.js";
import {
  appliedLine, importIdempotencyKey, importRowsFromJson, type ImportCommitted, type ImportPreview, previewLines, rowProblemLine,
  SCHEDULE_IMPORT_NEEDS_CORRECTIONS,
} from "./schedule-import.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; next?: { command: string; reason: string } };
}

interface Env { fs: ConfigFs; cwd: string; configPath: string }

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<Env> {
  const configDir = await testTemp("schedule-import-cfg-");
  const cwd = await testTemp("schedule-import-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, stdin?: string | Buffer): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr,
    now: () => new Date("2026-10-29T17:00:00.000Z"),
    sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
    ...(stdin !== undefined ? { stdin: Readable.from([stdin]), isStdinTty: () => false } : {}),
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  const err = await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, stderr: err, envelope };
}

const ok = (body: unknown, headers: Record<string, string> = {}): TransportResponse => ({ status: 200, headers: { "content-type": "application/json", ...headers }, body });
const problem = (status: number, code: string, detail: string): TransportResponse => ({
  status, headers: { "content-type": "application/problem+json" },
  body: { type: `https://screenrig.ai/problems/${code.replaceAll("_", "-")}`, title: code, status, detail, code },
});

const SUMMARY = { rows: 3, rows_with_errors: 0, levels: 3, creates: 2, updates: 1, unchanged: 0, removes: 1, screens: 2, playlists: 2 };

function validPreview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    name: "spring", source: "spring.csv", valid: true, fingerprint: "fp_1234567890abcdef", summary: SUMMARY,
    rows: [
      { row: 2, status: "ok", level: "a", target: { kind: "screen", id: "scr_LOBBY", name: "Lobby 1" }, content: { kind: "file", id: "med_A", name: "welcome.jpg" } },
      { row: 3, status: "ok", level: "b", target: { kind: "folder", id: "sfd_A", name: "Casino Floor", screens: 4 }, content: { kind: "file", id: "med_B", name: "happy-hour.mp4" }, warnings: [{ column: "end", code: "open_end", message: "No end time, so it plays until the date closes." }] },
    ],
    levels: [
      { key: "a", action: "create", home: "screen", screen_id: "scr_LOBBY", entry_id: "imp_a", content: { kind: "file", id: "med_A", name: "welcome.jpg" }, screens: 1, priority: 0, from: "2026-11-05T18:00", until: "2026-11-08T02:00", rows: [2] },
      { key: "b", action: "update", home: "shared", campaign_id: "cmp_B", name: "Happy hour", content: { kind: "file", id: "med_B", name: "happy-hour.mp4" }, screens: 4, priority: 5, from: "2026-11-05T00:00", until: "2026-12-01T00:00", rows: [3] },
    ],
    removals: [{ home: "shared", campaign_id: "cmp_OLD", name: "Old promo" }],
    calendar: {
      groups: [{
        screens: 1, timezone: "America/Los_Angeles",
        levels: [{ id: "schedule:imp_a", record_id: "imp_a" }],
        spans: [{ level_id: "schedule:imp_a", from: "2026-11-06T02:00:00Z", to: "2026-11-08T10:00:00Z", state: "plays" }],
        conflicts: [],
      }],
    },
    ...overrides,
  };
}

function invalidPreview(): ImportPreview {
  return validPreview({
    valid: false,
    summary: { ...SUMMARY, rows_with_errors: 2 },
    rows: [
      { row: 7, status: "error", errors: [{ column: "content", code: "unknown_file", message: "No file or playlist is named \"x.jpg\"." }] },
      { row: 9, status: "error", errors: [{ column: "target", code: "unknown_screen", message: "No screen matches \"LOBBY-9\"." }, { code: "no_timing", message: "The row has no start or end." }] },
    ],
  });
}

const importCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => call.path.startsWith("/api/schedule/imports"));
const bytesOf = (body: unknown): string => Buffer.from(body as Uint8Array).toString("utf8");

function backend(preview: ImportPreview = validPreview()): FakeTransport {
  const committed: ImportCommitted = { preview, applied: { ...SUMMARY, rows_with_errors: 0 } };
  return new FakeTransport()
    .on("POST", "/api/schedule/imports/preview", () => ok(preview))
    .on("POST", "/api/schedule/imports", () => ok(committed));
}

const SHEET = "Screen,File,Start,End\nLOBBY-01,welcome.jpg,2026-11-05 18:00,2026-11-08 02:00\n";

test("a CSV sheet with row errors prints each error by column and exits 8 without writing", async () => {
  const env = await enrolled();
  await writeFile(path.join(env.cwd, "spring.csv"), SHEET);
  const transport = backend(invalidPreview());
  const human = await cli(["--human", "schedule", "import", "spring.csv"], transport, env);
  assert.equal(human.code, SCHEDULE_IMPORT_NEEDS_CORRECTIONS);
  assert.equal(human.code, ExitCode.Client);
  const lines = human.stdout.split("\n");
  assert.ok(lines.includes("row 7 · File · No file or playlist is named \"x.jpg\"."), human.stdout);
  assert.ok(lines.includes("row 9 · Screen · No screen matches \"LOBBY-9\"."), human.stdout);
  assert.ok(lines.includes("row 9 · The row has no start or end."), human.stdout);
  assert.match(lines.find((line) => line.startsWith("Import"))!, /^Import "spring": 3 rows, 3 levels \(2 create, 1 update, 1 remove\), 2 screens, 2 playlists made, 2 rows with errors$/);
  assert.equal(lines.at(-2), "Fix the rows above and run again.");
  assert.doesNotMatch(human.stdout, /Valid\. Commit with/);

  const calls = importCalls(transport);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["POST /api/schedule/imports/preview"], "only the preview is called");
  assert.equal(calls[0]!.headers?.["content-type"], "text/csv");
  assert.equal(bytesOf(calls[0]!.body), SHEET, "the file goes as raw bytes");
  assert.equal(calls[0]!.query?.name, "spring", "--name defaults to the file name without its extension");
  assert.equal(calls[0]!.query?.source, "spring.csv");
  assert.equal(calls[0]!.query?.fingerprint, undefined);
  assert.equal(calls[0]!.headers?.["idempotency-key"], undefined, "a preview is a read");

  const json = await cli(["schedule", "import", "spring.csv"], backend(invalidPreview()), env);
  assert.equal(json.code, 8);
  assert.equal(json.envelope.ok, true);
  assert.equal(json.envelope.data.valid, false);
  assert.equal(json.envelope.data.rows[0].errors[0].column, "content");
  assert.equal(json.envelope.data.next.command, "screenrig schedule import spring.csv --name spring");
  assert.match(json.stderr, /Checking spring\.csv/);
  assert.doesNotMatch(json.stdout, /secretsecret/);
});

test("a valid preview prints the levels, removals and calendar, and names the commit command", async () => {
  const env = await enrolled();
  await writeFile(path.join(env.cwd, "spring.csv"), SHEET);
  const transport = backend(validPreview({ name: "Spring promos" }));
  const human = await cli(["--human", "schedule", "import", "spring.csv", "--name", "Spring promos", "--timezone", "America/Los_Angeles"], transport, env);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /^create\s+screen Lobby 1\s+welcome\.jpg\s+2026-11-05 18:00 → 2026-11-08 02:00\s+0$/m);
  assert.match(human.stdout, /^update\s+shared \(4 screens\)\s+happy-hour\.mp4\s+2026-11-05 00:00 → 2026-12-01 00:00\s+5$/m);
  assert.match(human.stdout, /row 3 · End · warning: No end time/);
  assert.match(human.stdout, /Removed because the sheet no longer has them:\n {2}shared "Old promo"/);
  assert.match(human.stdout, /1 screen \(America\/Los_Angeles\): welcome\.jpg plays 2026-11-05 18:00 → 2026-11-08 02:00/);
  assert.equal(human.stdout.trimEnd().split("\n").at(-1), "Valid. Commit with: screenrig schedule import spring.csv --name 'Spring promos' --timezone America/Los_Angeles --commit");
  assert.equal(importCalls(transport).length, 1, "no commit without --commit");
  assert.equal(importCalls(transport)[0]!.query?.name, "Spring promos");
  assert.equal(importCalls(transport)[0]!.query?.timezone, "America/Los_Angeles");

  const json = await cli(["schedule", "import", "spring.csv"], backend(), env);
  assert.equal(json.code, 0);
  assert.equal(json.envelope.data.valid, true);
  assert.equal(json.envelope.data.fingerprint, "fp_1234567890abcdef");
  assert.equal(json.envelope.data.next.command, "screenrig schedule import spring.csv --name spring --commit");
});

test("--commit previews, then commits with the preview's fingerprint and a deterministic idempotency key", async () => {
  const env = await enrolled();
  await writeFile(path.join(env.cwd, "spring.csv"), SHEET);
  const transport = backend();
  const first = await cli(["--human", "schedule", "import", "spring.csv", "--code-field", "room_id", "--commit"], transport, env);
  assert.equal(first.code, 0, first.stdout);
  const calls = importCalls(transport);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["POST /api/schedule/imports/preview", "POST /api/schedule/imports"]);
  const commit = calls[1]!;
  assert.equal(commit.headers?.["content-type"], "text/csv");
  assert.equal(bytesOf(commit.body), SHEET);
  assert.deepEqual({ name: commit.query?.name, fingerprint: commit.query?.fingerprint, code_field: commit.query?.code_field, source: commit.query?.source },
    { name: "spring", fingerprint: "fp_1234567890abcdef", code_field: "room_id", source: "spring.csv" });
  const key = commit.headers?.["idempotency-key"];
  assert.equal(key, importIdempotencyKey("spring", "fp_1234567890abcdef"));
  assert.match(key!, /^[A-Za-z0-9._~-]{8,200}$/);
  assert.match(first.stdout, /Import "spring" applied: 2 created, 1 updated, 0 unchanged, 1 removed; 2 screens written, 2 playlists made\./);
  assert.match(first.stdout, /^create {2}screen Lobby 1/m, "the preview is printed before the result");
  assert.match(first.stderr, /committing import spring/);

  const again = await cli(["schedule", "import", "spring.csv", "--code-field", "room_id", "--commit"], transport, env);
  assert.equal(again.code, 0);
  assert.equal(again.envelope.data.committed, true);
  assert.equal(again.envelope.data.applied.creates, 2);
  assert.equal(again.envelope.data.preview.fingerprint, "fp_1234567890abcdef");
  assert.equal(importCalls(transport)[3]!.headers?.["idempotency-key"], key, "a rerun of the identical command sends the same key");
  assert.notEqual(importIdempotencyKey("spring", "other"), key);
});

test("--commit with row errors commits nothing and exits 8", async () => {
  const env = await enrolled();
  await writeFile(path.join(env.cwd, "spring.csv"), SHEET);
  const transport = backend(invalidPreview());
  const result = await cli(["schedule", "import", "spring.csv", "--commit"], transport, env);
  assert.equal(result.code, 8);
  assert.equal(result.envelope.data.valid, false);
  assert.equal(result.envelope.data.committed, false);
  assert.deepEqual(importCalls(transport).map((call) => call.path), ["/api/schedule/imports/preview"]);
  const human = await cli(["--human", "schedule", "import", "spring.csv", "--commit"], transport, env);
  assert.equal(human.code, 8);
  assert.match(human.stdout, /Fix the rows above and run again\. Nothing was committed\.\n$/);
});

test("a stale refusal explains that the run previews again", async () => {
  const env = await enrolled();
  await writeFile(path.join(env.cwd, "spring.csv"), SHEET);
  const transport = new FakeTransport()
    .on("POST", "/api/schedule/imports/preview", () => ok(validPreview()))
    .on("POST", "/api/schedule/imports", () => problem(409, "schedule_import_stale", "The screens, media or levels changed since the preview, so nothing was written."));
  const result = await cli(["schedule", "import", "spring.csv", "--commit"], transport, env);
  assert.equal(result.code, ExitCode.Conflict);
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.error?.code, "schedule_import_stale");
  assert.equal(result.envelope.error?.next?.command, "screenrig schedule import spring.csv --name spring --commit");
  assert.match(result.envelope.error?.next?.reason ?? "", /previews again/);

  const refused = new FakeTransport()
    .on("POST", "/api/schedule/imports/preview", () => ok(validPreview()))
    .on("POST", "/api/schedule/imports", () => problem(422, "schedule_import_invalid", "Some rows have errors, so nothing was written."));
  const invalid = await cli(["--human", "schedule", "import", "spring.csv", "--commit"], refused, env);
  assert.equal(invalid.code, 8);
  assert.match(invalid.stderr, /schedule_import_invalid|Some rows have errors/);
  assert.match(invalid.stderr, /screenrig schedule import spring\.csv --name spring(\s|$)/);
});

test("the template downloads to --output, refuses to overwrite and prints CSV without --output", async () => {
  const env = await enrolled();
  const template = "Screen,File,Start,End\nLOBBY-01,welcome-spring.jpg,2026-11-05 18:00,2026-11-08 02:00\n";
  const transport = new FakeTransport().on("GET", "/api/schedule/imports/template", (req) => ({
    status: 200,
    headers: { "content-type": req.query?.format === "xlsx" ? XLSX : "text/csv; charset=utf-8" },
    body: req.query?.format === "xlsx" ? new Uint8Array([0x50, 0x4b, 3, 4, 9]) : new TextEncoder().encode(template),
  }));
  const saved = await cli(["schedule", "template", "--output", "out/schedule.csv"], transport, env);
  assert.equal(saved.code, 0, saved.stdout);
  const output = path.join(env.cwd, "out", "schedule.csv");
  assert.equal(saved.envelope.data.output, output);
  assert.equal(saved.envelope.data.format, "csv");
  assert.equal(await readFile(output, "utf8"), template);
  assert.equal(importCalls(transport)[0]!.query?.format, "csv");
  assert.equal(importCalls(transport)[0]!.binary, true);

  await writeFile(output, "mine\n");
  const calls = importCalls(transport).length;
  const refused = await cli(["schedule", "template", "--output", "out/schedule.csv"], transport, env);
  assert.equal(refused.code, ExitCode.Usage);
  assert.match(refused.envelope.error?.detail ?? "", /already exists/);
  assert.equal(await readFile(output, "utf8"), "mine\n", "the existing file is untouched");
  assert.equal(importCalls(transport).length, calls, "refused before any request");

  const replaced = await cli(["schedule", "template", "--output", "out/schedule.csv", "--overwrite"], transport, env);
  assert.equal(replaced.code, 0);
  assert.equal(await readFile(output, "utf8"), template);

  const workbook = await cli(["schedule", "template", "--format", "xlsx", "--output", "book.xlsx"], transport, env);
  assert.equal(workbook.code, 0);
  assert.deepEqual([...(await readFile(path.join(env.cwd, "book.xlsx")))], [0x50, 0x4b, 3, 4, 9]);
  assert.equal(importCalls(transport).at(-1)!.query?.format, "xlsx");

  const bare = await cli(["schedule", "template", "--format", "xlsx"], transport, env);
  assert.equal(bare.code, ExitCode.Usage);
  const printed = await cli(["--human", "schedule", "template"], transport, env);
  assert.equal(printed.code, 0);
  assert.ok(printed.stdout.endsWith(`${template}`), printed.stdout);
  const data = await cli(["schedule", "template"], transport, env);
  assert.equal(data.envelope.data.content, template);
  const overwriteOnly = await cli(["schedule", "template", "--overwrite"], transport, env);
  assert.equal(overwriteOnly.code, ExitCode.Usage);
});

test("a JSON rows file sends its rows as a JSON body with the name, zone and source", async () => {
  const env = await enrolled();
  const rows = [{ target: "LOBBY-01", content: "welcome.jpg", start: "2026-11-05 18:00", end: "2026-11-08", priority: 3, days: null }];
  await writeFile(path.join(env.cwd, "plan.json"), JSON.stringify(rows));
  await writeFile(path.join(env.cwd, "wrapped.json"), JSON.stringify({ rows }));
  const transport = backend();
  const array = await cli(["schedule", "import", "plan.json", "--timezone", "UTC", "--code-field", "code"], transport, env);
  assert.equal(array.code, 0, array.stdout);
  const wrapped = await cli(["schedule", "import", "wrapped.json", "--name", "Wrapped"], transport, env);
  assert.equal(wrapped.code, 0, wrapped.stdout);
  const [first, second] = importCalls(transport);
  assert.equal(first!.headers?.["content-type"], "application/json");
  assert.deepEqual(first!.body, { name: "plan", source: "plan.json", timezone: "UTC", code_field: "code", rows });
  assert.equal(first!.query, undefined);
  assert.deepEqual(second!.body, { name: "Wrapped", source: "wrapped.json", rows });

  const commit = await cli(["schedule", "import", "plan.json", "--commit"], transport, env);
  assert.equal(commit.code, 0);
  assert.deepEqual(importCalls(transport).at(-1)!.body, { name: "plan", source: "plan.json", fingerprint: "fp_1234567890abcdef", rows }, "the commit repeats the sheet and its name");

  await writeFile(path.join(env.cwd, "bad.json"), JSON.stringify([{ target: { nested: 1 } }]));
  const bad = await cli(["schedule", "import", "bad.json"], transport, env);
  assert.equal(bad.code, ExitCode.Usage);
  assert.match(bad.envelope.error?.detail ?? "", /JSON row 1, column target/);
});

test("the content type follows the extension: xlsx workbooks go as raw bytes", async () => {
  const env = await enrolled();
  const workbook = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.from([0, 1, 2, 255, 254])]);
  await writeFile(path.join(env.cwd, "Spring Promos.XLSX"), workbook);
  const transport = backend();
  const result = await cli(["schedule", "import", "Spring Promos.XLSX"], transport, env);
  assert.equal(result.code, 0, result.stdout);
  const call = importCalls(transport)[0]!;
  assert.equal(call.headers?.["content-type"], XLSX);
  assert.deepEqual([...(call.body as Uint8Array)], [...workbook], "binary bytes are not re-encoded");
  assert.equal(call.query?.name, "Spring Promos");
  assert.equal(call.query?.source, "Spring Promos.XLSX");
  assert.match(result.envelope.data.next.command, /^screenrig schedule import 'Spring Promos\.XLSX' --name spring --commit$/);
});

test("- reads JSON rows or CSV text from stdin", async () => {
  const env = await enrolled();
  const transport = backend();
  const rows = [{ screen: "LOBBY-01", file: "welcome.jpg", from: "2026-11-05", until: "2026-11-06" }];
  const json = await cli(["schedule", "import", "-", "--name", "From stdin"], transport, env, JSON.stringify(rows));
  assert.equal(json.code, 0, json.stdout);
  assert.deepEqual(importCalls(transport)[0]!.body, { name: "From stdin", rows });
  const csv = await cli(["schedule", "import", "-", "--name", "From stdin"], transport, env, SHEET);
  assert.equal(csv.code, 0, csv.stdout);
  assert.equal(importCalls(transport)[1]!.headers?.["content-type"], "text/csv");
  assert.equal(bytesOf(importCalls(transport)[1]!.body), SHEET);
  assert.equal(importCalls(transport)[1]!.query?.source, undefined);
  const book = await cli(["schedule", "import", "-", "--name", "Book"], transport, env, Buffer.from("PK\x03\x04abc", "latin1"));
  assert.equal(book.code, 0);
  assert.equal(importCalls(transport)[2]!.headers?.["content-type"], XLSX);
  const unnamed = await cli(["schedule", "import", "-"], transport, env, SHEET);
  assert.equal(unnamed.envelope.data.next.command, "screenrig schedule import - --name spring --commit", "the preview's name is the one to commit under");
});

test("unreadable input and bad options are usage errors that send nothing", async () => {
  const env = await enrolled();
  const transport = backend();
  await writeFile(path.join(env.cwd, "notes.txt"), "x");
  await writeFile(path.join(env.cwd, "empty.csv"), "");
  await writeFile(path.join(env.cwd, `${"n".repeat(81)}.csv`), SHEET);
  for (const [argv, detail] of [
    [["schedule", "import", "missing.csv"], /missing\.csv does not exist/],
    [["schedule", "import", "notes.txt"], /not a \.csv, \.xlsx or \.json file/],
    [["schedule", "import", "empty.csv"], /empty\.csv is empty/],
    [["schedule", "import", `${"n".repeat(81)}.csv`], /Pass --name NAME/],
    [["schedule", "import", "empty.csv", "--name", " "], /--name must contain 1 to 80 characters/],
    [["schedule", "import", "empty.csv", "--timezone", "Mars/Base"], /IANA time zone/],
    [["schedule", "import"], /requires <file>|missing required argument/i],
  ] as Array<[string[], RegExp]>) {
    const result = await cli(argv, transport, env);
    assert.equal(result.code, ExitCode.Usage, argv.join(" "));
    assert.match(result.envelope.error?.detail ?? result.stdout, detail, argv.join(" "));
  }
  assert.equal(importCalls(transport).length, 0);
});

test("the sheet-wide problems, columns and warnings render as lines", () => {
  assert.equal(rowProblemLine(7, { column: "daily_start", code: "invalid_time", message: "must be a time of day" }), "row 7 · Daily start · must be a time of day");
  assert.equal(rowProblemLine(undefined, { code: "limit", message: "more than 5,000 rows" }), "file · more than 5,000 rows");
  assert.equal(rowProblemLine(4, { column: "end", code: "open_end", message: "plays until close" }, true), "row 4 · End · warning: plays until close");
  const lines = previewLines(validPreview({ errors: [{ code: "limit", message: "A screen holds at most 32 levels." }], removals: [], calendar: undefined }), "next");
  assert.ok(lines.includes("file · A screen holds at most 32 levels."));
  assert.equal(lines.at(-1), "next");
  assert.equal(appliedLine("x", { ...SUMMARY, creates: 0, updates: 0, removes: 0 }), "Import \"x\" applied: nothing changed, every level already matches the sheet.");
  assert.deepEqual(importRowsFromJson("[{\"target\":\"a\"}]"), [{ target: "a" }]);
  assert.throws(() => importRowsFromJson("{\"rows\":[]}"), /lists no rows/);
  assert.throws(() => importRowsFromJson("{\"nope\":1}"), /array of row objects/);
  assert.throws(() => importRowsFromJson("[1]"), /JSON row 1 must be an object/);
});

test("schedule help names the sheet format, the exit codes and how to recover", () => {
  assert.ok(commandHelp().commands.some((command) => command.name === "schedule"));
  assert.deepEqual(commandHelp(["schedule"]).commands.map((command) => command.name), ["import", "template"]);
  const importHelp = commandHelp(["schedule", "import"]);
  for (const text of [/target/, /folder:NAME/, /tag:NAME/, /playlist:NAME/, /daily_start/, /a date alone as the end closes that day/, /each screen's own clock/, /become one level/, /same name updates|importing again under the same name updates/, /write access/, /exit 8/, /schedule_import_stale \(exit 5\)/, /Idempotency-Key/]) {
    assert.match(importHelp.usage, text);
  }
  assert.deepEqual(importHelp.options.map((option) => option.name).filter((name) => name.startsWith("--") && !["--json", "--human"].includes(name)).slice(0, 4), ["--name", "--timezone", "--code-field", "--commit"]);
  assert.ok(importHelp.examples.length >= 4);
  const template = commandHelp(["schedule", "template"]);
  assert.deepEqual(template.relationships, [{ kind: "requires", options: ["--overwrite", "--output"] }]);
  assert.ok(template.examples.length >= 2);
});
