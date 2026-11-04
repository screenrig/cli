import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ApiClient } from "./client.js";
import { networkError } from "./problems.js";
import { processRuntime } from "./runtime.js";
import { publishScreen } from "./screen-publish.js";
import { FakeTransport } from "./transport/fake.js";

const response = (body: unknown) => ({ status: 200, headers: {}, body });
const alreadyPublished = (result: Awaited<ReturnType<typeof publishScreen>>) => "already_published" in result ? result.already_published : undefined;
type Failure = "create" | "assign" | "verify";

async function fixture(t: TestContext, prefix = "", failure?: Failure) {
  const dir = await mkdtemp(path.join(tmpdir(), "publish-saved-cards-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cards = ["FIRST", "SECOND"].map(name => ({
    id: `${prefix}crd_${name}`, revision: 1, params: { title: "Office", showTitles: true },
  }));
  const document = {
    name: "Rooms",
    pages: [cards[0]!, cards[1]!, cards[0]!].map((card, index) => ({
      id: `page-${index}`, canvas: { width: 1920, height: 1080, background: "#000000FF" },
      transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "duration", after_ms: 8000 }, primitives: [
        { id: "board", primitive: "card", card: card.id, layout: "full", content_fit: "fill" },
      ],
    })),
  };
  let screen = { id: `${prefix}scr_TEST`, revision: 7, playlist_id: undefined as string | undefined };
  let failed = false;
  const created = new Map<string, { id: string; revision: number; params: typeof cards[number]["params"][] }>();
  const control = { cardFailure: "" };
  const transport = new FakeTransport()
    .on("GET", "/api/project", () => response({ id: `${prefix}prj_TEST` }))
    .on("GET", `/api/screens/${screen.id}`, () => {
      if (failure === "verify" && screen.playlist_id && !failed) { failed = true; throw networkError("Verification interrupted"); }
      return response(screen);
    })
    .on("GET", /^\/api\/cards\//, req => {
      if (control.cardFailure === "network") throw networkError("Card read interrupted");
      if (control.cardFailure === "missing") return { status: 404, headers: {}, body: { code: "not_found", title: "Not found", status: 404 } };
      const card = cards.find(card => req.path === `/api/cards/${card.id}`)!;
      return response({ ...card, ...(control.cardFailure === "identity" ? { id: "crd_OTHER" } : {}), ...(control.cardFailure === "revision" ? { revision: 0 } : {}) });
    })
    .on("POST", "/api/playlists", req => {
      assert.deepEqual(req.body, document, "the backend still owns resolving card params");
      const key = req.headers!["idempotency-key"]!;
      if (!created.has(key)) created.set(key, {
        id: `${prefix}pl_TEST${created.size + 1}`, revision: 1, params: cards.map(card => structuredClone(card.params)),
      });
      if (failure === "create" && !failed) { failed = true; throw networkError("Create response lost"); }
      return response(created.get(key));
    })
    .on("PATCH", `/api/screens/${screen.id}`, req => {
      screen = { ...screen, revision: screen.revision + 1, playlist_id: (req.body as { playlist_id: string }).playlist_id };
      if (failure === "assign" && !failed) { failed = true; throw networkError("Assign response lost"); }
      return response(screen);
    });
  const options = {
    client: new ApiClient({ transport }), runtime: processRuntime(), configPath: path.join(dir, "config.json"),
    apiUrl: "https://api.screenrig.ai", screenId: screen.id, document,
  };
  return { options, cards, created, control, transport };
}

for (const prefix of ["", "development_", "qa_", "stage_"]) test(`republishing edited ${prefix || "production "}saved cards refreshes params without changing the document`, async t => {
  const f = await fixture(t, prefix);
  const input = JSON.stringify(f.options.document);
  const first = await publishScreen(f.options);
  assert.equal(alreadyPublished(await publishScreen(f.options)), true);
  assert.equal(f.created.size, 1, "unchanged saved cards reuse the completed publish");

  // The edited instance is on another page; the first instance occurs twice.
  Object.assign(f.cards[1]!, { revision: 2, params: { title: "Private rooms", showTitles: false } });
  const reads = f.transport.calls.filter(call => call.path.startsWith("/api/cards/")).length;
  const fresh = await publishScreen(f.options);
  assert.notEqual(fresh.playlist_id, first.playlist_id);
  assert.equal(alreadyPublished(fresh), undefined);
  assert.equal(fresh.assignment_verified, true);
  assert.equal(f.created.size, 2);
  assert.deepEqual([...f.created.values()].at(-1)!.params[1], { title: "Private rooms", showTitles: false });
  assert.equal(JSON.stringify(f.options.document), input);
  assert.equal(f.transport.calls.filter(call => call.path.startsWith("/api/cards/")).length - reads, 2, "one read per distinct saved card");
  assert.equal(alreadyPublished(await publishScreen(f.options)), true);
  assert.equal(f.created.size, 2);
  const journal = await readFile(fresh.journal, "utf8");
  assert.doesNotMatch(journal, /Private rooms|Office|showTitles/, "journals retain identities and revisions, never card settings");
});

test("completed journals from older CLIs reauthor saved cards once", async t => {
  const f = await fixture(t);
  const first = await publishScreen(f.options);
  const journal = JSON.parse(await readFile(first.journal, "utf8"));
  delete journal.cards;
  await writeFile(first.journal, JSON.stringify(journal), { mode: 0o600 });
  const fresh = await publishScreen(f.options);
  assert.notEqual(fresh.playlist_id, first.playlist_id);
  assert.equal(alreadyPublished(await publishScreen(f.options)), true);
  assert.equal(f.created.size, 2);
});

for (const failure of ["create", "assign", "verify"] as const) test(`saved-card publishes recover a lost ${failure} response without duplicating writes`, async t => {
  const f = await fixture(t, "", failure);
  await assert.rejects(() => publishScreen(f.options));
  // Even a separate edit must not change an incomplete write's recovery keys.
  if (failure !== "verify") f.cards[1]!.revision++;
  const resumed = await publishScreen(f.options);
  assert.equal(resumed.playlist_id, "pl_TEST1");
  assert.equal(f.created.size, 1);
  assert.equal(f.transport.calls.filter(call => call.method === "PATCH").length, 1);
  assert.equal(new Set(f.transport.calls.filter(call => call.method === "POST").map(call => call.headers!["idempotency-key"])).size, 1);
  if (failure === "verify") f.cards[1]!.revision++;
  assert.equal((await publishScreen(f.options)).playlist_id, "pl_TEST2", "the next completed-publish check detects the edit");
});

for (const cardFailure of ["network", "missing", "identity", "revision"]) test(`a ${cardFailure} card read cannot report a completed publish as current`, async t => {
  const f = await fixture(t);
  const first = await publishScreen(f.options);
  const journal = await readFile(first.journal, "utf8");
  const writes = f.transport.calls.filter(call => call.method !== "GET").length;
  f.control.cardFailure = cardFailure;
  await assert.rejects(() => publishScreen(f.options));
  assert.equal(f.transport.calls.filter(call => call.method !== "GET").length, writes);
  assert.equal(await readFile(first.journal, "utf8"), journal);
  f.control.cardFailure = "";
  assert.equal(alreadyPublished(await publishScreen(f.options)), true);
});

test("saved-card edits still require the intended screen revision before creating a fresh playlist", async t => {
  const f = await fixture(t);
  const options = { ...f.options, revision: "7" };
  await publishScreen(options);
  assert.equal(alreadyPublished(await publishScreen(options)), true);
  f.cards[1]!.revision++;
  await assert.rejects(() => publishScreen(options), (error: any) => error.problem.code === "revision_conflict" && error.problem.status === 412);
  assert.equal(f.created.size, 1);
  assert.equal(f.transport.calls.filter(call => call.method === "PATCH").length, 1);
});
