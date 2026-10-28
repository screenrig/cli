import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { LiveSession } from "./adapters/protocol.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help.js";
import { run, type CliRuntime } from "./main.js";
import { LIVE_DURATION_MAX_S } from "./screen-live.js";
import { liveFrameFileName, liveFrameIntervalMs, liveFrameLeaseSeconds, liveFramesBody, readLiveFrame, resolveFrameOutput } from "./screen-live-frame.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const SCREEN = "scr_LIVEAAAAAAAAAAAAAAAAAAA";
const LIVE = "lv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const VIEWER_URL = `https://screenrig.ai/dashboard/screens/${SCREEN}/screenshot`;
const START = new Date("2026-10-28T12:00:00.000Z");
const LIVE_PATH = `/api/screens/${SCREEN}/live`;
const FRAMES_PATH = `${LIVE_PATH}/frames`;
const FRAME_PATH = `${LIVE_PATH}/frame`;

function session(extra: Partial<LiveSession> = {}): LiveSession {
  return { state: "requested", screen_id: SCREEN, live_id: LIVE, created_at: "2026-10-28T12:00:00Z",
    lease_until: "2026-10-28T12:02:00Z", max_until: "2026-10-28T13:00:00Z", viewer_url: VIEWER_URL, ...extra };
}
const publishing = (): LiveSession => session({ state: "publishing", publisher: { connected: true, connection: "connected", reported_at: "2026-10-28T12:00:03Z", width: 1280, height: 720, fps: 15 } });
const ended = (reason: string): LiveSession => session({ state: "ended", ended_at: "2026-10-28T12:00:05Z", ended_reason: reason });

/** A JPEG as far as the CLI looks: its start-of-image marker, then bytes that make this frame its own. */
function jpeg(shade: number): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, shade, shade, 0xff, 0xd9]);
}
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function frameResponse(bytes: Uint8Array, capturedAt: string, extra: Record<string, string> = {}): TransportResponse {
  return {
    status: 200,
    headers: {
      "content-type": "image/jpeg", "content-length": String(bytes.byteLength), etag: `"${sha(bytes)}"`, "cache-control": "no-store",
      "screenrig-live-id": LIVE, "screenrig-captured-at": capturedAt, "screenrig-frame-width": "1280", "screenrig-frame-height": "720", ...extra,
    },
    body: bytes,
  };
}

test("--interval is a whole-unit duration or 0, and the lease covers the frames", () => {
  for (const [text, ms] of [["0", 0], ["0s", 0], ["1s", 1000], ["30s", 30_000], ["5m", 300_000], [" 2s ", 2000]] as const) {
    assert.equal(liveFrameIntervalMs(text), ms, text);
  }
  for (const text of ["6m", "1h", "soon", "", "-1s", "1.5s", "500ms"]) {
    assert.throws(() => liveFrameIntervalMs(text), /--interval/, text);
  }
  // The default session is two minutes; more frames, or a longer pause, ask for more.
  assert.equal(liveFrameLeaseSeconds(undefined, 1, 1000), 120);
  assert.equal(liveFrameLeaseSeconds(60, 5, 1000), 60);
  assert.equal(liveFrameLeaseSeconds(undefined, 100, 2000), 230);
  assert.equal(liveFrameLeaseSeconds(undefined, 200, 0), 230, "an interval of 0 still costs the second the relay takes per frame");
  assert.equal(liveFrameLeaseSeconds(200, 5, 1000), 200);
  assert.throws(() => liveFrameLeaseSeconds(undefined, LIVE_DURATION_MAX_S, 1000), new RegExp(`longer than the ${LIVE_DURATION_MAX_S}s a session can last`));
});

test("a frame is named by when it was captured, in a name every filesystem accepts", () => {
  assert.equal(liveFrameFileName("2026-10-28T12:00:03.123456789Z"), "frame-2026-10-28T12-00-03.123456789Z.jpg");
});

test("--output names a directory, or one file for one frame", async () => {
  const cwd = await testTemp("frame-output-");
  await mkdir(path.join(cwd, "shots"));
  assert.deepEqual(await resolveFrameOutput(cwd, undefined, 5), { directory: cwd });
  assert.deepEqual(await resolveFrameOutput(cwd, "shots", 5), { directory: path.join(cwd, "shots") });
  assert.deepEqual(await resolveFrameOutput(cwd, "later/", 3), { directory: path.join(cwd, "later") });
  assert.deepEqual(await resolveFrameOutput(cwd, "now.jpg", 1), { directory: cwd, file: path.join(cwd, "now.jpg") });
  assert.deepEqual(await resolveFrameOutput(cwd, "sub/now.jpg", 1), { directory: path.join(cwd, "sub"), file: path.join(cwd, "sub", "now.jpg") });
  await assert.rejects(resolveFrameOutput(cwd, "now.jpg", 2), /--output must be a directory with --count above 1/);
});

test("only a LiveFrames shaped answer is an adapter", () => {
  assert.deepEqual(liveFramesBody({ live_id: LIVE, state: "starting" }), { live_id: LIVE, state: "starting" });
  assert.equal(liveFramesBody({ live_id: LIVE, state: "streaming", last_frame_at: "2026-10-28T12:00:03Z" })?.state, "streaming");
  for (const body of [undefined, null, "x", {}, { live_id: LIVE }, { state: "starting" }, { live_id: LIVE, state: "ready" }, { live_id: 4, state: "silent" }]) {
    assert.equal(liveFramesBody(body), undefined, JSON.stringify(body));
  }
});

test("a frame is checked against its own headers", () => {
  const bytes = jpeg(7);
  const good = readLiveFrame(frameResponse(bytes, "2026-10-28T12:00:03.5Z"));
  assert.deepEqual({ ...good, jpeg: undefined }, { live_id: LIVE, captured_at: "2026-10-28T12:00:03.5Z", width: 1280, height: 720, jpeg: undefined, sha256: sha(bytes) });
  assert.deepEqual(good.jpeg, bytes);

  const broken: Array<[string, TransportResponse]> = [
    ["not a JPEG", { ...frameResponse(bytes, "2026-10-28T12:00:03Z"), body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2]) }],
    ["a text body", { ...frameResponse(bytes, "2026-10-28T12:00:03Z"), body: "hello" }],
    ["a webp content type", frameResponse(bytes, "2026-10-28T12:00:03Z", { "content-type": "image/webp" })],
    ["no captured-at", frameResponse(bytes, "2026-10-28T12:00:03Z", { "screenrig-captured-at": "" })],
    ["a captured-at that is no time", frameResponse(bytes, "yesterday")],
    ["no width", frameResponse(bytes, "2026-10-28T12:00:03Z", { "screenrig-frame-width": "0" })],
    ["no live id", frameResponse(bytes, "2026-10-28T12:00:03Z", { "screenrig-live-id": "" })],
    ["another ETag", frameResponse(bytes, "2026-10-28T12:00:03Z", { etag: `"${"0".repeat(64)}"` })],
  ];
  for (const [name, response] of broken) assert.throws(() => readLiveFrame(response), /Live frame/, name);
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
  const configDir = await testTemp("screen-live-frame-cfg-");
  const cwd = await testTemp("screen-live-frame-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd };
}

function clockWithSleep(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let time = START.getTime();
  const slept: number[] = [];
  return { now: () => time, sleep: async (ms) => { slept.push(ms); time += ms; }, slept };
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

const ok = (body: unknown, status = 200): TransportResponse => ({ status, headers: { "cache-control": "no-store", "x-request-id": "req_frames" }, body });
const refusal = (status: number, code: string, detail: string, headers: Record<string, string> = {}): TransportResponse => ({
  status, headers: { "content-type": "application/problem+json", ...headers }, body: { status, code, title: "Refused", detail },
});
const notYet = (): TransportResponse => refusal(409, "live_not_ready", "No new frame arrived within five seconds.", { "retry-after": "1" });

interface Script {
  /** POST live answers `started`, each GET live the next of `reads`. */
  started?: LiveSession | TransportResponse;
  reads?: LiveSession[];
  /** POST frames answers each of these in turn, the last repeating. */
  frames?: TransportResponse[];
  /** GET frame answers each of these in turn. */
  shots: TransportResponse[];
}

function framesTransport(script: Script): FakeTransport {
  const transport = new FakeTransport();
  const started = script.started ?? publishing();
  let read = 0;
  let posted = 0;
  let shot = 0;
  transport.on("POST", LIVE_PATH, () => ("status" in started ? started : ok(started)));
  transport.on("GET", LIVE_PATH, () => ok(script.reads?.[Math.min(read++, script.reads.length - 1)] ?? session({ state: "idle" })));
  transport.on("DELETE", LIVE_PATH, () => ({ status: 204, headers: { "cache-control": "no-store" }, body: undefined }));
  const frames = script.frames ?? [ok({ live_id: LIVE, state: "starting" }, 202)];
  transport.on("POST", FRAMES_PATH, () => frames[Math.min(posted++, frames.length - 1)]!);
  transport.on("GET", FRAME_PATH, () => script.shots[Math.min(shot++, script.shots.length - 1)]!);
  return transport;
}

const sent = (transport: FakeTransport, method: string, route: string): TransportRequest[] => transport.calls.filter((call) => call.method === method && call.path === route);

test("screen live frame starts the session, starts frames and saves the frame", async () => {
  const env = await enrolled();
  const bytes = jpeg(1);
  const transport = framesTransport({ shots: [frameResponse(bytes, "2026-10-28T12:00:03.123456789Z")] });
  const result = await cli(["--json", "screen", "live", "frame", SCREEN], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(result.envelope.ok, true);

  const file = path.join(env.cwd, "frame-2026-10-28T12-00-03.123456789Z.jpg");
  assert.deepEqual(result.envelope.data, {
    screen_id: SCREEN, live_id: LIVE,
    frames: [{ path: file, captured_at: "2026-10-28T12:00:03.123456789Z", width: 1280, height: 720, bytes: bytes.byteLength, sha256: sha(bytes) }],
  });
  assert.deepEqual(await readFile(file), Buffer.from(bytes));
  assert.deepEqual(sent(transport, "POST", LIVE_PATH).map((call) => call.body), [{ duration_s: 120 }], "the default session is two minutes");
  assert.equal(sent(transport, "POST", FRAMES_PATH).length, 1);
  const read = sent(transport, "GET", FRAME_PATH);
  assert.equal(read.length, 1);
  assert.equal(read[0]!.query?.after, undefined, "the first frame is any frame");
  assert.equal(read[0]!.binary, true);
  assert.equal(read[0]!.headers?.accept, "image/jpeg");
  assert.equal(sent(transport, "DELETE", LIVE_PATH).length, 0, "the session is left to its lease");
  assert.deepEqual(result.slept, []);
  assert.deepEqual(await readdir(env.cwd), [path.basename(file)], "no temp file is left behind");
});

test("--count takes each new frame once, after the one before, --interval apart", async () => {
  const env = await enrolled();
  const times = ["2026-10-28T12:00:03.100Z", "2026-10-28T12:00:04.200Z", "2026-10-28T12:00:05.300Z"];
  const frames = [jpeg(1), jpeg(2), jpeg(3)];
  const transport = framesTransport({ shots: times.map((time, index) => frameResponse(frames[index]!, time)) });
  const result = await cli(["--json", "screen", "live", "frame", SCREEN, "--output", "shots/", "--count", "3", "--interval", "2s"], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.deepEqual(result.envelope.data.frames.map((frame: { captured_at: string }) => frame.captured_at), times);
  assert.deepEqual((await readdir(path.join(env.cwd, "shots"))).sort(), times.map((time) => liveFrameFileName(time)));
  assert.deepEqual(sent(transport, "GET", FRAME_PATH).map((call) => call.query?.after), [undefined, times[0], times[1]]);
  assert.deepEqual(result.slept, [2000, 2000], "a pause between frames, none after the last");
  assert.deepEqual(sent(transport, "POST", LIVE_PATH).map((call) => call.body), [{ duration_s: 120 }]);
  assert.deepEqual(new Set(result.envelope.data.frames.map((frame: { sha256: string }) => frame.sha256)).size, 3, "three different frames");
});

test("a run that takes longer than --duration asks for a longer lease", async () => {
  const env = await enrolled();
  const transport = framesTransport({ shots: [frameResponse(jpeg(1), "2026-10-28T12:00:03Z"), frameResponse(jpeg(2), "2026-10-28T12:00:04Z")] });
  const result = await cli(["--json", "screen", "live", "frame", SCREEN, "--count", "2", "--interval", "2m", "--duration", "1m", "--output", "out/"], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.deepEqual(sent(transport, "POST", LIVE_PATH).map((call) => call.body), [{ duration_s: 270 }]);
});

test("--output names the file of one frame", async () => {
  const env = await enrolled();
  const transport = framesTransport({ shots: [frameResponse(jpeg(9), "2026-10-28T12:00:03Z")] });
  const result = await cli(["--json", "screen", "live", "frame", SCREEN, "--output", "now.jpg"], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(result.envelope.data.frames[0].path, path.join(env.cwd, "now.jpg"));
  assert.deepEqual(await readFile(path.join(env.cwd, "now.jpg")), Buffer.from(jpeg(9)));
});

test("it waits for the Player to publish, then goes on", async () => {
  const env = await enrolled();
  const transport = framesTransport({ started: session(), reads: [session(), session({ state: "publishing" })], shots: [frameResponse(jpeg(1), "2026-10-28T12:00:03Z")] });
  const result = await cli(["--json", "screen", "live", "frame", SCREEN], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.deepEqual(result.slept, [1000, 1000]);
  assert.equal(sent(transport, "GET", LIVE_PATH).length, 2);
  assert.equal(sent(transport, "POST", FRAMES_PATH).length, 1);
});

test("a Player that does not publish within --wait is live_not_ready, and no frames are asked for", async () => {
  const env = await enrolled();
  const transport = framesTransport({ started: session(), reads: [session()], shots: [] });
  const result = await cli(["--json", "screen", "live", "frame", SCREEN, "--wait", "3s"], transport, env);
  assert.equal(result.code, ExitCode.Conflict, result.stdout);
  assert.equal(result.envelope.error?.code, "live_not_ready");
  assert.match(result.envelope.error!.detail, /within 3s/);
  assert.match(result.envelope.error!.detail, /once each time the Player starts/);
  assert.equal(result.envelope.error?.next?.command, `screenrig screen live status ${SCREEN}`);
  assert.deepEqual(result.slept, [1000, 1000, 1000]);
  assert.equal(sent(transport, "POST", FRAMES_PATH).length, 0);

  const now = framesTransport({ started: session(), reads: [session()], shots: [] });
  const immediate = await cli(["--json", "screen", "live", "frame", SCREEN, "--wait", "0"], now, env);
  assert.equal(immediate.envelope.error?.code, "live_not_ready");
  assert.deepEqual(immediate.slept, []);
  assert.equal(sent(now, "GET", LIVE_PATH).length, 0);
});

test("a session that ended while waiting is live_unavailable naming ended_reason", async () => {
  const env = await enrolled();
  const result = await cli(["--json", "screen", "live", "frame", SCREEN], framesTransport({ started: session(), reads: [ended("consent_timeout")], shots: [] }), env);
  assert.equal(result.code, ExitCode.Conflict, result.stdout);
  assert.equal(result.envelope.error?.code, "live_unavailable");
  assert.match(result.envelope.error!.detail, /ended_reason consent_timeout/);
});

test("a frame that is not there yet is asked for again every second until --wait is spent", async () => {
  const env = await enrolled();
  const transport = framesTransport({ shots: [notYet(), notYet(), frameResponse(jpeg(1), "2026-10-28T12:00:03Z")] });
  const result = await cli(["--json", "screen", "live", "frame", SCREEN], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.deepEqual(result.slept, [1000, 1000]);
  assert.equal(sent(transport, "GET", FRAME_PATH).length, 3);
  assert.equal(sent(transport, "POST", FRAMES_PATH).length, 1);
});

test("no new frame within --wait is live_not_ready", async () => {
  const env = await enrolled();
  const result = await cli(["--json", "screen", "live", "frame", SCREEN, "--wait", "3s"], framesTransport({ shots: [notYet()] }), env);
  assert.equal(result.code, ExitCode.Conflict, result.stdout);
  assert.equal(result.envelope.error?.code, "live_not_ready");
  assert.match(result.envelope.error!.detail, /No new frame arrived within 3s/);
  assert.deepEqual(result.slept, [1000, 1000, 1000]);

  // The second frame is as patient as the first.
  const env2 = await enrolled();
  const second = framesTransport({ shots: [frameResponse(jpeg(1), "2026-10-28T12:00:03Z"), notYet()] });
  const stuck = await cli(["--json", "screen", "live", "frame", SCREEN, "--count", "2", "--wait", "2s", "--output", "x/"], second, env2);
  assert.equal(stuck.envelope.error?.code, "live_not_ready");
  assert.equal((await readdir(path.join(env2.cwd, "x"))).length, 1, "the frame that arrived is kept");
});

test("frames that were never started, because the publisher was replaced, are started again", async () => {
  const env = await enrolled();
  const notStarted = refusal(409, "resource_conflict", "Frames were not started for this live session.");
  const transport = framesTransport({ shots: [notStarted, frameResponse(jpeg(1), "2026-10-28T12:00:03Z")] });
  const result = await cli(["--json", "screen", "live", "frame", SCREEN], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(sent(transport, "POST", FRAMES_PATH).length, 2);
  assert.deepEqual(result.slept, [1000]);
});

test("a publisher replaced between the wait and the frames call is waited out", async () => {
  const env = await enrolled();
  const notReady = refusal(409, "live_not_ready", "The screen's Player is not publishing yet.", { "retry-after": "1" });
  const transport = framesTransport({ frames: [notReady, ok({ live_id: LIVE, state: "starting" }, 202)], shots: [frameResponse(jpeg(1), "2026-10-28T12:00:03Z")] });
  const result = await cli(["--json", "screen", "live", "frame", SCREEN], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(sent(transport, "POST", FRAMES_PATH).length, 2);
});

test("the server's refusals come with the next step", async () => {
  const env = await enrolled();
  for (const [route, status, code, next, exit] of [
    ["live", 409, "live_unsupported", `screenrig screen screenshot ${SCREEN}`, ExitCode.Conflict],
    ["frames", 404, "feature_unavailable", `screenrig screen screenshot ${SCREEN}`, ExitCode.NotFound],
    ["frames", 409, "live_unavailable", `screenrig screen live status ${SCREEN}`, ExitCode.Conflict],
    ["shot", 409, "live_unavailable", `screenrig screen live status ${SCREEN}`, ExitCode.Conflict],
    ["shot", 409, "live_session_ended", undefined, ExitCode.Conflict],
  ] as const) {
    const answer = refusal(status, code, "The server says no.");
    const transport = framesTransport({
      ...(route === "live" ? { started: answer } : {}),
      ...(route === "frames" ? { frames: [answer] } : {}),
      shots: [route === "shot" ? answer : frameResponse(jpeg(1), "2026-10-28T12:00:03Z")],
    });
    const result = await cli(["--json", "screen", "live", "frame", SCREEN], transport, env);
    assert.equal(result.code, exit, `${route} ${code}: ${result.stdout}`);
    assert.equal(result.envelope.error?.code, code);
    assert.equal(result.envelope.error?.next?.command, next, `${route} ${code}`);
  }
});

test("--stop ends the session when done, and when a frame failed", async () => {
  const env = await enrolled();
  const done = framesTransport({ shots: [frameResponse(jpeg(1), "2026-10-28T12:00:03Z")] });
  const result = await cli(["--json", "screen", "live", "frame", SCREEN, "--stop"], done, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(result.envelope.data.stopped, true);
  assert.deepEqual(done.calls.filter((call) => call.path === LIVE_PATH).map((call) => call.method), ["POST", "DELETE"]);

  const failed = framesTransport({ shots: [refusal(409, "live_unavailable", "The live session ended (ended_reason stopped).")] });
  const broken = await cli(["--json", "screen", "live", "frame", SCREEN, "--stop"], failed, env);
  assert.equal(broken.envelope.error?.code, "live_unavailable", "the run's own failure is the one reported");
  assert.equal(sent(failed, "DELETE", LIVE_PATH).length, 1);
});

test("a frame that does not match its ETag is never saved", async () => {
  const env = await enrolled();
  const transport = framesTransport({ shots: [frameResponse(jpeg(1), "2026-10-28T12:00:03Z", { etag: `"${"0".repeat(64)}"` })] });
  const result = await cli(["--json", "screen", "live", "frame", SCREEN], transport, env);
  assert.equal(result.envelope.ok, false);
  assert.match(result.envelope.error!.detail, /did not match its ETag/);
  assert.deepEqual(await readdir(env.cwd), []);
});

test("a bad value fails before any request", async () => {
  const env = await enrolled();
  const transport = framesTransport({ shots: [] });
  for (const argv of [
    ["screen", "live", "frame", "pl_PLAYLIST"],
    ["screen", "live", "frame", SCREEN, "--count", "0"],
    ["screen", "live", "frame", SCREEN, "--count", "two"],
    ["screen", "live", "frame", SCREEN, "--interval", "6m"],
    ["screen", "live", "frame", SCREEN, "--duration", "10s"],
    ["screen", "live", "frame", SCREEN, "--wait", "11m"],
    ["screen", "live", "frame", SCREEN, "--count", "3", "--output", "one-file.jpg"],
    ["screen", "live", "frame", SCREEN, "--count", "5000"],
  ]) {
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    assert.equal(result.envelope.error?.code, "usage_error");
  }
  assert.equal(transport.calls.length, 0);
  await writeFile(path.join(env.cwd, "keep"), "x");
  assert.deepEqual(await readdir(env.cwd), ["keep"]);
});

test("help names the command, its options and what a frame is", () => {
  const group = commandHelp(["screen", "live"]);
  assert.deepEqual(group.commands?.map((command) => command.name).sort(), ["frame", "start", "status", "stop"]);
  assert.match(group.notes.join("\n"), /never carries video/);
  assert.match(group.notes.join("\n"), /screen live frame/);
  const frame = commandHelp(["screen", "live", "frame"]);
  assert.match(frame.usage, /screen live frame \[options\] <id>/);
  assert.deepEqual(frame.options.map((option) => option.name).filter((option) => option !== "--help"), ["--output", "--count", "--interval", "--duration", "--wait", "--stop"]);
  const notes = frame.notes.join("\n");
  assert.match(notes, /not a screenshot/);
  assert.match(notes, /live_not_ready/);
  assert.match(notes, /frame-<captured_at>\.jpg/);
  assert.ok(frame.examples.some((example) => /screenrig screen live frame scr_SCREEN --output frames\/ --count 5/.test(example)));
});
