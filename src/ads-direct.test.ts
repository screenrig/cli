import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { commandHelp } from "./help.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { csvRecord } from "./playback-export.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest } from "./transport/types.js";

const API_URL = "https://api.screenrig.ai";
const TOKEN = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
const HEADERS = { "cache-control": "private, no-store" };
const DIRECT = "/api/advertising/direct-campaigns";

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

function realFs(home: string): ConfigFs {
  return { mkdir, open, rename, rm, chmod, stat, homedir: () => home, env: { XDG_CONFIG_HOME: home } };
}

async function withRuntime(argv: string[], transport: FakeTransport, configDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const fsLike = realFs(configDir);
  const runtime: CliRuntime = {
    argv, env: fsLike.env, stdout, stderr,
    now: () => new Date("2026-10-27T12:00:00.000Z"), sleep: async () => undefined,
    homedir: fsLike.homedir, cwd: () => configDir, fs: fsLike, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: await outP, stderr: await errP };
}

async function enrolled(configDir: string): Promise<void> {
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: API_URL, token: TOKEN, project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization" },
    realFs(configDir),
  );
}

const DRAFT = {
  name: "Brand X November", advertiser: "Brand X", category: "quick_service_restaurants",
  flight_start: "2026-11-01T00:00:00Z", flight_end: "2026-12-01T00:00:00Z", goal_plays: 200000,
  price: { model: "cpm", amount: "12.50", currency: "USD" }, media_ids: ["med_AAAAAAAAAAAAAAAAAAAAAAAA"],
  tags: ["downtown"], dayparts: [{ days: ["mon", "tue"], start: "11:00", end: "14:00" }], overbook: false,
};

const CAMPAIGN = { id: "adc_TEST", revision: 2, name: "Brand X November", state: "active", pace: { status: "on_pace", expected_plays: 10 } };

const REPORT = {
  campaign_id: "adc_TEST", name: "Brand X November", advertiser: "Brand X", from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z",
  goal_plays: 200000, delivered_plays: 24, plays: 24, played_ms: 240000, not_played: 1,
  value: { model: "cpm", amount: "0.30", currency: "USD" },
  rows: [
    { day: "2026-11-01", screen_id: "scr_A", slot_id: "ads_A", media_id: "med_A", plays: 12, played_ms: 120000 },
    { day: "2026-11-02", screen_id: "scr_B", slot_id: "ads_B", media_id: "med,\"B\"", plays: 12, played_ms: 120000 },
  ],
  truncated: false,
};

function directTransport(): FakeTransport {
  const ok = (body: unknown, status = 200) => ({ status, headers: HEADERS, body });
  return new FakeTransport()
    .on("GET", DIRECT, () => ok({ direct_campaigns: [CAMPAIGN] }))
    .on("POST", DIRECT, (request) => ok({ ...(request.body as object), id: "adc_NEW", revision: 1 }, 201))
    .on("GET", `${DIRECT}/adc_TEST`, () => ok(CAMPAIGN))
    .on("POST", `${DIRECT}/adc_TEST`, (request) => ok({ ...(request.body as object), id: "adc_TEST", revision: 3 }))
    .on("POST", `${DIRECT}/adc_TEST/pause`, () => ok({ ...CAMPAIGN, state: "paused", revision: 3 }))
    .on("POST", `${DIRECT}/adc_TEST/resume`, () => ok({ ...CAMPAIGN, revision: 4 }))
    .on("POST", `${DIRECT}/adc_TEST/end`, () => ok({ ...CAMPAIGN, state: "ended", revision: 5 }))
    .on("GET", `${DIRECT}/adc_TEST/report`, () => ok(REPORT))
    .on("POST", "/api/advertising/availability", () => ok({ estimated_plays: 1200000, booked_plays: 300000, available_plays: 900000, screens: 40 }))
    .on("GET", "/api/advertising/reports/fill", () => ok({ from: "2026-10-20T12:00:00Z", to: "2026-10-27T12:00:00Z", occurrences: 1000, direct: 100, marketplace: 300, vast: 50, unfilled: 550, fill_rate: 0.45, unfilled_reasons: { no_demand: 400, separated: 20 }, days: [] }));
}

async function withDir<T>(prefix: string, body: (configDir: string) => Promise<T>): Promise<T> {
  const configDir = await testTemp(prefix);
  await enrolled(configDir);
  try {
    return await body(configDir);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

const lastCall = (transport: FakeTransport): TransportRequest => transport.calls.at(-1)!;

test("ads direct list and show read the direct campaign routes", async () => {
  await withDir("ads-direct-read-", async (configDir) => {
    const transport = directTransport();
    const list = await withRuntime(["--json", "ads", "direct", "list"], transport, configDir);
    assert.equal(list.code, ExitCode.Success, list.stdout);
    assert.deepEqual(JSON.parse(list.stdout).data.direct_campaigns, [CAMPAIGN]);
    assert.equal(lastCall(transport).method, "GET");
    assert.equal(lastCall(transport).path, DIRECT);
    const show = await withRuntime(["--json", "ads", "direct", "show", "adc_TEST"], transport, configDir);
    assert.equal(show.code, ExitCode.Success, show.stdout);
    assert.equal(lastCall(transport).path, `${DIRECT}/adc_TEST`);
    assert.equal(JSON.parse(show.stdout).data.id, "adc_TEST");
  });
});

test("ads direct create sends the draft with an Idempotency-Key and update sends If-Match", async () => {
  await withDir("ads-direct-write-", async (configDir) => {
    const transport = directTransport();
    const file = path.join(configDir, "direct.json");
    await writeFile(file, JSON.stringify(DRAFT));
    const created = await withRuntime(["--json", "ads", "direct", "create", file], transport, configDir);
    assert.equal(created.code, ExitCode.Success, created.stdout);
    let call = lastCall(transport);
    assert.equal(call.method, "POST");
    assert.equal(call.path, DIRECT);
    assert.deepEqual(call.body, DRAFT);
    assert.match(call.headers?.["idempotency-key"] ?? "", /\S/);
    assert.equal(call.headers?.["if-match"], undefined);

    const updated = await withRuntime(["--json", "ads", "direct", "update", "adc_TEST", file, "--expect-rev", "2"], transport, configDir);
    assert.equal(updated.code, ExitCode.Success, updated.stdout);
    call = lastCall(transport);
    assert.equal(call.method, "POST");
    assert.equal(call.path, `${DIRECT}/adc_TEST`);
    assert.deepEqual(call.body, DRAFT);
    assert.equal(call.headers?.["if-match"], '"2"');
  });
});

test("ads direct pause, resume and end post the transition with If-Match and no body", async () => {
  await withDir("ads-direct-state-", async (configDir) => {
    const transport = directTransport();
    for (const verb of ["pause", "resume", "end"]) {
      const result = await withRuntime(["--json", "ads", "direct", verb, "adc_TEST", "--expect-rev", "2"], transport, configDir);
      assert.equal(result.code, ExitCode.Success, `${verb}: ${result.stdout}`);
      const call = lastCall(transport);
      assert.equal(call.method, "POST", verb);
      assert.equal(call.path, `${DIRECT}/adc_TEST/${verb}`);
      assert.equal(call.headers?.["if-match"], '"2"', verb);
      assert.equal(call.body, undefined, verb);
    }
  });
});

test("ads direct availability posts the query document as a read", async () => {
  await withDir("ads-direct-availability-", async (configDir) => {
    const transport = directTransport();
    const query = { tags: ["downtown"], flight_start: "2026-11-01T00:00:00Z", flight_end: "2026-12-01T00:00:00Z", exclude_campaign_id: "adc_TEST" };
    const file = path.join(configDir, "query.json");
    await writeFile(file, JSON.stringify(query));
    const result = await withRuntime(["--json", "ads", "direct", "availability", file], transport, configDir);
    assert.equal(result.code, ExitCode.Success, result.stdout);
    const call = lastCall(transport);
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/api/advertising/availability");
    assert.deepEqual(call.body, query);
    assert.equal(call.headers?.["idempotency-key"], undefined);
    assert.equal(JSON.parse(result.stdout).data.available_plays, 900000);
  });
});

test("ads direct report resolves --from and --to into the query and prints JSON by default", async () => {
  await withDir("ads-direct-report-json-", async (configDir) => {
    const transport = directTransport();
    const whole = await withRuntime(["--json", "ads", "direct", "report", "adc_TEST"], transport, configDir);
    assert.equal(whole.code, ExitCode.Success, whole.stdout);
    assert.equal(lastCall(transport).path, `${DIRECT}/adc_TEST/report`);
    assert.deepEqual(lastCall(transport).query ?? {}, {});
    assert.equal(JSON.parse(whole.stdout).data.plays, 24);
    const windowed = await withRuntime(["--json", "ads", "direct", "report", "adc_TEST", "--from", "7d", "--to", "2026-10-27T10:00:00-07:00"], transport, configDir);
    assert.equal(windowed.code, ExitCode.Success, windowed.stdout);
    assert.deepEqual(lastCall(transport).query, { from: "2026-10-20T12:00:00Z", to: "2026-10-27T17:00:00Z" });
  });
});

test("ads direct report --format csv writes the rows to a file and to stdout", async () => {
  await withDir("ads-direct-report-csv-", async (configDir) => {
    const transport = directTransport();
    const expected = [
      "day,screen_id,slot_id,media_id,plays,played_ms",
      "2026-11-01,scr_A,ads_A,med_A,12,120000",
      "2026-11-02,scr_B,ads_B,\"med,\"\"B\"\"\",12,120000",
    ].map((line) => `${line}\r\n`).join("");
    const file = path.join(configDir, "report.csv");
    const written = await withRuntime(["--json", "ads", "direct", "report", "adc_TEST", "--format", "csv", "--output", file], transport, configDir);
    assert.equal(written.code, ExitCode.Success, written.stdout);
    assert.equal(await readFile(file, "utf8"), expected);
    const data = JSON.parse(written.stdout).data;
    assert.equal(data.rows, 2);
    assert.equal(data.path, file);
    assert.equal(data.content_type, "text/csv");
    assert.equal(data.bytes, Buffer.byteLength(expected));
    assert.equal(written.stdout.includes("scr_A"), false, "the CSV is not in the envelope");

    const streamed = await withRuntime(["--json", "ads", "direct", "report", "adc_TEST", "--format", "csv", "--output", "-"], transport, configDir);
    assert.equal(streamed.code, ExitCode.Success, `${streamed.stderr}${streamed.stdout}`);
    assert.equal(streamed.stdout, expected);

    const defaulted = await withRuntime(["--json", "ads", "direct", "report", "adc_TEST", "--format", "csv"], transport, configDir);
    assert.equal(defaulted.code, ExitCode.Success, defaulted.stdout);
    assert.equal(JSON.parse(defaulted.stdout).data.path, path.join(configDir, "direct-report-adc_TEST.csv"));
  });
});

test("ads direct report CSV is only the header for a campaign with no rows, and a truncated report warns", async () => {
  await withDir("ads-direct-report-empty-", async (configDir) => {
    const transport = new FakeTransport().on("GET", `${DIRECT}/adc_TEST/report`, () => ({ status: 200, headers: HEADERS, body: { ...REPORT, rows: [], truncated: true } }));
    const file = path.join(configDir, "empty.csv");
    const result = await withRuntime(["--json", "ads", "direct", "report", "adc_TEST", "--format", "csv", "--output", file], transport, configDir);
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.equal(await readFile(file, "utf8"), "day,screen_id,slot_id,media_id,plays,played_ms\r\n");
    assert.equal(JSON.parse(result.stdout).warnings[0].code, "direct_report_truncated");
  });
});

test("ads reports fill sends the window and defaults to the server window", async () => {
  await withDir("ads-reports-fill-", async (configDir) => {
    const transport = directTransport();
    const defaulted = await withRuntime(["--json", "ads", "reports", "fill"], transport, configDir);
    assert.equal(defaulted.code, ExitCode.Success, defaulted.stdout);
    assert.equal(lastCall(transport).path, "/api/advertising/reports/fill");
    assert.deepEqual(lastCall(transport).query ?? {}, {});
    assert.equal(JSON.parse(defaulted.stdout).data.fill_rate, 0.45);
    const windowed = await withRuntime(["--json", "ads", "reports", "fill", "--from", "14d", "--to", "now"], transport, configDir);
    assert.equal(windowed.code, ExitCode.Success, windowed.stdout);
    assert.deepEqual(lastCall(transport).query, { from: "2026-10-13T12:00:00Z", to: "2026-10-27T12:00:00Z" });
  });
});

test("ads direct and fill refuse bad input before any request", async () => {
  await withDir("ads-direct-refuse-", async (configDir) => {
    const transport = directTransport();
    const write = async (name: string, value: unknown): Promise<string> => {
      const file = path.join(configDir, name);
      await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
      return file;
    };
    const { name: _name, ...noName } = DRAFT;
    const { advertiser: _advertiser, ...noAdvertiser } = DRAFT;
    for (const argv of [
      ["ads", "direct", "create", await write("array.json", [])],
      ["ads", "direct", "create", await write("garbage.json", "{nope")],
      ["ads", "direct", "create", await write("no-name.json", noName)],
      ["ads", "direct", "create", await write("no-media.json", { ...DRAFT, media_ids: [] })],
      ["ads", "direct", "create", await write("no-advertiser.json", noAdvertiser)],
      ["ads", "direct", "create", await write("goal.json", { ...DRAFT, goal_plays: -1 })],
      ["ads", "direct", "create", await write("overbook.json", { ...DRAFT, overbook: "yes" })],
      ["ads", "direct", "create", path.join(configDir, "missing.json")],
      ["ads", "direct", "availability", await write("list.json", [])],
      ["ads", "direct", "update", "adc_TEST", await write("ok.json", DRAFT)],
      ["ads", "direct", "update", "adc_TEST", await write("ok2.json", DRAFT), "--expect-rev", "zero"],
      ["ads", "direct", "pause", "adc_TEST"],
      ["ads", "direct", "end", "adc_TEST"],
      ["ads", "direct", "report", "adc_TEST", "--output", "report.csv"],
      ["ads", "direct", "report", "adc_TEST", "--format", "xml"],
      ["ads", "direct", "report", "adc_TEST", "--from", "yesterday"],
      ["ads", "direct", "report", "adc_TEST", "--from", "now", "--to", "7d"],
      ["ads", "reports", "fill", "--from", "40d", "--to", "now"],
      ["ads", "reports", "fill", "--from", "now", "--to", "now"],
    ]) {
      const result = await withRuntime(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    }
    assert.equal(transport.calls.length, 0);
  });
});

test("goal_overbooked is rendered with a hint and a next command, and a server hint wins", async () => {
  await withDir("ads-direct-overbooked-", async (configDir) => {
    const problem = (extra: Record<string, unknown>) => ({
      status: 409, headers: { "content-type": "application/problem+json" },
      body: { type: "https://screenrig.ai/problems/goal-overbooked", title: "Goal overbooked", status: 409, detail: "The goal exceeds the availability estimate.", code: "goal_overbooked", ...extra },
    });
    const file = path.join(configDir, "direct.json");
    await writeFile(file, JSON.stringify(DRAFT));
    const local = new FakeTransport().on("POST", DIRECT, () => problem({}));
    const result = await withRuntime(["--json", "ads", "direct", "create", file], local, configDir);
    assert.equal(result.code, ExitCode.Conflict, result.stdout);
    const error = JSON.parse(result.stdout).error;
    assert.equal(error.code, "goal_overbooked");
    assert.equal(error.next.command, "screenrig ads direct availability --help");
    assert.match(error.hint, /overbook/);
    const server = new FakeTransport().on("POST", DIRECT, () => problem({ hint: "Server hint." }));
    const served = await withRuntime(["--json", "ads", "direct", "create", file], server, configDir);
    assert.equal(JSON.parse(served.stdout).error.hint, "Server hint.");
  });
});

test("csvRecord quotes commas, quotes and line breaks", () => {
  assert.equal(csvRecord(["a", 1, undefined, null, "b,c", "d\"e", "f\ng"]), "a,1,,,\"b,c\",\"d\"\"e\",\"f\ng\"\r\n");
});

test("ads direct help states write scope and the contract", () => {
  const create = commandHelp(["ads", "direct", "create"]);
  assert.ok(create.examples.length > 0);
  assert.match(JSON.stringify(create), /goal_overbooked/);
  assert.match(JSON.stringify(create), /bill the advertiser|moves no money|Writes this project/);
  const report = commandHelp(["ads", "direct", "report"]);
  assert.ok(report.options.some((option) => option.name === "--format"));
  assert.ok(report.options.some((option) => option.name === "--output"));
  const update = commandHelp(["ads", "direct", "update"]);
  assert.ok(update.options.some((option) => option.name === "--expect-rev" && option.required));
  assert.ok(commandHelp(["ads", "reports", "fill"]).options.some((option) => option.name === "--from"));
});
