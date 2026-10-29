import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { commandHelp } from "./help-tree.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { fakeSessionJwt, FakeTransport } from "./transport/fake.js";
import type { TransportRequest } from "./transport/types.js";

const API_URL = "https://api.screenrig.ai";
const TOKEN = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
const PROJECT = "prj_AAAAAAAAAAAAAAAAAAAAAAAA";
const SCREEN = "scr_AAAAAAAAAAAAAAAAAAAAAAAA";
const MEDIA = "med_AAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = "2026-10-21T17:00:00.000Z";

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

async function withRuntime(argv: string[], transport: FakeTransport, configDir: string): Promise<{ code: number; stdout: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const fsLike = realFs(configDir);
  const runtime: CliRuntime = {
    argv, env: fsLike.env, stdout, stderr,
    now: () => new Date(NOW), sleep: async () => undefined,
    homedir: fsLike.homedir, cwd: () => configDir, fs: fsLike, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  await errP;
  return { code, stdout: await outP };
}

async function enrolled(configDir: string, subset = false): Promise<void> {
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    {
      api_url: API_URL,
      token: subset ? fakeSessionJwt({ exp: 4102444800, sid: "grant", scope: "identity", projects: { [PROJECT]: ["content"] } }) : TOKEN,
      ...(subset ? { project_id: PROJECT } : {}),
      project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization",
    },
    realFs(configDir),
  );
}

const json = (body: unknown) => ({ status: 200, headers: { "content-type": "application/json" }, body });
const query = (request: TransportRequest | undefined) =>
  Object.fromEntries(Object.entries(request?.query ?? {}).filter(([, value]) => value !== undefined));
const data = (stdout: string) => (JSON.parse(stdout) as { data: any }).data;

/** Run each argv, expecting a usage error and no request. */
async function refused(prefix: string, argvs: string[][]): Promise<void> {
  const configDir = await testTemp(`${prefix}-`);
  await enrolled(configDir);
  const transport = new FakeTransport();
  try {
    for (const argv of argvs) {
      const result = await withRuntime(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    }
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

test("the analytics read commands are in help", () => {
  for (const name of ["playback totals", "playback completeness", "screen uptime", "screen presence", "screen health-history", "project uptime", "project health-trend"]) {
    assert.match(commandHelp(name.split(" ")).synopsis[0]!, new RegExp(name));
  }
  assert.deepEqual(commandHelp(["playback", "totals"]).options.find((option) => option.name === "--by")?.choices, ["day", "screen", "media", "screen_day"]);
  assert.deepEqual(commandHelp(["screen", "health-history"]).options.find((option) => option.name === "--resolution")?.choices, ["raw", "hour"]);
});

test("playback totals sends the grouping, days, narrowing and top it was given", async () => {
  const configDir = await testTemp("totals-");
  await enrolled(configDir);
  const transport = new FakeTransport().on("GET", "/api/playback/totals", () => json({ by: "day", day_from: "2026-09-22", day_to: "2026-10-21", truncated: false, days: [] }));
  try {
    const plain = await withRuntime(["--json", "playback", "totals"], transport, configDir);
    assert.equal(plain.code, ExitCode.Success, plain.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), {});
    assert.deepEqual(data(plain.stdout).days, []);

    const narrowed = await withRuntime(["--json", "playback", "totals", "--day-from", "2026-09-01", "--day-to", "2026-09-30", "--screen-id", SCREEN], transport, configDir);
    assert.equal(narrowed.code, ExitCode.Success, narrowed.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), { day_from: "2026-09-01", day_to: "2026-09-30", screen_id: SCREEN });

    const media = await withRuntime(["--json", "playback", "totals", "--by", "day", "--media-id", MEDIA], transport, configDir);
    assert.equal(media.code, ExitCode.Success, media.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), { by: "day", media_id: MEDIA });

    const ranked = await withRuntime(["--json", "playback", "totals", "--by", "screen", "--top", "5", "--day-from", "2026-07-01", "--day-to", "2026-09-30"], transport, configDir);
    assert.equal(ranked.code, ExitCode.Success, ranked.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), { by: "screen", top: "5", day_from: "2026-07-01", day_to: "2026-09-30" });

    const series = await withRuntime(["--json", "playback", "totals", "--by", "screen_day", "--top", "10"], transport, configDir);
    assert.equal(series.code, ExitCode.Success, series.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), { by: "screen_day", top: "10" });

    // The longest day series (366 days) and ranking (92 days) are accepted.
    const year = await withRuntime(["--json", "playback", "totals", "--day-from", "2025-10-21", "--day-to", "2026-10-21"], transport, configDir);
    assert.equal(year.code, ExitCode.Success, year.stdout);
    const quarter = await withRuntime(["--json", "playback", "totals", "--by", "media", "--top", "100", "--day-from", "2026-07-22", "--day-to", "2026-10-21"], transport, configDir);
    assert.equal(quarter.code, ExitCode.Success, quarter.stdout);
    assert.equal(transport.calls.every((call) => call.method === "GET" && call.path === "/api/playback/totals"), true);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("playback totals refuses what the API refuses before any request", async () => {
  await refused("totals-usage", [
    ["playback", "totals", "--by", "week"],
    ["playback", "totals", "--top", "5"],
    ["playback", "totals", "--by", "day", "--top", "5"],
    ["playback", "totals", "--by", "screen", "--top", "0"],
    ["playback", "totals", "--by", "screen", "--top", "101"],
    ["playback", "totals", "--by", "media", "--top", "ten"],
    ["playback", "totals", "--by", "screen_day", "--top", "11"],
    ["playback", "totals", "--by", "screen", "--screen-id", SCREEN],
    ["playback", "totals", "--by", "media", "--media-id", MEDIA],
    ["playback", "totals", "--screen-id", SCREEN, "--media-id", MEDIA],
    ["playback", "totals", "--screen-id", "Lobby"],
    ["playback", "totals", "--media-id", "poster.png"],
    ["playback", "totals", "--day-from", "2026-02-30"],
    ["playback", "totals", "--day-to", "yesterday"],
    ["playback", "totals", "--day-from", "2026-10-02", "--day-to", "2026-10-01"],
    ["playback", "totals", "--day-from", "2025-10-20", "--day-to", "2026-10-21"],
    ["playback", "totals", "--screen-id", SCREEN, "--day-from", "2026-07-21", "--day-to", "2026-10-21"],
    ["playback", "totals", "--by", "screen", "--day-from", "2026-07-21", "--day-to", "2026-10-21"],
    ["playback", "totals", "--by", "screen_day", "--day-from", "2026-01-01", "--day-to", "2026-10-21"],
  ]);
});

test("playback completeness sends the days, screen and gap limit it was given", async () => {
  const configDir = await testTemp("completeness-");
  await enrolled(configDir);
  const body = {
    day_from: "2026-09-22", day_to: "2026-10-21", measured_plays: 95, missing_plays: 5, completeness: 0.95,
    days: [{ day: "2026-10-21", measured_plays: 95, missing_plays: 5, completeness: 0.95 }],
    gaps: [{ screen_id: SCREEN, day: "2026-10-21", from: "2026-10-20T22:10:00Z", to: "2026-10-21T08:02:00Z", missing_plays: 5 }],
    truncated: false,
  };
  const transport = new FakeTransport().on("GET", "/api/playback/completeness", () => json(body));
  try {
    const plain = await withRuntime(["--json", "playback", "completeness"], transport, configDir);
    assert.equal(plain.code, ExitCode.Success, plain.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), {});
    assert.deepEqual(data(plain.stdout), body);

    const narrowed = await withRuntime(["--json", "playback", "completeness", "--day-from", "2026-07-22", "--day-to", "2026-10-21", "--screen-id", SCREEN, "--limit", "500"], transport, configDir);
    assert.equal(narrowed.code, ExitCode.Success, narrowed.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), { day_from: "2026-07-22", day_to: "2026-10-21", screen_id: SCREEN, limit: "500" });
    assert.equal(transport.calls.every((call) => call.method === "GET" && call.path === "/api/playback/completeness"), true);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("playback completeness refuses what the API refuses before any request", async () => {
  await refused("completeness-usage", [
    ["playback", "completeness", "--limit", "0"],
    ["playback", "completeness", "--limit", "501"],
    ["playback", "completeness", "--screen-id", "Lobby"],
    ["playback", "completeness", "--media-id", MEDIA],
    ["playback", "completeness", "--day-from", "2026-07-21", "--day-to", "2026-10-21"],
    ["playback", "completeness", "--day-from", "2026-10-02", "--day-to", "2026-10-01"],
  ]);
});

test("screen uptime and project uptime read the daily routes with the days given", async () => {
  const configDir = await testTemp("uptime-");
  await enrolled(configDir);
  const rows = [{ day: "2026-10-20", online_s: 80000, offline_s: 6400, availability: 0.926, coverage: 1 }];
  const transport = new FakeTransport()
    .on("GET", `/api/screens/${SCREEN}/uptime`, () => json({ items: rows }))
    .on("GET", "/api/uptime/daily", () => json({ items: rows }));
  try {
    const screen = await withRuntime(["--json", "screen", "uptime", SCREEN], transport, configDir);
    assert.equal(screen.code, ExitCode.Success, screen.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), {});
    assert.deepEqual(data(screen.stdout).items, rows);

    const ranged = await withRuntime(["--json", "screen", "uptime", SCREEN, "--day-from", "2026-09-01", "--day-to", "2026-09-30"], transport, configDir);
    assert.equal(ranged.code, ExitCode.Success, ranged.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), { day_from: "2026-09-01", day_to: "2026-09-30" });

    const project = await withRuntime(["--json", "project", "uptime", "--day-from", "2026-09-01"], transport, configDir);
    assert.equal(project.code, ExitCode.Success, project.stdout);
    assert.equal(transport.calls.at(-1)?.path, "/api/uptime/daily");
    assert.deepEqual(query(transport.calls.at(-1)), { day_from: "2026-09-01" });
    assert.deepEqual(data(project.stdout).items, rows);

    const year = await withRuntime(["--json", "project", "uptime", "--day-from", "2025-10-21", "--day-to", "2026-10-21"], transport, configDir);
    assert.equal(year.code, ExitCode.Success, year.stdout);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("the uptime commands refuse a bad screen id or day range before any request", async () => {
  await refused("uptime-usage", [
    ["screen", "uptime"],
    ["screen", "uptime", "Lobby"],
    ["screen", "uptime", MEDIA],
    ["screen", "uptime", SCREEN, "--day-from", "2026-13-01"],
    ["screen", "uptime", SCREEN, "--day-from", "2026-10-02", "--day-to", "2026-10-01"],
    ["screen", "uptime", SCREEN, "--day-from", "2025-10-20", "--day-to", "2026-10-21"],
    ["project", "uptime", "--day-to", "2026-1-5"],
    ["project", "uptime", "--day-from", "2025-10-20", "--day-to", "2026-10-21"],
  ]);
});

test("screen presence follows every page with one fixed window and the before cursor", async () => {
  const configDir = await testTemp("presence-");
  await enrolled(configDir);
  // 60 pages: more than any page cap would allow.
  const total = 60;
  const transport = new FakeTransport().on("GET", `/api/screens/${SCREEN}/presence`, (request) => {
    const page = request.query?.before ? Number((request.query.before as string).slice(1)) : 0;
    return json({
      items: [{ at: `2026-10-21T${String(page % 24).padStart(2, "0")}:00:00Z`, state: page % 2 ? "online" : "offline" }],
      next_cursor: page + 1 < total ? `c${page + 1}` : null,
    });
  });
  try {
    const result = await withRuntime(["--json", "screen", "presence", SCREEN], transport, configDir);
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.equal(data(result.stdout).items.length, total);
    assert.equal(data(result.stdout).next_cursor, null);
    assert.equal(transport.calls.length, total);
    const first = query(transport.calls[0]);
    assert.deepEqual(first, { since: "2026-09-21T17:00:00Z", until: "2026-10-21T17:00:00Z", limit: "500" });
    assert.deepEqual(query(transport.calls[1]), { ...first, before: "c1" });
    for (const call of transport.calls) {
      assert.equal(call.query?.since, first.since);
      assert.equal(call.query?.until, first.until);
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen presence takes an age or instants", async () => {
  const configDir = await testTemp("presence-flags-");
  await enrolled(configDir);
  const transport = new FakeTransport().on("GET", `/api/screens/${SCREEN}/presence`, () => json({ items: [], next_cursor: null }));
  try {
    const age = await withRuntime(["--json", "screen", "presence", SCREEN, "--since", "7d"], transport, configDir);
    assert.equal(age.code, ExitCode.Success, age.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), { since: "2026-10-14T17:00:00Z", until: "2026-10-21T17:00:00Z", limit: "500" });

    const instants = await withRuntime(["--json", "screen", "presence", SCREEN, "--since", "2026-09-01T00:00:00-07:00", "--until", "2026-09-08T00:00:00Z"], transport, configDir);
    assert.equal(instants.code, ExitCode.Success, instants.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), { since: "2026-09-01T07:00:00Z", until: "2026-09-08T00:00:00Z", limit: "500" });
    assert.deepEqual(data(instants.stdout), { items: [], next_cursor: null });

    const year = await withRuntime(["--json", "screen", "presence", SCREEN, "--since", "366d"], transport, configDir);
    assert.equal(year.code, ExitCode.Success, year.stdout);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen presence refuses a bad id, time, window or paging flag before any request", async () => {
  await refused("presence-usage", [
    ["screen", "presence"],
    ["screen", "presence", "Lobby"],
    ["screen", "presence", SCREEN, "--since", "yesterday"],
    ["screen", "presence", SCREEN, "--until", "2026-10-21"],
    ["screen", "presence", SCREEN, "--since", "now"],
    ["screen", "presence", SCREEN, "--since", "2026-10-02T00:00:00Z", "--until", "2026-10-01T00:00:00Z"],
    ["screen", "presence", SCREEN, "--since", "367d"],
    ["screen", "presence", SCREEN, "--limit", "10"],
    ["screen", "presence", SCREEN, "--after", "c1"],
  ]);
});

test("screen health-history reads raw samples and hourly summaries page by page", async () => {
  const configDir = await testTemp("health-history-");
  await enrolled(configDir);
  const transport = new FakeTransport().on("GET", `/api/screens/${SCREEN}/health/history`, (request) => {
    const second = request.query?.cursor === "h2";
    return request.query?.resolution === "hour"
      ? json({ resolution: "hour", hours: [{ hour: second ? "2026-10-21T15:00:00Z" : "2026-10-21T16:00:00Z", reports: 60 }], next_cursor: second ? null : "h2" })
      : json({ resolution: "raw", samples: [{ reported_at: second ? "2026-10-21T16:58:00Z" : "2026-10-21T16:59:00Z", temperature_c: 51 }], next_cursor: second ? null : "h2" });
  });
  try {
    const raw = await withRuntime(["--json", "screen", "health-history", SCREEN], transport, configDir);
    assert.equal(raw.code, ExitCode.Success, raw.stdout);
    assert.equal(data(raw.stdout).resolution, "raw");
    assert.equal(data(raw.stdout).samples.length, 2);
    assert.equal(data(raw.stdout).next_cursor, null);
    assert.deepEqual(query(transport.calls[0]), { from: "2026-10-20T17:00:00Z", to: "2026-10-21T17:00:00Z", limit: "500" });
    assert.deepEqual(query(transport.calls[1]), { from: "2026-10-20T17:00:00Z", to: "2026-10-21T17:00:00Z", limit: "500", cursor: "h2" });

    const hours = await withRuntime(["--json", "screen", "health-history", SCREEN, "--from", "30d", "--resolution", "hour"], transport, configDir);
    assert.equal(hours.code, ExitCode.Success, hours.stdout);
    assert.equal(data(hours.stdout).hours.length, 2);
    assert.deepEqual(query(transport.calls.at(-2)), { from: "2026-09-21T17:00:00Z", to: "2026-10-21T17:00:00Z", resolution: "hour", limit: "500" });

    const month = await withRuntime(["--json", "screen", "health-history", SCREEN, "--from", "31d", "--resolution", "raw"], transport, configDir);
    assert.equal(month.code, ExitCode.Success, month.stdout);
    const quarter = await withRuntime(["--json", "screen", "health-history", SCREEN, "--from", "93d", "--resolution", "hour"], transport, configDir);
    assert.equal(quarter.code, ExitCode.Success, quarter.stdout);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen health-history refuses a bad id, resolution, window or paging flag before any request", async () => {
  await refused("health-history-usage", [
    ["screen", "health-history"],
    ["screen", "health-history", "Lobby"],
    ["screen", "health-history", SCREEN, "--resolution", "day"],
    ["screen", "health-history", SCREEN, "--from", "last week"],
    ["screen", "health-history", SCREEN, "--from", "now"],
    ["screen", "health-history", SCREEN, "--from", "32d"],
    ["screen", "health-history", SCREEN, "--from", "32d", "--resolution", "raw"],
    ["screen", "health-history", SCREEN, "--from", "94d", "--resolution", "hour"],
    ["screen", "health-history", SCREEN, "--limit", "10"],
    ["screen", "health-history", SCREEN, "--after", "h2"],
  ]);
});

test("project health-trend reads every page of the hourly fleet series", async () => {
  const configDir = await testTemp("health-trend-");
  await enrolled(configDir);
  const transport = new FakeTransport().on("GET", "/api/health/trend", (request) => json(request.query?.cursor
    ? { items: [{ hour: "2026-10-21T15:00:00Z", screens_reporting: 9, hot: 0, display_disconnected: 0, crashing: 0 }], next_cursor: null }
    : { items: [{ hour: "2026-10-21T16:00:00Z", screens_reporting: 10, hot: 1, display_disconnected: 0, crashing: 0 }], next_cursor: "t2" }));
  try {
    const result = await withRuntime(["--json", "project", "health-trend", "--from", "7d"], transport, configDir);
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.equal(data(result.stdout).items.length, 2);
    assert.equal(data(result.stdout).next_cursor, null);
    assert.deepEqual(query(transport.calls[0]), { from: "2026-10-14T17:00:00Z", to: "2026-10-21T17:00:00Z", limit: "500" });
    assert.deepEqual(query(transport.calls[1]), { from: "2026-10-14T17:00:00Z", to: "2026-10-21T17:00:00Z", limit: "500", cursor: "t2" });

    const defaults = await withRuntime(["--json", "project", "health-trend"], transport, configDir);
    assert.equal(defaults.code, ExitCode.Success, defaults.stdout);
    assert.deepEqual(query(transport.calls.at(-1)), { from: "2026-10-20T17:00:00Z", to: "2026-10-21T17:00:00Z", limit: "500", cursor: "t2" });

    const quarter = await withRuntime(["--json", "project", "health-trend", "--from", "93d"], transport, configDir);
    assert.equal(quarter.code, ExitCode.Success, quarter.stdout);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("project health-trend refuses a bad window or paging flag before any request", async () => {
  await refused("health-trend-usage", [
    ["project", "health-trend", "--from", "94d"],
    ["project", "health-trend", "--from", "2026-10-02T00:00:00Z", "--to", "2026-10-01T00:00:00Z"],
    ["project", "health-trend", "--to", "tomorrow"],
    ["project", "health-trend", "--limit", "10"],
    ["project", "health-trend", "--after", "t2"],
  ]);
});

test("a project-scoped credential reads the project routes under its project and the screen routes by screen id", async () => {
  const configDir = await testTemp("series-project-");
  await enrolled(configDir, true);
  const projectPath = `/api/projects/${PROJECT}`;
  const transport = new FakeTransport()
    .on("GET", `${projectPath}/playback/totals`, () => json({ by: "day", day_from: "2026-09-22", day_to: "2026-10-21", truncated: false, days: [] }))
    .on("GET", `${projectPath}/uptime/daily`, () => json({ items: [] }))
    .on("GET", `${projectPath}/health/trend`, () => json({ items: [], next_cursor: null }))
    .on("GET", `/api/screens/${SCREEN}/uptime`, () => json({ items: [] }))
    .on("GET", `/api/screens/${SCREEN}/presence`, () => json({ items: [], next_cursor: null }))
    .on("GET", `/api/screens/${SCREEN}/health/history`, () => json({ resolution: "raw", samples: [], next_cursor: null }));
  try {
    for (const argv of [
      ["playback", "totals"], ["project", "uptime"], ["project", "health-trend"],
      ["screen", "uptime", SCREEN], ["screen", "presence", SCREEN], ["screen", "health-history", SCREEN],
    ]) {
      const result = await withRuntime(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Success, `${argv.join(" ")}: ${result.stdout}`);
    }
    assert.deepEqual(transport.calls.filter((call) => call.method === "GET").map((call) => call.path), [
      `${projectPath}/playback/totals`, `${projectPath}/uptime/daily`, `${projectPath}/health/trend`,
      `/api/screens/${SCREEN}/uptime`, `/api/screens/${SCREEN}/presence`, `/api/screens/${SCREEN}/health/history`,
    ]);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
