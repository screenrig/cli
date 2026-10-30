import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { formatEventLine } from "./handlers/events.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help-tree.js";
import { run, type CliRuntime } from "./main.js";
import { durationMs, effectivePlaylistText, scheduleEntries, scheduleTableLines, takeoverUntil } from "./screen-control.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest } from "./transport/types.js";

const A = "scr_AAAAAAAAAAAAAAAAAAAAAAAA";
const B = "scr_BBBBBBBBBBBBBBBBBBBBBBBB";
const C = "scr_CCCCCCCCCCCCCCCCCCCCCCCC";
const D = "scr_DDDDDDDDDDDDDDDDDDDDDDDD";
const NOW = new Date("2026-08-14T17:00:00.000Z");

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; retry_after_seconds?: number; next?: { command: string; reason: string } };
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
  const configDir = await testTemp("control-cfg-");
  const cwd = await testTemp("control-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  const err = await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human */ }
  return { code, stdout: text, stderr: err, envelope };
}

const DAYPARTS = {
  entries: [
    { id: "breakfast", playlist_id: "pl_BREAKFAST", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "06:00", end: "11:00" }] },
    { id: "lunch", playlist_id: "pl_LUNCH", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "11:00", end: "15:00" }] },
    { id: "dinner", playlist_id: "pl_DINNER", windows: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "17:00", end: "22:00" }] },
  ],
};

async function backend(env: Env): Promise<FakeTransport> {
  const transport = memoryBackend({ now: () => NOW });
  // The default playlist every assignment below names; an unknown id is a 404.
  await transport.request({ method: "PUT", path: "/api/playlists/pl_DEFAULT", body: { name: "Default", pages: [] } });
  // The memory PATCH creates screens it does not know. A and B have a zone and
  // a default playlist, C has a default but no zone, D a zone but no default.
  for (const id of [A, B, D]) assert.equal((await cli(["--json", "screen", "set-timezone", id, "--timezone", "America/Los_Angeles"], transport, env)).code, 0);
  for (const id of [A, B]) assert.equal((await cli(["--json", "screen", "update", id, "--playlist-id", "pl_DEFAULT"], transport, env)).code, 0);
  assert.equal((await cli(["--json", "screen", "update", C, "--name", "Cafe", "--playlist-id", "pl_DEFAULT"], transport, env)).code, 0);
  await writeFile(path.join(env.cwd, "dayparts.json"), JSON.stringify(DAYPARTS));
  return transport;
}

const last = (transport: FakeTransport): TransportRequest => transport.calls.at(-1)!;

test("screen schedule set on one screen PUTs the entries with the revision guard", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  const set = await cli(["--json", "screen", "schedule", "set", A, "--file", "dayparts.json", "--expect-rev", "2"], transport, env);
  assert.equal(set.code, 0, set.stdout);
  const call = last(transport);
  assert.equal(call.method, "PUT");
  assert.equal(call.path, `/api/screens/${A}/playlist-schedule`);
  assert.deepEqual(call.body, DAYPARTS);
  assert.equal(call.headers?.["if-match"], '"2"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.deepEqual(set.envelope.data.effective_playlist, { id: "pl_BREAKFAST", source: "schedule", entry_id: "breakfast" });
  assert.equal(set.envelope.data.playlist_schedule.entries.length, 3);

  const human = await cli(["--human", "screen", "schedule", "set", A, "--file", "dayparts.json"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Set a 3-entry playlist schedule on scr_A/m);
  assert.match(human.stdout, /^Windows and FROM\/UNTIL are civil times \(screen timezone America\/Los_Angeles\)\.$/m);
  assert.match(human.stdout, /ENTRY\s+PLAYLIST\s+WINDOWS/);
  assert.match(human.stdout, /lunch\s+pl_LUNCH\s+mon,tue,wed,thu,fri 11:00-15:00/);
});

test("screen schedule show reads the view; clear DELETEs one screen only", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  await cli(["--json", "screen", "schedule", "set", A, "--file", "dayparts.json"], transport, env);
  const shown = await cli(["--json", "screen", "schedule", "show", A], transport, env);
  assert.equal(shown.code, 0, shown.stdout);
  assert.equal(last(transport).path, `/api/screens/${A}/playlist-schedule`);
  assert.equal(shown.envelope.data.entries[0].id, "breakfast");
  assert.equal(shown.envelope.data.effective_playlist.source, "schedule");
  const human = await cli(["--human", "screen", "schedule", "show", A], transport, env);
  assert.match(human.stdout, /^Playlist schedule for scr_A/m);
  assert.match(human.stdout, /^updated_at: /m);
  assert.match(human.stdout, /\(screen timezone America\/Los_Angeles\)/, "human show reads the zone from the screen");
  const jsonCalls = transport.calls.length;
  await cli(["--json", "screen", "schedule", "show", A], transport, env);
  assert.equal(transport.calls.length, jsonCalls + 1, "JSON output makes no extra screen read");

  // The saved show envelope is accepted back unchanged.
  await writeFile(path.join(env.cwd, "current.json"), shown.stdout);
  const roundTrip = await cli(["--json", "screen", "schedule", "set", A, "--file", "current.json"], transport, env);
  assert.equal(roundTrip.code, 0, roundTrip.stdout);
  assert.deepEqual(last(transport).body, { entries: DAYPARTS.entries });

  const cleared = await cli(["--json", "screen", "schedule", "clear", A, "--expect-rev", "5"], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  assert.equal(last(transport).method, "DELETE");
  assert.equal(last(transport).headers?.["if-match"], '"5"');
  assert.equal(cleared.envelope.data.playlist_schedule, undefined);
  const empty = await cli(["--human", "screen", "schedule", "show", A], transport, env);
  assert.match(empty.stdout, /No playlist schedule/);

});

test("screen schedule clear with several ids or --tag uses clear_playlist_schedule", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  await cli(["--json", "screen", "schedule", "set", A, B, "--file", "dayparts.json"], transport, env);
  const fleet = await cli(["--json", "screen", "schedule", "clear", A, B], transport, env);
  assert.equal(fleet.code, 0, fleet.stdout);
  assert.deepEqual(last(transport).body, { selector: { by: "ids", screen_ids: [A, B] }, action: { type: "clear_playlist_schedule" } });
  assert.equal(fleet.envelope.data.action, "clear_playlist_schedule");
  assert.equal(fleet.envelope.data.succeeded, 2);
  const shown = await cli(["--json", "screen", "show", B], transport, env);
  assert.equal(shown.envelope.data.playlist_schedule, undefined);
  assert.equal(shown.envelope.data.effective_playlist.source, "default");
  const human = await cli(["--human", "screen", "schedule", "clear", "--tag", "Cafe"], transport, env);
  assert.deepEqual(last(transport).body, { selector: { by: "tag", tag: "Cafe" }, action: { type: "clear_playlist_schedule" } });
  assert.match(human.stdout, /^Fleet schedule clear: matched 0/m);
  const guarded = await cli(["--json", "screen", "schedule", "clear", A, B, "--expect-rev", "3"], transport, env);
  assert.equal(guarded.code, ExitCode.Usage);
  assert.match(guarded.envelope.error!.detail, /does not take --expect-rev/);
});

test("schedule and takeover writes need a default playlist: next is screen assign", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  for (const argv of [["screen", "schedule", "set", D, "--file", "dayparts.json"], ["screen", "takeover", D, "--playlist-id", "pl_DRILL"]]) {
    const refused = await cli(["--json", ...argv], transport, env);
    assert.equal(refused.code, ExitCode.Client, refused.stdout);
    assert.equal(refused.envelope.error!.code, "invalid_request");
    assert.match(refused.envelope.error!.detail, /^Assign the screen a default playlist first: playlist_id: assign the screen a default playlist/);
    assert.equal(refused.envelope.error!.next!.command, `screenrig screen assign ${D} --playlist-id PLAYLIST_ID`);
  }
  const fleet = await cli(["--json", "screen", "takeover", A, D, "--playlist-id", "pl_DRILL"], transport, env);
  assert.deepEqual(fleet.envelope.data.results.map((item: any) => item.status), ["ok", "failed"]);
  assert.equal(fleet.code, ExitCode.Client);
});

test("schedule and takeover rate limits keep the exit-7 convention", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("POST", `/api/screens/${A}/takeover`, () => ({
    status: 429, headers: { "content-type": "application/problem+json", "retry-after": "30" },
    body: { status: 429, code: "rate_limited", title: "Too many requests", detail: "screen-control-screen limit reached." },
  }));
  const limited = await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_X"], transport, env);
  assert.equal(limited.code, ExitCode.RateLimited, limited.stdout);
  assert.equal(limited.envelope.error!.retry_after_seconds, 30);
});

test("screen schedule set with several ids or --tag uses set_playlist_schedule; a zoneless screen fails alone", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  const fleet = await cli(["--json", "screen", "schedule", "set", A, C, "--file", "dayparts.json"], transport, env);
  const call = last(transport);
  assert.equal(call.path, "/api/screens/actions");
  assert.deepEqual(call.body, { selector: { by: "ids", screen_ids: [A, C] }, action: { type: "set_playlist_schedule", entries: DAYPARTS.entries } });
  assert.equal(fleet.envelope.ok, true);
  assert.equal(fleet.envelope.data.action, "set_playlist_schedule");
  assert.deepEqual(fleet.envelope.data.results.map((item: any) => item.status), ["ok", "failed"]);
  assert.equal(fleet.envelope.data.results[1].problem.code, "invalid_request");
  assert.equal(fleet.code, ExitCode.Client, "first failed screen's exit code");
  assert.ok(fleet.envelope.warnings?.some((warning) => warning.code === "fleet_partial_failure"));

  const tagged = await cli(["--json", "screen", "schedule", "set", "--tag", "Cafe", "--file", "dayparts.json"], transport, env);
  assert.deepEqual(last(transport).body, { selector: { by: "tag", tag: "Cafe" }, action: { type: "set_playlist_schedule", entries: DAYPARTS.entries } });
  assert.ok(tagged.envelope.warnings?.some((warning) => warning.code === "fleet_no_match"));

  const guarded = await cli(["--json", "screen", "schedule", "set", A, B, "--file", "dayparts.json", "--expect-rev", "2"], transport, env);
  assert.equal(guarded.code, ExitCode.Usage);
  assert.match(guarded.envelope.error!.detail, /does not take --expect-rev/);
});

test("schedule problems: missing timezone points at set-timezone, archived at unarchive", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  const zoneless = await cli(["--json", "screen", "schedule", "set", C, "--file", "dayparts.json"], transport, env);
  assert.equal(zoneless.code, ExitCode.Client, zoneless.stdout);
  assert.equal(zoneless.envelope.error!.code, "invalid_request");
  assert.match(zoneless.envelope.error!.detail, /^Set the screen timezone first: timezone: is required/);
  assert.equal(zoneless.envelope.error!.next!.command, `screenrig screen set-timezone ${C} --timezone ZONE`);

  const archived = new FakeTransport().on("PUT", `/api/screens/${A}/playlist-schedule`, () => ({
    status: 409, headers: { "content-type": "application/problem+json" },
    body: { status: 409, code: "screen_archived", title: "Screen is archived", detail: "screen is archived" },
  }));
  const refused = await cli(["--json", "screen", "schedule", "set", A, "--file", "dayparts.json"], archived, env);
  assert.equal(refused.code, ExitCode.Conflict);
  assert.equal(refused.envelope.error!.next!.command, `screenrig screen unarchive ${A}`);
});

test("schedule files are validated locally with a path in the message", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  const cases: Array<[unknown, RegExp]> = [
    [{ entries: [] }, /at least one entry/],
    [{ entries: Array.from({ length: 33 }, () => DAYPARTS.entries[0]) }, /at most 32 entries/],
    [{ entries: [{ playlist_id: "pl_A", windows: [] }] }, /entries\[0\]\.windows must list 1 to 16 windows/],
    [{ entries: [{ playlist_id: "pl_A", windows: Array.from({ length: 17 }, () => ({ days: ["mon"] })) }] }, /1 to 16 windows/],
    [{ entries: [{ playlist_id: "pl_A", windows: [{ days: ["monday"] }] }] }, /entries\[0\]\.windows\[0\]\.days\[0\] must be one of mon, tue/],
    [{ entries: [{ playlist_id: "pl_A", windows: [{ days: ["mon", "mon"] }] }] }, /must not repeat a day/],
    [{ entries: [{ playlist_id: "pl_A", windows: [{ days: ["mon"], start: "7:00", end: "09:00" }] }] }, /start must be HH:MM/],
    [{ entries: [{ playlist_id: "pl_A", windows: [{ days: ["mon"], start: "24:00", end: "09:00" }] }] }, /HH:MM/],
    [{ entries: [{ playlist_id: "pl_A", windows: [{ days: ["mon"], start: "07:00" }] }] }, /both start and end/],
    [{ entries: [{ windows: [{ days: ["mon"] }] }] }, /playlist_id is required/],
    [{ entries: [{ playlist_id: "pl_A", from: "2026-12-24 18:00", windows: [{ days: ["mon"] }] }] }, /from must be a civil minute/],
    [{ entries: [{ playlist_id: "pl_A", from: "2026-12-25T00:00", until: "2026-12-24T00:00", windows: [{ days: ["mon"] }] }] }, /from must be before until/],
    [{ entries: [{ id: "a", playlist_id: "pl_A", windows: [{ days: ["mon"] }] }, { id: "a", playlist_id: "pl_B", windows: [{ days: ["tue"] }] }] }, /repeat an entry id/],
    [{ entries: [{ playlist_id: "pl_A", windows: [{ days: ["mon"] }], priority: 1 }] }, /unknown field "priority"/],
    [{ schedule: [] }, /unknown field "schedule"/],
  ];
  const before = transport.calls.length;
  for (const [document, message] of cases) {
    await writeFile(path.join(env.cwd, "bad.json"), JSON.stringify(document));
    const refused = await cli(["--json", "screen", "schedule", "set", A, "--file", "bad.json"], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${JSON.stringify(document).slice(0, 80)}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message);
  }
  assert.equal(transport.calls.length, before, "invalid schedules never reach the server");
  const missing = await cli(["--json", "screen", "schedule", "set", A], transport, env);
  assert.equal(missing.code, ExitCode.Usage);
  // A bare array and whole-day windows are accepted.
  assert.deepEqual(scheduleEntries([{ playlist_id: "pl_A", windows: [{ days: ["sat", "sun"] }] }]), [{ playlist_id: "pl_A", windows: [{ days: ["sat", "sun"] }] }]);
});

const LEVELS = {
  entries: [
    { id: "sunday-market", playlist_id: "pl_MARKET", monthly: [{ nth: -1, weekday: "sun", start: "09:00", end: "14:00" }], except: ["2026-12-27"] },
    { id: "pay-day", playlist_id: "pl_PAYDAY", monthly: [{ day: 15 }, { nth: 1, weekday: "fri" }], dates: [{ date: "2026-12-24", start: "18:00", end: "22:00" }, { date: "2026-12-31" }] },
    { id: "kiosk", playlist_id: "pl_KIOSK", interaction: { idle_s: 90 }, displays: [1, 2], start: "on_time" },
    { id: "rain", playlist_id: "pl_RAIN", data: { key: "{screen.weather}", path: "/condition", equals: "rain" }, covers: "header" },
    { id: "lunch", playlist_id: "pl_LUNCH", windows: [{ days: ["mon", "tue"], start: "11:00", end: "15:00" }], from: "2026-12-01T00:00" },
  ],
};

test("screen schedule set takes entries without windows and sends every level member", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  await writeFile(path.join(env.cwd, "levels.json"), JSON.stringify(LEVELS));
  const set = await cli(["--json", "screen", "schedule", "set", A, "--file", "levels.json"], transport, env);
  assert.equal(set.code, 0, set.stdout);
  assert.equal(last(transport).method, "PUT");
  assert.deepEqual(last(transport).body, LEVELS);
  assert.deepEqual(set.envelope.data.playlist_schedule.entries.map((entry: { id: string }) => entry.id), ["sunday-market", "pay-day", "kiosk", "rain", "lunch"]);

  const human = await cli(["--human", "screen", "schedule", "set", A, "--file", "levels.json"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Windows, FROM\/UNTIL and the monthly and date rules are civil times \(screen timezone America\/Los_Angeles\)\.$/m);
  assert.match(human.stdout, /^ENTRY\s+PLAYLIST\s+WINDOWS\s+FROM\s+UNTIL\s+RULES$/m);
  assert.match(human.stdout, /^sunday-market\s+pl_MARKET\s+last Sunday 09:00–14:00; except 2026-12-27$/m);
  assert.match(human.stdout, /^pay-day\s+pl_PAYDAY\s+day 15; 1st Friday; on 2026-12-24 18:00–22:00; on 2026-12-31$/m);
  assert.match(human.stdout, /^kiosk\s+pl_KIOSK\s+on touch \(idle 90 s\); displays 1, 2; starts on time$/m);
  assert.match(human.stdout, /^rain\s+pl_RAIN\s+data \{screen\.weather\} \/condition = "rain"; covers header$/m);
  assert.match(human.stdout, /^lunch\s+pl_LUNCH\s+mon,tue 11:00-15:00\s+2026-12-01T00:00$/m);

  // The saved show envelope, with the stored interaction, is accepted back unchanged.
  const shown = await cli(["--json", "screen", "schedule", "show", A], transport, env);
  await writeFile(path.join(env.cwd, "current.json"), shown.stdout);
  const roundTrip = await cli(["--json", "screen", "schedule", "set", A, "--file", "current.json"], transport, env);
  assert.equal(roundTrip.code, 0, roundTrip.stdout);
  assert.deepEqual(last(transport).body, LEVELS);
  const fleet = await cli(["--json", "screen", "schedule", "set", A, B, "--file", "levels.json"], transport, env);
  assert.equal(fleet.code, 0, fleet.stdout);
  assert.deepEqual((last(transport).body as { action: unknown }).action, { type: "set_playlist_schedule", entries: LEVELS.entries });
});

test("schedule entries keep the level members, ascending where the server stores them", () => {
  assert.deepEqual(scheduleEntries([{ playlist_id: "pl_A", except: ["2027-01-01", "2026-12-25"], displays: [3, 1], interaction: {}, start: "next_item", covers: "full" }]),
    [{ playlist_id: "pl_A", except: ["2026-12-25", "2027-01-01"], interaction: {}, covers: "full", displays: [1, 3], start: "next_item" }]);
  assert.deepEqual(scheduleEntries({ entries: [{ playlist_id: "pl_A", monthly: [{ day: 1, start: "08:00", end: "09:00" }], data: { key: "queue", equals: null } }] }),
    [{ playlist_id: "pl_A", monthly: [{ day: 1, start: "08:00", end: "09:00" }], data: { key: "queue", equals: null } }]);
  // Rules alone are an entry: no windows needed.
  for (const rule of [{ from: "2026-12-24T18:00" }, { until: "2026-12-24T18:00" }, { dates: [{ date: "2026-12-24" }] }, { except: ["2026-12-25"] }, { interaction: {} }, { data: { key: "queue" } }]) {
    assert.equal(scheduleEntries([{ playlist_id: "pl_A", ...rule }]).length, 1, JSON.stringify(rule));
  }
});

test("schedule level members are validated locally with a path in the message", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  const entry = (extra: Record<string, unknown>) => ({ entries: [{ playlist_id: "pl_A", ...extra }] });
  const cases: Array<[unknown, RegExp]> = [
    [entry({}), /entries\[0\] must set at least one rule: windows, monthly, dates, except, from, until, data or interaction/],
    [entry({ displays: [1], start: "on_time", covers: "header" }), /must set at least one rule/],
    [entry({ monthly: [] }), /entries\[0\]\.monthly must list 1 to 16 monthly rules/],
    [entry({ monthly: Array.from({ length: 17 }, () => ({ day: 1 })) }), /1 to 16 monthly rules/],
    [entry({ monthly: [{ day: 0 }] }), /entries\[0\]\.monthly\[0\]\.day must be a day of the month from 1 to 31/],
    [entry({ monthly: [{ day: 32 }] }), /day of the month from 1 to 31/],
    [entry({ monthly: [{ day: 1.5 }] }), /day of the month from 1 to 31/],
    [entry({ monthly: [{ day: 1, nth: 1, weekday: "mon" }] }), /must set either day, or nth and weekday, not both/],
    [entry({ monthly: [{}] }), /monthly\[0\] must set day, or nth and weekday/],
    [entry({ monthly: [{ nth: 5, weekday: "mon" }] }), /monthly\[0\]\.nth must be 1, 2, 3, 4 or -1 for the last/],
    [entry({ monthly: [{ nth: 1 }] }), /monthly\[0\]\.weekday must be one of mon, tue/],
    [entry({ monthly: [{ nth: 1, weekday: "monday" }] }), /monthly\[0\]\.weekday must be one of mon, tue/],
    [entry({ monthly: [{ day: 1, start: "09:00" }] }), /must set both start and end/],
    [entry({ monthly: [{ day: 1, start: "9:00", end: "10:00" }] }), /monthly\[0\]\.start must be HH:MM/],
    [entry({ monthly: [{ day: 1, every: 2 }] }), /unknown field "every"; allowed: day, nth, weekday, start, end/],
    [entry({ dates: [] }), /entries\[0\]\.dates must list 1 to 100 dates/],
    [entry({ dates: Array.from({ length: 101 }, () => ({ date: "2026-12-24" })) }), /1 to 100 dates/],
    [entry({ dates: [{ date: "2026-02-30" }] }), /entries\[0\]\.dates\[0\]\.date must be a real civil date/],
    [entry({ dates: [{}] }), /dates\[0\]\.date must be a real civil date/],
    [entry({ dates: [{ date: "2026-12-24", start: "18:00" }] }), /must set both start and end/],
    [entry({ dates: [{ date: "2026-12-24", until: "x" }] }), /unknown field "until"; allowed: date, start, end/],
    [entry({ except: [] }), /entries\[0\]\.except must list 1 to 100 dates/],
    [entry({ except: ["2026-12-25", "2026-13-01"] }), /entries\[0\]\.except\[1\] must be a real civil date/],
    [entry({ except: ["2026-12-25", "2026-12-25"] }), /except must not repeat 2026-12-25/],
    [entry({ data: {} }), /entries\[0\]\.data\.key must name card data/],
    [entry({ data: { key: "feed:weather" } }), /data\.key must name card data/],
    [entry({ data: { key: "bad key" } }), /data\.key must name card data/],
    [entry({ data: { key: "queue", path: "condition" } }), /data\.path must be an RFC 6901 pointer/],
    [entry({ data: { key: "queue", equals: { a: 1 } } }), /data\.equals must be a string, number, boolean or null/],
    [entry({ data: { key: "queue", equals: "x".repeat(1025) } }), /data\.equals must be at most 1024 bytes/],
    [entry({ data: { key: "queue", when: 1 } }), /unknown field "when"; allowed: key, path, equals/],
    [entry({ interaction: { idle_s: 4 } }), /entries\[0\]\.interaction\.idle_s must be a whole number of seconds from 5 to 3600/],
    [entry({ interaction: { idle_s: 3601 } }), /from 5 to 3600/],
    [entry({ interaction: { idle_s: "60" } }), /from 5 to 3600/],
    [entry({ interaction: { idle: 60 } }), /unknown field "idle"; allowed: idle_s/],
    [entry({ interaction: true }), /entries\[0\]\.interaction must be an object/],
    [entry({ windows: [{ days: ["mon"] }], covers: "left" }), /entries\[0\]\.covers must be full, main, header, footer or side/],
    [entry({ windows: [{ days: ["mon"] }], displays: [] }), /entries\[0\]\.displays must list 1 to 12 displays/],
    [entry({ windows: [{ days: ["mon"] }], displays: [0] }), /displays\[0\] must be a display number from 1 to 12/],
    [entry({ windows: [{ days: ["mon"] }], displays: [13] }), /displays\[0\] must be a display number from 1 to 12/],
    [entry({ windows: [{ days: ["mon"] }], displays: [1, 1] }), /displays must not repeat a display/],
    [entry({ windows: [{ days: ["mon"] }], start: "now" }), /entries\[0\]\.start must be next_item or on_time/],
  ];
  const before = transport.calls.length;
  for (const [document, message] of cases) {
    await writeFile(path.join(env.cwd, "bad.json"), JSON.stringify(document));
    const refused = await cli(["--json", "screen", "schedule", "set", A, "--file", "bad.json"], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${JSON.stringify(document).slice(0, 100)}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, JSON.stringify(document).slice(0, 100));
  }
  assert.equal(transport.calls.length, before, "invalid schedules never reach the server");
});

test("screen schedule set help describes the level members and shows an entry with monthly and except", () => {
  const help = commandHelp(["screen", "schedule", "set"]);
  assert.match(help.usage, /1 to 32 entries of \{id\?, playlist_id, from\?, until\?, windows\?, monthly\?, dates\?, except\?, data\?, interaction\?, covers\?, displays\?, start\?, paused\?\}/);
  assert.match(help.usage, /sets at least one of from, until, windows, monthly, dates, except, data or interaction \(windows are no longer required\)/);
  assert.match(help.usage, /"monthly":\[\{"nth":-1,"weekday":"sun","start":"09:00","end":"14:00"\}\],"except":\["2026-12-27"\]/);
  assert.match(help.usage, /reports reason stack_only/);
  const example = /Example: (\{"entries":.*?\}\]\})\. from\/until/.exec(help.usage)?.[1];
  assert.ok(example, "the help carries one example file");
  assert.equal(scheduleEntries(JSON.parse(example)).length, 2, "the example is a file the CLI accepts");
});

test("schedule tables keep their columns when no entry sets a level member", () => {
  const lines = scheduleTableLines([{ id: "a", playlist_id: "pl_A", windows: [{ days: ["sat", "sun"] }] }], "UTC");
  assert.deepEqual(lines, ["Windows and FROM/UNTIL are civil times (screen timezone UTC).", "ENTRY  PLAYLIST  WINDOWS          FROM  UNTIL", "a      pl_A      sat,sun all day"]);
  const withRules = scheduleTableLines([{ id: "a", playlist_id: "pl_A", windows: [{ days: ["sat"] }], monthly: [{ day: 1 }] }, { id: "b", playlist_id: "pl_B", until: "2027-01-01T00:00" }]);
  assert.match(withRules[0]!, /^ENTRY\s+PLAYLIST\s+WINDOWS\s+FROM\s+UNTIL\s+RULES$/);
  assert.match(withRules[1]!, /^a\s+pl_A\s+sat all day\s+day 1$/);
  assert.match(withRules[2]!, /^b\s+pl_B\s+2027-01-01T00:00$/);
});

test("screen takeover sets one screen with --for, --until, or held until cleared", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  const timed = await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_DRILL", "--for", "30m", "--reason", "Fire drill", "--expect-rev", "2"], transport, env);
  assert.equal(timed.code, 0, timed.stdout);
  let call = last(transport);
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/screens/${A}/takeover`);
  assert.deepEqual(call.body, { playlist_id: "pl_DRILL", until: "2026-08-14T17:30:00Z", reason: "Fire drill" });
  assert.equal(call.headers?.["if-match"], '"2"');
  assert.deepEqual(timed.envelope.data.effective_playlist, { id: "pl_DRILL", source: "takeover", until: "2026-08-14T17:30:00Z" });
  assert.equal(timed.envelope.data.takeover.reason, "Fire drill");

  const explicit = await cli(["--json", "screen", "takeover", "set", A, "--playlist-id", "pl_LAUNCH", "--until", "2026-08-15T18:00:00Z"], transport, env);
  assert.equal(explicit.code, 0, explicit.stdout);
  assert.deepEqual(last(transport).body, { playlist_id: "pl_LAUNCH", until: "2026-08-15T18:00:00Z" });

  const held = await cli(["--human", "screen", "takeover", A, "--playlist-id", "pl_NOTICE", "--until", "none"], transport, env);
  assert.equal(held.code, 0, held.stderr);
  assert.deepEqual(last(transport).body, { playlist_id: "pl_NOTICE", until: null });
  assert.match(held.stdout, /^Took over scr_A\w+ with pl_NOTICE until cleared$/m);
  assert.match(held.stdout, /^Takeover: pl_NOTICE until cleared$/m);

  const omitted = await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_NOTICE"], transport, env);
  assert.equal(omitted.code, 0);
  assert.deepEqual(last(transport).body, { playlist_id: "pl_NOTICE" }, "no until means held until cleared");


  const cleared = await cli(["--json", "screen", "takeover", "clear", A], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  call = last(transport);
  assert.equal(call.method, "DELETE");
  assert.equal(call.path, `/api/screens/${A}/takeover`);
  assert.equal(cleared.envelope.data.takeover, undefined);
});

test("takeover instants print in the screen timezone; server until refusals and skew hints", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  const timed = await cli(["--human", "screen", "takeover", A, "--playlist-id", "pl_DRILL", "--for", "30m", "--reason", "  Fire drill  "], transport, env);
  assert.equal(timed.code, 0, timed.stderr);
  assert.equal((transport.calls.at(-1)!.body as { reason?: string }).reason, "Fire drill", "reason is trimmed");
  assert.match(timed.stdout, /^Took over scr_A\w+ with pl_DRILL until 2026-08-14 10:30 America\/Los_Angeles$/m);
  assert.match(timed.stdout, /^Takeover: pl_DRILL until 2026-08-14 10:30 America\/Los_Angeles \(Fire drill\)$/m);

  const past = await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_DRILL", "--until", "2026-08-14T16:00:00Z"], transport, env);
  assert.equal(past.code, ExitCode.Client);
  assert.equal(past.envelope.error!.detail, "until: must be in the future");
  assert.equal(past.envelope.error!.next, undefined, "an explicit --until gets no --for hint");

  // This computer's clock runs two minutes ahead of the server's.
  const skewed = memoryBackend({ now: () => new Date(NOW.getTime() - 2 * 60_000) });
  await skewed.request({ method: "PUT", path: "/api/playlists/pl_DEFAULT", body: { name: "Default", pages: [] } });
  for (const id of [A]) {
    await cli(["--json", "screen", "set-timezone", id, "--timezone", "America/Los_Angeles"], skewed, env);
    await cli(["--json", "screen", "update", id, "--playlist-id", "pl_DEFAULT"], skewed, env);
  }
  const single = await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_DRILL", "--for", "6d23h59m"], skewed, env);
  assert.equal(single.code, ExitCode.Client, single.stdout);
  assert.match(single.envelope.error!.detail, /^until: must be at most 7 days ahead/);
  assert.match(single.envelope.error!.next!.command, /shorter --for/);
  const fleet = await cli(["--json", "screen", "takeover", A, B, "--playlist-id", "pl_DRILL", "--for", "6d23h59m"], skewed, env);
  assert.equal(fleet.code, ExitCode.Client, fleet.stdout);
  assert.match(fleet.envelope.error!.next!.command, /shorter --for/);
  const fine = await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_DRILL", "--for", "6d23h"], skewed, env);
  assert.equal(fine.code, 0, fine.stdout);
});

test("only the server's timezone path gets the set-timezone hint", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("PUT", `/api/screens/${A}/playlist-schedule`, () => ({
    status: 400, headers: { "content-type": "application/problem+json" },
    body: { status: 400, code: "invalid_request", title: "Request is invalid", detail: "pages[0].visibility: needs a screen timezone" },
  }));
  await writeFile(path.join(env.cwd, "dayparts.json"), JSON.stringify(DAYPARTS));
  const refused = await cli(["--json", "screen", "schedule", "set", A, "--file", "dayparts.json"], transport, env);
  assert.equal(refused.code, ExitCode.Client);
  assert.equal(refused.envelope.error!.next, undefined);
  assert.equal(refused.envelope.error!.detail, "pages[0].visibility: needs a screen timezone");
});

test("screen takeover fleets use the takeover and takeover_clear actions", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  const fleet = await cli(["--json", "screen", "takeover", A, B, "--playlist-id", "pl_LAUNCH", "--until", "2026-08-15T18:00:00Z", "--reason", "Launch"], transport, env);
  assert.equal(fleet.code, 0, fleet.stdout);
  assert.deepEqual(last(transport).body, {
    selector: { by: "ids", screen_ids: [A, B] },
    action: { type: "takeover", playlist_id: "pl_LAUNCH", until: "2026-08-15T18:00:00Z", reason: "Launch" },
  });
  assert.equal(fleet.envelope.data.succeeded, 2);
  const human = await cli(["--human", "screen", "takeover", "--tag", "Lobby", "--playlist-id", "pl_LAUNCH"], transport, env);
  assert.deepEqual(last(transport).body, { selector: { by: "tag", tag: "Lobby" }, action: { type: "takeover", playlist_id: "pl_LAUNCH" } });
  assert.match(human.stdout, /^Fleet takeover: matched 0/m);
  const cleared = await cli(["--json", "screen", "takeover", "clear", A, B], transport, env);
  assert.deepEqual(last(transport).body, { selector: { by: "ids", screen_ids: [A, B] }, action: { type: "takeover_clear" } });
  assert.equal(cleared.envelope.data.action, "takeover_clear");
  const tagClear = await cli(["--json", "screen", "takeover", "clear", "--tag", "Lobby"], transport, env);
  assert.equal(tagClear.code, 0);
  assert.deepEqual(last(transport).body, { selector: { by: "tag", tag: "Lobby" }, action: { type: "takeover_clear" } });
  const guarded = await cli(["--json", "screen", "takeover", "clear", A, B, "--expect-rev", "3"], transport, env);
  assert.equal(guarded.code, ExitCode.Usage);
});

test("screen takeover validates its inputs locally", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  const before = transport.calls.length;
  for (const [args, message] of [
    [[A], /--playlist-id/],
    [[A, "--playlist-id", "pl_X", "--for", "8d"], /under 7 days \(at most 6d23h59m\)/],
    [[A, "--playlist-id", "pl_X", "--for", "7d"], /under 7 days/],
    [[A, "--playlist-id", "pl_X", "--until", "2026-08-15T18:00Z"], /with seconds and an offset/],
    [[A, "--playlist-id", "pl_X", "--until", "2026-08-15t18:00:00z"], /with seconds and an offset/],
    [[A, "--playlist-id", "pl_X", "--until", "2026-13-01T18:00:00Z"], /RFC 3339/],
    [[A, "--playlist-id", "pl_X", "--until", "2026-02-30T18:00:00Z"], /RFC 3339/],
    [[A, "--playlist-id", "pl_X", "--until", "2026-08-15T18:00:00+25:00"], /RFC 3339/],
    [[A, "--playlist-id", "pl_X", "--reason", "   "], /must not be empty/],
    [[A, "--playlist-id", "pl_X", "--reason", "drill\u0085now"], /control characters/],
    [[A, "--playlist-id", "pl_X", "--reason", "drill\tnow"], /control characters/],
    [[A, "--playlist-id", "pl_X", "--for", "soon"], /duration such as 30m/],
    [[A, "--playlist-id", "pl_X", "--for", "0m"], /duration such as 30m/],
    [[A, "--playlist-id", "pl_X", "--until", "tomorrow"], /RFC 3339 instant with seconds and an offset/],
    [[A, "--playlist-id", "pl_X", "--until", "2026-08-15T18:00:00"], /and an offset/],
    [[A, "--playlist-id", "pl_X", "--for", "1h", "--until", "none"], /--until cannot be used with --for|--for cannot be used with --until/],
    [[A, "--playlist-id", "pl_X", "--reason", "x".repeat(121)], /at most 120 characters/],
    [[A, "--playlist-id", "pl_X", "--tag", "Lobby"], /give only one/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "screen", "takeover", ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message);
  }
  assert.equal(transport.calls.length, before);
  assert.equal(durationMs("1h30m"), 5_400_000);
  assert.equal(durationMs("6d23h59m"), 7 * 86_400_000 - 60_000);
  assert.equal(takeoverUntil("2026-08-15T11:00:00-07:00", undefined, NOW), "2026-08-15T18:00:00Z", "offsets normalize to UTC");
  assert.equal(takeoverUntil("2026-08-15T18:00:00.250Z", undefined, NOW), "2026-08-15T18:00:00.250Z");
  assert.equal(takeoverUntil(undefined, "2h", NOW), "2026-08-14T19:00:00Z");
  assert.equal(takeoverUntil("none", undefined, NOW), null);
  assert.equal(takeoverUntil(undefined, undefined, NOW), undefined);
});

test("a --for takeover rerun supersedes its obsolete saved key", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("POST", `/api/screens/${A}/takeover`, () => { throw new Error("socket hang up"); });
  const first = await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_X", "--for", "30m"], transport, env);
  assert.notEqual(first.code, 0);
  const pending = JSON.parse(await readFile(env.configPath, "utf8")).pending_writes;
  assert.equal(Object.keys(pending).length, 1);
  const second = await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_X", "--for", "45m"], transport, env);
  assert.notEqual(second.code, 0);
  const after = JSON.parse(await readFile(env.configPath, "utf8")).pending_writes;
  assert.equal(Object.keys(after).length, 1, "the rerun replaced the earlier entry");
});

test("screen show and list surface effective_playlist, takeover, and schedule", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  await cli(["--json", "screen", "schedule", "set", A, "--file", "dayparts.json"], transport, env);
  const shown = await cli(["--human", "screen", "show", A], transport, env);
  assert.match(shown.stdout, /^Playlist schedule: 3 entries \(screen schedule show scr_A/m);
  const json = await cli(["--json", "screen", "show", A], transport, env);
  assert.equal(json.envelope.data.effective_playlist.source, "schedule");
  assert.equal(json.envelope.data.playlist_schedule.entries.length, 3);
  const listed = await cli(["--human", "screen", "list"], transport, env);
  assert.match(listed.stdout, new RegExp(`${A}.*pl_BREAKFAST \\(schedule entry breakfast\\)`));

});

test("effective playlist text names the takeover, campaign, schedule entry or default that decides", () => {
  const zone = "America/Los_Angeles";
  const until = "2026-12-24T18:00:00Z";
  assert.equal(effectivePlaylistText(undefined), undefined);
  assert.equal(effectivePlaylistText({ id: "pl_X", source: "takeover" }), "pl_X (takeover until cleared)");
  assert.equal(effectivePlaylistText({ id: "pl_X", source: "takeover", until }, undefined, zone), "pl_X (takeover until 2026-12-24 10:00 America/Los_Angeles)");
  assert.equal(effectivePlaylistText({ id: "pl_X", source: "campaign", entry_id: "cmp_HOLIDAY" }), "pl_X (campaign cmp_HOLIDAY)");
  assert.equal(effectivePlaylistText({ id: "pl_X", source: "campaign", entry_id: "cmp_HOLIDAY", until }, undefined, zone), "pl_X (campaign cmp_HOLIDAY until 2026-12-24 10:00 America/Los_Angeles)");
  assert.equal(effectivePlaylistText({ id: "pl_X", source: "campaign" }), "pl_X (campaign)");
  assert.equal(effectivePlaylistText({ id: "pl_X", source: "schedule", entry_id: "lunch", until }, undefined, zone), "pl_X (schedule entry lunch until 2026-12-24 10:00 America/Los_Angeles)");
  assert.equal(effectivePlaylistText({ id: "pl_X", source: "default" }), "pl_X (default)");
  assert.equal(effectivePlaylistText({ id: "pl_X", source: "default", until }, undefined, zone), "pl_X (default, a campaign or schedule changes it until 2026-12-24 10:00 America/Los_Angeles)");
});

test("playlist delete in use points at the screens that can still show it", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_DRILL"], transport, env);
  const refused = await cli(["--json", "playlist", "delete", "pl_DRILL"], transport, env);
  assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
  assert.equal(refused.envelope.error!.code, "resource_conflict");
  assert.equal(refused.envelope.error!.next!.command, "screenrig screen list");
  assert.match(refused.envelope.error!.next!.reason, /effective_playlist/);
  assert.match(refused.envelope.error!.next!.reason, /shown by a campaign.*campaign explain ID names the campaign a screen plays/);
});

test("effective-playlist events render in human event output", () => {
  const base = { cursor: "ev1_1", sequence: 1, severity: "info", at: "2026-08-14T17:00:00.000Z", resource: { type: "screen", id: A } } as const;
  assert.equal(
    formatEventLine({ ...base, type: "screen.playlist_switched", message: "Screen effective playlist switched", details: { playlist_id: "pl_LUNCH", previous_playlist_id: "pl_BREAKFAST", source: "schedule", entry_id: "lunch", until: "2026-08-14T22:00:00Z" } } as any),
    `at=2026-08-14T17:00:00.000Z type=screen.playlist_switched severity=info resource_type=screen resource_id=${A} entry_id=lunch playlist_id=pl_LUNCH previous_playlist_id=pl_BREAKFAST source=schedule until=2026-08-14T22:00:00Z`,
  );
  assert.equal(
    formatEventLine({ ...base, type: "screen.takeover_started", message: "Screen takeover started", details: { playlist_id: "pl_DRILL", until: null, reason: "Fire drill" } } as any),
    `at=2026-08-14T17:00:00.000Z type=screen.takeover_started severity=info resource_type=screen resource_id=${A} playlist_id=pl_DRILL reason="Fire drill" until=none`,
  );
  for (const reason of ["expired", "cleared", "replaced", "playlist_deleted", "playlist_unavailable"]) {
    assert.equal(
      formatEventLine({ ...base, type: "screen.takeover_ended", message: "Screen takeover ended", details: { playlist_id: "pl_DRILL", reason } } as any),
      `at=2026-08-14T17:00:00.000Z type=screen.takeover_ended severity=info resource_type=screen resource_id=${A} playlist_id=pl_DRILL reason=${reason}`,
    );
  }
  assert.equal(
    formatEventLine({ ...base, type: "screen.playlist_unavailable", severity: "warning", message: "A scheduled playlist cannot be shown; its entries were skipped", details: { playlist_id: "pl_LUNCH", entry_ids: ["lunch", "late_lunch"], code: "playlist_deleted" } } as any),
    `at=2026-08-14T17:00:00.000Z type=screen.playlist_unavailable severity=warning resource_type=screen resource_id=${A} code=playlist_deleted entry_ids=lunch,late_lunch playlist_id=pl_LUNCH`,
  );
});
