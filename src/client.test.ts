import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient } from "./client.js";
import { CliError } from "./problems.js";
import { FakeTransport } from "./transport/fake.js";

const operation = (state: string) => ({ id: "op_test", state });

test("operation polling bounds each request and sleep by the remaining deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const budgets: (number | undefined)[] = [];
  const transport = new FakeTransport().on("GET", "/api/v1/operations/op_test", (request) => {
    budgets.push(request.timeout_ms);
    if (budgets.length === 1) t.mock.timers.tick(2);
    return { status: 200, headers: {}, body: operation(budgets.length === 1 ? "queued" : "succeeded") };
  });
  const client = new ApiClient({ transport });
  const sleeps: number[] = [];
  const result = await client.waitForOperation("op_test", {
    timeoutMs: 5, pollMs: 1,
    sleep: async (ms) => { sleeps.push(ms); t.mock.timers.tick(ms); },
  });
  assert.equal(result.state, "succeeded");
  assert.deepEqual(budgets, [5, 2]);
  assert.deepEqual(sleeps, [1]);
});

test("operation polling never sleeps or starts another request past its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const transport = new FakeTransport().on("GET", "/api/v1/operations/op_test", () => ({
    status: 200, headers: {}, body: operation("queued"),
  }));
  const client = new ApiClient({ transport });
  const sleeps: number[] = [];
  await assert.rejects(client.waitForOperation("op_test", {
    timeoutMs: 5, pollMs: 60_000,
    sleep: async (ms) => { sleeps.push(ms); t.mock.timers.tick(ms); },
  }), (error: unknown) => error instanceof CliError && error.problem.code === "timeout");
  assert.deepEqual(sleeps, [5]);
  assert.equal(transport.calls.length, 1);
});

test("an operation response arriving after the deadline does not report success", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const transport = new FakeTransport().on("GET", "/api/v1/operations/op_test", () => {
    t.mock.timers.tick(6);
    return { status: 200, headers: {}, body: operation("succeeded") };
  });
  const client = new ApiClient({ transport });
  await assert.rejects(client.waitForOperation("op_test", {
    timeoutMs: 5, pollMs: 1, sleep: async () => { throw new Error("unexpected sleep"); },
  }), (error: unknown) => error instanceof CliError && error.problem.code === "timeout");
});
