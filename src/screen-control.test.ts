import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { formatEventLine } from "./commands.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { durationMs, scheduleEntries, takeoverUntil } from "./screen-control.js";
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
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
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
  assert.equal(call.path, `/api/v1/screens/${A}/playlist-schedule`);
  assert.deepEqual(call.body, DAYPARTS);
  assert.equal(call.headers?.["if-match"], '"2"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.deepEqual(set.envelope.data.effective_playlist, { id: "pl_BREAKFAST", source: "schedule", entry_id: "breakfast" });
  assert.equal(set.envelope.data.playlist_schedule.entries.length, 3);

  const human = await cli(["--human", "screen", "schedule", "set", A, "--file", "dayparts.json"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Set a 3-entry playlist schedule on scr_A/m);
  assert.match(human.stdout, /^Playing: pl_BREAKFAST \(schedule entry breakfast\)$/m);
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
  assert.equal(last(transport).path, `/api/v1/screens/${A}/playlist-schedule`);
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
  const transport = new FakeTransport().on("POST", `/api/v1/screens/${A}/takeover`, () => ({
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
  assert.equal(call.path, "/api/v1/screens/actions");
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
  assert.equal(zoneless.envelope.error!.next!.command, `screenrig screen set-timezone ${C} --timezone America/Los_Angeles`);

  const archived = new FakeTransport().on("PUT", `/api/v1/screens/${A}/playlist-schedule`, () => ({
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

test("screen takeover sets one screen with --for, --until, or held until cleared", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  const timed = await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_DRILL", "--for", "30m", "--reason", "Fire drill", "--expect-rev", "2"], transport, env);
  assert.equal(timed.code, 0, timed.stdout);
  let call = last(transport);
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/v1/screens/${A}/takeover`);
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
  assert.match(held.stdout, /^Playing: pl_NOTICE \(takeover until cleared\)$/m);
  assert.match(held.stdout, /^Takeover: pl_NOTICE until cleared$/m);

  const omitted = await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_NOTICE"], transport, env);
  assert.equal(omitted.code, 0);
  assert.deepEqual(last(transport).body, { playlist_id: "pl_NOTICE" }, "no until means held until cleared");

  const shown = await cli(["--human", "screen", "show", A], transport, env);
  assert.match(shown.stdout, /^Playing: pl_NOTICE \(takeover until cleared\)$/m);

  const cleared = await cli(["--json", "screen", "takeover", "clear", A], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  call = last(transport);
  assert.equal(call.method, "DELETE");
  assert.equal(call.path, `/api/v1/screens/${A}/takeover`);
  assert.equal(cleared.envelope.data.takeover, undefined);
});

test("takeover instants print in the screen timezone; server until refusals and skew hints", async () => {
  const env = await enrolled();
  const transport = await backend(env);
  const timed = await cli(["--human", "screen", "takeover", A, "--playlist-id", "pl_DRILL", "--for", "30m", "--reason", "  Fire drill  "], transport, env);
  assert.equal(timed.code, 0, timed.stderr);
  assert.equal((transport.calls.at(-1)!.body as { reason?: string }).reason, "Fire drill", "reason is trimmed");
  assert.match(timed.stdout, /^Took over scr_A\w+ with pl_DRILL until 2026-08-14 10:30 America\/Los_Angeles$/m);
  assert.match(timed.stdout, /^Playing: pl_DRILL \(takeover until 2026-08-14 10:30 America\/Los_Angeles\)$/m);
  assert.match(timed.stdout, /^Takeover: pl_DRILL until 2026-08-14 10:30 America\/Los_Angeles \(Fire drill\)$/m);

  const past = await cli(["--json", "screen", "takeover", A, "--playlist-id", "pl_DRILL", "--until", "2026-08-14T16:00:00Z"], transport, env);
  assert.equal(past.code, ExitCode.Client);
  assert.equal(past.envelope.error!.detail, "until: must be in the future");
  assert.equal(past.envelope.error!.next, undefined, "an explicit --until gets no --for hint");

  // This computer's clock runs two minutes ahead of the server's.
  const skewed = memoryBackend({ now: () => new Date(NOW.getTime() - 2 * 60_000) });
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
  const transport = new FakeTransport().on("PUT", `/api/v1/screens/${A}/playlist-schedule`, () => ({
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
    [[A, "--playlist-id", "pl_X", "--for", "1h", "--until", "none"], /Conflicting options/],
    [[A, "--playlist-id", "pl_X", "--reason", "x".repeat(121)], /at most 120 characters/],
    [[A, "--playlist-id", "pl_X", "--tag", "Lobby"], /not both/],
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
  const transport = new FakeTransport().on("POST", `/api/v1/screens/${A}/takeover`, () => { throw new Error("socket hang up"); });
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
  assert.match(shown.stdout, /^Playing: pl_BREAKFAST \(schedule entry breakfast\)$/m);
  assert.match(shown.stdout, /^Playlist schedule: 3 entries \(screen schedule show scr_A/m);
  const json = await cli(["--json", "screen", "show", A], transport, env);
  assert.equal(json.envelope.data.effective_playlist.source, "schedule");
  assert.equal(json.envelope.data.playlist_schedule.entries.length, 3);
  const listed = await cli(["--human", "screen", "list"], transport, env);
  assert.match(listed.stdout, /PLAYING/);
  assert.match(listed.stdout, new RegExp(`${A}.*pl_BREAKFAST \\(schedule entry breakfast\\)`));

  const plain = new FakeTransport().on("GET", "/api/v1/screens", () => ({ status: 200, headers: {}, body: { items: [
    { id: A, label: "A", state: "active", revision: 1, public_id: "p", manifest_revision: 1, content_access_generation: 1, online: true, created_at: "x", updated_at: "x", playlist_id: "pl_A", effective_playlist: { id: "pl_A", source: "default" } },
  ] } })).on("GET", `/api/v1/screens/${A}`, () => ({ status: 200, headers: {}, body: {
    id: A, label: "A", state: "active", revision: 1, playlist_id: "pl_A", effective_playlist: { id: "pl_A", source: "default", until: "2026-08-15T13:00:00Z" },
  } }));
  const defaults = await cli(["--human", "screen", "list"], plain, env);
  assert.doesNotMatch(defaults.stdout, /PLAYING/, "a fleet on defaults keeps its table");
  const defaultShow = await cli(["--human", "screen", "show", A], plain, env);
  assert.match(defaultShow.stdout, /^Playing: pl_A \(default, schedule changes it until 2026-08-15 13:00 UTC\)$/m, "no zone falls back to labelled UTC");
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
