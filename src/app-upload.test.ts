import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { SDK_PROTOCOL_VERSION } from "./adapters/sdk-injection.js";
import { writeConfigAtomic } from "./config.js";
import { run } from "./main.js";
import type { SignedRawPutRequest } from "./runtime.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";

const DIRECT = { application_direct_uploads: true };

async function appFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const configDir = await testTemp("app-upload-");
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const fs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_existing_secret",
  }, fs);
  const appDir = path.join(configDir, "app");
  await mkdir(appDir);
  await writeFile(path.join(appDir, "index.html"), "<!doctype html><html><head></head><body>hello</body></html>");
  return { configDir, fs, appDir };
}

async function runApp(
  fixture: Awaited<ReturnType<typeof appFixture>>,
  argv: string[],
  transport: FakeTransport,
  puts: SignedRawPutRequest[],
  putStatus = 200,
): Promise<{ code: number; envelope: Record<string, any> }> {
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, callback) { output += chunk; callback(); } });
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const code = await run({
    argv: ["--json", ...argv], env: fixture.fs.env, stdout, stderr, fs: fixture.fs, homedir: fixture.fs.homedir,
    cwd: () => fixture.configDir, transport,
    now: () => new Date("2026-09-10T00:00:00Z"), sleep: async () => undefined,
    signedRawPut: async (request) => { puts.push(request); return { status: putStatus }; },
  });
  return { code, envelope: JSON.parse(output) };
}

for (const action of ["upload", "update"] as const) {
  test(`app ${action} sends the archive straight to the object store where the server takes it, with the streamed envelope`, async (t) => {
    const fixture = await appFixture(t);
    const argv = ["app", action, ...(action === "update" ? ["app_EXISTING", fixture.appDir, "--expect-rev", "7"] : [fixture.appDir, "--name", "Lobby board"]), "--poll-ms", "1"];

    const streamed = memoryBackend();
    if (action === "update") {
      streamed.on("POST", "/api/applications/app_EXISTING/releases", () => ({ status: 202, headers: {}, body: {
        id: "app_EXISTING", release_id: "rel_NEW", operation_id: "op_AAAAAAAAAAAAAAAAAAAAAAAA",
      } }));
    }
    const legacy = await runApp(fixture, argv, streamed, []);
    assert.equal(legacy.code, 0, JSON.stringify(legacy.envelope));

    const transport = memoryBackend({ features: DIRECT });
    const puts: SignedRawPutRequest[] = [];
    const direct = await runApp(fixture, argv, transport, puts);
    assert.equal(direct.code, 0, JSON.stringify(direct.envelope));

    // Declare, signed PUT, commit; the API never receives the archive.
    const writes = transport.calls.filter((call) => call.method === "POST").map((call) => call.path);
    const declarePath = action === "update" ? "/api/applications/app_EXISTING/uploads" : "/api/applications/uploads";
    assert.deepEqual(writes, [declarePath, "/api/applications/uploads/op_AAAAAAAAAAAAAAAAAAAAAAAA/commit"]);
    const declare = transport.calls.find((call) => call.path === declarePath)!;
    const data = direct.envelope.data;
    assert.deepEqual(declare.body, {
      ...(action === "upload" ? { name: "Lobby board" } : {}),
      sha256: data.pack.sha256,
      compressed_bytes: (declare.body as { compressed_bytes: number }).compressed_bytes,
      expanded_bytes: (declare.body as { expanded_bytes: number }).expanded_bytes,
      file_count: data.pack.file_count,
      sdk_version: SDK_PROTOCOL_VERSION,
    });
    assert.equal(declare.headers?.["if-match"], action === "update" ? '"7"' : undefined);
    assert.ok(declare.headers?.["idempotency-key"], "the declaration is idempotent");
    assert.equal(puts.length, 1);
    assert.equal(puts[0]!.url, "https://storage.example.invalid/signed/application-upload");
    assert.deepEqual(puts[0]!.headers, { "content-type": "application/gzip", "content-length": String((declare.body as { compressed_bytes: number }).compressed_bytes) });
    const sent = puts[0]!.body as Uint8Array;
    assert.equal(sent.byteLength, (declare.body as { compressed_bytes: number }).compressed_bytes);
    assert.equal(createHash("sha256").update(sent).digest("hex"), data.pack.sha256);
    const commit = transport.calls.find((call) => call.path.endsWith("/commit"))!;
    assert.deepEqual(commit.body, { sha256: data.pack.sha256, compressed_bytes: sent.byteLength });
    assert.ok(commit.headers?.["idempotency-key"], "the commit is idempotent");

    // The envelope is the streamed upload's, field for field.
    assert.deepEqual(Object.keys(data).sort(), Object.keys(legacy.envelope.data).sort());
    assert.deepEqual(data.application, legacy.envelope.data.application);
    assert.equal(data.id, data.application.id);
    assert.equal(data.release_id, data.application.release_id);
    assert.equal(data.operation_id, data.application.operation_id);
    assert.equal(direct.envelope.operation_id, data.application.operation_id);
    assert.equal(data.operation.state, "succeeded");
    assert.equal(data.sha256, legacy.envelope.data.sha256);
  });
}

/** The memory backend, with a commit that answers `commitStatus` until `failures` run out. */
function directOnly(failures: number, commitStatus: number, code: string): { transport: FakeTransport; commits: () => number } {
  const transport = new FakeTransport();
  const backend = memoryBackend({ features: DIRECT });
  let commits = 0;
  transport.on("POST", /\/commit$/, (req) => {
    commits += 1;
    if (commits <= failures) {
      return { status: commitStatus, headers: { "content-type": "application/problem+json" }, body: { status: commitStatus, code, title: "Refused", detail: "Commit refused." } };
    }
    return backend.request(req);
  });
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) transport.on(method, /.*/, (req) => backend.request(req));
  return { transport, commits: () => commits };
}

test("app upload repeats a commit the server could not answer", async (t) => {
  const fixture = await appFixture(t);
  const recovered = directOnly(2, 500, "dependency_unavailable");
  const result = await runApp(fixture, ["app", "upload", fixture.appDir, "--no-wait"], recovered.transport, []);
  assert.equal(result.code, 0, JSON.stringify(result.envelope));
  assert.equal(recovered.commits(), 3);
  assert.equal(result.envelope.data.application.release_id, "rel_AAAAAAAAAAAAAAAAAAAAAAAA");

  const unavailable = directOnly(10, 500, "dependency_unavailable");
  const failed = await runApp(fixture, ["app", "upload", fixture.appDir, "--no-wait"], unavailable.transport, []);
  assert.notEqual(failed.code, 0);
  assert.equal(failed.envelope.error.code, "dependency_unavailable");
  assert.equal(unavailable.commits(), 4, "the commit is sent four times in all");

  const refused = directOnly(10, 400, "invalid_request");
  const rejected = await runApp(fixture, ["app", "upload", fixture.appDir, "--no-wait"], refused.transport, []);
  assert.notEqual(rejected.code, 0);
  assert.equal(refused.commits(), 1, "a refusal is not repeated");
});

test("app upload does not commit when the signed PUT is refused", async (t) => {
  const fixture = await appFixture(t);
  const transport = memoryBackend({ features: DIRECT });
  const puts: SignedRawPutRequest[] = [];
  const result = await runApp(fixture, ["app", "upload", fixture.appDir, "--no-wait"], transport, puts, 403);
  assert.notEqual(result.code, 0);
  assert.equal(result.envelope.error.code, "transport_error");
  assert.match(result.envelope.error.detail, /Application package upload returned HTTP 403/);
  assert.equal(puts.length, 1);
  assert.equal(transport.calls.some((call) => call.path.endsWith("/commit")), false);
});
