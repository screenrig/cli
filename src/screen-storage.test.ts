import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { run, processRuntime } from "./main.js";
import { initializePlaylist } from "./playlist-authoring.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const SCREEN = "scr_AAAAAAAAAAAAAAAAAAAAAAAA";
const PLAYLIST = "pl_AAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = new Date("2026-10-20T18:00:00Z");
const response = (body: unknown) => ({ status: 200, headers: {}, body });

function reportedScreen(fit = "none_fit") {
  return {
    id: SCREEN, label: "Lobby", state: "active", revision: 4, playlist_id: PLAYLIST,
    storage: {
      received_at: NOW.toISOString(),
      durability: "purgeable",
      volume: { total_bytes: 83886080, available_bytes: 46137344 },
      cache: { house_used_bytes: 0, capacity_bytes: 0, reserve_bytes: 67108864 },
      plan: { manifest_revision: "man_CURRENT", fit, transition: "blocked", required_bytes: 172032,
        excluded_pages: [{ page_id: "lobby", reason: "object_exceeds_capacity" }] },
      transfer_24h: { new: 0, refetch: 0, repair: 0, failed: 0 },
    },
    storage_shortfall: { fit, required_bytes: 172032, capacity_bytes: 0, excluded_page_count: 1 },
    storage_forecast: { manifest_revision: "man_CURRENT", fit, excluded_page_count: 1,
      basis: "reported_capacity", received_at: NOW.toISOString() },
  };
}

async function invoke(args: string[], transport: FakeTransport, files: Record<string, unknown> = {}, clock = { ms: NOW.getTime() }) {
  const dir = await testTemp("storage-cli-");
  const config = path.join(dir, "config.json");
  await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai",
    project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Example",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example", token: "test-token" }), { mode: 0o600 });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), JSON.stringify(body));
  let stdout = "", stderr = "";
  const code = await run({ ...processRuntime(), argv: ["--config", config, ...args], cwd: () => dir,
    transport, env: { XDG_CONFIG_HOME: dir }, now: () => new Date(clock.ms), sleep: async (ms) => { clock.ms += ms; },
    stdout: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }),
    stderr: new Writable({ write(chunk, _encoding, done) { stderr += chunk; done(); } }),
  });
  return { code, stdout, stderr };
}

function assertRecovery(warning: { code: string; message: string }, impact: string) {
  assert.equal(warning.code, "storage_full");
  assert.ok(warning.message.includes(SCREEN), "the agent must identify the affected screen");
  assert.ok(warning.message.includes(impact), warning.message);
  assert.match(warning.message, /Ask the user to free up storage on the device running this Player, then retry/);
  assert.doesNotMatch(warning.message, /reserve|object_exceeds_capacity|republish|Large videos take longer/);
}

// Requirement: an agent reading an unusable device must get a recovery action,
// while the successful API read and its original diagnostics remain intact.
test("screen reads expose device-storage recovery in JSON and human output", async () => {
  const screen = reportedScreen();
  const transport = new FakeTransport()
    .on("GET", `/api/screens/${SCREEN}`, () => response(screen))
    .on("GET", "/api/screens", () => response({ items: [screen], next_cursor: null }));
  for (const args of [["screen", "show", SCREEN], ["screen", "list"]]) {
    const json = await invoke(args, transport);
    assert.equal(json.code, 0, json.stdout);
    const envelope = JSON.parse(json.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.warnings.length, 1);
    assertRecovery(envelope.warnings[0], "Can't load this playlist.");
    assert.deepEqual(args[1] === "show" ? envelope.data : envelope.data.items[0], screen);
    const human = await invoke(["--human", ...args], transport);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /Storage full\. Can't load this playlist\./);
    assert.match(human.stdout, /Ask the user to free up storage/);
  }
  assert.ok(transport.calls.every((call) => call.method === "GET"), "diagnostics must not change the device");
});

test("a forecast warns about partial playback but never invents a failure for unknown or fitting content", async () => {
  for (const fit of ["partial", "none_fit", "fits", "unknown"]) {
    const forecast = { fit, excluded_page_count: fit === "partial" || fit === "none_fit" ? 1 : 0,
      required_bytes: fit === "unknown" ? null : 172032, capacity_bytes: fit === "unknown" ? null : 0,
      basis: "reported_capacity", received_at: fit === "unknown" ? null : NOW.toISOString() };
    const transport = new FakeTransport().on("POST", `/api/screens/${SCREEN}/storage-forecast`, () => response(forecast));
    const result = await invoke(["screen", "storage-forecast", SCREEN, "--playlist-id", PLAYLIST], transport);
    assert.equal(result.code, 0, result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.data, forecast);
    if (fit === "partial" || fit === "none_fit") {
      assert.equal(envelope.warnings.length, 1);
      assertRecovery(envelope.warnings[0], fit === "partial" ? "Some playlist pages can't be loaded." : "Can't load this playlist.");
    } else assert.deepEqual(envelope.warnings, []);
    assert.deepEqual(transport.calls.find((call) => call.method === "POST")?.body, { playlist_id: PLAYLIST });
  }
});

test("accepted playlist assignments warn about storage without refusing or repeating the saved write", async () => {
  for (const command of ["assign", "update"]) {
    const transport = new FakeTransport()
      .on("GET", `/api/playlists/${PLAYLIST}`, () => response({ id: PLAYLIST, pages: [] }))
      .on("GET", `/api/screens/${SCREEN}`, () => response({ id: SCREEN, revision: 3 }))
      .on("PATCH", `/api/screens/${SCREEN}`, () => response(reportedScreen()));
    const result = await invoke(["screen", command, SCREEN, "--playlist-id", PLAYLIST], transport);
    assert.equal(result.code, 0, result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.playlist_id, PLAYLIST);
    assertRecovery(envelope.warnings.find((warning: { code: string }) => warning.code === "storage_full"), "Can't load this playlist.");
    const writes = transport.calls.filter((call) => call.method === "PATCH");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.body, { playlist_id: PLAYLIST });
  }
});

test("a fresh fitting forecast replaces an older playlist's shortfall and stale warnings identify their age", async () => {
  const screen = reportedScreen();
  screen.storage_forecast = { ...screen.storage_forecast, manifest_revision: "man_NEW", fit: "fits", excluded_page_count: 0 };
  const transport = new FakeTransport().on("GET", `/api/screens/${SCREEN}`, () => response(screen));
  const fitting = JSON.parse((await invoke(["screen", "show", SCREEN], transport)).stdout);
  assert.deepEqual(fitting.warnings, []);
  screen.storage_forecast.fit = "none_fit";
  screen.storage.received_at = "2026-10-18T18:00:00Z";
  const stale = JSON.parse((await invoke(["screen", "show", SCREEN], transport)).stdout);
  assertRecovery(stale.warnings[0], "Can't load this playlist.");
  assert.match(stale.warnings[0].message, /more than 24 hours old/);
});

test("publish distinguishes full storage from a playlist that is still loading", async () => {
  for (const fixture of [
    { state: "blocked", code: "none_fit", playing: false, impact: "Can't load this playlist." },
    { state: "partial", code: "capacity", playing: true, impact: "Some playlist pages can't be loaded." },
    { state: "partial", code: "staged", playing: true, impact: undefined },
  ]) {
  for (const mode of ["--json", "--human"]) {
    let assigned = false;
    const transport = new FakeTransport()
      .on("GET", "/api/project", () => response({ id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA" }))
      .on("GET", `/api/screens/${SCREEN}`, () => response(assigned ? {
        id: SCREEN, revision: 4, playlist_id: PLAYLIST, online: true,
        effective_playlist: { id: PLAYLIST, source: "default" },
        manifest_upgrade: { state: fixture.state, code: fixture.code, desired_revision: "man_NEW", active_revision: fixture.playing ? "man_NEW" : null,
          desired_playlist: { id: PLAYLIST, name: "Lobby", revision: 1 },
          active_playlist: fixture.playing ? { id: PLAYLIST, name: "Lobby", revision: 1 } : null },
      } : { id: SCREEN, revision: 3 }))
      .on("POST", "/api/playlists", () => response({ id: PLAYLIST, revision: 1 }))
      .on("PATCH", `/api/screens/${SCREEN}`, () => { assigned = true; return response({ id: SCREEN, revision: 4, playlist_id: PLAYLIST }); });
    const document = initializePlaylist({ name: "Lobby", media: [{ id: "med_AAAAAAAAAAAAAAAAAAAAAAAA", primitive: "image", state: "ready" }],
      width: 1920, height: 1080, durationMs: 8000, fit: "contain" });
    const result = await invoke([mode, "screen", "publish", SCREEN, "playlist.json", "--timeout", "10000", "--poll-ms", "2000"], transport, { "playlist.json": document });
    assert.equal(result.code, 0, result.stdout);
    if (mode === "--json") {
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.data.stage, fixture.playing ? "playing" : "assigned");
      assert.equal(envelope.data.playback_verified, fixture.playing);
      if (fixture.impact) assertRecovery(envelope.warnings[0], fixture.impact);
      else {
        assert.equal(envelope.warnings[0].code, "playback_partial");
        assert.match(envelope.warnings[0].message, /showing only part of the playlist/);
        assert.doesNotMatch(envelope.warnings[0].message, /Storage full|free up storage/);
      }
    } else {
      if (fixture.impact) {
        assert.ok(result.stdout.includes(fixture.impact), result.stdout);
        assert.match(result.stdout, /Ask the user to free up storage/);
      } else {
        assert.match(result.stdout, /showing only part of the playlist/);
        assert.doesNotMatch(result.stdout, /Storage full|free up storage/);
      }
    }
    assert.equal(transport.calls.filter((call) => call.method === "PATCH").length, 1);
  }
  }
});
