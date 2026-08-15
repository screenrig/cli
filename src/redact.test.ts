import assert from "node:assert/strict";
import { test } from "node:test";
import { redactText, redactValue } from "./redact.js";

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
