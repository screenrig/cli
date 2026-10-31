import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient } from "./client.js";
import { FakeTransport, listPage } from "./transport/fake.js";
import { preparePlaylist } from "./playlist-authoring.js";
import { replacePlaylistRelease } from "./playlist-release.js";
import { parseArgv } from "./argv.js";
import type { Screen } from "./adapters/protocol.js";

const response = (body: unknown) => ({ status: 200, headers: {}, body });
type ImpactScreen = Pick<Screen, "id" | "label" | "state" | "revision"> &
  Partial<Pick<Screen, "playlist_id" | "playlist_schedule" | "takeover" | "effective_playlist">>;
/** `pageSize` serves the screen lists that many rows per page, with next_cursor; without it each list is one page. */
function fixture(pageSize?: number) {
  const document = preparePlaylist({ name: "Board", content: [{ primitive: "application", release_id: "rel_OLD" }, { primitive: "application", release_id: "rel_OLD" }], width: 1920, height: 1080, durationMs: 8000, fit: "fill" });
  document.pages[0].primitives[0].application_id = "app_BOARD";
  document.pages[0].visibility = { enabled: true, from: "2026-09-10T09:00" };
  let revision = 4;
  let failure = false;
  let malformed = false;
  let proposal = false;
  const screens: ImpactScreen[] = [ { id: "scr_A", label: "Lobby", state: "active", revision: 3, playlist_id: "pl_BOARD" }, { id: "scr_B", label: "Stored", state: "archived", revision: 7, playlist_id: "pl_BOARD" }, { id: "scr_C", label: "Other", state: "active", revision: 2, playlist_id: "pl_OTHER" } ];
  const transport = new FakeTransport()
    .on("GET", "/api/playlists/pl_BOARD", () => response({ ...document, id: "pl_BOARD", revision }))
    .on("GET", "/api/screens", req => {
      const listed = screens.filter(s => (s.state === "archived") === (req.query?.state === "archived"));
      return malformed ? response({}) : pageSize === undefined ? response({ items: listed }) : listPage(req, listed, pageSize);
    })
    .on("PUT", "/api/playlists/pl_BOARD", req => proposal ? { status: 202, headers: {}, body: { status: "pending_review",
      review: { id: "rvw_BOARD", kind: "playlist_change", state: "pending", url: "https://screenrig.ai/dashboard/reviews/rvw_BOARD", subject: { type: "playlist", id: "pl_BOARD", name: "Board" }, impact: { screens: 1 } },
      playlist: { ...document, id: "pl_BOARD", revision } } } : failure ? { status: 409, headers: {}, body: { code: "revision_conflict", title: "Conflict", status: 409, detail: "Playlist changed", current_revision: 5 } } : response({ ...(req.body as object), id: "pl_BOARD", revision: 5 }));
  const options = { client: new ApiClient({ transport }), apiUrl: "https://api.screenrig.ai", playlistId: "pl_BOARD", pageId: "page_1", primitiveId: "content", releaseId: "rel_NEW", apply: false };
  return { document, transport, options, screens, changeRevision: () => revision++, failWrite: () => failure = true, malformedList: () => malformed = true, proposeWrite: () => proposal = true };
}

test("preview is read-only and apply changes only the explicitly scoped pin", async () => {
  const f = fixture();
  const preview = await replacePlaylistRelease(f.options);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.affected_screens!.map(s => s.id), ["scr_A", "scr_B"]);
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

test("the impact review reads every page of both screen lists", async () => {
  const late: ImpactScreen = { id: "scr_D", label: "Late", state: "active", revision: 1, playlist_id: "pl_BOARD" };
  const whole = fixture(); whole.screens.push(late);
  const paged = fixture(1); paged.screens.push(late);
  const expected = await replacePlaylistRelease(whole.options);
  const preview = await replacePlaylistRelease(paged.options);
  assert.deepEqual(preview.affected_screens!.map(s => s.id), ["scr_A", "scr_B", "scr_D"]);
  assert.equal(preview.impact, expected.impact, "the impact token does not depend on the page size");
  assert.deepEqual(
    paged.transport.calls.filter(c => c.path === "/api/screens").map(c => c.query),
    [undefined, { after: "pg_1" }, { after: "pg_2" }, { state: "archived" }],
  );
});

const takeover = { playlist_id: "pl_BOARD", until: null, set_at: "2026-10-30T00:00:00Z" };
const schedule = { entries: [{ id: "scheduled", playlist_id: "pl_BOARD", from: "2026-10-01T00:00" }], updated_at: "2026-10-30T00:00:00Z" };

test("impact includes scheduled, takeover and effective consumers across both paginated lists", async () => {
  const whole = fixture();
  whole.screens.push(
    { id: "scr_S", label: "Scheduled", state: "active", revision: 1, playlist_id: "pl_OTHER", playlist_schedule: schedule },
    { id: "scr_T", label: "Takeover", state: "active", revision: 1, playlist_id: "pl_OTHER", takeover },
    { id: "scr_E", label: "Campaign", state: "active", revision: 1, playlist_id: "pl_OTHER", effective_playlist: { id: "pl_BOARD", source: "campaign", entry_id: "cmp_BOARD" } },
    { id: "scr_F", label: "Inherited", state: "active", revision: 1, effective_playlist: { id: "pl_BOARD", source: "folder", entry_id: "sfd_BOARD" } },
    { id: "scr_P", label: "Future", state: "pairing_pending", revision: 1, playlist_schedule: { ...schedule, entries: [{ ...schedule.entries[0]!, paused: true, from: "2099-01-01T00:00" }] } },
    { id: "scr_R", label: "Archived", state: "archived", revision: 1, playlist_schedule: schedule, takeover },
  );
  // The direct positive control also has both indirect references; it appears once.
  Object.assign(whole.screens[0]!, { playlist_schedule: schedule, takeover });
  const paged = fixture(1);
  paged.screens.splice(0, paged.screens.length, ...structuredClone(whole.screens).reverse());
  const expected = await replacePlaylistRelease(whole.options);
  const preview = await replacePlaylistRelease(paged.options);
  assert.deepEqual(preview.affected_screens!.map(s => s.id), ["scr_A", "scr_B", "scr_E", "scr_F", "scr_P", "scr_R", "scr_S", "scr_T"]);
  assert.equal(preview.impact, expected.impact, "pagination and screen order do not change the review");
  assert.ok(paged.transport.calls.every(c => c.method === "GET"));
  const applied = await replacePlaylistRelease({ ...paged.options, apply: true, revision: String(preview.revision), impact: preview.impact });
  assert.equal(applied.applied, true);
  const document = structuredClone(paged.document);
  document.pages[0].primitives[0].release_id = "rel_NEW";
  assert.deepEqual(paged.transport.calls.find(c => c.method === "PUT")!.body, document);
});

for (const reference of ["takeover", "playlist_schedule", "effective_playlist"] as const) {
  for (const change of ["add", "remove", "modify"] as const) test(`${change} ${reference} invalidates impact even when screen ids and revisions stay the same`, async () => {
    const f = fixture();
    const screen = f.screens[0]!; // Still affected through its default assignment.
    const value = { takeover, playlist_schedule: schedule, effective_playlist: { id: "pl_BOARD", source: "campaign", entry_id: "cmp_BOARD" } };
    if (change !== "add") Object.assign(screen, { [reference]: structuredClone(value[reference]) });
    const preview = await replacePlaylistRelease(f.options);
    if (change === "add") Object.assign(screen, { [reference]: structuredClone(value[reference]) });
    else if (change === "remove") delete screen[reference];
    else if (reference === "takeover") screen.takeover!.until = "2026-11-01T00:00:00Z";
    else if (reference === "playlist_schedule") screen.playlist_schedule!.entries[0]!.until = "2026-11-01T00:00";
    else screen.effective_playlist!.entry_id = "cmp_OTHER";
    const changed = await replacePlaylistRelease(f.options);
    assert.deepEqual(changed.affected_screens, preview.affected_screens);
    assert.notEqual(changed.impact, preview.impact);
    await assert.rejects(() => replacePlaylistRelease({ ...f.options, apply: true, revision: "4", impact: preview.impact }),
      (error: any) => error.problem.code === "resource_conflict" && error.problem.status === 409);
    assert.ok(f.transport.calls.every(c => c.method === "GET"));
  });
}

test("reference object member order does not invalidate a reviewed replacement", async () => {
  const f = fixture();
  f.screens[2]!.takeover = takeover;
  const preview = await replacePlaylistRelease(f.options);
  f.screens[2]!.takeover = { set_at: takeover.set_at, until: takeover.until, playlist_id: takeover.playlist_id };
  const applied = await replacePlaylistRelease({ ...f.options, apply: true, impact: preview.impact });
  assert.equal(applied.applied, true);
});

for (const malformed of [{ playlist_schedule: { entries: null } }, { takeover: {} }, { effective_playlist: {} }]) {
  test(`malformed indirect reference fails closed: ${Object.keys(malformed)[0]}`, async () => {
    const f = fixture();
    Object.assign(f.screens[2]!, malformed);
    await assert.rejects(() => replacePlaylistRelease(f.options), /Cannot determine affected screens/);
    assert.ok(f.transport.calls.every(c => c.method === "GET"));
  });
}

test("server revision race is surfaced without a retry", async () => {
  const f = fixture(); const preview = await replacePlaylistRelease(f.options); f.failWrite();
  await assert.rejects(() => replacePlaylistRelease({ ...f.options, apply: true, revision: "4", impact: preview.impact }), (error: any) => error.problem.code === "revision_conflict");
  assert.equal(f.transport.calls.filter(c => c.method === "PUT").length, 1);
});

test("invalid preview flags and wrong targets never write", async () => {
  for (const override of [{ revision: "4" }, { pageId: "missing" }, { primitiveId: "missing" }]) {
    const f = fixture();
    await assert.rejects(() => replacePlaylistRelease({ ...f.options, ...override }));
    assert.ok(f.transport.calls.every(c => c.method === "GET"));
  }
  const f = fixture(); f.document.pages[0].primitives[0] = { id: "content", primitive: "iframe", src: "https://example.com", title: "Example", rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "fill" };
  await assert.rejects(() => replacePlaylistRelease(f.options), /application/);
});

test("CLI exposes explicit targets and the revision guard", () => {
  const argv = ["playlist", "replace-release", "pl_BOARD", "--page", "page_1", "--primitive", "content", "--release-id", "rel_NEW"];
  assert.equal(parseArgv(argv).flags.page, "page_1");
  assert.equal(parseArgv([...argv, "--apply", "--expect-rev", "4", "--expect-impact", "token"]).flags["expect-rev"], "4");
  assert.throws(() => parseArgv(["playlist", "replace-release", "pl_BOARD"]));
});

test("a stale --expect-rev is a 412 and a stale --expect-impact a 409, both before any write", async () => {
 const f = fixture(); const preview = await replacePlaylistRelease(f.options);
 await assert.rejects(() => replacePlaylistRelease({ ...f.options, apply: true, revision: "3", impact: preview.impact }),
  (error: any) => error.problem.code === "revision_conflict" && error.exitCode === 6);
 await assert.rejects(() => replacePlaylistRelease({ ...f.options, apply: true, impact: "0".repeat(64) }),
  (error: any) => error.problem.code === "resource_conflict" && error.exitCode === 5);
 assert.ok(f.transport.calls.every(c => c.method === "GET"));
});

test("apply accepts omitted revision and sends no precondition", async () => {
 const f = fixture(); const preview = await replacePlaylistRelease(f.options);
 const applied = await replacePlaylistRelease({...f.options, apply: true, impact: preview.impact});
 assert.equal(applied.applied, true);
 assert.equal(applied.revision, 5, "the top-level revision is the written one");
 assert.equal((applied as { previous_revision?: number }).previous_revision, 4);
 assert.equal(f.transport.calls.find(c => c.method === "PUT")?.headers?.["if-match"], undefined);
});

test("direct apply needs no preview or screen inventory, and a no-op succeeds", async () => {
 const f = fixture();
 const applied = await replacePlaylistRelease({...f.options, apply:true});
 assert.equal(applied.applied,true);
 assert.deepEqual(f.transport.calls.map(c=>c.method),["GET","PUT"]);
 assert.equal(f.transport.calls[1]?.headers?.["if-match"],undefined);
 const noOp = fixture();
 const result = await replacePlaylistRelease({...noOp.options, apply:true, releaseId:"rel_OLD"});
 assert.equal(result.applied,true);
 assert.deepEqual(noOp.transport.calls.map(c=>c.method),["GET"]);
});

test("an apply that waits for review sends the note and reports the review without applying", async () => {
  const f = fixture();
  f.proposeWrite();
  const preview = await replacePlaylistRelease(f.options);
  const result = await replacePlaylistRelease({ ...f.options, apply: true, revision: String(preview.revision), impact: preview.impact, note: "Board release with the new menu" });
  assert.equal(result.applied, false);
  assert.equal((result as { status?: string }).status, "pending_review");
  assert.equal((result as { review?: { id: string } }).review?.id, "rvw_BOARD");
  const write = f.transport.calls.find(c => c.method === "PUT")!;
  assert.equal(write.headers?.["screenrig-review-note"], encodeURIComponent("Board release with the new menu"));
  assert.equal(write.headers?.["if-match"], `"${preview.revision}"`);
});
