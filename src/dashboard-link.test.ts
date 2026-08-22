import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { dashboardOriginFor, validateDashboardLink } from "./dashboard-link.js";

const TOKEN = "A".repeat(43);
const EXPIRES = "2026-08-20T19:10:00.000Z";

test("derives the dashboard origin from the configured control-plane origin", () => {
  assert.equal(dashboardOriginFor("https://api.screenrig.ai"), "dashboard.screenrig.ai");
  assert.equal(dashboardOriginFor("https://api.screenrig.localhost:8088"), "dashboard.screenrig.localhost:8088");
  assert.equal(dashboardOriginFor("http://api.screenrig.localhost:8088"), "dashboard.screenrig.localhost:8088");
  assert.throws(() => dashboardOriginFor("http://api.screenrig.ai"), /HTTPS/);
  assert.throws(() => dashboardOriginFor("http://api.example.invalid:8088"), /HTTPS/);
  assert.throws(() => dashboardOriginFor("https://api.example.invalid"), /api\.screenrig\.ai/);
});

test("accepts only the fragment-carried link on the derived origin", () => {
  assert.deepEqual(
    validateDashboardLink({ url: `https://dashboard.screenrig.ai/#link=${TOKEN}`, expires_at: EXPIRES }, "https://api.screenrig.ai"),
    { url: `https://dashboard.screenrig.ai/#link=${TOKEN}`, expiresAt: EXPIRES },
  );
  assert.deepEqual(
    validateDashboardLink(
      { url: `http://dashboard.screenrig.localhost:8088/#link=${TOKEN}`, expires_at: EXPIRES },
      "http://api.screenrig.localhost:8088",
    ),
    { url: `http://dashboard.screenrig.localhost:8088/#link=${TOKEN}`, expiresAt: EXPIRES },
  );
});

test("rejects any URL that would put the token where a server or a Referer can see it", () => {
  for (const url of [
    `https://dashboard.screenrig.ai/?link=${TOKEN}`,
    `https://dashboard.screenrig.ai/claim#link=${TOKEN}`,
    `https://dashboard.screenrig.ai/#link=${TOKEN}&next=/`,
    `https://dashboard.screenrig.ai/#provision=${TOKEN}`,
    `https://dashboard.screenrig.ai/#link=${"A".repeat(42)}`,
    `https://evil.invalid/#link=${TOKEN}`,
    `https://dashboard.screenrig.ai.evil.invalid/#link=${TOKEN}`,
    `http://dashboard.screenrig.ai/#link=${TOKEN}`,
    `https://user:pass@dashboard.screenrig.ai/#link=${TOKEN}`,
    "https://dashboard.screenrig.ai/",
  ]) {
    assert.throws(
      () => validateDashboardLink({ url, expires_at: EXPIRES }, "https://api.screenrig.ai"),
      /unsafe URL/,
      url,
    );
  }
});

test("rejects a response that does not match the DashboardLink contract", () => {
  for (const value of [
    {},
    { url: `https://dashboard.screenrig.ai/#link=${TOKEN}` },
    { url: `https://dashboard.screenrig.ai/#link=${TOKEN}`, expires_at: "never" },
    { expires_at: EXPIRES },
  ]) {
    assert.throws(
      () => validateDashboardLink(value as never, "https://api.screenrig.ai"),
      /DashboardLink contract/,
      JSON.stringify(value),
    );
  }
  assert.throws(
    () => validateDashboardLink({ url: "not-a-url", expires_at: EXPIRES }, "https://api.screenrig.ai"),
    /invalid URL/,
  );
});

test("the dashboard link is handed to the shared argv-only opener", async () => {
  const source = await readFile(new URL("../src/commands.ts", import.meta.url), "utf8");
  // One opener primitive, reached through the injectable runtime hook.
  assert.match(source, /const opened = printMode \? false : await \(runtime\.openUrl\?\./);
  assert.doesNotMatch(source, /spawn\(/);
});
