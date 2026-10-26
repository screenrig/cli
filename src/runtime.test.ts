import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { Readable } from "node:stream";
import { childEnv } from "./child-env.js";
import { fetchSignedRawPut, SIGNED_PUT_ANSWER_MS, SIGNED_PUT_IDLE_MS, signedPutDispatcher, spawnRunProcess } from "./runtime.js";
import { spawnDetached } from "./open-url.js";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { testTemp } from "./test-temp.js";

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

/** A fetch that waits until its signal aborts, as a stalled connection does. */
function stalledFetch(onStart: (init: RequestInit) => Promise<void> = async () => undefined): typeof fetch {
  return async (_url, init) => {
    await onStart(init!);
    const signal = init!.signal!;
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a signed upload already sending is not cut off at session expiry, only after it moves no bytes for ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const source = new Readable({ read() {} });
  let signal: AbortSignal | null | undefined;
  const put = fetchSignedRawPut(stalledFetch(async (init) => { signal = init.signal; }));
  const pending = put({ ...signedRequest, body: source, expiresAt: 1005 });
  pending.catch(() => undefined);
  await settle();
  t.mock.timers.tick(10);
  assert.equal(signal?.aborted, false, "storage checks the URL when the PUT starts, so expiry does not end it");
  t.mock.timers.tick(SIGNED_PUT_IDLE_MS - 20);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(10);
  await assert.rejects(pending, (error: Error & { code?: string }) => error.code === "UPLOAD_STALLED");
  assert.equal(source.destroyed, true);
});

test("every chunk the connection takes restarts the stall limit, and after the last one storage gets thirty minutes to answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const bytes = Buffer.alloc(4 * 256 * 1024, 1);
  let chunks = 0;
  const put = fetchSignedRawPut(async (_url, init) => {
    for await (const _chunk of init!.body as Readable) {
      chunks += 1;
      // The last chunk is taken at once; storage's answer then has its own limit.
      if (chunks === 4) continue;
      t.mock.timers.tick(SIGNED_PUT_IDLE_MS - 1000);
      assert.equal(init!.signal!.aborted, false, "a slow link that keeps moving is never ended");
    }
    t.mock.timers.tick(SIGNED_PUT_ANSWER_MS - 1000);
    assert.equal(init!.signal!.aborted, false, "the operating system may still be sending what it accepted");
    return new Response(null, { status: 200 });
  });
  assert.ok(SIGNED_PUT_IDLE_MS < SIGNED_PUT_ANSWER_MS);
  assert.deepEqual(await put({ ...signedRequest, body: bytes, expiresAt: 1005 }), { status: 200 });
  assert.equal(chunks, 4);
});

test("a signed upload whose answer never comes ends thirty minutes after its last byte", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let signal: AbortSignal | undefined;
  let drained = false;
  const put = fetchSignedRawPut(stalledFetch(async (init) => {
    signal = init.signal!;
    for await (const _chunk of init.body as Readable) { /* a fast link takes every byte */ }
    drained = true;
  }));
  const pending = put({ ...signedRequest, body: Buffer.alloc(1024, 2) });
  pending.catch(() => undefined);
  while (!drained) await settle();
  t.mock.timers.tick(SIGNED_PUT_ANSWER_MS - 1);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, (error: Error & { code?: string }) => error.code === "UPLOAD_UNANSWERED");
});

/** R2's answer to a PUT whose signature did not match: the message, then the signed request it computed. */
const SIGNATURE_REFUSAL = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code>'
  + "<Message>The request signature we calculated does not match the signature you provided. Check your secret access key and signing method.</Message>"
  + "<StringToSign>AWS4-HMAC-SHA256\n20261026T022959Z\n20261026/us-east-1/s3/aws4_request\nb4babbdc0cca0596610cac7457e4050e</StringToSign>"
  + "<CanonicalRequest>PUT\n/bucket/staging/obj\nX-Amz-Credential=AKIDEXAMPLE%2F20261026&amp;X-Amz-Signature=0123456789abcdef</CanonicalRequest></Error>";

test("a storage refusal reports its error code and message, and nothing else from its body", async () => {
  const answer = (status: number, body: string) => fetchSignedRawPut(async () => new Response(body, { status, headers: { "content-type": "application/xml" } }));
  const signature = await answer(403, SIGNATURE_REFUSAL)({ ...signedRequest, body: Buffer.from([1]) });
  assert.deepEqual(signature, {
    status: 403,
    errorCode: "SignatureDoesNotMatch",
    errorMessage: "The request signature we calculated does not match the signature you provided. Check your secret access key and signing method",
  });
  assert.doesNotMatch(JSON.stringify(signature), /StringToSign|AWS4|Credential|Signature=|bucket/);

  const digest = await answer(400, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>BadDigest</Code><Message>The SHA-256 checksum you specified did not match what we received.\nYou provided a SHA-256 checksum with value: 8539f10d\nActual SHA-256 was: 58af0375</Message></Error>")({ ...signedRequest, body: Buffer.from([1]) });
  assert.deepEqual(digest, {
    status: 400,
    errorCode: "BadDigest",
    errorMessage: "The SHA-256 checksum you specified did not match what we received. You provided a SHA-256 checksum with value: 8539f10d Actual SHA-256 was: 58af0375",
  });
  const expired = await answer(403, "<Error><Code>ExpiredRequest</Code><Message>Request has expired at https://storage.example.invalid/obj?X-Amz-Signature=abc</Message></Error>")({ ...signedRequest, body: Buffer.from([1]) });
  assert.deepEqual(expired, { status: 403, errorCode: "ExpiredRequest", errorMessage: "Request has expired at [url]" });
  assert.deepEqual(await answer(502, "<html><body>Bad gateway</body></html>")({ ...signedRequest, body: Buffer.from([1]) }), { status: 502 });
});

test("a refusal whose body never ends is read only as far as its first 8 KiB", async () => {
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message>")); },
    pull(controller) { controller.enqueue(new Uint8Array(1024).fill(32)); },
    cancel() { cancelled = true; },
  });
  const put = fetchSignedRawPut(async () => new Response(endless, { status: 503 }));
  assert.deepEqual(await put({ ...signedRequest, body: Buffer.from([1]) }), { status: 503, errorCode: "SlowDown", errorMessage: "Please reduce your request rate" });
  assert.equal(cancelled, true);
});

test("a signed upload asks Node's fetch for no headers or body timeout of its own", async () => {
  const key = Symbol.for("undici.globalDispatcher.1");
  const global = globalThis as Record<symbol, unknown>;
  const saved = global[key];
  const seen: object[] = [];
  global[key] = { dispatch: (options: object) => { seen.push(options); return true; } };
  try {
    const put = fetchSignedRawPut(async (_url, init) => {
      (init as { dispatcher: { dispatch(options: object, handler: object): boolean } }).dispatcher.dispatch({ method: "PUT", path: "/upload" }, {});
      return new Response(null, { status: 200 });
    });
    await put({ ...signedRequest, body: Buffer.from([1]) });
  } finally {
    global[key] = saved;
  }
  assert.deepEqual(seen, [{ method: "PUT", path: "/upload", headersTimeout: 0, bodyTimeout: 0 }]);
});

test("this Node's fetch applies the signed upload's own timeouts per request", async (t) => {
  const answers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => { answers.add(setTimeout(() => res.end("ok"), req.url === "/slow" ? 3000 : 0)); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { answers.forEach(clearTimeout); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  void fetch;
  const short = signedPutDispatcher({ headersTimeout: 100, bodyTimeout: 0 });
  assert.ok(short, "Node keeps a global fetch dispatcher to wrap");
  await assert.rejects(
    fetch(`${origin}/slow`, { method: "PUT", body: "x", dispatcher: short } as RequestInit),
    (error: Error & { cause?: { code?: string } }) => error.cause?.code === "UND_ERR_HEADERS_TIMEOUT",
  );
  const response = await fetch(`${origin}/fast`, { method: "PUT", body: "x", dispatcher: signedPutDispatcher() } as RequestInit);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
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

const CREDENTIAL_ENV = {
  SCREENRIG_TOKEN: "sr_live_never_in_a_child",
  SCREENRIG_CLIENT_ID: "scl_AAAAAAAAAAAAAAAAAAAAAAAA",
  SCREENRIG_CLIENT_SECRET: "sr_cs_never_in_a_child",
  SCREENRIG_CLIENT_KEY_FILE: "/home/user/service.jwk",
  SCREENRIG_CONFIG: "/home/user/config.json",
  screenrig_api_url: "https://api.screenrig.ai",
};

test("childEnv drops every SCREENRIG_ variable and keeps the rest", () => {
  const env = childEnv({ ...CREDENTIAL_ENV, PATH: "/usr/bin", HOME: "/home/user", DISPLAY: ":0", NOT_SCREENRIG_X: "1" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/user", DISPLAY: ":0", NOT_SCREENRIG_X: "1" });
});

test("a spawned process receives the environment without SCREENRIG_ credentials", async () => {
  const code = "process.stdout.write(JSON.stringify(Object.keys(process.env).filter((name) => /^screenrig_/i.test(name)).concat([process.env.KEEP ?? 'missing'])))";
  const result = await spawnRunProcess({ ...process.env, ...CREDENTIAL_ENV, KEEP: "kept" })({ command: process.execPath, args: ["-e", code] });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), ["kept"]);
});

test("a detached file opener receives the environment without SCREENRIG_ credentials", async () => {
  const dir = await testTemp("opener-env-");
  try {
    const out = path.join(dir, "env.json");
    const code = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(Object.keys(process.env).filter((name) => /^screenrig_/i.test(name))))";
    assert.equal(await spawnDetached(process.execPath, ["-e", code, out], 2000, { ...process.env, ...CREDENTIAL_ENV }), true);
    assert.deepEqual(JSON.parse(await readFile(out, "utf8")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
