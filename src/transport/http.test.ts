import assert from "node:assert/strict";
import { test } from "node:test";
import { FetchTransport } from "./http.js";
import { CliError } from "../problems.js";

function spyResponse(body: Uint8Array | string, init: ResponseInit): {
  response: Response;
  textCalls: () => number;
  arrayBufferCalls: () => number;
} {
  const inner = new Response(body, init);
  let textCalls = 0;
  let arrayBufferCalls = 0;
  const response = {
    get status() {
      return inner.status;
    },
    get headers() {
      return inner.headers;
    },
    text: async () => {
      textCalls += 1;
      return inner.text();
    },
    arrayBuffer: async () => {
      arrayBufferCalls += 1;
      return inner.arrayBuffer();
    },
  } as Response;
  return {
    response,
    textCalls: () => textCalls,
    arrayBufferCalls: () => arrayBufferCalls,
  };
}

test("binary GET uses arrayBuffer and never calls text()", async () => {
  const payload = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x57, 0x45, 0x42, 0x50]);
  const spy = spyResponse(payload, {
    status: 200,
    headers: { "content-type": "image/webp", "content-length": String(payload.byteLength) },
  });
  const transport = new FetchTransport("https://api.screenrig.ai/", "sr_live_test", async () => spy.response);
  const result = await transport.request({
    method: "GET",
    path: "/api/v1/screens/scr_PAIRINGAAAAAAAAAAAAAAAA/screenshot",
    query: { capture_id: "shot_AAAAAAAAAAAAAAAA" },
    binary: true,
  });
  assert.equal(spy.textCalls(), 0);
  assert.equal(spy.arrayBufferCalls(), 1);
  assert.equal(result.status, 200);
  assert.equal(result.rawText, undefined);
  assert.ok(result.body instanceof Uint8Array);
  assert.deepEqual(Array.from(result.body), Array.from(payload));
});

test("binary GET problem response still avoids text() and does not leave bytes in rawText as image data", async () => {
  const problem = {
    type: "https://screenrig.ai/problems/screenshot-unavailable",
    title: "Screenshot is not available",
    status: 409,
    detail: "Screenshot is not available.",
    code: "screenshot_unavailable",
  };
  const spy = spyResponse(JSON.stringify(problem), {
    status: 409,
    headers: { "content-type": "application/problem+json" },
  });
  const transport = new FetchTransport("https://api.screenrig.ai/", "sr_live_test", async () => spy.response);
  const result = await transport.request({
    method: "GET",
    path: "/api/v1/screens/scr_PAIRINGAAAAAAAAAAAAAAAA/screenshot",
    binary: true,
  });
  assert.equal(spy.textCalls(), 0);
  assert.equal(spy.arrayBufferCalls(), 1);
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, problem);
});

test("JSON GET still uses text()", async () => {
  const spy = spyResponse(JSON.stringify({ state: "ready" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const transport = new FetchTransport("https://api.screenrig.ai/", "sr_live_test", async () => spy.response);
  const result = await transport.request({
    method: "GET",
    path: "/api/v1/screens/scr_PAIRINGAAAAAAAAAAAAAAAA/screenshot/status",
  });
  assert.equal(spy.textCalls(), 1);
  assert.equal(spy.arrayBufferCalls(), 0);
  assert.equal(result.rawText, '{"state":"ready"}');
  assert.deepEqual(result.body, { state: "ready" });
});

test("media download exposes response chunks without calling text or arrayBuffer", async () => {
  const chunks = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5])];
  const inner = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "image/png", "content-length": "5", etag: '"abc"' },
  });
  let textCalls = 0;
  let arrayBufferCalls = 0;
  const response = {
    get status() { return inner.status; },
    get headers() { return inner.headers; },
    get body() { return inner.body; },
    text: async () => { textCalls += 1; throw new Error("must not buffer as text"); },
    arrayBuffer: async () => { arrayBufferCalls += 1; throw new Error("must not buffer as arrayBuffer"); },
  } as unknown as Response;
  const transport = new FetchTransport("https://api.screenrig.ai/", "sr_live_test", async () => response);
  const result = await transport.download({ method: "GET", path: "/api/v1/media/med_1/content" });
  const received: number[] = [];
  assert.ok(result.body);
  for await (const chunk of result.body) received.push(...chunk);
  assert.deepEqual(received, [1, 2, 3, 4, 5]);
  assert.equal(textCalls, 0);
  assert.equal(arrayBufferCalls, 0);
});

for (const method of ["request", "download"] as const) {
  test(`${method} keeps its deadline when the caller supplies an abort signal`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let fetchSignal: AbortSignal | undefined;
    const transport = new FetchTransport("https://api.screenrig.ai/", undefined, async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
      });
    });
    const caller = new AbortController();
    const rejected = assert.rejects(transport[method]({ method: "GET", path: "/api/v1/media", timeout_ms: 5, signal: caller.signal }),
      (err: unknown) => err instanceof CliError && err.problem.code === "timeout");
    t.mock.timers.tick(5);
    const timedOut = fetchSignal?.aborted;
    if (!timedOut) caller.abort(); // Settle the request even on a regression.
    await rejected;
    assert.equal(timedOut, true, "the request deadline must abort the fetch");
    assert.equal(caller.signal.aborted, false, "the deadline must leave the caller signal alone");
  });

  test(`${method} also respects caller cancellation with a custom reason`, async () => {
    const caller = new AbortController();
    const transport = new FetchTransport("https://api.screenrig.ai/", undefined, async (_input, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const rejected = assert.rejects(transport[method]({ method: "GET", path: "/api/v1/media", timeout_ms: 30_000, signal: caller.signal }),
      (err: unknown) => err instanceof CliError && err.problem.code === "timeout");
    caller.abort(new Error("Cancelled by caller"));
    await rejected;
  });
}

test("media download keeps its deadline while reading an error response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let abortSignal: AbortSignal | undefined;
  let releaseBody: (() => void) | undefined;
  const transport = new FetchTransport("https://api.screenrig.ai/", undefined, async (_input, init) => {
    abortSignal = init?.signal ?? undefined;
    return {
      status: 503,
      headers: new Headers({ "content-type": "application/problem+json" }),
      text: () => new Promise<string>((resolve, reject) => {
        releaseBody = () => resolve('{}');
        abortSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    } as Response;
  });
  const rejected = assert.rejects(transport.download({ method: "GET", path: "/api/v1/media/med_1/content", timeout_ms: 5 }),
    (err: unknown) => err instanceof CliError && err.problem.code === "timeout");
  await Promise.resolve();
  assert.ok(releaseBody, "the response body must be pending before the deadline");
  t.mock.timers.tick(5);
  if (!abortSignal?.aborted) releaseBody();
  await rejected;
  assert.equal(abortSignal?.aborted, true);
});
