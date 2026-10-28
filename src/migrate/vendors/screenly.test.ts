import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { testTemp } from "../../test-temp.js";
import { harness, fakeProject } from "../project-fake.test.js";
import type { SourceCatalog } from "../types.js";
import { fixture, NOW, open, problemOf, router, scan, type Recorded } from "./more-helpers.test.js";
import { parsePredicate, screenly, termTiming } from "./screenly.js";

const TOKEN = "fixture-token";
const CREDENTIALS = { SCREENLY_API_TOKEN: TOKEN };
const ROUTES: Record<string, string> = {
  "/assets": "assets", "/playlists": "playlists", "/playlist-items": "playlist-items", "/labels": "labels",
  "/labels/screens": "labels-screens", "/labels/playlists": "labels-playlists", "/screens": "screens",
};

/** The fixture workspace: every list is cut by limit and offset, as the API does. */
function workspace(overrides: Record<string, unknown[]> = {}) {
  return router(async (request: Recorded) => {
    if (request.url.origin !== "https://api.screenlyapp.com") return new Response("not here", { status: 404 });
    if (request.headers.authorization !== `Token ${TOKEN}`) return Response.json({ message: "JWSError JWSInvalidSignature" }, { status: 401 });
    const route = ROUTES[request.url.pathname.replace("/api/v4.1", "")];
    if (!route) return new Response("not found", { status: 404 });
    const rows = (overrides[route] ?? await fixture<unknown[]>("screenly", route)) as unknown[];
    const offset = Number(request.url.searchParams.get("offset") ?? 0);
    const limit = Number(request.url.searchParams.get("limit") ?? rows.length);
    return Response.json(rows.slice(offset, offset + limit));
  });
}

test("the account becomes media, playlists, groups, waiting screens and campaigns, exactly as the fixture says", async () => {
  const api = workspace();
  const catalog = await scan(screenly, api.fetch, { credentials: CREDENTIALS });
  assert.deepEqual(catalog, await fixture<SourceCatalog>("screenly", "catalog.expected"));
  assert.ok(api.requests.every((request) => request.headers.authorization === `Token ${TOKEN}` && request.url.origin === "https://api.screenlyapp.com"));
  assert.deepEqual([...new Set(api.requests.map((request) => request.url.pathname))].sort(), Object.keys(ROUTES).map((route) => `/api/v4.1${route}`).sort());
  assert.ok(api.requests.every((request) => request.url.searchParams.has("order") && request.url.searchParams.get("limit") === "100"));
});

test("the listing reads every page of 100 rows, in a stable order, to an empty page", async () => {
  const many = Array.from({ length: 230 }, (_unused, index) => ({
    id: `01J9FX00000000000000PL${String(index).padStart(4, "0")}`, title: `List ${index}`, predicate: "TRUE", is_enabled: true, priority: false, team_id: "01J9FX0000000000000000T001",
  }));
  const api = workspace({ playlists: many });
  const catalog = await scan(screenly, api.fetch, { credentials: CREDENTIALS });
  assert.equal(catalog.playlists.filter((playlist) => playlist.id.includes("PL0")).length, 230);
  const pages = api.requests.filter((request) => request.url.pathname === "/api/v4.1/playlists").map((request) => [request.url.searchParams.get("offset"), request.url.searchParams.get("order")]);
  assert.deepEqual(pages, [["0", "id"], ["100", "id"], ["200", "id"], ["230", "id"]]);
});

test("a server that returns fewer rows than the limit is read to the end all the same", async () => {
  const many = Array.from({ length: 230 }, (_unused, index) => ({
    id: `01J9FX00000000000000PL${String(index).padStart(4, "0")}`, title: `List ${index}`, predicate: "TRUE", is_enabled: true, priority: false, team_id: "01J9FX0000000000000000T001",
  }));
  const inner = workspace({ playlists: many });
  const capped = router(async (request) => {
    const response = await inner.fetch(request.url.href, { method: request.method, headers: request.headers });
    if (request.url.pathname !== "/api/v4.1/playlists") return response;
    return Response.json(((await response.json()) as unknown[]).slice(0, 50));
  });
  const catalog = await scan(screenly, capped.fetch, { credentials: CREDENTIALS });
  assert.equal(catalog.playlists.filter((playlist) => playlist.id.includes("PL0")).length, 230);
});

test("every reason an asset, a playlist or a rule is listed is the one the fixture expects", async () => {
  const catalog = await scan(screenly, workspace().fetch, { credentials: CREDENTIALS });
  const reasons = catalog.not_imported.map((entry) => [entry.kind, entry.name, entry.reason]);
  assert.deepEqual(reasons, [
    ["item", "Lobby camera", "It is a live stream."],
    ["item", "Weather app", "It is a Screenly Edge App."],
    ["media", "Still processing", "Screenly has not finished processing it."],
    ["media", "Handbook", "It is a PDF document, which is not an image, video or audio file."],
    ["schedule", "Night", "Its time window ends before it starts."],
    ["schedule", "Switched off", "The playlist is switched off in Screenly, so its labels play nothing."],
    ["schedule", "Odd rule", "Its time rule uses an operator other than BETWEEN, >= or <=."],
  ]);
  assert.equal(catalog.not_imported[0]!.next, "Add the stream address as a stream page in a playlist.");
  const lobby = catalog.playlists.find((playlist) => playlist.name === "Lobby loop")!;
  assert.deepEqual(lobby.notes, ["1 item was left out because its asset is listed under Cannot come over."]);
  assert.deepEqual(catalog.playlists.find((playlist) => playlist.name === "Switched off")!.notes, ["It was switched off in Screenly."]);
});

test("a screen's own label stays with the screen, every other label is a group, and the all-screens label reaches every screen", async () => {
  const catalog = await scan(screenly, workspace().fetch, { credentials: CREDENTIALS });
  assert.deepEqual(catalog.groups.map((group) => group.name), ["All screens", "Lobby screens"]);
  const byName = new Map(catalog.screens.map((screen) => [screen.name, screen]));
  assert.equal(byName.get("Front desk")!.group_ids.length, 2);
  assert.equal(byName.get("Cafe wall")!.group_ids.length, 1);
  const own = catalog.schedules.filter((schedule) => schedule.targets.screen_ids.length > 0);
  assert.deepEqual(own.map((schedule) => schedule.name).sort(), ["Either or (1)", "Either or (2)", "Evening", "Not Tuesday"]);
});

test("an always-on playlist is the screen's default, and several play as one combined playlist in name order", async () => {
  const catalog = await scan(screenly, workspace().fetch, { credentials: CREDENTIALS });
  const cafe = catalog.screens.find((screen) => screen.name === "Cafe wall")!;
  const combined = catalog.playlists.find((playlist) => "playlist_id" in (cafe.content ?? {}) && playlist.id === (cafe.content as { playlist_id: string }).playlist_id)!;
  assert.equal(combined.name, "Cafe loop + Lobby loop");
  assert.deepEqual(combined.items.map((item) => ("playlist_id" in item ? catalog.playlists.find((playlist) => playlist.id === item.playlist_id)!.name : "?")), ["Cafe loop", "Lobby loop"]);
  assert.match(combined.notes[0]!, /in an order it does not publish/);
  const front = catalog.screens.find((screen) => screen.name === "Front desk")!;
  assert.equal(catalog.playlists.find((playlist) => playlist.id === (front.content as { playlist_id: string }).playlist_id)!.name, "Lobby loop");
  assert.ok(!catalog.schedules.some((schedule) => schedule.name === "Lobby loop" || schedule.name === "Cafe loop"), "always-on playlists make no campaign");
});

test("media come from the processed address, which is another origin and carries no token", async () => {
  const api = workspace();
  const session = await open(screenly, api.fetch, { credentials: CREDENTIALS });
  const catalog = await session.scan();
  const welcome = catalog.media.find((item) => item.name === "Welcome")!;
  assert.equal(welcome.filename, "Welcome.png");
  const dir = await testTemp("screenly-media-");
  try {
    const download = router(async (request) => {
      assert.equal(request.headers.authorization, undefined, "the token never leaves api.screenlyapp.com");
      return new Response(Buffer.from("picture bytes"));
    });
    const other = await open(screenly, download.fetch, { credentials: CREDENTIALS });
    const target = path.join(dir, "welcome");
    assert.deepEqual(await other.fetchMedia(welcome, target), { bytes: 13 });
    assert.equal((await readFile(target)).toString(), "picture bytes");
    assert.equal(download.requests[0]!.url.href, "https://assets.example.com/screenly/welcome");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a refused token is vendor_refused and names the variable, never the value", async () => {
  const api = router(async () => Response.json({ message: `token ${TOKEN} is not valid` }, { status: 401 }));
  const refused = await problemOf(scan(screenly, api.fetch, { credentials: CREDENTIALS }));
  assert.equal(refused.code, "vendor_refused");
  assert.match(refused.detail, /Check SCREENLY_API_TOKEN/);
  assert.ok(!refused.detail.includes(TOKEN));
  const gone = await problemOf(scan(screenly, router(async () => new Response("no", { status: 404 })).fetch, { credentials: CREDENTIALS }));
  assert.equal(gone.code, "vendor_not_found");
  const wrong = await problemOf(scan(screenly, router(async () => Response.json({ rows: [] })).fetch, { credentials: CREDENTIALS }));
  assert.equal(wrong.code, "vendor_bad_response");
  assert.match(wrong.detail, /\/assets did not answer with a list/);
});

// ---- the predicate reference, clause by clause

const HOUR = 3_600_000;
const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

test("predicates: TRUE and an empty rule always play; weekdays, times and dates join with AND", () => {
  assert.deepEqual(parsePredicate("TRUE"), { ok: true, terms: [{}] });
  assert.deepEqual(parsePredicate(""), { ok: true, terms: [{}] });
  assert.deepEqual(parsePredicate(null), { ok: true, terms: [{}] });
  assert.deepEqual(parsePredicate("TRUE AND ($WEEKDAY IN {0, 1, 2, 3, 4}) AND ($TIME BETWEEN {28800000, 61200000})"), { ok: true, terms: [{ days: [0, 1, 2, 3, 4], lo: 8 * HOUR, hi: 17 * HOUR }] });
  assert.deepEqual(parsePredicate(`TRUE AND ($DATE >= ${day("2026-12-01")}) AND ($DATE <= ${day("2026-12-31")})`), { ok: true, terms: [{ dlo: day("2026-12-01"), dhi: day("2026-12-31") }] });
  assert.deepEqual(parsePredicate(`$DATE = ${day("2026-01-01")}`), { ok: true, terms: [{ dlo: day("2026-01-01"), dhi: day("2026-01-01") }] });
  assert.deepEqual(parsePredicate("$TIME >= 64800000 AND $TIME <= 79200000"), { ok: true, terms: [{ lo: 18 * HOUR, hi: 22 * HOUR }] });
  assert.deepEqual(parsePredicate("$weekday in {6}"), { ok: true, terms: [{ days: [6] }] });
});

test("predicates: NOT IN is the other days, AND binds tighter than OR, and an alternative that always holds wins", () => {
  assert.deepEqual(parsePredicate("$WEEKDAY NOT IN {5, 6}"), { ok: true, terms: [{ days: [0, 1, 2, 3, 4] }] });
  assert.deepEqual(parsePredicate("NOT $WEEKDAY IN {5, 6}"), { ok: true, terms: [{ days: [0, 1, 2, 3, 4] }] });
  assert.deepEqual(parsePredicate("NOT ($WEEKDAY IN {5, 6})"), { ok: true, terms: [{ days: [0, 1, 2, 3, 4] }] });
  assert.deepEqual(parsePredicate("$WEEKDAY IN {5} OR $WEEKDAY IN {1} AND $TIME >= 3600000"), { ok: true, terms: [{ days: [5] }, { days: [1], lo: HOUR }] });
  assert.deepEqual(parsePredicate("FALSE OR ($WEEKDAY IN {5})"), { ok: true, terms: [{ days: [5] }] });
  assert.deepEqual(parsePredicate("$WEEKDAY IN {5} OR TRUE"), { ok: true, terms: [{}] });
  assert.deepEqual(parsePredicate("($WEEKDAY IN {0, 1}) AND ($WEEKDAY IN {1, 2})"), { ok: true, terms: [{ days: [1] }] });
  assert.deepEqual(parsePredicate("$WEEKDAY IN {0, 1, 2, 3, 4, 5, 6}"), { ok: true, terms: [{}] });
});

test("predicates: a form the reference does not list is refused with its reason, never guessed", () => {
  const refused = (text: string): string => {
    const result = parsePredicate(text);
    assert.equal(result.ok, false, text);
    return (result as { reason: string }).reason;
  };
  assert.match(refused("$TIME < 3600000"), /operator other than BETWEEN, >= or <=/);
  assert.match(refused(`$DATE < ${day("2026-01-01")}`), /operator other than <=, = or >=/);
  assert.match(refused("NOT ($TIME >= 3600000)"), /negates something other than a weekday list/);
  assert.match(refused("$WEEKDAY IN {7}"), /outside 0 \(Monday\) to 6 \(Sunday\)/);
  assert.match(refused("$NOW > 5"), /does not read/);
  assert.match(refused("$WEEKDAY IN {1"), /does not read/);
  assert.match(refused("$TIME BETWEEN {1}"), /exactly a start and an end/);
  assert.match(refused("TRUE AND @"), /does not read/);
  assert.match(refused("FALSE"), /never true/);
  assert.match(refused(`$DATE >= ${day("2026-12-01")} AND $DATE <= ${day("2026-11-01")}`), /never true/);
  assert.match(refused("$WEEKDAY IN {1} AND $WEEKDAY IN {2}"), /never true/);
});

test("timing: dates alone are bounds, weekdays and hours are weekly windows, and a window may run to midnight", () => {
  const today = "2026-10-28";
  assert.deepEqual(termTiming({}, today), { ok: true, schedule: { always: true }, notes: [] });
  assert.deepEqual(termTiming({ dlo: day("2026-12-24"), dhi: day("2026-12-31") }, today), { ok: true, schedule: { start: "2026-12-24T00:00", end: "2027-01-01T00:00" }, notes: [] });
  assert.deepEqual(termTiming({ dhi: day("2026-12-31") }, today), { ok: true, schedule: { end: "2027-01-01T00:00" }, notes: [] });
  assert.deepEqual(termTiming({ dlo: day("2026-12-24") }, today), { ok: true, schedule: { start: "2026-12-24T00:00" }, notes: [] });
  assert.deepEqual(termTiming({ days: [0, 4], lo: 9 * HOUR, hi: 17 * HOUR }, today), {
    ok: true, schedule: { start: "2026-10-28T09:00", end: "2026-10-28T17:00", repeat: { every: "week", weekdays: ["mon", "fri"] } }, notes: [],
  });
  assert.deepEqual(termTiming({ lo: 18 * HOUR }, today), { ok: true, schedule: { start: "2026-10-28T18:00", end: "2026-10-29T00:00", repeat: { every: "day" } }, notes: [] });
  assert.deepEqual(termTiming({ hi: 6 * HOUR }, today), { ok: true, schedule: { start: "2026-10-28T00:00", end: "2026-10-28T06:00", repeat: { every: "day" } }, notes: [] });
  assert.deepEqual(termTiming({ days: [5, 6], dlo: day("2026-11-07"), dhi: day("2026-12-20") }, today), {
    ok: true, schedule: { start: "2026-11-07T00:00", end: "2026-11-08T00:00", repeat: { every: "week", weekdays: ["sat", "sun"], until: "2026-12-20" } }, notes: [],
  });
  // Weekdays alone run midnight to the next midnight on those days.
  assert.deepEqual(termTiming({ days: [0, 1, 2, 3, 4] }, today), {
    ok: true, schedule: { start: "2026-10-28T00:00", end: "2026-10-29T00:00", repeat: { every: "week", weekdays: ["mon", "tue", "wed", "thu", "fri"] } }, notes: [],
  });
  assert.deepEqual(termTiming({ lo: 22 * HOUR, hi: 7 * HOUR }, today), { ok: false, reason: "Its time window ends before it starts." });
  assert.deepEqual(termTiming({ lo: 9 * HOUR, hi: 9 * HOUR }, today), { ok: false, reason: "Its time window is shorter than a minute." });
  const rounded = termTiming({ lo: 9 * HOUR + 30_000, hi: 17 * HOUR + 30_000 }, today);
  assert.deepEqual(rounded.ok && rounded.schedule.start, "2026-10-28T09:00");
  assert.deepEqual(rounded.ok && rounded.schedule.end, "2026-10-28T17:01");
  assert.deepEqual(rounded.ok && rounded.notes, ["Its times were rounded outward to the minute."]);
  const local = termTiming({ dlo: day("2026-12-24") + 5 * HOUR }, today);
  assert.deepEqual(local.ok && local.schedule.start, "2026-12-24T00:00");
  assert.match((local.ok && local.notes[0]) || "", /nearest the stamp/);
});

// ---- through the command, the way an agent runs it

test("migrate scan --from screenly prints what comes over and what does not, and writes only scan.json", async () => {
  const configDir = await testTemp("screenly-cfg-");
  const cwd = await testTemp("screenly-cwd-");
  try {
    const project = fakeProject();
    const h = await harness(project, configDir, cwd);
    const api = workspace();
    const result = await h.invoke(["migrate", "scan", "--from", "screenly"], { env: CREDENTIALS, vendorFetch: api.fetch });
    assert.equal(result.code, 0, result.stdout);
    const report = result.json.data;
    assert.equal(report.vendor, "screenly");
    assert.deepEqual(report.found, { media: 3, playlists: 11, layouts: 0, schedules: 6, groups: 2, screens: 3 });
    // Night is refused by the adapter, so Either or counts twice here: five of the six rules come over.
    assert.equal(report.importable.schedules, 6, JSON.stringify(report.not_imported));
    assert.equal(report.importable.media, 3);
    assert.deepEqual(report.not_imported.map((entry: { name: string }) => entry.name), ["Lobby camera", "Weather app", "Still processing", "Handbook", "Night", "Switched off", "Odd rule"]);
    const lossy = report.lossy.map((entry: { name: string; change: string }) => `${entry.name}: ${entry.change}`);
    // A rule on weekdays alone is exactly a whole day on those days: the campaign changes nothing, so it says nothing.
    assert.ok(!lossy.some((line: string) => /^Not Tuesday: .*(no end time|24 hours)/.test(line)), lossy.join("\n"));
    const alongside = "In Screenly it played alongside the screen's other playlists during its hours; the campaign shows it instead of them.";
    assert.ok(lossy.includes(`Not Tuesday: ${alongside}`), lossy.join("\n"));
    assert.ok(lossy.includes(`Evening: ${alongside}`));
    assert.ok(!lossy.some((line: string) => line.startsWith("Holiday") && line.includes("alongside")), "a priority playlist replaces the others, as a campaign does: no note");
    assert.ok(lossy.includes("Either or (1): Its rule had several alternatives; each became its own campaign."));
    assert.ok(lossy.includes("Cafe loop + Lobby loop: Screenly plays every active playlist of a screen one after another, in an order it does not publish; this one plays Cafe loop, Lobby loop in that order."));
    assert.ok(report.notes.some((note: string) => /No time zone was known for 1 screen/.test(note)));
    assert.ok(!result.stdout.includes(TOKEN), "the token is never printed");
    assert.equal(project.transport.calls.length, 0, "nothing reached screenRIG");
    const scan = JSON.parse(await readFile(path.join(cwd, "screenrig-migration-screenly", "scan.json"), "utf8"));
    assert.equal(scan.account, "01J9FX0000000000000000T001");
    assert.ok(!JSON.stringify(scan).includes(TOKEN));
    assert.equal(NOW.toISOString().slice(0, 10), "2026-10-28");
    const refused = await h.invoke(["migrate", "scan", "--from", "screenly", "--dir", "refused"], { env: { SCREENLY_API_TOKEN: "wrong-token" }, vendorFetch: api.fetch });
    assert.equal(refused.code, 3);
    assert.equal(refused.json.error.code, "vendor_refused");
    assert.ok(!refused.stdout.includes("wrong-token"));
    const flag = await h.invoke(["migrate", "scan", "--from", "screenly", "--url", "https://x.example.com", "--dir", "flag"], { env: CREDENTIALS, vendorFetch: api.fetch });
    assert.equal(flag.code, 2);
    assert.match(flag.json.error.detail, /Screenly does not take --url\. Screenly takes no vendor flags; it reads SCREENLY_API_TOKEN \(required, secret\)/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
