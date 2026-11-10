import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import {
  backgroundColor, backgroundId, backgroundOrSetId, backgroundUrl, imageBackgroundOf, isBackgroundId, setBackgroundColor, withCanvasBackground,
} from "./backgrounds.js";
import { ExitCode } from "./exit-codes.js";
import { run } from "./main.js";
import { processRuntime } from "./runtime.js";
import { fakeSessionJwt, FakeTransport } from "./transport/fake.js";

const PLAYLIST = "pl_AAAAAAAAAAAAAAAAAAAAAAAA";
const IMAGE = "med_AAAAAAAAAAAAAAAAAAAAAAAA";
const BG = "bg_blockbuster-laser-rush__landscape__bottom-banner-73d2f112";
const OTHER_BG = "bg_concert-poster-comic-book__landscape__left-half-0a1b2c3d";
const SET = "blockbuster-laser-rush";

const set = (colors: string[] = ["#09111B", "#2F62D9", "#FF6A47"]) => ({
  id: SET, name: "Blockbuster Laser Rush", category: "arts-culture-entertainment", category_name: "Arts, Culture & Entertainment", style: "neon",
  colors, thumbnail_path: "/static-resources/images/background-thumbs/blockbuster-laser-rush-7c635246.webp", landscape_count: 2, portrait_count: 1,
});
const image = (id: string, orientation: "landscape" | "portrait", layout: string, tone: "dark" | "light") => ({
  id, set: SET, orientation, layout, label: layout.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" "),
  width: orientation === "landscape" ? 1280 : 720, height: orientation === "landscape" ? 720 : 1280, bytes: 106342, sha256: "73d2".repeat(16), tone,
  image_path: `/static-resources/images/backgrounds/${id.slice(3)}.webp`,
});
const shown = (colors?: string[]) => ({ background: image(BG, "landscape", "bottom-banner", "dark"), set: set(colors) });

const storedPage = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "welcome",
  canvas: { width: 3840, height: 2160, viewport_fit: "contain", background: "#112233FF" },
  transition: { type: "dip", duration_ms: 300 },
  advance: { mode: "duration", after_ms: 7000 },
  visibility: { enabled: true, from: "2026-12-01T00:00" },
  primitives: [{
    id: "media", primitive: "image", selector: { by: "id", media_id: IMAGE }, rect: { x: 0, y: 0, width: 3840, height: 2160 }, layer: 0, content_fit: "cover",
    resolved_media: [{ media_id: IMAGE, intrinsic_size: { width: 1920, height: 1080 } }],
  }],
  comments: { note: "kept by the agent" },
  ...extra,
});
const withBackground = (background: unknown) => storedPage({ canvas: { width: 3840, height: 2160, viewport_fit: "contain", background } });
const playlistBody = (pages: unknown[], revision = 7) => ({ id: PLAYLIST, name: "Lobby", revision, pages });

test("a background id is bg_ then the image's name, ending in eight hex characters", () => {
  assert.ok(isBackgroundId(BG));
  assert.ok(isBackgroundId("bg_a-00000000"));
  for (const bad of ["", "blockbuster-laser-rush", "bg_", "bg_x", "bg_-abc-01234567", "bg_Upper-case-01234567", "bg_name-0123456", "bg_name-0123456G", `bg_${"a".repeat(150)}-01234567`, "med_AAAA", "bg_two words-01234567"]) {
    assert.equal(isBackgroundId(bad), false, bad);
  }
  assert.equal(backgroundId(BG), BG);
  assert.throws(() => backgroundId("bg_x"), (error: { problem?: { code?: string } }) => error.problem?.code === "usage_error");
  assert.equal(backgroundOrSetId(SET), SET);
  assert.equal(backgroundOrSetId(BG), BG);
  assert.throws(() => backgroundOrSetId("bg_x"), (error: { problem?: { code?: string } }) => error.problem?.code === "usage_error");
  assert.throws(() => backgroundOrSetId(""), (error: { problem?: { code?: string } }) => error.problem?.code === "usage_error");
});

test("a colour is #RRGGBBAA, taken in either case and kept in the canonical uppercase form", () => {
  assert.equal(backgroundColor("#09111bff"), "#09111BFF");
  assert.equal(backgroundColor("#09111B80"), "#09111B80");
  for (const bad of ["09111BFF", "#09111B", "#09111BF", "#09111BFFF", "#GG111BFF", "red", ""]) {
    assert.throws(() => backgroundColor(bad), (error: { problem?: { code?: string } }) => error.problem?.code === "usage_error", bad);
  }
});

test("the default colour is the set's first colour, opaque, else black", () => {
  assert.equal(setBackgroundColor(set()), "#09111BFF");
  assert.equal(setBackgroundColor(set(["#2f62d9"])), "#2F62D9FF");
  assert.equal(setBackgroundColor(set([])), "#000000FF");
  assert.equal(setBackgroundColor(set(["blue"])), "#000000FF");
  assert.equal(setBackgroundColor(undefined), "#000000FF");
});

test("a stored page's image background is read with its colour, and a solid or gradient has none", () => {
  assert.deepEqual(imageBackgroundOf(withBackground({ type: "image", background_id: BG, color: "#09111BFF" })), { background_id: BG, color: "#09111BFF" });
  assert.deepEqual(imageBackgroundOf(withBackground({ type: "image", background_id: BG })), { background_id: BG });
  assert.equal(imageBackgroundOf(storedPage()), undefined);
  assert.equal(imageBackgroundOf(withBackground({ type: "linear", stops: [] })), undefined);
  assert.equal(imageBackgroundOf({ id: "slot", type: "adslot" }), undefined);
});

test("replacing the background changes the canvas background alone and refuses a page without a canvas", () => {
  const page = storedPage();
  const changed = withCanvasBackground(page, { type: "image", background_id: BG, color: "#09111BFF" });
  assert.deepEqual(changed.canvas, { width: 3840, height: 2160, viewport_fit: "contain", background: { type: "image", background_id: BG, color: "#09111BFF" } });
  assert.deepEqual({ ...changed, canvas: undefined }, { ...page, canvas: undefined });
  assert.equal((page.canvas as { background: unknown }).background, "#112233FF", "the page is not mutated");
  assert.throws(() => withCanvasBackground({ id: "slot", type: "adslot" }, "#000000FF"), (error: { problem?: { code?: string } }) => error.problem?.code === "usage_error");
});

test("a root-relative path resolves against the API origin", () => {
  assert.equal(backgroundUrl("/static-resources/images/backgrounds/a-01234567.webp", "https://api.screenrig.ai"), "https://api.screenrig.ai/static-resources/images/backgrounds/a-01234567.webp");
  assert.equal(backgroundUrl("/static-resources/x.webp", "http://api.screenrig.localhost:8080/"), "http://api.screenrig.localhost:8080/static-resources/x.webp");
  assert.equal(backgroundUrl("https://elsewhere.example/x.webp", "https://api.screenrig.ai"), "https://elsewhere.example/x.webp");
  assert.equal(backgroundUrl(undefined, "https://api.screenrig.ai"), "");
});

async function cli(t: TestContext, transport: FakeTransport, stored: Record<string, unknown> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "background-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "config.json");
  await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "test-token", ...stored }), { mode: 0o600 });
  return async (argv: string[]) => {
    let output = "";
    const code = await run({ ...processRuntime(), argv: ["--config", config, ...argv], cwd: () => directory, settings: {}, transport,
      stdin: Readable.from([""]), isStdinTty: () => false,
      stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
      stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    });
    return { code, output };
  };
}

const writesOf = (transport: FakeTransport) => transport.calls.filter((call) => call.method !== "GET");

test("background categories and sets read the catalog, filter on the server and print absolute URLs where there are images", async (t) => {
  const transport = new FakeTransport()
    .on("GET", "/api/backgrounds/categories", () => ({ status: 200, headers: {}, body: { categories: [{ id: "arts-culture-entertainment", name: "Arts, Culture & Entertainment", set_count: 12, thumbnail_path: "/static-resources/images/background-thumbs/blockbuster-laser-rush-7c635246.webp" }] } }))
    .on("GET", "/api/backgrounds/sets", () => ({ status: 200, headers: {}, body: { sets: [set()] } }));
  const invoke = await cli(t, transport);

  const categories = await invoke(["--human", "background", "categories"]);
  assert.equal(categories.code, ExitCode.Success, categories.output);
  assert.match(categories.output, /Background categories \(1\)/);
  assert.match(categories.output, /arts-culture-entertainment +Arts, Culture & Entertainment +12/);
  assert.equal(JSON.parse((await invoke(["background", "categories"])).output).data.categories[0].set_count, 12);

  const sets = await invoke(["--human", "background", "sets", "--category", "arts-culture-entertainment", "--search", "laser rush", "--orientation", "portrait"]);
  assert.equal(sets.code, ExitCode.Success, sets.output);
  assert.deepEqual(transport.calls.find((call) => call.path === "/api/backgrounds/sets")?.query, { category: "arts-culture-entertainment", q: "laser rush", orientation: "portrait" });
  assert.match(sets.output, new RegExp(`${SET} +Blockbuster Laser Rush +arts-culture-entertainment +2 +1 +#09111B, #2F62D9, #FF6A47`));
  const json = JSON.parse((await invoke(["background", "sets"])).output);
  assert.equal(json.data.sets[0].landscape_count, 2);
  assert.equal(writesOf(transport).length, 0);

  const bad = await invoke(["background", "sets", "--orientation", "square"]);
  assert.equal(bad.code, ExitCode.Usage, bad.output);
});

test("background show reads a set with each image, or one image with its set, and an unknown id is not_found with the way to list them", async (t) => {
  const images = [image(BG, "landscape", "bottom-banner", "dark"), image(OTHER_BG, "portrait", "left-half", "light")];
  const transport = new FakeTransport()
    .on("GET", `/api/backgrounds/sets/${SET}`, () => ({ status: 200, headers: {}, body: { ...set(), backgrounds: images } }))
    .on("GET", `/api/backgrounds/${BG}`, () => ({ status: 200, headers: {}, body: shown() }));
  const invoke = await cli(t, transport);

  const setAnswer = await invoke(["--human", "background", "show", SET]);
  assert.equal(setAnswer.code, ExitCode.Success, setAnswer.output);
  assert.match(setAnswer.output, /Background set blockbuster-laser-rush/);
  assert.match(setAnswer.output, /category: arts-culture-entertainment \(Arts, Culture & Entertainment\)/);
  assert.match(setAnswer.output, new RegExp(`${BG} +landscape +bottom-banner +dark +https://api\\.screenrig\\.ai/static-resources/images/backgrounds/blockbuster-laser-rush__landscape__bottom-banner-73d2f112\\.webp`));
  assert.match(setAnswer.output, new RegExp(`${OTHER_BG} +portrait +left-half +light `));
  assert.match(setAnswer.output, /thumbnail: https:\/\/api\.screenrig\.ai\/static-resources\/images\/background-thumbs\//);
  assert.equal(JSON.parse((await invoke(["background", "show", SET])).output).data.backgrounds.length, 2);

  const imageAnswer = await invoke(["--human", "background", "show", BG]);
  assert.equal(imageAnswer.code, ExitCode.Success, imageAnswer.output);
  assert.match(imageAnswer.output, /orientation: landscape \(1280x720\)/);
  assert.match(imageAnswer.output, /layout: bottom-banner \(Bottom Banner\)/);
  assert.match(imageAnswer.output, /tone: dark/);
  assert.match(imageAnswer.output, /image: https:\/\/api\.screenrig\.ai\/static-resources\/images\/backgrounds\/blockbuster-laser-rush__landscape__bottom-banner-73d2f112\.webp/);
  assert.equal(JSON.parse((await invoke(["background", "show", BG])).output).data.set.id, SET);

  const missingSet = JSON.parse((await invoke(["background", "show", "no-such-set"])).output);
  assert.equal(missingSet.ok, false);
  assert.equal(missingSet.error.code, "not_found");
  assert.equal(missingSet.error.next.command, "screenrig background sets");
  assert.equal((await invoke(["background", "show", OTHER_BG])).code, ExitCode.NotFound);
  assert.equal((await invoke(["background", "show", "bg_bad"])).code, ExitCode.Usage);
});

function applyRoutes(page: Record<string, unknown>, colors?: string[]) {
  const writes: { body: Record<string, unknown>; headers: Record<string, string | undefined>; path: string }[] = [];
  const transport = new FakeTransport()
    .on("GET", `/api/backgrounds/${BG}`, () => ({ status: 200, headers: {}, body: shown(colors) }))
    .on("GET", `/api/playlists/${PLAYLIST}`, () => ({ status: 200, headers: {}, body: playlistBody([page]) }))
    .on("PUT", `/api/playlists/${PLAYLIST}/pages/welcome`, (request) => {
      writes.push({ body: request.body as never, headers: request.headers ?? {}, path: request.path });
      return { status: 200, headers: { etag: '"8"' }, body: playlistBody([request.body], 8) };
    });
  return { transport, writes };
}

test("background apply writes the page with the image background, the set's first colour, the revision it read and the note", async (t) => {
  const { transport, writes } = applyRoutes(storedPage());
  const invoke = await cli(t, transport);
  const answer = await invoke(["background", "apply", BG, "--playlist-id", PLAYLIST, "--page-id", "welcome", "--note", "Winter look"]);
  assert.equal(answer.code, ExitCode.Success, answer.output);
  assert.equal(writes.length, 1);
  const { body, headers } = writes[0]!;
  const stored = storedPage();
  assert.deepEqual(body.canvas, { width: 3840, height: 2160, viewport_fit: "contain", background: { type: "image", background_id: BG, color: "#09111BFF" } });
  assert.equal("comments" in body, false, "an agent's comments are not authored");
  assert.equal("resolved_media" in (body.primitives as Record<string, unknown>[])[0]!, false, "what the server resolved is not sent back");
  const { comments: _comments, canvas: _canvas, primitives: _primitives, ...others } = stored;
  const { canvas: _written, primitives: _writtenPrimitives, ...writtenOthers } = body;
  assert.deepEqual(writtenOthers, others, "every other member stays as stored");
  assert.deepEqual((body.primitives as unknown[])[0], { id: "media", primitive: "image", selector: { by: "id", media_id: IMAGE }, rect: { x: 0, y: 0, width: 3840, height: 2160 }, layer: 0, content_fit: "cover" });
  assert.equal(headers["if-match"], '"7"', "the revision the page was read at");
  assert.equal(headers["screenrig-review-note"], "Winter%20look");
  assert.ok(headers["idempotency-key"]);
  assert.equal(JSON.parse(answer.output).data.revision, 8);
  // The catalog image is read before the playlist, so an unknown image writes nothing.
  assert.deepEqual(transport.calls.map((call) => `${call.method} ${call.path}`), [`GET /api/backgrounds/${BG}`, `GET /api/playlists/${PLAYLIST}`, `PUT /api/playlists/${PLAYLIST}/pages/welcome`]);

  const human = await invoke(["--human", "background", "apply", BG, "--playlist-id", PLAYLIST, "--page-id", "welcome"]);
  assert.match(human.output, new RegExp(`Background ${BG} set on page welcome of ${PLAYLIST} \\(color #09111BFF\\)\\.`));
});

test("background apply colour: --color, else the image background's own, else the set's first, else black", async (t) => {
  const colorOf = async (page: Record<string, unknown>, extra: string[] = [], colors?: string[]) => {
    const { transport, writes } = applyRoutes(page, colors);
    const answer = await (await cli(t, transport))(["background", "apply", BG, "--playlist-id", PLAYLIST, "--page-id", "welcome", ...extra]);
    assert.equal(answer.code, ExitCode.Success, answer.output);
    return ((writes[0]!.body.canvas as { background: { color: string } }).background).color;
  };
  assert.equal(await colorOf(storedPage()), "#09111BFF");
  assert.equal(await colorOf(storedPage(), ["--color", "#ff000080"]), "#FF000080", "an explicit colour wins and is made uppercase");
  assert.equal(await colorOf(withBackground({ type: "image", background_id: OTHER_BG, color: "#123456FF" })), "#123456FF", "a page's image background keeps its colour");
  assert.equal(await colorOf(withBackground({ type: "image", background_id: OTHER_BG, color: "#123456FF" }), ["--color", "#00000000"]), "#00000000");
  assert.equal(await colorOf(withBackground({ type: "image", background_id: OTHER_BG })), "#09111BFF", "an image background without a colour takes the set's");
  assert.equal(await colorOf(storedPage(), [], []), "#000000FF");
});

test("background apply holds the write to --expect-rev when given and refuses what it cannot change before any write", async (t) => {
  const { transport, writes } = applyRoutes(storedPage());
  const invoke = await cli(t, transport);
  await invoke(["background", "apply", BG, "--playlist-id", PLAYLIST, "--page-id", "welcome", "--expect-rev", "5"]);
  assert.equal(writes[0]!.headers["if-match"], '"5"');

  const missingPage = await invoke(["background", "apply", BG, "--playlist-id", PLAYLIST, "--page-id", "nowhere"]);
  assert.equal(missingPage.code, ExitCode.Usage, missingPage.output);
  assert.match(JSON.parse(missingPage.output).error.detail, /has no page nowhere/);

  const slot = applyRoutes({ id: "welcome", type: "adslot" });
  const adSlot = await (await cli(t, slot.transport))(["background", "apply", BG, "--playlist-id", PLAYLIST, "--page-id", "welcome"]);
  assert.equal(adSlot.code, ExitCode.Usage, adSlot.output);
  assert.equal(slot.writes.length, 0);

  const unknown = applyRoutes(storedPage());
  const unknownAnswer = await (await cli(t, unknown.transport))(["background", "apply", OTHER_BG, "--playlist-id", PLAYLIST, "--page-id", "welcome"]);
  assert.equal(unknownAnswer.code, ExitCode.NotFound, unknownAnswer.output);
  assert.equal(JSON.parse(unknownAnswer.output).error.next.command, "screenrig background sets");
  assert.deepEqual(unknown.transport.calls.map((call) => call.path), [`/api/backgrounds/${OTHER_BG}`], "nothing else is read or written");
  assert.equal(writes.length, 1);
});

test("background apply and clear check their input before any request", async (t) => {
  const transport = new FakeTransport();
  const invoke = await cli(t, transport);
  for (const argv of [
    ["background", "apply", "bg_bad", "--playlist-id", PLAYLIST, "--page-id", "welcome"],
    ["background", "apply", SET, "--playlist-id", PLAYLIST, "--page-id", "welcome"],
    ["background", "apply", BG, "--page-id", "welcome"],
    ["background", "apply", BG, "--playlist-id", PLAYLIST],
    ["background", "apply", BG, "--playlist-id", "not-a-playlist", "--page-id", "welcome"],
    ["background", "apply", BG, "--playlist-id", PLAYLIST, "--page-id", "1bad"],
    ["background", "apply", BG, "--playlist-id", PLAYLIST, "--page-id", "welcome", "--color", "#09111B"],
    ["background", "apply", BG, "--playlist-id", PLAYLIST, "--page-id", "welcome", "--expect-rev", "x"],
    ["background", "clear", "--page-id", "welcome"],
    ["background", "clear", "--playlist-id", PLAYLIST, "--page-id", "welcome", "--color", "blue"],
  ]) {
    const answer = await invoke(argv);
    assert.equal(answer.code, ExitCode.Usage, argv.join(" ") + " " + answer.output);
  }
  assert.equal(transport.calls.length, 0);
});

test("background clear sets a solid colour: --color, else the image background's colour, and nothing is written for a page that has none", async (t) => {
  const clear = async (page: Record<string, unknown>, extra: string[] = []) => {
    const { transport, writes } = applyRoutes(page);
    const answer = await (await cli(t, transport))(["background", "clear", "--playlist-id", PLAYLIST, "--page-id", "welcome", ...extra]);
    return { answer, writes, transport };
  };

  const kept = await clear(withBackground({ type: "image", background_id: BG, color: "#09111BFF" }), ["--expect-rev", "7", "--note", "Plain again"]);
  assert.equal(kept.answer.code, ExitCode.Success, kept.answer.output);
  assert.deepEqual(kept.writes[0]!.body.canvas, { width: 3840, height: 2160, viewport_fit: "contain", background: "#09111BFF" });
  assert.equal(kept.writes[0]!.headers["if-match"], '"7"');
  assert.equal(kept.writes[0]!.headers["screenrig-review-note"], "Plain%20again");
  assert.equal(kept.writes[0]!.path, `/api/playlists/${PLAYLIST}/pages/welcome`);
  assert.equal("comments" in kept.writes[0]!.body, false);
  assert.deepEqual(kept.transport.calls.map((call) => call.method + " " + call.path), [`GET /api/playlists/${PLAYLIST}`, `PUT /api/playlists/${PLAYLIST}/pages/welcome`], "clear reads no catalog image");

  const read = await clear(withBackground({ type: "image", background_id: BG, color: "#09111BFF" }));
  assert.equal(read.writes[0]!.headers["if-match"], '"7"', "held to the revision it read");

  const named = await clear(withBackground({ type: "image", background_id: BG, color: "#09111BFF" }), ["--color", "#ffffffff"]);
  assert.equal((named.writes[0]!.body.canvas as { background: string }).background, "#FFFFFFFF");

  const bare = await clear(withBackground({ type: "image", background_id: BG }));
  assert.equal((bare.writes[0]!.body.canvas as { background: string }).background, "#000000FF");

  const solid = await clear(storedPage(), ["--color", "#445566FF"]);
  assert.equal((solid.writes[0]!.body.canvas as { background: string }).background, "#445566FF", "--color sets a solid colour on any page");

  const none = await clear(storedPage());
  assert.equal(none.answer.code, ExitCode.Usage, none.answer.output);
  assert.match(JSON.parse(none.answer.output).error.detail, /no image background to clear/);
  assert.equal(none.writes.length, 0);
});

test("a background change under Propose access is a pending review, not a write that failed", async (t) => {
  const transport = new FakeTransport()
    .on("GET", `/api/backgrounds/${BG}`, () => ({ status: 200, headers: {}, body: shown() }))
    .on("GET", `/api/playlists/${PLAYLIST}`, () => ({ status: 200, headers: {}, body: playlistBody([storedPage()]) }))
    .on("PUT", `/api/playlists/${PLAYLIST}/pages/welcome`, () => ({ status: 202, headers: {}, body: { status: "pending_review", review: { id: "rvw_TEST", state: "pending", kind: "playlist_change", subject: { id: PLAYLIST, type: "playlist", name: "Lobby" }, url: "https://screenrig.ai/dashboard/reviews/rvw_TEST" } } }));
  const answer = await (await cli(t, transport))(["background", "apply", BG, "--playlist-id", PLAYLIST, "--page-id", "welcome"]);
  assert.equal(answer.code, ExitCode.Success, answer.output);
  const envelope = JSON.parse(answer.output);
  assert.equal(envelope.data.review.id, "rvw_TEST");
  assert.equal(envelope.warnings[0].code, "pending_review");
});

const NORTH = "prj_AAAAAAAAAAAAAAAAAAAAAAAA", SOUTH = "prj_BBBBBBBBBBBBBBBBBBBBBBBB";

/**
 * The catalog as the backend serves it to a token with two project grants: a request names its project in the path or in
 * ?project=, else it is project_required. Only the list routes have a path form; a set and an image are read with the query.
 */
function twoProjectCatalog(selected: (string | undefined)[]) {
  const problem = (status: number, code: string) => ({ status, headers: {}, body: { status, code, detail: code } });
  const lists: Record<string, unknown> = {
    "/api/backgrounds/categories": { categories: [{ id: "arts-culture-entertainment", name: "Arts, Culture & Entertainment", set_count: 12, thumbnail_path: "/static-resources/x.webp" }] },
    "/api/backgrounds/sets": { sets: [set()] },
  };
  const details: Record<string, unknown> = {
    [`/api/backgrounds/sets/${SET}`]: { ...set(), backgrounds: [image(BG, "landscape", "bottom-banner", "dark")] },
    [`/api/backgrounds/${BG}`]: shown(),
  };
  return new FakeTransport().on("GET", /^\/api\/(?:projects\/[^/]+\/)?backgrounds\//, (request) => {
    const inPath = /^\/api\/projects\/([^/]+)\//.exec(request.path)?.[1];
    const project = inPath ?? request.query?.project;
    selected.push(project);
    if (!project) return problem(400, "project_required");
    if (project !== NORTH && project !== SOUTH) return problem(404, "not_found");
    const logical = request.path.replace(/^\/api\/projects\/[^/]+\//, "/api/");
    const body = lists[logical] ?? (inPath ? undefined : details[logical]);
    return body ? { status: 200, headers: {}, body } : problem(404, "not_found");
  });
}

test("the background commands select the project with a token that holds two", async (t) => {
  const selected: (string | undefined)[] = [];
  const writes: string[] = [];
  const transport = twoProjectCatalog(selected)
    .on("GET", `/api/playlists/${PLAYLIST}`, () => ({ status: 200, headers: {}, body: playlistBody([storedPage()]) }))
    .on("GET", `/api/projects/${SOUTH}/reviews`, () => ({ status: 200, headers: {}, body: { items: [], next_cursor: null } }))
    .on("PUT", `/api/playlists/${PLAYLIST}/pages/welcome`, (request) => {
      writes.push(request.path);
      return { status: 200, headers: { etag: '"8"' }, body: playlistBody([request.body], 8) };
    });
  const token = fakeSessionJwt({ sub: "agent:agt_EXAMPLE", sid: "grt_BACKGROUND", exp: 4102444800, scope: "identity", projects: {
    [NORTH]: ["access:read", "content"], [SOUTH]: ["access:manage", "content"],
  } });
  const invoke = await cli(t, transport, { token, project_id: SOUTH, project_name: "South" });
  const calls = () => transport.calls.splice(0).map((call) => `${call.method} ${call.path}${call.query?.project ? ` ?project=${call.query.project}` : ""}`);

  for (const argv of [
    ["background", "categories"], ["background", "sets", "--category", "arts-culture-entertainment"], ["background", "show", SET], ["background", "show", BG],
  ]) {
    const answer = await invoke(argv);
    assert.equal(answer.code, ExitCode.Success, `${argv.join(" ")} ${answer.output}`);
  }
  assert.deepEqual(calls(), [
    `GET /api/projects/${SOUTH}/backgrounds/categories`,
    `GET /api/projects/${SOUTH}/backgrounds/sets`,
    `GET /api/backgrounds/sets/${SET} ?project=${SOUTH}`,
    `GET /api/backgrounds/${BG} ?project=${SOUTH}`,
  ]);

  const applied = await invoke(["background", "apply", BG, "--playlist-id", PLAYLIST, "--page-id", "welcome"]);
  assert.equal(applied.code, ExitCode.Success, applied.output);
  assert.deepEqual(calls(), [
    `GET /api/backgrounds/${BG} ?project=${SOUTH}`,
    `GET /api/playlists/${PLAYLIST} ?project=${SOUTH}`,
    `GET /api/projects/${SOUTH}/reviews`,
    `PUT /api/playlists/${PLAYLIST}/pages/welcome`,
  ]);
  assert.deepEqual(writes, [`/api/playlists/${PLAYLIST}/pages/welcome`]);

  const north = await (await cli(t, transport, { token, project_id: NORTH, project_name: "North" }))(["background", "sets"]);
  assert.equal(north.code, ExitCode.Success, north.output);
  assert.deepEqual(calls(), [`GET /api/projects/${NORTH}/backgrounds/sets`]);
  assert.ok(selected.length > 0 && selected.every((project) => project === SOUTH || project === NORTH), `every catalog request named its project: ${selected.join(", ")}`);
});
