import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { testTemp } from "../test-temp.js";
import { FileKvStore, RemoteKvStore, normalizeContentType, validKvKey, type KvChange } from "./kv.js";

const b64 = (text: string) => Buffer.from(text).toString("base64");
let serial = 0;
const write = (value: string, extra: { contentType?: string; expectedRevision?: number } = {}) => ({ valueBase64: b64(value), contentType: extra.contentType ?? "text/plain", idempotencyKey: `idem-${++serial}-test`, ...(extra.expectedRevision === undefined ? {} : { expectedRevision: extra.expectedRevision }) });
const drop = (extra: { expectedRevision?: number } = {}) => ({ idempotencyKey: `idem-${++serial}-test`, ...extra });

async function open(onProblem?: (message: string) => void) {
  const dir = await testTemp("kv-");
  const file = path.join(dir, ".screenrig-dev", "kv.json");
  const store = new FileKvStore(file, "app_dev_test", { watch: false, ...(onProblem ? { onProblem } : {}) });
  await store.open();
  const changes: KvChange[] = [];
  store.subscribe((change) => changes.push(change));
  return { dir, file, store, changes, reopen: async () => { await store.close(); const next = new FileKvStore(file, "app_dev_test", { watch: false }); await next.open(); return next; } };
}

test("a key is created, read, listed and deleted, with a revision that counts every write", async () => {
  const { store, changes } = await open();
  const missing = await store.get("greeting");
  assert.deepEqual(missing.ok ? null : [missing.problem.code, missing.problem.status], ["not_found", 404]);
  const first = await store.set("greeting", write("hello"));
  assert.ok(first.ok);
  assert.equal(first.value.revision, 1);
  assert.equal(first.value.bytes, 5);
  assert.equal(first.value.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(first.value.application_id, "app_dev_test");
  const second = await store.set("greeting", write("hello again"));
  assert.equal(second.ok && second.value.revision, 2);
  await store.set("alpha", write("a"));
  const listed = await store.list();
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.map((item) => [item.key, item.revision]), [["alpha", 1], ["greeting", 2]]);
  assert.equal("value_base64" in listed.value[0]!, false);
  const read = await store.get("greeting");
  assert.equal(read.ok && Buffer.from(read.value.value_base64, "base64").toString(), "hello again");
  const deleted = await store.delete("greeting", drop());
  assert.deepEqual(deleted, { ok: true, value: null });
  const gone = await store.delete("greeting", drop());
  assert.equal(gone.ok ? "" : gone.problem.code, "not_found");
  assert.deepEqual(changes, [
    { key: "greeting", revision: 1, deleted: false }, { key: "greeting", revision: 2, deleted: false },
    { key: "alpha", revision: 1, deleted: false }, { key: "greeting", deleted: true },
  ]);
});

test("an expected revision that is stale is a revision_conflict carrying the current revision", async () => {
  const { store } = await open();
  await store.set("n", write("1"));
  await store.set("n", write("2"));
  const stale = await store.set("n", write("3", { expectedRevision: 1 }));
  assert.ok(!stale.ok);
  assert.deepEqual([stale.problem.code, stale.problem.status, stale.problem.current_revision], ["revision_conflict", 412, 2]);
  assert.match(stale.problem.request_id, /^dev_/);
  const fresh = await store.set("n", write("3", { expectedRevision: 2 }));
  assert.equal(fresh.ok && fresh.value.revision, 3);
  const staleDelete = await store.delete("n", drop({ expectedRevision: 2 }));
  assert.ok(!staleDelete.ok);
  assert.equal(staleDelete.problem.current_revision, 3);
  assert.ok((await store.delete("n", drop({ expectedRevision: 3 }))).ok);
});

test("a write that names revision 0 creates a key and conflicts with one that exists; any other revision conflicts with a missing key", async () => {
  const { store } = await open();
  assert.ok((await store.set("k", write("a", { expectedRevision: 0 }))).ok);
  const again = await store.set("k", write("b", { expectedRevision: 0 }));
  assert.ok(!again.ok);
  assert.equal(again.problem.current_revision, 1);
  const missing = await store.set("other", write("b", { expectedRevision: 4 }));
  assert.ok(!missing.ok);
  assert.equal(missing.problem.code, "revision_conflict");
  assert.equal(missing.problem.current_revision, undefined);
});

test("a deleted key's next revision continues from the last one, and survives a restart", async () => {
  const { store, reopen } = await open();
  await store.set("k", write("a"));
  await store.set("k", write("b"));
  await store.delete("k", drop());
  const next = await reopen();
  const created = await next.set("k", write("c"));
  assert.equal(created.ok && created.value.revision, 3);
});

test("values, types and revisions are kept in the file and read back", async () => {
  const { store, file, reopen } = await open();
  await store.set("text", write("hello"));
  await store.set("config", write('{"theme":"dark","n":2}', { contentType: "application/json" }));
  await store.set("spaced", write('{ "a": 1 }', { contentType: "application/json" }));
  await store.set("blob", { valueBase64: Buffer.from([0, 1, 2, 255]).toString("base64"), contentType: "application/octet-stream", idempotencyKey: "idem-blob-0001" });
  const document = JSON.parse(await readFile(file, "utf8"));
  assert.equal(document.schema, "screenrig.dev-kv/v1");
  assert.deepEqual(document.entries.text, { content_type: "text/plain", value: "hello", revision: 1 });
  assert.deepEqual(document.entries.config, { content_type: "application/json", value: { theme: "dark", n: 2 }, revision: 1 });
  assert.equal(document.entries.spaced.value, '{ "a": 1 }');
  assert.deepEqual(document.entries.blob, { content_type: "application/octet-stream", value_base64: "AAEC/w==", revision: 1 });
  const next = await reopen();
  for (const key of ["text", "config", "spaced", "blob"]) {
    const before = await store.get(key);
    const after = await next.get(key);
    assert.deepEqual(after, before, key);
  }
});

test("the same idempotency key replays a write and refuses a different one", async () => {
  const { store } = await open();
  const input = write("v");
  const a = await store.set("k", input);
  const b = await store.set("k", input);
  assert.deepEqual(b, a);
  assert.equal((await store.get("k")).ok && ((await store.get("k")) as { value: { revision: number } }).value.revision, 1);
  const c = await store.set("k", { ...input, valueBase64: b64("other") });
  assert.ok(!c.ok);
  assert.equal(c.problem.code, "idempotency_mismatch");
});

test("keys, values and content types are checked as the real store checks them", async () => {
  const { store } = await open();
  assert.ok(validKvKey("a/b:c.d-e_f"));
  for (const key of ["", ".", "..", "_screenrig/x", "x".repeat(257), "\ud800"]) assert.equal(validKvKey(key), false, JSON.stringify(key));
  assert.equal((await store.set("_screenrig/x", write("a"))).ok, false);
  const big = await store.set("big", { valueBase64: Buffer.alloc((1 << 20) + 1).toString("base64"), contentType: "text/plain", idempotencyKey: "idem-big-0001" });
  assert.ok(!big.ok);
  assert.equal(big.problem.code, "invalid_request");
  assert.equal((await store.set("t", write("a", { contentType: "not a type" }))).ok, false);
  assert.equal((await store.set("i", { ...write("a"), idempotencyKey: "short" })).ok, false);
  assert.equal((await store.set("b", { ...write("a"), valueBase64: "%%%" })).ok, false);
  assert.equal(normalizeContentType("Text/Plain; Charset=UTF-8"), "text/plain; charset=UTF-8");
});

test("an edit made to the file from outside is read, numbered and pushed as kv.changed", async () => {
  const { store, file, changes } = await open();
  await store.set("greeting", write("hello"));
  changes.length = 0;
  const document = JSON.parse(await readFile(file, "utf8"));
  document.entries.greeting.value = "hello from the editor";
  document.entries.added = { value: { on: true } };
  await writeFile(file, JSON.stringify(document));
  await store.reload();
  assert.deepEqual(changes.sort((a, b) => (a.key < b.key ? -1 : 1)), [{ key: "added", revision: 1, deleted: false }, { key: "greeting", revision: 2, deleted: false }]);
  // The edit named no revision, so the file now says what the store holds.
  const rewritten = JSON.parse(await readFile(file, "utf8"));
  assert.equal(rewritten.entries.greeting.revision, 2);
  assert.deepEqual(rewritten.entries.added, { content_type: "application/json", value: { on: true }, revision: 1 });
  changes.length = 0;
  await store.reload();
  assert.deepEqual(changes, [], "a file that says what the store holds changes nothing");
  delete rewritten.entries.greeting;
  await writeFile(file, JSON.stringify(rewritten));
  await store.reload();
  assert.deepEqual(changes, [{ key: "greeting", deleted: true }]);
  const created = await store.set("greeting", write("back"));
  assert.equal(created.ok && created.value.revision, 3, "a key deleted from the file continues its revisions");
});

test("a file edited to a higher revision keeps it, and watching notices an outside edit by itself", async () => {
  const dir = await testTemp("kv-watch-");
  const file = path.join(dir, "kv.json");
  await writeFile(file, JSON.stringify({ entries: { n: { value: "a", revision: 7 } } }));
  const seen: KvChange[] = [];
  const store = new FileKvStore(file, "app_dev_test", { watch: true });
  await store.open();
  store.subscribe((change) => seen.push(change));
  const read = await store.get("n");
  assert.equal(read.ok && read.value.revision, 7);
  await writeFile(file, JSON.stringify({ entries: { n: { value: "b", revision: 9 }, m: { value: "c" } } }));
  for (let waited = 0; seen.length < 2 && waited < 3000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  await store.close();
  assert.deepEqual(seen.sort((a, b) => (a.key < b.key ? -1 : 1)), [{ key: "m", revision: 1, deleted: false }, { key: "n", revision: 9, deleted: false }]);
});

test("a file that is not valid keeps the previous values, reports why and refuses writes until it is fixed", async () => {
  const problems: string[] = [];
  const { store, file } = await open((message) => problems.push(message));
  await store.set("k", write("kept"));
  await writeFile(file, "{ not json");
  await store.reload();
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /not valid JSON/);
  const read = await store.get("k");
  assert.equal(read.ok && Buffer.from(read.value.value_base64, "base64").toString(), "kept");
  const refused = await store.set("k", write("lost"));
  assert.ok(!refused.ok);
  assert.equal(refused.problem.status, 500);
  assert.equal(await readFile(file, "utf8"), "{ not json", "the file is not overwritten");
  await writeFile(file, JSON.stringify({ entries: { k: { value: "fixed" } } }));
  await store.reload();
  assert.ok((await store.set("k", write("again"))).ok);
  await writeFile(file, JSON.stringify({ entries: { "": { value: "x" } } }));
  await store.reload();
  assert.match(problems.at(-1)!, /not a valid key/);
  await rm(file);
  await store.reload();
  assert.deepEqual((await store.list()).ok && (await store.list() as { value: unknown[] }).value, []);
});

test("the real store is read through the signed-in client and never written", async () => {
  const requested: string[] = [];
  const remote = new RemoteKvStore("app_REAL", async (apiPath) => {
    requested.push(apiPath);
    if (apiPath.endsWith("/missing")) return { ok: false, problem: { code: "not_found", status: 404, detail: "Key/value entry not found." } };
    if (apiPath.endsWith("/kv")) return { ok: true, body: { items: [{ application_id: "app_REAL", key: "a", content_type: "text/plain", bytes: 1, sha256: "x".repeat(64), revision: 4 }], next_cursor: null } };
    return { ok: true, body: { application_id: "app_REAL", key: "a", value_base64: "YQ==", content_type: "text/plain", bytes: 1, sha256: "x".repeat(64), revision: 4 } };
  });
  const list = await remote.list();
  assert.equal(list.ok && list.value[0]!.revision, 4);
  assert.equal((await remote.get("a")).ok, true);
  const missing = await remote.get("missing");
  assert.ok(!missing.ok);
  assert.equal(missing.problem.code, "not_found");
  assert.match(missing.problem.request_id, /^dev_/);
  assert.deepEqual(requested, ["/api/applications/app_REAL/kv", "/api/applications/app_REAL/kv/a", "/api/applications/app_REAL/kv/missing"]);
  for (const refused of [await remote.set(), await remote.delete()]) {
    assert.ok(!refused.ok);
    assert.deepEqual([refused.problem.code, refused.problem.status], ["forbidden", 403]);
  }
  assert.equal(requested.length, 3, "a refused write sends nothing");
});
