import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { LiveSession } from "./adapters/protocol.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help.js";
import { run, type CliRuntime } from "./main.js";
import { liveDurationSeconds, liveHumanLines, liveScreenId, liveSessionBody, liveSettled, liveWaitMs, settleLive } from "./screen-live.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const SCREEN = "scr_LIVEAAAAAAAAAAAAAAAAAAA";
const VIEWER_URL = `https://screenrig.ai/dashboard/screens/${SCREEN}/screenshot`;
const START = new Date("2026-10-28T12:00:00.000Z");

function session(extra: Partial<LiveSession> = {}): LiveSession {
  return { state: "requested", screen_id: SCREEN, live_id: "lv_aaaaaaaaaaaaaaaaaaaaaaaaaa", created_at: "2026-10-28T12:00:00Z",
    lease_until: "2026-10-28T12:05:00Z", max_until: "2026-10-28T12:05:00Z", viewer_url: VIEWER_URL, ...extra };
}
const connected = (): LiveSession => session({ state: "publishing", publisher: { connected: true, connection: "connected", reported_at: "2026-10-28T12:00:03Z", width: 1280, height: 720, fps: 15 } });
const publishing = (): LiveSession => session({ state: "publishing", publisher: { connected: false, connection: "connecting", reported_at: "2026-10-28T12:00:03Z" } });
const ended = (reason: string): LiveSession => session({ state: "ended", ended_at: "2026-10-28T12:00:05Z", ended_reason: reason });

test("--duration and --wait are whole-unit durations inside the contract's bounds", () => {
  for (const [text, seconds] of [["30s", 30], ["90s", 90], ["5m", 300], ["300s", 300], [" 2m ", 120]] as const) {
    assert.equal(liveDurationSeconds(text), seconds, text);
  }
  for (const text of ["29s", "301s", "6m", "1h", "3600s", "0s", "5", "soon", "", "-5m", "1.5m"]) {
    assert.throws(() => liveDurationSeconds(text), /--duration/, text);
  }
  for (const [text, ms] of [["0", 0], ["0s", 0], ["1s", 1000], ["30s", 30_000], ["1m", 60_000], ["10m", 600_000]] as const) {
    assert.equal(liveWaitMs(text), ms, text);
  }
  for (const text of ["11m", "1h", "soon", "", "-1s", "1.5s"]) {
    assert.throws(() => liveWaitMs(text), /--wait/, text);
  }
});

test("a screen id is checked before any request", () => {
  assert.equal(liveScreenId(SCREEN, "start"), SCREEN);
  assert.throws(() => liveScreenId(undefined, "start"), /screen live start requires <id>/);
  assert.throws(() => liveScreenId("pl_PLAYLIST", "stop"), /scr_/);
});

test("only a LiveSession shaped answer is a session", () => {
  assert.deepEqual(liveSessionBody(session()), session());
  for (const body of [undefined, null, "text", {}, { state: "live", screen_id: SCREEN, viewer_url: "x" }, { state: "idle", viewer_url: "x" }, { state: "idle", screen_id: SCREEN }]) {
    assert.equal(liveSessionBody(body), undefined, JSON.stringify(body));
  }
  assert.equal(liveSettled(session()), false);
  assert.equal(liveSettled(publishing()), false);
  assert.equal(liveSettled(connected()), true);
  assert.equal(liveSettled(ended("stopped")), true);
  assert.equal(liveSettled(session({ state: "idle" })), true);
});

function clockWithSleep(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let time = START.getTime();
  const slept: number[] = [];
  return { now: () => time, sleep: async (ms) => { slept.push(ms); time += ms; }, slept };
}

test("settleLive reads every second until connected, ended, or the wait is over", async () => {
  const reads = (...answers: LiveSession[]) => {
    let index = 0;
    return async () => answers[Math.min(index++, answers.length - 1)]!;
  };

  const clock = clockWithSleep();
  const done = await settleLive(session(), reads(session(), publishing(), connected()), { waitMs: 30_000, ...clock });
  assert.equal(done.publisher?.connected, true);
  assert.deepEqual(clock.slept, [1000, 1000, 1000]);

  const stopped = clockWithSleep();
  assert.equal((await settleLive(session(), reads(ended("consent_timeout")), { waitMs: 30_000, ...stopped })).state, "ended");
  assert.deepEqual(stopped.slept, [1000]);

  // The wait is a ceiling, and the last sleep is cut to fit it.
  const short = clockWithSleep();
  const last = await settleLive(session(), reads(session()), { waitMs: 2500, ...short });
  assert.equal(last.state, "requested");
  assert.deepEqual(short.slept, [1000, 1000, 500]);

  // Already connected, or no wait: nothing is read.
  const none = clockWithSleep();
  let calls = 0;
  const counting = async () => { calls += 1; return session(); };
  await settleLive(connected(), counting, { waitMs: 30_000, ...none });
  await settleLive(session(), counting, { waitMs: 0, ...none });
  assert.equal(calls, 0);
});

test("human lines name the state, the Player's report and the page to open", () => {
  assert.match(liveHumanLines(connected()), /^Live view of scr_LIVEAAAAAAAAAAAAAAAAAAA: publishing\nlive_id: lv_a+\npublisher: connected 1280x720 at 15 fps\n/);
  assert.match(liveHumanLines(connected()), new RegExp(`Watch it in the dashboard: ${VIEWER_URL}$`));
  assert.match(liveHumanLines(publishing()), /publisher: connecting\n/);
  const text = liveHumanLines(ended("consent_denied"));
  assert.match(text, /ended_reason: consent_denied/);
  assert.doesNotMatch(text, /Watch it/);
});

interface Env { fs: ConfigFs; cwd: string }
interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; next?: { command: string; reason: string } };
  warnings?: Array<{ code: string; message: string }>;
}

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<Env> {
  const configDir = await testTemp("screen-live-cfg-");
  const cwd = await testTemp("screen-live-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, clock = clockWithSleep()): Promise<{ code: number; stdout: string; envelope: Envelope; slept: number[] }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  void collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr, now: () => new Date(clock.now()), sleep: clock.sleep,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await out;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human */ }
  return { code, stdout: text, envelope, slept: clock.slept };
}

const ok = (body: unknown): TransportResponse => ({ status: 200, headers: { "cache-control": "no-store", "x-request-id": "req_live" }, body });
const refusal = (status: number, code: string, detail: string): TransportResponse => ({
  status, headers: { "content-type": "application/problem+json" }, body: { status, code, title: "Refused", detail },
});

/** The live routes of one screen: POST answers `started`, each GET the next of `reads`, DELETE 204. */
function liveTransport(started: LiveSession | TransportResponse, reads: LiveSession[] = []): FakeTransport {
  const transport = new FakeTransport();
  let index = 0;
  const path = `/api/screens/${SCREEN}/live`;
  transport.on("POST", path, () => ("status" in started ? started : ok(started)));
  transport.on("GET", path, () => ok(reads[Math.min(index++, reads.length - 1)] ?? session({ state: "idle" })));
  transport.on("DELETE", path, () => ({ status: 204, headers: { "cache-control": "no-store" }, body: undefined }));
  return transport;
}

const calls = (transport: FakeTransport, method: string): TransportRequest[] => transport.calls.filter((call) => call.method === method && call.path === `/api/screens/${SCREEN}/live`);

test("screen live start asks for the session and reads it until the Player is connected", async () => {
  const env = await enrolled();
  const transport = liveTransport(session(), [session(), publishing(), connected()]);
  const result = await cli(["--json", "screen", "live", "start", SCREEN], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(result.envelope.ok, true);
  assert.equal(result.envelope.data.state, "publishing");
  assert.equal(result.envelope.data.publisher.connected, true);
  assert.equal(result.envelope.data.viewer_url, VIEWER_URL);
  assert.deepEqual(result.envelope.warnings, []);
  assert.equal(calls(transport, "POST").length, 1);
  assert.equal(calls(transport, "POST")[0]!.body, undefined, "the server's 5 minutes applies");
  assert.equal(calls(transport, "GET").length, 3);
  assert.deepEqual(result.slept, [1000, 1000, 1000]);
});

test("screen live start sends --duration as duration_s and honors --wait", async () => {
  const env = await enrolled();
  const transport = liveTransport(session(), [session()]);
  const result = await cli(["--json", "screen", "live", "start", SCREEN, "--duration", "2m", "--wait", "3s"], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.deepEqual(calls(transport, "POST")[0]!.body, { duration_s: 120 });
  assert.equal(calls(transport, "GET").length, 3);
  assert.deepEqual(result.slept, [1000, 1000, 1000]);
});

test("a session still requested when the wait is over is ok with the warning live_not_ready", async () => {
  const env = await enrolled();
  const requested = await cli(["--json", "screen", "live", "start", SCREEN, "--wait", "2s"], liveTransport(session(), [session()]), env);
  assert.equal(requested.code, ExitCode.Success, requested.stdout);
  assert.equal(requested.envelope.ok, true);
  assert.equal(requested.envelope.data.state, "requested");
  assert.deepEqual(requested.envelope.warnings?.map((warning) => warning.code), ["live_not_ready"]);
  assert.match(requested.envelope.warnings![0]!.message, /not started publishing/);

  const connecting = await cli(["--json", "screen", "live", "start", SCREEN, "--wait", "1s"], liveTransport(session(), [publishing()]), env);
  assert.equal(connecting.code, ExitCode.Success, connecting.stdout);
  assert.deepEqual(connecting.envelope.warnings?.map((warning) => warning.code), ["live_not_ready"]);
  assert.match(connecting.envelope.warnings![0]!.message, /has not reported connected/);

  // --wait 0 returns what the start answered, and reads nothing.
  const transport = liveTransport(session(), [connected()]);
  const now = await cli(["--json", "screen", "live", "start", SCREEN, "--wait", "0"], transport, env);
  assert.equal(now.code, ExitCode.Success, now.stdout);
  assert.equal(now.envelope.data.state, "requested");
  assert.equal(calls(transport, "GET").length, 0);
});

test("a renewal of a connected session returns at once", async () => {
  const env = await enrolled();
  const transport = liveTransport(connected(), []);
  const result = await cli(["--json", "screen", "live", "start", SCREEN], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(calls(transport, "GET").length, 0);
  assert.deepEqual(result.slept, []);
  assert.deepEqual(result.envelope.warnings, []);
});

test("a session that ended while waiting is live_unavailable naming ended_reason", async () => {
  const env = await enrolled();
  const result = await cli(["--json", "screen", "live", "start", SCREEN], liveTransport(session(), [session(), ended("consent_timeout")]), env);
  assert.equal(result.code, ExitCode.Conflict, result.stdout);
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.error?.code, "live_unavailable");
  assert.match(result.envelope.error!.detail, /ended_reason consent_timeout/);
  assert.match(result.envelope.error!.detail, /once each time the Player starts/);
  assert.equal(result.envelope.error?.next?.command, `screenrig screen live start ${SCREEN}`);

  const vanished = await cli(["--json", "screen", "live", "start", SCREEN], liveTransport(session(), [session({ state: "idle" })]), env);
  assert.equal(vanished.envelope.error?.code, "live_unavailable");
});

test("a session that reached its end by itself says it lasted five minutes", async () => {
  const env = await enrolled();
  const result = await cli(["--json", "screen", "live", "start", SCREEN], liveTransport(session(), [session(), ended("expired")]), env);
  assert.equal(result.envelope.error?.code, "live_unavailable");
  assert.match(result.envelope.error!.detail, /ended_reason expired/);
  assert.match(result.envelope.error!.detail, /five minutes/);
});

test("the server's refusals come with the next step", async () => {
  const env = await enrolled();
  for (const [status, code, next, exit] of [
    [409, "live_unsupported", `screenrig screen screenshot ${SCREEN}`, ExitCode.Conflict],
    [409, "live_unavailable", `screenrig screen show ${SCREEN}`, ExitCode.Conflict],
    [404, "feature_unavailable", `screenrig screen screenshot ${SCREEN}`, ExitCode.NotFound],
    [409, "screen_archived", `screenrig screen unarchive ${SCREEN}`, ExitCode.Conflict],
  ] as const) {
    const transport = liveTransport(refusal(status, code, "The server says no."));
    const result = await cli(["--json", "screen", "live", "start", SCREEN], transport, env);
    assert.equal(result.code, exit, `${code}: ${result.stdout}`);
    assert.equal(result.envelope.error?.code, code);
    assert.equal(result.envelope.error?.next?.command, next, code);
    assert.equal(calls(transport, "GET").length, 0, "a refused start reads nothing");
  }
});

test("a bad value fails before any request", async () => {
  const env = await enrolled();
  const transport = liveTransport(session());
  for (const argv of [
    ["screen", "live", "start", SCREEN, "--duration", "10s"],
    ["screen", "live", "start", SCREEN, "--duration", "6m"],
    ["screen", "live", "start", SCREEN, "--duration", "1h"],
    ["screen", "live", "start", SCREEN, "--wait", "11m"],
    ["screen", "live", "start", "pl_PLAYLIST"],
    ["screen", "live", "status", "nope"],
    ["screen", "live", "stop", "nope"],
  ]) {
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    assert.equal(result.envelope.error?.code, "usage_error");
  }
  assert.equal(transport.calls.length, 0);
});

test("a start that is not a LiveSession is an unexpected response", async () => {
  const env = await enrolled();
  const result = await cli(["--json", "screen", "live", "start", SCREEN], liveTransport({ status: 200, headers: {}, body: { hello: "world" } }), env);
  assert.equal(result.envelope.ok, false);
  assert.match(result.envelope.error!.detail, /LiveSession/);
});

test("screen live status and stop read the session", async () => {
  const env = await enrolled();
  const status = await cli(["--json", "screen", "live", "status", SCREEN], liveTransport(session(), [connected()]), env);
  assert.equal(status.code, ExitCode.Success, status.stdout);
  assert.equal(status.envelope.data.publisher.connected, true);

  const idle = await cli(["--json", "screen", "live", "status", SCREEN], liveTransport(session(), [session({ state: "idle", live_id: undefined })]), env);
  assert.equal(idle.envelope.data.state, "idle");
  assert.equal(idle.envelope.data.viewer_url, VIEWER_URL);

  const transport = liveTransport(session(), [ended("stopped")]);
  const stopped = await cli(["--json", "screen", "live", "stop", SCREEN], transport, env);
  assert.equal(stopped.code, ExitCode.Success, stopped.stdout);
  assert.equal(stopped.envelope.data.state, "ended");
  assert.equal(stopped.envelope.data.ended_reason, "stopped");
  assert.deepEqual(transport.calls.filter((call) => call.path === `/api/screens/${SCREEN}/live`).map((call) => call.method), ["DELETE", "GET"]);

  const human = await cli(["--human", "screen", "live", "status", SCREEN], liveTransport(session(), [connected()]), env);
  assert.match(human.stdout, new RegExp(`Watch it in the dashboard: ${VIEWER_URL}`));
});

test("help names the subcommands and what they never carry", () => {
  const group = commandHelp(["screen", "live"]);
  assert.equal(group.kind, "group");
  assert.deepEqual(group.commands?.map((command) => command.name).sort(), ["frame", "start", "status", "stop"]);
  assert.ok(group.notes.length > 0);
  assert.match(group.notes.join("\n"), /never carries video/);
  const start = commandHelp(["screen", "live", "start"]);
  assert.match(start.usage, /screen live start \[options\] <id>/);
  assert.deepEqual(start.options.map((option) => option.name).filter((option) => option !== "--help"), ["--duration", "--wait"]);
  assert.match(start.notes.join("\n"), /live_not_ready/);
  assert.match(start.notes.join("\n"), /five minutes/);
  assert.equal(start.options.find((option) => option.name === "--duration")?.description.includes("30s to 5m"), true);
  assert.ok(start.examples.some((example) => /screenrig screen live start scr_SCREEN/.test(example)));
});
