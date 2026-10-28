import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { testTemp } from "../../test-temp.js";
import { harness, fakeProject } from "../project-fake.test.js";
import type { SourceCatalog } from "../types.js";
import { fixture, open, problemOf, router, scan, type Recorded } from "./more-helpers.test.js";
import { screencloud, zoneRects } from "./screencloud.js";

const TOKEN = "fixture-token";
const CREDENTIALS = { SCREENCLOUD_API_TOKEN: TOKEN };
const EU = "https://graphql.eu.screencloud.com/graphql";

interface Page {
  data: Record<string, { pageInfo: { endCursor: string | null } }>;
}

/** The fixture organisation. Each connection is a list of pages; a request's `after` cursor picks the page after the one that ended there. */
function studio(options: { errors?: unknown[]; host?: string } = {}) {
  return router(async (request: Recorded) => {
    const host = options.host ?? EU;
    if (request.url.href !== host) return new Response("not here", { status: 404 });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return Response.json({ errors: [{ message: `token ${TOKEN} refused`, extensions: { code: "UNAUTHENTICATED" } }], data: null });
    if (options.errors) return Response.json({ errors: options.errors, data: null });
    const body = JSON.parse(request.body ?? "{}") as { query: string; variables?: { after?: string | null; first?: number } };
    if (/currentOrgId/.test(body.query)) return Response.json(await fixture("screencloud", "currentOrgId"));
    const field = /\{ (all\w+)\(first/.exec(body.query)?.[1];
    if (!field) return new Response("bad query", { status: 400 });
    const pages = await fixture<Page[]>("screencloud", field);
    const after = body.variables?.after ?? null;
    const index = after === null ? 0 : pages.findIndex((page) => page.data[field]!.pageInfo.endCursor === after) + 1;
    return Response.json(pages[index]);
  });
}

test("the organisation becomes media, playlists, layouts, groups and waiting screens, exactly as the fixture says", async () => {
  const api = studio();
  const catalog = await scan(screencloud, api.fetch, { region: "eu", credentials: CREDENTIALS });
  assert.deepEqual(catalog, await fixture<SourceCatalog>("screencloud", "catalog.expected"));
  assert.ok(api.requests.every((request) => request.method === "POST" && request.url.href === EU && request.headers.authorization === `Bearer ${TOKEN}`));
});

test("connections are read page by page, following each end cursor", async () => {
  const api = studio();
  await scan(screencloud, api.fetch, { region: "eu", credentials: CREDENTIALS });
  const cursors = (field: string): Array<string | null> => api.requests
    .map((request) => JSON.parse(request.body!) as { query: string; variables: { after: string | null; first: number } })
    .filter((body) => body.query.includes(`${field}(first`))
    .map((body) => body.variables.after);
  assert.deepEqual(cursors("allFiles"), [null, "cursor-files-1"]);
  assert.deepEqual(cursors("allScreens"), [null, "cursor-screens-1"]);
  assert.deepEqual(cursors("allChannels"), [null]);
  const sizes = api.requests.map((request) => (JSON.parse(request.body!) as { variables: { first?: number } }).variables.first);
  assert.ok(sizes.every((size) => size === undefined || size === 100));
});

test("the US region reads the US host", async () => {
  const us = "https://graphql.us.screencloud.com/graphql";
  const catalog = await scan(screencloud, studio({ host: us }).fetch, { region: "us", credentials: CREDENTIALS });
  assert.equal(catalog.label, "ScreenCloud (US)");
  assert.equal(catalog.account, "0a000000-0000-4000-8000-000000000001");
});

test("ScreenCloud has no schedule object, and every rule on an item is listed on its channel or playlist", async () => {
  const catalog = await scan(screencloud, studio().fetch, { region: "eu", credentials: CREDENTIALS });
  assert.deepEqual(catalog.schedules, []);
  const rules = catalog.not_imported.filter((entry) => entry.kind === "schedule");
  assert.deepEqual(rules.map((entry) => [entry.name, entry.reason]), [
    ["Lobby loop (1 item)", "Its items carry time, weekday or date rules, which do not come over: they play whenever the playlist plays."],
    ["Lobby channel (1 item)", "Its items carry time, weekday or date rules, which do not come over: they play whenever the channel plays."],
  ]);
  for (const rule of rules) {
    assert.match(rule.next ?? "", /campaign create/);
    assert.match(rule.next ?? "", /visibility/);
  }
});

test("drafts, deleted files and the built-in blank channel are left out; what cannot come over is listed with its reason", async () => {
  const catalog = await scan(screencloud, studio().fetch, { region: "eu", credentials: CREDENTIALS });
  assert.ok(!catalog.playlists.some((playlist) => playlist.name.includes("draft")));
  assert.ok(!catalog.layouts.some((layout) => layout.name.includes("draft") || layout.name === "Blank"));
  assert.ok(!catalog.media.some((item) => item.name === "Old.png"), "a file in the recycle bin");
  assert.deepEqual(catalog.not_imported.filter((entry) => entry.kind !== "schedule").map((entry) => [entry.kind, entry.name, entry.reason]), [
    ["media", "Handbook.pdf", "It is not an image, video or audio file."],
    ["media", "NoAddress.png", "ScreenCloud gave no address for the file."],
    ["item", "Lobby loop: app 77000000", "A ScreenCloud app is not media, a web link or a playlist."],
  ]);
  assert.deepEqual(catalog.notes, ["ScreenCloud's built-in blank and splash channels are not imported."]);
  const lobby = catalog.layouts.find((layout) => layout.name === "Lobby channel")!;
  assert.deepEqual(lobby.notes, [
    "Its hidden zone held 1 item, which does not come over.",
    "1 audio file is not played: audio comes over only as a playlist's soundtrack, not inside a layout.",
  ]);
  const unplaced = catalog.layouts.find((layout) => layout.name === "No layout")!;
  assert.equal(unplaced.notes.length, 2);
  assert.match(unplaced.notes[0]!, /could not be read from the layout, so it fills the screen/);
  assert.deepEqual(catalog.screens.find((screen) => screen.name === "Hall")!.notes, ["It showed an app, which does not come over."]);
});

test("durations are milliseconds, 0 means the default of the kind, and a video keeps its own length", async () => {
  const catalog = await scan(screencloud, studio().fetch, { region: "eu", credentials: CREDENTIALS });
  const loop = catalog.playlists.find((playlist) => playlist.name === "Lobby loop")!;
  assert.deepEqual(loop.items.filter((item) => "media_id" in item || "url" in item).map((item) => ("duration_s" in item ? item.duration_s : null)), [10, null, 60, null, 12, null]);
  const side = catalog.layouts.find((layout) => layout.name === "Lobby channel")!.zones.find((zone) => zone.name === "Sidebar Zone")!;
  assert.deepEqual(side.items.map((item) => ("duration_s" in item ? item.duration_s : null)), [30, null, 4]);
});

test("a file is downloaded from its own address, which carries no token; only a processed copy is not the original", async () => {
  const catalog = await scan(screencloud, studio().fetch, { region: "eu", credentials: CREDENTIALS });
  const original = catalog.media.find((item) => item.name === "Welcome.png")!;
  const processed = catalog.media.find((item) => item.name === "Banner.jpg")!;
  assert.equal(original.original, true);
  assert.equal(original.bytes, 2048);
  assert.equal(processed.original, false);
  assert.equal(processed.bytes, undefined);
  const dir = await testTemp("screencloud-media-");
  try {
    const download = router(async (request) => {
      assert.equal(request.headers.authorization, undefined);
      return new Response(Buffer.from("fixture bytes"));
    });
    const session = await open(screencloud, download.fetch, { region: "eu", credentials: CREDENTIALS });
    assert.deepEqual(await session.fetchMedia(original, path.join(dir, "welcome")), { bytes: 13 });
    assert.equal((await readFile(path.join(dir, "welcome"))).toString(), "fixture bytes");
    assert.equal(download.requests[0]!.url.href, "https://files.example.com/screencloud/welcome.png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a GraphQL answer with errors is a refusal for an authentication code, and a bad response for any other, never echoing a message", async () => {
  const refused = await problemOf(scan(screencloud, studio().fetch, { region: "eu", credentials: { SCREENCLOUD_API_TOKEN: "wrong-token" } }));
  assert.equal(refused.code, "vendor_refused");
  assert.match(refused.detail, /Check SCREENCLOUD_API_TOKEN/);
  assert.ok(!refused.detail.includes("wrong-token"));
  const other = await problemOf(scan(screencloud, studio({ errors: [{ message: `query failed for ${TOKEN}`, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }).fetch, { region: "eu", credentials: CREDENTIALS }));
  assert.equal(other.code, "vendor_bad_response");
  assert.ok(!other.detail.includes(TOKEN));
  const http401 = await problemOf(scan(screencloud, router(async () => new Response("no", { status: 401 })).fetch, { region: "eu", credentials: CREDENTIALS }));
  assert.equal(http401.code, "vendor_refused");
  const shape = await problemOf(scan(screencloud, router(async (request) => (/currentOrgId/.test(request.body!) ? Response.json({ data: { currentOrgId: "org" } }) : Response.json({ data: { allFiles: { nodes: [] } } }))).fetch, { region: "eu", credentials: CREDENTIALS }));
  assert.equal(shape.code, "vendor_bad_response");
  assert.match(shape.detail, /allFiles\.nodes or allFiles\.pageInfo is missing/);
});

test("zone rectangles are read from the layout CSS in vw, vh, percent and pixels", () => {
  const rects = zoneRects("<style>/* two */ #zone1 { position: absolute; width: 70vw; height: 100vh; top: 0; left: 0; z-index: 10; } #zone2{width:25%;height:50%;top:10%;left:75%;z-index:5} #zone3 { width: 300px; height: 200px; top: 20px; left: 40px } #zone4 { width: calc(50% - 10px); height: 10px }</style>", 2000, 1000);
  assert.deepEqual([...rects], [
    ["zone1", { x: 0, y: 0, width: 1400, height: 1000, z: 10 }],
    ["zone2", { x: 1500, y: 100, width: 500, height: 500, z: 5 }],
    ["zone3", { x: 40, y: 20, width: 300, height: 200, z: 0 }],
  ]);
  assert.equal(zoneRects("", 1920, 1080).size, 0);
});

test("migrate scan --from screencloud needs --region and a token, and prints the report without a token", async () => {
  const configDir = await testTemp("screencloud-cfg-");
  const cwd = await testTemp("screencloud-cwd-");
  try {
    const project = fakeProject();
    const h = await harness(project, configDir, cwd);
    const api = studio();
    const result = await h.invoke(["migrate", "scan", "--from", "screencloud", "--region", "eu"], { env: CREDENTIALS, vendorFetch: api.fetch });
    assert.equal(result.code, 0, result.stdout);
    const report = result.json.data;
    assert.deepEqual(report.found, { media: 4, playlists: 3, layouts: 4, schedules: 0, groups: 4, screens: 5 });
    assert.equal(report.importable.layouts, 4, JSON.stringify(report.not_imported));
    assert.ok(report.lossy.some((entry: { name: string; change: string }) => entry.name === "Banner.jpg" && /re-encoded copy/.test(entry.change)));
    assert.ok(report.lossy.some((entry: { name: string; change: string }) => entry.name === "Lobby channel" && /advances together with the main zone/.test(entry.change)));
    assert.ok(report.notes.some((note: string) => /No time zone was known for 2 screens/.test(note)));
    assert.ok(!result.stdout.includes(TOKEN));
    assert.equal(project.transport.calls.length, 0);
    const noRegion = await h.invoke(["migrate", "scan", "--from", "screencloud", "--dir", "none"], { env: CREDENTIALS, vendorFetch: api.fetch });
    assert.equal(noRegion.code, 2);
    assert.match(noRegion.json.error.detail, /ScreenCloud needs --region/);
    const badRegion = await h.invoke(["migrate", "scan", "--from", "screencloud", "--region", "asia", "--dir", "none"], { env: CREDENTIALS, vendorFetch: api.fetch });
    assert.match(badRegion.json.error.detail, /--region asia is not one of eu, us/);
    const noToken = await h.invoke(["migrate", "scan", "--from", "screencloud", "--region", "eu", "--dir", "none"], { vendorFetch: api.fetch });
    assert.match(noToken.json.error.detail, /ScreenCloud needs SCREENCLOUD_API_TOKEN/);
    const wrong = await h.invoke(["migrate", "scan", "--from", "screencloud", "--region", "eu", "--dir", "wrong"], { env: { SCREENCLOUD_API_TOKEN: "wrong-token" }, vendorFetch: api.fetch });
    assert.equal(wrong.code, 3);
    assert.ok(!wrong.stdout.includes("wrong-token"));
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
