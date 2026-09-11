import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { run, processRuntime } from "./main.js";
import { FakeTransport } from "./transport/fake.js";
import { networkError } from "./problems.js";

const command = ["screen", "update", "scr_TEST", "--name", "Private lobby name", "--if-match", "1"];
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "screenrig-write-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = `${directory}/config.json`;
  await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai", token: "test-only-credential" }), { mode: 0o600 });
  const read = async () => JSON.parse(await readFile(config, "utf8"));
  async function invoke(transport: FakeTransport, args = command, now = "2026-09-10T12:00:00Z") {
    let stdout = "", stderr = "";
    const code = await run({ ...processRuntime(), argv: ["--config", config, ...args], env: {}, transport,
      now: () => new Date(now),
      stdout: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }),
      stderr: new Writable({ write(chunk, _encoding, done) { stderr += chunk; done(); } }),
    });
    return { code, result: JSON.parse(stdout), stderr };
  }
  return { directory, config, read, invoke };
}
const failed = () => new FakeTransport().on("PATCH", "/api/v1/screens/scr_TEST", () => { throw networkError("Response lost"); });
const success = () => new FakeTransport().on("PATCH", "/api/v1/screens/scr_TEST", () => ({ status: 200, headers: {}, body: { id: "scr_TEST", revision: 2 } }));
const key = (transport: FakeTransport) => transport.calls[0]?.headers?.["idempotency-key"];

test("ordinary writes persist before sending, replay after response loss, and clear after success", async (t) => {
  const f = await fixture(t);
  const first = new FakeTransport().on("PATCH", "/api/v1/screens/scr_TEST", async request => {
    const entries = Object.values((await f.read()).pending_writes) as Array<{ idempotency_key: string }>;
    assert.equal(entries[0]?.idempotency_key, request.headers?.["idempotency-key"]);
    throw networkError("Response lost");
  });
  assert.notEqual((await f.invoke(first)).code, 0);
  const pending = JSON.stringify((await f.read()).pending_writes);
  assert.doesNotMatch(pending, /Private lobby name|test-only-credential|scr_TEST/);
  if (process.platform !== "win32") assert.equal((await stat(f.config)).mode & 0o777, 0o600);
  const second = success();
  assert.equal((await f.invoke(second)).code, 0);
  assert.equal(key(second), key(first));
  assert.equal((await f.read()).pending_writes, undefined);
  const third = success();
  assert.equal((await f.invoke(third)).code, 0);
  assert.notEqual(key(third), key(first));
});

test("changed body, revision, origin and credentials do not reuse pending write keys", async (t) => {
  const f = await fixture(t);
  const transports: FakeTransport[] = [];
  for (const args of [command, command.map(x => x === "Private lobby name" ? "Other lobby" : x), command.map(x => x === "1" ? "2" : x), [...command, "--api-url", "https://example.com"]]) {
    const transport = failed(); transports.push(transport);
    await f.invoke(transport, args);
  }
  await writeFile(f.config, JSON.stringify({ ...(await f.read()), token: "changed-test-credential" }), { mode: 0o600 });
  const last = failed(); transports.push(last); await f.invoke(last);
  assert.equal(new Set(transports.map(key)).size, transports.length);
});

test("definitive precondition refusal clears the pending key without retrying", async (t) => {
  const f = await fixture(t);
  const refused = new FakeTransport().on("PATCH", "/api/v1/screens/scr_TEST", () => ({ status: 412, headers: {}, body: { code: "revision_conflict", detail: "Refetch", status: 412 } }));
  assert.notEqual((await f.invoke(refused)).code, 0);
  assert.equal(refused.calls.length, 1);
  assert.equal((await f.read()).pending_writes, undefined);
});

test("expired pending writes stop before network and require explicit reconciliation", async (t) => {
  const f = await fixture(t); const first = failed(); await f.invoke(first);
  const blocked = success();
  const result = await f.invoke(blocked, command, "2026-09-11T12:00:00Z");
  assert.equal(result.code, 2);
  assert.match(result.result.error.detail, /safe replay window/);
  assert.equal(blocked.calls.length, 0);
  assert.equal((await f.invoke(blocked, [...command, "--idempotency-key", "explicit-reconciled-write"], "2026-09-11T12:00:00Z")).code, 0);
  assert.equal(key(blocked), "explicit-reconciled-write");
});

test("invalid recovery state fails closed before mutation", async (t) => {
  const f = await fixture(t);
  await writeFile(f.config, JSON.stringify({ ...(await f.read()), pending_writes: { broken: {} } }), { mode: 0o600 });
  const transport = success();
  assert.equal((await f.invoke(transport)).code, 12);
  assert.equal(transport.calls.length, 0);
});

test("concurrent identical unresolved invocations use one persisted key", async (t) => {
  const f = await fixture(t);
  const first = failed(); const second = failed();
  await Promise.all([f.invoke(first), f.invoke(second)]);
  assert.ok(key(first));
  assert.equal(key(first), key(second));
  assert.equal(Object.keys((await f.read()).pending_writes).length, 1);
});

test("server errors retain the saved key and expose recovery guidance", async (t) => {
  const f = await fixture(t);
  const first = new FakeTransport().on("PATCH", "/api/v1/screens/scr_TEST", () => ({ status: 503, headers: {}, body: { detail: "Unavailable", status: 503 } }));
  const result = await f.invoke(first);
  assert.notEqual(result.code, 0);
  assert.equal(result.result.warnings[0].code, "write_recovery_saved");
  const second = success(); await f.invoke(second);
  assert.equal(key(first), key(second));
});

test("application acceptance followed by lost operation status replays the same upload", async (t) => {
  const f = await fixture(t);
  const { mkdir } = await import("node:fs/promises");
  const { memoryBackend } = await import("./transport/fake.js");
  const app = `${f.directory}/app`; await mkdir(app);
  await writeFile(`${app}/index.html`, "<!doctype html><html><head></head><body>hello</body></html>");
  const transport = () => {
    const fake = new FakeTransport();
    const backend = memoryBackend();
    fake.on("GET", "/api/v1/capabilities", req => backend.request(req));
    fake.on("POST", "/api/v1/applications", req => backend.request(req));
    fake.on("GET", /\/api\/v1\/operations\//, () => { throw networkError("Status unavailable"); });
    return fake;
  };
  const first = transport(); const second = transport();
  assert.notEqual((await f.invoke(first, ["app", "upload", app])).code, 0);
  assert.notEqual((await f.invoke(second, ["app", "upload", app])).code, 0);
  const upload = (fake: FakeTransport) => fake.calls.find(req => req.method === "POST");
  assert.ok(upload(first)?.headers?.["idempotency-key"]);
  assert.equal(upload(first)?.headers?.["idempotency-key"], upload(second)?.headers?.["idempotency-key"]);
});

test("recovery list/show expose safe metadata and reconcile only the selected entry without transport", async (t) => {
  const f = await fixture(t);
  await f.invoke(failed());
  await f.invoke(failed(), command.map(x => x === "Private lobby name" ? "Other private name" : x));
  const original = await f.read();
  const transport = new FakeTransport();
  const listed = await f.invoke(transport, ["recovery", "list"]);
  assert.equal(listed.code, 0);
  assert.equal(listed.result.data.entries.length, 2);
  const entry = listed.result.data.entries[0];
  assert.equal(entry.command, "screen update");
  assert.equal(entry.replay_status, "within_window");
  const serialized = JSON.stringify(listed.result);
  for (const secret of ["Private lobby name", "test-only-credential", "scr_TEST", ...Object.values(original.pending_writes).map((entry: any) => entry.idempotency_key)]) {
    assert.ok(!serialized.includes(secret));
  }
  const shown = await f.invoke(transport, ["recovery", "show", entry.id]);
  assert.deepEqual(shown.result.data.entry, entry);
  const removed = await f.invoke(transport, ["recovery", "reconcile", entry.id]);
  assert.equal(removed.code, 0);
  assert.equal(removed.result.data.reconciled, true);
  assert.equal(removed.result.data.remote_changed, false);
  const remaining = await f.read();
  assert.equal(remaining.token, original.token);
  assert.equal(Object.keys(remaining.pending_writes).length, 1);
  assert.equal((await f.invoke(transport, ["recovery", "reconcile", entry.id])).code, 2);
  assert.equal(transport.calls.length, 0);
});

test("recovery legacy and expired entries are inspectable and stale IDs cannot clear replacement keys", async (t) => {
  const f = await fixture(t);
  await f.invoke(failed());
  const saved = await f.read();
  const fingerprint = Object.keys(saved.pending_writes)[0]!;
  delete saved.pending_writes[fingerprint].command;
  await writeFile(f.config, JSON.stringify(saved), { mode: 0o600 });
  const transport = new FakeTransport();
  const listed = await f.invoke(transport, ["recovery", "list"], "2026-09-11T12:00:00Z");
  const entry = listed.result.data.entries[0];
  assert.equal(entry.command, null);
  assert.equal(entry.replay_status, "expired");
  saved.pending_writes[fingerprint].idempotency_key = "replacement-write-key";
  await writeFile(f.config, JSON.stringify(saved), { mode: 0o600 });
  assert.equal((await f.invoke(transport, ["recovery", "reconcile", entry.id])).code, 2);
  assert.equal((await f.read()).pending_writes[fingerprint].idempotency_key, "replacement-write-key");
  const current = await f.invoke(transport, ["recovery", "list"]);
  assert.notEqual(current.result.data.entries[0].id, entry.id);
  assert.equal((await f.invoke(transport, ["recovery", "reconcile", current.result.data.entries[0].id])).code, 0);
  assert.equal((await f.read()).pending_writes, undefined);
  assert.equal(transport.calls.length, 0);
});

test("recovery rejects malformed state and identifiers without clearing anything", async (t) => {
  const f = await fixture(t);
  const transport = new FakeTransport();
  assert.equal((await f.invoke(transport, ["recovery", "list"])).result.data.entries.length, 0);
  assert.equal((await f.invoke(transport, ["recovery", "reconcile", "all"])).code, 2);
  await writeFile(f.config, JSON.stringify({ ...(await f.read()), pending_writes: { broken: {} } }), { mode: 0o600 });
  assert.equal((await f.invoke(transport, ["recovery", "list"])).code, 12);
  assert.deepEqual((await f.read()).pending_writes, { broken: {} });
  assert.equal(transport.calls.length, 0);
});
