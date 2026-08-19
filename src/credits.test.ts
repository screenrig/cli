import assert from "node:assert/strict";
import { test } from "node:test";
import { successEnvelope } from "./envelope.js";
import {
  CREDITS_LOW_CODE,
  applyCreditsLowToSuccess,
  creditsLowWarning,
  parseCreditsInteger,
  parseCreditsRemainingHeader,
} from "./credits.js";

test("parses integer remaining from numbers, digit strings, and credit headers", () => {
  assert.equal(parseCreditsInteger(0), 0);
  assert.equal(parseCreditsInteger(999), 999);
  assert.equal(parseCreditsInteger(1000), 1000);
  assert.equal(parseCreditsInteger(" 999 "), 999);
  assert.equal(parseCreditsInteger("0"), 0);
  assert.equal(parseCreditsInteger(-1), undefined);
  assert.equal(parseCreditsInteger(999.5), undefined);
  assert.equal(parseCreditsInteger("999.5"), undefined);
  assert.equal(parseCreditsInteger("nope"), undefined);
  assert.equal(parseCreditsInteger(""), undefined);
  assert.equal(parseCreditsInteger(undefined), undefined);
  assert.equal(parseCreditsRemainingHeader({ "ScreenRig-Credits-Remaining": "999" }), 999);
  assert.equal(parseCreditsRemainingHeader({ "screenrig-credits-remaining": "0" }), 0);
  assert.equal(parseCreditsRemainingHeader({ "ScreenRig-Credits-Remaining": "nope" }), undefined);
  assert.equal(parseCreditsRemainingHeader({}), undefined);
});

test("credits_low fires below 1000 remaining and is silent at the threshold", () => {
  assert.equal(creditsLowWarning(1000), undefined);
  assert.equal(creditsLowWarning(undefined), undefined);
  const low = creditsLowWarning(999);
  assert.equal(low?.code, CREDITS_LOW_CODE);
  assert.match(low?.message ?? "", /999/);
  assert.match(low?.message ?? "", /below 1000 credits/);
  assert.doesNotMatch(low?.message ?? "", /mcr|millicredit|kCr|stripe|x402|\$/i);
  const zero = creditsLowWarning(0);
  assert.equal(zero?.code, CREDITS_LOW_CODE);
  assert.match(zero?.message ?? "", /\b0\b/);
});

test("success envelopes append credits_low without replacing other warnings", () => {
  const result = applyCreditsLowToSuccess(
    {
      envelope: successEnvelope({ ok: true }, { warnings: [{ code: "generic_filename", message: "rename me" }] }),
      human: "Uploaded\nwarning: rename me",
    },
    999,
  );
  assert.deepEqual(
    result.envelope.warnings.map((item) => item.code),
    ["generic_filename", CREDITS_LOW_CODE],
  );
  assert.match(result.human, /warning: rename me/);
  assert.match(result.human, /warning: Remaining prepaid credit is 999, below 1000 credits\./);
  const emptyHuman = applyCreditsLowToSuccess({ envelope: successEnvelope({}), human: "" }, 0);
  assert.equal(emptyHuman.human, "");
  assert.equal(emptyHuman.envelope.warnings[0]?.code, CREDITS_LOW_CODE);
});
