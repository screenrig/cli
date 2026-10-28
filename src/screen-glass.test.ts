import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Screen } from "./adapters/protocol.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { run, type CliRuntime } from "./main.js";
import { glassLines } from "./screen-glass.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const base = { id: "scr_LOBBY", label: "Lobby" } as Screen;
const stalled = {
  verdict: "stalled" as const, since: "2026-10-28T12:07:10Z", last_media_start_at: "2026-10-28T12:00:00Z", threshold_s: 240, judged_at: "2026-10-28T12:07:41Z",
};

test("glassLines prints a stalled playback verdict with what to do and nothing else", () => {
  const lines = glassLines({ ...base, glass: { playback: stalled } });
  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    "Playlist stalled since 2026-10-28T12:07:10Z: no media start has reached ScreenRig for more than 4 minutes (the last was at 2026-10-28T12:00:00Z), although the screen is online and its content is current.",
  );
  assert.match(lines[1]!, /screen screenshot scr_LOBBY, or restart the Player with screen reload scr_LOBBY/);
  for (const verdict of ["playing", "unjudged"] as const) {
    assert.deepEqual(glassLines({ ...base, glass: { playback: { ...stalled, verdict } } }), [], verdict);
  }
  assert.deepEqual(glassLines(undefined), []);
  assert.deepEqual(glassLines(base), []);
  assert.deepEqual(glassLines({ ...base, glass: {} }), []);
});

test("glassLines prints only well-formed server values", () => {
  const lines = glassLines({ ...base, glass: { playback: { ...stalled, since: "yesterday\u001b[2J", last_media_start_at: "2026-10-28T12:00:00Z\nforged: line", threshold_s: -5 } } });
  assert.equal(lines[0], "Playlist stalled: no media start has reached ScreenRig for longer than the loop allows, although the screen is online and its content is current.");
  const long = glassLines({ ...base, glass: { playback: { ...stalled, threshold_s: 3 * 3600 + 180 } } });
  assert.match(long[0]!, /for more than 3 hours/);
  const one = glassLines({ ...base, glass: { playback: { ...stalled, threshold_s: 30 } } });
  assert.match(one[0]!, /for more than 1 minute /);
});

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function cli(argv: string[], transport: FakeTransport): Promise<{ code: number; stdout: string }> {
  const configDir = await testTemp("glass-cfg-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  void collect(stderr);
  const runtime: CliRuntime = {
    argv, env: fs.env, stdout, stderr, now: () => new Date("2026-10-28T12:10:00Z"), sleep: async () => undefined,
    homedir: fs.homedir, cwd: () => configDir, fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: await out };
}

test("screen show carries Screen.glass in JSON and prints the stalled block in human output", async () => {
  const body = {
    id: "scr_LOBBY", label: "Lobby", state: "active", public_id: "pub_scr_LOBBY", revision: 1, manifest_revision: "man_1", online: true,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", glass: { playback: stalled },
  };
  const transport = new FakeTransport().on("GET", "/api/screens/scr_LOBBY", () => ({ status: 200, headers: {}, body }));
  const json = await cli(["--json", "screen", "show", "scr_LOBBY"], transport);
  assert.equal(json.code, 0, json.stdout);
  assert.deepEqual((JSON.parse(json.stdout) as { data: Screen }).data.glass, { playback: stalled });
  const human = await cli(["--human", "screen", "show", "scr_LOBBY"], transport);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /\nPlaylist stalled since 2026-10-28T12:07:10Z: no media start has reached ScreenRig for more than 4 minutes/);
  const calm = new FakeTransport().on("GET", "/api/screens/scr_LOBBY", () => ({ status: 200, headers: {}, body: { ...body, glass: { playback: { ...stalled, verdict: "playing" } } } }));
  const quiet = await cli(["--human", "screen", "show", "scr_LOBBY"], calm);
  assert.doesNotMatch(quiet.stdout, /Playlist stalled/);
});
