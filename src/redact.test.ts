import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSensitiveKey,
  isSensitiveValue,
  redactEvent,
  redactText,
  redactValue,
} from "./redact.js";

test("redacts credentials and email addresses from errors", () => {
  const token = "sr_live_identifier_secret";
  assert.equal(redactText(`Bearer ${token} for owner@example.com`), "Bearer *** for [redacted-email]");
  assert.deepEqual(
    redactValue({ token, nested: [`email owner@example.com`] }),
    {
      token: "sr_live_identifier_***",
      nested: ["email [redacted-email]"],
    },
  );
});

test("redacts temporary agent connection authority and envelope material", () => {
  const temporary = `sac_${"A".repeat(43)}`;
  assert.equal(redactText(`ScreenRig-Agent-Connect ${temporary}`), "ScreenRig-Agent-Connect ***");
  assert.equal(isSensitiveValue(temporary), true);
  assert.equal(isSensitiveKey("credential_envelope_ciphertext"), true);
  assert.equal(isSensitiveKey("private_jwk"), true);
  assert.equal(isSensitiveKey("nonce"), true);
});

test("redacts a fragment-delivered single-use link wherever text carries one", () => {
  const token = "D".repeat(43);
  assert.equal(
    redactText(`open https://dashboard.screenrig.ai/#link=${token} now`),
    "open https://dashboard.screenrig.ai/#link=*** now",
  );
  assert.equal(
    redactText(`https://play.screenrig.ai/s/pub#provision=${token}`),
    "https://play.screenrig.ai/s/pub#provision=***",
  );
  // The origin stays legible so the operator can tell which link failed.
  assert.doesNotMatch(redactText(`#link=${token}`), /DDD/);
  assert.equal(isSensitiveValue(`https://dashboard.screenrig.ai/#link=${token}`), true);
  assert.equal(isSensitiveValue(`https://play.screenrig.ai/s/pub#provision=${token}`), true);
  assert.equal(isSensitiveValue("https://dashboard.screenrig.ai/"), false);
});

test("sensitive keys match embedded names, not only exact tokens", () => {
  for (const key of [
    "token",
    "extra_token",
    "access_token",
    "authorization",
    "password",
    "secret",
    "cookie",
    "session_cookie",
    "object_key",
    "signed_url",
    "completion_nonce",
    "upload_url",
    "image_bytes",
    "pixels",
  ]) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  assert.equal(isSensitiveKey("capture_id"), false);
  assert.equal(isSensitiveKey("code"), false);
  assert.equal(isSensitiveKey("primitive_id"), false);
});

test("sensitive values match embedded credentials, not only at the start", () => {
  assert.equal(isSensitiveValue("sr_live_identifier_secret"), true);
  assert.equal(isSensitiveValue("use sr_live_identifier_secret now"), true);
  assert.equal(isSensitiveValue("Authorization: Bearer secret-material"), true);
  assert.equal(isSensitiveValue("preview data:image/webp;base64,AAAA"), true);
  assert.equal(isSensitiveValue("https://example.invalid/get?X-Amz-Signature=abc"), true);
  assert.equal(isSensitiveValue("https://example.invalid/get?signature=abc"), true);
  assert.equal(isSensitiveValue("shot_1"), false);
  assert.equal(isSensitiveValue("cta.pressed"), false);
});

test("redactValue replaces extra secret keys", () => {
  assert.deepEqual(
    redactValue({
      object_key: "accounts/acc/objects/obj",
      upload_url: "https://example.invalid/put",
      pixels: "data:image/webp;base64,AAAA",
      capture_id: "shot_1",
    }),
    {
      object_key: "***",
      upload_url: "***",
      pixels: "***",
      capture_id: "shot_1",
    },
  );
});

test("redactEvent omits tokens, pixels, authorization, and object keys", () => {
  const redacted = redactEvent({
    type: "screen.screenshot_ready",
    message: "shot_1",
    details: {
      capture_id: "shot_1",
      token: "sr_live_identifier_secret",
      extra_token: "sr_live_identifier_secret",
      authorization: "Bearer secret-material",
      pixels: "data:image/webp;base64,AAAA",
      object_key: "accounts/acc/objects/obj",
      upload_url: "https://example.invalid/put?X-Amz-Signature=abc",
      completion_nonce: "nonce-value",
      signed_url: "https://example.invalid/get?signature=abc",
      note: "use sr_live_identifier_secret",
      code: "cta.pressed",
    },
  }) as { message: string; details: Record<string, unknown> };
  assert.equal(redacted.message, "shot_1");
  assert.deepEqual(redacted.details, { capture_id: "shot_1", code: "cta.pressed" });
});
