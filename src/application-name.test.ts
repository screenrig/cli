import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationNameHeaders } from "./application-name.js";
import { FetchTransport } from "./transport/http.js";

test("application name preserves ASCII and encodes Unicode as RFC 8187 ASCII bytes", async () => {
  assert.deepEqual(applicationNameHeaders(" Lobby board "), { "screenrig-application-name": "Lobby board" });
  assert.deepEqual(applicationNameHeaders(undefined), {});
  for (const name of ["TelemetryOS engineering — Fleet and usage lab", "Café", "東京 🖥️", "L'été (1) * — 100%", "😀".repeat(120)]) {
    const headers = applicationNameHeaders(name);
    assert.equal(headers["screenrig-application-name"], undefined);
    const encoded = headers["screenrig-application-name*"]!;
    assert.match(encoded, /^UTF-8''[\x21-\x7e]+$/);
    assert.equal(decodeURIComponent(encoded.slice(7)), name);
    // Construct a real Request: this is where the UAT's raw Unicode header
    // failed with ByteString conversion before any network call was made.
    let requested = false;
    const transport = new FetchTransport("https://api.screenrig.ai", undefined, async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get("screenrig-application-name*"), encoded);
      requested = true;
      return Response.json({ id: "app_TEST" }, { status: 202 });
    });
    assert.equal((await transport.request({ method: "POST", path: "/api/v1/applications", headers, body: new Uint8Array([1]) })).status, 202);
    assert.equal(requested, true);
  }
});

test("application name rejects invalid Unicode, controls and over-limit scalar counts locally", () => {
  for (const name of ["😀".repeat(121), "a".repeat(121), "bad\ud800name", "bad\udfffname", "bad\nname", "bad\0name", "bad\u0085name", "bad\u007fname"]) {
    assert.throws(() => applicationNameHeaders(name), /120 Unicode characters/);
  }
  assert.deepEqual(applicationNameHeaders(" "), {});
});
