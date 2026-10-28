import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { testTemp } from "../../test-temp.js";
import { openLocalFiles } from "../local-files.js";
import { harness, fakeProject } from "../project-fake.test.js";
import type { SourceCatalog } from "../types.js";
import { fixture, open, problemOf, router, scan, type Recorded } from "./more-helpers.test.js";
import { civil, optisigns, parseRule } from "./optisigns.js";

const KEY = "fixture-token";
const CREDENTIALS = { OPTISIGNS_API_KEY: KEY };
const ENDPOINT = "https://graphql-gateway.optisigns.com/graphql";
const USED_SCHEDULE = "OPS00000000000001";

interface Page {
  data: Record<string, { page: { pageInfo: { endCursor: string | null } } }>;
}

/** The fixture account. Each list is a list of pages; a request's `after` cursor picks the page after the one that ended there. */
function gateway(options: { errors?: unknown[] } = {}) {
  return router(async (request: Recorded) => {
    if (request.url.href !== ENDPOINT) return new Response("not here", { status: 404 });
    if (request.headers.authorization !== `Bearer ${KEY}`) return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
    if (options.errors) return Response.json({ errors: options.errors, data: null });
    const body = JSON.parse(request.body ?? "{}") as { query: string; variables: { after: string | null; scheduleId?: string } };
    const field = /\{ (\w+)\(/.exec(body.query)?.[1];
    if (!field) return new Response("bad query", { status: 400 });
    if (field === "scheduleItems" && body.variables.scheduleId !== USED_SCHEDULE) {
      return Response.json({ data: { scheduleItems: { page: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    const pages = await fixture<Page[]>("optisigns", field);
    const index = body.variables.after === null ? 0 : pages.findIndex((page) => page.data[field]!.page.pageInfo.endCursor === body.variables.after) + 1;
    return Response.json(pages[index]);
  });
}

test("with the schedules' time zone, the account becomes media, playlists, groups, waiting screens and campaigns, exactly as the fixture says", async () => {
  const api = gateway();
  const catalog = await scan(optisigns, api.fetch, { credentials: CREDENTIALS, timezone: "America/Toronto" });
  assert.deepEqual(catalog, await fixture<SourceCatalog>("optisigns", "catalog.expected"));
  assert.ok(api.requests.every((request) => request.method === "POST" && request.url.href === ENDPOINT && request.headers.authorization === `Bearer ${KEY}`));
});

test("lists are read page by page with first and after, and the events of each used schedule by its id", async () => {
  const api = gateway();
  await scan(optisigns, api.fetch, { credentials: CREDENTIALS, timezone: "America/Toronto" });
  const calls = api.requests.map((request) => JSON.parse(request.body!) as { query: string; variables: { first: number; after: string | null; scheduleId?: string } });
  const fields = calls.map((call) => /\{ (\w+)\(/.exec(call.query)![1]);
  assert.deepEqual(fields, ["devices", "devices", "assets", "assets", "playlists", "schedules", "scheduleItems", "scheduleItems"]);
  assert.deepEqual(calls.filter((call) => call.query.includes("devices(")).map((call) => call.variables.after), [null, "cursor-devices-1"]);
  assert.deepEqual(calls.filter((call) => call.query.includes("scheduleItems(")).map((call) => [call.variables.scheduleId, call.variables.after]), [[USED_SCHEDULE, null], [USED_SCHEDULE, "cursor-items-1"]]);
  assert.ok(calls.every((call) => call.variables.first === 100));
  assert.ok(calls.every((call) => /query\(\$first:Int,\$after:String/.test(call.query)));
});

test("every event is either a campaign or listed with its reason, and without --timezone none can be read", async () => {
  const withZone = await scan(optisigns, gateway().fetch, { credentials: CREDENTIALS, timezone: "America/Toronto" });
  assert.deepEqual(withZone.schedules.map((schedule) => schedule.name), ["Morning promo", "Christmas Eve", "Exception", "Every two weeks", "First Monday"]);
  assert.deepEqual(withZone.not_imported.filter((entry) => entry.kind === "schedule").map((entry) => [entry.name, entry.reason]), [
    ["Monthly report", "It repeats by BYMONTHDAY, which campaigns cannot express: they repeat on days of the week."],
    ["Holiday skips", "It skips or adds single dates, which campaigns cannot express."],
    ["Gone", "The playlist or asset it plays did not come over."],
    ["Unused calendar", "No screen uses this schedule."],
  ]);
  const exception = withZone.schedules.find((schedule) => schedule.name === "Exception")!;
  assert.equal(exception.priority, 10);
  assert.deepEqual(exception.notes, ["It replaced one occurrence of a repeating event; it now takes priority over that event at its own time."]);

  const without = await scan(optisigns, gateway().fetch, { credentials: CREDENTIALS });
  assert.deepEqual(without.schedules, []);
  const refused = without.not_imported.filter((entry) => entry.kind === "schedule" && entry.reason.startsWith("OptiSigns gives event times"));
  assert.deepEqual(refused.map((entry) => entry.name), ["Morning promo", "Christmas Eve", "Monthly report", "Holiday skips", "Exception", "Every two weeks", "First Monday"]);
  assert.match(refused[0]!.next ?? "", /--timezone ZONE/);
  assert.ok(without.not_imported.some((entry) => entry.name === "Gone" && entry.reason === "The playlist or asset it plays did not come over."));
});

test("without --files the media have no address, and the report says how the agent supplies the originals", async () => {
  const catalog = await scan(optisigns, gateway().fetch, { credentials: CREDENTIALS, timezone: "America/Toronto" });
  assert.ok(catalog.media.length > 0 && catalog.media.every((item) => item.fetch === undefined && item.original));
  assert.ok(catalog.notes.some((note) => /documents no way to download a file/.test(note) && /rerun migrate scan with --files DIR/.test(note)));
  assert.ok(catalog.notes.some((note) => /durations without a unit; they were read as seconds/.test(note)));
  await assert.rejects(
    (await open(optisigns, gateway().fetch, { credentials: CREDENTIALS })).fetchMedia(catalog.media[0]!, "/nowhere"),
    /OptiSigns hands out no files/,
  );
});

test("an asset the API cannot give a reason for, and what each kind of item needs, is listed", async () => {
  const catalog = await scan(optisigns, gateway().fetch, { credentials: CREDENTIALS, timezone: "America/Toronto" });
  const items = catalog.not_imported.filter((entry) => entry.kind !== "schedule").map((entry) => [entry.kind, entry.name, entry.reason]);
  assert.deepEqual(items, [
    ["media", "Handbook", "It is a document, not an image, video or audio file."],
    ["item", "Clock", "It is an OptiSigns app with no web address in the API."],
    ["media", "Split screen", "It is a multi-zone screen layout, which the OptiSigns API does not describe fully enough to rebuild."],
    ["item", "Main loop: Handbook.pdf", "It is a document, not an image, video or audio file."],
    ["item", "Main loop: Clock", "It is an OptiSigns app with no web address in the API."],
  ]);
  assert.match(catalog.not_imported.find((entry) => entry.name === "Clock")!.next ?? "", /built-in card/);
  assert.deepEqual(catalog.playlists.find((playlist) => playlist.name === "Main loop")!.notes, ["Its background audio does not come over."]);
  assert.equal(catalog.playlists.find((playlist) => playlist.name === "Main loop")!.shuffle, true);
});

test("through the command: with --files the originals are matched by the asset's file name, and the rest waits", async () => {
  const configDir = await testTemp("optisigns-cfg-");
  const cwd = await testTemp("optisigns-cwd-");
  try {
    const downloads = path.join(cwd, "downloads");
    await mkdir(path.join(downloads, "sub"), { recursive: true });
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex");
    await writeFile(path.join(downloads, "welcome.PNG"), png);
    await writeFile(path.join(downloads, "sub", "Banner.jpg"), png);
    await writeFile(path.join(downloads, "stored-9f2c.jpg"), Buffer.from("not the original"));
    const project = fakeProject();
    const h = await harness(project, configDir, cwd);
    const api = gateway();
    const result = await h.invoke(["migrate", "scan", "--from", "optisigns", "--files", downloads, "--timezone", "America/Toronto"], { env: CREDENTIALS, vendorFetch: api.fetch });
    assert.equal(result.code, 0, result.stdout);
    const report = result.json.data;
    assert.deepEqual(report.found, { media: 4, playlists: 3, layouts: 0, schedules: 5, groups: 3, screens: 4 });
    assert.deepEqual(report.importable, { media: 2, playlists: 3, layouts: 0, schedules: 4, groups: 3, screens: 4 });
    const missing = report.not_imported.filter((entry: { kind: string; reason: string }) => entry.kind === "media" && /does not hand out this file/.test(entry.reason));
    assert.deepEqual(missing.map((entry: { name: string }) => entry.name).sort(), ["Extra", "Promo"]);
    assert.ok(missing.every((entry: { next: string }) => /into a folder and rerun migrate scan with --files DIR/.test(entry.next)));
    assert.ok(!report.notes.some((note: string) => /documents no way to download/.test(note)), "with --files the download note is not repeated");
    assert.ok(report.lossy.some((entry: { name: string; change: string }) => entry.name === "Main loop" && /left out because their media did not come over/.test(entry.change)));
    const scanFile = JSON.parse(await readFile(path.join(cwd, "screenrig-migration-optisigns", "scan.json"), "utf8"));
    const media = new Map<string, { local?: string; filename: string }>(scanFile.catalog.media.map((item: { name: string; local?: string; filename: string }) => [item.name, item]));
    assert.equal(media.get("Welcome.png")!.local, "welcome.PNG");
    assert.equal(media.get("Banner")!.local, "sub/Banner.jpg");
    assert.equal(media.get("Banner")!.filename, "Banner.jpg", "the original file name, not the stored one");
    assert.ok(!JSON.stringify(scanFile).includes(KEY));
    assert.ok(!result.stdout.includes(KEY));
    assert.equal(project.transport.calls.length, 0);
    const refused = await h.invoke(["migrate", "scan", "--from", "optisigns", "--dir", "refused"], { env: { OPTISIGNS_API_KEY: "wrong-token" }, vendorFetch: api.fetch });
    assert.equal(refused.code, 3);
    assert.equal(refused.json.error.code, "vendor_refused");
    assert.match(refused.json.error.detail, /Check OPTISIGNS_API_KEY/);
    assert.ok(!refused.stdout.includes("wrong-token"));
    assert.equal((await h.invoke(["migrate", "scan", "--from", "optisigns", "--dir", "u", "--url", "https://x.example.com"], { env: CREDENTIALS, vendorFetch: api.fetch })).code, 2);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the adapter prefers whichever of the two file names is in --files", async () => {
  const dir = await testTemp("optisigns-names-");
  try {
    await writeFile(path.join(dir, "stored-9f2c.jpg"), "x");
    const catalog = await scan(optisigns, gateway().fetch, { credentials: CREDENTIALS, files: await openLocalFiles(dir) });
    assert.equal(catalog.media.find((item) => item.name === "Banner")!.filename, "stored-9f2c.jpg");
    assert.ok(!catalog.notes.some((note) => /documents no way to download/.test(note)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a GraphQL error with an authentication code is a refusal; any other is a bad response that quotes nothing", async () => {
  const refused = await problemOf(scan(optisigns, gateway({ errors: [{ message: `key ${KEY} refused`, extensions: { code: "UNAUTHENTICATED" } }] }).fetch, { credentials: CREDENTIALS }));
  assert.equal(refused.code, "vendor_refused");
  assert.ok(!refused.detail.includes(KEY));
  const other = await problemOf(scan(optisigns, gateway({ errors: [{ message: `Cannot query field "UID" on type "Device" for ${KEY}`, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }).fetch, { credentials: CREDENTIALS }));
  assert.equal(other.code, "vendor_bad_response");
  assert.ok(!other.detail.includes(KEY) && !other.detail.includes("UID"));
  const shape = await problemOf(scan(optisigns, router(async () => Response.json({ data: { devices: { page: { edges: [{ cursor: "c" }], pageInfo: { hasNextPage: false } } } } })).fetch, { credentials: CREDENTIALS }));
  assert.equal(shape.code, "vendor_bad_response");
  assert.match(shape.detail, /devices\.page\.edges\[0\]\.node is missing/);
});

// ---- the repeat rules a schedule event carries

test("repeat rules: daily and weekly with a count or an end come over, with or without a DTSTART line", () => {
  const rule = (text: string | undefined) => parseRule(text, "America/Toronto");
  assert.deepEqual(rule(undefined), { ok: true });
  assert.deepEqual(rule(""), { ok: true });
  assert.deepEqual(rule("FREQ=DAILY;COUNT=1"), { ok: true });
  assert.deepEqual(rule("FREQ=DAILY"), { ok: true, repeat: { every: "day" } });
  assert.deepEqual(rule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6"), { ok: true, repeat: { every: "week", interval: 2, count: 6, weekdays: ["mon", "wed"] } });
  assert.deepEqual(rule("DTSTART:20261102T140000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO;WKST=SU;UNTIL=20261218"), { ok: true, repeat: { every: "week", weekdays: ["mon"], until: "2026-12-18" } });
  assert.deepEqual(rule("FREQ=DAILY;UNTIL=20261219T023000Z"), { ok: true, repeat: { every: "day", until: "2026-12-18" } }, "an end in UTC is the date it falls on in the zone");
  assert.deepEqual(rule("freq=weekly;byday=su"), { ok: true, repeat: { every: "week", weekdays: ["sun"] } });
});

test("repeat rules: what campaigns cannot express is refused with the reason, and a month or year reaches the mapper as it is", () => {
  const refused = (text: string): string => {
    const result = parseRule(text, "UTC");
    assert.equal(result.ok, false, text);
    return (result as { reason: string }).reason;
  };
  assert.match(refused("FREQ=MONTHLY;BYMONTHDAY=1"), /repeats by BYMONTHDAY/);
  assert.match(refused("FREQ=YEARLY;BYMONTH=3"), /repeats by BYMONTH/);
  assert.match(refused("FREQ=DAILY;BYHOUR=9"), /repeats by BYHOUR/);
  assert.match(refused("FREQ=DAILY\nEXDATE:20261125T150000Z"), /skips or adds single dates/);
  assert.match(refused("FREQ=DAILY\nRDATE:20261125T150000Z"), /skips or adds single dates/);
  assert.match(refused("FREQ=SECONDLY"), /no frequency campaigns can express/);
  assert.match(refused("INTERVAL=2"), /no frequency campaigns can express/);
  assert.match(refused("FREQ=DAILY;INTERVAL=0"), /interval could not be read/);
  assert.match(refused("FREQ=DAILY;COUNT=x"), /count could not be read/);
  assert.match(refused("FREQ=WEEKLY;BYDAY=XX"), /weekdays could not be read/);
  assert.match(refused("FREQ=DAILY;UNTIL=soon"), /date its repeat ends on could not be read/);
  assert.deepEqual(parseRule("FREQ=MONTHLY;BYDAY=1MO", "UTC"), { ok: true, repeat: { every: "month", nth_weekday: true, weekdays: ["mon"] } });
  assert.deepEqual(parseRule("FREQ=MONTHLY", "UTC"), { ok: true, repeat: { every: "month" } });
  assert.deepEqual(parseRule("FREQ=YEARLY", "UTC"), { ok: true, repeat: { every: "year" } });
});

test("civil times follow the zone's offset on the day, across a change of clocks", () => {
  assert.equal(civil(new Date("2026-03-07T14:00:00.000Z"), "America/Toronto"), "2026-03-07T09:00");
  assert.equal(civil(new Date("2026-03-08T14:00:00.000Z"), "America/Toronto"), "2026-03-08T10:00");
  assert.equal(civil(new Date("2026-06-01T00:00:00.000Z"), "UTC"), "2026-06-01T00:00");
  assert.equal(civil(new Date("2026-11-02T04:30:00.000Z"), "Asia/Kolkata"), "2026-11-02T10:00");
});
