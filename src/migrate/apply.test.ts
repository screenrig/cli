import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testTemp } from "../test-temp.js";
import type { TransportRequest } from "../transport/types.js";
import { fixtureRouter, FIXTURE_TOKEN, FIXTURE_URL, registerFixtureVendor } from "./fixture-vendor.test.js";
import { fakeProject, harness, PROJECT_ID, type FakeProject, type Harness } from "./project-fake.test.js";

registerFixtureVendor();

const SIGNAGE = path.resolve(fileURLToPath(new URL("../../fixtures/migrate/files/signage/", import.meta.url)));
const APPLY = ["migrate", "apply", "--dir", "mig", "--no-transcode"];

interface World {
  project: FakeProject;
  h: Harness;
  cwd: string;
  dir: string;
  cleanup: () => Promise<unknown>;
}

async function world(options: Parameters<typeof fakeProject>[0] = {}): Promise<World> {
  const configDir = await testTemp("apply-cfg-");
  const cwd = await testTemp("apply-cwd-");
  const project = fakeProject(options);
  const h = await harness(project, configDir, cwd);
  return { project, h, cwd, dir: path.join(cwd, "mig"), cleanup: () => Promise.all([rm(configDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]) };
}

async function scanFiles(w: World): Promise<void> {
  const scan = await w.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE, "--dir", "mig"]);
  assert.equal(scan.code, 0, scan.stdout);
}

async function scanFixture(w: World, extra: string[] = []): Promise<void> {
  const scan = await w.h.invoke(["migrate", "scan", "--from", "fixture", "--url", FIXTURE_URL, "--dir", "mig", ...extra], { env: { FIXTURE_TOKEN }, vendorFetch: fixtureRouter().fetch });
  assert.equal(scan.code, 0, scan.stdout);
}

const readMap = async (w: World): Promise<any> => JSON.parse(await readFile(path.join(w.dir, "map.json"), "utf8"));
const applyFiles = (w: World, extra: string[] = []) => w.h.invoke([...APPLY, ...extra]);
const applyFixture = (w: World, extra: string[] = [], router = fixtureRouter()) => w.h.invoke([...APPLY, ...extra], { env: { FIXTURE_TOKEN }, vendorFetch: router.fetch });
const sorted = <T>(rows: Iterable<T>, by: (row: T) => string): T[] => [...rows].sort((a, b) => by(a).localeCompare(by(b)));
const writesTo = (project: FakeProject, route: string): number => project.writes().filter((write) => write === route).length;

test("a dry run reads the project and prints the plan; nothing is written on either side", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    const before = await readdir(w.dir);
    const result = await w.h.invoke(["migrate", "apply", "--dir", "mig", "--dry-run"]);
    assert.equal(result.code, 0, result.stdout);
    const data = result.json.data;
    assert.equal(data.dry_run, true);
    assert.deepEqual(data.plan.media, { create: 4, reuse: 0, recreate: 0, waiting: 0, fail: 0 });
    assert.deepEqual(data.plan.playlists, { create: 2, reuse: 0, recreate: 0, waiting: 0, fail: 0 });
    assert.deepEqual(data.plan.screens, { create: 3, reuse: 0, recreate: 0, waiting: 0, fail: 0 });
    assert.deepEqual(data.placeholders, { linked: 3, unlinked: 0, paired: 0, finished: 0 });
    assert.deepEqual(data.project, { fleet_links: { used: 0, max: 50 }, campaigns: { used: 0, max: 100 } });
    assert.ok(data.bytes > 0);
    assert.equal(data.items.length, 4 + 2 + 3);
    assert.deepEqual(data.tags, { "group:Lobby": "Lobby", "group:Ground floor": "GroundFloor" });
    assert.deepEqual(w.project.writes(), []);
    assert.deepEqual(await readdir(w.dir), before, "no map, lock or staging");
    assert.equal(w.project.transport.calls.every((call) => call.method === "GET"), true);
  } finally {
    await w.cleanup();
  }
});

test("the first apply makes the folder, media, playlists and waiting screens in order, and records every object", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    const result = await applyFiles(w);
    assert.equal(result.code, 0, result.stdout);
    const data = result.json.data;
    assert.deepEqual(data.applied.media, { create: 4, reuse: 0, recreate: 0, waiting: 0, fail: 0 });
    assert.deepEqual(data.applied.playlists, { create: 2, reuse: 0, recreate: 0, waiting: 0, fail: 0 });
    assert.deepEqual(data.applied.screens, { create: 3, reuse: 0, recreate: 0, waiting: 0, fail: 0 });
    assert.deepEqual(data.failed, []);
    assert.deepEqual(data.placeholders.map((item: { source_id: string; state: string }) => [item.source_id, item.state]), [["Front desk", "linked"], ["Cafe wall", "linked"], ["Back office, east", "linked"]]);
    const firstWrite = (route: string): number => w.project.writes().indexOf(route);
    assert.ok(firstWrite("POST /api/media-folders") < firstWrite("POST /api/media/uploads"));
    assert.ok(firstWrite("POST /api/media/uploads") < firstWrite("POST /api/playlists"));
    assert.ok(firstWrite("POST /api/playlists") < firstWrite("POST /api/fleet-links"));
    assert.equal(writesTo(w.project, "POST /api/campaigns"), 0);

    const [folder] = [...w.project.folders.values()];
    assert.equal(folder!.name, "Imported from Files");
    assert.equal(w.project.media.size, 4);
    assert.ok([...w.project.media.values()].every((item) => item.folder_id === folder!.id));
    assert.deepEqual(sorted(w.project.media.values(), (item) => String(item.source_filename)).map((item) => [item.source_filename, item.content_type]), [
      ["intro.mp4", "video/mp4"], ["menu.png", "image/png"], ["theme.mp3", "audio/mpeg"], ["welcome.png", "image/png"],
    ]);

    const lobby = [...w.project.playlists.values()].find((playlist) => playlist.name === "Lobby")!;
    const pages = lobby.pages as Array<{ id: string; advance: unknown; primitives: Array<{ primitive: string; selector: { media_id: string } }> }>;
    assert.deepEqual(pages.map((page) => page.advance), [{ mode: "duration", after_ms: 12_000 }, { mode: "media_end" }, { mode: "duration", after_ms: 5000 }]);
    const mediaBySource = (name: string): string => [...w.project.media.values()].find((item) => item.source_filename === name)!.id;
    assert.deepEqual(pages.map((page) => page.primitives[0]!.selector.media_id), [mediaBySource("welcome.png"), mediaBySource("intro.mp4"), mediaBySource("menu.png")]);
    assert.deepEqual(lobby.audio, { tracks: [{ id: "track_1", media_id: mediaBySource("theme.mp3") }] });

    const links = sorted(w.project.links.values(), (link) => String(link.label));
    assert.deepEqual(links.map((link) => [link.label, link.tags, link.max_screens, link.fields, link.playlist_id !== undefined]), [
      ["Back office, east", [], 1, { migrated_from: "files:Back office, east" }, false],
      ["Cafe wall", ["GroundFloor"], 1, { migrated_from: "files:Cafe wall" }, true],
      ["Front desk", ["Lobby", "GroundFloor"], 1, { migrated_from: "files:Front desk" }, true],
    ]);
    assert.equal(links.find((link) => link.label === "Front desk")!.playlist_id, lobby.id);

    const map = await readMap(w);
    assert.equal(map.schema, "screenrig.migration-map/v1");
    assert.equal(map.api_url, "https://api.screenrig.ai");
    assert.equal(map.project_id, PROJECT_ID);
    assert.equal(map.vendor, "files");
    assert.equal(map.account, "files");
    assert.match(map.seed, /^[0-9a-f]{64}$/);
    assert.deepEqual(map.tags, { "group:Lobby": "Lobby", "group:Ground floor": "GroundFloor" });
    assert.deepEqual(Object.keys(map.items).sort(), [
      "folder:root", "media:audio/theme.mp3", "media:images/menu.png", "media:images/welcome.png", "media:video/intro.mp4",
      "playlist:Cafe", "playlist:Lobby", "screen:Back office, east", "screen:Cafe wall", "screen:Front desk",
    ]);
    assert.equal(map.items["playlist:Lobby"].id, lobby.id);
    assert.ok(map.items["screen:Front desk"].fleet_link_id.startsWith("flk_"));
    assert.equal((await stat(path.join(w.dir, "map.json"))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(w.dir)).sort(), ["map.json", "scan.json", "staging"], "the lock is gone");
    assert.deepEqual(await readdir(path.join(w.dir, "staging")), [], "downloads are deleted once the media is mapped");
    assert.ok(!result.stdout.includes("#fleet="), "a fleet link URL is never printed");
    assert.ok(!JSON.stringify([...w.project.transport.calls.map((call) => call.headers)]).includes("migration"), "no secret rides in a header");
  } finally {
    await w.cleanup();
  }
});

test("a rerun reuses everything it made and writes nothing; edits made in screenRIG survive", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    await applyFiles(w);
    const writes = w.project.writes().length;
    const lobby = [...w.project.playlists.values()].find((playlist) => playlist.name === "Lobby")!;
    lobby.name = "Lobby, edited by a person";
    const again = await applyFiles(w);
    assert.equal(again.code, 0, again.stdout);
    assert.deepEqual(again.json.data.applied.media, { create: 0, reuse: 4, recreate: 0, waiting: 0, fail: 0 });
    assert.deepEqual(again.json.data.applied.screens, { create: 0, reuse: 3, recreate: 0, waiting: 0, fail: 0 });
    assert.equal(w.project.writes().length, writes, "not one more write");
    assert.equal(lobby.name, "Lobby, edited by a person");
  } finally {
    await w.cleanup();
  }
});

test("an object deleted in screenRIG is made again, and nothing else is touched", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    await applyFiles(w);
    const map = await readMap(w);
    const menuId = map.items["media:images/menu.png"].id;
    const cafeId = map.items["playlist:Cafe"].id;
    const linkId = map.items["screen:Cafe wall"].fleet_link_id;
    const lobbyId = map.items["playlist:Lobby"].id;
    w.project.media.delete(menuId);
    w.project.playlists.delete(cafeId);
    w.project.links.delete(linkId);
    const before = w.project.writes().length;
    const again = await applyFiles(w);
    assert.equal(again.code, 0, again.stdout);
    assert.equal(again.json.data.applied.media.recreate, 1);
    assert.equal(again.json.data.applied.playlists.recreate, 1);
    assert.equal(again.json.data.applied.screens.recreate, 1);
    const after = await readMap(w);
    assert.notEqual(after.items["media:images/menu.png"].id, menuId);
    assert.notEqual(after.items["playlist:Cafe"].id, cafeId);
    assert.notEqual(after.items["screen:Cafe wall"].fleet_link_id, linkId);
    assert.equal(after.items["playlist:Lobby"].id, lobbyId);
    assert.deepEqual(w.project.writes().slice(before).map((write) => write.replace(/\/\w+\/commit$/, "/commit")).sort(), [
      "POST /api/fleet-links", "POST /api/media/move", "POST /api/media/uploads", "POST /api/media/uploads/commit", "POST /api/playlists",
    ].sort());
    // The recreated playlist points at the recreated media.
    const cafe = w.project.playlists.get(after.items["playlist:Cafe"].id)!;
    assert.equal((cafe.pages as Array<{ primitives: Array<{ selector: { media_id: string } }> }>)[0]!.primitives[0]!.selector.media_id, after.items["media:images/menu.png"].id);
    // Lobby still shows the media it was made with, and the old menu is gone: it was never rewritten.
    assert.ok(w.project.playlists.has(lobbyId));
  } finally {
    await w.cleanup();
  }
});

test("one item failing does not stop the rest: its dependents wait, the exit code follows the failure, and a rerun finishes", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    w.project.intercept = (req: TransportRequest) => (req.method === "POST" && req.path === "/api/media/uploads" && (req.body as { filename?: string }).filename === "intro.mp4"
      ? { status: 400, headers: { "content-type": "application/problem+json" }, body: { status: 400, code: "invalid_request", title: "Request refused", detail: "That video cannot be read." } }
      : undefined);
    const result = await applyFiles(w);
    assert.equal(result.code, 8);
    assert.equal(result.json.ok, true);
    assert.deepEqual(result.json.warnings.map((warning: { code: string }) => warning.code), ["migration_items_failed"]);
    assert.deepEqual(result.json.data.failed.map((item: { key: string; code: string; status: number }) => [item.key, item.code, item.status]), [["media:video/intro.mp4", "invalid_request", 400]]);
    assert.deepEqual(result.json.data.applied.media, { create: 3, reuse: 0, recreate: 0, waiting: 0, fail: 1 });
    assert.deepEqual(result.json.data.waiting.map((item: { key: string }) => item.key).sort(), ["playlist:Lobby", "screen:Front desk"]);
    assert.match(result.json.data.waiting[0].reason, /Its (media|playlist) has not been imported/);
    assert.equal(result.json.data.applied.playlists.create, 1, "Cafe does not use the video");
    assert.equal(result.json.data.applied.screens.create, 2);
    const map = await readMap(w);
    assert.equal(map.failed["media:video/intro.mp4"].code, "invalid_request");
    assert.equal(result.json.data.stopped, undefined);

    w.project.intercept = undefined;
    const again = await applyFiles(w);
    assert.equal(again.code, 0, again.stdout);
    assert.deepEqual(again.json.data.failed, []);
    assert.equal(again.json.data.applied.media.create, 1);
    assert.equal(again.json.data.applied.playlists.create, 1);
    assert.equal(again.json.data.applied.screens.create, 1);
    assert.equal(again.json.data.applied.media.reuse, 3);
    assert.deepEqual((await readMap(w)).failed, {});
  } finally {
    await w.cleanup();
  }
});

test("payment_required stops the run with the same command to run again; the rest waits, and a resume completes", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    let declared = 0;
    w.project.intercept = (req: TransportRequest) => {
      if (req.method !== "POST" || req.path !== "/api/media/uploads") return undefined;
      declared += 1;
      return declared > 2 ? { status: 402, headers: { "content-type": "application/problem+json" }, body: { status: 402, code: "payment_required", title: "Payment required", detail: "The project has no credit left." } } : undefined;
    };
    const result = await w.h.invoke([...APPLY, "--concurrency", "1"]);
    assert.equal(result.code, 8, result.stdout);
    assert.equal(result.json.ok, true);
    const stopped = result.json.data.stopped;
    assert.equal(stopped.code, "payment_required");
    assert.match(stopped.detail, /no credit left/);
    assert.match(stopped.next.command, /^screenrig migrate apply --dir \S+\/mig --concurrency 1 --no-transcode$/);
    assert.match(stopped.next.reason, /billing balance/);
    assert.equal(result.json.data.applied.media.create, 2);
    assert.equal(result.json.data.applied.playlists.create, 0, "nothing after the stop is written");
    assert.equal(w.project.playlists.size, 0);
    assert.equal(w.project.links.size, 0);
    assert.ok(result.json.data.waiting.some((item: { key: string; reason: string }) => item.key === "playlist:Lobby" && /stopped|not imported/.test(item.reason)));
    assert.deepEqual(result.json.data.failed, [], "a stop is not a per-item failure");

    w.project.intercept = undefined;
    const resumed = await w.h.invoke([...APPLY, "--concurrency", "1"]);
    assert.equal(resumed.code, 0, resumed.stdout);
    assert.equal(resumed.json.data.applied.media.reuse, 2);
    assert.equal(resumed.json.data.applied.media.create, 2);
    assert.equal(w.project.media.size, 4, "no media was uploaded twice");
    assert.equal(w.project.links.size, 3);
  } finally {
    await w.cleanup();
  }
});

test("a pending review (a Propose sign-in) stops the run and points at Manage access", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    w.project.intercept = (req: TransportRequest) => (req.method === "POST" && req.path === "/api/playlists"
      ? { status: 202, headers: {}, body: { status: "pending_review", review: { id: "rvw_X", url: "https://screenrig.ai/dashboard/reviews/rvw_X", kind: "playlist_change", subject: { id: "pl_x" } } } }
      : undefined);
    const result = await applyFiles(w);
    assert.equal(result.json.data.stopped.code, "pending_review");
    assert.equal(result.json.data.stopped.next.command, "screenrig login --access manage");
    assert.equal(w.project.links.size, 0);
  } finally {
    await w.cleanup();
  }
});

test("a map made for another project, API URL or vendor is migration_dir_mismatch and nothing is written", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    const base = { schema: "screenrig.migration-map/v1", api_url: "https://api.screenrig.ai", project_id: PROJECT_ID, vendor: "files", account: "files", seed: "s".repeat(64), tags: {}, items: {}, failed: {} };
    for (const [field, value, aspect] of [["project_id", "prj_OTHER", "project"], ["api_url", "https://api.stage.example.com", "API URL"], ["vendor", "xibo", "vendor"], ["account", "https://cms.example.com", "source account"]] as const) {
      await writeFile(path.join(w.dir, "map.json"), JSON.stringify({ ...base, [field]: value }));
      const dry = await w.h.invoke(["migrate", "apply", "--dir", "mig", "--dry-run"]);
      assert.equal(dry.code, 2, field);
      assert.equal(dry.json.error.code, "migration_dir_mismatch");
      assert.match(dry.json.error.detail, new RegExp(`another ${aspect}`));
      const real = await applyFiles(w);
      assert.equal(real.json.error.code, "migration_dir_mismatch", field);
    }
    assert.deepEqual(w.project.writes(), []);
    assert.deepEqual((await readdir(w.dir)).sort(), ["map.json", "scan.json"], "no lock file is left");
  } finally {
    await w.cleanup();
  }
});

test("a lock held by a running process refuses the run; a lock whose process has ended is taken over", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    await writeFile(path.join(w.dir, "map.json.lock"), String(process.pid));
    const held = await applyFiles(w);
    assert.equal(held.code, 2);
    assert.equal(held.json.error.code, "usage_error");
    assert.match(held.json.error.detail, new RegExp(`process ${process.pid}`));
    assert.deepEqual(w.project.writes(), []);
    const ended = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    await writeFile(path.join(w.dir, "map.json.lock"), ended.stdout);
    const taken = await applyFiles(w);
    assert.equal(taken.code, 0, taken.stdout);
    await writeFile(path.join(w.dir, "map.json.lock"), "not a pid");
    assert.equal((await applyFiles(w)).code, 0, "a lock that holds no pid is stale");
    await assert.rejects(stat(path.join(w.dir, "map.json.lock")), { code: "ENOENT" });
  } finally {
    await w.cleanup();
  }
});

test("beyond the project's fleet link cap, placeholders stay unlinked, and each finished placeholder frees a slot", async () => {
  const w = await world({ linkCap: 2 });
  try {
    await scanFiles(w);
    const result = await applyFiles(w);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.json.data.placeholders.map((item: { source_id: string; state: string }) => [item.source_id, item.state]), [["Front desk", "linked"], ["Cafe wall", "linked"], ["Back office, east", "unlinked"]]);
    assert.equal(result.json.data.applied.screens.create, 3);
    assert.equal(w.project.links.size, 2);
    const map = await readMap(w);
    assert.equal(map.items["screen:Back office, east"], undefined, "an unlinked placeholder has no map entry yet");
    // A device opens the first link; the next apply finishes that screen and frees its slot for the third.
    const screen = w.project.openLink(map.items["screen:Front desk"].fleet_link_id, "ASSET-001");
    const freed = await applyFiles(w);
    assert.equal(freed.code, 0, freed.stdout);
    assert.deepEqual(freed.json.data.placeholders.map((item: { source_id: string; state: string }) => [item.source_id, item.state]), [["Front desk", "finished"], ["Cafe wall", "linked"], ["Back office, east", "linked"]]);
    assert.equal(w.project.links.size, 2);
    assert.equal(w.project.screens.get(screen.id)!.label, "Front desk");
  } finally {
    await w.cleanup();
  }
});

test("a dry run counts the project's 50 fleet links and says which placeholders will wait for a Player code", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    for (let n = 0; n < 49; n += 1) w.project.links.set(`flk_other${n}`, { id: `flk_other${n}`, label: `Other ${n}`, tags: [] });
    const dry = await w.h.invoke(["migrate", "apply", "--dir", "mig", "--dry-run"]);
    assert.deepEqual(dry.json.data.placeholders, { linked: 1, unlinked: 2, paired: 0, finished: 0 });
    assert.deepEqual(dry.json.data.project.fleet_links, { used: 49, max: 50 });
    assert.deepEqual(w.project.writes(), []);
  } finally {
    await w.cleanup();
  }
});

test("a screen that opened its link is finished once: old name, time zone, map entry, and the used link deleted", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    await applyFiles(w);
    const map = await readMap(w);
    const linkId = map.items["screen:Front desk"].fleet_link_id;
    const screen = w.project.openLink(linkId, "ASSET-001");
    const before = w.project.writes().length;
    const result = await applyFiles(w);
    assert.equal(result.code, 0, result.stdout);
    const stored = w.project.screens.get(screen.id)!;
    assert.equal(stored.label, "Front desk");
    assert.equal(stored.timezone, "America/Toronto");
    assert.equal(w.project.links.has(linkId), false, "the used link is deleted");
    assert.equal(w.project.links.size, 2);
    const after = await readMap(w);
    assert.deepEqual({ ...after.items["screen:Front desk"], at: undefined }, { fleet_link_id: linkId, screen_id: screen.id, finished: true, at: undefined });
    assert.deepEqual(result.json.data.placeholders[0], { source_id: "Front desk", name: "Front desk", screen_id: screen.id, state: "finished", fleet_link_id: linkId });
    assert.deepEqual(w.project.writes().slice(before), [`PATCH /api/screens/${screen.id}`, `DELETE /api/fleet-links/${linkId}`]);

    // Once: an edit made afterwards is not undone, and nothing is written again.
    stored.label = "Reception";
    const writes = w.project.writes().length;
    const again = await applyFiles(w);
    assert.equal(again.code, 0);
    assert.equal(w.project.writes().length, writes);
    assert.equal(stored.label, "Reception");
    assert.equal(again.json.data.placeholders[0].state, "finished");
  } finally {
    await w.cleanup();
  }
});

test("finishing a screen that fails on its last step is retried by the next apply, not marked finished", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    await applyFiles(w);
    const linkId = (await readMap(w)).items["screen:Front desk"].fleet_link_id;
    const screen = w.project.openLink(linkId, "ASSET-001");
    w.project.intercept = (req: TransportRequest) => (req.method === "DELETE" && req.path === `/api/fleet-links/${linkId}`
      ? { status: 400, headers: { "content-type": "application/problem+json" }, body: { status: 400, code: "invalid_request", title: "Request refused", detail: "Not now." } }
      : undefined);
    const first = await applyFiles(w);
    assert.equal(first.code, 8);
    assert.deepEqual(first.json.data.failed.map((item: { key: string }) => item.key), ["screen:Front desk"]);
    assert.equal(w.project.screens.get(screen.id)!.label, "Front desk", "the name was already set");
    const mid = await readMap(w);
    assert.equal(mid.items["screen:Front desk"].finished, undefined);
    assert.equal(mid.items["screen:Front desk"].screen_id, undefined, "only a pair claim records a screen before the screen is finished");
    w.project.intercept = undefined;
    const second = await applyFiles(w);
    assert.equal(second.code, 0, second.stdout);
    assert.equal(w.project.links.has(linkId), false);
    assert.equal((await readMap(w)).items["screen:Front desk"].finished, true);
    assert.equal(second.json.data.placeholders[0].state, "finished");
  } finally {
    await w.cleanup();
  }
});

test("a group tag never equals a tag an existing screen already carries", async () => {
  const w = await world();
  try {
    w.project.addScreen("scr_existing", { tags: ["lobby", "Cafe"] });
    await scanFiles(w);
    const dry = await w.h.invoke(["migrate", "apply", "--dir", "mig", "--dry-run"]);
    assert.deepEqual(dry.json.data.tags, { "group:Lobby": "Lobby2", "group:Ground floor": "GroundFloor" });
    await applyFiles(w);
    const front = [...w.project.links.values()].find((link) => link.label === "Front desk")!;
    assert.deepEqual(front.tags, ["Lobby2", "GroundFloor"]);
    assert.deepEqual((await readMap(w)).tags, { "group:Lobby": "Lobby2", "group:Ground floor": "GroundFloor" });
    // Allocations never change after the first apply, even when the other screen's tags do.
    w.project.screens.get("scr_existing")!.tags = [];
    await applyFiles(w);
    assert.equal((await readMap(w)).tags["group:Lobby"], "Lobby2");
  } finally {
    await w.cleanup();
  }
});

test("--only limits the kinds; dependents of an unselected kind wait until it exists", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    const first = await applyFiles(w, ["--only", "playlists,screens"]);
    assert.equal(first.code, 0, first.stdout);
    assert.equal(first.json.data.applied.media.create, 0);
    assert.deepEqual(first.json.data.applied.playlists, { create: 0, reuse: 0, recreate: 0, waiting: 2, fail: 0 });
    assert.equal(w.project.media.size, 0);
    assert.equal(w.project.playlists.size, 0);
    assert.equal(first.json.data.placeholders.filter((item: { state: string }) => item.state === "waiting").length, 2);
    assert.equal(first.json.data.placeholders.filter((item: { state: string }) => item.state === "linked").length, 1, "a screen with no default playlist does not wait");
    const media = await applyFiles(w, ["--only", "media"]);
    assert.equal(media.json.data.applied.media.create, 4);
    assert.equal(w.project.playlists.size, 0);
    const rest = await applyFiles(w, ["--only", "playlists,screens"]);
    assert.equal(rest.json.data.applied.playlists.create, 2);
    assert.equal(rest.json.data.applied.screens.create, 2);
    assert.equal(rest.json.data.applied.screens.reuse, 1);
    const bad = await applyFiles(w, ["--only", "media,nonsense"]);
    assert.equal(bad.code, 2);
    assert.match(bad.json.error.detail, /--only takes a comma-separated list of media, playlists, screens, schedules/);
  } finally {
    await w.cleanup();
  }
});

test("--folder uses an existing folder, --canvas sets plain playlists, --concurrency is bounded", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    w.project.folders.set("mfd_EXISTING", { id: "mfd_EXISTING", name: "Mine" });
    const result = await applyFiles(w, ["--folder", "mfd_EXISTING", "--canvas", "1280x720", "--concurrency", "2"]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(w.project.folders.size, 1);
    assert.ok([...w.project.media.values()].every((item) => item.folder_id === "mfd_EXISTING"));
    assert.equal(result.json.data.folder_id, "mfd_EXISTING");
    const cafe = [...w.project.playlists.values()].find((playlist) => playlist.name === "Cafe")!;
    assert.deepEqual((cafe.pages as Array<{ canvas: { width: number; height: number } }>)[0]!.canvas.width, 1280);
    assert.equal((await applyFiles(w, ["--concurrency", "9"])).json.error.code, "usage_error");
    assert.equal((await applyFiles(w, ["--canvas", "wide"])).json.error.code, "usage_error");
    const missing = await w.h.invoke([...APPLY, "--folder", "mfd_MISSING"]);
    assert.equal(missing.code, 4, "a folder that is not there is the server's not_found");
  } finally {
    await w.cleanup();
  }
});

test("apply with no scan names migrate scan; an unreadable choice of directory is explained", async () => {
  const w = await world();
  try {
    const none = await w.h.invoke(["migrate", "apply", "--dir", "nowhere"]);
    assert.equal(none.code, 2);
    assert.match(none.json.error.detail, /There is no scan in .*nowhere\. Run migrate scan first\./);
    assert.equal(none.json.error.next.command, "screenrig migrate scan --from VENDOR");
    const unknown = await w.h.invoke(["migrate", "apply"]);
    assert.match(unknown.json.error.detail, /There is no migration directory here/);
    await scanFiles(w);
    const found = await w.h.invoke(["migrate", "apply", "--dry-run"]);
    assert.equal(found.code, 2, "the directory is not the default name, so it is not found");
    await w.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE]);
    await w.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE, "--dir", "screenrig-migration-other"]);
    assert.match((await w.h.invoke(["migrate", "apply", "--dry-run"])).json.error.detail, /More than one migration directory/);
  } finally {
    await w.cleanup();
  }
});

// ---- a system with an API: downloads, groups, layouts and schedules -----------------------------------------

test("a vendor's media is downloaded with its key, uploaded, and the key leaves no trace in the directory", async () => {
  const w = await world();
  try {
    await scanFixture(w);
    const router = fixtureRouter();
    const result = await applyFixture(w, [], router);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(w.project.media.size, 3);
    assert.deepEqual(router.requests.map((request) => request.path).sort(), ["/api/library/download/1", "/api/library/download/2", "/api/library/download/4"]);
    assert.ok(router.requests.every((request) => request.authorization === `Bearer ${FIXTURE_TOKEN}`));
    for (const name of ["scan.json", "map.json"]) {
      const text = await readFile(path.join(w.dir, name), "utf8");
      assert.ok(!text.includes(FIXTURE_TOKEN), `${name} holds no key`);
    }
    assert.ok(!result.stdout.includes(FIXTURE_TOKEN));
    assert.ok(!result.stderr.includes(FIXTURE_TOKEN));
    assert.ok(!JSON.stringify(w.project.transport.calls).includes(FIXTURE_TOKEN), "nothing sent to screenRIG carries the key");
    // A rerun downloads nothing.
    const again = fixtureRouter();
    await applyFixture(w, [], again);
    assert.deepEqual(again.requests, []);
    // And with every media mapped, the key is not even needed.
    const keyless = await w.h.invoke(APPLY);
    assert.equal(keyless.code, 0, keyless.stdout);
  } finally {
    await w.cleanup();
  }
});

test("schedules become campaigns on the group tags, with exact windows, priority and bounds; what cannot is not made", async () => {
  const w = await world();
  try {
    w.project.addScreen("scr_existing", { tags: ["Cafe"] });
    await scanFixture(w);
    const result = await applyFixture(w);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.json.data.applied.schedules, { create: 3, reuse: 0, recreate: 0, waiting: 0, fail: 0 });
    const tags = (await readMap(w)).tags;
    assert.deepEqual(tags, { "group:g1": "LobbyScreens", "group:g2": "Cafe2", "screen:s3": "BackOffice" });
    const campaigns = sorted(w.project.campaigns.values(), (campaign) => String(campaign.name));
    const playlistId = (await readMap(w)).items["playlist:11"].id;
    assert.deepEqual(campaigns.map(({ id: _id, revision: _revision, paused: _paused, ...rest }) => rest), [
      { name: "Always at the café", playlist_id: playlistId, audience: { tag: "Cafe2" }, priority: 5 },
      { name: "Holiday", playlist_id: playlistId, audience: { tag: "BackOffice" }, from: "2026-12-24T09:00", until: "2026-12-26T09:00", priority: 20 },
      {
        name: "Weekday mornings", playlist_id: playlistId, audience: { tag: "LobbyScreens" }, from: "2026-11-02T00:00", until: "2026-12-19T00:00",
        windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "07:00", end: "11:00" }], priority: 10,
      },
    ]);
    // The screen that a schedule names alone carries its own tag, and the café screen got the collision-free one.
    const links = sorted(w.project.links.values(), (link) => String(link.label));
    assert.deepEqual(links.map((link) => [link.label, link.tags]), [["Back office", ["BackOffice"]], ["Café wall", ["Cafe2"]], ["Front desk", ["LobbyScreens"]]]);
    assert.ok(!campaigns.some((campaign) => campaign.name === "Monthly report"));
    const second = await applyFixture(w);
    assert.deepEqual(second.json.data.applied.schedules, { create: 0, reuse: 3, recreate: 0, waiting: 0, fail: 0 });
    assert.equal(w.project.campaigns.size, 3);
  } finally {
    await w.cleanup();
  }
});

test("layouts become playlists and a screen showing one is placed with it", async () => {
  const w = await world();
  try {
    await scanFixture(w);
    await applyFixture(w);
    const layout = [...w.project.playlists.values()].find((playlist) => playlist.name === "Split")!;
    const pages = layout.pages as Array<{ advance: unknown; primitives: Array<{ id: string; rect: unknown; primitive: string }> }>;
    assert.equal(pages.length, 2);
    assert.deepEqual(pages.map((page) => page.advance), [{ mode: "duration", after_ms: 6000 }, { mode: "duration", after_ms: 9000 }]);
    assert.deepEqual(pages[0]!.primitives.map((item) => [item.id, item.primitive]), [["zone_1", "image"], ["zone_2", "iframe"]]);
    const cafe = [...w.project.links.values()].find((link) => link.label === "Café wall")!;
    assert.equal(cafe.playlist_id, layout.id);
  } finally {
    await w.cleanup();
  }
});

test("campaign_limit_reached stops the run at the campaigns; the playlists and screens before it stand", async () => {
  const w = await world({ campaignCap: 1 });
  try {
    await scanFixture(w);
    const result = await applyFixture(w);
    assert.equal(result.json.data.stopped.code, "campaign_limit_reached");
    assert.equal(result.code, 5);
    assert.match(result.json.data.stopped.next.reason, /campaign delete/);
    assert.equal(w.project.campaigns.size, 1);
    assert.equal(result.json.data.applied.schedules.create, 1);
    assert.equal(result.json.data.applied.schedules.waiting, 2, "the refused one and the one after it");
    assert.equal(w.project.links.size, 3);
  } finally {
    await w.cleanup();
  }
});

test("the vendor refusing the key mid-run ends the run as vendor_refused with the command to run again", async () => {
  const w = await world();
  try {
    await scanFixture(w);
    const result = await applyFixture(w, [], fixtureRouter({ downloadStatus: { "2": 401 } }));
    assert.equal(result.code, 3, result.stdout);
    assert.equal(result.json.data.stopped.code, "vendor_refused");
    assert.match(result.json.data.stopped.detail, /Check FIXTURE_TOKEN/);
    assert.match(result.json.data.stopped.next.command, /^screenrig migrate apply --dir /);
    const resumed = await applyFixture(w);
    assert.equal(resumed.code, 0, resumed.stdout);
    assert.equal(w.project.media.size, 3);
  } finally {
    await w.cleanup();
  }
});

test("a file the vendor no longer has fails that media alone", async () => {
  const w = await world();
  try {
    await scanFixture(w);
    const result = await applyFixture(w, [], fixtureRouter({ downloadStatus: { "4": 404 } }));
    assert.equal(result.code, 8, "the exit code follows the failure, as media upload-batch does");
    assert.deepEqual(result.json.data.failed.map((item: { key: string; code: string }) => [item.key, item.code]), [["media:4", "vendor_not_found"]]);
    assert.equal(result.json.data.stopped, undefined);
    assert.equal(w.project.media.size, 2);
    assert.ok(result.json.data.waiting.some((item: { key: string }) => item.key === "playlist:10"));
  } finally {
    await w.cleanup();
  }
});

test("apply needs the vendor key only when a download is due", async () => {
  const w = await world();
  try {
    await scanFixture(w);
    const dry = await w.h.invoke(["migrate", "apply", "--dir", "mig", "--dry-run"]);
    assert.equal(dry.code, 0, dry.stdout);
    const missing = await w.h.invoke(APPLY);
    assert.equal(missing.code, 2);
    assert.match(missing.json.error.detail, /Fixture CMS needs FIXTURE_TOKEN/);
    const fromFile = path.join(w.cwd, "fixture.env");
    await writeFile(fromFile, `# fixture\nFIXTURE_TOKEN="${FIXTURE_TOKEN}"\n`);
    const ok = await w.h.invoke([...APPLY, "--credentials", fromFile], { vendorFetch: fixtureRouter().fetch });
    assert.equal(ok.code, 0, ok.stdout);
    assert.ok(!ok.stdout.includes(FIXTURE_TOKEN));
  } finally {
    await w.cleanup();
  }
});

test("originals the API cannot hand out come from --files by file name, with no vendor key at all", async () => {
  const w = await world();
  try {
    const bare = await w.h.invoke(["migrate", "scan", "--from", "fixture-local", "--dir", "bare"]);
    assert.equal(bare.code, 0, bare.stdout);
    assert.equal(bare.json.data.importable.media, 0);
    assert.deepEqual(bare.json.data.not_imported.filter((entry: { kind: string }) => entry.kind === "media").map((entry: { source_id: string }) => entry.source_id), ["a", "b", "c"]);
    assert.equal(bare.json.data.not_imported[0].next, "Download welcome.png from Local CMS into a folder and rerun migrate scan with --files DIR.");
    assert.equal(bare.json.data.importable.playlists, 0, "a playlist with no media is not importable");

    const scan = await w.h.invoke(["migrate", "scan", "--from", "fixture-local", "--files", SIGNAGE, "--dir", "mig"]);
    assert.equal(scan.code, 0, scan.stdout);
    assert.deepEqual(scan.json.data.importable.media, 2);
    assert.deepEqual(scan.json.data.not_imported.map((entry: { source_id: string; reason: string }) => [entry.source_id, entry.reason]), [
      ["c", "Local CMS does not hand out this file, and no file of that name is in --files."],
    ]);
    assert.ok(scan.json.data.lossy.some((entry: { kind: string; change: string }) => entry.kind === "playlist" && /1 item was left out because its media did not come over/.test(entry.change)));
    const stored = JSON.parse(await readFile(path.join(w.dir, "scan.json"), "utf8"));
    assert.deepEqual(stored.catalog.media.map((media: { id: string; local: string }) => [media.id, media.local]), [["a", "images/welcome.png"], ["b", "video/intro.mp4"]]);

    const result = await applyFiles(w);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(w.project.media.size, 2);
    assert.equal(w.project.playlists.size, 1);
    assert.deepEqual(sorted(w.project.media.values(), (item) => String(item.source_filename)).map((item) => item.source_filename), ["Intro.MP4", "Welcome.png"]);
  } finally {
    await w.cleanup();
  }
});

// ---- more than one import into one project ---------------------------------------------------------------------

test("a second import of the same names into one project leaves the first import's screens alone", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    await applyFiles(w);
    const first = await readMap(w);
    // A device opens the first import's link and is not finished yet.
    const firstScreen = w.project.openLink(first.items["screen:Front desk"].fleet_link_id, "ASSET-001");
    const writesBefore = w.project.writes().length;

    // A second directory imports an account that has a screen of the same name (Anthias calls its only screen "device").
    const scan = await w.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE, "--dir", "mig2"]);
    assert.equal(scan.code, 0, scan.stdout);
    const second = await w.h.invoke(["migrate", "apply", "--dir", "mig2", "--no-transcode"]);
    assert.equal(second.code, 0, second.stdout);

    const stored = w.project.screens.get(firstScreen.id)!;
    assert.equal(stored.label, "ASSET-001", "the first import's screen keeps the name its device gave it");
    assert.equal(stored.timezone, undefined);
    assert.ok(!w.project.writes().slice(writesBefore).some((write) => write === `PATCH /api/screens/${firstScreen.id}`), "nothing was written to the first import's screen");
    assert.equal(w.project.links.has(first.items["screen:Front desk"].fleet_link_id), true, "the first import's link is still there");

    const other = JSON.parse(await readFile(path.join(w.cwd, "mig2", "map.json"), "utf8"));
    assert.notEqual(other.items["screen:Front desk"].fleet_link_id, first.items["screen:Front desk"].fleet_link_id);
    assert.equal(other.items["screen:Front desk"].screen_id, undefined, "the second import's screen is still waiting");
    assert.equal(other.items["screen:Front desk"].finished, undefined);
    assert.deepEqual(second.json.data.placeholders.map((item: { source_id: string; state: string }) => [item.source_id, item.state]), [["Front desk", "linked"], ["Cafe wall", "linked"], ["Back office, east", "linked"]]);

    // The second import's own device pairs through the second link; the first import finishes its screen later.
    const secondScreen = w.project.openLink(other.items["screen:Front desk"].fleet_link_id, "ASSET-002");
    assert.equal((await w.h.invoke(["migrate", "apply", "--dir", "mig2", "--no-transcode"])).code, 0);
    assert.equal(w.project.screens.get(secondScreen.id)!.label, "Front desk");
    assert.equal(w.project.screens.get(firstScreen.id)!.label, "ASSET-001", "still untouched by the second import");
    assert.equal((await applyFiles(w)).code, 0);
    assert.equal(w.project.screens.get(firstScreen.id)!.label, "Front desk");
    assert.equal((await readMap(w)).items["screen:Front desk"].screen_id, firstScreen.id);
  } finally {
    await w.cleanup();
  }
});

test("a second import never reuses a tag that another import's screens or links carry", async () => {
  const w = await world();
  try {
    await scanFiles(w);
    // Screens and links that another import made carry migrated_from, and still keep their tags.
    w.project.addScreen("scr_other", { tags: ["Lobby"], fields: { migrated_from: "xibo:12" }, fleet_link_id: "flk_gone" });
    w.project.links.set("flk_other", { id: "flk_other", label: "Waiting", tags: ["GroundFloor"], fields: { migrated_from: "xibo:13" } });
    const dry = await w.h.invoke(["migrate", "apply", "--dir", "mig", "--dry-run"]);
    assert.deepEqual(dry.json.data.tags, { "group:Lobby": "Lobby2", "group:Ground floor": "GroundFloor2" });

    // The tags this import made stay its own on a rerun, even once its devices have paired with them.
    await applyFiles(w);
    const map = await readMap(w);
    const screen = w.project.openLink(map.items["screen:Front desk"].fleet_link_id, "ASSET-001");
    assert.deepEqual(screen.tags, ["Lobby2", "GroundFloor2"]);
    await applyFiles(w);
    assert.deepEqual((await readMap(w)).tags, { "group:Lobby": "Lobby2", "group:Ground floor": "GroundFloor2" });
    const third = await w.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE, "--dir", "mig3"]);
    assert.equal(third.code, 0);
    const later = await w.h.invoke(["migrate", "apply", "--dir", "mig3", "--dry-run"]);
    assert.deepEqual(later.json.data.tags, { "group:Lobby": "Lobby3", "group:Ground floor": "GroundFloor3" }, "the first import's screens and links reserve their tags from a third");
  } finally {
    await w.cleanup();
  }
});

// ---- a file that fails alone, and what ends the run -------------------------------------------------------------

test("one file address that no longer works fails that media alone, with the way back; a rerun finishes it", async () => {
  const w = await world();
  try {
    await scanFixture(w);
    const result = await applyFixture(w, [], fixtureRouter({ downloadRedirect: ["2"], cdnStatus: 403 }));
    assert.equal(result.code, 8, result.stdout);
    assert.equal(result.json.data.stopped, undefined, "an expired address is not a refusal of the key");
    assert.deepEqual(result.json.data.failed.map((item: { key: string; code: string }) => [item.key, item.code]), [["media:2", "vendor_file_gone"]]);
    assert.match(result.json.data.failed[0].detail, /sent no key.*migrate scan again to refresh the file addresses/);
    assert.equal(result.json.data.failed[0].next.command, "screenrig migrate scan --from fixture");
    assert.equal(w.project.media.size, 2, "the other two files came over");
    assert.ok(result.json.data.waiting.some((item: { key: string }) => item.key === "playlist:10"), "what needs the file waits");
    assert.equal(result.json.data.applied.screens.create >= 1, true, "the run went on past the media: the screen with no playlist was made");
    const resumed = await applyFixture(w);
    assert.equal(resumed.code, 0, resumed.stdout);
    assert.equal(w.project.media.size, 3);
  } finally {
    await w.cleanup();
  }
});

test("an answer that is not a file fails that media alone", async () => {
  const w = await world();
  try {
    await scanFixture(w);
    const result = await applyFixture(w, [], fixtureRouter({ emptyDownloads: ["4"] }));
    assert.equal(result.json.data.stopped, undefined);
    assert.deepEqual(result.json.data.failed.map((item: { key: string; code: string }) => [item.key, item.code]), [["media:4", "vendor_bad_response"]]);
    assert.equal(result.code, 9, "the exit code follows the failure");
    assert.equal(w.project.media.size, 2);
    assert.equal(result.json.data.applied.playlists.create >= 1, true, "the run went on past the media");
  } finally {
    await w.cleanup();
  }
});

test("a lost network still ends the run, and a rerun continues", async () => {
  const w = await world();
  try {
    await scanFixture(w);
    const result = await applyFixture(w, ["--concurrency", "1"], fixtureRouter({ networkDown: ["2"] }));
    assert.equal(result.json.data.stopped.code, "vendor_unavailable");
    assert.match(result.json.data.stopped.detail, /\(ECONNREFUSED\)/);
    assert.equal(result.code, 10);
    assert.equal(w.project.playlists.size, 0, "nothing after the stop is written");
    const resumed = await applyFixture(w);
    assert.equal(resumed.code, 0, resumed.stdout);
    assert.equal(w.project.media.size, 3);
  } finally {
    await w.cleanup();
  }
});

// ---- the same original file for two media -------------------------------------------------------------------------

test("two media that name the same original file upload together and leave the original untouched", async () => {
  const w = await world();
  try {
    const scan = await w.h.invoke(["migrate", "scan", "--from", "fixture-shared", "--files", SIGNAGE, "--dir", "mig"]);
    assert.equal(scan.code, 0, scan.stdout);
    assert.equal(scan.json.data.importable.media, 2, JSON.stringify(scan.json.data.not_imported));
    const original = path.join(SIGNAGE, "images", "welcome.png");
    const before = await stat(original);
    const result = await applyFiles(w, ["--concurrency", "2"]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.json.data.failed, []);
    assert.equal(w.project.media.size, 2);
    const after = await stat(original);
    assert.deepEqual([after.ctimeMs, after.mtimeMs, after.nlink], [before.ctimeMs, before.mtimeMs, before.nlink], "the original's inode was never linked, so its change time never moved");
  } finally {
    await w.cleanup();
  }
});
