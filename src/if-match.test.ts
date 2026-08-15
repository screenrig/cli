import assert from "node:assert/strict";
import { test } from "node:test";
import { quotedRevision } from "./if-match.js";
import { CliError } from "./problems.js";
import { ExitCode } from "./exit-codes.js";

test("quotedRevision accepts positive bare or quoted integers", () => {
  assert.equal(quotedRevision("1"), '"1"');
  assert.equal(quotedRevision("42"), '"42"');
  assert.equal(quotedRevision("999999999999"), '"999999999999"');
  assert.equal(quotedRevision('"1"'), '"1"');
  assert.equal(quotedRevision('"42"'), '"42"');
  assert.equal(quotedRevision('"999999999999"'), '"999999999999"');
});

test("quotedRevision rejects invalid forms", () => {
  for (const raw of [
    "",
    "0",
    "-1",
    "1.5",
    "abc",
    "01",
    " 1",
    "1 ",
    '"0"',
    '"-1"',
    '""',
    '"1',
    '1"',
    "'1'",
    '"01"',
    '"1.5"',
  ]) {
    assert.throws(
      () => quotedRevision(raw),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.exitCode, ExitCode.Usage);
        assert.equal(err.problem.code, "usage_error");
        return true;
      },
    );
  }
});
