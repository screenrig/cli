import assert from "node:assert/strict";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CliError } from "../../problems.js";
import { testTemp } from "../../test-temp.js";
import { createVendorHttp } from "../http.js";
import { fakeProject, harness } from "../project-fake.test.js";
import type { SourceCatalog, SourceMedia } from "../types.js";
import { xibo } from "./xibo.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/migrate/xibo/", import.meta.url));
const ORIGIN = "https://cms.example.com";
const CLIENT_ID = "fixture-client";
const CLIENT_SECRET = "fixture-secret";
const NOW = new Date("2026-10-28T10:00:00.000Z");
const GRIDS: Record<string, string> = {
  "/api/library": "library.json",
  "/api/playlist": "playlist.json",
  "/api/layout": "layout.json",
  "/api/displaygroup": "displaygroup.json",
  "/api/display": "display.json",
  "/api/campaign": "campaign.json",
  "/api/schedule": "schedule.json",
};

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization?: string;
  body?: string;
}

interface RouterOptions {
  /** Every grid answers 401, whatever the token. */
  denyGrids?: boolean;
  /** The most rows a page carries, whatever `length` asks for. */
  cap?: number;
  /** Under a folder, as a CMS installed in a sub-directory. */
  prefix?: string;
  /** Downloads of this media id answer a redirect to another origin. */
  redirect?: string;
}

/** The fixture CMS: OAuth client credentials, bearer auth, paged grids and the library download route. */
function cms(options: RouterOptions = {}) {
  const seen: Seen[] = [];
  const prefix = options.prefix ?? "";
  let issued = 0;
  let valid = "";
  const handler = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    const body = typeof init?.body === "string" ? init.body : undefined;
    seen.push({
      method: init?.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams),
      ...(headers.authorization ? { authorization: headers.authorization } : {}), ...(body !== undefined ? { body } : {}),
    });
    if (url.origin === "https://cdn.example.com") return new Response("file from the cdn");
    if (url.origin !== ORIGIN) return new Response("wrong origin", { status: 502 });
    const route = url.pathname.slice(prefix.length);
    if (route === "/api/authorize/access_token") {
      const form = new URLSearchParams(body ?? "");
      if (init?.method !== "POST" || headers["content-type"] !== "application/x-www-form-urlencoded" || form.get("grant_type") !== "client_credentials"
        || form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
        return Response.json({ error: "invalid_client", error_description: `Client authentication failed for ${form.get("client_secret")}`, message: "Client authentication failed" }, { status: 401 });
      }
      issued += 1;
      valid = `fixture-token-${issued}`;
      // The documented answer, with a token that is new each time.
      return Response.json({ ...JSON.parse(await readFile(path.join(FIXTURES, "access_token.json"), "utf8")), access_token: valid });
    }
    if (headers.authorization !== `Bearer ${valid}`) return Response.json({ error: "access_denied", message: "Access token expired or malformed" }, { status: 401 });
    const grid = GRIDS[route];
    if (grid && options.denyGrids) return Response.json({ error: "access_denied", message: "Access token expired or malformed" }, { status: 401 });
    if (grid) {
      const rows = JSON.parse(await readFile(path.join(FIXTURES, grid), "utf8")) as unknown[];
      const start = Number(url.searchParams.get("start") ?? 0);
      const length = Math.min(Number(url.searchParams.get("length") ?? 10), options.cap ?? 2);
      return Response.json(rows.slice(start, start + length), { headers: { "X-Total-Count": String(rows.length) } });
    }
    const download = /^\/api\/library\/download\/(\d+)\/(\w+)$/.exec(route);
    if (download) {
      if (download[1] === options.redirect) return new Response(null, { status: 302, headers: { location: "https://cdn.example.com/files/redirected.png" } });
      return new Response(`bytes of ${download[1]} as ${download[2]}`);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    fetch: handler,
    seen,
    /** The current token stops working, as an hour-old one does. */
    expire(): void {
      valid = "expired";
    },
    get tokens(): number {
      return issued;
    },
  };
}

function session(router: ReturnType<typeof cms>, extra: { url?: string; timezone?: string } = {}) {
  const http = createVendorHttp({
    vendor: "xibo", name: "Xibo", credentialNames: ["XIBO_CLIENT_ID", "XIBO_CLIENT_SECRET"], fetch: router.fetch,
    sleep: async () => undefined, now: () => NOW.getTime(),
  });
  return xibo.open({
    url: extra.url ?? ORIGIN, ...(extra.timezone !== undefined ? { timezone: extra.timezone } : {}),
    credentials: { XIBO_CLIENT_ID: CLIENT_ID, XIBO_CLIENT_SECRET: CLIENT_SECRET }, http, now: () => NOW,
  });
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
  const configDir = await testTemp("xibo-cfg-");
  const cwd = await testTemp("xibo-cwd-");
  return { configDir, cwd, h: await harness(fakeProject(), configDir, cwd), cleanup: () => Promise.all([rm(configDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]) };
}

const gridRequests = (router: ReturnType<typeof cms>, grid: string): Seen[] => router.seen.filter((request) => request.path.endsWith(grid) && request.method === "GET");

test("a small account becomes the catalog in expected-catalog.json", async () => {
  const router = cms();
  const catalog = await (await session(router, { timezone: "America/Toronto" })).scan();
  const expected = JSON.parse(await readFile(path.join(FIXTURES, "expected-catalog.json"), "utf8")) as SourceCatalog;
  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), expected);
});

test("the token comes from client credentials in a form body, and every later request carries it", async () => {
  const router = cms();
  await (await session(router)).scan();
  const [first, ...rest] = router.seen;
  assert.equal(first!.method, "POST");
  assert.equal(first!.path, "/api/authorize/access_token");
  assert.equal(first!.authorization, undefined, "the token request carries no bearer");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(first!.body)), { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  assert.equal(router.tokens, 1);
  assert.ok(rest.every((request) => request.authorization === "Bearer fixture-token-1"));
});

test("a CMS that caps the page size is read to the end by X-Total-Count", async () => {
  const router = cms({ cap: 2 });
  const catalog = await (await session(router)).scan();
  const library = gridRequests(router, "/library");
  assert.deepEqual(library.map((request) => request.query.start), ["0", "2", "4"]);
  assert.ok(library.every((request) => request.query.length === "100"));
  assert.equal(gridRequests(router, "/schedule").length, 7, "14 events at 2 a page");
  assert.equal(catalog.media.length + catalog.not_imported.filter((entry) => entry.kind === "media").length, 6, "every library row was seen");
  assert.deepEqual(gridRequests(router, "/layout")[0]!.query.embed, "regions,playlists,widgets");
  assert.deepEqual(gridRequests(router, "/display")[0]!.query.embed, "displaygroups");
  assert.deepEqual(gridRequests(router, "/playlist")[0]!.query.embed, "widgets");
  assert.deepEqual(gridRequests(router, "/campaign")[0]!.query.embed, "layouts");
  const everything = cms({ cap: 1000 });
  const same = await (await session(everything)).scan();
  assert.deepEqual(same, catalog, "the page size changes nothing");
  assert.equal(gridRequests(everything, "/library").length, 1);
});

test("an event synced to the displays' zones is read in each display's zone; any other is read in the CMS zone, or UTC with a note when nothing is known", async () => {
  const withZone = (await (await session(cms(), { timezone: "America/Toronto" })).scan()).schedules;
  const without = (await (await session(cms())).scan()).schedules;
  const byId = (list: typeof withZone, id: string) => list.find((schedule) => schedule.id === id)!;
  // Synced to each display's zone (syncTimezone 1): one moment, two displays. 12:00 UTC is 07:00 in Toronto and 05:00 in Phoenix.
  const toronto = byId(without, "1@America/Toronto");
  const phoenix = byId(without, "1@America/Phoenix");
  assert.deepEqual([toronto.start, toronto.end, toronto.repeat?.until], ["2026-11-02T07:00", "2026-11-02T11:00", "2026-12-18"]);
  assert.deepEqual([phoenix.start, phoenix.end, phoenix.repeat?.until], ["2026-11-02T05:00", "2026-11-02T09:00", "2026-12-18"]);
  assert.deepEqual(toronto.targets, { group_ids: [], screen_ids: ["1"] });
  assert.deepEqual(phoenix.targets, { group_ids: [], screen_ids: ["2"] });
  assert.equal(toronto.priority, 10);
  assert.ok(toronto.notes.some((note) => /several time zones/.test(note)));
  // The default (syncTimezone 0) shows the CMS clock's digits and each display plays them on its own clock: read in the CMS zone,
  // kept as one schedule with its group, and with no zone of its own, so the report claims no change.
  assert.equal(byId(withZone, "3").start, "2026-11-03T09:00");
  assert.equal(byId(withZone, "3").timezone, undefined);
  assert.deepEqual(byId(withZone, "3").targets, { group_ids: ["601"], screen_ids: [] });
  assert.deepEqual(byId(withZone, "3").repeat, { every: "day", interval: 2 });
  assert.equal(byId(without, "3").start, "2026-11-03T14:00");
  assert.equal(byId(without, "3").timezone, undefined);
  assert.ok(byId(without, "3").notes.some((note) => /read as UTC.*--timezone/.test(note)));
  // A display with no zone takes the CMS zone, else UTC.
  assert.equal(byId(withZone, "12").start, "2026-11-04T04:00");
  assert.equal(byId(without, "12").start, "2026-11-04T09:00");
  assert.ok(byId(without, "12").notes.some((note) => /read as UTC/.test(note)));
  assert.ok(!byId(withZone, "12").notes.some((note) => /read as UTC/.test(note)));
  // A display's own zone never needs the note.
  assert.ok(!toronto.notes.some((note) => /read as UTC/.test(note)));
  // Always-on events have no times; a daypart other than always is taken as stored.
  assert.deepEqual([byId(withZone, "4").always, byId(withZone, "4").start, byId(withZone, "4").timezone], [true, undefined, undefined]);
  assert.ok(byId(withZone, "12").notes.some((note) => /daypart/.test(note)));
  assert.ok(!byId(withZone, "4").notes.some((note) => /daypart/.test(note)));
  // An always-on event that reaches displays in two zones has no times to read, so it is not split.
  assert.deepEqual(byId(withZone, "14").targets, { group_ids: ["601"], screen_ids: [] });
  assert.equal(without.filter((schedule) => schedule.id.startsWith("14")).length, 1);
});

test("on the default setting a 09:00 to 17:00 event plays 09:00 to 17:00 on every display, and the report claims no change", async () => {
  // The CMS is in Toronto and the display in Phoenix. Xibo shows the CMS clock's digits and the display plays them on its own clock.
  const base = cms();
  const event = {
    eventId: 40, name: "Office hours", eventTypeId: 1, campaignId: 501, displayGroups: [{ displayGroupId: 702, displayGroup: "Cafe wall", isDisplaySpecific: 1, isDynamic: 0 }],
    criteria: [], fromDt: 1793628000, toDt: 1793656800, isPriority: 0, recurrenceType: "Week", recurrenceDetail: 1, recurrenceRange: 1797656340,
    recurrenceRepeatsOn: "1,2,3,4,5", recurrenceMonthlyRepeatsOn: null, campaign: "Office hours", dayPartId: 2, isAlways: 0, isCustom: 1, syncTimezone: 0, maxPlaysPerHour: 0, isGeoAware: 0,
  };
  const only = (async (input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).pathname === "/api/schedule"
    ? Response.json([event], { headers: { "X-Total-Count": "1" } })
    : base.fetch(input, init))) as typeof fetch;
  const catalog = await (await session({ ...base, fetch: only }, { timezone: "America/Toronto" })).scan();
  const [schedule] = catalog.schedules;
  assert.deepEqual([catalog.schedules.length, schedule!.id, schedule!.start, schedule!.end, schedule!.timezone], [1, "40", "2026-11-02T09:00", "2026-11-02T17:00", undefined]);
  assert.deepEqual(schedule!.targets, { group_ids: [], screen_ids: ["2"] });
  assert.deepEqual(schedule!.notes, []);
  const t = await setup();
  try {
    const result = await t.h.invoke(["migrate", "scan", "--from", "xibo", "--url", ORIGIN, "--timezone", "America/Toronto"], {
      env: { XIBO_CLIENT_ID: CLIENT_ID, XIBO_CLIENT_SECRET: CLIENT_SECRET }, vendorFetch: only,
    });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.json.data.lossy.filter((entry: { kind: string; source_id: string }) => entry.kind === "schedule" && entry.source_id === "40"), []);
    assert.equal(result.json.data.importable.schedules, 1);
  } finally {
    await t.cleanup();
  }
});

test("every event that campaigns cannot express is listed with its reason", async () => {
  const listed = (await (await session(cms(), { timezone: "America/Toronto" })).scan()).not_imported.filter((entry) => entry.kind === "schedule");
  assert.deepEqual(listed.map((entry) => [entry.source_id, entry.reason]), [
    ["6", "Overlay events draw a layout over the one that is playing."],
    ["7", "It plays only inside a map area (geo-fencing), which campaigns cannot express."],
    ["8", "It has already ended."],
    ["9", "Media events show one library item full screen, and Xibo's API does not say which item."],
    ["10", "The layout it plays is retired in Xibo."],
    ["11", "It plays only while a condition holds (schedule criteria), which campaigns cannot express."],
    ["13", "It plays an ad campaign, which Xibo schedules by a target of plays, spend or impressions."],
  ]);
});

test("a 401 mid-run gets a fresh token and one more try; a refusal that persists is vendor_refused", async () => {
  const router = cms();
  const open = await session(router);
  await open.scan();
  assert.equal(router.tokens, 1);
  const before = router.seen.length;
  router.expire();
  const again = await open.scan();
  assert.equal(router.tokens, 2, "one renewal for the whole second scan");
  assert.equal(again.media.length, 3);
  const after = router.seen.slice(before);
  assert.equal(after.filter((request) => request.authorization === "Bearer fixture-token-1").length, 1, "only the first request of the second scan used the old token");
  assert.equal(after[1]!.path, "/api/authorize/access_token");
  assert.equal(after[1]!.authorization, undefined, "the renewal does not carry the expired token");
  assert.ok(after.slice(2).every((request) => request.authorization === "Bearer fixture-token-2"));

  const denied = cms({ denyGrids: true });
  const error = await failure((await session(denied)).scan());
  assert.equal(error.problem.code, "vendor_refused");
  assert.equal(error.exitCode, 3);
  assert.equal(denied.tokens, 2, "renewed once, then refused");
  assert.match(error.problem.detail, /Check XIBO_CLIENT_ID and XIBO_CLIENT_SECRET/);
});

test("a download carries the token, writes the file, renews an expired token, and sends no credential off the CMS", async () => {
  const dir = await testTemp("xibo-dl-");
  try {
    const router = cms({ redirect: "102" });
    const open = await session(router);
    const [image, video] = [{ id: "101", type: "image" }, { id: "102", type: "video" }].map((fetch): SourceMedia => ({ id: fetch.id, name: "x", filename: "x", kind: fetch.type as "image", fetch, original: true }));
    const target = path.join(dir, "one");
    const { bytes } = await open.fetchMedia(image!, target);
    assert.equal(await readFile(target, "utf8"), "bytes of 101 as image");
    assert.equal(bytes, "bytes of 101 as image".length);
    assert.equal(router.seen.at(-1)!.path, "/api/library/download/101/image");
    assert.equal(router.seen.at(-1)!.authorization, "Bearer fixture-token-1");
    router.expire();
    const renewed = path.join(dir, "two");
    await open.fetchMedia(image!, renewed);
    assert.equal(router.tokens, 2);
    assert.equal(await readFile(renewed, "utf8"), "bytes of 101 as image");
    const moved = path.join(dir, "three");
    await open.fetchMedia(video!, moved);
    assert.equal(await readFile(moved, "utf8"), "file from the cdn");
    const off = router.seen.filter((request) => request.path === "/files/redirected.png");
    assert.equal(off.length, 1);
    assert.equal(off[0]!.authorization, undefined, "the redirect target never sees the token");
    assert.deepEqual(await readdir(dir), ["one", "three", "two"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--url may name a folder or end in /api: the API is under the CMS address", async () => {
  for (const [url, account] of [["https://cms.example.com/xibo", "https://cms.example.com/xibo"], ["https://cms.example.com/xibo/api/", "https://cms.example.com/xibo"], ["https://cms.example.com/", "https://cms.example.com"]] as const) {
    const router = cms({ prefix: account.slice("https://cms.example.com".length) });
    const catalog = await (await session(router, { url })).scan();
    assert.equal(catalog.account, account);
    assert.ok(router.seen.every((request) => request.path.startsWith(`${account.slice("https://cms.example.com".length)}/api/`)), url);
    assert.equal(catalog.media.length, 3);
  }
  const error = await failure(xibo.open({ url: "not an address", credentials: { XIBO_CLIENT_ID: "a", XIBO_CLIENT_SECRET: "b" }, http: createVendorHttp({ vendor: "xibo", name: "Xibo", credentialNames: [], fetch: cms().fetch, sleep: async () => undefined, now: () => 0 }), now: () => NOW }));
  assert.equal(error.problem.code, "usage_error");
});

test("an answer this adapter cannot use is vendor_bad_response, naming the path and never the body", async () => {
  const base = cms();
  const body = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/library") return Response.json({ secret: "do-not-echo", rows: [] }, { headers: { "X-Total-Count": "1" } });
    return base.fetch(input, init);
  }) as typeof fetch;
  const http = createVendorHttp({ vendor: "xibo", name: "Xibo", credentialNames: [], fetch: body, sleep: async () => undefined, now: () => NOW.getTime() });
  const open = await xibo.open({ url: ORIGIN, credentials: { XIBO_CLIENT_ID: CLIENT_ID, XIBO_CLIENT_SECRET: CLIENT_SECRET }, http, now: () => NOW });
  const error = await failure(open.scan());
  assert.equal(error.problem.code, "vendor_bad_response");
  assert.match(error.problem.detail, /GET \/library did not answer with a list/);
  assert.ok(!JSON.stringify(error.problem).includes("do-not-echo"));

  const noToken = createVendorHttp({ vendor: "xibo", name: "Xibo", credentialNames: [], fetch: (async () => Response.json({ token_type: "Bearer" })) as typeof fetch, sleep: async () => undefined, now: () => 0 });
  const refused = await failure((await xibo.open({ url: ORIGIN, credentials: { XIBO_CLIENT_ID: CLIENT_ID, XIBO_CLIENT_SECRET: CLIENT_SECRET }, http: noToken, now: () => NOW })).scan());
  assert.equal(refused.problem.code, "vendor_bad_response");
  assert.match(refused.problem.detail, /no access_token/);

  const noId = createVendorHttp({
    vendor: "xibo", name: "Xibo", credentialNames: [], sleep: async () => undefined, now: () => 0,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).pathname === "/api/library" ? Response.json([{ name: "no id" }], { headers: { "X-Total-Count": "1" } }) : base.fetch(input, init))) as typeof fetch,
  });
  const missing = await failure((await xibo.open({ url: ORIGIN, credentials: { XIBO_CLIENT_ID: CLIENT_ID, XIBO_CLIENT_SECRET: CLIENT_SECRET }, http: noId, now: () => NOW })).scan());
  assert.match(missing.problem.detail, /GET \/library has a row without mediaId/);
});

test("migrate scan --from xibo: keys from the environment, a report of what cannot come over, and no key in anything written or printed", async () => {
  const t = await setup();
  try {
    const router = cms();
    const result = await t.h.invoke(["migrate", "scan", "--from", "xibo", "--url", ORIGIN, "--timezone", "America/Toronto"], {
      env: { XIBO_CLIENT_ID: CLIENT_ID, XIBO_CLIENT_SECRET: CLIENT_SECRET }, vendorFetch: router.fetch,
    });
    assert.equal(result.code, 0, result.stdout);
    const report = result.json.data;
    assert.equal(report.vendor, "xibo");
    assert.equal(report.label, "cms.example.com");
    assert.deepEqual(report.found, { media: 3, playlists: 3, layouts: 2, schedules: 8, groups: 2, screens: 3 });
    const notImported = (kind: string) => report.not_imported.filter((entry: { kind: string }) => entry.kind === kind).map((entry: { source_id: string }) => entry.source_id);
    assert.deepEqual(notImported("schedule").sort(), ["10", "11", "13", "5", "6", "7", "8", "9"], "the monthly event is listed by the framework with the others");
    assert.match(report.not_imported.find((entry: { source_id: string }) => entry.source_id === "5").reason, /by the month/);
    assert.deepEqual(notImported("media"), ["104", "105", "106"]);
    assert.deepEqual(notImported("item"), ["playlist 201 item 5", "playlist 201 item 8"]);
    const lossy = (id: string) => report.lossy.filter((entry: { source_id: string }) => entry.source_id === id).map((entry: { change: string }) => entry.change);
    assert.ok(lossy("3").some((change: string) => /every 2 days/.test(change)), JSON.stringify(report.lossy));
    assert.ok(lossy("1@America/Toronto").length > 0);
    assert.ok(lossy("301").some((change: string) => /background image/.test(change)));
    assert.ok(!result.stdout.includes(CLIENT_SECRET) && !result.stdout.includes("fixture-token"));
    const dir = path.join(t.cwd, "screenrig-migration-xibo");
    const scanFile = await readFile(path.join(dir, "scan.json"), "utf8");
    assert.ok(!scanFile.includes(CLIENT_SECRET) && !scanFile.includes("fixture-token"), "scan.json holds no credential");
    assert.equal(JSON.parse(scanFile).account, ORIGIN);
    assert.equal((await stat(path.join(dir, "scan.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ["scan.json"]);

    const refused = await t.h.invoke(["migrate", "scan", "--from", "xibo", "--url", ORIGIN, "--dir", "refused"], {
      env: { XIBO_CLIENT_ID: CLIENT_ID, XIBO_CLIENT_SECRET: "a-wrong-secret" }, vendorFetch: cms().fetch,
    });
    assert.equal(refused.code, 3);
    assert.equal(refused.json.error.code, "vendor_refused");
    assert.match(refused.json.error.detail, /Check XIBO_CLIENT_ID and XIBO_CLIENT_SECRET/);
    assert.ok(!refused.stdout.includes("a-wrong-secret"), "a secret the CMS quotes back is not echoed");
    await assert.rejects(stat(path.join(t.cwd, "refused")), { code: "ENOENT" });

    const noSecret = await t.h.invoke(["migrate", "scan", "--from", "xibo", "--url", ORIGIN, "--dir", "nosecret"], { env: { XIBO_CLIENT_ID: CLIENT_ID }, vendorFetch: cms().fetch });
    assert.equal(noSecret.code, 2);
    assert.match(noSecret.json.error.detail, /Xibo needs XIBO_CLIENT_SECRET/);
    const noUrl = await t.h.invoke(["migrate", "scan", "--from", "xibo", "--dir", "nourl"], { env: { XIBO_CLIENT_ID: CLIENT_ID, XIBO_CLIENT_SECRET: CLIENT_SECRET }, vendorFetch: cms().fetch });
    assert.match(noUrl.json.error.detail, /Xibo needs --url/);
    const files = await t.h.invoke(["migrate", "scan", "--from", "xibo", "--url", ORIGIN, "--files", t.cwd, "--dir", "files"], { env: { XIBO_CLIENT_ID: CLIENT_ID, XIBO_CLIENT_SECRET: CLIENT_SECRET }, vendorFetch: cms().fetch });
    assert.match(files.json.error.detail, /Xibo does not take --files/);
  } finally {
    await t.cleanup();
  }
});

test("migrate vendors xibo says what it takes and how to make the key", async () => {
  const t = await setup();
  try {
    const result = await t.h.invoke(["migrate", "vendors", "xibo"]);
    assert.equal(result.code, 0);
    const [vendor] = result.json.data.vendors;
    assert.deepEqual(vendor.inputs.flags, [{ flag: "--url", required: true }, { flag: "--timezone", required: false }]);
    assert.deepEqual(vendor.inputs.env.map((entry: { name: string; secret: boolean; required: boolean }) => [entry.name, entry.secret, entry.required]), [["XIBO_CLIENT_ID", false, true], ["XIBO_CLIENT_SECRET", true, true]]);
    assert.ok(vendor.connect.length >= 3 && vendor.maps.length > 0 && vendor.skips.length > 0 && vendor.docs.every((doc: string) => doc.startsWith("https://")));
    assert.match(vendor.example, /^screenrig migrate scan --from xibo --url https:\/\/cms\.example\.com/);
  } finally {
    await t.cleanup();
  }
});

test("the example on migrate vendors runs as written", async () => {
  const t = await setup();
  try {
    await writeFile(path.join(t.cwd, "xibo.env"), `XIBO_CLIENT_ID=${CLIENT_ID}\nXIBO_CLIENT_SECRET=${CLIENT_SECRET}\n`);
    const result = await t.h.invoke(xibo.example.split(" ").slice(1), { vendorFetch: cms().fetch });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.json.data.vendor, "xibo");
  } finally {
    await t.cleanup();
  }
});
