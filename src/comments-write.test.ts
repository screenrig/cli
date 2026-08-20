import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { ParsedArgs } from "./argv.js";
import { CliError } from "./problems.js";
import { COMMENTS_MAX_BYTES, commentsObjectFromJson, commentsWriteFromArgs } from "./comments-write.js";
import { testTemp } from "./test-temp.js";

function args(flags: ParsedArgs["flags"]): ParsedArgs {
  return { command: ["comment", "set", "screen"], positionals: ["comment", "set", "screen", "scr_1"], flags };
}

test("comments JSON must be an object within the compact UTF-8 byte limit", () => {
  assert.deepEqual(commentsObjectFromJson('{"z":1,"a":2}', "--json-value"), { z: 1, a: 2 });
  assert.deepEqual(commentsObjectFromJson('  {"note":"hi"}  ', "--json-value"), { note: "hi" });
  const exact = `{"x":"${"a".repeat(COMMENTS_MAX_BYTES - 8)}"}`;
  assert.equal(Buffer.byteLength(exact, "utf8"), COMMENTS_MAX_BYTES);
  assert.equal(typeof commentsObjectFromJson(exact, "--json-value").x, "string");
  assert.throws(() => commentsObjectFromJson("not json", "--json-value"), CliError);
  for (const raw of ["[]", '"hi"', "1", "true", "null", ""]) {
    assert.throws(() => commentsObjectFromJson(raw, "--json-value"), CliError);
  }
  const over = `{"x":"${"a".repeat(COMMENTS_MAX_BYTES - 7)}"}`;
  assert.throws(() => commentsObjectFromJson(over, "--json-value"), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.match(error.problem.detail, /1024 bytes/);
    return true;
  });
});

test("comment writes accept exactly one of --json-value or --file", async () => {
  const temp = await testTemp("comments-write-");
  await mkdir(temp, { recursive: true });
  await writeFile(path.join(temp, "note.json"), '{"slot":"hero","ok":true}');
  try {
    assert.deepEqual(
      await commentsWriteFromArgs(args({ "json-value": '{"note":"lobby"}' }), temp),
      { comments: { note: "lobby" } },
    );
    assert.deepEqual(
      await commentsWriteFromArgs(args({ file: "note.json" }), temp),
      { comments: { slot: "hero", ok: true } },
    );
    await assert.rejects(() => commentsWriteFromArgs(args({}), temp), CliError);
    await assert.rejects(() => commentsWriteFromArgs(args({ value: "stale" }), temp), CliError);
    await assert.rejects(
      () => commentsWriteFromArgs(args({ "json-value": "{}", "value-base64": "e30=" }), temp),
      CliError,
    );
    await assert.rejects(
      () => commentsWriteFromArgs(args({ "json-value": "{}", "content-type": "application/json" }), temp),
      CliError,
    );
    await assert.rejects(
      () => commentsWriteFromArgs(args({ "json-value": "{}", file: "note.json" }), temp),
      CliError,
    );
    await assert.rejects(() => commentsWriteFromArgs(args({ "json-value": "[]" }), temp), CliError);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
