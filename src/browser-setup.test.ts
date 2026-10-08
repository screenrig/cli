import assert from "node:assert/strict";
import { test } from "node:test";
import { browserHandoffUrl, normalizeBrowserSetupCode } from "./browser-setup.js";

test("browser setup code accepts grouped or ungrouped lowercase and displays canonical XXX-XXX", () => {
  for (const input of ["abc234", "abc-234", "ABC 234", " abc - 234 "]) {
    assert.deepEqual(normalizeBrowserSetupCode(input), { canonical: "ABC234", display: "ABC-234" });
  }
});

test("browser setup code rejects ambiguous characters, wrong lengths, and other punctuation", () => {
  for (const input of ["ABC-23", "ABC_234", "ABC.234", "ABC10I", "ABC-10I", "ABC-2345"]) {
    assert.throws(() => normalizeBrowserSetupCode(input), /six characters/);
  }
});

test("browser setup opener derives the handoff from the same API-to-apex table as dashboard open", () => {
  assert.equal(browserHandoffUrl("https://api.screenrig.ai", "ABC-234"), "https://screenrig.ai/ABC-234");
  assert.equal(browserHandoffUrl("https://api.stage.screenrig.ai", "ABC-234"), "https://stage.screenrig.ai/ABC-234");
  assert.equal(browserHandoffUrl("https://api.screenrig.localhost:8443", "ABC-234"), "https://screenrig.localhost:8443/ABC-234");
  assert.throws(() => browserHandoffUrl("http://api.screenrig.localhost:8088", "ABC-234"), /HTTPS/);
  assert.throws(() => browserHandoffUrl("https://example.invalid", "ABC-234"), /requires a supported ScreenRig API origin/);
});
