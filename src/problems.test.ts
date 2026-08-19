import assert from "node:assert/strict";
import { test } from "node:test";
import { exitCodeForStatus, ExitCode } from "./exit-codes.js";
import { normalizeProblem, renderProblem, withPaymentGuidance } from "./problems.js";

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
  const problem = normalizeProblem({ status: 409, code: "account_exists" }, { request_id: "req_1" });
  assert.equal(problem.code, "account_exists");
  assert.equal(problem.request_id, "req_1");
  assert.match(problem.type, /account-exists/);
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

test("payment_required guidance names credit_remaining and not millicredits", () => {
  const problem = withPaymentGuidance({
    type: "https://screenrig.ai/problems/payment-required",
    title: "Prepaid credit is required",
    status: 402,
    detail: "Prepaid credit remaining is zero.",
    code: "payment_required",
    errors: [],
  });
  assert.equal(problem.next?.command, "screenrig --json account show");
  assert.match(problem.next?.reason ?? "", /credit_remaining/);
  assert.doesNotMatch(problem.next?.reason ?? "", /mcr|millicredit|kCr|stripe|x402|\$/i);
});
