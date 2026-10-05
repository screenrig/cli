import assert from "node:assert/strict";
import { test } from "node:test";
import { exitCodeForStatus, ExitCode } from "./exit-codes.js";
import { fileError, networkError, normalizeProblem, problemCodeOf, renderProblem, withDefaultHint, withPaymentGuidance, withQuotaGuidance, withRetryAfter } from "./problems.js";

test("maps HTTP statuses onto explicit exit codes", () => {
  assert.equal(exitCodeForStatus(401), ExitCode.Auth);
  assert.equal(exitCodeForStatus(402), ExitCode.Client);
  assert.equal(exitCodeForStatus(404), ExitCode.NotFound);
  assert.equal(exitCodeForStatus(409), ExitCode.Conflict);
  assert.equal(exitCodeForStatus(412), ExitCode.Precondition);
  assert.equal(exitCodeForStatus(429), ExitCode.RateLimited);
  assert.equal(exitCodeForStatus(400), ExitCode.Client);
  assert.equal(exitCodeForStatus(500), ExitCode.Server);
});

test("normalizes incomplete problem bodies", () => {
  const problem = normalizeProblem({ status: 409, code: "resource_conflict" }, { request_id: "req_1" });
  assert.equal(problem.code, "resource_conflict");
  assert.equal(problem.request_id, "req_1");
  assert.match(problem.type, /resource-conflict/);
});

test("reads the error from errors[0] of the backend problem document", () => {
  const document = {
    action: "hold_lkg",
    errors: [
      {
        status: 412,
        code: "revision_conflict",
        type: "https://screenrig.ai/problems/revision-conflict",
        title: "Resource revision does not match",
        detail: "The playlist changed since the revision in If-Match.",
        hint: "Read it again and retry with its current revision.",
        current_revision: 8,
        next: { command: "screenrig playlist show pl_01", reason: "Fetch revision 8." },
      },
    ],
    instance: "urn:screenrig:request:req_doc",
    request_id: "req_doc",
    server_time: "2026-10-05T17:00:00Z",
    trace_id: "trace_doc",
  };
  const problem = normalizeProblem(document);
  assert.equal(problem.code, "revision_conflict");
  assert.equal(problem.status, 412);
  assert.equal(problem.title, "Resource revision does not match");
  assert.equal(problem.detail, "The playlist changed since the revision in If-Match.");
  assert.equal(problem.hint, "Read it again and retry with its current revision.");
  assert.equal(problem.current_revision, 8);
  assert.deepEqual(problem.next, { command: "screenrig playlist show pl_01", reason: "Fetch revision 8." });
  assert.equal(problem.request_id, "req_doc");
  assert.equal(problem.instance, "urn:screenrig:request:req_doc");
  assert.equal(problem.trace_id, "trace_doc");
  assert.deepEqual(problem.errors, []);
  assert.equal(problemCodeOf(document), "revision_conflict");
  assert.equal(problemCodeOf({ code: "webhook_limit_reached", status: 409 }), "webhook_limit_reached");
  assert.equal(problemCodeOf({ errors: [] }), undefined);
});

test("blamed request fields in the problem document become field errors", () => {
  const problem = normalizeProblem({
    errors: [
      { status: 400, code: "invalid_request", type: "https://screenrig.ai/problems/invalid-request", title: "Request is invalid", detail: "The project name is invalid.", hint: "Correct the request.", field: "name" },
      { status: 400, code: "invalid_request", type: "https://screenrig.ai/problems/invalid-request", title: "Request is invalid", detail: "limit must be between 1 and 200.", hint: "Correct the request.", field: "limit" },
    ],
    instance: "urn:screenrig:request:req_fields",
    request_id: "req_fields",
  });
  assert.equal(problem.code, "invalid_request");
  assert.equal(problem.detail, "The project name is invalid.");
  assert.deepEqual(problem.errors, [
    { field: "name", detail: "The project name is invalid." },
    { field: "limit", detail: "limit must be between 1 and 200." },
  ]);
  assert.match(renderProblem(problem), /- limit: limit must be between 1 and 200\./);
});

test("human rendering includes next-action guidance", () => {
  const text = renderProblem({
    type: "https://screenrig.ai/problems/revision-conflict",
    title: "Resource revision does not match",
    status: 412,
    detail: "Playlist changed after revision 7 was read.",
    code: "revision_conflict",
    request_id: "req_01",
    errors: [],
    next: { command: "screenrig playlist get pl_01 --json", reason: "Retry with revision 8." },
  });
  assert.match(text, /revision_conflict\/412/);
  assert.match(text, /next: screenrig playlist get pl_01 --json/);
});

const PAYMENT_BASE = {
  type: "https://screenrig.ai/problems/payment-required",
  title: "Prepaid credit is required",
  status: 402,
  detail: "Prepaid credit remaining is zero.",
  code: "payment_required",
  errors: [],
};

test("402 guidance tells the agent to stop, tell the user, and continue another way", () => {
  for (const code of ["payment_required", "insufficient_credits"]) {
    const problem = withPaymentGuidance({ ...PAYMENT_BASE, code });
    assert.equal(problem.next?.command, "screenrig billing balance", code);
    assert.match(problem.hint ?? "", /Stop retrying/, code);
    assert.match(problem.hint ?? "", /tell the user/, code);
    assert.match(problem.hint ?? "", /screenrig media upload/, code);
    assert.doesNotMatch(`${problem.hint} ${problem.next?.reason}`, /mcr|millicredit|kCr|stripe|x402|buy|purchase|top.?up|\$/i, code);
  }
});

test("local guidance never replaces a server hint or next", () => {
  const server = { hint: "Server hint.", next: { command: "screenrig server next", reason: "Server reason." } };
  const payment = withPaymentGuidance({ ...PAYMENT_BASE, ...server });
  assert.equal(payment.hint, "Server hint.");
  assert.equal(payment.next?.command, "screenrig server next");
  const quota = withQuotaGuidance({ ...PAYMENT_BASE, status: 413, code: "quota_exceeded", ...server });
  assert.equal(quota.hint, "Server hint.");
  assert.equal(quota.next?.command, "screenrig server next");
  const limited = withRetryAfter({ ...PAYMENT_BASE, status: 429, code: "rate_limited", ...server }, 30);
  assert.equal(limited.hint, "Server hint.");
  assert.equal(limited.next?.command, "screenrig server next");
  assert.equal(limited.retry_after_seconds, 30);
  assert.equal(withDefaultHint({ ...PAYMENT_BASE, ...server }).hint, "Server hint.");
  // An older server with a next but no hint keeps its next and gains only a hint.
  const older = withQuotaGuidance({ ...PAYMENT_BASE, status: 413, code: "quota_exceeded", next: server.next });
  assert.equal(older.next?.command, "screenrig server next");
  assert.match(older.hint ?? "", /storage limit/);
  const olderLimited = withRetryAfter({ ...PAYMENT_BASE, status: 429, code: "rate_limited" }, 90);
  assert.match(olderLimited.hint ?? "", /Wait 2 minutes/);
  assert.equal(olderLimited.next?.command, "retry the same command");
});

test("normalizeProblem carries hint, next.argv, retryable, trace_id, and errors from the server", () => {
  const problem = normalizeProblem({
    type: "https://screenrig.ai/problems/invalid-request",
    title: "Request is invalid",
    status: 400,
    detail: "The playlist document is invalid.",
    instance: "urn:screenrig:request:req_1",
    code: "invalid_request",
    request_id: "req_1",
    trace_id: "trace_1",
    hint: "Fix pages[0].duration_ms and send the document again.",
    errors: [{ field: "pages[0].duration_ms", code: "minimum", detail: "must be at least 1000" }],
    next: { command: "screenrig playlist validate FILE", reason: "Validate locally first.", argv: ["playlist", "validate", "FILE"] },
  });
  assert.equal(problem.hint, "Fix pages[0].duration_ms and send the document again.");
  assert.equal(problem.trace_id, "trace_1");
  assert.deepEqual(problem.next?.argv, ["playlist", "validate", "FILE"]);
  assert.deepEqual(problem.errors, [{ field: "pages[0].duration_ms", code: "minimum", detail: "must be at least 1000" }]);
  const server = normalizeProblem({ status: 503, code: "dependency_unavailable", title: "Dependency unavailable", detail: "Storage is unavailable.", retryable: true });
  assert.equal(server.retryable, true);
  // A malformed argv is dropped; the command and reason survive.
  const bad = normalizeProblem({ status: 409, code: "resource_conflict", detail: "x", next: { command: "screenrig screen show ID", reason: "Inspect.", argv: ["screen", 7] } });
  assert.deepEqual(bad.next, { command: "screenrig screen show ID", reason: "Inspect." });
});

test("the server's next wins over the local missing-capability guidance", () => {
  const detail = "This agent credential lacks the screens capability.";
  const local = normalizeProblem({ status: 403, code: "forbidden", title: "Request is not allowed", detail });
  assert.match(local.next?.command ?? "", /agent connect --capability screens/);
  const served = normalizeProblem({ status: 403, code: "forbidden", title: "Request is not allowed", detail, hint: "Server hint.", next: { command: "screenrig agent status", reason: "Check." } });
  assert.equal(served.next?.command, "screenrig agent status");
  assert.equal(served.hint, "Server hint.");
});

test("a non-problem error body keeps status, request_id, and a bounded redacted excerpt", () => {
  const html = `<html><body><h1>502 Bad Gateway</h1>${"x".repeat(1000)} Bearer sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr</body></html>`;
  const problem = normalizeProblem(html, { status: 502, request_id: "req_proxy", bodyText: html });
  assert.equal(problem.status, 502);
  assert.equal(problem.request_id, "req_proxy");
  assert.equal(problem.code, "internal_error");
  assert.match(problem.detail, /^HTTP 502 answered with a body that is not a screenRIG problem document: <html><body><h1>502 Bad Gateway/);
  assert.ok(problem.detail.length < 450, problem.detail);
  assert.doesNotMatch(problem.detail, /secretsecret/);
  assert.match(problem.hint ?? "", /proxy/);

  const empty = normalizeProblem(undefined, { status: 404, request_id: "req_empty", bodyText: "" });
  assert.equal(empty.detail, "HTTP 404 answered with an empty body.");
  assert.equal(empty.request_id, "req_empty");
  assert.match(empty.hint ?? "", /api-url/);

  const foreignJson = normalizeProblem({ message: "Too many requests" }, { status: 400, bodyText: JSON.stringify({ message: "Too many requests" }) });
  assert.match(foreignJson.detail, /\{"message":"Too many requests"\}/);
});

test("human rendering shows the hint, field errors, argv, and retryable", () => {
  const text = renderProblem({
    type: "https://screenrig.ai/problems/invalid-request",
    title: "Request is invalid",
    status: 400,
    detail: "The playlist document is invalid.",
    hint: "Fix the named field and send it again.",
    code: "invalid_request",
    request_id: "req_01",
    trace_id: "trace_01",
    errors: [{ field: "name", code: "required", detail: "is required" }],
    next: { command: "screenrig playlist validate FILE", reason: "Validate locally.", argv: ["playlist", "validate", "FILE"] },
  });
  assert.match(text, /^hint: Fix the named field and send it again\.$/m);
  assert.match(text, /^- name: is required \(required\)$/m);
  assert.match(text, /^trace_id: trace_01$/m);
  assert.match(text, /argv: \["playlist","validate","FILE"\]/);
  assert.match(renderProblem({ ...PAYMENT_BASE, status: 500, code: "internal_error", retryable: false }), /^retryable: false$/m);
});

test("every problem that reaches the output boundary has a hint", () => {
  for (const code of ["usage_error", "not_enrolled", "config_error", "file_error", "unexpected_response", "transport_error", "timeout", "unexpected_error", "not_found", "revision_conflict", "forbidden", "some_future_code"]) {
    const hint = withDefaultHint({ ...PAYMENT_BASE, status: 400, code }).hint;
    assert.ok(hint && hint.length > 20, code);
  }
  assert.match(withDefaultHint({ ...PAYMENT_BASE, status: 500, code: "some_future_code", retryable: false }).hint ?? "", /will not help/);
  assert.match(withDefaultHint({ ...PAYMENT_BASE, status: 503, code: "some_future_code", retryable: true }).hint ?? "", /retry/);
});

test("local errors carry a concrete hint and, where one exists, a next command", () => {
  assert.match(fileError("Cannot write out.csv.", Object.assign(new Error("full"), { code: "ENOSPC" })).problem.hint ?? "", /disk is full/);
  assert.match(fileError("Cannot write out.csv.", Object.assign(new Error("denied"), { code: "EACCES" })).problem.hint ?? "", /cannot write there/);
  assert.equal(networkError("fetch failed").problem.next?.command, "screenrig doctor");
});
