import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import type { MediaUploadSession } from "./adapters/protocol.js";
import { ApiClient } from "./client.js";
import { writeConfigAtomic } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { isValidIdempotencyKey } from "./ids.js";
import { run } from "./main.js";
import {
  deriveCommitIdempotencyKey,
  performSignedMediaPut,
  performSignedMediaStreamPut,
  prepareMediaUpload,
  validateMediaUploadSession,
} from "./media-upload.js";
import { CliError } from "./problems.js";
import type { SignedRawPut } from "./runtime.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";

/** Retries without waiting, so a test does not sleep between attempts. */
const noWait = { sleep: async () => undefined };

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

test("signed PUT preserves exact raw bytes and headers without project credential leakage", async () => {
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
    assert.match(error.message, /refused by storage: HTTP 403/);
    return true;
  });
  await assert.rejects(() => performSignedMediaPut(prepared, validated, async () => {
    throw new Error("connect refused to https://storage.example.invalid/private?signature=secret");
  }, noWait), (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.problem.code, "transport_error");
    assert.equal(error.problem.status, 503);
    assert.equal(error.problem.operation_id, "op_1");
    assert.equal(error.message, "Private media upload to storage was interrupted: the connection failed. It did not finish after 4 attempts.");
    assert.equal(error.problem.hint, "Run the same command again to upload it again.");
    assert.equal(error.problem.next, undefined, "screenrig doctor sends no requests, so it is not the next step");
    assert.doesNotMatch(JSON.stringify(error.problem), /secret|signature|storage\.example|connect refused|doctor|not ready/);
    return true;
  });
  await assert.rejects(() => performSignedMediaPut(prepared, validated, async () => ({ status: 503, bodyText: "secret" }), noWait), (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.problem.code, "transport_error");
    assert.equal(error.problem.status, 503);
    assert.match(error.message, /interrupted: storage answered HTTP 503\. It did not finish after 4 attempts\./);
    assert.ok(!error.message.includes("secret"));
    return true;
  });
});

/** A connection the network cut, the way Node's fetch reports it. */
function connectionReset(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET from storage.example.invalid"), { code: "ECONNRESET" }),
  });
}

test("a dropped connection sends the whole PUT again with the same binding and stops at success", async () => {
  const bytes = Buffer.from([0, 255, 3, 4]);
  const prepared = {
    bytes,
    declaration: { filename: "x.png", content_type: "image/png" as const, bytes: bytes.length, sha256: "a".repeat(64) },
    commit: { content_type: "image/png" as const, bytes: bytes.length, sha256: "a".repeat(64) },
  };
  const validated = validateMediaUploadSession(session());
  const waits: number[] = [];
  let attempts = 0;
  await performSignedMediaPut(prepared, validated, async (request) => {
    attempts += 1;
    assert.equal(request.body, bytes, "every attempt sends the same held bytes from the start");
    assert.equal(request.url, validated.uploadUrl);
    assert.deepEqual(request.headers, validated.headers);
    if (attempts < 3) throw connectionReset();
    return { status: 200 };
  }, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(attempts, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[0]! >= 500 && waits[0]! <= 1000 && waits[1]! >= 1000 && waits[1]! <= 2000, `the wait grows and stays bounded: ${waits.join(", ")}`);

  attempts = 0;
  await assert.rejects(performSignedMediaPut(prepared, validated, async () => {
    attempts += 1;
    throw connectionReset();
  }, noWait), (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, ExitCode.Network);
    assert.equal(error.problem.operation_id, "op_1");
    assert.equal(error.problem.detail, "Private media upload to storage was interrupted: the connection was reset (ECONNRESET). It did not finish after 4 attempts.");
    assert.doesNotMatch(JSON.stringify(error.problem), /storage\.example|signature/);
    return true;
  });
  assert.equal(attempts, 4, "a connection that keeps failing still ends after a bounded number of PUTs");
});

test("a storage refusal names storage's error code and message, never the URL", async () => {
  const bytes = Buffer.from([1, 2]);
  const prepared = {
    bytes,
    declaration: { filename: "x.png", content_type: "image/png" as const, bytes: 2, sha256: "a".repeat(64) },
    commit: { content_type: "image/png" as const, bytes: 2, sha256: "a".repeat(64) },
  };
  const validated = validateMediaUploadSession(session());
  await assert.rejects(performSignedMediaPut(prepared, validated, async () => ({
    status: 403, errorCode: "ExpiredRequest", errorMessage: "Request has expired", bodyText: "secret",
  }), noWait), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.problem.detail, "Private media upload was refused by storage: HTTP 403 ExpiredRequest: Request has expired.");
    assert.equal(error.problem.operation_id, "op_1");
    assert.doesNotMatch(JSON.stringify(error.problem), /secret|signature|storage\.example/);
    return true;
  });
  let attempts = 0;
  await assert.rejects(performSignedMediaPut(prepared, validated, async () => {
    attempts += 1;
    return { status: 503, errorCode: "SlowDown", errorMessage: "Please reduce your request rate" };
  }, noWait), /interrupted: storage answered HTTP 503 SlowDown: Please reduce your request rate\. It did not finish after 4 attempts\./);
  assert.equal(attempts, 4);
});

test("a stalled PUT is sent again and reported as a stall", async () => {
  const bytes = Buffer.from([1, 2]);
  const prepared = {
    bytes,
    declaration: { filename: "x.png", content_type: "image/png" as const, bytes: 2, sha256: "a".repeat(64) },
    commit: { content_type: "image/png" as const, bytes: 2, sha256: "a".repeat(64) },
  };
  const validated = validateMediaUploadSession(session());
  let attempts = 0;
  await assert.rejects(performSignedMediaPut(prepared, validated, async () => {
    attempts += 1;
    throw Object.assign(new Error("No upload bytes moved."), { code: attempts % 2 ? "UPLOAD_STALLED" : "UPLOAD_UNANSWERED" });
  }, noWait), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.problem.detail, "Private media upload to storage was interrupted: storage did not answer within 30 minutes of the last byte. It did not finish after 4 attempts.");
    return true;
  });
  assert.equal(attempts, 4);
  await assert.rejects(performSignedMediaPut(prepared, validated, async () => {
    throw Object.assign(new Error("No upload bytes moved."), { code: "UPLOAD_STALLED" });
  }, noWait), /interrupted: the transfer stalled: no bytes moved for 10 minutes\. It did not finish after 4 attempts\./);
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

test("buffered signed PUT retries transient 503s with the exact binding and stops at success", async () => {
  const bytes = Buffer.from([0, 255, 3, 4]);
  const prepared = {
    bytes,
    declaration: { filename: "x.png", content_type: "image/png" as const, bytes: bytes.length, sha256: "a".repeat(64) },
    commit: { content_type: "image/png" as const, bytes: bytes.length, sha256: "a".repeat(64) },
  };
  const validated = validateMediaUploadSession(session());
  let attempts = 0;
  await performSignedMediaPut(prepared, validated, async (request) => {
    attempts += 1;
    assert.equal(request.body, bytes);
    assert.equal(request.url, validated.uploadUrl);
    assert.deepEqual(request.headers, validated.headers);
    assert.equal(request.credentials, "omit");
    assert.equal(request.redirect, "error");
    assert.equal(request.expiresAt, validated.expiresAt);
    return { status: attempts < 3 ? 503 : 204 };
  }, noWait);
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(performSignedMediaPut(prepared, validated, async () => {
    attempts += 1;
    return { status: 503 };
  }, noWait), /storage answered HTTP 503\. It did not finish after 4 attempts\./);
  assert.equal(attempts, 4, "persistent failures still fail after a bounded number of real PUTs");
  attempts = 0;
  await assert.rejects(performSignedMediaPut(prepared, validated, async () => {
    attempts += 1;
    return { status: 403 };
  }, noWait), /refused by storage: HTTP 403/);
  assert.equal(attempts, 1, "authorization failures are never retried");
});

test("signed PUT never retries a one-shot stream or beyond session expiry", async () => {
  const validated = validateMediaUploadSession(session());
  const stream = (async function* () { yield Buffer.from([1]); })();
  let attempts = 0;
  await assert.rejects(performSignedMediaStreamPut(stream, validated, async () => {
    attempts += 1;
    return { status: 503 };
  }), /^CliError: Private media upload to storage was interrupted: storage answered HTTP 503\.$/);
  assert.equal(attempts, 1);
  const prepared = {
    bytes: Buffer.from([1]),
    declaration: { filename: "x.png", content_type: "image/png" as const, bytes: 1, sha256: "a".repeat(64) },
    commit: { content_type: "image/png" as const, bytes: 1, sha256: "a".repeat(64) },
  };
  const expiring = { ...validated, expiresAt: Date.now() + 100 };
  attempts = 0;
  await assert.rejects(performSignedMediaPut(prepared, expiring, async () => {
    attempts += 1;
    throw connectionReset();
  }, noWait), /reset \(ECONNRESET\)\. Its upload URL expired before it could be sent again\./);
  assert.equal(attempts, 1, "a retry wait cannot outlive the signed session");
  attempts = 0;
  await assert.rejects(performSignedMediaPut(prepared, { ...validated, expiresAt: 0 }, async () => {
    attempts += 1;
    return { status: 204 };
  }), /could not start: its upload URL had expired/);
  assert.equal(attempts, 0);
});

/** Runs the CLI against `transport` with an enrolled config in `dir` and returns the exit code and envelope. */
async function runCli(dir: string, argv: string[], transport: FakeTransport, signedRawPut: SignedRawPut): Promise<{ code: number; envelope: Record<string, any> }> {
  const fs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, env: { XDG_CONFIG_HOME: dir } };
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, callback) { output += chunk; callback(); } });
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const code = await run({
    argv: ["--json", ...argv], env: fs.env, stdout, stderr, fs, homedir: fs.homedir, cwd: () => dir, transport,
    now: () => new Date("2026-08-14T17:00:00Z"), sleep: async () => undefined, signedRawPut,
  });
  return { code, envelope: JSON.parse(output) };
}

test("media upload cancels the declared upload whose bytes could not be sent, so the rerun starts clean", async (t) => {
  const dir = await testTemp("media-put-cut-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, env: { XDG_CONFIG_HOME: dir } };
  await writeConfigAtomic(path.join(dir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization",
    token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr",
  }, fs);
  const file = path.join(dir, "lobby-loop.mp4");
  await writeFile(file, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
  const operation = "op_MEDIAAAAAAAAAAAAAAAAAAAAA";
  let puts = 0;
  const cut: SignedRawPut = async () => { puts += 1; throw connectionReset(); };

  const transport = memoryBackend();
  const failed = await runCli(dir, ["media", "upload", file, "--no-transcode"], transport, cut);
  assert.equal(failed.code, ExitCode.Network, JSON.stringify(failed.envelope));
  assert.equal(puts, 4);
  const error = failed.envelope.error;
  assert.equal(error.code, "transport_error");
  assert.equal(error.operation_id, operation);
  assert.equal(error.detail, "Private media upload to storage was interrupted: the connection was reset (ECONNRESET). It did not finish after 4 attempts.");
  assert.equal(error.hint, `Upload ${operation} was cancelled, so it holds no storage. Run the same command again to upload it again.`);
  assert.equal(error.next, undefined);
  const writes = () => transport.calls.filter((call) => call.method === "POST").map((call) => call.path);
  assert.deepEqual(writes(), ["/api/media/uploads", `/api/operations/${operation}/cancel`]);

  const rerun = await runCli(dir, ["media", "upload", file, "--no-transcode"], transport, async () => ({ status: 200 }));
  assert.equal(rerun.code, 0, JSON.stringify(rerun.envelope));
  assert.equal(rerun.envelope.data.media_id, "med_AAAAAAAAAAAAAAAAAAAAAAAA");

  // An explicit --idempotency-key replays the same declaration on the rerun, so the upload is kept for it.
  const keyed = memoryBackend();
  const kept = await runCli(dir, ["media", "upload", file, "--no-transcode", "--idempotency-key", "lobby-loop-upload-1"], keyed, cut);
  assert.equal(kept.code, ExitCode.Network);
  assert.equal(kept.envelope.error.operation_id, operation);
  assert.equal(kept.envelope.error.hint, "Run the same command again to upload it again.");
  assert.equal(keyed.calls.some((call) => call.path.endsWith("/cancel")), false);
});


test("media admission rejects oversized files before reading or allocating their payload", async (t) => {
  const dir = await testTemp("media-limit-");
  const file = path.join(dir, "oversized.png");
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

/** The prototype of a file handle, whose `read` the tests mock. */
async function fileHandlePrototype(dir: string): Promise<FileHandle> {
  const handle = await open(path.join(dir, "prototype"), "w");
  await handle.close();
  return Object.getPrototypeOf(handle);
}

test("a video over the server's 500,000,000-byte cap is rejected before its payload is read", async (t) => {
  const dir = await testTemp("media-video-limit-");
  const prototype = await fileHandlePrototype(dir);
  try {
    for (const [name, contentType] of [["clip.mp4", undefined], ["clip.webm", undefined], ["clip.bin", "video/mp4"]] as const) {
      const file = path.join(dir, name);
      const handle = await open(file, "w");
      await handle.truncate(500_000_001);
      await handle.close();
      const reads = t.mock.method(prototype, "read", () => { throw new Error("oversized payload must not be read"); });
      await assert.rejects(prepareMediaUpload(file, contentType), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(
          error.problem.detail,
          "Video exceeds the 500,000,000-byte (500 MB) limit for one video upload. Trim the video to a shorter clip, then run the upload again.",
        );
        return true;
      });
      assert.equal(reads.mock.callCount(), 0);
      reads.mock.restore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a video of exactly 500,000,000 bytes is within the cap, and other types keep the 1 GiB transport bound", async (t) => {
  const dir = await testTemp("media-video-boundary-");
  const prototype = await fileHandlePrototype(dir);
  // The payload's content is not under test, only its admission; skip the 500 MB of real reads.
  t.mock.method(prototype, "read", async (...args: unknown[]) => ({ bytesRead: args[2] as number, buffer: args[0] }));
  try {
    const video = path.join(dir, "exact.mp4");
    const videoHandle = await open(video, "w");
    await videoHandle.truncate(500_000_000);
    await videoHandle.close();
    const prepared = await prepareMediaUpload(video);
    assert.equal(prepared.declaration.bytes, 500_000_000);
    assert.equal(prepared.declaration.content_type, "video/mp4");

    // Audio and images stay under the transport bound as before; the server holds them to their own limits.
    const audio = path.join(dir, "long.mp3");
    const audioHandle = await open(audio, "w");
    await audioHandle.truncate(500_000_001);
    await audioHandle.close();
    assert.equal((await prepareMediaUpload(audio)).declaration.bytes, 500_000_001);
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
