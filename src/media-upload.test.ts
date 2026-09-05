import assert from "node:assert/strict";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
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

function webpChunk(id: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(id), size, data, pad]);
}

function losslessWebp(width = 8, height = 8): Buffer {
  const bits = Buffer.alloc(5);
  bits.writeUInt8(0x2f, 0);
  bits.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  const body = Buffer.concat([Buffer.from("WEBP"), webpChunk("VP8L", bits)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), size, body]);
}

function lossyVp8xWebp(width = 8, height = 8): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([Buffer.from("WEBP"), webpChunk("VP8X", data)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), size, body]);
}

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

test("verified video hash binds the exact buffered upload bytes", async () => {
  const dir = await testTemp("media-verified-");
  const file = path.join(dir, "clip.mp4");
  try {
    await writeFile(file, Buffer.from("verified video bytes"));
    const original = await prepareMediaUpload(file);
    const prepared = await prepareMediaUpload(file, "video/mp4", original.declaration.sha256);
    await writeFile(file, Buffer.from("changed after verification"));
    assert.deepEqual(prepared.bytes, original.bytes, "the signed PUT retains the verified Buffer despite later path changes");
    await assert.rejects(() => prepareMediaUpload(file, "video/mp4", original.declaration.sha256), /changed after delivery verification/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

    const lossyPath = path.join(dir, "lossy.webp");
    await writeFile(lossyPath, lossyVp8xWebp());
    const lossy = await prepareMediaUpload(lossyPath);
    assert.equal(lossy.declaration.content_type, "image/webp");

    const losslessPath = path.join(dir, "lossless.webp");
    await writeFile(losslessPath, losslessWebp());
    await assert.rejects(() => prepareMediaUpload(losslessPath), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.problem.code, "usage_error");
      assert.match(error.message, /Lossless WebP \(VP8L\) is not accepted/);
      assert.match(error.message, /--no-transcode/);
      return true;
    });
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
    assert.match(error.message, /HTTP 403/);
    return true;
  });
  await assert.rejects(() => performSignedMediaPut(prepared, validated, async () => {
    throw new Error("connect refused");
  }), (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.problem.code, "transport_error");
    assert.equal(error.problem.status, 503);
    assert.match(error.message, /not ready/);
    assert.match(error.message, /doctor/);
    assert.match(error.message, /ready/);
    assert.ok(!error.message.includes("connect refused"));
    return true;
  });
  await assert.rejects(() => performSignedMediaPut(prepared, validated, async () => ({ status: 503, bodyText: "secret" })), (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.problem.code, "transport_error");
    assert.equal(error.problem.status, 503);
    assert.match(error.message, /not ready/);
    assert.match(error.message, /doctor/);
    assert.ok(!error.message.includes("secret"));
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


test("media admission rejects oversized files before reading or allocating their payload", async (t) => {
  const dir = await testTemp("media-limit-");
  const file = path.join(dir, "oversized.mp4");
  const handle = await open(file, "w");
  const prototype = Object.getPrototypeOf(handle);
  await handle.truncate(1_073_741_825);
  await handle.close();
  const reads = t.mock.method(prototype, "read", () => { throw new Error("oversized payload must not be read"); });
  try {
    await assert.rejects(prepareMediaUpload(file), /1 GiB per-upload transport ceiling/);
    assert.equal(reads.mock.callCount(), 0);
    await assert.rejects(prepareMediaUpload(dir, "video/mp4"), /regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("media snapshot rejects growth during a bounded descriptor read", async (t) => {
  const dir = await testTemp("media-growth-");
  const file = path.join(dir, "clip.mp4");
  const handle = await open(file, "w+");
  await handle.writeFile(Buffer.alloc(300_000, 7));
  const prototype = Object.getPrototypeOf(handle);
  const read = prototype.read;
  let requested = 0;
  let changed = false;
  t.mock.method(prototype, "read", async function (this: typeof handle, ...args: [Buffer, number, number, number]) {
    requested += Number(args[2]);
    const result = await read.apply(this, args);
    if (!changed) {
      changed = true;
      await handle.truncate(2_000_000);
    }
    return result;
  });
  try {
    await assert.rejects(prepareMediaUpload(file), /changed while reading/);
    assert.equal(requested, 300_000, "file growth cannot enlarge the admitted allocation/read budget");
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test("media read errors preserve the usage envelope and close the descriptor", async (t) => {
  const dir = await testTemp("media-read-error-");
  const file = path.join(dir, "clip.mp4");
  const handle = await open(file, "w");
  await handle.writeFile("bytes");
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  let failedHandle: typeof handle | undefined;
  t.mock.method(prototype, "read", function (this: typeof handle) {
    failedHandle = this;
    throw new Error("untrusted read diagnostic");
  });
  try {
    await assert.rejects(prepareMediaUpload(file), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.problem.code, "usage_error");
      assert.doesNotMatch(error.message, /untrusted/);
      return true;
    });
    assert.equal(failedHandle?.fd, -1, "the failed read descriptor must be closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
