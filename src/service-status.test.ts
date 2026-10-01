import assert from "node:assert/strict";
import { test } from "node:test";
import { handleServiceStatus, validateServiceStatus } from "./service-status.js";
import { parseArgv } from "./argv.js";
import { processRuntime } from "./runtime.js";
import { FakeTransport } from "./transport/fake.js";

test("service status reports stale and missing observations as unknown", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  for (const observed_at of ["2026-10-01T11:57:00Z", "2026-10-01T12:01:00Z", "invalid"]) {
    const result = validateServiceStatus({ schema: "screenrig.monitor/v1", environments: [{ environment: "production", state: "up", observed_at, components: [] }] }, "production", now);
    assert.equal(result.environments[0]?.state, "unknown");
    assert.equal(result.environments[0]?.stale, true);
  }
  assert.throws(() => validateServiceStatus({ schema: "other", environments: [] }, "production", now));
  assert.throws(() => validateServiceStatus({ schema: "screenrig.monitor/v1", environments: [{ environment: "stage", state: "up", components: [] }] }, "production", now));
});

test("status works without enrollment, never reads config, and sends no project credentials", async () => {
  const runtime = processRuntime();
  runtime.now = () => new Date("2026-10-01T12:00:00Z");
  runtime.homedir = () => { throw new Error("status must not resolve project configuration"); };
  runtime.env = { SCREENRIG_TOKEN: "project-secret" };
  const transport = new FakeTransport().on("GET", "/api/status", (request) => {
    assert.equal(request.query?.environment, "production");
    assert.equal(request.headers?.Authorization, undefined);
    return { status: 200, headers: {}, body: { schema: "screenrig.monitor/v1", environments: [{ environment: "production", state: "degraded", observed_at: runtime.now().toISOString(), components: [] }] } };
  });
  runtime.transport = transport;
  const result = await handleServiceStatus(parseArgv(["status"]), runtime);
  assert.equal(result.envelope.ok, true);
  assert.match(result.human ?? "", /production: degraded/);
  assert.doesNotMatch(JSON.stringify(result), /project-secret/);
  assert.throws(() => parseArgv(["status", "--environment", "private-env"]));
});
