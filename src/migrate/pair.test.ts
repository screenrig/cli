import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testTemp } from "../test-temp.js";
import type { TransportRequest } from "../transport/types.js";
import { findPlaceholder } from "./pair.js";
import { fakeProject, harness, type FakeProject, type Harness } from "./project-fake.test.js";
import type { ScanFile } from "./state.js";

const SIGNAGE = path.resolve(fileURLToPath(new URL("../../fixtures/migrate/files/signage/", import.meta.url)));

interface World {
  project: FakeProject;
  h: Harness;
  cwd: string;
  dir: string;
  cleanup: () => Promise<unknown>;
}

async function world(options: Parameters<typeof fakeProject>[0] = {}): Promise<World> {
  const configDir = await testTemp("pair-cfg-");
  const cwd = await testTemp("pair-cwd-");
  const project = fakeProject(options);
  const h = await harness(project, configDir, cwd);
  return { project, h, cwd, dir: path.join(cwd, "mig"), cleanup: () => Promise.all([rm(configDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]) };
}

async function applied(w: World, source = SIGNAGE): Promise<void> {
  assert.equal((await w.h.invoke(["migrate", "scan", "--from", "files", "--files", source, "--dir", "mig"])).code, 0);
  const result = await w.h.invoke(["migrate", "apply", "--dir", "mig", "--no-transcode"]);
  assert.equal(result.code, 0, result.stdout);
}

const readMap = async (w: World): Promise<any> => JSON.parse(await readFile(path.join(w.dir, "map.json"), "utf8"));
const pair = (w: World, code: string[], screen: string, extra: string[] = []) => w.h.invoke(["migrate", "pair", ...code, "--screen", screen, "--dir", "mig", ...extra]);

test("pairing a code to a waiting screen sets its name, playlist, time zone, field and tags, deletes its link and records it", async () => {
  const w = await world();
  try {
    await applied(w);
    const map = await readMap(w);
    const linkId = map.items["screen:Front desk"].fleet_link_id;
    const before = w.project.writes().length;
    const sent = w.project.transport.calls.length;
    const result = await pair(w, ["ABC", "234"], "Front desk");
    assert.equal(result.code, 0, result.stdout);
    const screenId = result.json.data.screen_id;
    assert.deepEqual(result.json.data.steps, ["paired", "updated", "tagged", "link deleted", "recorded"]);
    assert.equal(result.json.data.next.command, `screenrig screen show ${screenId}`);
    const calls = w.project.transport.calls.slice(sent).filter((call) => call.method !== "GET");
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["POST /api/screens/pair", `PATCH /api/screens/${screenId}`, `PATCH /api/screens/${screenId}`, `DELETE /api/fleet-links/${linkId}`]);
    assert.deepEqual(calls[0]!.body, { code: "ABC234", label: "Front desk" });
    assert.deepEqual(calls[1]!.body, { playlist_id: map.items["playlist:Lobby"].id, timezone: "America/Toronto", fields: { migrated_from: "files:Front desk" } });
    assert.deepEqual(calls[2]!.body, { tags: ["Lobby", "GroundFloor"] });
    const screen = w.project.screens.get(screenId)!;
    assert.equal(screen.label, "Front desk");
    assert.equal(screen.playlist_id, map.items["playlist:Lobby"].id);
    assert.equal(screen.timezone, "America/Toronto");
    assert.deepEqual(screen.tags, ["Lobby", "GroundFloor"]);
    assert.equal(w.project.links.has(linkId), false);
    const after = await readMap(w);
    assert.deepEqual({ ...after.items["screen:Front desk"], at: undefined }, { fleet_link_id: linkId, screen_id: screenId, finished: true, at: undefined });
    assert.equal(w.project.writes().length - before, 4);

    // The next apply finds it finished: nothing more is made or changed.
    const writes = w.project.writes().length;
    const again = await w.h.invoke(["migrate", "apply", "--dir", "mig", "--no-transcode"]);
    assert.equal(again.json.data.placeholders[0].state, "finished");
    assert.equal(w.project.writes().length, writes);
  } finally {
    await w.cleanup();
  }
});

test("findPlaceholder takes a source id before a name, and an ambiguous name lists the ids", () => {
  const screen = (id: string, name: string) => ({ id, name, group_ids: [], notes: [] });
  const scan = { catalog: { screens: [screen("a", "Lobby"), screen("b", "Lobby"), screen("c", "Cafe")] } } as unknown as ScanFile;
  assert.equal(findPlaceholder(scan, "c").name, "Cafe");
  assert.equal(findPlaceholder(scan, "Cafe").id, "c");
  assert.equal(findPlaceholder(scan, "b").id, "b");
  assert.throws(() => findPlaceholder(scan, "Lobby"), /2 screens are named "Lobby": "a", "b"\. Pass the source id of the one you mean\./);
  assert.throws(() => findPlaceholder(scan, "lobby"), /No screen in the scan has the source id or the exact name "lobby"/);
});

test("a placeholder is chosen by its source id or its exact old name; an ambiguous or unknown one is a usage error", async () => {
  const w = await world();
  try {
    await writeFile(path.join(w.cwd, "a.png"), await readFile(path.join(SIGNAGE, "images", "welcome.png")));
    await writeFile(path.join(w.cwd, "screens.csv"), "name\nHall\nHall\nAnnex\n");
    await applied(w, w.cwd);
    const unknown = await pair(w, ["ABC234"], "Nobody");
    assert.equal(unknown.code, 2);
    assert.match(unknown.json.error.detail, /No screen in the scan has the source id or the exact name "Nobody"/);
    assert.equal(w.project.transport.calls.some((call) => call.path === "/api/screens/pair"), false, "nothing was claimed");
    const byId = await pair(w, ["ABC234"], "Hall (2)");
    assert.equal(byId.code, 0, byId.stdout);
    assert.equal(w.project.screens.get(byId.json.data.screen_id)!.label, "Hall");
    const byName = await pair(w, ["DEF567"], "Annex");
    assert.equal(byName.code, 0);
  } finally {
    await w.cleanup();
  }
});

test("a placeholder that is already a screen is resource_conflict, naming the screen", async () => {
  const w = await world();
  try {
    await applied(w);
    const first = await pair(w, ["ABC234"], "Cafe wall");
    assert.equal(first.code, 0, first.stdout);
    const second = await pair(w, ["DEF567"], "Cafe wall");
    assert.equal(second.code, 5);
    assert.equal(second.json.error.code, "resource_conflict");
    assert.match(second.json.error.detail, new RegExp(`already screen ${first.json.data.screen_id}`));
    assert.equal(second.json.error.next.command, `screenrig screen show ${first.json.data.screen_id}`);
    assert.equal(w.project.transport.calls.filter((call) => call.path === "/api/screens/pair").length, 1);
  } finally {
    await w.cleanup();
  }
});

test("an interrupted pair is finished by running it again, without claiming the code twice", async () => {
  const w = await world();
  try {
    await applied(w);
    let failures = 1;
    w.project.intercept = (req: TransportRequest) => (failures > 0 && req.method === "PATCH" && Array.isArray((req.body as { tags?: unknown } | undefined)?.tags)
      ? (failures -= 1, { status: 500, headers: { "content-type": "application/problem+json" }, body: { status: 500, code: "internal_error", title: "Internal error", detail: "Try again." } })
      : undefined);
    const first = await pair(w, ["ABC234"], "Front desk");
    assert.equal(first.code, 9);
    assert.equal(first.json.ok, false);
    const mid = await readMap(w);
    const screenId = mid.items["screen:Front desk"].screen_id;
    assert.ok(screenId.startsWith("scr_"), "the screen is recorded the moment the code is claimed");
    assert.equal(mid.items["screen:Front desk"].finished, undefined);
    assert.ok(w.project.links.has(mid.items["screen:Front desk"].fleet_link_id), "the link is still there");

    // An apply in between leaves the half-paired screen alone: only migrate pair finishes it.
    const between = await w.h.invoke(["migrate", "apply", "--dir", "mig", "--no-transcode"]);
    assert.equal(between.code, 0, between.stdout);
    assert.equal(between.json.data.placeholders[0].state, "paired");
    assert.ok(w.project.links.has(mid.items["screen:Front desk"].fleet_link_id), "its link is not deleted");
    assert.equal((await readMap(w)).items["screen:Front desk"].finished, undefined);

    const second = await pair(w, ["ABC234"], "Front desk");
    assert.equal(second.code, 0, second.stdout);
    assert.equal(second.json.data.screen_id, screenId);
    assert.deepEqual(second.json.data.steps, ["updated", "tagged", "link deleted", "recorded"]);
    assert.equal(w.project.transport.calls.filter((call) => call.path === "/api/screens/pair").length, 1);
    assert.deepEqual(w.project.screens.get(screenId)!.tags, ["Lobby", "GroundFloor"]);
    assert.equal((await readMap(w)).items["screen:Front desk"].finished, true);
  } finally {
    await w.cleanup();
  }
});

test("a placeholder with no link, past the project's cap, pairs by code all the same", async () => {
  const w = await world({ linkCap: 1 });
  try {
    await applied(w);
    const map = await readMap(w);
    assert.equal(map.items["screen:Cafe wall"], undefined);
    const result = await pair(w, ["ABC234"], "Cafe wall");
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.json.data.steps, ["paired", "updated", "tagged", "recorded"]);
    const after = await readMap(w);
    assert.equal(after.items["screen:Cafe wall"].finished, true);
    assert.equal(after.items["screen:Cafe wall"].fleet_link_id, undefined);
  } finally {
    await w.cleanup();
  }
});

test("pairing before anything is imported is refused with the command that imports it", async () => {
  const w = await world();
  try {
    assert.equal((await w.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE, "--dir", "mig"])).code, 0);
    const early = await pair(w, ["ABC234"], "Front desk");
    assert.equal(early.code, 2);
    assert.match(early.json.error.detail, /has no map, so no placeholder/);
    assert.match(early.json.error.next.command, /^screenrig migrate apply --dir /);
    await w.h.invoke(["migrate", "apply", "--dir", "mig", "--no-transcode", "--only", "media"]);
    const unfinished = await pair(w, ["ABC234"], "Front desk");
    assert.match(unfinished.json.error.detail, /shows a playlist that has not been imported/);
    assert.equal(w.project.transport.calls.some((call) => call.path === "/api/screens/pair"), false);
  } finally {
    await w.cleanup();
  }
});

test("a pairing code the Player never showed is a usage error before anything is sent", async () => {
  const w = await world();
  try {
    await applied(w);
    const bad = await pair(w, ["not a code"], "Front desk");
    assert.equal(bad.code, 2);
    assert.equal(w.project.transport.calls.some((call) => call.path === "/api/screens/pair"), false);
    const lost = await pair(w, ["000000"], "Front desk");
    assert.equal(lost.json.ok, false);
  } finally {
    await w.cleanup();
  }
});
