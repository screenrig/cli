import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { ExitCode } from "./exit-codes.js";
import { processRuntime, run } from "./main.js";
import { buildMediaPage, civilTime, formatCanvas, newPageId, pageCanvas, replaceMedia, visibilityOf } from "./playlist-page.js";
import { normalizeProblem } from "./problems.js";
import { FakeTransport } from "./transport/fake.js";

const PLAYLIST = "pl_AAAAAAAAAAAAAAAAAAAAAAAA";
const IMAGE = "med_AAAAAAAAAAAAAAAAAAAAAAAA";
const VIDEO = "med_BBBBBBBBBBBBBBBBBBBBBBBB";
const FOLDER = "mfd_AAAAAAAAAAAAAAAAAAAAAAAA";

const storedImagePage = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "up-ab12cd34",
  canvas: { width: 3840, height: 2160, background: "#112233FF" },
  transition: { type: "dip", duration_ms: 300 },
  advance: { mode: "duration", after_ms: 7000 },
  primitives: [{
    id: "media", primitive: "image", selector: { by: "id", media_id: IMAGE, one_at_a_time: false }, controller: false,
    rect: { x: 0, y: 0, width: 3840, height: 2160 }, layer: 0, content_fit: "cover",
    resolved_media: [{ media_id: IMAGE, intrinsic_size: { width: 1920, height: 1080 } }],
  }],
  comments: { note: "kept by the agent" },
  ...extra,
});

const playlistBody = (pages: unknown[] = [storedImagePage()], extra: Record<string, unknown> = {}) => ({ id: PLAYLIST, name: "Lobby", revision: 7, pages, ...extra });

test("a media page is one full-canvas primitive on the playlist's canvas, dated by its own visibility", () => {
  const playlist = playlistBody();
  const image = buildMediaPage({ id: "up-aaaaaaaa", mediaId: IMAGE, kind: "image", fit: "contain", seconds: 10, playlist, from: "2026-12-01T00:00", until: "2026-12-25T00:00" });
  assert.deepEqual(image, {
    id: "up-aaaaaaaa",
    canvas: { width: 3840, height: 2160, background: "#112233FF" },
    transition: { type: "dip", duration_ms: 300 },
    advance: { mode: "duration", after_ms: 10000 },
    primitives: [{ id: "media", primitive: "image", selector: { by: "id", media_id: IMAGE }, rect: { x: 0, y: 0, width: 3840, height: 2160 }, layer: 0, content_fit: "contain" }],
    visibility: { enabled: true, from: "2026-12-01T00:00", until: "2026-12-25T00:00" },
  });
  const video = buildMediaPage({ id: "up-bbbbbbbb", mediaId: VIDEO, kind: "video", fit: "cover", seconds: 99, playlist });
  assert.deepEqual(video.advance, { mode: "media_end" });
  assert.deepEqual(video.primitives, [{ id: "media", primitive: "video", selector: { by: "id", media_id: VIDEO }, rect: { x: 0, y: 0, width: 3840, height: 2160 }, layer: 0, content_fit: "cover", muted: true }]);
  assert.equal("visibility" in video, false, "no dates, always shown");
});

test("the canvas is the format's, else the first ordinary page's, else 1920 x 1080 on black", () => {
  const wall = { displays: 2, arrangement: "row", orientation: "landscape" };
  assert.deepEqual(formatCanvas(wall), { width: 3840, height: 1080 });
  assert.deepEqual(formatCanvas({ displays: 3, arrangement: "column", orientation: "portrait" }), { width: 1080, height: 5760 });
  assert.deepEqual(pageCanvas(playlistBody([storedImagePage()], { format: wall })), { width: 3840, height: 1080, background: "#112233FF" });
  assert.deepEqual(pageCanvas(playlistBody([{ id: "slot", type: "adslot" }, storedImagePage({ canvas: { width: 1280, height: 720, background: "#000000FF" } })])), { width: 1280, height: 720, background: "#000000FF" });
  assert.deepEqual(pageCanvas(playlistBody([])), { width: 1920, height: 1080, background: "#000000FF" });
  assert.deepEqual(buildMediaPage({ id: "up-cccccccc", mediaId: IMAGE, kind: "image", fit: "contain", seconds: 5, playlist: playlistBody([]) }).transition, { type: "crossfade", duration_ms: 600 });
});

test("page ids are up- and eight characters of a-z and 0-9", () => {
  for (let index = 0; index < 50; index += 1) assert.match(newPageId(), /^up-[a-z0-9]{8}$/);
  assert.equal(newPageId(() => Uint8Array.from([0, 1, 2, 3, 4, 5, 35, 36])), "up-abcdef9a");
  assert.notEqual(newPageId(), newPageId());
});

test("dates: a date alone starts at 00:00 and ends after that whole day, in civil time", () => {
  assert.equal(civilTime("2026-12-01", "from", "--from"), "2026-12-01T00:00");
  assert.equal(civilTime("2026-12-24", "until", "--until"), "2026-12-25T00:00");
  assert.equal(civilTime("2026-12-31", "until", "--until"), "2027-01-01T00:00");
  assert.equal(civilTime("2028-02-28", "until", "--until"), "2028-02-29T00:00");
  assert.equal(civilTime("2026-12-24T17:30", "until", "--until"), "2026-12-24T17:30", "a time is kept as given");
  for (const bad of ["12/24/2026", "2026-13-01", "2026-02-30", "2026-12-24T24:00", "2026-12-24T10:60", "tomorrow", ""]) {
    assert.throws(() => civilTime(bad, "from", "--from"), (error: { problem?: { code?: string } }) => error.problem?.code === "usage_error", bad);
  }
});

test("a date flag changes its bound alone and an undated page has no visibility", () => {
  assert.equal(visibilityOf(undefined, undefined, undefined), undefined);
  assert.deepEqual(visibilityOf(undefined, "2026-12-01T00:00", undefined), { enabled: true, from: "2026-12-01T00:00" });
  assert.deepEqual(visibilityOf({ enabled: true, from: "2026-12-01T00:00", until: "2026-12-25T00:00" }, undefined, "2026-12-31T00:00"), { enabled: true, from: "2026-12-01T00:00", until: "2026-12-31T00:00" });
  assert.deepEqual(visibilityOf({ enabled: true, windows: [{ days: ["mon"] }] }, "2026-12-01T00:00", undefined), { enabled: true, windows: [{ days: ["mon"] }], from: "2026-12-01T00:00" });
});

test("replacing media keeps everything else, dates included, and rebuilds across kinds", () => {
  const stored = storedImagePage({ visibility: { enabled: true, from: "2026-12-01T00:00", until: "2026-12-25T00:00" } });
  const same = replaceMedia({ stored, mediaId: "med_CCCCCCCCCCCCCCCCCCCCCCCC", kind: "image", playlist: playlistBody([stored]), always: false });
  assert.equal("comments" in same, false, "a page's comments are not authored");
  assert.equal("resolved_media" in (same.primitives as Record<string, unknown>[])[0]!, false, "what the server resolved is not sent back");
  assert.deepEqual((same.primitives as Record<string, unknown>[])[0]!.selector, { by: "id", media_id: "med_CCCCCCCCCCCCCCCCCCCCCCCC" });
  assert.equal((same.primitives as Record<string, unknown>[])[0]!.content_fit, "cover", "the stored fit stays");
  assert.deepEqual(same.advance, { mode: "duration", after_ms: 7000 });
  assert.deepEqual(same.canvas, stored.canvas);
  assert.deepEqual(same.visibility, stored.visibility, "the dates stay");

  const longer = replaceMedia({ stored, mediaId: IMAGE, kind: "image", seconds: 20, fit: "contain", playlist: playlistBody([stored]), always: false });
  assert.deepEqual(longer.advance, { mode: "duration", after_ms: 20000 });
  assert.equal((longer.primitives as Record<string, unknown>[])[0]!.content_fit, "contain");

  const moved = replaceMedia({ stored, mediaId: IMAGE, kind: "image", until: "2027-01-01T00:00", playlist: playlistBody([stored]), always: false });
  assert.deepEqual(moved.visibility, { enabled: true, from: "2026-12-01T00:00", until: "2027-01-01T00:00" });
  const always = replaceMedia({ stored, mediaId: IMAGE, kind: "image", playlist: playlistBody([stored]), always: true });
  assert.equal("visibility" in always, false, "--always removes the dates");
  const datesOnly = replaceMedia({ stored, until: "2027-02-01T00:00", playlist: playlistBody([stored]), always: false });
  assert.deepEqual((datesOnly.primitives as Record<string, unknown>[])[0]!.selector, { by: "id", media_id: IMAGE, one_at_a_time: false }, "the media stays");

  const video = replaceMedia({ stored, mediaId: VIDEO, kind: "video", playlist: playlistBody([stored]), always: false });
  assert.deepEqual(video.advance, { mode: "media_end" });
  assert.deepEqual((video.primitives as Record<string, unknown>[])[0], { id: "media", primitive: "video", selector: { by: "id", media_id: VIDEO }, rect: { x: 0, y: 0, width: 3840, height: 2160 }, layer: 0, content_fit: "contain", muted: true });
  assert.deepEqual(video.visibility, stored.visibility, "an image for a video keeps the dates");
  assert.equal(video.id, "up-ab12cd34");

  assert.throws(() => replaceMedia({ stored: storedImagePage({ primitives: [{ id: "a" }, { id: "b" }] }), mediaId: IMAGE, kind: "image", playlist: playlistBody(), always: false }),
    (error: { problem?: { code?: string } }) => error.problem?.code === "usage_error");
});

async function cli(t: TestContext, transport: FakeTransport, env: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "playlist-page-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "config.json");
  await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "test-token" }), { mode: 0o600 });
  return Object.assign(async (argv: string[], input = "") => {
    let output = "";
    const code = await run({ ...processRuntime(), argv: ["--config", config, ...argv], cwd: () => directory, env, transport,
      stdin: Readable.from([input]), isStdinTty: () => false,
      stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
      stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    });
    return { code, output };
  }, { directory });
}

const media = (primitive: string) => ({ status: 200, headers: {}, body: { id: IMAGE, primitive } });
const playlistAnswer = (revision = 8) => ({ status: 200, headers: { etag: `"${revision}"` }, body: playlistBody([], { revision }) });

test("playlist page add --media builds the page, dates it, and sends it with the place and the guards", async (t) => {
  const writes: { body: unknown; headers: Record<string, string | undefined> }[] = [];
  const transport = new FakeTransport()
    .on("GET", `/api/media/${IMAGE}`, () => media("image"))
    .on("GET", `/api/playlists/${PLAYLIST}`, () => ({ status: 200, headers: {}, body: playlistBody() }))
    .on("POST", `/api/playlists/${PLAYLIST}/pages`, (request) => { writes.push({ body: request.body, headers: request.headers ?? {} }); return playlistAnswer(); });
  const invoke = await cli(t, transport);
  const answer = await invoke(["playlist", "page", "add", PLAYLIST, "--media", IMAGE, "--from", "2026-12-01", "--until", "2026-12-24", "--seconds", "12",
    "--fit", "cover", "--before", "welcome", "--page-id", "december", "--expect-rev", "7", "--note", "Winter menu"]);
  assert.equal(answer.code, ExitCode.Success, answer.output);
  assert.equal(writes.length, 1);
  const { body, headers } = writes[0]!;
  assert.deepEqual(body, { before: "welcome", page: {
    id: "december", canvas: { width: 3840, height: 2160, background: "#112233FF" }, transition: { type: "dip", duration_ms: 300 },
    advance: { mode: "duration", after_ms: 12000 },
    primitives: [{ id: "media", primitive: "image", selector: { by: "id", media_id: IMAGE }, rect: { x: 0, y: 0, width: 3840, height: 2160 }, layer: 0, content_fit: "cover" }],
    visibility: { enabled: true, from: "2026-12-01T00:00", until: "2026-12-25T00:00" },
  } });
  assert.equal(headers["if-match"], '"7"');
  assert.equal(headers["screenrig-review-note"], "Winter%20menu");
  assert.ok(headers["idempotency-key"]);
  assert.equal(JSON.parse(answer.output).data.revision, 8);
});

test("playlist page add --media without options takes a generated id, the end of the loop and no dates", async (t) => {
  const writes: { page: Record<string, unknown>; before?: string }[] = [];
  const transport = new FakeTransport()
    .on("GET", `/api/media/${VIDEO}`, () => media("video"))
    .on("GET", `/api/playlists/${PLAYLIST}`, () => ({ status: 200, headers: {}, body: playlistBody([]) }))
    .on("POST", `/api/playlists/${PLAYLIST}/pages`, (request) => { writes.push(request.body as never); return playlistAnswer(); });
  const answer = await (await cli(t, transport))(["playlist", "page", "add", PLAYLIST, "--media", VIDEO]);
  assert.equal(answer.code, ExitCode.Success, answer.output);
  const page = writes[0]!.page;
  assert.match(String(page.id), /^up-[a-z0-9]{8}$/);
  assert.equal("before" in writes[0]!, false);
  assert.deepEqual(page.advance, { mode: "media_end" });
  assert.equal("visibility" in page, false);
  assert.deepEqual(page.canvas, { width: 1920, height: 1080, background: "#000000FF" });
});

test("playlist page add --file sends the page as written and dates it only when asked", async (t) => {
  const bodies: unknown[] = [];
  const transport = new FakeTransport().on("POST", `/api/playlists/${PLAYLIST}/pages`, (request) => { bodies.push(request.body); return playlistAnswer(); });
  const invoke = await cli(t, transport);
  const page = { id: "custom", canvas: { width: 1920, height: 1080, background: "#000000FF" }, transition: { type: "crossfade", duration_ms: 600 }, advance: { mode: "duration", after_ms: 5000 }, primitives: [] };
  assert.equal((await invoke(["playlist", "page", "add", PLAYLIST, "--file", "-"], JSON.stringify(page))).code, ExitCode.Success);
  assert.deepEqual(bodies[0], { page });
  assert.equal((await invoke(["playlist", "page", "add", PLAYLIST, "--file", "-", "--until", "2026-12-24", "--page-id", "renamed"], JSON.stringify(page))).code, ExitCode.Success);
  assert.deepEqual(bodies[1], { page: { ...page, id: "renamed", visibility: { enabled: true, until: "2026-12-25T00:00" } } });
});

test("playlist page replace --media reads the page and holds the write to the revision it read", async (t) => {
  const writes: { body: Record<string, unknown>; headers: Record<string, string | undefined> }[] = [];
  const stored = storedImagePage({ visibility: { enabled: true, from: "2026-12-01T00:00" } });
  const transport = new FakeTransport()
    .on("GET", `/api/media/${VIDEO}`, () => media("video"))
    .on("GET", `/api/playlists/${PLAYLIST}`, () => ({ status: 200, headers: {}, body: playlistBody([stored]) }))
    .on("PUT", `/api/playlists/${PLAYLIST}/pages/up-ab12cd34`, (request) => { writes.push({ body: request.body as never, headers: request.headers ?? {} }); return playlistAnswer(); });
  const invoke = await cli(t, transport);
  const answer = await invoke(["playlist", "page", "replace", PLAYLIST, "up-ab12cd34", "--media", VIDEO, "--until", "2026-12-31"]);
  assert.equal(answer.code, ExitCode.Success, answer.output);
  const { body, headers } = writes[0]!;
  assert.equal(headers["if-match"], '"7"', "the revision the stored page was read at");
  assert.equal(body.id, "up-ab12cd34");
  assert.deepEqual(body.advance, { mode: "media_end" });
  assert.deepEqual(body.visibility, { enabled: true, from: "2026-12-01T00:00", until: "2027-01-01T00:00" });
  // An explicit --expect-rev wins.
  await invoke(["playlist", "page", "replace", PLAYLIST, "up-ab12cd34", "--media", VIDEO, "--expect-rev", "5"]);
  assert.equal(writes[1]!.headers["if-match"], '"5"');
  // --always drops the dates; dates alone change nothing else.
  await invoke(["playlist", "page", "replace", PLAYLIST, "up-ab12cd34", "--always"]);
  assert.equal("visibility" in writes[2]!.body, false);
  assert.deepEqual((writes[2]!.body.primitives as { selector: unknown }[])[0]!.selector, { by: "id", media_id: IMAGE, one_at_a_time: false });
  // A page the playlist does not hold is refused before the write.
  const missing = await invoke(["playlist", "page", "replace", PLAYLIST, "nowhere", "--media", VIDEO]);
  assert.equal(missing.code, ExitCode.Usage, missing.output);
  assert.equal(writes.length, 3);
});

test("playlist page replace and remove validate their input before any request", async (t) => {
  const transport = new FakeTransport();
  const invoke = await cli(t, transport);
  for (const argv of [
    ["playlist", "page", "replace", PLAYLIST, "up-ab12cd34"],
    ["playlist", "page", "replace", PLAYLIST, "up-ab12cd34", "--media", VIDEO, "--file", "-"],
    ["playlist", "page", "replace", PLAYLIST, "up-ab12cd34", "--always", "--from", "2026-12-01"],
    ["playlist", "page", "replace", PLAYLIST, "bad id", "--always"],
    ["playlist", "page", "replace", "not-a-playlist", "up-ab12cd34", "--always"],
    ["playlist", "page", "replace", PLAYLIST, "up-ab12cd34", "--until", "next week"],
    ["playlist", "page", "remove", PLAYLIST, "1bad"],
    ["playlist", "page", "add", PLAYLIST],
    ["playlist", "page", "add", PLAYLIST, "--media", IMAGE, "--file", "-"],
    ["playlist", "page", "add", PLAYLIST, "--media", IMAGE, "--always"],
    ["playlist", "page", "add", PLAYLIST, "--media", "not-media"],
  ]) {
    const answer = await invoke(argv, "{}");
    assert.equal(answer.code, ExitCode.Usage, argv.join(" ") + " " + answer.output);
  }
  assert.equal(transport.calls.filter((call) => call.method !== "GET").length, 0);
});

test("playlist page remove sends a DELETE with the guard and the note; a page change under Propose is a pending review", async (t) => {
  const deletes: { headers: Record<string, string | undefined> }[] = [];
  const transport = new FakeTransport().on("DELETE", `/api/playlists/${PLAYLIST}/pages/up-ab12cd34`, (request) => {
    deletes.push({ headers: request.headers ?? {} });
    return { status: 202, headers: {}, body: { status: "pending_review", review: { id: "rvw_TEST", state: "pending", kind: "playlist_change", subject: { id: PLAYLIST, type: "playlist", name: "Lobby" }, url: "https://screenrig.ai/dashboard/reviews/rvw_TEST" } } };
  });
  const answer = await (await cli(t, transport))(["playlist", "page", "remove", PLAYLIST, "up-ab12cd34", "--expect-rev", "7", "--note", "Done"]);
  assert.equal(answer.code, ExitCode.Success, answer.output);
  assert.equal(deletes[0]!.headers["if-match"], '"7"');
  assert.equal(deletes[0]!.headers["screenrig-review-note"], "Done");
  const envelope = JSON.parse(answer.output);
  assert.equal(envelope.data.review.id, "rvw_TEST");
  assert.equal(envelope.warnings[0].code, "pending_review");
});

test("outside_upload_scope exits 3, names the scope and says what to do", async (t) => {
  // The project problem document: the error is errors[0].
  const document = { request_id: "req_TEST", instance: "urn:screenrig:request:req_TEST", errors: [{ status: 403, code: "outside_upload_scope", type: "https://screenrig.ai/problems/outside-upload-scope",
    title: "Outside this uploader's playlists and folders", detail: "Playlist pl_OTHER is not one of this uploader's playlists.",
    hint: "This uploader works only in the playlists and media folders errors[0].upload_scope lists.",
    upload_scope: { playlist_ids: [PLAYLIST], folder_ids: [FOLDER] } }] };
  const transport = new FakeTransport().on("DELETE", `/api/playlists/${PLAYLIST}/pages/up-ab12cd34`, () => ({ status: 403, headers: { "content-type": "application/problem+json" }, body: document }));
  const answer = await (await cli(t, transport))(["playlist", "page", "remove", PLAYLIST, "up-ab12cd34"]);
  assert.equal(answer.code, ExitCode.Auth, answer.output);
  const error = JSON.parse(answer.output).error;
  assert.equal(error.code, "outside_upload_scope");
  assert.deepEqual(error.upload_scope, { playlist_ids: [PLAYLIST], folder_ids: [FOLDER] });
  assert.match(error.hint, /upload_scope|playlists and media folders/);
  // The same document without a usable scope still normalizes.
  assert.equal(normalizeProblem({ ...document, errors: [{ ...document.errors[0], upload_scope: { playlist_ids: "x" } }] }).upload_scope, undefined);
});

test("invitations create --kind uploader sends the scope; its options need the kind", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const transport = new FakeTransport().on("POST", "/api/invitations", (request) => {
    bodies.push(request.body as Record<string, unknown>);
    return { status: 201, headers: { "cache-control": "private, no-store" }, body: { invitations: [{
      id: "inv_TEST", kind: "project_member", delivery: "email", status: "queued", recipient_email: "designer@example.com", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA",
      created_at: "2026-10-28T12:00:00Z", expires_at: "2026-11-04T12:00:00Z", upload_scope: { playlist_ids: [PLAYLIST], folder_ids: [FOLDER] },
    }] } };
  });
  const invoke = await cli(t, transport);
  const answer = await invoke(["invitations", "create", "--kind", "uploader", "--email", "designer@example.com", "--folder-id", FOLDER, "--playlist-id", PLAYLIST, "--access", "manage"]);
  assert.equal(answer.code, ExitCode.Success, answer.output);
  assert.deepEqual(bodies[0], { kind: "project_member", delivery: "email", emails: ["designer@example.com"], upload_scope: { playlist_ids: [PLAYLIST], folder_ids: [FOLDER], access: "manage" } });
  assert.deepEqual(JSON.parse(answer.output).data.invitations[0].upload_scope, { playlist_ids: [PLAYLIST], folder_ids: [FOLDER] });
  const link = await invoke(["invitations", "create", "--kind", "uploader", "--link", "--folder-id", `${FOLDER}`]);
  assert.notEqual(link.code, ExitCode.Success, "the stub does not answer a link, but the request was built");
  assert.deepEqual(bodies[1], { kind: "project_member", delivery: "link", upload_scope: { playlist_ids: [], folder_ids: [FOLDER] } });
  const before = bodies.length;
  for (const argv of [
    ["invitations", "create", "--kind", "uploader", "--email", "a@example.com"],
    ["invitations", "create", "--kind", "uploader", "--email", "a@example.com", "--folder-id", "Menus"],
    ["invitations", "create", "--kind", "uploader", "--email", "a@example.com", "--folder-id", FOLDER, "--playlist-id", "pl"],
    ["invitations", "create", "--email", "a@example.com", "--folder-id", FOLDER],
    ["invitations", "create", "--kind", "uploader", "--email", "a@example.com", "--folder-id", FOLDER, "--access", "owner"],
  ]) {
    assert.equal((await invoke(argv)).code, ExitCode.Usage, argv.join(" "));
  }
  assert.equal(bodies.length, before);
});

test("service-client create --uploader sends the scope and holds the capabilities to content and playlists", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const transport = new FakeTransport().on("POST", "/api/service-clients", (request) => {
    bodies.push(request.body as Record<string, unknown>);
    return { status: 201, headers: {}, body: { client: { id: "scl_AAAAAAAAAAAAAAAAAAAAAAAA", name: "Agency", access: "propose", state: "active", capabilities: ["content", "playlists"], keys: [], secrets: [{ id: "css_AAAAAAAAA", hint: "abcd" }],
      upload_scope: { playlist_ids: [PLAYLIST], folder_ids: [FOLDER] } }, secret: "sr_cs_thisSecretIsOnlyForTheFile" } };
  });
  const invoke = await cli(t, transport);
  const secretFile = path.join(invoke.directory, "agency.secret");
  const answer = await invoke(["service-client", "create", "--name", "Agency", "--uploader", "--folder-id", `${FOLDER}`, "--playlist-id", PLAYLIST, "--secret-file", secretFile]);
  assert.equal(answer.code, ExitCode.Success, answer.output);
  assert.deepEqual(bodies[0], { name: "Agency", secret: true, upload_scope: { playlist_ids: [PLAYLIST], folder_ids: [FOLDER] } });
  assert.doesNotMatch(answer.output, /sr_cs_/);
  assert.deepEqual(JSON.parse(answer.output).data.client.upload_scope, { playlist_ids: [PLAYLIST], folder_ids: [FOLDER] });
  const before = bodies.length;
  for (const argv of [
    ["service-client", "create", "--name", "A", "--uploader", "--secret-file", path.join(invoke.directory, "a.secret")],
    ["service-client", "create", "--name", "A", "--folder-id", FOLDER, "--secret-file", path.join(invoke.directory, "b.secret")],
    ["service-client", "create", "--name", "A", "--uploader", "--folder-id", FOLDER, "--capability", "screens", "--secret-file", path.join(invoke.directory, "c.secret")],
  ]) {
    assert.equal((await invoke(argv)).code, ExitCode.Usage, argv.join(" "));
  }
  assert.equal(bodies.length, before);
});
