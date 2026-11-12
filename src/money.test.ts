import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMcrAsDollars, moneyLabel } from "./money.js";

test("mcr amounts print as exact US dollars, 10,000,000 mcr to the dollar", () => {
  assert.equal(formatMcrAsDollars("0"), "$0.00");
  assert.equal(formatMcrAsDollars("10000000"), "$1.00");
  assert.equal(formatMcrAsDollars("125000000"), "$12.50");
  assert.equal(formatMcrAsDollars("150000"), "$0.015");
  assert.equal(formatMcrAsDollars("1"), "$0.0000001");
  assert.equal(formatMcrAsDollars("12345678"), "$1.2345678");
  assert.equal(formatMcrAsDollars("-12345678"), "-$1.2345678");
  assert.equal(formatMcrAsDollars("100000000000000"), "$10,000,000.00");
  // 10,000 credits are $1 and 1 credit is 1,000 mcr.
  assert.equal(formatMcrAsDollars(String(10_000 * 1000)), "$1.00");
});

test("a value that is not an exact integer prints nothing instead of a guess", () => {
  for (const value of [undefined, null, "", "1.5", "abc", "1e7", 1.5, {}]) assert.equal(formatMcrAsDollars(value), undefined, String(value));
  assert.equal(formatMcrAsDollars(20000000), "$2.00");
  assert.equal(formatMcrAsDollars("123456789012345678901234567890"), "$12,345,678,901,234,567,890,123.456789");
});

test("a money member shows without its _mcr suffix", () => {
  assert.equal(moneyLabel("net_mcr"), "net");
  assert.equal(moneyLabel("completed"), "completed");
});
