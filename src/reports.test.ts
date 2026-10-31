import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { reportCatalogLines, reportFilter, reportFilters, reportRecipients, reportTableLines, scheduleText, subscriptionLines } from "./reports.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const NOW = new Date("2026-10-29T17:00:00.000Z");
const SUB = "rsub_AAAAAAAAAAAAAAAAAAAAAA";

interface Envelope { ok: boolean; data?: any; error?: { code: string; detail: string }; warnings?: Array<{ code: string }> }
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
  const configDir = await testTemp("reports-cfg-");
  const cwd = await testTemp("reports-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env): Promise<{ code: number; stdout: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const runtime: CliRuntime = { argv, env: env.fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined, homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await out;
  await err;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, envelope };
}

const json = (body: unknown) => ({ status: 200, headers: { "content-type": "application/json" }, body, rawText: JSON.stringify(body) });
const file = (type: string, bytes: Buffer) => ({ status: 200, headers: { "content-type": type }, body: { async *[Symbol.asyncIterator]() { yield bytes; } } });

const TABLE = {
  kind: "fleet_health", title: "Fleet health by folder", from: "2026-09-30", to: "2026-10-29", truncated: false,
  columns: [{ key: "group", label: "Folder", type: "text" }, { key: "screens", label: "Screens", type: "int" }, { key: "availability", label: "Availability %", type: "percent" }],
  rows: [{ group: "All screens", screens: 4, availability: 99.5 }, { group: "Tower", screens: 2, availability: null }], totals: { screens: 4 },
};

test("reports show prints the table with its totals, and sends only the filters it was given", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("GET", "/api/reports/fleet_health", () => json(TABLE));
  const result = await cli(["--json", "reports", "show", "fleet_health", "--group-by", "screen", "--folder-id", "sfd_AAAAAAAAAAAAAAAAAAAAAA", "--direct", "--from", "2026-10-01"], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.deepEqual(JSON.parse(JSON.stringify(transport.calls[0]!.query)), { from: "2026-10-01", group_by: "screen", folder_id: "sfd_AAAAAAAAAAAAAAAAAAAAAA", direct: "true" });
  assert.equal(result.envelope.data.rows.length, 2);
  const lines = reportTableLines(TABLE);
  assert.deepEqual(lines.slice(0, 2), ["Fleet health by folder", "2026-09-30 to 2026-10-29"]);
  assert.match(lines.join("\n"), /Total\s+4/);
  assert.match(lines.join("\n"), /All screens\s+4\s+99\.50/);
});

test("a report file lands in the working directory with a default name, atomically, and a wrong type is refused", async () => {
  const env = await enrolled();
  const bytes = Buffer.from("%PDF-1.4 pretend");
  const transport = new FakeTransport().onDownload("GET", "/api/reports/fleet_health", (req) => {
    assert.equal(req.query?.format, "pdf");
    return file("application/pdf", bytes);
  });
  const done = await cli(["--json", "reports", "show", "fleet_health", "--format", "pdf", "--to", "2026-10-28"], transport, env);
  assert.equal(done.code, ExitCode.Success, done.stdout);
  assert.equal(done.envelope.data.path, path.join(env.cwd, "fleet-health-2026-10-28.pdf"));
  assert.equal(done.envelope.data.bytes, bytes.length);
  assert.equal(done.envelope.data.content_type, "application/pdf");
  assert.deepEqual(await readdir(env.cwd), ["fleet-health-2026-10-28.pdf"]);
  assert.equal(await readFile(path.join(env.cwd, "fleet-health-2026-10-28.pdf"), "utf8"), "%PDF-1.4 pretend");

  const wrong = new FakeTransport().onDownload("GET", "/api/reports/fleet_health", () => file("text/html", Buffer.from("<html>")));
  const refused = await cli(["--json", "reports", "show", "fleet_health", "--format", "pdf", "--output", "other.pdf"], wrong, env);
  assert.notEqual(refused.code, ExitCode.Success);
  assert.deepEqual((await readdir(env.cwd)).sort(), ["fleet-health-2026-10-28.pdf"], "nothing is left behind by a refused download");
});

test("the existing report commands take --format and ask the server for the file", async () => {
  const env = await enrolled();
  const asked: string[] = [];
  const transport = new FakeTransport().onDownload("GET", /^\/api\//, (req) => {
    asked.push(`${req.path}?${new URLSearchParams(req.query as Record<string, string>).toString()}`);
    return file(req.query?.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Buffer.from("x"));
  });
  for (const argv of [
    ["project", "uptime", "--format", "xlsx", "--output", "a.xlsx"], ["project", "health-trend", "--format", "pdf", "--output", "b.pdf"],
    ["alerts", "list", "--state", "all", "--format", "xlsx", "--output", "c.xlsx"], ["playback", "totals", "--format", "pdf", "--output", "d.pdf"],
    ["playback", "plays", "--from", "7d", "--format", "xlsx", "--output", "e.xlsx"],
  ]) {
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Success, `${argv.join(" ")}: ${result.stdout}`);
  }
  assert.deepEqual(asked.map((line) => line.split("&")[0]!.split("?")[0]), ["/api/uptime/daily", "/api/health/trend", "/api/alerts", "/api/playback/totals", "/api/playback/plays"]);
  assert.match(asked[2]!, /state=all/);
  assert.deepEqual((await readdir(env.cwd)).sort(), ["a.xlsx", "b.pdf", "c.xlsx", "d.pdf", "e.xlsx"]);
  const stray = await cli(["--json", "project", "uptime", "--output", "x.csv"], transport, env);
  assert.equal(stray.code, ExitCode.Usage, "--output without a file format is refused");
});

for (const format of ["xlsx", "pdf"] as const) {
  test(`playback plays ${format} exports preserve continuation cursors and filters`, async () => {
    const env = await enrolled();
    const contentType = format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const bytes = Buffer.from(`export-${format}`);
    const transport = new FakeTransport().onDownload("GET", "/api/playback/plays", () => file(contentType, bytes));
    for (const cursor of [undefined, "pc_NEXT"]) {
      const output = `${cursor ? "remaining" : "all"}.${format}`;
      const result = await cli([
        "--json", "playback", "plays",
        "--from", "2026-10-28T02:00:00+02:00", "--to", "2026-10-29T02:00:00+02:00",
        "--screen-id", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--media-id", "med_AAAAAAAAAAAAAAAAAAAAAA", "--tag", "Lobby",
        ...(cursor ? ["--cursor", cursor] : []), "--format", format, "--output", output,
      ], transport, env);
      assert.equal(result.code, ExitCode.Success, result.stdout);
      assert.deepEqual(JSON.parse(JSON.stringify(transport.calls.at(-1)!.query)), {
        from: "2026-10-28T00:00:00Z", to: "2026-10-29T00:00:00Z",
        screen_id: "scr_PAIRINGAAAAAAAAAAAAAAAA", media_id: "med_AAAAAAAAAAAAAAAAAAAAAA", tag: "Lobby",
        ...(cursor ? { cursor } : {}), format,
      });
      assert.equal(result.envelope.data.path, path.join(env.cwd, output));
      assert.deepEqual(await readFile(path.join(env.cwd, output)), bytes);
    }
    assert.equal(transport.calls.length, 2);
  });
}

test("subscriptions create, update, send and delete through the report-subscriptions routes", async () => {
  const env = await enrolled();
  const subscription = {
    id: SUB, name: "Monday", kind: "fleet_health", format: "pdf", enabled: true, filters: { group_by: "folder" }, revision: 1,
    schedule: { cadence: "weekly", weekday: "monday", hour: 7, timezone: "America/Los_Angeles" }, recipients: [{ user_id: "usr_A" }], next_run_at: "2026-11-02T15:00:00Z",
  };
  const transport = new FakeTransport()
    .on("POST", "/api/report-subscriptions", () => ({ ...json(subscription), status: 201 }))
    .on("PATCH", `/api/report-subscriptions/${SUB}`, () => json({ ...subscription, revision: 2, enabled: false }))
    .on("POST", `/api/report-subscriptions/${SUB}/send`, () => json({ ...subscription, last_status: "failed", last_error: "mail is not configured on this server" }))
    .on("DELETE", `/api/report-subscriptions/${SUB}`, () => ({ status: 204, headers: {}, body: undefined, rawText: "" }))
    .on("GET", "/api/report-subscriptions", () => json({ items: [subscription] }));
  const created = await cli(["--json", "reports", "subscriptions", "create", "--name", "Monday", "--kind", "fleet_health", "--cadence", "weekly", "--weekday", "monday", "--hour", "7",
    "--timezone", "America/Los_Angeles", "--format", "pdf", "--recipients", "ann@example.invalid, usr_A", "--filter", "group_by=folder", "--filter", "tag=Lobby"], transport, env);
  assert.equal(created.code, ExitCode.Success, created.stdout);
  const body = transport.calls.find((call) => call.method === "POST")!.body as Record<string, unknown>;
  assert.deepEqual(body, {
    name: "Monday", format: "pdf", recipients: ["ann@example.invalid", "usr_A"], filters: { group_by: "folder", tag: "Lobby" },
    schedule: { cadence: "weekly", weekday: "monday", hour: 7, timezone: "America/Los_Angeles" }, kind: "fleet_health",
  });
  const updated = await cli(["--json", "reports", "subscriptions", "update", SUB, "--pause", "--expect-rev", "1"], transport, env);
  assert.equal(updated.code, ExitCode.Success, updated.stdout);
  const patch = transport.calls.find((call) => call.method === "PATCH")!;
  assert.deepEqual(patch.body, { enabled: false });
  assert.equal(Object.entries(patch.headers ?? {}).find(([name]) => name.toLowerCase() === "if-match")?.[1], "\"1\"");
  const sent = await cli(["--human", "reports", "subscriptions", "send", SUB], transport, env);
  assert.match(sent.stdout, /Not delivered/);
  assert.match(sent.stdout, /failure: mail is not configured/);
  const listed = await cli(["--human", "reports", "subscriptions", "list"], transport, env);
  assert.match(listed.stdout, /Monday\s+fleet_health\s+weekly on monday at 07:00 America\/Los_Angeles\s+pdf/);
  const deleted = await cli(["--json", "reports", "subscriptions", "delete", SUB], transport, env);
  assert.equal(deleted.envelope.data.deleted, true);
  const none = await cli(["--json", "reports", "subscriptions", "update", SUB], transport, env);
  assert.equal(none.code, ExitCode.Usage);
  const bad = await cli(["--json", "reports", "subscriptions", "create", "--name", "x", "--kind", "uptime", "--cadence", "daily", "--format", "doc", "--recipients", "a"], transport, env);
  assert.equal(bad.code, ExitCode.Usage);
});

test("option parsers refuse what the server would refuse", () => {
  assert.throws(() => reportRecipients(" , "), /--recipients/);
  assert.throws(() => reportRecipients("a@x.invalid,A@X.invalid"), /different/);
  assert.deepEqual(reportRecipients("a@x.invalid, usr_B"), ["a@x.invalid", "usr_B"]);
  assert.throws(() => reportFilter("novalue"), /NAME=VALUE/);
  assert.deepEqual(reportFilters(reportFilter("b=2", reportFilter("a=1"))), { a: "1", b: "2" });
  assert.equal(scheduleText({ cadence: "monthly", day_of_month: 3, hour: 6, timezone: "UTC" }), "monthly on day 3 at 06:00 UTC");
  assert.match(subscriptionLines({ id: SUB, name: "N", kind: "uptime", format: "csv", enabled: false, recipients: [], last_status: "delivered", last_delivered: 2 }).join("\n"), /\(paused\)[\s\S]*mailed: 2 members/);
  assert.match(reportCatalogLines({ items: [{ kind: "uptime", title: "Uptime", description: "d", params: [{ name: "from", description: "" }] }], formats: ["json", "pdf"] }).join("\n"), /uptime: Uptime[\s\S]*filters: from[\s\S]*formats: json, pdf/);
});
