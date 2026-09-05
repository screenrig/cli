import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Readable } from "node:stream";
import { fetchSignedRawPut, spawnRunProcess } from "./runtime.js";

for (const stream of ["stdout", "stderr"] as const) {
  test(`process streaming bounds unterminated ${stream} lines`, async () => {
    const seen: string[] = [];
    const result = await spawnRunProcess()({ command: process.execPath,
      args: ["-e", `process.${stream}.write('x'.repeat(100000)); setTimeout(()=>{},1000)`],
      maxLineChars: 1024, timeoutMs: 2000,
      ...(stream === "stdout" ? { onStdoutLine: (line: string) => { seen.push(line); } } : { onStderrLine: (line: string) => { seen.push(line); } }) });
    assert.equal(result.outputTruncated, true);
    assert.equal(result.stoppedEarly, true);
    assert.equal(result.stdout, ""); assert.equal(result.stderrTail, "");
    assert.equal(seen.length, 0);
  });
}

test("streamed stderr is not retained and rejection stops the process", async () => {
  const seen: string[] = [];
  const result = await spawnRunProcess()({ command: process.execPath,
    args: ["-e", "process.stderr.write('reject\\n'); setTimeout(()=>{},1000)"], timeoutMs: 2000,
    onStderrLine: (line) => { seen.push(line); return false; } });
  assert.deepEqual(seen, ["reject"]);
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.stderrTail, "");
});

test("streamed final lines are delivered and timeouts remain visible", async () => {
  const seen: string[] = [];
  const result = await spawnRunProcess()({ command: process.execPath, args: ["-e", "process.stderr.write('final')"],
    onStderrLine: (line) => { seen.push(line); } });
  assert.deepEqual(seen, ["final"]); assert.equal(result.code, 0); assert.equal(result.outputTruncated, false);
  const timeout = await spawnRunProcess()({ command: process.execPath, args: ["-e", "setTimeout(()=>{},2000)"], timeoutMs: 30 });
  assert.equal(timeout.timedOut, true);
});


const signedRequest = {
  url: "https://storage.example.invalid/upload",
  method: "PUT" as const,
  headers: {},
  credentials: "omit" as const,
  redirect: "error" as const,
};

test("signed upload retains the verified bytes and cancels an unused response body", async () => {
  const bytes = Buffer.from([7, 8, 9]);
  let cancelled = false;
  const put = fetchSignedRawPut(async (_url, init) => {
    assert.ok(init?.body instanceof Readable);
    for await (const chunk of init.body) {
      assert.equal(chunk.buffer, bytes.buffer, "upload chunks must reference the held verified bytes");
      assert.deepEqual(chunk, bytes);
    }
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
  });
  assert.deepEqual(await put({ ...signedRequest, body: bytes }), { status: 200 });
  assert.equal(cancelled, true, "an unending storage response must not hold the upload open");
});

test("signed upload destroys its source even when fetch fails before consuming it", async () => {
  const source = new Readable({ read() { throw new Error("must not consume on rejected fetch"); } });
  const put = fetchSignedRawPut(async () => { throw new Error("connection refused"); });
  await assert.rejects(put({ ...signedRequest, body: source }), /connection refused/);
  assert.equal(source.destroyed, true);
});

test("signed upload aborts at session expiry and releases the source", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const source = new Readable({ read() {} });
  let signal: AbortSignal | null | undefined;
  const put = fetchSignedRawPut(async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
    });
  });
  const rejected = assert.rejects(put({ ...signedRequest, body: source, expiresAt: 1005 }), /abort/i);
  t.mock.timers.tick(5);
  await rejected;
  assert.equal(signal?.aborted, true);
  assert.equal(source.destroyed, true);
});

test("expired signed upload sessions do not contact storage", async () => {
  let called = false;
  const put = fetchSignedRawPut(async () => { called = true; return new Response(null, { status: 204 }); });
  await assert.rejects(put({ ...signedRequest, body: Buffer.from([1]), expiresAt: 0 }), /expired/);
  assert.equal(called, false);
});


test("the real Fetch Request consumes verified bytes with bounded read-ahead", async (t) => {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 19);
  const slices = t.mock.method(bytes, "subarray", bytes.subarray);
  const expected = createHash("sha256").update(bytes).digest("hex");
  let received = 0;
  const actual = createHash("sha256");
  const put = fetchSignedRawPut(async (url, init) => {
    const request = new Request(url, init);
    assert.equal(request.headers.get("content-length"), String(bytes.length));
    // Let Fetch request its initial chunks without draining the body.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(slices.mock.callCount() <= 4, "the body adapter must not eagerly materialize all upload chunks");
    const reader = request.body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      assert.ok(value.byteLength <= 512 * 1024, "read-ahead remains bounded under Fetch consumption");
      actual.update(value);
      received += value.byteLength;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    reader.releaseLock();
    return new Response(null, { status: 204 });
  });
  await put({ ...signedRequest, headers: { "content-length": String(bytes.length) }, body: bytes });
  assert.equal(received, bytes.length);
  assert.equal(actual.digest("hex"), expected);
});
