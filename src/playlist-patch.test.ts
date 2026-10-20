import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { processRuntime, run } from "./main.js";
import { FakeTransport } from "./transport/fake.js";
import { networkError } from "./problems.js";

async function patchCli(t: TestContext, transport: FakeTransport) {
  const directory = await mkdtemp(path.join(tmpdir(), "playlist-patch-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "config.json");
  await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "test-token" }), { mode: 0o600 });
  return async (argv: string[], input = "") => {
    let output = "";
    const code = await run({ ...processRuntime(), argv: ["--config", config, ...argv], cwd: () => directory, env: {}, transport,
      stdin: Readable.from([input]), isStdinTty: () => false,
      stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
      stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    });
    return { code, output };
  };
}

test("playlist rename sends only the new name and revision guard, without reading/replacing the document", async t => {
  const writes: unknown[] = [];
  const transport = new FakeTransport().on("PATCH", "/api/playlists/pl_TEST", request => {
    assert.equal(request.headers?.["if-match"], '"7"');
    assert.ok(request.headers?.["idempotency-key"]);
    writes.push(request.body);
    return { status: 200, headers: {}, body: { id: "pl_TEST", name: "Cello — 36 tracks", revision: 8 } };
  });
  const invoke = await patchCli(t, transport);
  const answer = await invoke(["playlist", "rename", "pl_TEST", "--name", " Cello — 36 tracks ", "--expect-rev", "7"]);
  assert.equal(answer.code, 0, answer.output);
  assert.deepEqual(writes, [{ name: "Cello — 36 tracks" }]);
  assert.equal(JSON.parse(answer.output).data.revision, 8);
});

test("playlist patch preserves audio null and returns the pending approval instead of claiming application", async t => {
  const transport = new FakeTransport().on("PATCH", "/api/playlists/pl_TEST", request => {
    assert.deepEqual(request.body, { audio: null });
    assert.equal(request.headers?.["screenrig-review-note"], "Remove%20music");
    return { status: 202, headers: {}, body: { status: "pending_review", review: { id: "rvw_TEST", state: "pending", kind: "playlist_change", subject: { id: "pl_TEST", type: "playlist", name: "Recordings" }, url: "https://screenrig.ai/dashboard/reviews/rvw_TEST" } } };
  });
  const invoke = await patchCli(t, transport);
  const answer = await invoke(["playlist", "patch", "pl_TEST", "-", "--note", "Remove music"], '{"audio":null}');
  assert.equal(answer.code, 0, answer.output);
  const envelope = JSON.parse(answer.output);
  assert.equal(envelope.data.review.id, "rvw_TEST");
  assert.equal(envelope.warnings[0].code, "pending_review");
});

test("partial playlist patch retries retain exactly the original body and saved write key", async t => {
  const bodies: unknown[] = [], keys: string[] = [];
  const transport = new FakeTransport().on("PATCH", "/api/playlists/pl_TEST", request => {
    bodies.push(request.body);
    keys.push(request.headers!["idempotency-key"]!);
    if (bodies.length === 1) throw networkError("Connection ended after the write");
    return { status: 200, headers: {}, body: { id: "pl_TEST", name: "New name", revision: 9 } };
  });
  const invoke = await patchCli(t, transport);
  const argv = ["playlist", "patch", "pl_TEST", "--name", "New name", "--clear-audio"];
  assert.notEqual((await invoke(argv)).code, 0);
  const answer = await invoke(argv);
  assert.equal(answer.code, 0, answer.output);
  assert.deepEqual(bodies, [{ name: "New name", audio: null }, { name: "New name", audio: null }]);
  assert.equal(new Set(keys).size, 1);
});

test("playlist patch rejects unsupported or ambiguous fields before sending a request", async t => {
  const invoke = await patchCli(t, new FakeTransport());
  for (const body of ['{}', '{"revision":8}', '{"name":null}', '{"pages":[]}', '{"audio":42}']) {
    const answer = await invoke(["playlist", "patch", "pl_TEST", "-"], body);
    assert.equal(answer.code, 2, answer.output);
  }
  const duplicate = await invoke(["playlist", "patch", "pl_TEST", "-", "--name", "Override"], '{"name":"Original"}');
  assert.equal(duplicate.code, 2, duplicate.output);
});

test("human playlist lists distinguish equal names with identity, revision and update time", async t => {
  const transport = new FakeTransport().on("GET", "/api/playlists", () => ({ status: 200, headers: {}, body: { items: [
    { id: "pl_OLD", name: "Recordings", revision: 4, updated_at: "2026-10-19T10:00:00Z" },
    { id: "pl_NEW", name: "Recordings", revision: 8, updated_at: "2026-10-20T10:00:00Z" },
  ], next_cursor: null } }));
  const invoke = await patchCli(t, transport);
  const answer = await invoke(["playlist", "list", "--human"]);
  assert.equal(answer.code, 0, answer.output);
  assert.match(answer.output, /pl_OLD\t4\t2026-10-19T10:00:00Z\tRecordings/);
  assert.match(answer.output, /pl_NEW\t8\t2026-10-20T10:00:00Z\tRecordings/);
});


test("application rename also keeps its saved PATCH key after an ambiguous network failure", async t => {
  const keys: string[] = [];
  const transport = new FakeTransport().on("PATCH", "/api/applications/app_TEST", request => {
    assert.deepEqual(request.body, { name: "New application name" });
    keys.push(request.headers!["idempotency-key"]!);
    if (keys.length === 1) throw networkError("Connection ended after the write");
    return { status: 200, headers: {}, body: { id: "app_TEST", name: "New application name", revision: 4 } };
  });
  const invoke = await patchCli(t, transport);
  const argv = ["app", "rename", "app_TEST", "--name", "New application name"];
  assert.notEqual((await invoke(argv)).code, 0);
  const answer = await invoke(argv);
  assert.equal(answer.code, 0, answer.output);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 1);
});
