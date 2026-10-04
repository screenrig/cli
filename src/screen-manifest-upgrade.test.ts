import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Screen, ScreenManifestUpgrade, ScreenManifestUpgradePlaylist } from "./adapters/protocol.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { run, type CliRuntime } from "./main.js";
import { manifestUpgradeCell, manifestUpgradeLines, manifestUpgradeOf } from "./screen-manifest-upgrade.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const NOW = new Date("2026-09-25T10:05:00Z");

const TARGET_HASH = "man_abcdef123456";
const ACK_HASH = "man_9999abcdef01";
const LOBBY = "pl_LOBBY";
const PROMO = "pl_PROMO";

function playlist(id: string, revision: number, name?: string): ScreenManifestUpgradePlaylist {
  return { id, name: name ?? null, revision };
}

function upgrade(fields: Partial<ScreenManifestUpgrade> & Pick<ScreenManifestUpgrade, "state">): ScreenManifestUpgrade {
  const { state, ...rest } = fields;
  return {
    desired_revision: null, active_revision: null, desired_playlist: null, active_playlist: null,
    code: null, attempt: null, retry_at: null, missing_page_count: null, state_since: null,
    reported_at: null, ...rest, state,
  };
}

function screen(id: string, label: string, manifestUpgrade?: ScreenManifestUpgrade): Screen {
  return {
    id, label, state: "active", public_id: `pub_${id}`, revision: 1, manifest_revision: 1, online: true,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    ...(manifestUpgrade ? { manifest_upgrade: manifestUpgrade } : {}),
  } as Screen;
}

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function cli(argv: string[], transport: FakeTransport): Promise<{ code: number; stdout: string }> {
  const configDir = await testTemp("upgrade-cfg-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  void collect(stderr);
  const runtime: CliRuntime = {
    argv, env: fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: fs.homedir, cwd: () => configDir, fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: await out };
}

function eventFrame(id: string, event: Record<string, unknown>): string {
  return `id: ${id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`;
}

test("same playlist shows Target vX · Playing vX with the playlist name", () => {
  const lines = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "downloading", desired_revision: TARGET_HASH, active_revision: ACK_HASH,
    desired_playlist: playlist(LOBBY, 42, "Lobby loop"), active_playlist: playlist(LOBBY, 41, "Lobby loop"),
    state_since: "2026-09-25T10:00:00Z", reported_at: "2026-09-25T10:04:00Z",
  })), NOW);
  assert.deepEqual(lines, [
    "Manifest upgrade",
    "Target v42 · Playing v41",
    "playlist: Lobby loop",
    "diagnostics: target man_abcdef123456, acknowledged man_9999abcdef01",
    "state: downloading (since 2026-09-25T10:00:00Z)",
    "last report: 2026-09-25T10:04:00Z",
    "Playing is the last activation the server confirmed; the display may still be showing it rather than the target, and it is not proof that every connected session shows it.",
  ]);
});

test("differing playlists carry both names; retrying shows code, attempt, overdue retry", () => {
  const lines = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "retrying", desired_revision: TARGET_HASH, active_revision: ACK_HASH,
    desired_playlist: playlist(PROMO, 7, "Weekend promo"), active_playlist: playlist(LOBBY, 41, "Lobby loop"),
    code: "download_failed", attempt: 2, retry_at: "2026-09-25T10:04:00Z", reported_at: "2026-09-25T10:04:00Z",
  })), NOW);
  assert.deepEqual(lines.slice(0, 4), [
    "Manifest upgrade",
    "Target Weekend promo v7 · Playing Lobby loop v41",
    "diagnostics: target man_abcdef123456, acknowledged man_9999abcdef01",
    "state: retrying",
  ]);
  assert.ok(lines.includes("reason: download_failed — the candidate download failed"));
  assert.ok(lines.includes("attempt: 2"));
  assert.ok(lines.includes("retry: 2026-09-25T10:04:00Z (overdue)"));
  assert.ok(lines.includes("A retry is scheduled; the player reports again after it. Offline is never reported as failure."));

  const scheduled = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "retrying", desired_revision: TARGET_HASH, desired_playlist: playlist(PROMO, 7),
    retry_at: "2026-09-25T10:30:00Z",
  })), NOW);
  assert.ok(scheduled.includes("retry: 2026-09-25T10:30:00Z"));
  assert.ok(!scheduled.some((line) => line.includes("overdue")));
});

test("failed prints the known reason and recovery hint; unknown codes print as they are", () => {
  const lines = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "failed", desired_revision: TARGET_HASH, active_revision: ACK_HASH,
    desired_playlist: playlist(PROMO, 7), active_playlist: playlist(LOBBY, 41), code: "manifest_invalid",
  })), NOW);
  assert.ok(lines.includes("reason: manifest_invalid — the candidate manifest was rejected as invalid"));
  assert.ok(lines.includes("No retry is scheduled. Fix the cause, then screen reload <id> or reassign the playlist."));

  const unknown = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "failed", desired_revision: TARGET_HASH, desired_playlist: playlist(PROMO, 7), code: "solar_flare",
  })), NOW);
  assert.ok(unknown.includes("reason: solar_flare"));
  assert.ok(!unknown.some((line) => line.toLowerCase().includes("solar flare")));
});

test("partial reports missing pages and recovery converges to matching versions", () => {
  const partial = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "partial", desired_revision: TARGET_HASH, active_revision: TARGET_HASH,
    desired_playlist: playlist(PROMO, 7, "Weekend promo"), active_playlist: playlist(PROMO, 7, "Weekend promo"),
    missing_page_count: 3, reported_at: "2026-09-25T10:04:00Z",
  })), NOW);
  assert.ok(partial.includes("missing pages: 3"));
  assert.ok(partial.includes("Partial: the target is on the display, but 3 whole page(s) of authored content are excluded."));
  assert.ok(!partial.some((line) => line.includes("display may still be showing")));

  const current = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "current", desired_revision: TARGET_HASH, active_revision: TARGET_HASH,
    desired_playlist: playlist(PROMO, 7, "Weekend promo"), active_playlist: playlist(PROMO, 7, "Weekend promo"),
    state_since: "2026-09-25T10:04:30Z", reported_at: "2026-09-25T10:04:30Z",
  })), NOW);
  assert.ok(current.includes("Target v7 · Playing v7"));
  assert.ok(current.includes("playlist: Weekend promo"));
  assert.ok(current.includes("state: current (since 2026-09-25T10:04:30Z)"));
  assert.ok(!current.some((line) => line.includes("may still be showing")));
  assert.ok(!current.some((line) => line.includes("Partial")));
});

test("blocked explains storage; an unacknowledged target shows Playing: none yet", () => {
  const blocked = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "blocked", desired_revision: TARGET_HASH, active_revision: ACK_HASH,
    desired_playlist: playlist(PROMO, 7), active_playlist: playlist(LOBBY, 41), code: "storage_full",
  })), NOW);
  assert.ok(blocked.includes("reason: storage_full — the screen's storage cannot hold the candidate"));
  assert.ok(blocked.includes("Storage could not stage the candidate; the acknowledged revision keeps playing."));

  const fresh = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "pending", desired_revision: TARGET_HASH, desired_playlist: playlist(PROMO, 7),
  })), NOW);
  assert.ok(fresh.includes("Target v7"));
  assert.ok(fresh.includes("Playing: none yet"));
  assert.ok(fresh.includes("no upgrade report yet"));
});

test("unknown target versions are never fabricated from the hash; none prints nothing", () => {
  const unknown = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "downloading", desired_revision: TARGET_HASH,
  })), NOW);
  assert.ok(unknown.includes("Target: unknown version"));
  assert.ok(!unknown.some((line) => line.startsWith("target: ") || line.startsWith("acknowledged: ")));
  assert.ok(unknown.includes(`diagnostics: target ${TARGET_HASH}`));

  const malformed = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "downloading", desired_revision: TARGET_HASH,
    desired_playlist: { id: PROMO, name: null, revision: 0 } as ScreenManifestUpgradePlaylist,
  })), NOW);
  assert.ok(malformed.includes("Target: unknown version"));

  assert.deepEqual(manifestUpgradeLines(screen("scr_PLAIN", "Plain", upgrade({ state: "none" })), NOW), []);
  assert.deepEqual(manifestUpgradeLines(screen("scr_OLD", "Old"), NOW), []);
  assert.deepEqual(manifestUpgradeLines(undefined, NOW), []);
});

test("names are literal text: CR/LF/tab become spaces and the name is capped at 48 characters", () => {
  const lines = manifestUpgradeLines(screen("scr_LOBBY", "Lobby", upgrade({
    state: "retrying", desired_revision: TARGET_HASH, active_revision: ACK_HASH,
    desired_playlist: playlist(PROMO, 7, "  Weekend\r\npromo\t2026  ".repeat(3).trim() + " $& {activeName}"),
    active_playlist: playlist(LOBBY, 41, "Lobby loop"),
  })), NOW);
  const targetLine = lines.find((line) => line.startsWith("Target "));
  assert.ok(targetLine);
  const shown = targetLine.slice("Target ".length, targetLine.indexOf(" v7 · Playing"));
  assert.equal(shown, "Weekend promo 2026    Weekend promo 2026    Week");
  assert.ok(!targetLine.includes("\n") && !targetLine.includes("\t"));
});

test("screen list adds UPGRADE only when a screen has a story, with version primary and no hashes", async () => {
  const transport = new FakeTransport().on("GET", "/api/v1/screens", () => ({
    status: 200, headers: {},
    body: {
      items: [
        screen("scr_CALM", "Calm", upgrade({ state: "none", desired_revision: TARGET_HASH, active_revision: TARGET_HASH })),
        screen("scr_DOWN", "Down", upgrade({
          state: "downloading", desired_revision: TARGET_HASH, active_revision: ACK_HASH,
          desired_playlist: playlist(LOBBY, 42, "Lobby loop"), active_playlist: playlist(LOBBY, 41, "Lobby loop"),
          reported_at: "2026-09-25T10:04:00Z",
        })),
        screen("scr_SWITCH", "Switch", upgrade({
          state: "retrying", desired_revision: TARGET_HASH, active_revision: ACK_HASH, code: "hash_mismatch",
          attempt: 2, retry_at: "2026-09-25T10:04:00Z",
          desired_playlist: playlist(PROMO, 7, "Weekend promo"), active_playlist: playlist(LOBBY, 41),
        })),
        screen("scr_FAIL", "Fail", upgrade({
          state: "failed", desired_revision: TARGET_HASH, active_revision: ACK_HASH, code: "manifest_invalid",
          desired_playlist: playlist(PROMO, 7), active_playlist: playlist(LOBBY, 41),
        })),
      ],
    },
  }));
  const human = await cli(["--human", "screen", "list"], transport);
  assert.equal(human.code, 0, human.stdout);
  const lines = human.stdout.split("\n");
  assert.match(lines.find((line) => line.startsWith("ID"))!, /UPGRADE$/);
  const down = lines.find((line) => line.startsWith("scr_DOWN"))!;
  assert.match(down, /downloading Target v42 · Playing v41/);
  assert.doesNotMatch(down, /man_/);
  const switched = lines.find((line) => line.startsWith("scr_SWITCH"))!;
  assert.match(switched, /Target Weekend promo v7 · Playing pl_LOBBY v41/);
  assert.match(lines.find((line) => line.startsWith("scr_FAIL"))!, /failed Target pl_PROMO v7 · Playing pl_LOBBY v41 manifest_invalid/);
  assert.match(lines.find((line) => line.startsWith("scr_CALM"))!, /active$/);

  const calm = await cli(["--human", "screen", "list"], new FakeTransport().on("GET", "/api/v1/screens", () => ({
    status: 200, headers: {}, body: { items: [screen("scr_CALM", "Calm", upgrade({ state: "none" })), screen("scr_NEW", "New")] },
  })));
  assert.equal(calm.code, 0, calm.stdout);
  assert.doesNotMatch(calm.stdout, /UPGRADE/);
});

test("screen list keeps assignment, health, and acknowledged upgrade data under their own columns", async () => {
  const body: Screen = {
    ...screen("scr_COMBINED", "Combined", upgrade({
      state: "failed", code: "download_failed", desired_revision: TARGET_HASH, active_revision: ACK_HASH,
      desired_playlist: playlist(PROMO, 7, "Promo"), active_playlist: playlist(LOBBY, 41, "Lobby"),
    })),
    effective_playlist: { id: PROMO, source: "schedule", entry_id: "lunch" },
    health: { reported_at: "2026-09-25T10:04:00Z", stale: false, temperature_c: 85 },
  };
  const transport = new FakeTransport().on("GET", "/api/v1/screens", () => ({ status: 200, headers: {}, body: { items: [body] } }));
  const result = await cli(["--human", "screen", "list"], transport);
  assert.equal(result.code, 0, result.stdout);
  const lines = result.stdout.split("\n");
  const header = lines.find((line) => line.startsWith("ID"))!;
  const row = lines.find((line) => line.startsWith("scr_COMBINED"))!;
  const assignment = header.indexOf("ASSIGNED");
  const health = header.indexOf("HEALTH");
  const upgradeColumn = header.indexOf("UPGRADE");
  assert.ok(assignment > 0 && health > assignment && upgradeColumn > health);
  assert.equal(row.slice(assignment, health).trim(), `${PROMO} (schedule entry lunch)`);
  assert.equal(row.slice(health, upgradeColumn).trim(), "hot 85°C");
  assert.match(row.slice(upgradeColumn), /^failed Target Promo v7 · Playing Lobby v41 download_failed/);
});

test("screen list cell carries attempt, pages, retry, overdue, and report time", () => {
  const cell = manifestUpgradeCell(screen("scr_LOBBY", "Lobby", upgrade({
    state: "retrying", desired_revision: TARGET_HASH, active_revision: ACK_HASH, code: "hash_mismatch",
    attempt: 2, retry_at: "2026-09-25T10:04:00Z", reported_at: "2026-09-25T10:04:00Z",
    desired_playlist: playlist(LOBBY, 42, "Lobby loop"), active_playlist: playlist(LOBBY, 41, "Lobby loop"),
  })), NOW);
  assert.equal(cell, "retrying Target v42 · Playing v41 hash_mismatch attempt 2 retry 2026-09-25T10:04:00Z overdue reported 2026-09-25T10:04:00Z");
  const pages = manifestUpgradeCell(screen("scr_LOBBY", "Lobby", upgrade({
    state: "partial", desired_revision: TARGET_HASH, missing_page_count: 3, reported_at: "2026-09-25T10:04:00Z",
    desired_playlist: playlist(PROMO, 7, "Weekend promo"),
  })), NOW);
  assert.equal(pages, "partial Target v7 3 pages reported 2026-09-25T10:04:00Z");
});

test("screen show prints the Manifest upgrade block and keeps the JSON body unchanged", async () => {
  const body = screen("scr_LOBBY", "Lobby", upgrade({
    state: "partial", desired_revision: TARGET_HASH, active_revision: TARGET_HASH,
    desired_playlist: playlist(PROMO, 7, "Weekend promo"), active_playlist: playlist(PROMO, 7, "Weekend promo"),
    missing_page_count: 3, state_since: "2026-09-25T10:00:00Z", reported_at: "2026-09-25T10:04:00Z",
  }));
  const transport = new FakeTransport().on("GET", "/api/v1/screens/scr_LOBBY", () => ({ status: 200, headers: {}, body }));
  const json = await cli(["--json", "screen", "show", "scr_LOBBY"], transport);
  assert.equal(json.code, 0, json.stdout);
  assert.deepEqual((JSON.parse(json.stdout) as { data: Screen }).data.manifest_upgrade, body.manifest_upgrade);

  const human = await cli(["--human", "screen", "show", "scr_LOBBY"], transport);
  assert.equal(human.code, 0, human.stdout);
  const block = human.stdout.slice(human.stdout.indexOf("Manifest upgrade")).split("\n");
  assert.equal(block[0], "Manifest upgrade");
  assert.equal(block[1], "Target v7 · Playing v7");
  assert.ok(block.some((line) => line === "playlist: Weekend promo"));
  assert.ok(block.some((line) => line === `diagnostics: target ${TARGET_HASH}, acknowledged ${TARGET_HASH}`));
  assert.ok(block.some((line) => line === "missing pages: 3"));
  assert.ok(block.some((line) => line.startsWith("Partial:")));
});

test("events follow delivers and renders manifest upgrade and activation events", async () => {
  const upgradeEvent = {
    cursor: "ev1_1", type: "screen.manifest_upgrade", severity: "warning",
    message: "Screen manifest upgrade retrying", at: "2026-09-25T10:00:00Z",
    resource: { type: "screen", id: "scr_LOBBY" },
    details: { manifest_revision: TARGET_HASH, state: "retrying", code: "download_failed", attempt: 2 },
  };
  const activatedEvent = {
    cursor: "ev1_2", type: "screen.manifest_activated", severity: "info",
    message: "Screen manifest activated", at: "2026-09-25T10:01:00Z",
    resource: { type: "screen", id: "scr_LOBBY" },
    details: { manifest_revision: TARGET_HASH },
  };
  const transport = new FakeTransport();
  transport.pushStream(eventFrame("ev1_1", upgradeEvent) + eventFrame("ev1_2", activatedEvent));

  const human = await cli(["--human", "events", "follow", "--timeout", "50"], transport);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /^organization: Example organization\nproject: Screens \(prj_AAAAAAAAAAAAAAAAAAAAAAAA\)\n/);
  const lines = human.stdout.split("\n").slice(2).filter((line) => line.length > 0);
  assert.equal(lines.length, 2, human.stdout);
  assert.match(lines[0]!, /^at=2026-09-25T10:00:00Z type=screen\.manifest_upgrade severity=warning resource_type=screen resource_id=scr_LOBBY code=download_failed /);
  assert.match(lines[0]!, /manifest_revision=man_abcdef123456 /);
  assert.match(lines[0]!, / state=retrying /);
  assert.match(lines[0]!, / attempt=2/);
  assert.match(lines[1]!, /type=screen\.manifest_activated .*manifest_revision=man_abcdef123456/);

  const json = await cli(["--json", "events", "follow", "--timeout", "50"], transport);
  assert.equal(json.code, 0, json.stdout);
  const envelopes = json.stdout.split("\n").filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { ok: boolean; data: { type: string; details: Record<string, unknown> } });
  assert.equal(envelopes.length, 2, json.stdout);
  assert.equal(envelopes[0]!.ok, true);
  assert.equal(envelopes[0]!.data.type, "screen.manifest_upgrade");
  assert.equal(envelopes[0]!.data.details.manifest_revision, TARGET_HASH);
  assert.equal(envelopes[0]!.data.details.state, "retrying");
  assert.equal(envelopes[0]!.data.details.code, "download_failed");
  assert.equal(envelopes[0]!.data.details.attempt, 2);
  assert.equal(envelopes[1]!.data.type, "screen.manifest_activated");
});

test("manifestUpgradeOf accepts the contract shape and rejects malformed objects", () => {
  assert.equal(manifestUpgradeOf(screen("scr_LOBBY", "Lobby", upgrade({ state: "partial" })))?.state, "partial");
  assert.equal(manifestUpgradeOf({ manifest_upgrade: { state: "weather" } } as unknown as Screen), undefined);
  assert.equal(manifestUpgradeOf({} as unknown as Screen), undefined);
});
