import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import type { Screen } from "./adapters/protocol.js";
import { ApiClient, LIST_MAX_PAGES } from "./client.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { CliError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, listPage, memoryBackend } from "./transport/fake.js";
import type { TransportResponse } from "./transport/types.js";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number };
}

interface Env { fs: ConfigFs; cwd: string }

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(t: TestContext): Promise<Env> {
  const configDir = await testTemp("paging-cfg-");
  const cwd = await testTemp("paging-cwd-");
  t.after(() => Promise.all([rm(configDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]));
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr, now: () => new Date("2026-08-14T17:00:00.000Z"), sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, envelope };
}

const problemOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error.problem;
  }
  assert.fail("expected a CliError");
};

const rows = (count: number, prefix = "row") => Array.from({ length: count }, (_, index) => ({ id: `${prefix}_${index}` }));
const screenId = (letter: string) => `scr_${letter.repeat(24)}`;

function screen(id: string, extra: Partial<Screen> = {}): Screen {
  return {
    id, public_id: `pub_${id}`, label: id.slice(4, 8), state: "active", online: true, revision: 1, manifest_revision: 1,
    content_access_generation: 1, created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:00.000Z", ...extra,
  };
}

test("listAll follows next_cursor across pages, keeps the other query parameters, and merges the items", async () => {
  let served = 0;
  const transport = new FakeTransport().on("GET", "/api/media", (req) => {
    served += 1;
    return listPage(req, rows(5), 2, { "x-page": String(served) });
  });
  const query = { tag: "Lobby", primitive: "image", unset: undefined };
  const response = await new ApiClient({ transport }).listAll("/api/media", query);
  assert.deepEqual(response.body, { items: rows(5), next_cursor: null });
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-page"], "3", "the answer carries the last page's headers");
  assert.deepEqual(transport.calls.map((call) => call.query), [
    query,
    { ...query, after: "pg_2" },
    { ...query, after: "pg_4" },
  ]);
  assert.equal("after" in transport.calls[0]!.query!, false, "the first request starts at the newest rows, without a cursor");
});

test("listAll stops at a null, an absent, or an empty next_cursor", async () => {
  for (const [name, body] of [
    ["null", { items: rows(2), next_cursor: null }],
    ["absent", { items: rows(2) }],
    ["empty", { items: rows(2), next_cursor: "" }],
  ] as const) {
    const transport = new FakeTransport().on("GET", "/api/screens", () => ({ status: 200, headers: {}, body }));
    const response = await new ApiClient({ transport }).listAll("/api/screens");
    assert.deepEqual(response.body, { items: rows(2), next_cursor: null }, name);
    assert.equal(transport.calls.length, 1, `${name}: one request`);
    assert.equal(transport.calls[0]!.query, undefined, `${name}: no cursor on the first request`);
  }
});

test("listAll reads exactly LIST_MAX_PAGES pages and fails one page beyond, never returning part of a list", async () => {
  const listed = (count: number) => new FakeTransport().on("GET", "/api/media", (req) => listPage(req, rows(count), 1));
  const exact = listed(LIST_MAX_PAGES);
  const whole = await new ApiClient({ transport: exact }).listAll("/api/media");
  assert.equal((whole.body as { items: unknown[] }).items.length, LIST_MAX_PAGES);
  assert.equal(exact.calls.length, LIST_MAX_PAGES);

  const over = listed(LIST_MAX_PAGES + 1);
  const problem = await problemOf(new ApiClient({ transport: over }).listAll("/api/media"));
  assert.equal(problem.code, "unexpected_response");
  assert.match(problem.detail, new RegExp(`GET /api/media still offered another page after ${LIST_MAX_PAGES} pages \\(${LIST_MAX_PAGES} rows\\)`));
  assert.match(problem.hint ?? "", /Narrow the list/);
  assert.equal(over.calls.length, LIST_MAX_PAGES, "no request past the cap");

  let served = 0;
  const endless = new FakeTransport().on("GET", "/api/media", () => {
    served += 1;
    return { status: 200, headers: {}, body: { items: [], next_cursor: `cur_${served}` } };
  });
  assert.equal((await problemOf(new ApiClient({ transport: endless }).listAll("/api/media"))).code, "unexpected_response");
  assert.equal(served, LIST_MAX_PAGES, "a server that never ends the list is stopped at the cap");
});

test("listAll fails when a later page fails or is not a list, and returns a first answer that is not a list unchanged", async () => {
  const secondPage = (answer: TransportResponse) => new FakeTransport().on("GET", "/api/screens", (req) => req.query?.after === undefined
    ? { status: 200, headers: {}, body: { items: rows(1), next_cursor: "cur_1" } }
    : answer);
  const failed = await problemOf(new ApiClient({ transport: secondPage({
    status: 500, headers: { "content-type": "application/problem+json" }, body: { status: 500, code: "internal_error", title: "Internal error", detail: "The list failed." },
  }) }).listAll("/api/screens"));
  assert.equal(failed.code, "internal_error");
  const notAList = await problemOf(new ApiClient({ transport: secondPage({ status: 200, headers: {}, body: { next_cursor: null } }) }).listAll("/api/screens"));
  assert.equal(notAList.code, "unexpected_response");
  assert.match(notAList.detail, /GET \/api\/screens answered page 2 without an items array/);

  // The caller has always judged a malformed first answer itself.
  const body = { unexpected: true };
  const first = new FakeTransport().on("GET", "/api/screens", () => ({ status: 200, headers: { "x-request-id": "req_first" }, body }));
  const answer = await new ApiClient({ transport: first }).listAll("/api/screens");
  assert.equal(answer.body, body);
  assert.equal(answer.headers["x-request-id"], "req_first");
  assert.equal(first.calls.length, 1);
});

test("screen, media, app, playlist, and kv list return every page as one list", async (t) => {
  const env = await enrolled(t);
  const screens = ["A", "B", "C", "D", "E"].map((letter) => screen(screenId(letter)));
  const media = rows(5, "med");
  const apps = rows(3, "app");
  const playlists = rows(4, "pl");
  const kv = rows(3, "key");
  const kvRoute = "/api/applications/app_AAAAAAAAAAAAAAAAAAAAAAAA/kv";
  const transport = new FakeTransport()
    .on("GET", "/api/screens", (req) => listPage(req, screens, 2))
    .on("GET", "/api/media", (req) => listPage(req, media, 2))
    .on("GET", "/api/applications", (req) => listPage(req, apps, 2))
    .on("GET", "/api/playlists", (req) => listPage(req, playlists, 2))
    .on("GET", kvRoute, (req) => listPage(req, kv, 2));
  const cases: Array<[string[], string, unknown[], Record<string, string>]> = [
    [["screen", "list", "--state", "archived"], "/api/screens", screens, { state: "archived" }],
    [["media", "list", "--tag", "lobby", "--primitive", "image"], "/api/media", media, { tag: "lobby", primitive: "image" }],
    [["app", "list"], "/api/applications", apps, {}],
    [["playlist", "list"], "/api/playlists", playlists, {}],
    [["kv", "list", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA"], kvRoute, kv, {}],
  ];
  for (const [argv, route, all, query] of cases) {
    transport.calls.length = 0;
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.deepEqual(result.envelope.data, { items: all, next_cursor: null }, route);
    const asked = transport.calls.filter((call) => call.path === route);
    assert.equal(asked.length, Math.ceil(all.length / 2), `${route}: one request per page`);
    asked.forEach((call, index) => {
      assert.deepEqual(call.query ?? {}, index === 0 ? query : { ...query, after: `pg_${index * 2}` }, `${route} page ${index + 1}`);
    });
  }

  const human = await cli(["--human", "screen", "list"], transport, env);
  assert.equal(human.code, ExitCode.Success, human.stdout);
  for (const row of screens) assert.match(human.stdout, new RegExp(row.id), "the table lists screens from every page");
});

test("screen screenshot --tag finds the tagged screens on later pages", async (t) => {
  const env = await enrolled(t);
  const transport = memoryBackend({ listPageSize: 2 });
  const lobby = ["A", "B", "C", "D", "E"].map(screenId);
  for (const id of lobby) transport.putScreen!(screen(id, { tags: ["Lobby"] }));
  transport.putScreen!(screen(screenId("F"), { tags: ["Bar"] }));
  const result = await cli(["--json", "screen", "screenshot", "--tag", "Lobby", "--output", "shots"], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(result.envelope.data.matched, 5);
  assert.deepEqual(result.envelope.data.results.map((item: { screen_id: string }) => item.screen_id), lobby);
  const lists = transport.calls.filter((call) => call.method === "GET" && call.path === "/api/screens");
  assert.deepEqual(lists.map((call) => call.query), [{ tag: "Lobby" }, { tag: "Lobby", after: "pg_2" }, { tag: "Lobby", after: "pg_4" }]);
});

test("playlist update sees an assigned screen without a timezone on a later page", async (t) => {
  const env = await enrolled(t);
  const transport = memoryBackend({ listPageSize: 2 });
  const playlistId = "pl_AAAAAAAAAAAAAAAAAAAAAAAA";
  for (const letter of ["A", "B"]) transport.putScreen!(screen(screenId(letter), { playlist_id: playlistId, timezone: "America/Los_Angeles" }));
  transport.putScreen!(screen(screenId("C"), { playlist_id: playlistId }));
  const page = (id: string, visibility?: unknown) => ({
    id,
    canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
    transition: { type: "crossfade", duration_ms: 200 },
    advance: { mode: "duration", after_ms: 8000 },
    ...(visibility ? { visibility } : {}),
    primitives: [{
      id: "poster", primitive: "image", selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "contain",
    }],
  });
  const file = path.join(env.cwd, "scheduled.json");
  await writeFile(file, JSON.stringify({
    name: "Lobby",
    pages: [page("always"), page("evenings", { enabled: true, windows: [{ days: ["fri", "sat"], start: "18:00", end: "02:00" }] })],
  }));
  const result = await cli(["--json", "playlist", "update", playlistId, file, "--expect-rev", "1"], transport, env);
  assert.equal(result.code, ExitCode.Usage, result.stdout);
  assert.match(result.envelope.error!.detail, new RegExp(`${screenId("C")} has no timezone`));
  assert.equal(transport.calls.some((call) => call.method === "PUT"), false, "the refusal comes before any write");
});

test("media upload reuses its earlier upload from a later page of the media list", async (t) => {
  const env = await enrolled(t);
  const bytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]);
  const file = path.join(env.cwd, "lobby-loop.mp4");
  await writeFile(file, bytes);
  const row = (id: string, sha256: string) => ({
    id, filename: "lobby-loop.mp4", source_filename: "lobby-loop.mp4", primitive: "video", content_type: "video/mp4",
    operation_id: "op_EARLIER", sha256, bytes: bytes.length, revision: 1, state: "ready",
    created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:01.000Z",
  });
  const earlier = row("med_EARLIERAAAAAAAAAAAAAAAAA", createHash("sha256").update(bytes).digest("hex"));
  const transport = new FakeTransport()
    .on("GET", "/api/media", (req) => listPage(req, [row("med_OTHERAAAAAAAAAAAAAAAAAAA", "0".repeat(64)), earlier], 1))
    .on("GET", "/api/operations/op_EARLIER", () => ({
      status: 200, headers: {},
      body: { id: "op_EARLIER", kind: "media.upload", state: "succeeded", created_at: earlier.created_at, updated_at: earlier.updated_at, result: { media_id: earlier.id } },
    }));
  const result = await cli(["--json", "media", "upload", file, "--no-transcode"], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(result.envelope.data.reused, true);
  assert.equal(result.envelope.data.media_id, earlier.id);
  assert.equal(transport.calls.some((call) => call.path === "/api/media/uploads"), false, "nothing was uploaded again");
  const lists = transport.calls.filter((call) => call.path === "/api/media");
  assert.deepEqual(lists.map((call) => call.query), [{ primitive: "video" }, { primitive: "video", after: "pg_1" }]);
});

test("media upload reuses normalized media by its original upload identity", async (t) => {
  const env = await enrolled(t);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const file = path.join(env.cwd, "oriented-photo.jpg");
  await writeFile(file, bytes);
  const row = (id: string, sha256: string) => ({
    id, filename: "oriented-photo.jpg", source_filename: "oriented-photo.jpg", primitive: "image", content_type: "image/webp",
    operation_id: "op_EARLIER", sha256: "f".repeat(64), bytes: 80, upload_source: { filename: "oriented-photo.jpg", source_filename: "oriented-photo.jpg", content_type: "image/jpeg", sha256, bytes: bytes.length }, revision: 1, state: "ready",
    created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:01.000Z",
  });
  const earlier = row("med_EARLIERAAAAAAAAAAAAAAAAA", createHash("sha256").update(bytes).digest("hex"));
  const transport = new FakeTransport()
    .on("GET", "/api/media", (req) => listPage(req, [row("med_OTHERAAAAAAAAAAAAAAAAAAA", "0".repeat(64)), earlier], 1))
    .on("GET", "/api/operations/op_EARLIER", () => ({
      status: 200, headers: {},
      body: { id: "op_EARLIER", kind: "media.upload", state: "succeeded", created_at: earlier.created_at, updated_at: earlier.updated_at, result: { media_id: earlier.id } },
    }));
  const result = await cli(["--json", "media", "upload", file, "--no-transcode"], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(result.envelope.data.reused, true);
  assert.equal(result.envelope.data.media_id, earlier.id);
  assert.equal(transport.calls.some((call) => call.path === "/api/media/uploads"), false, "nothing was uploaded again");
  const lists = transport.calls.filter((call) => call.path === "/api/media");
  assert.deepEqual(lists.map((call) => call.query), [{ primitive: "image" }, { primitive: "image", after: "pg_1" }]);
});
