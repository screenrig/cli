import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parseArgv } from "./argv.js";
import { ApiClient } from "./client.js";
import { USAGE } from "./commands.js";
import { run, type CliRuntime } from "./main.js";
import {
  PLAYLIST_BUNDLE_MANIFEST,
  PLAYLIST_BUNDLE_PLAYLIST,
  PLAYLIST_BUNDLE_SCHEMA,
  deriveBundleIdempotencyKey,
  exportPlaylistBundle,
  importPlaylistBundle,
  normalizePlaylistForBundle,
  preflightPlaylistBundle,
  type PlaylistBundleManifest,
} from "./playlist-bundle.js";
import { CliError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mediaPlacement(selector: Record<string, unknown>, items?: string[]) {
  return {
    id: "hero",
    content: {
      type: "image",
      selector,
      ...(items ? { items: items.map((media_id) => ({ media_id, intrinsic_size: { width: 1, height: 1 } })) } : {}),
      alt: "Hero",
    },
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
    layer: 0,
    content_fit: "fill",
    controller: false,
  };
}

function playlist(placement: Record<string, unknown>) {
  return {
    id: "pl_SOURCE",
    name: "Portable playlist",
    revision: 7,
    comments: { private: "excluded" },
    pages: [{
      id: "page",
      canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
      transition: { type: "crossfade", duration_ms: 200 },
      advance: { mode: "duration", after_ms: 5000 },
      comments: { private: "excluded" },
      placements: [placement, {
        id: "web",
        content: { type: "iframe", src: "https://example.com/", title: "Example" },
        rect: { x: 0, y: 0, width: 100, height: 100 },
        layer: 1,
        content_fit: "fill",
        controller: false,
      }],
    }],
  };
}

function remoteMedia(id: string, bytes: Uint8Array, overrides: Record<string, unknown> = {}) {
  return {
    id,
    filename: "hero.png",
    kind: "image",
    content_type: "image/png",
    operation_id: `op_${id}`,
    sha256: sha(bytes),
    bytes: bytes.byteLength,
    width: 1,
    height: 1,
    revision: 1,
    state: "ready",
    created_at: "2026-08-21T00:00:00Z",
    updated_at: "2026-08-21T00:00:00Z",
    ...overrides,
  };
}

function byteStream(bytes: Uint8Array, split = 2) {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes.subarray(0, split);
      yield bytes.subarray(split);
    },
  };
}

function exportTransport(bytes: Uint8Array, options: { playlist?: unknown; headers?: Record<string, string>; body?: Uint8Array } = {}) {
  const id = "med_SOURCE";
  const item = remoteMedia(id, bytes);
  const headers = {
    "content-type": "image/png",
    "content-length": String(bytes.byteLength),
    etag: `"${sha(bytes)}"`,
    ...options.headers,
  };
  return new FakeTransport()
    .on("GET", "/api/v1/playlists/pl_SOURCE", () => ({
      status: 200,
      headers: {},
      body: options.playlist ?? playlist(mediaPlacement({ by: "tag", tag: "Lobby", one_at_a_time: false }, [id])),
    }))
    .on("GET", `/api/v1/media/${id}`, () => ({ status: 200, headers: {}, body: item }))
    .on("HEAD", `/api/v1/media/${id}/content`, () => ({ status: 200, headers, body: undefined }))
    .onDownload("GET", `/api/v1/media/${id}/content`, () => ({
      status: 200,
      headers,
      body: byteStream(options.body ?? bytes),
    }));
}

test("normalizes server playlists, snapshots dynamic selectors, preserves iframes, and removes response-only fields", () => {
  const normalized = normalizePlaylistForBundle(playlist(
    mediaPlacement({ by: "tag", tag: "Lobby", one_at_a_time: true }, ["med_B", "med_A"]),
  ));
  assert.deepEqual(normalized.mediaIds, ["med_A", "med_B"]);
  const text = JSON.stringify(normalized.playlist);
  assert.doesNotMatch(text, /comments|controller|"items"|"by":"tag"/);
  assert.match(text, /"by":"ids","media_ids":\["med_B","med_A"\],"one_at_a_time":true/);
  assert.match(text, /"type":"iframe"/);
});

test("rejects application placements before any media lookup or local output", async () => {
  const dir = await testTemp("bundle-app-");
  const output = path.join(dir, "export");
  const source = playlist({
    id: "app",
    content: { type: "application", release_id: "rel_1" },
    rect: { x: 0, y: 0, width: 1, height: 1 },
    layer: 0,
    content_fit: "fill",
    controller: true,
  });
  const transport = new FakeTransport().on("GET", "/api/v1/playlists/pl_SOURCE", () => ({ status: 200, headers: {}, body: source }));
  const client = new ApiClient({ transport, token: "token" });
  await assert.rejects(() => exportPlaylistBundle({ playlistId: "pl_SOURCE", outputDirectory: output, client }), /application placements/);
  assert.deepEqual(transport.calls.map((call) => `${call.method} ${call.path}`), ["GET /api/v1/playlists/pl_SOURCE"]);
  await assert.rejects(() => lstat(output), /ENOENT/);
  await rm(dir, { recursive: true, force: true });
});

test("exports through a private sibling, streams bytes, verifies headers and hash, and publishes an atomic private bundle", async () => {
  const dir = await testTemp("bundle-export-");
  const output = path.join(dir, "portable");
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
  const transport = exportTransport(bytes);
  const result = await exportPlaylistBundle({
    playlistId: "pl_SOURCE",
    outputDirectory: output,
    client: new ApiClient({ transport, token: "token" }),
  });
  assert.equal(result.media_count, 1);
  assert.deepEqual(new Uint8Array(await readFile(path.join(output, "media", `${sha(bytes)}.png`))), bytes);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(output, "media"))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(output, PLAYLIST_BUNDLE_MANIFEST))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(output, PLAYLIST_BUNDLE_PLAYLIST))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(output, "media", `${sha(bytes)}.png`))).mode & 0o777, 0o600);
  const savedPlaylist = JSON.parse(await readFile(path.join(output, PLAYLIST_BUNDLE_PLAYLIST), "utf8"));
  const savedManifest = JSON.parse(await readFile(path.join(output, PLAYLIST_BUNDLE_MANIFEST), "utf8"));
  assert.equal(savedPlaylist.pages[0].placements[0].content.selector.by, "id");
  assert.equal(savedManifest.selector_policy, "snapshot");
  assert.equal(savedManifest.comments_policy, "excluded");
  assert.deepEqual(transport.calls.map((call) => call.method), ["GET", "GET", "HEAD", "GET"]);
  await rm(dir, { recursive: true, force: true });
});

test("export fails closed on existing destination and cleans temporary output on stream/header/hash mismatch", async () => {
  const dir = await testTemp("bundle-export-fail-");
  const existing = path.join(dir, "exists");
  await mkdir(existing);
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const existingTransport = exportTransport(bytes);
  await assert.rejects(() => exportPlaylistBundle({
    playlistId: "pl_SOURCE",
    outputDirectory: existing,
    client: new ApiClient({ transport: existingTransport, token: "token" }),
  }), /already exists/);
  assert.deepEqual(existingTransport.calls.map((call) => call.path), []);

  for (const [name, transport] of [
    ["type", exportTransport(bytes, { headers: { "content-type": "video/mp4" } })],
    ["hash", exportTransport(bytes, { body: Uint8Array.from([1, 2, 3, 9]) })],
  ] as const) {
    const output = path.join(dir, name);
    await assert.rejects(() => exportPlaylistBundle({
      playlistId: "pl_SOURCE",
      outputDirectory: output,
      client: new ApiClient({ transport, token: "token" }),
    }));
    await assert.rejects(() => lstat(output), /ENOENT/);
    const leftovers = (await import("node:fs/promises")).readdir(dir);
    assert.equal((await leftovers).some((entry) => entry.startsWith(`.${name}.tmp-`)), false);
  }
  await rm(dir, { recursive: true, force: true });
});

interface BundleSource {
  id: string;
  filename: string;
  bytes: Uint8Array;
  tag?: string;
}

async function writeBundle(root: string, sources: BundleSource[]): Promise<PlaylistBundleManifest> {
  await mkdir(path.join(root, "media"), { recursive: true });
  const placements = sources.map((source, index) => ({
    ...mediaPlacement({ by: "id", media_id: source.id }),
    id: `media_${index}`,
  })).map(({ controller: _controller, ...placement }) => placement);
  const playlistJson = {
    name: "Imported",
    pages: [{
      id: "page",
      canvas: { width: 1, height: 1, background: "#000000FF" },
      transition: { type: "crossfade", duration_ms: 200 },
      advance: { mode: "duration", after_ms: 1000 },
      placements,
    }],
  };
  const media = sources.map((source) => ({
    source_id: source.id,
    path: `media/${sha(source.bytes)}.png`,
    filename: source.filename,
    content_type: "image/png",
    bytes: source.bytes.byteLength,
    sha256: sha(source.bytes),
    ...(source.tag ? { tag: source.tag } : {}),
  }));
  for (const [index, source] of sources.entries()) {
    await writeFile(path.join(root, media[index]!.path), source.bytes, { mode: 0o600 });
  }
  const manifest: PlaylistBundleManifest = {
    schema: PLAYLIST_BUNDLE_SCHEMA,
    selector_policy: "snapshot",
    comments_policy: "excluded",
    playlist: { source_id: "pl_SOURCE", source_revision: 7, path: PLAYLIST_BUNDLE_PLAYLIST },
    media,
  };
  await writeFile(path.join(root, PLAYLIST_BUNDLE_PLAYLIST), `${JSON.stringify(playlistJson)}\n`, { mode: 0o600 });
  await writeFile(path.join(root, PLAYLIST_BUNDLE_MANIFEST), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return manifest;
}

async function replaceManifest(root: string, mutate: (manifest: PlaylistBundleManifest) => void): Promise<void> {
  const filename = path.join(root, PLAYLIST_BUNDLE_MANIFEST);
  const manifest = JSON.parse(await readFile(filename, "utf8")) as PlaylistBundleManifest;
  mutate(manifest);
  await writeFile(filename, JSON.stringify(manifest));
}

async function replacePlaylist(root: string, mutate: (playlist: any) => void): Promise<void> {
  const filename = path.join(root, PLAYLIST_BUNDLE_PLAYLIST);
  const playlist = JSON.parse(await readFile(filename, "utf8"));
  mutate(playlist);
  await writeFile(filename, JSON.stringify(playlist));
}

test("preflight verifies exact files and ignores unlisted file contents", async () => {
  const dir = await testTemp("bundle-preflight-");
  const source = { id: "med_SOURCE", filename: "hero.png", bytes: Uint8Array.from([1, 2, 3]) };
  await writeBundle(dir, [source]);
  await symlink("missing-secret", path.join(dir, "unlisted-link"));
  const result = await preflightPlaylistBundle(dir);
  assert.equal(result.manifest.media[0]?.sha256, sha(source.bytes));
  assert.equal(result.manifest.selector_policy, "snapshot");
  assert.equal(result.manifest.comments_policy, "excluded");
  await result.close();
  await rm(dir, { recursive: true, force: true });
});

test("preflight rejects traversal, backslash, absolute, control, and noncanonical media paths", async () => {
  for (const hostile of ["../escape.png", "media\\escape.png", "/tmp/escape.png", "media/control\u0001.png", "media/other.png"]) {
    const dir = await testTemp("bundle-path-");
    await writeBundle(dir, [{ id: "med_SOURCE", filename: "hero.png", bytes: Uint8Array.from([1]) }]);
    await replaceManifest(dir, (manifest) => { manifest.media[0]!.path = hostile; });
    await assert.rejects(() => preflightPlaylistBundle(dir), CliError, hostile);
    await rm(dir, { recursive: true, force: true });
  }
});

test("preflight validates the complete playlist write surface and media kinds before network use", async () => {
  const cases: Array<[string, (playlist: any) => void]> = [
    ["canvas", (value) => { value.pages[0].canvas.width = 0; }],
    ["transition", (value) => { value.pages[0].transition.duration_ms = 60_001; }],
    ["advance", (value) => { value.pages[0].advance.after_ms = 999; }],
    ["visibility", (value) => { value.pages[0].visibility = { enabled: true }; }],
    ["rect", (value) => { value.pages[0].placements[0].rect.width = 0; }],
    ["layer", (value) => { value.pages[0].placements[0].layer = 1025; }],
    ["content_fit", (value) => { value.pages[0].placements[0].content_fit = "stretch"; }],
    ["enter", (value) => { value.pages[0].placements[0].enter = { type: "spin" }; }],
    ["iframe", (value) => {
      value.pages[0].placements[0].content = { type: "iframe", src: "http://127.0.0.1/private", title: "Private" };
      value.pages[0].placements[0].content_fit = "fill";
    }],
    ["media-kind", (value) => {
      value.pages[0].placements[0].content = {
        type: "video",
        selector: { by: "id", media_id: "med_SOURCE" },
        muted: true,
        loop: false,
      };
    }],
  ];
  for (const [name, mutate] of cases) {
    const dir = await testTemp(`bundle-write-${name}-`);
    await writeBundle(dir, [{ id: "med_SOURCE", filename: "hero.png", bytes: Uint8Array.from([1, 2, 3]) }]);
    await replacePlaylist(dir, mutate);
    await assert.rejects(() => preflightPlaylistBundle(dir), CliError, name);
    await rm(dir, { recursive: true, force: true });
  }
});

test("preflight rejects bundle roots or listed media that are symlinks, hardlinks, sparse, or non-regular", async () => {
  const bytes = Uint8Array.from([4, 5, 6]);

  const symlinkDir = await testTemp("bundle-symlink-");
  const manifest = await writeBundle(symlinkDir, [{ id: "med_SOURCE", filename: "hero.png", bytes }]);
  const mediaPath = path.join(symlinkDir, manifest.media[0]!.path);
  await rm(mediaPath);
  await symlink(path.join(symlinkDir, PLAYLIST_BUNDLE_PLAYLIST), mediaPath);
  await assert.rejects(() => preflightPlaylistBundle(symlinkDir), /symlink/);

  const hardlinkDir = await testTemp("bundle-hardlink-");
  const hardManifest = await writeBundle(hardlinkDir, [{ id: "med_SOURCE", filename: "hero.png", bytes }]);
  await link(path.join(hardlinkDir, hardManifest.media[0]!.path), path.join(hardlinkDir, "other-link"));
  await assert.rejects(() => preflightPlaylistBundle(hardlinkDir), /hardlink/);

  const sparseDir = await testTemp("bundle-sparse-");
  const sparseManifest = await writeBundle(sparseDir, [{ id: "med_SOURCE", filename: "hero.png", bytes }]);
  const sparsePath = path.join(sparseDir, sparseManifest.media[0]!.path);
  const sparseHandle = await open(sparsePath, "w");
  await sparseHandle.truncate(1024 * 1024);
  await sparseHandle.close();
  await replaceManifest(sparseDir, (value) => { value.media[0]!.bytes = 1024 * 1024; });
  await assert.rejects(() => preflightPlaylistBundle(sparseDir), /sparse/);

  const specialDir = await testTemp("bundle-special-");
  const specialManifest = await writeBundle(specialDir, [{ id: "med_SOURCE", filename: "hero.png", bytes }]);
  const specialPath = path.join(specialDir, specialManifest.media[0]!.path);
  await rm(specialPath);
  await mkdir(specialPath);
  await assert.rejects(() => preflightPlaylistBundle(specialDir), /regular file/);

  const rootLink = `${specialDir}-link`;
  await symlink(specialDir, rootLink);
  await assert.rejects(() => preflightPlaylistBundle(rootLink), /real directory/);

  const ancestorDir = await testTemp("bundle-ancestor-");
  const realParent = path.join(ancestorDir, "real-parent");
  const nestedBundle = path.join(realParent, "bundle");
  await mkdir(nestedBundle, { recursive: true });
  await writeBundle(nestedBundle, [{ id: "med_SOURCE", filename: "hero.png", bytes }]);
  const linkedParent = path.join(ancestorDir, "linked-parent");
  await symlink(realParent, linkedParent);
  await assert.rejects(() => preflightPlaylistBundle(path.join(linkedParent, "bundle")), /symlinked ancestor/);

  const containedDir = await testTemp("bundle-contained-");
  await writeBundle(containedDir, [{ id: "med_SOURCE", filename: "hero.png", bytes }]);
  await rename(path.join(containedDir, "media"), path.join(containedDir, "real-media"));
  await symlink("real-media", path.join(containedDir, "media"));
  await assert.rejects(() => preflightPlaylistBundle(containedDir), /symlink-free bundle root/);

  await Promise.all([symlinkDir, hardlinkDir, sparseDir, specialDir, rootLink, ancestorDir, containedDir].map((entry) => rm(entry, { recursive: true, force: true })));
});

function importTransport(existing: unknown[], uploadedIds: string[] = []) {
  const transport = new FakeTransport();
  let declaration = 0;
  const operations = new Map<string, string>();
  transport.on("GET", "/api/v1/media", () => ({ status: 200, headers: {}, body: { items: existing } }));
  transport.on("GET", /^\/api\/v1\/playlists\/pl_/, (req) => ({
    status: 200,
    headers: { etag: '"8"' },
    body: { id: req.path.split("/").pop(), name: "Target", revision: 8, pages: [] },
  }));
  transport.on("POST", "/api/v1/media/uploads", () => {
    const index = declaration++;
    const operationId = `op_${index}`;
    operations.set(operationId, uploadedIds[index] ?? `med_UPLOADED_${index}`);
    return {
      status: 201,
      headers: { "cache-control": "private, no-store" },
      body: {
        id: `upload_${index}`,
        operation: { id: operationId, kind: "media.upload", state: "queued", created_at: "2026-08-21T00:00:00Z", updated_at: "2026-08-21T00:00:00Z" },
        upload_url: `https://storage.invalid/${index}`,
        method: "PUT",
        headers: { "content-type": "image/png" },
        expires_at: "2099-01-01T00:00:00Z",
      },
    };
  });
  transport.on("POST", /^\/api\/v1\/media\/uploads\/upload_\d+\/commit$/, (req) => {
    const index = req.path.match(/upload_(\d+)/)?.[1] ?? "0";
    return { status: 202, headers: {}, body: { id: `op_${index}`, state: "queued" } };
  });
  transport.on("GET", /^\/api\/v1\/operations\/op_\d+$/, (req) => {
    const operationId = req.path.split("/").pop()!;
    return {
      status: 200,
      headers: {},
      body: { id: operationId, kind: "media.upload", state: "succeeded", created_at: "", updated_at: "", result: { media_id: operations.get(operationId) } },
    };
  });
  transport.on("POST", "/api/v1/playlists", (req) => ({ status: 201, headers: {}, body: { ...(req.body as object), id: "pl_IMPORTED", revision: 1 } }));
  transport.on("PUT", /^\/api\/v1\/playlists\//, (req) => ({ status: 200, headers: {}, body: { ...(req.body as object), id: req.path.split("/").pop(), revision: 9 } }));
  return transport;
}

function runtimeForImport(signedBodies: Uint8Array[]): CliRuntime {
  return {
    argv: [], env: {}, stdout: new PassThrough(), stderr: new PassThrough(), now: () => new Date("2026-08-21T00:00:00Z"),
    sleep: async () => undefined, homedir: () => "/tmp", cwd: () => "/tmp",
    fs: { mkdir, open, rename, rm, chmod, stat, homedir: () => "/tmp", env: {} },
    signedRawPut: async (request) => {
      const chunks: Uint8Array[] = [];
      if (request.body instanceof Uint8Array) chunks.push(request.body);
      else for await (const chunk of request.body) chunks.push(chunk);
      signedBodies.push(Buffer.concat(chunks));
      return { status: 200 };
    },
  };
}

test("import dedupes exact media injectively, rewrites selectors, and performs no remote deletion", async () => {
  const dir = await testTemp("bundle-dedupe-");
  const bytes = Uint8Array.from([7, 8, 9]);
  await writeBundle(dir, [
    { id: "med_SOURCE_A", filename: "hero.png", bytes, tag: "Lobby" },
    { id: "med_SOURCE_B", filename: "hero.png", bytes, tag: "Lobby" },
  ]);
  const existing = [
    remoteMedia("med_Z_LAST", bytes, { tag: "Lobby" }),
    remoteMedia("med_SOURCE_A", bytes, { tag: "Lobby" }),
    remoteMedia("med_A_FIRST", bytes, { tag: "Lobby" }),
  ];
  const transport = importTransport(existing);
  const result = await importPlaylistBundle({
    directory: dir,
    client: new ApiClient({ transport, token: "token", idempotencyKey: "bundle-base-key" }),
    runtime: runtimeForImport([]),
  });
  assert.equal(result.media.reused, 2);
  const create = transport.calls.find((call) => call.method === "POST" && call.path === "/api/v1/playlists")!;
  const text = JSON.stringify(create.body);
  assert.match(text, /med_SOURCE_A/);
  assert.match(text, /med_A_FIRST/);
  assert.doesNotMatch(text, /med_Z_LAST/);
  assert.equal(transport.calls.some((call) => call.method === "DELETE"), false);
  assert.equal(transport.calls.some((call) => call.path === "/api/v1/media/uploads"), false);
  await rm(dir, { recursive: true, force: true });
});

test("import uploads missing media serially without transcoding, preserves declaration metadata, and uses distinct stable keys", async () => {
  const dir = await testTemp("bundle-upload-");
  const first = Uint8Array.from([1, 3, 5]);
  const second = Uint8Array.from([2, 4, 6, 8]);
  await writeBundle(dir, [
    { id: "med_SOURCE_A", filename: "first.png", bytes: first, tag: "A1" },
    { id: "med_SOURCE_B", filename: "second.png", bytes: second },
  ]);
  const transport = importTransport([], ["med_NEW_A", "med_NEW_B"]);
  const signedBodies: Uint8Array[] = [];
  const client = new ApiClient({ transport, token: "token", idempotencyKey: "bundle-base-key" });
  const result = await importPlaylistBundle({ directory: dir, client, runtime: runtimeForImport(signedBodies) });
  assert.equal(result.media.uploaded, 2);
  assert.deepEqual(signedBodies.map((value) => [...value]), [[...first], [...second]]);
  const declares = transport.calls.filter((call) => call.path === "/api/v1/media/uploads");
  assert.deepEqual(declares.map((call) => call.body), [
    { filename: "first.png", content_type: "image/png", bytes: 3, sha256: sha(first), tag: "A1" },
    { filename: "second.png", content_type: "image/png", bytes: 4, sha256: sha(second) },
  ]);
  const keys = transport.calls.filter((call) => call.method === "POST").map((call) => call.headers?.["idempotency-key"]);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(declares[0]?.headers?.["idempotency-key"], deriveBundleIdempotencyKey("bundle-base-key", "media-declare", "med_SOURCE_A"));
  const methods = transport.calls.map((call) => `${call.method} ${call.path}`);
  assert.ok(methods.indexOf("POST /api/v1/media/uploads/upload_0/commit") < methods.indexOf("POST /api/v1/media/uploads" , methods.indexOf("POST /api/v1/media/uploads") + 1));
  assert.equal(transport.calls.at(-1)?.path, "/api/v1/playlists");
  await rm(dir, { recursive: true, force: true });
});

test("import uploads the verified open file even when the bundle path is replaced after preflight", async () => {
  const dir = await testTemp("bundle-replace-");
  const original = Uint8Array.from([1, 3, 5, 7]);
  const replacement = Uint8Array.from([9, 9, 9, 9]);
  const manifest = await writeBundle(dir, [{ id: "med_SOURCE", filename: "hero.png", bytes: original }]);
  const filename = path.join(dir, manifest.media[0]!.path);
  const transport = importTransport([], ["med_NEW"]);
  const signedBodies: Uint8Array[] = [];
  await importPlaylistBundle({
    directory: dir,
    client: new ApiClient({ transport, token: "token", idempotencyKey: "bundle-base-key" }),
    runtime: runtimeForImport(signedBodies),
    beforePlaylistWrite: async () => {
      await rename(filename, `${filename}.replaced`);
      await writeFile(filename, replacement, { mode: 0o600 });
    },
  });
  assert.deepEqual(signedBodies.map((value) => [...value]), [[...original]]);
  await rm(dir, { recursive: true, force: true });
});

test("import validates create/update flags and all local bytes before any network mutation", async () => {
  const dir = await testTemp("bundle-pre-network-");
  await writeBundle(dir, [{ id: "med_SOURCE", filename: "hero.png", bytes: Uint8Array.from([1, 2]) }]);
  const transport = importTransport([]);
  const common = { directory: dir, client: new ApiClient({ transport, token: "token" }), runtime: runtimeForImport([]) };
  await assert.rejects(() => importPlaylistBundle({ ...common, updateId: "pl_TARGET" }), /requires --if-match/);
  await assert.rejects(() => importPlaylistBundle({ ...common, ifMatch: "1" }), /requires --update/);
  await assert.rejects(() => importPlaylistBundle({ ...common, updateId: "pl_TARGET", ifMatch: "not-a-revision" }), /--if-match/);
  assert.equal(transport.calls.length, 0);
  await writeFile(path.join(dir, (JSON.parse(await readFile(path.join(dir, PLAYLIST_BUNDLE_MANIFEST), "utf8")) as PlaylistBundleManifest).media[0]!.path), Uint8Array.from([9, 9]));
  await assert.rejects(() => importPlaylistBundle(common), /SHA-256 mismatch/);
  assert.equal(transport.calls.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test("update target revision and timezone preflight finish before any media upload", async () => {
  const dir = await testTemp("bundle-update-preflight-");
  await writeBundle(dir, [{ id: "med_SOURCE", filename: "hero.png", bytes: Uint8Array.from([1, 2]) }]);

  const revisionTransport = importTransport([]);
  await assert.rejects(() => importPlaylistBundle({
    directory: dir,
    client: new ApiClient({ transport: revisionTransport, token: "token" }),
    runtime: runtimeForImport([]),
    updateId: "pl_TARGET",
    ifMatch: "7",
  }), /revision 8/);
  assert.deepEqual(revisionTransport.calls.map((call) => `${call.method} ${call.path}`), ["GET /api/v1/playlists/pl_TARGET"]);

  const timezoneTransport = importTransport([]);
  await assert.rejects(() => importPlaylistBundle({
    directory: dir,
    client: new ApiClient({ transport: timezoneTransport, token: "token" }),
    runtime: runtimeForImport([]),
    updateId: "pl_TARGET",
    ifMatch: "8",
    beforePlaylistWrite: async () => { throw new Error("timezone preflight failed"); },
  }), /timezone preflight failed/);
  assert.deepEqual(timezoneTransport.calls.map((call) => `${call.method} ${call.path}`), ["GET /api/v1/playlists/pl_TARGET"]);
  await rm(dir, { recursive: true, force: true });
});

test("update carries If-Match, and a later failure reports partial mutation without deletion or playlist write", async () => {
  const updateDir = await testTemp("bundle-update-");
  const bytes = Uint8Array.from([1]);
  await writeBundle(updateDir, [{ id: "med_SOURCE", filename: "hero.png", bytes }]);
  const existing = [remoteMedia("med_EXISTING", bytes)];
  const updateTransport = importTransport(existing);
  await importPlaylistBundle({
    directory: updateDir,
    client: new ApiClient({ transport: updateTransport, token: "token", idempotencyKey: "bundle-base-key" }),
    runtime: runtimeForImport([]),
    updateId: "pl_TARGET",
    ifMatch: "8",
  });
  const update = updateTransport.calls.find((call) => call.method === "PUT" && call.path === "/api/v1/playlists/pl_TARGET");
  assert.equal(update?.headers?.["if-match"], '"8"');

  const partialDir = await testTemp("bundle-partial-");
  await writeBundle(partialDir, [
    { id: "med_SOURCE_A", filename: "a.png", bytes: Uint8Array.from([1]) },
    { id: "med_SOURCE_B", filename: "b.png", bytes: Uint8Array.from([2]) },
  ]);
  const partial = importTransport([], ["med_NEW_A", "med_NEW_B"]);
  const partialRuntime = runtimeForImport([]);
  let signedPuts = 0;
  partialRuntime.signedRawPut = async (request) => {
    signedPuts += 1;
    if (signedPuts === 2) throw new Error("second upload failed");
    if (!(request.body instanceof Uint8Array)) for await (const _chunk of request.body) { /* drain */ }
    return { status: 200 };
  };
  await assert.rejects(
    () => importPlaylistBundle({
      directory: partialDir,
      client: new ApiClient({ transport: partial, token: "token", idempotencyKey: "bundle-base-key" }),
      runtime: partialRuntime,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.problem.code, "bundle_import_partial");
      assert.match(error.problem.detail, /No playlist write was started, and no media was deleted/);
      assert.deepEqual(error.problem.errors, [{ code: "confirmed_media_ready", media_id: "med_NEW_A" }]);
      return true;
    },
  );
  assert.equal(partial.calls.some((call) => call.method === "DELETE"), false);
  assert.equal(partial.calls.some((call) => /^\/api\/v1\/playlists/.test(call.path)), false);
  await Promise.all([updateDir, partialDir].map((entry) => rm(entry, { recursive: true, force: true })));
});

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

test("command parser and JSON help expose playlist export/import including update", async () => {
  const parsed = parseArgv(["playlist", "import", "./bundle", "--update", "pl_TARGET", "--if-match", "8"]);
  assert.equal(parsed.flags.update, "pl_TARGET");
  assert.equal(parsed.flags["if-match"], "8");
  assert.match(USAGE, /playlist export <id> --output DIRECTORY/);
  assert.match(USAGE, /playlist import <directory> \[--update ID --if-match REVISION\]/);

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = collect(stdout);
  const errors = collect(stderr);
  const runtime: CliRuntime = {
    argv: ["--json", "--help"], env: {}, stdout, stderr, now: () => new Date(), sleep: async () => undefined,
    homedir: () => "/tmp", cwd: () => "/tmp", transport: new FakeTransport(),
    fs: { mkdir, open, rename, rm, chmod, stat, homedir: () => "/tmp", env: {} },
  };
  assert.equal(await run(runtime), 0);
  stdout.end(); stderr.end();
  const envelope = JSON.parse(await output);
  assert.match(envelope.data.usage, /playlist export/);
  assert.equal(await errors, "");
});
