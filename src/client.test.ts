import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient } from "./client.js";
import { CliError, networkError, timeoutError } from "./problems.js";
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

const problemOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error.problem;
  }
  assert.fail("expected a CliError");
};

test("an empty 2xx where JSON is expected is unexpected_response, not success", async () => {
  const transport = new FakeTransport()
    .on("GET", "/api/v1/screens", () => ({ status: 200, headers: { "x-request-id": "req_emptyread" }, body: undefined, rawText: "" }))
    .on("PATCH", "/api/v1/screens/scr_1", () => ({ status: 200, headers: {}, body: "<html>proxy</html>", rawText: "<html>proxy</html>" }))
    .on("DELETE", "/api/v1/screens/scr_1", () => ({ status: 204, headers: {}, body: undefined }))
    .on("HEAD", "/api/v1/media/med_1/content", () => ({ status: 200, headers: {}, body: undefined }));
  const client = new ApiClient({ transport });
  const read = await problemOf(client.call({ method: "GET", path: "/api/v1/screens" }));
  assert.equal(read.code, "unexpected_response");
  assert.equal(read.request_id, "req_emptyread");
  assert.match(read.detail, /GET \/api\/v1\/screens answered HTTP 200 with an empty body/);
  assert.match(read.hint ?? "", /Run the same command again/);
  const write = await problemOf(client.call({ method: "PATCH", path: "/api/v1/screens/scr_1", body: {} }));
  assert.match(write.detail, /not JSON: <html>proxy<\/html>/);
  assert.match(write.hint ?? "", /unknown whether the change happened/);
  // 204 and HEAD legitimately carry no body.
  assert.equal((await client.call({ method: "DELETE", path: "/api/v1/screens/scr_1" })).status, 204);
  assert.equal((await client.call({ method: "HEAD", path: "/api/v1/media/med_1/content" })).status, 200);
});

test("a non-problem error body reaches the caller with status, request_id, and an excerpt", async () => {
  const transport = new FakeTransport()
    .on("GET", "/api/v1/project", () => ({ status: 502, headers: { "x-request-id": "req_gateway" }, body: "<html><h1>502 Bad Gateway</h1></html>" }))
    .on("GET", "/api/v1/screens", () => ({ status: 403, headers: {}, body: undefined }));
  const client = new ApiClient({ transport });
  const gateway = await problemOf(client.call({ method: "GET", path: "/api/v1/project" }));
  assert.equal(gateway.status, 502);
  assert.equal(gateway.request_id, "req_gateway");
  assert.match(gateway.detail, /502 Bad Gateway/);
  assert.match(gateway.hint ?? "", /proxy/);
  const empty = await problemOf(client.call({ method: "GET", path: "/api/v1/screens" }));
  assert.equal(empty.detail, "HTTP 403 answered with an empty body.");
  assert.ok(empty.hint);
});

test("transport failures say whether rerunning is safe", async () => {
  const transport = new FakeTransport()
    .on("GET", "/api/v1/project", () => { throw networkError("getaddrinfo ENOTFOUND api.example.test"); })
    .on("PATCH", "/api/v1/project", () => { throw timeoutError("API request timed out"); });
  const client = new ApiClient({ transport });
  const read = await problemOf(client.call({ method: "GET", path: "/api/v1/project" }));
  assert.equal(read.code, "transport_error");
  assert.match(read.hint ?? "", /safe to run the same command again/);
  assert.equal(read.next?.command, "screenrig doctor");
  const write = await problemOf(client.call({ method: "PATCH", path: "/api/v1/project", idempotent: true, body: { name: "x" } }));
  assert.equal(write.code, "timeout");
  assert.match(write.hint ?? "", /may already have happened/);
});

test("an operation wait timeout says the operation keeps running and how to resume", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const transport = new FakeTransport().on("GET", "/api/v1/operations/op_test", () => ({
    status: 200, headers: {}, body: operation("running"),
  }));
  const client = new ApiClient({ transport });
  const problem = await problemOf(client.waitForOperation("op_test", {
    timeoutMs: 5, pollMs: 60_000,
    sleep: async (ms) => { t.mock.timers.tick(ms); },
  }));
  assert.equal(problem.operation_id, "op_test");
  assert.match(problem.hint ?? "", /keeps running/);
  assert.deepEqual(problem.next?.argv, ["operations", "wait", "op_test"]);
});

test("a server hint, next.argv, errors, and current_revision survive the client", async () => {
  const transport = new FakeTransport().on("PUT", "/api/v1/playlists/pl_1", () => ({
    status: 412,
    headers: { "content-type": "application/problem+json", "x-request-id": "req_rev" },
    body: {
      type: "https://screenrig.ai/problems/revision-conflict", title: "Revision conflict", status: 412,
      detail: "Playlist changed.", code: "revision_conflict", request_id: "req_rev", current_revision: 8,
      hint: "Show the playlist again and retry with revision 8.",
      errors: [{ field: "revision", code: "stale", detail: "is 7, current is 8" }],
      next: { command: "screenrig playlist show pl_1 --editable", reason: "Read revision 8.", argv: ["playlist", "show", "pl_1", "--editable"] },
    },
  }));
  const client = new ApiClient({ transport });
  const problem = await problemOf(client.call({ method: "PUT", path: "/api/v1/playlists/pl_1", idempotent: true, body: {} }));
  assert.equal(problem.hint, "Show the playlist again and retry with revision 8.");
  assert.equal(problem.current_revision, 8);
  assert.equal(problem.request_id, "req_rev");
  assert.deepEqual(problem.next?.argv, ["playlist", "show", "pl_1", "--editable"]);
  assert.deepEqual(problem.errors, [{ field: "revision", code: "stale", detail: "is 7, current is 8" }]);
});
