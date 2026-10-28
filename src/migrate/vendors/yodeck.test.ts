import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CliError } from "../../problems.js";
import { testTemp } from "../../test-temp.js";
import { createVendorHttp } from "../http.js";
import { fakeProject, harness } from "../project-fake.test.js";
import type { SourceCatalog, SourceMedia } from "../types.js";
import { yodeck } from "./yodeck.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/migrate/yodeck/", import.meta.url));
const API = "https://app.yodeck.com";
const TOKEN = "fixture-label:fixture-token";
const NOW = new Date("2026-10-28T10:00:00.000Z");
const LISTS: Record<string, string> = {
  "/api/v2/media/": "media.json",
  "/api/v2/playlists/": "playlists.json",
  "/api/v2/layouts/": "layouts.json",
  "/api/v2/schedules/": "schedules.json",
  "/api/v2/screens/": "screens.json",
};

interface Seen {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  authorization?: string;
  at: number;
}

interface RouterOptions {
  /** The most rows a page carries, whatever `limit` asks for. */
  cap?: number;
  /** Answer the first request 429 with this Retry-After. */
  throttleOnce?: number;
}

/** The fixture Yodeck: `Authorization: Token label:token`, limit/offset lists in the documented envelope, and file hosts of its own. */
function yodeck_(options: RouterOptions = {}) {
  const seen: Seen[] = [];
  const clock = { now: 0 };
  let throttled = false;
  const handler = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    seen.push({
      method: init?.method ?? "GET", url: url.toString(), path: url.pathname, query: Object.fromEntries(url.searchParams),
      ...(headers.authorization ? { authorization: headers.authorization } : {}), at: clock.now,
    });
    if (url.origin === "https://cdn.example.com" || url.origin === "https://assets.example.com") return new Response(`bytes of ${url.pathname}`);
    if (url.origin !== API) return new Response("wrong origin", { status: 502 });
    if (headers.authorization !== `Token ${TOKEN}`) return new Response(null, { status: 401 });
    if (options.throttleOnce !== undefined && !throttled) {
      throttled = true;
      return new Response(null, { status: 429, headers: { "retry-after": String(options.throttleOnce) } });
    }
    const file = LISTS[url.pathname];
    if (!file) return new Response("not found", { status: 404 });
    const name = url.pathname === "/api/v2/screens/" && url.searchParams.get("subset") === "basic" ? "screens-basic.json" : file;
    const rows = JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")) as unknown[];
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), options.cap ?? 2);
    const next = (to: number) => new URL(`${url.origin}${url.pathname}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), limit: String(limit), offset: String(to) })}`).toString();
    return Response.json({
      count: rows.length,
      next: offset + limit < rows.length ? next(offset + limit) : null,
      previous: offset > 0 ? next(Math.max(0, offset - limit)) : null,
      results: rows.slice(offset, offset + limit),
    });
  }) as typeof fetch;
  return { fetch: handler, seen, clock };
}

function session(router: ReturnType<typeof yodeck_>, token = TOKEN) {
  const http = createVendorHttp({
    vendor: "yodeck", name: "Yodeck", credentialNames: ["YODECK_API_TOKEN"], fetch: router.fetch,
    // Virtual time: a sleep moves the clock, and every request is stamped with it.
    sleep: async (ms) => {
      router.clock.now += ms;
    },
    now: () => router.clock.now,
  });
  return yodeck.open({ credentials: { YODECK_API_TOKEN: token }, http, now: () => NOW });
}

async function failure(work: Promise<unknown>): Promise<CliError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  throw new Error("expected a failure");
}

async function setup() {
  const configDir = await testTemp("yodeck-cfg-");
  const cwd = await testTemp("yodeck-cwd-");
  return { configDir, cwd, h: await harness(fakeProject(), configDir, cwd), cleanup: () => Promise.all([rm(configDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]) };
}

const lists = (router: ReturnType<typeof yodeck_>, list: string, subset?: string): Seen[] =>
  router.seen.filter((request) => request.path === `/api/v2/${list}/` && request.query.subset === subset);

test("a small account becomes the catalog in expected-catalog.json", async () => {
  const router = yodeck_();
  const catalog = await (await session(router)).scan();
  const expected = JSON.parse(await readFile(path.join(FIXTURES, "expected-catalog.json"), "utf8")) as SourceCatalog;
  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), expected);
});

test("lists are read to their count when the server caps the page, screens twice (what they show, then tags and time zone)", async () => {
  const router = yodeck_({ cap: 2 });
  const catalog = await (await session(router)).scan();
  assert.deepEqual(lists(router, "media").map((request) => request.query.offset), ["0", "2", "4", "6", "8", "10"]);
  assert.ok(lists(router, "media").every((request) => request.query.limit === "100"));
  assert.deepEqual(lists(router, "screens").map((request) => request.query.offset), ["0", "2", "4"]);
  assert.deepEqual(lists(router, "screens", "basic").map((request) => request.query.offset), ["0", "2", "4"]);
  assert.deepEqual(lists(router, "schedules").map((request) => request.query.offset), ["0", "2"]);
  assert.ok(router.seen.every((request) => request.authorization === `Token ${TOKEN}` || !request.url.startsWith(API)));
  const everything = yodeck_({ cap: 1000 });
  assert.deepEqual(await (await session(everything)).scan(), catalog, "the page size changes nothing");
  assert.equal(lists(everything, "media").length, 1);
});

test("requests stay inside 21 per 10 seconds, and a 429 with Retry-After is waited out", async () => {
  const router = yodeck_({ cap: 1 });
  await (await session(router)).scan();
  const at = router.seen.map((request) => request.at);
  assert.ok(at.length > 21, `the scan made ${at.length} requests`);
  for (let index = 21; index < at.length; index += 1) {
    assert.ok(at[index]! - at[index - 21]! >= 10_000, `request ${index} came ${at[index]! - at[index - 21]!} ms after request ${index - 21}`);
  }
  const throttled = yodeck_({ throttleOnce: 4 });
  const catalog = await (await session(throttled)).scan();
  assert.equal(catalog.media.length, 5);
  assert.equal(throttled.seen[1]!.at - throttled.seen[0]!.at >= 4000, true, "the retry waited for Retry-After");
});

test("a thumbnail is never used: an upload the API cannot hand out has no file to fetch", async () => {
  const router = yodeck_();
  const catalog = await (await session(router)).scan();
  const byId = (id: string) => catalog.media.find((media) => media.id === id)!;
  assert.equal(byId("11").fetch, undefined, "an uploaded image has no address");
  assert.equal(byId("14").fetch, undefined, "an uploaded audio file has no address");
  assert.deepEqual([byId("12").fetch, byId("12").original], [{ url: "https://cdn.example.com/yodeck/12/play.mp4" }, false], "a video comes from the copy Yodeck plays, and says so");
  assert.deepEqual([byId("13").fetch, byId("13").original], [{ url: "https://assets.example.com/logo.png" }, true], "an import from a web address comes from there");
  const text = JSON.stringify(catalog);
  assert.ok(!text.includes("thumbs.example.com") && !text.includes("shots.example.com"));
  assert.ok(router.seen.every((request) => !/thumbs|shots/.test(request.url)));
  const dir = await testTemp("yodeck-dl-");
  try {
    for (const id of ["12", "13"]) {
      const target = path.join(dir, id);
      await (await session(router)).fetchMedia(byId(id), target);
    }
    assert.equal(await readFile(path.join(dir, "12"), "utf8"), "bytes of /yodeck/12/play.mp4");
    assert.equal(await readFile(path.join(dir, "13"), "utf8"), "bytes of /logo.png");
    const downloads = router.seen.filter((request) => request.url.startsWith("https://cdn.example.com") || request.url.startsWith("https://assets.example.com"));
    assert.equal(downloads.length, 2);
    assert.ok(downloads.every((request) => request.authorization === undefined), "the token goes to Yodeck only");
    const file = { id: "x", name: "x", filename: "x", kind: "image" as const, original: true };
    const error = await failure((await session(router)).fetchMedia(file as SourceMedia, path.join(dir, "none")));
    assert.equal(error.problem.code, "vendor_bad_response");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the token is label:token, a pasted Token prefix is dropped, and a wrong one is vendor_refused without echoing it", async () => {
  for (const bad of ["", "nocolonsecret", "has space:secret1", ":secret2", "mylabel:"]) {
    const error = await failure(session(yodeck_(), bad));
    assert.equal(error.problem.code, "usage_error", JSON.stringify(bad));
    assert.match(error.problem.detail, /label:token/);
    assert.ok(!bad || !error.problem.detail.includes(bad));
  }
  const prefixed = await (await session(yodeck_(), `Token ${TOKEN}`)).scan();
  assert.equal(prefixed.media.length, 5);
  const router = yodeck_();
  const wrong = await failure((await session(router, "fixture-label:wrong-token")).scan());
  assert.equal(wrong.problem.code, "vendor_refused");
  assert.equal(wrong.exitCode, 3);
  assert.match(wrong.problem.detail, /Check YODECK_API_TOKEN/);
  assert.ok(!JSON.stringify(wrong.problem).includes("wrong-token"));
  assert.equal(router.seen.length, 1, "nothing else was asked after the refusal");
});

test("a schedule is shown by its screens: their default is its filler, and each event aims at them", async () => {
  const catalog = await (await session(yodeck_())).scan();
  const screen = (id: string) => catalog.screens.find((candidate) => candidate.id === id)!;
  assert.deepEqual(screen("62").content, { playlist_id: "31" }, "the filler of schedule 51");
  assert.equal(screen("63").content, undefined, "a filler that turns the screen off is no default");
  const events = catalog.schedules.filter((schedule) => schedule.id.startsWith("51:"));
  assert.ok(events.every((schedule) => schedule.targets.screen_ids.join() === "62" && schedule.targets.group_ids.length === 0));
  const byId = (id: string) => catalog.schedules.find((schedule) => schedule.id === id)!;
  // Minutes become the end; the Monday-first bit string becomes weekdays; a daily event with days chosen is weekly.
  assert.deepEqual([byId("51:1").start, byId("51:1").end, byId("51:1").repeat?.weekdays?.join()], ["2026-11-02T07:00", "2026-11-02T11:00", "mon,tue,wed,thu,fri"]);
  assert.deepEqual(byId("51:6").repeat, { every: "week", weekdays: ["mon", "sun"], until: "2026-12-31" });
  assert.deepEqual(byId("51:3").repeat, { every: "day", interval: 2, until: "2050-01-01", count: 10 });
  assert.equal(byId("51:3").end, "2026-11-10T19:30");
  // An event that shows one media is a playlist of one item.
  assert.deepEqual(byId("51:3").content, { playlist_id: "media:13" });
  assert.deepEqual(catalog.playlists.find((playlist) => playlist.id === "media:13")!.items, [{ media_id: "13" }]);
  assert.deepEqual(catalog.screens.find((candidate) => candidate.id === "65")!.content, { playlist_id: "media:15" });
  assert.equal(byId("51:2").repeat, undefined);
  assert.equal(byId("51:1").priority, 3);
});

test("a time zone is its area and place together, in the platform's spelling", async () => {
  const catalog = await (await session(yodeck_())).scan();
  const zone = (id: string) => catalog.screens.find((screen) => screen.id === id)!.timezone;
  assert.deepEqual(["61", "62", "63", "64", "65", "66"].map(zone), ["America/Toronto", "America/Phoenix", "UTC", undefined, undefined, "America/Los_Angeles"]);
  assert.match(catalog.screens.find((screen) => screen.id === "64")!.notes.join(" "), /Mars\/Olympus is not one this CLI knows/);
  assert.deepEqual(catalog.screens.find((screen) => screen.id === "65")!.notes, [], "a screen with no zone set says nothing");
});

test("the account is the lowest workspace id, so a workspace added later keeps the same directory", async () => {
  assert.equal((await (await session(yodeck_())).scan()).account, "yodeck:7");
});

test("an answer this adapter cannot use is vendor_bad_response, naming the path and never the body", async () => {
  const base = yodeck_();
  const make = (replace: (url: URL) => Response | undefined) => createVendorHttp({
    vendor: "yodeck", name: "Yodeck", credentialNames: [], sleep: async () => undefined, now: () => 0,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => replace(new URL(String(input))) ?? base.fetch(input, init)) as typeof fetch,
  });
  const open = (http: ReturnType<typeof make>) => yodeck.open({ credentials: { YODECK_API_TOKEN: TOKEN }, http, now: () => NOW });
  const noResults = await failure((await open(make((url) => (url.pathname === "/api/v2/media/" ? Response.json({ count: 1, detail: "do-not-echo" }) : undefined)))).scan());
  assert.equal(noResults.problem.code, "vendor_bad_response");
  assert.match(noResults.problem.detail, /GET \/media\/ has no results list/);
  assert.ok(!JSON.stringify(noResults.problem).includes("do-not-echo"));
  const noId = await failure((await open(make((url) => (url.pathname === "/api/v2/layouts/" ? Response.json({ count: 1, next: null, results: [{ name: "no id" }] }) : undefined)))).scan());
  assert.match(noId.problem.detail, /GET \/layouts\/ has a row without id/);
});

test("migrate scan --from yodeck: the token from the environment, originals from --files, and nothing secret written or printed", async () => {
  const t = await setup();
  try {
    const router = yodeck_();
    const env = { YODECK_API_TOKEN: TOKEN };
    const lone = await t.h.invoke(["migrate", "scan", "--from", "yodeck"], { env, vendorFetch: router.fetch });
    assert.equal(lone.code, 0, lone.stdout);
    const report = lone.json.data;
    assert.deepEqual(report.found, { media: 5, playlists: 5, layouts: 2, schedules: 7, groups: 2, screens: 6 });
    const reasons = (kind: string) => report.not_imported.filter((entry: { kind: string }) => entry.kind === kind).map((entry: { source_id: string; reason: string }) => [entry.source_id, entry.reason]);
    assert.deepEqual(reasons("media").map(([id]: string[]) => id), ["16", "17", "18", "19", "21", "11", "14"], "uploads Yodeck cannot hand out are listed after the ones it lists itself");
    const welcome = report.not_imported.find((entry: { source_id: string; kind: string }) => entry.kind === "media" && entry.source_id === "11");
    assert.equal(welcome.reason, "Yodeck does not hand out this file.");
    assert.equal(welcome.next, "Download Welcome.png from Yodeck into a folder and rerun migrate scan with --files DIR.");
    assert.ok(report.lossy.some((entry: { source_id: string; change: string }) => entry.source_id === "12" && /re-encoded copy/.test(entry.change)));
    assert.ok(report.not_imported.some((entry: { source_id: string; reason: string }) => entry.source_id === "51:5" && /by the month/.test(entry.reason)));
    assert.ok(report.not_imported.some((entry: { source_id: string; kind: string; reason: string }) => entry.kind === "playlist" && entry.source_id === "33" && /Nothing in it/.test(entry.reason)));
    assert.ok(report.notes.some((note: string) => /No time zone was known for 2 screens/.test(note)));
    assert.ok(!lone.stdout.includes("fixture-token"), "the token is never printed");
    const dir = path.join(t.cwd, "screenrig-migration-yodeck");
    const scanFile = await readFile(path.join(dir, "scan.json"), "utf8");
    assert.ok(!scanFile.includes("fixture-token") && !scanFile.includes("thumbs.example.com"));
    assert.equal((await stat(path.join(dir, "scan.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ["scan.json"]);

    // The originals the API never hands out come from --files, matched by name; a same-name original beats Yodeck's copy.
    const downloads = path.join(t.cwd, "downloads");
    await mkdir(downloads);
    for (const name of ["welcome.png", "THEME.MP3", "Promo.mp4"]) await writeFile(path.join(downloads, name), `bytes of ${name}`);
    const withFiles = await t.h.invoke(["migrate", "scan", "--from", "yodeck", "--files", downloads, "--timezone", "America/Toronto", "--dir", "with-files"], { env, vendorFetch: router.fetch });
    assert.equal(withFiles.code, 0, withFiles.stdout);
    assert.deepEqual(withFiles.json.data.not_imported.filter((entry: { kind: string }) => entry.kind === "media").map((entry: { source_id: string }) => entry.source_id), ["16", "17", "18", "19", "21"]);
    assert.ok(!withFiles.json.data.lossy.some((entry: { source_id: string }) => entry.source_id === "12"), "the original replaced the copy");
    assert.ok(!withFiles.json.data.notes.some((note: string) => /No time zone/.test(note)), "--timezone covers the screens that have none");
    const scan = JSON.parse(await readFile(path.join(t.cwd, "with-files", "scan.json"), "utf8"));
    assert.deepEqual(scan.catalog.media.map((media: { id: string; local?: string }) => [media.id, media.local]), [["11", "welcome.png"], ["12", "Promo.mp4"], ["13", undefined], ["14", "THEME.MP3"], ["20", undefined]]);

    const refused = await t.h.invoke(["migrate", "scan", "--from", "yodeck", "--dir", "refused"], { env: { YODECK_API_TOKEN: "fixture-label:wrong-token" }, vendorFetch: yodeck_().fetch });
    assert.equal(refused.code, 3);
    assert.equal(refused.json.error.code, "vendor_refused");
    assert.match(refused.json.error.detail, /Check YODECK_API_TOKEN/);
    assert.ok(!refused.stdout.includes("wrong-token"));
    const missing = await t.h.invoke(["migrate", "scan", "--from", "yodeck", "--dir", "missing"], { vendorFetch: yodeck_().fetch });
    assert.equal(missing.code, 2);
    assert.match(missing.json.error.detail, /Yodeck needs YODECK_API_TOKEN in the environment, or in a file passed with --credentials FILE/);
    const url = await t.h.invoke(["migrate", "scan", "--from", "yodeck", "--url", "https://example.com", "--dir", "url"], { env, vendorFetch: yodeck_().fetch });
    assert.match(url.json.error.detail, /Yodeck does not take --url/);
  } finally {
    await t.cleanup();
  }
});

test("the token can come from a --credentials file", async () => {
  const t = await setup();
  try {
    const file = path.join(t.cwd, "yodeck.env");
    await writeFile(file, `# read-only token\nYODECK_API_TOKEN="${TOKEN}"\nOTHER=ignored\n`);
    const result = await t.h.invoke(["migrate", "scan", "--from", "yodeck", "--credentials", file], { vendorFetch: yodeck_().fetch });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.json.data.found.media, 5);
  } finally {
    await t.cleanup();
  }
});

test("migrate vendors yodeck says what it takes and how to make the token", async () => {
  const t = await setup();
  try {
    const result = await t.h.invoke(["migrate", "vendors", "yodeck"]);
    assert.equal(result.code, 0);
    const [vendor] = result.json.data.vendors;
    assert.deepEqual(vendor.inputs.flags, [{ flag: "--timezone", required: false }, { flag: "--files", required: false }]);
    assert.deepEqual(vendor.inputs.env.map((entry: { name: string; secret: boolean; required: boolean }) => [entry.name, entry.secret, entry.required]), [["YODECK_API_TOKEN", true, true]]);
    assert.ok(vendor.connect.length >= 3 && vendor.maps.length > 0 && vendor.skips.length > 0 && vendor.docs.every((doc: string) => doc.startsWith("https://")));
    assert.match(vendor.example, /^screenrig migrate scan --from yodeck /);
  } finally {
    await t.cleanup();
  }
});

test("the example on migrate vendors runs as written", async () => {
  const t = await setup();
  try {
    await writeFile(path.join(t.cwd, "yodeck.env"), `YODECK_API_TOKEN=${TOKEN}\n`);
    await mkdir(path.join(t.cwd, "yodeck-downloads"));
    const result = await t.h.invoke(yodeck.example.split(" ").slice(1), { vendorFetch: yodeck_().fetch });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.json.data.vendor, "yodeck");
  } finally {
    await t.cleanup();
  }
});
