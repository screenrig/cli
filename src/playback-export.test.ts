import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { createMemoryLogger } from "./log/logger.js";
import { run, type CliRuntime } from "./main.js";
import { CsvRecordCounter, csvCells, playbackExportBudget, playsRange } from "./playback-export.js";
import { networkError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { openTempFile, shellQuote, tempPathFor } from "./temp-file.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const NOW = new Date("2026-08-14T17:00:00.000Z");
const DAY = ["--from", "2026-08-14T00:00:00Z", "--to", "2026-08-15T00:00:00Z"];
const PLAY_HEADER = "screen_id,playlist_id,page_id,primitive_id,media_id,primitive,started_at,received_at";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number };
  warnings?: Array<{ code: string; message: string }>;
}

interface Env { fs: ConfigFs; cwd: string }

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<Env> {
  const configDir = await testTemp("playback-cfg-");
  const cwd = await testTemp("playback-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, extra: Partial<CliRuntime> = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport, ...extra,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* CSV or human output */ }
  return { code, stdout: text, stderr: await errP, envelope };
}

const playsCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => call.path === "/api/v1/playback/plays");

test("playsRange normalizes to UTC, defaults to the last 24 hours, and bounds 31 days", () => {
  assert.deepEqual(playsRange(undefined, undefined, NOW), { from: "2026-08-13T17:00:00Z", to: "2026-08-14T17:00:00Z" });
  assert.deepEqual(playsRange("7d", "now", NOW), { from: "2026-08-07T17:00:00Z", to: "2026-08-14T17:00:00Z" });
  assert.deepEqual(playsRange("2026-08-14T00:00:00-07:00", "2h", NOW), { from: "2026-08-14T07:00:00Z", to: "2026-08-14T15:00:00Z" });
  assert.deepEqual(playsRange("31d", undefined, NOW).from, "2026-07-14T17:00:00Z", "exactly 31 days is allowed");
  assert.throws(() => playsRange("32d", undefined, NOW), /at most 31 days/);
  assert.throws(() => playsRange("2026-08-14T00:00:00Z", "2026-08-14T00:00:00Z", NOW), /before --to/);
  assert.throws(() => playsRange("2026-08-14", undefined, NOW), /RFC 3339/);
  assert.throws(() => playsRange("2026-02-30T00:00:00Z", undefined, NOW), /RFC 3339/);
  assert.throws(() => playsRange("1w", undefined, NOW), /RFC 3339/);
});

test("CsvRecordCounter counts records across chunk splits and quoted newlines", () => {
  const counter = new CsvRecordCounter();
  const body = Buffer.from(`a,b\r\n"x\r\ny",1\r\n"q""",2\r\n`);
  for (let offset = 0; offset < body.length; offset += 3) counter.push(body.subarray(offset, offset + 3));
  assert.equal(counter.rows, 2);
  assert.equal(counter.header, "a,b");
  assert.deepEqual(csvCells(counter.last!), ["q\"", "2"]);
  assert.equal(counter.complete, true);
  counter.push(Buffer.from("tail"));
  assert.equal(counter.complete, false);
});

test("playback plays JSON sends the resolved window, filters, cursor, and a next command", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW });
  const page = await cli(["--json", "playback", "plays", "--from", "2026-08-14T09:00:00+02:00", "--to", "2026-08-15T00:00:00Z", "--screen-id", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--limit", "2"], transport, env);
  assert.equal(page.code, ExitCode.Success, page.stdout);
  assert.deepEqual(playsCalls(transport)[0]?.query, {
    from: "2026-08-14T07:00:00Z", to: "2026-08-15T00:00:00Z", screen_id: "scr_PAIRINGAAAAAAAAAAAAAAAA", media_id: undefined, tag: undefined, limit: "2",
  });
  assert.equal(page.envelope.data.items.length, 2);
  assert.equal(page.envelope.data.next_cursor, "pc_2");
  assert.equal(page.envelope.data.from, "2026-08-14T07:00:00Z");
  assert.deepEqual(page.envelope.data.next.argv, [
    "playback", "plays", "--from", "2026-08-14T07:00:00Z", "--to", "2026-08-14T16:59:55Z", "--screen-id", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--cursor", "pc_2", "--limit", "2",
  ]);
  assert.equal(page.envelope.data.items[0].screen_tags, undefined);

  const second = await cli(["--json", ...page.envelope.data.next.argv], transport, env);
  assert.equal(second.code, ExitCode.Success, second.stdout);
  assert.equal(playsCalls(transport)[1]?.query?.cursor, "pc_2");
  assert.equal(second.envelope.data.next_cursor, null);
  assert.equal(second.envelope.data.next, undefined);

  const defaults = await cli(["--json", "playback", "plays", "--tag", "Lobby"], transport, env);
  assert.equal(defaults.code, ExitCode.Success, defaults.stdout);
  assert.equal(playsCalls(transport)[2]?.query?.from, "2026-08-13T17:00:00Z");
  assert.equal(playsCalls(transport)[2]?.query?.to, "2026-08-14T17:00:00Z");
  assert.deepEqual(defaults.envelope.data.items.map((play: { screen_id: string }) => play.screen_id), ["scr_LOBBYBBBBBBBBBBBBBBBBBB"]);
});

test("playback plays --all follows next_cursor and stops at the page cap with a warning", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW });
  const all = await cli(["--json", "playback", "plays", ...DAY, "--limit", "2", "--all"], transport, env);
  assert.equal(all.code, ExitCode.Success, all.stdout);
  assert.equal(all.envelope.data.items.length, 5);
  assert.equal(all.envelope.data.pages, 3);
  assert.equal(all.envelope.data.next_cursor, null);
  assert.deepEqual(all.envelope.warnings, []);
  const defaultLimit = await cli(["--json", "playback", "plays", ...DAY, "--all"], transport, env);
  assert.equal(playsCalls(transport).at(-1)?.query?.limit, "1000", "--all asks for full pages");
  assert.equal(defaultLimit.envelope.data.pages, 1);

  const endless = new FakeTransport();
  let served = 0;
  endless.on("GET", "/api/v1/playback/plays", () => {
    served += 1;
    return { status: 200, headers: {}, body: { items: [{ screen_id: "scr_A", page_id: "p", media_id: "med_A", primitive: "image", received_at: "2026-08-14T16:00:00Z" }], next_cursor: `pc_${served}` } };
  });
  const capped = await cli(["--json", "playback", "plays", ...DAY, "--all"], endless, env);
  assert.equal(capped.code, ExitCode.Success, capped.stdout);
  assert.equal(served, 50);
  assert.equal(capped.envelope.data.items.length, 50);
  assert.equal(capped.envelope.data.next_cursor, "pc_50");
  assert.equal(capped.envelope.warnings?.[0]?.code, "playback_plays_truncated");
  assert.ok(capped.envelope.data.next.argv.includes("pc_50"));
});

test("playback plays refuses bad windows, cursors, and flag mixes before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW });
  for (const argv of [
    ["--from", "40d"],
    ["--from", "2026-08-14T00:00:00Z", "--to", "2026-08-13T00:00:00Z"],
    ["--from", "yesterday"],
    ["--cursor", "abc"],
    ["--limit", "0"],
    ["--limit", "1001"],
    ["--tag", "no spaces"],
    ["--screen-id", "med_AAAAAAAAAAAAAAAAAAAAAAAA"],
    ["--format", "csv", "--limit", "10"],
    ["--format", "csv", "--all"],
    ["--output", "plays.json"],
    ["--format", "xml"],
  ]) {
    const result = await cli(["--json", "playback", "plays", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
  }
  assert.equal(playsCalls(transport).length, 0);
});

test("playback plays --format csv streams to a file atomically and reports path, bytes, rows, sha256", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW });
  const { logger, events } = createMemoryLogger({ command: ["playback", "plays"] });
  const result = await cli(["--json", "playback", "plays", ...DAY, "--format", "csv", "--output", "exports/plays.csv"], transport, env);
  // exports/ does not exist: the temp file cannot be created, a file error.
  assert.equal(result.code, ExitCode.Unexpected, result.stdout);
  assert.equal(result.envelope.error?.code, "file_error");
  assert.match(result.envelope.error!.detail, /ENOENT/);
  await mkdir(path.join(env.cwd, "exports"));
  const ok = await cli(["--json", "playback", "plays", ...DAY, "--format", "csv", "--output", "exports/plays.csv"], transport, env, { logger });
  assert.equal(ok.code, ExitCode.Success, ok.stdout);
  const file = path.join(env.cwd, "exports", "plays.csv");
  const bytes = await readFile(file);
  assert.equal(ok.envelope.data.path, file);
  assert.equal(ok.envelope.data.rows, 5);
  assert.equal(ok.envelope.data.bytes, bytes.byteLength);
  assert.equal(ok.envelope.data.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(ok.envelope.data.last_received_at, "2026-08-14T16:40:00Z");
  assert.equal(ok.envelope.data.from, "2026-08-14T00:00:00Z");
  const text = bytes.toString("utf8");
  assert.ok(text.startsWith(`${PLAY_HEADER}\r\n`));
  assert.match(text, /,'=hero,/, "formula-guarded cell kept verbatim");
  assert.doesNotMatch(ok.stdout, /scr_PAIRING|hero/, "CSV never reaches the envelope");
  assert.deepEqual((await readdir(path.join(env.cwd, "exports"))).sort(), ["plays.csv"], "no temp file left");
  const call = playsCalls(transport).at(-1)!;
  assert.equal(call.query?.format, "csv");
  assert.equal(call.query?.limit, undefined);
  assert.equal(call.timeout_ms, 0, "no whole-transfer deadline");
  assert.equal(call.idle_timeout_ms, 60_000);
  assert.equal(call.label, "Playback export");
  assert.ok(events.length > 0);
  assert.doesNotMatch(JSON.stringify(events), /hero|scr_PAIRING/, "CSV bytes stay out of the operation log");

  const defaultName = await cli(["--json", "playback", "plays", ...DAY, "--format", "csv"], transport, env);
  assert.equal(defaultName.envelope.data.path, path.join(env.cwd, "playback-plays.csv"));
  const empty = await cli(["--json", "playback", "plays", "--from", "2026-08-01T00:00:00Z", "--to", "2026-08-02T00:00:00Z", "--format", "csv", "--output", "empty.csv"], transport, env);
  assert.equal(empty.envelope.data.rows, 0);
  assert.equal(empty.envelope.data.last_received_at, undefined);
});

test("a CSV stream that ends mid-row or is not CSV leaves the existing file untouched", async () => {
  const env = await enrolled();
  const target = path.join(env.cwd, "plays.csv");
  await writeFile(target, "previous export\r\n");
  const truncated = new FakeTransport().onDownload("GET", "/api/v1/playback/plays", () => ({
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8" },
    body: { async *[Symbol.asyncIterator]() { yield Buffer.from(`${PLAY_HEADER}\r\nscr_A,pl_A,page`); } },
  }));
  const cut = await cli(["--json", "playback", "plays", ...DAY, "--format", "csv", "--output", "plays.csv"], truncated, env);
  assert.equal(cut.code, ExitCode.Network, cut.stdout);
  assert.match(cut.envelope.error!.detail, /middle of a row/);
  assert.equal(await readFile(target, "utf8"), "previous export\r\n");
  assert.deepEqual(await readdir(env.cwd), ["plays.csv"]);

  const html = new FakeTransport().onDownload("GET", "/api/v1/playback/plays", () => ({
    status: 200, headers: { "content-type": "text/html" }, body: { async *[Symbol.asyncIterator]() { yield Buffer.from("<html>"); } },
  }));
  const wrong = await cli(["--json", "playback", "plays", ...DAY, "--format", "csv", "--output", "plays.csv"], html, env);
  assert.equal(wrong.code, ExitCode.Unexpected, wrong.stdout);
  assert.equal(wrong.envelope.error?.code, "unexpected_response");
  assert.equal(await readFile(target, "utf8"), "previous export\r\n");

  const refused = new FakeTransport().onDownload("GET", "/api/v1/playback/plays", () => ({
    status: 400,
    headers: { "content-type": "application/problem+json" },
    problem: { type: "https://screenrig.ai/problems/invalid_request", title: "Invalid request", status: 400, code: "invalid_request", detail: "the range from to to must be at most 31 days" },
  }));
  const problem = await cli(["--json", "playback", "plays", ...DAY, "--format", "csv", "--output", "plays.csv"], refused, env);
  assert.equal(problem.envelope.error?.code, "invalid_request");
  assert.equal(await readFile(target, "utf8"), "previous export\r\n");
});

test("--output - writes only the CSV to stdout", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW });
  const piped = await cli(["--json", "playback", "plays", ...DAY, "--tag", "Lobby", "--format", "csv", "--output", "-"], transport, env);
  assert.equal(piped.code, ExitCode.Success, piped.stderr);
  assert.equal(piped.stdout, `${PLAY_HEADER}\r\nscr_LOBBYBBBBBBBBBBBBBBBBBB,pl_AAAAAAAAAAAAAAAAAAAAAAAA,poster,,med_BBBBBBBBBBBBBBBBBBBBBBBB,image,,2026-08-14T16:30:00Z\r\n`);
  assert.deepEqual(await readdir(env.cwd), []);

  const truncated = new FakeTransport().onDownload("GET", "/api/v1/playback/plays", () => ({
    status: 200,
    headers: { "content-type": "text/csv" },
    body: { async *[Symbol.asyncIterator]() { yield Buffer.from(`${PLAY_HEADER}\r\nscr_A`); } },
  }));
  const cut = await cli(["--json", "playback", "plays", ...DAY, "--format", "csv", "--output", "-"], truncated, env);
  assert.equal(cut.code, ExitCode.Network);
  assert.equal(cut.stdout, `${PLAY_HEADER}\r\nscr_A`, "no envelope is appended to partial CSV");
  assert.match(cut.stderr, /incomplete export/);
});

test("playback list --format csv exports the daily aggregates", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW });
  const result = await cli(["--json", "playback", "list", "--screen-id", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--format", "csv", "--output", "daily.csv"], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(result.envelope.data.rows, 1);
  assert.equal(result.envelope.data.path, path.join(env.cwd, "daily.csv"));
  assert.equal(result.envelope.data.from, undefined);
  const text = await readFile(path.join(env.cwd, "daily.csv"), "utf8");
  assert.ok(text.startsWith("screen_id,media_id,filename,primitive,day,play_count,"));
  const call = transport.calls.find((item) => item.path === "/api/v1/playback" && item.query?.format === "csv");
  assert.equal(call?.query?.screen_id, "scr_PAIRINGAAAAAAAAAAAAAAAA");
  const refused = await cli(["--json", "playback", "list", "--output", "daily.csv"], transport, env);
  assert.equal(refused.code, ExitCode.Usage);
  const json = await cli(["--json", "playback", "list", "--format", "json"], transport, env);
  assert.equal(json.envelope.data.items.length, 1);
});

test("playback help names the billing rule and the CSV output contract", async () => {
  const env = await enrolled();
  const help = await cli(["--human", "playback", "plays", "--help"], memoryBackend(), env);
  assert.match(help.stdout, /billed/);
  assert.match(help.stdout, /--format <FORMAT>/);
  assert.match(help.stdout, /31 days/);
});

test("a CSV stream that fails partway keeps the complete rows beside the target and says how to resume", async () => {
  const env = await enrolled();
  const target = path.join(env.cwd, "plays.csv");
  await writeFile(target, "previous export\r\n");
  await writeFile(`${target}.partial`, "older partial\r\n");
  await writeFile(path.join(env.cwd, "plays-rest.csv"), "older rest\r\n");
  const rows = [
    "scr_A,pl_A,clip,,med_A,video,,2026-08-14T16:00:00Z",
    "scr_A,pl_A,poster,,med_B,image,,2026-08-14T16:10:00.250Z",
  ];
  const aborted = new FakeTransport().onDownload("GET", "/api/v1/playback/plays", () => ({
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8" },
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(`${PLAY_HEADER}\r\n${rows[0]}\r\n${rows[1]}\r\nscr_A,pl_`);
        throw networkError("Playback export stream failed");
      },
    },
  }));
  const failed = await cli(["--json", "playback", "plays", ...DAY, "--tag", "Lobby", "--format", "csv", "--output", "plays.csv"], aborted, env);
  assert.equal(failed.code, ExitCode.Network, failed.stdout);
  assert.equal(await readFile(target, "utf8"), "previous export\r\n", "the target is never replaced by a partial stream");
  assert.equal(await readFile(`${target}.partial`, "utf8"), "older partial\r\n", "an earlier partial is never overwritten");
  assert.equal(await readFile(`${target}.partial-2`, "utf8"), `${PLAY_HEADER}\r\n${rows[0]}\r\n${rows[1]}\r\n`, "only complete rows are kept");
  assert.deepEqual((await readdir(env.cwd)).sort(), ["plays-rest.csv", "plays.csv", "plays.csv.partial", "plays.csv.partial-2"]);
  const error = failed.envelope.error as { detail: string; next?: { argv?: string[]; reason: string } };
  assert.match(error.detail, /2 complete rows received are in .*plays\.csv\.partial-2/);
  assert.match(error.detail, /Playback export stream failed/);
  assert.deepEqual(error.next?.argv, [
    "playback", "plays", "--from", "2026-08-14T16:10:00.250Z", "--to", "2026-08-15T00:00:00Z", "--tag", "Lobby",
    "--format", "csv", "--output", path.join(env.cwd, "plays-rest-2.csv"),
  ]);
  assert.match(error.next!.reason, /drop the repeats/);

  const headerOnly = new FakeTransport().onDownload("GET", "/api/v1/playback", () => ({
    status: 200,
    headers: { "content-type": "text/csv" },
    body: { async *[Symbol.asyncIterator]() { yield Buffer.from("screen_id,media_id\r\n"); throw networkError("stream failed"); } },
  }));
  const daily = await cli(["--json", "playback", "list", "--day-from", "2026-08-01", "--format", "csv", "--output", "daily.csv"], headerOnly, env);
  assert.equal(daily.code, ExitCode.Network, daily.stdout);
  assert.deepEqual((daily.envelope.error as { next?: { argv?: string[] } }).next?.argv, [
    "playback", "list", "--day-from", "2026-08-01", "--format", "csv", "--output", path.join(env.cwd, "daily.csv"),
  ]);
  assert.deepEqual((await readdir(env.cwd)).sort(), ["plays-rest.csv", "plays.csv", "plays.csv.partial", "plays.csv.partial-2"], "nothing kept without a complete row");

  const piped = new FakeTransport().onDownload("GET", "/api/v1/playback/plays", () => ({
    status: 200,
    headers: { "content-type": "text/csv" },
    body: { async *[Symbol.asyncIterator]() { yield Buffer.from(`${PLAY_HEADER}\r\n${rows[0]}\r\n`); throw networkError("stream failed"); } },
  }));
  const stdout = await cli(["--json", "playback", "plays", ...DAY, "--format", "csv", "--output", "-"], piped, env);
  assert.equal(stdout.code, ExitCode.Network);
  assert.equal(stdout.stdout, `${PLAY_HEADER}\r\n${rows[0]}\r\n`);
  assert.match(stdout.stderr, /incomplete export/);
  assert.match(stdout.stderr, /next: screenrig playback plays --from 2026-08-14T16:00:00Z .*--output -$/m);
});

test("--all stops before the playback export budget runs out and a 429 keeps its retry hint", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW });
  transport.setPlaybackExportBudget!(2);
  const stopped = await cli(["--json", "playback", "plays", ...DAY, "--limit", "2", "--all"], transport, env);
  assert.equal(stopped.code, ExitCode.Success, stopped.stdout);
  assert.equal(stopped.envelope.data.pages, 2);
  assert.equal(stopped.envelope.data.items.length, 4);
  assert.equal(stopped.envelope.warnings?.[0]?.code, "playback_export_rate_limited");
  assert.match(stopped.envelope.warnings![0]!.message, /60 s/);
  assert.deepEqual(stopped.envelope.data.next.argv.slice(-5), ["--cursor", "pc_4", "--limit", "2", "--all"]);
  assert.equal(playsCalls(transport).length, 2, "no request is spent into a 429");

  const refused = await cli(["--json", "playback", "plays", ...DAY], transport, env);
  assert.equal(refused.code, ExitCode.RateLimited, refused.stdout);
  assert.equal(refused.envelope.error?.code, "rate_limited");
  assert.equal((refused.envelope.error as { retry_after_seconds?: number }).retry_after_seconds, 42);
  const csv = await cli(["--json", "playback", "plays", ...DAY, "--format", "csv", "--output", "plays.csv"], transport, env);
  assert.equal(csv.code, ExitCode.RateLimited, csv.stdout);
  assert.deepEqual(await readdir(env.cwd), []);

  const flaky = new FakeTransport();
  let calls = 0;
  flaky.on("GET", "/api/v1/playback/plays", (): TransportResponse => {
    calls += 1;
    if (calls === 1) {
      return { status: 200, headers: {}, body: { items: [{ screen_id: "scr_A", page_id: "p", media_id: "med_A", primitive: "image", received_at: "2026-08-14T16:00:00Z" }], next_cursor: "pc_1" } };
    }
    return {
      status: 429,
      headers: { "content-type": "application/problem+json", "retry-after": "17" },
      body: { type: "https://screenrig.ai/problems/rate_limited", title: "Too many requests", status: 429, detail: "Slow down.", code: "rate_limited" },
    };
  });
  const partial = await cli(["--json", "playback", "plays", ...DAY, "--all"], flaky, env);
  assert.equal(partial.code, ExitCode.Success, partial.stdout);
  assert.equal(partial.envelope.data.items.length, 1);
  assert.equal(partial.envelope.data.next_cursor, "pc_1");
  assert.match(partial.envelope.warnings![0]!.message, /17 s/);
});

test("playback list takes an inclusive --day-from/--day-to range of at most 366 days", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW });
  const ranged = await cli(["--json", "playback", "list", "--day-from", "2026-08-01", "--day-to", "2026-08-14"], transport, env);
  assert.equal(ranged.code, ExitCode.Success, ranged.stdout);
  const call = transport.calls.filter((item) => item.path === "/api/v1/playback").at(-1)!;
  assert.equal(call.query?.day_from, "2026-08-01");
  assert.equal(call.query?.day_to, "2026-08-14");
  assert.equal(ranged.envelope.data.items.length, 1);
  const csv = await cli(["--json", "playback", "list", "--day-to", "2026-08-13", "--format", "csv", "--output", "daily.csv"], transport, env);
  assert.equal(csv.envelope.data.rows, 0);
  for (const argv of [
    ["--day", "2026-08-14", "--day-from", "2026-08-01"],
    ["--day-from", "2026-08-15", "--day-to", "2026-08-14"],
    ["--day-from", "2025-08-13", "--day-to", "2026-08-14"],
    ["--day-from", "2026-02-30"],
  ]) {
    const result = await cli(["--json", "playback", "list", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
  }
  const yearLeap = await cli(["--json", "playback", "list", "--day-from", "2025-08-14", "--day-to", "2026-08-14"], transport, env);
  assert.equal(yearLeap.code, ExitCode.Success, "366 inclusive days are allowed");
});

test("playbackExportBudget reads the tightest playback-export member", () => {
  assert.deepEqual(playbackExportBudget('"project-read";r=0;t=5, "playback-export-project";r=3;t=40, "playback-export-ip";r=50;t=40'), { remaining: 3, resetSeconds: 40 });
  assert.equal(playbackExportBudget('"service";r=0;t=9'), undefined);
  assert.equal(playbackExportBudget(undefined), undefined);
});

test("data.to reports the effective end, at most 5 seconds before now, and next keeps it", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW });
  const page = await cli(["--json", "playback", "plays", "--from", "2026-08-14T16:00:00Z", "--limit", "1"], transport, env);
  assert.equal(page.code, ExitCode.Success, page.stdout);
  assert.equal(playsCalls(transport)[0]?.query?.to, "2026-08-14T17:00:00Z");
  assert.equal(page.envelope.data.to, "2026-08-14T16:59:55Z");
  assert.ok(page.envelope.data.next.argv.includes("2026-08-14T16:59:55Z"));
  const past = await cli(["--json", "playback", "plays", ...DAY], transport, env);
  assert.equal(past.envelope.data.to, "2026-08-14T16:59:55Z", "a future --to is clamped too");
  const early = await cli(["--json", "playback", "plays", "--from", "2026-08-14T00:00:00Z", "--to", "2026-08-14T12:00:00Z"], transport, env);
  assert.equal(early.envelope.data.to, "2026-08-14T12:00:00Z");
  const csv = await cli(["--json", "playback", "plays", "--from", "1h", "--format", "csv", "--output", "p.csv"], transport, env);
  assert.equal(csv.envelope.data.to, "2026-08-14T16:59:55Z");
  assert.deepEqual(await readdir(env.cwd), ["p.csv"], "no temp file is left beside the export");
});

test("temp files are exclusive, private, hidden beside the target, and removed on SIGTERM", async () => {
  const dir = await testTemp("temp-file-");
  const target = path.join(dir, "plays.csv");
  const first = tempPathFor(target);
  assert.equal(path.dirname(first), dir);
  assert.match(path.basename(first), /^\.plays\.csv\.[0-9a-f]{16}\.part$/);
  assert.notEqual(first, tempPathFor(target));
  const temp = await openTempFile(target);
  assert.equal((await stat(temp.path)).mode & 0o777, 0o600);
  await temp.handle.close();
  const keepAlive = () => undefined;
  process.on("SIGTERM", keepAlive);
  try {
    process.emit("SIGTERM", "SIGTERM");
  } finally {
    process.removeListener("SIGTERM", keepAlive);
  }
  await assert.rejects(stat(temp.path), /ENOENT/);
  temp.release();
  assert.equal(shellQuote(["playback", "plays", "--output", "my file's.csv"]), "playback plays --output 'my file'\\''s.csv'");
});
