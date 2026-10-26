import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { run, processRuntime, type CliRuntime } from "./main.js";
import { initializePlaylist } from "./playlist-authoring.js";
import { playlistAnswerWarnings, playlistWarningItems, withoutAnswerWarnings } from "./playlist-warnings.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportResponse } from "./transport/types.js";

const PLAYLIST = "pl_LOBBY";
const SCREEN = "scr_TEST";
const NOW = new Date("2026-10-26T17:00:00.000Z");
const FRAMING = {
  code: "iframe_framing_refused", page_id: "web", primitive_id: "board", src: "https://example.com/board", reason: "x_frame_options",
  message: "https://example.com/board sends X-Frame-Options, so the Player web app cannot show it. Android, Linux and Windows Players are not affected.",
};

const json = (status: number, body: unknown): TransportResponse => ({ status, headers: { "content-type": "application/json" }, body });
const media = [{ id: "med_IMAGE", primitive: "image", state: "ready" }];
const document = () => initializePlaylist({ name: "Lobby", media, width: 1920, height: 1080, durationMs: 8000, fit: "contain" });

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled() {
  const dir = await testTemp("playlist-warnings-");
  const configDir = path.join(dir, "config");
  const cwd = path.join(dir, "cwd");
  await mkdir(cwd, { recursive: true });
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  await writeFile(path.join(cwd, "lobby.json"), JSON.stringify(document()));
  return { fs, cwd, dir };
}

async function cli(argv: string[], transport: FakeTransport, env: Awaited<ReturnType<typeof enrolled>>) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  collect(stderr);
  const runtime: CliRuntime = { argv, env: env.fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined, homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  let envelope: any = {};
  try { envelope = JSON.parse(text); } catch { /* human */ }
  return { code, stdout: text, envelope };
}

function assertLifted(envelope: any, playlistId: string, pending = false): void {
  const warning = envelope.warnings.find((item: any) => item.code === "iframe_framing_refused");
  assert.ok(warning, JSON.stringify(envelope.warnings));
  assert.match(warning.message, /X-Frame-Options/);
  assert.match(warning.message, /Next: replace the iframe \(page web, primitive board, https:\/\/example\.com\/board\)/);
  assert.match(warning.message, new RegExp(`screenrig playlist patch ${playlistId} FILE`));
  assert.match(warning.message, pending ? /waits for review as written/ : /saved as written/);
  assert.equal(envelope.data.warnings, undefined, "warnings are lifted out of data");
}

test("playlistWarningItems keeps coded items with a message and drops the rest; control characters become spaces", () => {
  const items = playlistWarningItems([FRAMING, null, "x", { code: "a" }, { code: "other_code", message: "line\nbreak\u001b[31m" }]);
  assert.deepEqual(items.map((item) => item.code), ["iframe_framing_refused", "other_code"]);
  assert.equal(items[1]!.message, "line break [31m");
  assert.deepEqual(playlistWarningItems(undefined), []);
  assert.deepEqual(playlistAnswerWarnings({ id: PLAYLIST }), []);
  assert.deepEqual(withoutAnswerWarnings({ id: PLAYLIST, warnings: [FRAMING] }), { id: PLAYLIST });
});

test("playlist create, update and patch lift answer warnings into the envelope and human output", async () => {
  const env = await enrolled();
  try {
    const answer = (status: number) => () => json(status, { id: PLAYLIST, revision: 2, name: "Lobby", warnings: [FRAMING] });
    const transport = new FakeTransport()
      .on("POST", "/api/playlists", answer(201))
      .on("PUT", `/api/playlists/${PLAYLIST}`, answer(200))
      .on("PATCH", `/api/playlists/${PLAYLIST}`, answer(200))
      .on("GET", "/api/screens", () => json(200, { items: [], next_cursor: null }));
    for (const argv of [
      ["--json", "playlist", "create", "lobby.json"],
      ["--json", "playlist", "update", PLAYLIST, "lobby.json"],
      ["--json", "playlist", "patch", PLAYLIST, "--name", "Lobby loop"],
    ]) {
      const result = await cli(argv, transport, env);
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.envelope.data.id, PLAYLIST);
      assertLifted(result.envelope, PLAYLIST);
    }
    const human = await cli(["--human", "playlist", "create", "lobby.json"], transport, env);
    assert.match(human.stdout, /Playlist created\.\nwarning: .*X-Frame-Options/);
    const clean = new FakeTransport().on("POST", "/api/playlists", () => json(201, { id: PLAYLIST, revision: 1, name: "Lobby" }));
    const none = await cli(["--json", "playlist", "create", "lobby.json"], clean, env);
    assert.deepEqual(none.envelope.warnings, []);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("a pending_review answer carries the framing warning beside the review warning", async () => {
  const env = await enrolled();
  try {
    const review = { id: "rvw_X", kind: "playlist_change", state: "pending", url: "https://screenrig.ai/dashboard/reviews/rvw_X", subject: { type: "playlist", id: PLAYLIST, name: "Lobby" }, impact: { screens: 0 } };
    const transport = new FakeTransport().on("POST", "/api/playlists", () => json(202, { status: "pending_review", review, playlist: { id: PLAYLIST, revision: 1 }, warnings: [FRAMING] }));
    const result = await cli(["--json", "playlist", "create", "lobby.json"], transport, env);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.envelope.warnings.map((item: any) => item.code), ["pending_review", "iframe_framing_refused"]);
    assertLifted(result.envelope, PLAYLIST, true);
    const human = await cli(["--human", "playlist", "create", "lobby.json"], transport, env);
    assert.match(human.stdout, /Playlist change waiting for review[\s\S]*warning: .*X-Frame-Options/);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

async function publishFixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "publish-warnings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = `${dir}/config.json`;
  await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "test-token" }), { mode: 0o600 });
  await writeFile(`${dir}/lobby.json`, JSON.stringify(document()));
  let assigned = false;
  const playing = { id: SCREEN, revision: 8, playlist_id: "pl_TEST", online: true, effective_playlist: { id: "pl_TEST", source: "default" },
    manifest_upgrade: { desired_revision: "man_NEW", active_revision: "man_NEW", desired_playlist: { id: "pl_TEST", name: "Lobby", revision: 1 }, active_playlist: { id: "pl_TEST", name: "Lobby", revision: 1 }, state: "current", code: null, attempt: null, retry_at: null, missing_page_count: null, state_since: null, reported_at: null } };
  const transport = new FakeTransport()
    .on("GET", "/api/project", () => json(200, { id: "prj_TEST" }))
    .on("GET", `/api/screens/${SCREEN}`, () => json(200, assigned ? playing : { id: SCREEN, revision: 7 }))
    .on("POST", "/api/playlists", () => json(201, { id: "pl_TEST", revision: 1, warnings: [FRAMING] }))
    .on("PATCH", `/api/screens/${SCREEN}`, () => { assigned = true; return json(200, { id: SCREEN, revision: 8, playlist_id: "pl_TEST" }); });
  async function invoke(...extra: string[]) {
    let out = "";
    const code = await run({ ...processRuntime(), argv: ["--config", config, "screen", "publish", SCREEN, "lobby.json", "--no-progress", ...extra], env: { XDG_CONFIG_HOME: dir }, cwd: () => dir, transport, sleep: async () => {},
      stdout: new Writable({ write(chunk, _e, done) { out += chunk; done(); } }), stderr: new Writable({ write(_c, _e, done) { done(); } }) });
    return { code, out, body: (() => { try { return JSON.parse(out); } catch { return undefined; } })() };
  }
  return { invoke, dir };
}

test("screen publish keeps playback_verified as reported and carries the framing warning in the same result", async (t) => {
  const { invoke } = await publishFixture(t);
  const result = await invoke();
  assert.equal(result.code, 0, result.out);
  assert.equal(result.body.data.playback_verified, true, "the Player's verdict is untouched");
  assert.equal(result.body.data.stage, "playing");
  assertLifted(result.body, "pl_TEST");
  const human = await invoke("--human");
  assert.match(human.out, /Published and playing; see the framing warning\n/);
  assert.match(human.out, /warning: .*X-Frame-Options/);
});

test("a rerun of a finished publish reports the saved framing warning again, journal included", async (t) => {
  const { invoke, dir } = await publishFixture(t);
  await invoke();
  const again = await invoke();
  assert.equal(again.body.data.already_published, true);
  assertLifted(again.body, "pl_TEST");
  const journals = (await readdir(`${dir}/publishes`)).filter((name) => name.endsWith(".json"));
  assert.equal(journals.length, 1);
  const saved = JSON.parse(await readFile(`${dir}/publishes/${journals[0]}`, "utf8"));
  assert.equal(saved.warnings[0].code, "iframe_framing_refused");
});
