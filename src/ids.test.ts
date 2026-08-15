import assert from "node:assert/strict";
import { test } from "node:test";
import { ENTROPY_BYTES, newIdempotencyKey, newRequestId, requestIdEntropyBytes } from "./ids.js";

test("generated request and idempotency identifiers preserve 128 bits", () => {
  const requestId = newRequestId();
  assert.match(requestId, /^req_[A-Za-z0-9_-]{22}$/);
  assert.equal(requestIdEntropyBytes(requestId), ENTROPY_BYTES);
  assert.equal(Buffer.from(newIdempotencyKey(), "base64url").length, ENTROPY_BYTES);
});
