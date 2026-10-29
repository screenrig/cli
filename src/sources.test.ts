import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help-tree.js";
import { run, type CliRuntime } from "./main.js";
import { accumulate, refreshText, secretPairCheck, setMembers, setPairCheck, SOURCE_ID_PATTERN, sourceRefreshSeconds, sourceStaleAfterSeconds, sourceTestLines, type Source, type SourceRooms } from "./sources.js";
import { networkError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const NOW = new Date("2026-10-28T17:00:00.000Z");
const SOURCE = "src_LOBBYAAAAAAAAAAAAAAAAA";
const CARD = "crd_LOBBYAAAAAAAAAAAAAAAAA";
const ADDRESS = "https://calendar.example.com/ical/private-token-1234/basic.ics";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; hint?: string; errors?: Array<{ field?: string; detail?: string }>; next?: { command: string; reason: string } };
  warnings?: Array<{ code: string; message: string }>;
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
  const configDir = await testTemp("sources-cfg-");
  const cwd = await testTemp("sources-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, stdin?: string): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const input = stdin === undefined ? undefined : new PassThrough();
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr, stdin: input, isStdinTty: () => false,
    now: () => NOW,
    sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  };
  if (input) { input.end(stdin); }
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  const err = await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, stderr: err, envelope };
}

function problem(status: number, code: string, detail: string, extras: Record<string, unknown> = {}): TransportResponse {
  return { status, headers: { "content-type": "application/problem+json" }, body: { status, code, title: detail, detail, ...extras } };
}

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: SOURCE, name: "Lobby calendar", kind: "ics", target: { card_id: CARD }, enabled: true,
    config: { calendars: [{ key: "lobby" }], days: 7, time_zone: "America/Vancouver" },
    secrets: { "calendar_url.lobby": { set: true, hint: "https://calendar.example.com/…", updated_at: "2026-10-28T16:00:00Z" } },
    refresh_seconds: 300, stale_after_seconds: null, revision: 3,
    status: {
      state: "ok", last_attempt_at: "2026-10-28T16:55:00Z", last_success_at: "2026-10-28T16:55:00Z", last_change_at: "2026-10-28T16:00:00Z",
      next_run_at: "2026-10-28T17:00:20Z", failures: 0, stale: false, data_expires_at: null, error: null, warnings: [], stats: { calendars: 1, events: 12 },
    },
    created_at: "2026-10-28T15:00:00Z", updated_at: "2026-10-28T16:00:00Z",
    ...overrides,
  };
}

/** The data source routes of the API, scripted: each call is recorded on the transport. */
function scripted(): { transport: FakeTransport; bodies: Array<{ method: string; path: string; body: any; headers: Record<string, string> }>; current: { source: Source } } {
  const transport = new FakeTransport();
  const state = { source: source() };
  const bodies: Array<{ method: string; path: string; body: any; headers: Record<string, string> }> = [];
  const record = (req: TransportRequest) => bodies.push({ method: req.method, path: req.path, body: req.body, headers: req.headers ?? {} });
  transport.on("GET", "/api/sources", (req) => { record(req); return { status: 200, headers: {}, body: { items: [state.source], next_cursor: req.query?.after ? null : "cur_next" } }; });
  transport.on("POST", "/api/sources", (req) => {
    record(req);
    const body = req.body as any;
    return { status: 201, headers: { etag: '"1"' }, body: source({ name: body.name, kind: body.kind, target: body.target, config: body.config, revision: 1, status: { ...source().status, state: "pending", last_success_at: null, last_attempt_at: null, last_change_at: null, stats: {} } }) };
  });
  transport.on("POST", "/api/sources/test", (req) => {
    record(req);
    return { status: 200, headers: {}, body: { document: { events: [{ id: "e1", title: "Standup", start: "2026-10-29T17:00:00Z" }] }, valid: true, warnings: ["Calendar lobby names no time zone."], stats: { calendars: 1, events: 1 }, fetched_at: NOW.toISOString() } };
  });
  transport.on("GET", SOURCE_PATH(), (req) => { record(req); return { status: 200, headers: { etag: `"${state.source.revision}"` }, body: state.source }; });
  transport.on("PATCH", SOURCE_PATH(), (req) => {
    record(req);
    const body = req.body as any;
    state.source = { ...state.source, ...(body.name ? { name: body.name } : {}), ...(body.config ? { config: body.config } : {}), revision: state.source.revision + 1 };
    return { status: 200, headers: {}, body: state.source };
  });
  transport.on("DELETE", SOURCE_PATH(), (req) => { record(req); return { status: 204, headers: {}, body: undefined }; });
  transport.on("POST", new RegExp(`^/api/sources/${SOURCE}/refresh$`), (req) => { record(req); return { status: 200, headers: {}, body: state.source }; });
  return { transport, bodies, current: state };
}

function SOURCE_PATH(): RegExp { return new RegExp(`^/api/sources/${SOURCE}$`); }

test("source ids look like src_ and nothing else", () => {
  assert.ok(SOURCE_ID_PATTERN.test(SOURCE));
  assert.ok(SOURCE_ID_PATTERN.test("stage_src_abc-DEF_1"));
  assert.ok(!SOURCE_ID_PATTERN.test("crd_abc"));
  assert.ok(!SOURCE_ID_PATTERN.test("src_"));
});

test("--refresh takes 30s to 24h", () => {
  for (const [text, seconds] of [["1m", 60], ["90s", 90], ["5m", 300], ["1h", 3600], ["1h30m", 5400], ["24h", 86400], ["60s", 60], ["30s", 30]] as const) {
    assert.equal(sourceRefreshSeconds(text), seconds, text);
  }
  for (const text of ["", "29s", "0m", "25h", "24h1s", "1d", "5", "m", "1h 30m", "-5m", "1.5h"]) {
    assert.throws(() => sourceRefreshSeconds(text), /--refresh takes 30s to 24h/, text);
  }
  assert.equal(refreshText(300), "5m");
  assert.equal(refreshText(5400), "1h 30m");
  assert.equal(refreshText(90), "90s");
  assert.equal(refreshText(86400), "24h");
});

test("--stale-after takes 1m to 7d or none", () => {
  for (const [text, seconds] of [["1m", 60], ["30m", 1800], ["2h", 7200], ["1d", 86400], ["7d", 604800], ["1d12h", 129600], ["none", null], ["NONE", null]] as const) {
    assert.equal(sourceStaleAfterSeconds(text), seconds, text);
  }
  for (const text of ["", "30s", "0m", "8d", "7d1s", "5", "soon", "-5m"]) {
    assert.throws(() => sourceStaleAfterSeconds(text), /--stale-after takes 1m to 7d/, text);
  }
});

test("--set values are JSON when they parse, text otherwise, and a key may not repeat", () => {
  assert.deepEqual(setMembers(["days=14", "time_zone=America/Vancouver", 'calendars=[{"key":"lobby"}]', "private_title=Busy", "flag=true", 'quoted="true"', "empty=", "url=https://a.example/x?y=1&z=2"]), {
    days: 14, time_zone: "America/Vancouver", calendars: [{ key: "lobby" }], private_title: "Busy", flag: true, quoted: "true", empty: "", url: "https://a.example/x?y=1&z=2",
  });
  assert.throws(() => setMembers(["days=7", "days=14"]), /--set days is given twice/);
  assert.throws(() => setPairCheck("novalue"), /--set takes KEY=VALUE/);
  assert.throws(() => setPairCheck("=x"), /--set takes KEY=VALUE/);
  // A key such as __proto__ is an ordinary member, never the prototype.
  const members = setMembers(["__proto__=1"]);
  assert.equal(Object.getPrototypeOf(members), Object.prototype);
  assert.equal(Object.keys(members).length, 1);
});

test("--secret names are the server's and a bare name is refused", () => {
  secretPairCheck("calendar_url.lobby=@lobby.url");
  secretPairCheck("access_token=-");
  assert.throws(() => secretPairCheck("novalue"), /--secret takes NAME=VALUE/);
  assert.throws(() => secretPairCheck("Bad Name=x"), /A secret name is lower-case/);
  assert.throws(() => secretPairCheck("token="), /has no value/);
});

test("repeatable options accumulate as JSON, so a value may hold commas and quotes", () => {
  const parse = accumulate(() => undefined);
  const first = parse('a,b="c"');
  const second = parse("d", first);
  assert.deepEqual(JSON.parse(second), ['a,b="c"', "d"]);
});

test("source list prints the table and the next page command", async () => {
  const env = await enrolled();
  const { transport, bodies } = scripted();
  const json = await cli(["--json", "source", "list"], transport, env);
  assert.equal(json.code, 0, json.stdout);
  assert.deepEqual(json.envelope.data.items.map((item: Source) => item.id), [SOURCE]);
  assert.equal(bodies.at(-1)!.path, "/api/sources");
  const human = await cli(["--human", "source", "list"], transport, env);
  assert.match(human.stdout, /Data sources \(1\)/);
  assert.match(human.stdout, /ID\s+NAME\s+KIND\s+CARD\s+STATE\s+LAST OK\s+NEXT\s+ERROR/);
  assert.match(human.stdout, new RegExp(`${SOURCE}\\s+Lobby calendar\\s+ics\\s+${CARD}\\s+ok`));
  assert.match(human.stdout, /next: screenrig source list --after cur_next/);
  const paged = await cli(["--json", "source", "list", "--after", "cur_next"], transport, env);
  assert.equal(paged.code, 0, paged.stdout);
  assert.equal(transport.calls.at(-1)!.query?.after, "cur_next");
});

test("source show prints the masked secret and the last run, never an address", async () => {
  const env = await enrolled();
  const { transport, current } = scripted();
  current.source = source({
    status: { ...source().status, state: "error", failures: 2, error: { code: "http_status", message: "The address answered HTTP 404. Check that the address is still correct.", upstream_status: 404, at: "2026-10-28T16:58:00Z" }, warnings: ["Calendar lobby names no time zone."] },
  });
  const human = await cli(["--human", "source", "show", SOURCE], transport, env);
  assert.equal(human.code, 0, human.stdout);
  for (const expected of [`id: ${SOURCE}`, "kind: ics", `card_id: ${CARD}`, "refresh: 5m", "revision: 3", "state: error", "failures: 2",
    "error: http_status: The address answered HTTP 404.", "stats: calendars=1, events=12", "  - Calendar lobby names no time zone.",
    "  calendar_url.lobby: https://calendar.example.com/…"]) {
    assert.ok(human.stdout.includes(expected), `${expected}\n${human.stdout}`);
  }
  assert.ok(!human.stdout.includes("private-token"));
  const json = await cli(["--json", "source", "show", SOURCE], transport, env);
  assert.equal(json.envelope.data.secrets["calendar_url.lobby"].hint, "https://calendar.example.com/…");
  assert.equal((await cli(["--json", "source", "show", "crd_x"], transport, env)).envelope.error?.code, "usage_error");
});

test("source create sends the shaped body with the secret read from a file", async () => {
  const env = await enrolled();
  const { transport, bodies } = scripted();
  await writeFile(path.join(env.cwd, "lobby.url"), `${ADDRESS}\n`);
  const result = await cli([
    "--json", "source", "create", "--kind", "ics", "--card", CARD, "--name", "  Lobby calendar ",
    "--set", 'calendars=[{"key":"lobby","name":"Lobby"}]', "--set", "time_zone=America/Vancouver", "--set", "days=14",
    "--secret", "calendar_url.lobby=@lobby.url", "--refresh", "10m",
  ], transport, env);
  assert.equal(result.code, 0, result.stdout);
  const sent = bodies.find((call) => call.method === "POST" && call.path === "/api/sources")!;
  assert.deepEqual(sent.body, {
    name: "Lobby calendar", kind: "ics", target: { card_id: CARD },
    config: { calendars: [{ key: "lobby", name: "Lobby" }], time_zone: "America/Vancouver", days: 14 },
    secrets: { "calendar_url.lobby": ADDRESS }, refresh_seconds: 600,
  });
  assert.match(sent.headers["idempotency-key"] ?? "", /^[A-Za-z0-9_-]{8,}/, "a create is an idempotent write");
  assert.ok(!result.stdout.includes("private-token"), "the answer carries masked hints only");
  assert.equal(result.envelope.data.secrets["calendar_url.lobby"].set, true);
  const human = await cli(["--human", "source", "create", "--kind", "ics", "--card", CARD, "--name", "L", "--settings", '{"calendars":[{"key":"lobby"}]}', "--disabled", "--secret", `calendar_url.lobby=${ADDRESS}`], transport, env);
  assert.match(human.stdout, /^Created data source/m);
  assert.ok(!human.stdout.includes("private-token"));
  const disabled = bodies.filter((call) => call.method === "POST" && call.path === "/api/sources").at(-1)!;
  assert.equal(disabled.body.enabled, false);
  assert.deepEqual(disabled.body.config, { calendars: [{ key: "lobby" }] });
});

test("source create and update send the stale period, and none sends null", async () => {
  const env = await enrolled();
  const { transport, bodies } = scripted();
  const created = await cli(["--json", "source", "create", "--kind", "momentus", "--card", CARD, "--name", "Venue", "--settings", '{"organization":"10"}', "--stale-after", "45m", "--refresh", "30s"], transport, env);
  assert.equal(created.code, 0, created.stdout);
  const sent = bodies.find((call) => call.method === "POST" && call.path === "/api/sources")!;
  assert.equal(sent.body.stale_after_seconds, 2700);
  assert.equal(sent.body.refresh_seconds, 30);
  const plain = await cli(["--json", "source", "create", "--kind", "momentus", "--card", CARD, "--name", "Venue", "--settings", "{}"], transport, env);
  assert.equal(plain.code, 0, plain.stdout);
  assert.ok(!("stale_after_seconds" in bodies.filter((call) => call.method === "POST" && call.path === "/api/sources").at(-1)!.body), "an absent option leaves the kind's default");
  const update = await cli(["--json", "source", "update", SOURCE, "--stale-after", "none"], transport, env);
  assert.equal(update.code, 0, update.stdout);
  const patched = bodies.filter((call) => call.method === "PATCH").at(-1)!;
  assert.deepEqual(patched.body, { stale_after_seconds: null });
  const bad = await cli(["--json", "source", "update", SOURCE, "--stale-after", "30s"], transport, env);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stdout, /--stale-after takes 1m to 7d/);
});

test("source show says when the data goes stale and when it has", async () => {
  const env = await enrolled();
  const transport = new FakeTransport();
  const state = { source: source({ kind: "momentus", stale_after_seconds: 1800, status: { ...source().status, state: "error", stale: true, data_expires_at: "2026-10-28T17:25:00Z", error: { code: "http_status", message: "Momentus answered HTTP 500.", at: "2026-10-28T17:30:00Z" } } }) };
  transport.on("GET", SOURCE_PATH(), () => ({ status: 200, headers: {}, body: state.source }));
  const human = await cli(["--human", "source", "show", SOURCE], transport, env);
  assert.match(human.stdout, /stale_after: 30m/);
  assert.match(human.stdout, /stale: true \(the data has expired/);
  assert.match(human.stdout, /data_expires_at: 2026-10-28T17:25:00Z/);
  state.source = source();
  const fresh = await cli(["--human", "source", "show", SOURCE], transport, env);
  assert.match(fresh.stdout, /stale_after: none \(the last good data stays until the next refresh\)/);
  assert.ok(!/^stale: /m.test(fresh.stdout));
});

function roomsReport(overrides: Partial<SourceRooms> = {}): SourceRooms {
  return {
    source_id: SOURCE, room_field: "room", room_key_prefix: "momentus-room-", area_field: "area", area_key_prefix: "momentus-area-", rooms_as_of: "2026-10-28T17:00:00Z",
    summary: { rooms: 3, unmapped_rooms: 1, areas: 2, unmapped_areas: 1, screens: 3, missing_screens: 1, unknown_screens: 1 },
    rooms: [
      { key: "ballroom-a", code: "BALLROOM-A", name: "Grand Ballroom A", area: "Level 2", status: "mapped", screens: [{ id: "scr_1", name: "Ballroom A door" }] },
      { key: "salon-b", code: "SALON-B", name: "Salon B", area: "Level 2", status: "unmapped", screens: [] },
      { key: "board-1", code: "BOARD-1", name: "Board Room 1", area: "Level 3", status: "mapped", screens: [{ id: "scr_3", name: "Board door" }] },
    ],
    areas: [{ key: "level-2", name: "Level 2", rooms: 2, status: "mapped", screens: [{ id: "scr_4", name: "Hallway" }] }, { key: "level-3", name: "Level 3", rooms: 1, status: "unmapped", screens: [] }],
    screens: [
      { id: "scr_1", name: "Ballroom A door", kind: "room", field: "room", value: "ballroom-a", status: "mapped", key: "ballroom-a" },
      { id: "scr_2", name: "Salon door", kind: "room", field: "room", value: "SALON-B", status: "unknown", suggestion: "salon-b" },
      { id: "scr_9", name: "New door", kind: "room", field: "room", value: null, status: "missing" },
    ],
    warnings: [],
    ...overrides,
  };
}

test("source rooms prints what no screen shows and the screens to fix, with a suggestion", async () => {
  const env = await enrolled();
  const transport = new FakeTransport();
  transport.on("GET", new RegExp(`^/api/sources/${SOURCE}/rooms$`), () => ({ status: 200, headers: {}, body: roomsReport() }));
  const json = await cli(["--json", "source", "rooms", SOURCE], transport, env);
  assert.equal(json.code, 0, json.stdout);
  assert.equal(json.envelope.data.summary.unmapped_rooms, 1);
  assert.deepEqual((json.envelope.warnings ?? []).map((warning: { code: string }) => warning.code), ["source_rooms_unmapped", "source_screens_unmapped"]);
  const human = await cli(["--human", "source", "rooms", SOURCE], transport, env);
  assert.match(human.stdout, /^Room mapping/m);
  assert.match(human.stdout, /momentus-room-\{screen\.field\.room\}/);
  assert.match(human.stdout, /Rooms no screen shows\n.*KEY\s+NAME\s+CODE\s+AREA\n.*salon-b\s+Salon B\s+SALON-B\s+Level 2/s);
  assert.match(human.stdout, /Areas no screen shows\n.*level-3/s);
  assert.match(human.stdout, /Screens to fix[\s\S]*scr_2\s+Salon door\s+room\s+SALON-B\s+no such room\s+salon-b/);
  assert.match(human.stdout, /scr_9\s+New door\s+room\s+no value/);
  assert.ok(!human.stdout.includes("scr_1 "), "a mapped screen is not listed to fix");
  assert.equal((await cli(["--human", "source", "rooms", "crd_nope"], transport, env)).code, 2);
});

test("source rooms is quiet when every room is shown and says why a source has none to map", async () => {
  const env = await enrolled();
  const transport = new FakeTransport();
  const clean = roomsReport({
    summary: { rooms: 1, unmapped_rooms: 0, areas: 0, unmapped_areas: 0, screens: 1, missing_screens: 0, unknown_screens: 0 },
    rooms: [{ key: "a", status: "mapped", screens: [{ id: "scr_1", name: "A" }] }], areas: [],
    screens: [{ id: "scr_1", name: "A", kind: "room", field: "room", value: "a", status: "mapped", key: "a" }],
  });
  transport.on("GET", new RegExp(`^/api/sources/${SOURCE}/rooms$`), () => ({ status: 200, headers: {}, body: clean }));
  const quiet = await cli(["--json", "source", "rooms", SOURCE], transport, env);
  assert.deepEqual(quiet.envelope.warnings ?? [], []);
  assert.match((await cli(["--human", "source", "rooms", SOURCE], transport, env)).stdout, /Every room is shown and every screen names one\./);

  const none = new FakeTransport();
  none.on("GET", new RegExp(`^/api/sources/${SOURCE}/rooms$`), () => problem(409, "source_has_no_rooms", "This kind of source offers no rooms to map."));
  const refused = await cli(["--json", "source", "rooms", SOURCE], none, env);
  assert.equal(refused.code, 5);
  assert.equal(refused.envelope.error?.code, "source_has_no_rooms");
  assert.equal(refused.envelope.error?.next?.command, "screenrig source list");
});

test("source create reads --settings from stdin or a file, and --set overrides it", async () => {
  const env = await enrolled();
  const { transport, bodies } = scripted();
  const piped = await cli(["--json", "source", "create", "--kind", "ics", "--card", CARD, "--name", "n", "--settings", "-", "--set", "days=3"], transport, env,
    JSON.stringify({ calendars: [{ key: "a" }], days: 21 }));
  assert.equal(piped.code, 0, piped.stdout);
  assert.deepEqual(bodies.at(-1)!.body.config, { calendars: [{ key: "a" }], days: 3 });
  await writeFile(path.join(env.cwd, "cfg.json"), JSON.stringify({ calendars: [{ key: "b" }] }));
  const filed = await cli(["--json", "source", "create", "--kind", "ics", "--card", CARD, "--name", "n", "--settings", "@cfg.json"], transport, env);
  assert.equal(filed.code, 0, filed.stdout);
  assert.deepEqual(bodies.at(-1)!.body.config, { calendars: [{ key: "b" }] });
});

test("stdin serves one option and a missing or bad input is a usage error before any request", async () => {
  const env = await enrolled();
  const { transport } = scripted();
  const both = await cli(["--json", "source", "create", "--kind", "ics", "--card", CARD, "--name", "n", "--settings", "-", "--secret", "calendar_url.a=-"], transport, env, "{}");
  assert.equal(both.envelope.error?.code, "usage_error");
  assert.match(both.envelope.error!.detail, /another option already does/);
  for (const argv of [
    ["--settings", "[1]"], ["--settings", "{not json"], ["--settings", "@missing.json"], ["--secret", "calendar_url.a=@missing.url"],
    ["--secret", "calendar_url.a"], ["--set", "novalue"], ["--refresh", "10s"], ["--name", " "],
  ]) {
    const result = await cli(["--json", "source", "create", "--kind", "ics", "--card", CARD, ...(argv[0] === "--name" ? [] : ["--name", "n"]), ...argv], transport, env);
    assert.equal(result.envelope.error?.code, "usage_error", argv.join(" "));
  }
  assert.equal(transport.calls.filter((call) => call.path.startsWith("/api/sources")).length, 0, "nothing was sent");
  const kind = await cli(["--json", "source", "create", "--kind", "rss", "--card", CARD, "--name", "n"], transport, env);
  assert.equal(kind.envelope.error?.code, "usage_error");
  const card = await cli(["--json", "source", "create", "--kind", "ics", "--card", "pl_x", "--name", "n"], transport, env);
  assert.equal(card.envelope.error?.code, "usage_error");
});

test("a secret on the command line never reaches the output or an error", async () => {
  const env = await enrolled();
  const transport = new FakeTransport();
  transport.on("POST", "/api/sources", () => problem(400, "source_secret_required", "secrets.calendar_url.lobby is required.", {
    errors: [{ field: "secrets.calendar_url.lobby", detail: `is required: ${ADDRESS}`, code: "required" }],
  }));
  const failed = await cli(["--json", "source", "create", "--kind", "ics", "--card", CARD, "--name", "n", "--set", 'calendars=[{"key":"lobby"}]', "--secret", `calendar_url.other=${ADDRESS}`], transport, env);
  assert.equal(failed.envelope.error?.code, "source_secret_required");
  assert.equal(failed.envelope.error?.next?.command, "screenrig help source create");
  assert.match(failed.envelope.error!.next!.reason, /calendar_url\.lobby=@FILE/);
});

test("source update merges --set into the saved config, guarded by the revision it read", async () => {
  const env = await enrolled();
  const { transport, bodies } = scripted();
  const result = await cli(["--json", "source", "update", SOURCE, "--set", "days=14", "--secret", "calendar_url.lobby=-"], transport, env, ADDRESS);
  assert.equal(result.code, 0, result.stdout);
  const read = bodies.find((call) => call.method === "GET" && call.path === `/api/sources/${SOURCE}`);
  assert.ok(read, "the saved config is read to be merged");
  const patch = bodies.find((call) => call.method === "PATCH")!;
  assert.deepEqual(patch.body, {
    config: { calendars: [{ key: "lobby" }], days: 14, time_zone: "America/Vancouver" },
    secrets: { "calendar_url.lobby": ADDRESS },
  });
  assert.equal(patch.headers["if-match"], '"3"');
  assert.match(patch.headers["idempotency-key"] ?? "", /^[A-Za-z0-9_-]{8,}/);
});

test("source update without --set reads nothing and names only what changes", async () => {
  const env = await enrolled();
  const { transport, bodies } = scripted();
  const renamed = await cli(["--json", "source", "update", SOURCE, "--name", "Front desk", "--refresh", "2m", "--disable", "--unset-secret", "calendar_url.old", "--expect-rev", "3"], transport, env);
  assert.equal(renamed.code, 0, renamed.stdout);
  assert.equal(bodies.filter((call) => call.method === "GET").length, 0);
  const patch = bodies.find((call) => call.method === "PATCH")!;
  assert.deepEqual(patch.body, { name: "Front desk", secrets: { "calendar_url.old": null }, refresh_seconds: 120, enabled: false });
  assert.equal(patch.headers["if-match"], '"3"');
  const replaced = await cli(["--json", "source", "update", SOURCE, "--settings", '{"calendars":[{"key":"x"}]}', "--set", "days=2"], transport, env);
  assert.equal(replaced.code, 0, replaced.stdout);
  assert.deepEqual(bodies.filter((call) => call.method === "PATCH").at(-1)!.body.config, { calendars: [{ key: "x" }], days: 2 });
  assert.equal(bodies.filter((call) => call.method === "PATCH").at(-1)!.headers["if-match"], undefined, "a replacement config is not guarded unless asked");
  // Nothing to change, enable and disable together, a secret both set and removed.
  assert.match((await cli(["--json", "source", "update", SOURCE], transport, env)).envelope.error!.detail, /requires at least one change/);
  assert.equal((await cli(["--json", "source", "update", SOURCE, "--enable", "--disable"], transport, env)).envelope.error?.code, "usage_error");
  assert.match((await cli(["--json", "source", "update", SOURCE, "--secret", "calendar_url.a=x", "--unset-secret", "calendar_url.a"], transport, env)).envelope.error!.detail, /both set with --secret and removed/);
});

test("source test previews a saved source or an unsaved one and prints the document", async () => {
  const env = await enrolled();
  const { transport, bodies } = scripted();
  const unsaved = await cli(["--json", "source", "test", "--kind", "ics", "--card", CARD, "--set", 'calendars=[{"key":"lobby"}]', "--secret", `calendar_url.lobby=${ADDRESS}`], transport, env);
  assert.equal(unsaved.code, 0, unsaved.stdout);
  assert.deepEqual(bodies.at(-1)!.body, { kind: "ics", target: { card_id: CARD }, config: { calendars: [{ key: "lobby" }] }, secrets: { "calendar_url.lobby": ADDRESS } });
  assert.equal(bodies.at(-1)!.headers["idempotency-key"], undefined, "a preview writes nothing, so it carries no idempotency key");
  assert.equal(unsaved.envelope.data.valid, true);
  const saved = await cli(["--human", "source", "test", SOURCE, "--set", "days=2"], transport, env);
  assert.equal(saved.code, 0, saved.stdout);
  assert.deepEqual(bodies.at(-1)!.body, { source_id: SOURCE, config: { calendars: [{ key: "lobby" }], days: 2, time_zone: "America/Vancouver" } });
  assert.match(saved.stdout, /Preview \(nothing was saved or written\)/);
  assert.match(saved.stdout, /The card accepts this document\./);
  assert.match(saved.stdout, /stats: calendars=1, events=1/);
  assert.match(saved.stdout, /  - Calendar lobby names no time zone\./);
  assert.match(saved.stdout, /"title": "Standup"/);
  assert.match((await cli(["--json", "source", "test"], transport, env)).envelope.error!.detail, /takes a saved <source_id>, or --kind and --card/);
  assert.match((await cli(["--json", "source", "test", "--kind", "ics"], transport, env)).envelope.error!.detail, /takes a saved <source_id>, or --kind and --card/);
});

test("a preview the card refuses is a warning and says where", async () => {
  const env = await enrolled();
  const transport = new FakeTransport();
  transport.on("POST", "/api/sources/test", () => ({
    status: 200, headers: {}, body: { document: { events: [{ start: "2026-10-29" }] }, valid: false, validation_error: { path: "events[0].title", reason: "is required" }, warnings: [], stats: {}, fetched_at: NOW.toISOString() },
  }));
  const result = await cli(["--json", "source", "test", SOURCE], transport, env);
  assert.equal(result.code, 0, "a refused document is a result, not a failure");
  assert.equal(result.envelope.data.valid, false);
  assert.equal(result.envelope.warnings?.[0]?.code, "source_document_refused");
  assert.match(result.envelope.warnings![0]!.message, /events\[0\]\.title: is required\. Nothing was written/);
  const human = await cli(["--human", "source", "test", SOURCE], transport, env);
  assert.match(human.stdout, /The card refuses this document at events\[0\]\.title: is required/);
});

test("a long previewed document is clipped in the human output only", () => {
  const document = { events: Array.from({ length: 80 }, (_, index) => ({ id: `e${index}`, title: `Event ${index}`, start: "2026-10-29" })) };
  const lines = sourceTestLines({ document, valid: true, warnings: [], stats: {}, fetched_at: NOW.toISOString() });
  assert.ok(lines.some((line) => /more lines \(the JSON envelope has the whole document\)/.test(line)));
  assert.ok(lines.length < 70);
});

test("source refresh shows the new status and warns when the sync failed", async () => {
  const env = await enrolled();
  const { transport, current, bodies } = scripted();
  const ok = await cli(["--human", "source", "refresh", SOURCE], transport, env);
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, new RegExp(`Synced data source ${SOURCE}\\n`));
  assert.equal(bodies.at(-1)!.path, `/api/sources/${SOURCE}/refresh`);
  current.source = source({ status: { ...source().status, state: "error", failures: 1, error: { code: "unreachable", message: "screenRIG could not reach the address. Use a public http(s) address on port 80 or 443.", at: "2026-10-28T17:00:00Z" } } });
  const failed = await cli(["--json", "source", "refresh", SOURCE], transport, env);
  assert.equal(failed.code, 0, "the sync failing is the source's status, not a failed command");
  assert.equal(failed.envelope.data.status.state, "error");
  assert.equal(failed.envelope.warnings?.[0]?.code, "source_sync_failed");
  assert.match(failed.envelope.warnings![0]!.message, /The card keeps its last good document/);
});

test("source delete reports the id and honours --expect-rev", async () => {
  const env = await enrolled();
  const { transport, bodies } = scripted();
  const result = await cli(["--json", "source", "delete", SOURCE, "--expect-rev", "3"], transport, env);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.envelope.data, { id: SOURCE, deleted: true });
  assert.equal(bodies.at(-1)!.headers["if-match"], '"3"');
  const human = await cli(["--human", "source", "delete", SOURCE], transport, env);
  assert.match(human.stdout, /Deleted data source .* keeps the last document/);
});

test("problems carry the next step", async () => {
  const env = await enrolled();
  const transport = new FakeTransport();
  transport.on("POST", "/api/sources", () => problem(409, "source_target_taken", "Another source already writes this card.", { errors: [{ field: "target.card_id", detail: "is written by src_OTHERAAAAAAAAAAAAAAAAA." }] }));
  const taken = await cli(["--json", "source", "create", "--kind", "ics", "--card", CARD, "--name", "n"], transport, env);
  assert.equal(taken.code, 5);
  assert.equal(taken.envelope.error?.code, "source_target_taken");
  assert.equal(taken.envelope.error?.next?.command, "screenrig source show src_OTHERAAAAAAAAAAAAAAAAA");

  const unsupported = new FakeTransport();
  unsupported.on("POST", "/api/sources", () => problem(422, "source_target_unsupported", "a ics source cannot fill a text card.", { errors: [{ field: "target.card_id", detail: "a ics source cannot fill a text card; it fills events, study-rooms cards." }] }));
  const refused = await cli(["--json", "source", "create", "--kind", "ics", "--card", CARD, "--name", "n"], unsupported, env);
  assert.equal(refused.envelope.error?.next?.command, "screenrig card list");

  const secret = new FakeTransport();
  secret.on("PATCH", SOURCE_PATH(), () => problem(400, "source_secret_required", "secrets.calendar_url.lobby Enter it again.", { errors: [{ field: "secrets.calendar_url.lobby", detail: "Enter it again: the source now points at a different address." }] }));
  secret.on("GET", SOURCE_PATH(), () => ({ status: 200, headers: {}, body: source() }));
  const again = await cli(["--json", "source", "update", SOURCE, "--set", "days=3"], secret, env);
  assert.equal(again.envelope.error?.next?.command, `screenrig source update ${SOURCE} --secret calendar_url.lobby=@FILE`);

  const missing = new FakeTransport();
  const gone = await cli(["--json", "source", "show", SOURCE], missing, env);
  assert.equal(gone.code, 4);
  assert.equal(gone.envelope.error?.next?.command, "screenrig source list");

  const conflict = new FakeTransport();
  conflict.on("DELETE", SOURCE_PATH(), () => ({ status: 412, headers: { "content-type": "application/problem+json" }, body: { status: 412, code: "revision_conflict", title: "Revision", detail: "The source was changed since it was read.", current_revision: 4 } }));
  const stale = await cli(["--json", "source", "delete", SOURCE, "--expect-rev", "3"], conflict, env);
  assert.equal(stale.code, 6);
  assert.equal(stale.envelope.error?.next?.command, `screenrig source show ${SOURCE}`);

  const busy = new FakeTransport();
  busy.on("POST", new RegExp(`^/api/sources/${SOURCE}/refresh$`), () => problem(409, "source_busy", "A sync of this source is running."));
  const waiting = await cli(["--json", "source", "refresh", SOURCE], busy, env);
  assert.equal(waiting.code, 5);
  assert.equal(waiting.envelope.error?.next?.command, `screenrig source show ${SOURCE}`);
});

test("source help lists the kinds, the secret rule and a working example for every command", () => {
  const help = commandHelp(["source"]).usage;
  assert.match(help, /Keep a card live from an outside address/);
  for (const text of ["ics", "sheets", "csv", "json", "microsoft365", "google_calendar", "momentus", "square", "shopify", "calendar_url.KEY=@FILE", "docs/sources", "never writes", "200", "source_failed", "api_secret"]) {
    assert.ok(help.includes(text), text);
  }
  for (const leaf of ["list", "show", "create", "update", "test", "refresh", "rooms", "delete"]) {
    const leafHelp = commandHelp(["source", leaf]);
    assert.ok(leafHelp.examples.length > 0, leaf);
    assert.ok(leafHelp.examples.every((example) => example.startsWith("screenrig source ")), leaf);
  }
  const create = commandHelp(["source", "create"]).usage;
  assert.match(create, /--settings <JSON\|@FILE\|->/);
  assert.ok(!/--config <JSON/.test(create), "--config is the credential file option");
});

test("an ambiguous source create reruns with the saved key and holds no address or settings on disk", async () => {
  const env = await enrolled();
  const { transport, bodies } = scripted();
  let lose = true;
  const original = transport.request.bind(transport);
  transport.request = async (req) => {
    const response = await original(req);
    if (lose && req.method === "POST" && req.path === "/api/sources") {
      lose = false;
      throw networkError("connection reset after the request was sent");
    }
    return response;
  };
  await writeFile(path.join(env.cwd, "lobby.url"), ADDRESS);
  const argv = ["--json", "source", "create", "--kind", "ics", "--card", CARD, "--name", "Lobby calendar", "--set", 'calendars=[{"key":"lobby"}]', "--secret", "calendar_url.lobby=@lobby.url"];
  const lost = await cli(argv, transport, env);
  assert.equal(lost.code, ExitCode.Network, lost.stdout);
  assert.ok(lost.envelope.warnings?.some((warning) => warning.code === "write_recovery_saved"));
  const pending = await readFile(env.configPath, "utf8");
  assert.match(pending, /pending_writes/, "the key is saved for the rerun");
  assert.match(pending, /source create/, "recovery list can name the command");
  assert.doesNotMatch(pending, /private-token|calendar\.example\.com|Lobby calendar/, "the ledger holds no request content");
  const rerun = await cli(argv, transport, env);
  assert.equal(rerun.code, 0, rerun.stdout);
  const posts = bodies.filter((call) => call.method === "POST" && call.path === "/api/sources");
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.headers["idempotency-key"], posts[0]!.headers["idempotency-key"], "the rerun reuses the saved key");
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
});
