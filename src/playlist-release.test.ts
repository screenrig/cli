import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient } from "./client.js";
import { FakeTransport } from "./transport/fake.js";
import { preparePlaylist } from "./playlist-authoring.js";
import { replacePlaylistRelease } from "./playlist-release.js";
import { parseArgv } from "./argv.js";

const response = (body: unknown) => ({ status: 200, headers: {}, body });
function fixture() {
  const document = preparePlaylist({ name: "Board", content: [{ primitive: "application", release_id: "rel_OLD" }, { primitive: "application", release_id: "rel_OLD" }], width: 1920, height: 1080, durationMs: 8000, fit: "fill" });
  document.pages[0].primitives[0].application_id = "app_BOARD";
  document.pages[0].visibility = { enabled: true, from: "2026-09-10T09:00" };
  let revision = 4;
  let failure = false;
  let malformed = false;
  const screens = [ { id: "scr_A", label: "Lobby", state: "active", revision: 3, playlist_id: "pl_BOARD" }, { id: "scr_B", label: "Stored", state: "archived", revision: 7, playlist_id: "pl_BOARD" }, { id: "scr_C", label: "Other", state: "active", revision: 2, playlist_id: "pl_OTHER" } ];
  const transport = new FakeTransport()
    .on("GET", "/api/v1/playlists/pl_BOARD", () => response({ ...document, id: "pl_BOARD", revision }))
    .on("GET", "/api/v1/screens", req => response(malformed ? {} : { items: screens.filter(s => (s.state === "archived") === (req.query?.state === "archived")) }))
    .on("PUT", "/api/v1/playlists/pl_BOARD", req => failure ? { status: 409, headers: {}, body: { code: "revision_conflict", title: "Conflict", status: 409, detail: "Playlist changed", current_revision: 5 } } : response({ ...(req.body as object), id: "pl_BOARD", revision: 5 }));
  const options = { client: new ApiClient({ transport }), apiUrl: "https://api.screenrig.ai", playlistId: "pl_BOARD", pageId: "page_1", primitiveId: "content", releaseId: "rel_NEW", apply: false };
  return { document, transport, options, screens, changeRevision: () => revision++, failWrite: () => failure = true, malformedList: () => malformed = true };
}

test("preview is read-only and apply changes only the explicitly scoped pin", async () => {
  const f = fixture();
  const preview = await replacePlaylistRelease(f.options);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.affected_screens.map(s => s.id), ["scr_A", "scr_B"]);
  assert.equal(preview.previous_release_id, "rel_OLD");
  assert.ok(f.transport.calls.every(c => c.method === "GET"));
  const applied = await replacePlaylistRelease({ ...f.options, apply: true, revision: String(preview.revision), impact: preview.impact });
  assert.equal(applied.applied, true);
  const writes = f.transport.calls.filter(c => c.method === "PUT");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.headers?.["if-match"], '"4"');
  assert.ok(writes[0]!.headers?.["idempotency-key"]);
  const expected = structuredClone(f.document);
  expected.pages[0].primitives[0].release_id = "rel_NEW";
  assert.deepEqual(writes[0]!.body, expected);
  assert.equal(f.document.pages[0].primitives[0].release_id, "rel_OLD");
});

for (const change of ["revision", "assignment", "release", "page", "malformed"] as const) test(`apply refuses changed ${change} before any write`, async () => {
  const f = fixture();
  const preview = await replacePlaylistRelease(f.options);
  if (change === "revision") f.changeRevision();
  if (change === "assignment") f.screens[2]!.playlist_id = "pl_BOARD";
  if (change === "malformed") f.malformedList();
  await assert.rejects(() => replacePlaylistRelease({ ...f.options, apply: true, revision: "4", impact: preview.impact,
    ...(change === "release" ? { releaseId: "rel_DIFFERENT" } : {}), ...(change === "page" ? { pageId: "page_2" } : {}) }));
  assert.ok(f.transport.calls.every(c => c.method === "GET"));
});

test("server revision race is surfaced without a retry", async () => {
  const f = fixture(); const preview = await replacePlaylistRelease(f.options); f.failWrite();
  await assert.rejects(() => replacePlaylistRelease({ ...f.options, apply: true, revision: "4", impact: preview.impact }), (error: any) => error.problem.code === "revision_conflict");
  assert.equal(f.transport.calls.filter(c => c.method === "PUT").length, 1);
});

test("missing review, wrong target and no-op never write", async () => {
  for (const override of [{ apply: true }, { revision: "4" }, { pageId: "missing" }, { primitiveId: "missing" }, { releaseId: "rel_OLD" }]) {
    const f = fixture();
    await assert.rejects(() => replacePlaylistRelease({ ...f.options, ...override }));
    assert.ok(f.transport.calls.every(c => c.method === "GET"));
  }
  const f = fixture(); f.document.pages[0].primitives[0] = { id: "content", primitive: "iframe", src: "https://example.com", title: "Example", rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "fill" };
  await assert.rejects(() => replacePlaylistRelease(f.options), /application/);
});

test("CLI exposes explicit targets and revision aliases", () => {
  const argv = ["playlist", "replace-release", "pl_BOARD", "--page", "page_1", "--primitive", "content", "--release-id", "rel_NEW"];
  assert.equal(parseArgv(argv).flags.page, "page_1");
  assert.equal(parseArgv([...argv, "--apply", "--expect-rev", "4", "--expect-impact", "token"]).flags["if-match"], "4");
  assert.throws(() => parseArgv(["playlist", "replace-release", "pl_BOARD"]));
});
