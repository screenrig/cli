import assert from "node:assert/strict";
import { test } from "node:test";
import { browserHandoffUrl, normalizeBrowserSetupCode } from "./browser-setup.js";

test("browser setup code accepts dashed or undashed lowercase and displays canonical XXX-XXX", () => {
  assert.deepEqual(normalizeBrowserSetupCode("abc234"), { canonical: "ABC234", display: "ABC-234" });
  assert.deepEqual(normalizeBrowserSetupCode("abc-234"), { canonical: "ABC234", display: "ABC-234" });
});

test("browser setup code rejects ambiguous, misplaced, and extra punctuation", () => {
  for (const input of ["ABC-23", "AB-C234", "ABC_234", "ABC10I", "ABC-10I"]) {
    assert.throws(() => normalizeBrowserSetupCode(input), /six characters/);
  }
});

test("browser setup opener derives only the public production or HTTPS localhost handoff", () => {
  assert.equal(browserHandoffUrl("https://api.screenrig.ai", "ABC-234"), "https://screenrig.ai/ABC-234");
  assert.equal(browserHandoffUrl("https://api.screenrig.localhost:8443", "ABC-234"), "https://screenrig.localhost:8443/ABC-234");
  assert.throws(() => browserHandoffUrl("http://api.screenrig.localhost:8088", "ABC-234"), /HTTPS/);
  assert.throws(() => browserHandoffUrl("https://example.invalid", "ABC-234"), /requires api\.screenrig\.ai/);
});
