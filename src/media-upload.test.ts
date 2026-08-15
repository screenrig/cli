import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { MediaUploadSession } from "./adapters/protocol.js";
import { ApiClient } from "./client.js";
import { isValidIdempotencyKey } from "./ids.js";
import {
  deriveCommitIdempotencyKey,
  performSignedMediaPut,
  prepareMediaUpload,
  validateMediaUploadSession,
} from "./media-upload.js";
import { CliError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

function session(headers: Record<string, unknown> = { "content-type": "image/png", "x-signed": "yes" }): MediaUploadSession {
  return {
    id: "upload_1",
    operation: { id: "op_1", kind: "media.upload", state: "queued", created_at: "2026-08-14T17:00:00Z", updated_at: "2026-08-14T17:00:00Z" },
    upload_url: "https://storage.example.invalid/private?signature=secret",
    method: "PUT",
    headers,
    expires_at: "2099-08-14T17:05:00Z",
  };
}

test("prepares supported media with inferred or explicit content type", async () => {
  const dir = await testTemp("media-");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "pixel.PNG");
  const bytes = Buffer.from([0, 255, 1, 2]);
  await writeFile(file, bytes);
  try {
    const prepared = await prepareMediaUpload(file);
    assert.equal(prepared.declaration.content_type, "image/png");
    assert.equal(prepared.declaration.filename, "pixel.PNG");
    assert.deepEqual(prepared.bytes, bytes);
    assert.match(prepared.declaration.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(prepared.commit, {
      content_type: prepared.declaration.content_type,
      bytes: prepared.declaration.bytes,
      sha256: prepared.declaration.sha256,
    });
    assert.equal((await prepareMediaUpload(file, "video/webm")).declaration.content_type, "video/webm");
    await assert.rejects(() => prepareMediaUpload(file, "text/plain"), CliError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validates hostile signed sessions without leaking signed material", () => {
  const valid = validateMediaUploadSession(session());
  assert.equal(valid.uploadUrl, session().upload_url);
  assert.deepEqual(valid.headers, { "content-type": "image/png", "x-signed": "yes" });
  for (const hostile of [
    session({ "content-type": 7 }),
    { ...session(), method: "POST" },
    { ...session(), upload_url: "/relative" },
    { ...session(), upload_url: "https://user:pass@storage.example.invalid/x" },
    { ...session(), expires_at: "2000-01-01T00:00:00Z" },
  ]) {
    assert.throws(() => validateMediaUploadSession(hostile as MediaUploadSession), (error) => {
      assert.ok(error instanceof CliError);
      assert.ok(!error.message.includes("signature=secret"));
      assert.ok(!error.message.includes("x-signed"));
      return true;
    });
  }
});

test("signed PUT preserves exact raw bytes and headers without account credential leakage", async () => {
  const bytes = Buffer.from([0, 255, 3, 4]);
  const prepared = {
    bytes,
    declaration: { filename: "x.png", content_type: "image/png" as const, bytes: bytes.length, sha256: "a".repeat(64) },
    commit: { content_type: "image/png" as const, bytes: bytes.length, sha256: "a".repeat(64) },
  };
  const validated = validateMediaUploadSession(session());
  let captured: unknown;
  await performSignedMediaPut(prepared, validated, async (request) => {
    captured = request;
    return { status: 204 };
  });
  const request = captured as Record<string, unknown>;
  assert.equal(request.method, "PUT");
  assert.equal(request.credentials, "omit");
  assert.equal(request.redirect, "error");
  assert.equal(request.body, bytes);
  assert.deepEqual(request.headers, { "content-type": "image/png", "x-signed": "yes" });
  const serialized = JSON.stringify(request.headers);
  assert.doesNotMatch(serialized, /authorization|cookie|idempotency|x-request-id/i);
  await assert.rejects(() => performSignedMediaPut(prepared, validated, async () => ({ status: 403, bodyText: "secret" })), (error) => {
    assert.ok(error instanceof CliError);
    assert.ok(!error.message.includes("secret"));
    assert.ok(!error.message.includes("signature="));
    return true;
  });
});

test("commit idempotency key is deterministic, distinct, valid, and honored per call", async () => {
  const base = "base-idempotency-key";
  const derived = deriveCommitIdempotencyKey(base);
  assert.equal(derived, deriveCommitIdempotencyKey(base));
  assert.notEqual(derived, base);
  assert.ok(isValidIdempotencyKey(derived));
  assert.ok(derived.length <= 200);
  const transport = new FakeTransport().on("POST", "/commit", () => ({ status: 202, headers: {}, body: {} }));
  const client = new ApiClient({ transport, idempotencyKey: base });
  await client.call({ method: "POST", path: "/commit", idempotent: true, idempotencyKey: derived });
  assert.equal(transport.calls[0]?.headers?.["idempotency-key"], derived);
});
