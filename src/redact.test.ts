import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSensitiveKey,
  isSensitiveValue,
  redactEvent,
  redactText,
  redactValue,
} from "./redact.js";

test("redacts credentials and passes email addresses through", () => {
  const token = "sr_live_identifier_secret";
  assert.equal(redactText(`Bearer ${token} for owner@example.com`), "Bearer *** for owner@example.com");
  assert.deepEqual(
    redactValue({ token, nested: [`email owner@example.com`] }),
    {
      token: "sr_live_***",
      nested: ["email owner@example.com"],
    },
  );
  const jwt = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(redactText(`owner@example.com signed in with ${jwt}`), "owner@example.com signed in with jwt_***");
});

test("a redacted credential keeps no lookup segment of the live token", () => {
  const token = "sr_live_identifier_secret";
  assert.equal(redactText(`token ${token}`), "token sr_live_***");
  assert.doesNotMatch(redactText(`token ${token}`), /identifier/);
  assert.doesNotMatch(JSON.stringify(redactValue({ token })), /identifier/);
  assert.doesNotMatch(JSON.stringify(redactValue({ note: `use ${token}` })), /identifier/);
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
  const invitation = new URL("https://screenrig.ai/dashboard/invite");
  invitation.hash = `token=${token}`;
  assert.equal(redactText(invitation.href).includes(token), false, "invitation authority must not survive redaction");
  assert.equal(isSensitiveValue(invitation.href), true);
  assert.equal(
    redactText(`open https://screenrig.ai/dashboard/#link=${token} now`),
    "open https://screenrig.ai/dashboard/#link=*** now",
  );
  assert.equal(
    redactText(`https://play.screenrig.ai/player/s/pub#provision=${token}`),
    "https://play.screenrig.ai/player/s/pub#provision=***",
  );
  // The origin stays legible so the operator can tell which link failed.
  assert.doesNotMatch(redactText(`#link=${token}`), /DDD/);
  assert.equal(isSensitiveValue(`https://screenrig.ai/dashboard/#link=${token}`), true);
  assert.equal(isSensitiveValue(`https://play.screenrig.ai/player/s/pub#provision=${token}`), true);
  assert.equal(isSensitiveValue("https://screenrig.ai/dashboard/"), false);
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
    "private_key",
    "privateKey",
    "private_jwk",
    "device_code",
    "assertion",
    "nonce",
  ]) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  assert.equal(isSensitiveKey("capture_id"), false);
  assert.equal(isSensitiveKey("code"), false);
  assert.equal(isSensitiveKey("primitive_id"), false);
});

test("user content and anonymous identifiers are not sensitive keys", () => {
  for (const key of ["prompt", "client_id", "email", "private", "private_note", "visibility_private"]) {
    assert.equal(isSensitiveKey(key), false, key);
  }
  const request = {
    prompt: "A lobby at dusk for owner@example.com",
    client_id: "screenrig-cli",
    email: "owner@example.com",
    token: "sr_live_identifier_secret",
  };
  assert.deepEqual(redactValue(request), {
    prompt: "A lobby at dusk for owner@example.com",
    client_id: "screenrig-cli",
    email: "owner@example.com",
    token: "sr_live_***",
  });
  assert.deepEqual(redactEvent({ message: "shot_1", details: request }), {
    message: "shot_1",
    details: { prompt: request.prompt, client_id: request.client_id, email: request.email },
  });
});

test("URL query values pass through; signatures and embedded passwords do not", () => {
  assert.equal(
    redactText("GET https://example.test/fonts.ttf?family=Inter&token_count=3 failed"),
    "GET https://example.test/fonts.ttf?family=Inter&token_count=3 failed",
  );
  assert.equal(
    redactText("GET https://storage.example.invalid/get?id=7&X-Amz-Signature=abc123&expires=60"),
    "GET https://storage.example.invalid/get?id=7&X-Amz-Signature=***&expires=60",
  );
  assert.equal(redactText("https://storage.example.invalid/get?signature=abc#frag"), "https://storage.example.invalid/get?signature=***#frag");
  assert.equal(redactText("https://user:hunter2@example.test/renderer.js"), "https://user:***@example.test/renderer.js");
  assert.equal(redactText("https://user@example.test:8443/a"), "https://user@example.test:8443/a");
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
      object_key: "projects/acc/objects/obj",
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
      object_key: "projects/acc/objects/obj",
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

test("enrollment client credentials are redacted by shape and idempotency keys by key", () => {
  for (const key of ["idempotency_key", "idempotency-key", "beta_key"]) assert.equal(isSensitiveKey(key), true, key);
  const client = `cli_${"Z".repeat(43)}`;
  const exchange = `xchg_${"Y".repeat(43)}`;
  assert.equal(redactText(`enrolling ${client} and ${exchange}`), "enrolling cli_*** and xchg_***");
  assert.equal(isSensitiveValue(client), true);
  assert.equal(isSensitiveValue(exchange), true);
  assert.equal(isSensitiveValue("cli_version"), false);
  assert.doesNotMatch(JSON.stringify(redactValue({ client_id: client, idempotency_key: "retry-key-value" })), /ZZZZ|retry-key-value/);
  // A plain client id is not a credential.
  assert.deepEqual(redactValue({ client_id: "screenrig-cli" }), { client_id: "screenrig-cli" });
});
