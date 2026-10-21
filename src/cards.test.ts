import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { ApiClient } from "./client.js";
import { cardProperties, validatePlaylistCards, type CardDetails } from "./cards.js";
import { commandHelp } from "./help.js";
import { parseArgv } from "./argv.js";
import { run, processRuntime } from "./main.js";
import { FakeTransport, fakeSessionJwt } from "./transport/fake.js";
import { networkError } from "./problems.js";
import { publishScreen } from "./screen-publish.js";
import { editablePlaylist } from "./playlist-authoring.js";
import { validatePlaylistWriteSemantics } from "./generated/playlist-write-semantics.js";

const details: CardDetails = {
  id: "menu", major: 1, version: "1.0.0", tier: "core", layouts: ["full", "free", "center", "wide", "corner", "chip", "strip"], feed: "",
  params_schema: { type: "object", additionalProperties: false, required: ["sections"],
    $defs: { rows: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string", maxLength: 30 } } } } },
    properties: { theme: { type: "string", enum: ["neomustard"], default: "neomustard" }, title: { type: "string", maxLength: 40, default: "Menu" }, sections: { $ref: "#/$defs/rows", dynamic: true } } },
  data_schema: { type: "object", additionalProperties: false, required: ["sections"], properties: { sections: { type: "array", minItems: 1, maxItems: 3 } } },
  example: { id: "menu", primitive: "card", card: "menu", params: { title: "Menu", sections: [{ title: "Lunch" }] }, layout: "center", content_fit: "fill" },
};
const ok = (body: unknown, headers: Record<string, string> = {}) => ({ status: 200, headers, body });
const summary = (id: string, category = "food", tags = ["menu"]) => ({ id, title: id, short: "Live details", category, tags, tier: "core", layouts: ["full", "center"], majors: [1] });

async function fixture(t: TestContext, enrolled = true) {
  const dir = await mkdtemp(path.join(tmpdir(), "screenrig-cards-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = dir + "/config.json";
  if (enrolled) await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example", token: "test-token" }), { mode: 0o600 });
  const transport = new FakeTransport();
  async function invoke(argv: string[], input?: string) {
    let stdout = "", stderr = "";
    const code = await run({ ...processRuntime(), argv: ["--config", config, ...argv], env: {}, cwd: () => dir, transport,
      now: () => new Date("2026-10-15T12:00:00Z"), sleep: async () => { throw new Error("Feed must not loop or sleep"); },
      stdin: input === undefined ? undefined : Readable.from([input]), isStdinTty: () => input === undefined,
      stdout: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }),
      stderr: new Writable({ write(chunk, _encoding, done) { stderr += chunk; done(); } }),
    });
    return { code, stdout, stderr, body: argv.includes("--human") ? undefined : JSON.parse(stdout) };
  }
  return { dir, config, transport, invoke };
}

test("cards list returns catalogue metadata and combines local tag/category filters", async t => {
  const f = await fixture(t);
  const cards = [summary("menu"), summary("clock", "information", ["time"]), summary("specials", "food", ["menu", "daily"])];
  f.transport.on("GET", "/api/card-types", request => { assert.equal(request.query, undefined); return ok({ cards }); });
  assert.deepEqual((await f.invoke(["cards", "list"])).body.data.cards, cards);
  assert.deepEqual((await f.invoke(["cards", "list", "--tag", "daily", "--category", "food"])).body.data.cards, [cards[2]]);
  assert.deepEqual((await f.invoke(["cards", "list", "--category", "missing"])).body.data.cards, []);
});

test("cards show preserves schemas, splits properties and prints limits/defaults and placement", async t => {
  const f = await fixture(t);
  f.transport.on("GET", "/api/card-types/menu", () => ok(details));
  const result = await f.invoke(["cards", "show", "menu"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.body.data.params_schema, details.params_schema);
  assert.deepEqual(result.body.data.data_schema, details.data_schema);
  assert.equal(result.body.data.tier, "core");
  assert.deepEqual(result.body.data.layouts, details.layouts);
  assert.deepEqual(result.body.data.example, details.example);
  assert.equal(result.body.data.properties.static.title.schema.default, "Menu");
  assert.equal(result.body.data.properties.dynamic.sections.schema.maxItems, 3);
  assert.equal(result.body.data.properties.dynamic.sections.required, true);
  const human = await f.invoke(["--human", "cards", "show", "menu"]);
  assert.match(human.stdout, /static properties:[\s\S]*dynamic properties:[\s\S]*maxItems[\s\S]*example placement:/);
  const feed = { ...details, feed: "screenrig.weather/v1" };
  assert.equal(cardProperties(feed).static.theme.schema.default, "neomustard");
});

test("unknown cards preserve card_not_found and exit 4", async t => {
  const f = await fixture(t);
  f.transport.on("GET", "/api/card-types/unknown", () => ({ status: 404, headers: {}, body: { code: "card_not_found", title: "Card not found", status: 404 } }));
  const result = await f.invoke(["cards", "show", "unknown"]);
  assert.equal(result.code, 4); assert.equal(result.body.error.code, "card_not_found");
});

test("card-data get/list/delete use the project namespace, complete paging and quoted If-Match", async t => {
  const f = await fixture(t);
  const entry = { key: "menu/main", document: { sections: [] }, revision: 3 };
  f.transport.on("GET", "/api/card-data/menu%2Fmain", () => ok(entry));
  f.transport.on("GET", "/api/card-data", request => ok(request.query?.after ? { items: [{ key: "z", revision: 4 }], next_cursor: null } : { items: [{ key: "a", revision: 1 }], next_cursor: "a" }));
  f.transport.on("DELETE", "/api/card-data/menu%2Fmain", request => {
    assert.equal(request.headers?.["if-match"], '"3"'); assert.ok(request.headers?.["idempotency-key"]);
    return { status: 204, headers: {}, body: undefined };
  });
  assert.deepEqual((await f.invoke(["card-data", "get", "menu/main"])).body.data, entry);
  const list = await f.invoke(["card-data", "list"]);
  assert.equal(list.code, 0); assert.deepEqual(list.body.data.items.map((item: any) => item.key), ["a", "z"]); assert.equal(list.body.data.next_cursor, null);
  assert.equal((await f.invoke(["card-data", "delete", "menu/main", "--expect-rev", "3"])).code, 0);
});

test("card-data put reads files/stdin as document objects, supports If-Match alias and saved retry keys", async t => {
  const f = await fixture(t);
  const document = { sections: [{ title: "Lunch" }] };
  await writeFile(f.dir + "/data.json", JSON.stringify(document));
  let ambiguous = true;
  f.transport.on("PUT", "/api/card-data/menu-main", request => {
    assert.deepEqual(request.body, { document }); assert.equal(request.headers?.["if-match"], '"3"');
    if (ambiguous) { ambiguous = false; throw networkError("Connection interrupted"); }
    return ok({ key: "menu-main", document, revision: 4 });
  });
  const argv = ["card-data", "put", "menu-main", "--file", "data.json", "--if-match", "3"];
  assert.equal((await f.invoke(argv)).code, 10);
  assert.equal((await f.invoke(argv)).code, 0);
  const writes = f.transport.calls.filter(call => call.method === "PUT");
  assert.equal(writes[0]!.headers?.["idempotency-key"], writes[1]!.headers?.["idempotency-key"]);
  assert.equal((await f.invoke(["card-data", "put", "menu-main", "--file", "-", "--expect-rev", "3"], JSON.stringify(document))).code, 0);
  assert.doesNotMatch(await readFile(f.config, "utf8"), /sections|Lunch/);
});

test("card-data rejects invalid/nonobject/oversize input without writes or echoing content", async t => {
  const f = await fixture(t);
  for (const input of ["secret invalid JSON", "null", "[]", '"text"', JSON.stringify({ large: "x".repeat(1_048_576) })]) {
    const result = await f.invoke(["card-data", "put", "key", "--file", "-"], input);
    assert.equal(result.code, 2, result.stdout); assert.doesNotMatch(result.stdout, /secret invalid JSON/);
  }
  assert.equal(f.transport.calls.length, 0);
});

test("card-data server validation and revision refusals keep stable problem codes", async t => {
  const f = await fixture(t);
  for (const [status, code, exit] of [[409, "card_data_invalid", 5], [412, "revision_conflict", 6]] as const) {
    const path = `/api/card-data/key${status}`;
    f.transport.on("PUT", path, () => ({ status, headers: {}, body: { code, title: "Refused", status, errors: [{ field: "document.sections", card: "menu", major: 1, data_key: "key" }] } }));
    const result = await f.invoke(["card-data", "put", `key${status}`, "--file", "-", "--expect-rev", "3"], "{}");
    assert.equal(result.code, exit); assert.equal(result.body.error.code, code); assert.equal(result.body.error.errors[0].field, "document.sections");
  }
});

test("feeds get covers each family, maps query names and returns fetchedAt/attribution", async t => {
  const f = await fixture(t);
  const doc = { schema: "screenrig.weather/v1", fetchedAt: "2026-10-15T11:58:00Z", attribution: { text: "Data provider" } };
  const cases: Array<[string, string[], Record<string, string>]> = [
    ["weather", ["--lat", "49.25", "--lon", "-123"], { lat: "49.25", lon: "-123" }],
    ["airquality", ["--lat", "0", "--lon", "0"], { lat: "0", lon: "0" }],
    ["alerts", ["--lat", "-90", "--lon", "180"], { lat: "-90", lon: "180" }],
    ["rates", ["--base", "EUR"], { base: "EUR" }],
    ["crypto", ["--symbols", "btc,eth", "--currency", "usd"], { symbols: "btc,eth", currency: "usd" }],
    ["earthquakes", ["--lat", "49", "--lon", "-123", "--radius-km", "500"], { lat: "49", lon: "-123", radius_km: "500" }],
    ["headlines", ["--url", "https://example.com/rss.xml"], { url: "https://example.com/rss.xml" }],
  ];
  for (const [family, flags, query] of cases) {
    f.transport.on("GET", `/api/feeds/${family}`, request => { assert.deepEqual(request.query, query); return ok(doc, { "screenrig-feed-key": `feed:${family}.v1:example` }); });
    const result = await f.invoke(["feeds", "get", family, ...flags]);
    assert.equal(result.code, 0, result.stdout); assert.equal(result.body.data.fetchedAt, doc.fetchedAt); assert.deepEqual(result.body.data.attribution, doc.attribution);
  }
});

test("pending feed returns retry seconds/time with one read and no polling", async t => {
  const f = await fixture(t);
  f.transport.on("GET", "/api/feeds/rates", () => ({ status: 202, headers: { "retry-after": "60" }, body: { key: "feed:rates.v1:EUR", state: "pending", retry_after_seconds: 60 } }));
  const result = await f.invoke(["feeds", "get", "rates"]);
  assert.equal(result.code, 0); assert.equal(result.body.data.state, "pending"); assert.equal(result.body.data.retry_after_seconds, 60);
  assert.equal(result.body.data.retry_at, "2026-10-15T12:01:00.000Z"); assert.equal(f.transport.calls.length, 1);
});

test("pending feed honors Retry-After dates and body fallback, and refuses missing retry metadata", async t => {
  const f = await fixture(t);
  for (const [family, headers, body, retry] of [
    ["rates", { "retry-after": "Thu, 15 Oct 2026 12:02:00 GMT" }, { state: "pending" }, 120],
    ["crypto", {}, { state: "pending", retry_after_seconds: 15 }, 15],
    ["headlines", {}, { state: "pending" }, undefined],
  ] as const) {
    f.transport.on("GET", `/api/feeds/${family}`, () => ({ status: 202, headers: headers as Record<string, string>, body }));
    const flags = family === "crypto" ? ["--symbols", "btc"] : family === "headlines" ? ["--url", "https://example.com/rss"] : [];
    const result = await f.invoke(["feeds", "get", family, ...flags]);
    assert.equal(result.code, retry === undefined ? 1 : 0);
    if (retry !== undefined) assert.equal(result.body.data.retry_after_seconds, retry);
    else assert.equal(result.body.error.code, "unexpected_response");
  }
});

test("family and revision validation/discovery agree; invalid feed input never reaches the API", async t => {
  const f = await fixture(t);
  for (const argv of [
    ["feeds", "get", "weather"], ["feeds", "get", "weather", "--lat", "91", "--lon", "0"],
    ["feeds", "get", "weather", "--base", "EUR"], ["feeds", "get", "crypto"], ["feeds", "get", "headlines"],
    ["feeds", "get", "earthquakes", "--lat", "0", "--lon", "0", "--radius-km", "1"],
  ]) assert.equal((await f.invoke(argv)).code, 2);
  assert.equal(f.transport.calls.length, 0);
  for (const argv of [["cards", "show", "../bad"], ["card-data", "delete", "key"], ["card-data", "get", "feed:weather.v1:x"], ["card-data", "put", "key"], ["feeds", "get", "unknown"], ["feeds", "get", "weather", "--lat", "0"]]) assert.throws(() => parseArgv(argv));
  assert.ok(commandHelp(["card-data", "put"]).options.some(option => option.name === "--file"));
  assert.ok(commandHelp(["feeds", "get"]).relationships.some(group => group.kind === "together"));
});

test("card commands without enrollment fail not_enrolled and never enroll implicitly", async t => {
  const f = await fixture(t, false);
  for (const argv of [["cards", "list"], ["cards", "show", "menu"], ["card-data", "list"], ["feeds", "get", "rates"]]) {
    const result = await f.invoke(argv); assert.equal(result.code, 3); assert.equal(result.body.error.code, "not_enrolled");
  }
  assert.equal(f.transport.calls.length, 0);
});

function playlist(params: object, data?: string, major?: number) {
  return { name: "Menu", pages: [{ id: "lobby", canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
    transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "duration", after_ms: 8000 }, primitives: [
      { id: "menu", primitive: "card", card: "menu", ...(major === undefined ? {} : { major }), params, ...(data ? { data } : {}),
        layout: "full", content_fit: "fill" },
    ] }] };
}

test("playlist create/update validate schemas before uploading card JSON", async t => {
  const f = await fixture(t);
  f.transport.on("GET", "/api/card-types/menu", () => ok(details));
  f.transport.on("GET", "/api/screens", () => ok({ items: [], next_cursor: null }));
  f.transport.on("POST", "/api/playlists", request => ok({ ...(request.body as object), id: "pl_MENU", revision: 1 }));
  f.transport.on("PUT", "/api/playlists/pl_MENU", request => ok({ ...(request.body as object), id: "pl_MENU", revision: 2 }));
  const bound = playlist({ title: "Lunch", theme: "neomustard" }, "menu-main");
  const created = await f.invoke(["playlist", "create", "-"], JSON.stringify(bound));
  assert.equal(created.code, 0, created.stdout); assert.deepEqual(created.body.data.pages, bound.pages);
  assert.equal((await f.invoke(["playlist", "update", "pl_MENU", "-"], JSON.stringify(bound))).code, 0);
  const writes = f.transport.calls.filter(call => ["POST", "PUT"].includes(call.method)).length;
  for (const doc of [playlist({ title: 5 }, "menu-main"), playlist({ sections: [{ title: "Lunch" }] }, "menu-main"), playlist({}), playlist({ sections: [{ title: "x".repeat(31) }] }), playlist({ sections: [{ title: "Lunch" }], extra: true })]) {
    const result = await f.invoke(["playlist", "create", "-"], JSON.stringify(doc)); assert.equal(result.code, 2, result.stdout);
  }
  assert.equal(f.transport.calls.filter(call => ["POST", "PUT"].includes(call.method)).length, writes);
  assert.equal((await f.invoke(["playlist", "validate", "-"], JSON.stringify(bound))).code, 0);
});

test("playlist writes refuse a layout the card's tier does not take, and local semantics check placement shape", async () => {
  const transport = new FakeTransport().on("GET", "/api/card-types/menu", () => ok({ ...details, tier: "fullscreen", layouts: ["full"] }));
  const doc = playlist({ sections: [{ title: "Lunch" }] });
  Object.assign(doc.pages[0]!.primitives[0]!, { layout: "corner", anchor: "top-left" });
  await assert.rejects(() => validatePlaylistCards(new ApiClient({ transport }), doc), /fullscreen tier\) takes full, not corner/);
  const issues = (primitive: object) => validatePlaylistWriteSemantics({ pages: [{ id: "p", primitives: [{ id: "a", primitive: "card", card: "menu", ...primitive }] }] }).map(issue => issue.path);
  assert.deepEqual(issues({ layout: "full" }), []);
  assert.deepEqual(issues({ layout: "corner", anchor: "bottom-left" }), []);
  assert.deepEqual(issues({ layout: "strip", anchor: "left" }), []);
  assert.deepEqual(issues({ layout: "free", rect: {}, layer: 3 }), []);
  assert.deepEqual(issues({}), ["/pages/0/primitives/0/layout"]);
  assert.deepEqual(issues({ layout: "corner" }), ["/pages/0/primitives/0/anchor"]);
  assert.deepEqual(issues({ layout: "chip", anchor: "top" }), ["/pages/0/primitives/0/anchor"]);
  assert.deepEqual(issues({ layout: "center", anchor: "top" }), ["/pages/0/primitives/0/anchor"]);
  assert.deepEqual(issues({ layout: "wide" }), []);
  assert.deepEqual(issues({ layout: "wide", anchor: "top" }), ["/pages/0/primitives/0/anchor"]);
  assert.deepEqual(issues({ layout: "free" }), ["/pages/0/primitives/0/rect", "/pages/0/primitives/0/layer"]);
});

test("a page holds one full, center or wide card, and a card takes wide only when its layouts list it", async () => {
  const card = (id: string, layout: string, anchor?: string) => ({ id, primitive: "card", card: "menu", layout, ...(anchor ? { anchor } : {}) });
  const conflicts = (...primitives: object[]) => validatePlaylistWriteSemantics({ pages: [{ id: "p", primitives }] })
    .filter(issue => issue.message.includes("a page holds one full, center or wide card")).map(issue => issue.path);
  assert.deepEqual(conflicts(card("a", "wide"), card("b", "chip", "top-left"), card("c", "corner", "bottom-right"), card("d", "strip", "bottom")), []);
  assert.deepEqual(conflicts(card("a", "wide"), card("b", "full")), ["/pages/0/primitives/1/layout"]);
  assert.deepEqual(conflicts(card("a", "center"), card("b", "wide")), ["/pages/0/primitives/1/layout"]);
  assert.deepEqual(conflicts(card("a", "wide"), card("b", "wide")), ["/pages/0/primitives/1/layout"]);
  const transport = new FakeTransport().on("GET", "/api/card-types/menu", () => ok({ ...details, layouts: ["full", "free", "center", "corner", "chip", "strip"] }));
  const doc = playlist({ sections: [{ title: "Lunch" }] });
  Object.assign(doc.pages[0]!.primitives[0]!, { layout: "wide" });
  await assert.rejects(() => validatePlaylistCards(new ApiClient({ transport }), doc), /takes full, free, center, corner, chip, strip, not wide/);
  await validatePlaylistCards(new ApiClient({ transport: new FakeTransport().on("GET", "/api/card-types/menu", () => ok(details)) }), doc);
});

test("card checks cache one schema per card, accept inline dynamic data and defer older majors", async () => {
  const transport = new FakeTransport().on("GET", "/api/card-types/menu", () => ok(details));
  const doc = playlist({ sections: [{ title: "Lunch" }] });
  doc.pages.push(structuredClone(doc.pages[0]!));
  await validatePlaylistCards(new ApiClient({ transport }), doc);
  assert.equal(transport.calls.length, 1);
  await validatePlaylistCards(new ApiClient({ transport }), playlist({ legacy: true }, undefined, 2));
});

test("editable card placements preserve static params, data and major while stripping server-derived fields", () => {
  const authored = playlist({ title: "Lunch" }, "menu-main", 1);
  const resource = structuredClone(authored);
  Object.assign(resource.pages[0]!.primitives[0]!, { controller: false, feed: "feed:weather.v1:49.25:-123.00", resolved_media: [] });
  assert.deepEqual(editablePlaylist(resource), authored);
  assert.equal((resource.pages[0]!.primitives[0] as any).feed, "feed:weather.v1:49.25:-123.00");
});

test("screen publish checks cards before its create, preserves replay and refuses invalid params without writes", async t => {
  const f = await fixture(t);
  const screenId = "scr_AAAAAAAAAAAAAAAAAAAAAAAA", playlistId = "pl_AAAAAAAAAAAAAAAAAAAAAAAA";
  let assigned = false;
  f.transport.on("GET", "/api/project", () => ok({ id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA" }));
  f.transport.on("GET", `/api/screens/${screenId}`, () => ok({ id: screenId, revision: 1, ...(assigned ? { playlist_id: playlistId } : {}) }));
  f.transport.on("GET", "/api/card-types/menu", () => ok({ ...details, params_schema: { ...details.params_schema, $schema: "https://json-schema.org/draft/2020-12/schema" } }));
  f.transport.on("POST", "/api/playlists", request => {
    assert.equal((request.body as any).pages[0].primitives[0].card, "menu");
    assert.ok(f.transport.calls.some(call => call.path === "/api/card-types/menu"));
    return ok({ id: playlistId, revision: 1 });
  });
  f.transport.on("PATCH", `/api/screens/${screenId}`, () => { assigned = true; return ok({ id: screenId, revision: 1 }); });
  const options = { client: new ApiClient({ transport: f.transport }), runtime: processRuntime(), configPath: f.config, apiUrl: "https://api.screenrig.ai", screenId, document: playlist({ title: "Lunch" }, "menu-main") };
  assert.equal((await publishScreen(options)).stage, "assigned");
  const calls = f.transport.calls.length;
  assert.equal((await publishScreen(options)).stage, "assigned");
  assert.ok(f.transport.calls.slice(calls).every(call => call.method === "GET" && call.path !== "/api/card-types/menu"));
  const writes = f.transport.calls.filter(call => call.method !== "GET").length;
  await assert.rejects(() => publishScreen({ ...options, document: playlist({ title: 5 }, "menu-main") }), /Invalid card params/);
  assert.equal(f.transport.calls.filter(call => call.method !== "GET").length, writes);
});

async function subsetFixture(t: TestContext) {
  const f = await fixture(t);
  const stored = JSON.parse(await readFile(f.config, "utf8"));
  stored.token = fakeSessionJwt({ exp: 4102444800, sid: "grant", scope: "identity", projects: { prj_AAAAAAAAAAAAAAAAAAAAAAAA: ["access:manage", "content"] } });
  await writeFile(f.config, JSON.stringify(stored), { mode: 0o600 });
  return f;
}
const instanceId = "crd_INSTANCE";
const instancePath = `/api/cards/${instanceId}`;
const selectedPath = "/api/projects/prj_AAAAAAAAAAAAAAAAAAAAAAAA";

test("card create uses an explicit project parent, stdin params and a saved replay key", async t => {
  const f = await subsetFixture(t);
  const keys: string[] = [];
  f.transport.on("POST", `${selectedPath}/cards`, req => {
    assert.deepEqual(req.body, { type: "menu", major: 1, params: { title: "Lunch" } });
    assert.equal(req.headers?.["screenrig-project"], undefined);
    keys.push(req.headers!["idempotency-key"]!);
    if (keys.length === 1) throw networkError("lost response");
    return ok({ id: instanceId, revision: 1 });
  });
  const argv = ["card", "create", "--type", "menu", "--major", "1", "--file", "-"];
  assert.notEqual((await f.invoke(argv, '{"title":"Lunch"}')).code, 0);
  assert.equal((await f.invoke(argv, '{"title":"Lunch"}')).body.data.id, instanceId);
  assert.equal(keys[0], keys[1]);
});

test("card list completes every page and narrows with project query; show uses a global ID", async t => {
  const f = await subsetFixture(t);
  f.transport.on("GET", "/api/cards", req => {
    assert.equal(req.query?.project, "prj_AAAAAAAAAAAAAAAAAAAAAAAA");
    return ok(req.query?.after ? { items: [{ id: "crd_SECOND" }], next_cursor: null } : { items: [{ id: instanceId }], next_cursor: "next" });
  });
  f.transport.on("GET", instancePath, req => { assert.equal(req.query, undefined); return ok({ id: instanceId, revision: 1 }); });
  assert.equal((await f.invoke(["card", "list"])).body.data.items.length, 2);
  assert.equal((await f.invoke(["card", "show", instanceId])).body.data.id, instanceId);
});

test("card params replaces static params and card delete surfaces in-use refusal", async t => {
  const f = await subsetFixture(t);
  f.transport.on("PATCH", instancePath, req => { assert.deepEqual(req.body, { params: { title: "Dinner" } }); return ok({ id: instanceId, revision: 2 }); });
  let used = true;
  f.transport.on("DELETE", instancePath, req => {
    assert.ok(req.headers?.["idempotency-key"]);
    return used ? { status: 409, headers: {}, body: { code: "resource_conflict", status: 409, title: "Card in use" } } : { status: 204, headers: {}, body: undefined };
  });
  assert.equal((await f.invoke(["card", "params", instanceId, "--file", "-"], '{"title":"Dinner"}')).body.data.revision, 2);
  assert.equal((await f.invoke(["card", "delete", instanceId])).body.error.code, "resource_conflict");
  used = false;
  assert.equal((await f.invoke(["card", "delete", instanceId])).code, 0);
});

test("card instance data reads revisions and writes with If-Match and replay recovery", async t => {
  const f = await subsetFixture(t);
  f.transport.on("GET", `${instancePath}/data`, () => ok({ document: { sections: [] }, revision: 3 }));
  assert.equal((await f.invoke(["card", "data", "get", instanceId])).body.data.revision, 3);
  const keys: string[] = [];
  f.transport.on("PUT", `${instancePath}/data`, req => {
    assert.deepEqual(req.body, { document: { sections: [] } });
    assert.equal(req.headers?.["if-match"], '"3"');
    keys.push(req.headers!["idempotency-key"]!);
    if (keys.length === 1) throw networkError("lost response");
    return ok({ revision: 4 });
  });
  const argv = ["card", "data", "put", instanceId, "--file", "-", "--expect-rev", "3"];
  assert.notEqual((await f.invoke(argv, '{"sections":[]}')).code, 0);
  assert.equal((await f.invoke(argv, '{"sections":[]}')).body.data.revision, 4);
  assert.equal(keys[0], keys[1]);
});

test("instance data preserves revision refusals and rejects nonobject input before writes", async t => {
  const f = await subsetFixture(t);
  f.transport.on("PUT", `${instancePath}/data`, () => ({ status: 409, headers: {}, body: { code: "revision_conflict", status: 409, title: "Revision conflict" } }));
  assert.equal((await f.invoke(["card", "data", "put", instanceId, "--file", "-", "--expect-rev", "3"], "{}")).body.error.code, "revision_conflict");
  for (const argv of [["card", "create", "--type", "menu"], ["card", "params", instanceId], ["card", "data", "put", instanceId]]) {
    const count = f.transport.calls.length;
    assert.notEqual((await f.invoke([...argv, "--file", "-"], "[]")).code, 0);
    assert.equal(f.transport.calls.length, count);
  }
});

test("compatibility card-data commands surface server warning headers", async t => {
  const f = await subsetFixture(t);
  f.transport.on("GET", `${selectedPath}/card-data/old`, () => ok({ revision: 1 }, { warning: '299 screenrig "Use card instance data"', deprecation: "true" }));
  const result = await f.invoke(["card-data", "get", "old"]);
  assert.equal(result.code, 0);
  assert.match(result.body.warnings[0].message, /Use card instance data/);
});

test("UID placements defer validation to the server without a catalogue fetch", async () => {
  const transport = new FakeTransport();
  await validatePlaylistCards(new ApiClient({ transport, token: "test" }), { pages: [{ primitives: [{ primitive: "card", card: instanceId }] }] });
  assert.equal(transport.calls.length, 0);
});
