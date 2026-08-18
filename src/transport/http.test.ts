import assert from "node:assert/strict";
import { test } from "node:test";
import { FetchTransport } from "./http.js";

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
