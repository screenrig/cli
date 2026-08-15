import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { validateProvisioningUrls } from "./provisioning-url.js";

const screen = {
  content_access_generation: 1,
  created_at: "2026-08-15T17:00:00Z",
  id: "scr_test",
  public_id: "public-test",
  label: "Test",
  manifest_revision: 1,
  revision: 1,
  state: "pairing_pending" as const,
  updated_at: "2026-08-15T17:00:00Z",
};

test("validates production and localhost provisioning URLs", () => {
  for (const origin of ["https://play.screenrig.ai", "http://play.screenrig.localhost:8088"]) {
    assert.deepEqual(validateProvisioningUrls({
      screen,
      public_url: `${origin}/s/public-test`,
      provisioning_url: `${origin}/s/public-test#provision=${"A".repeat(43)}`,
      expires_at: "2026-08-15T17:10:00Z",
    }), {
      publicUrl: `${origin}/s/public-test`,
      provisioningUrl: `${origin}/s/public-test#provision=${"A".repeat(43)}`,
    });
  }
});

test("rejects token leakage outside the exact fragment and mismatched targets", () => {
  for (const provisioning_url of [
    `https://play.screenrig.ai/s/other#provision=${"A".repeat(43)}`,
    `https://evil.invalid/s/public-test#provision=${"A".repeat(43)}`,
    `https://play.screenrig.ai/s/public-test?provision=${"A".repeat(43)}`,
  ]) {
    assert.throws(() => validateProvisioningUrls({
      screen,
      public_url: "https://play.screenrig.ai/s/public-test",
      provisioning_url,
      expires_at: "2026-08-15T17:10:00Z",
    }), /unsafe URL/);
  }
});

test("browser opener is argv-only and never enables a shell", async () => {
  const source = await readFile(new URL("../src/open-url.ts", import.meta.url), "utf8");
  assert.match(source, /shell:\s*false/);
  assert.doesNotMatch(source, /\bexec(?:File|Sync)?\s*\(/);
});
