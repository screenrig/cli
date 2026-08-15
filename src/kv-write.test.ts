import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { ParsedArgs } from "./argv.js";
import { CliError } from "./problems.js";
import { canonicalBase64, canonicalJson, kvWriteFromArgs } from "./kv-write.js";
import { testTemp } from "./test-temp.js";

function args(flags: ParsedArgs["flags"]): ParsedArgs {
  return { command: ["kv", "set"], positionals: ["kv", "set", "key"], flags };
}

test("canonical JSON recursively sorts keys and preserves hostile property names", () => {
  assert.equal(
    canonicalJson('{"z":1,"a":{"z":2,"a":3},"list":[{"b":1,"a":2}],"__proto__":{"safe":true}}'),
    '{"__proto__":{"safe":true},"a":{"a":3,"z":2},"list":[{"a":2,"b":1}],"z":1}',
  );
  assert.throws(() => canonicalJson("not json"), CliError);
});

test("canonical base64 rejects non-standard and non-canonical encodings", () => {
  assert.equal(canonicalBase64("AP+A/w=="), "AP+A/w==");
  assert.throws(() => canonicalBase64("AP-A_w=="), CliError);
  assert.throws(() => canonicalBase64("aGVsbG8"), CliError);
  assert.throws(() => canonicalBase64("aGVs bG8="), CliError);
});

test("KV writes canonicalize JSON and preserve file/base64 content types", async () => {
  const temp = await testTemp("kv-write-");
  await mkdir(temp, { recursive: true });
  await writeFile(path.join(temp, "value.bin"), Buffer.from([0, 255, 1, 2]));
  try {
    assert.deepEqual(
      await kvWriteFromArgs(args({ "json-value": '{"z":1,"a":2}' }), temp),
      { value_base64: Buffer.from('{"a":2,"z":1}').toString("base64"), content_type: "application/json" },
    );
    assert.deepEqual(
      await kvWriteFromArgs(args({ file: "value.bin", "content-type": "application/x.screenrig-bytes; version=1" }), temp),
      { value_base64: "AP8BAg==", content_type: "application/x.screenrig-bytes; version=1" },
    );
    assert.deepEqual(
      await kvWriteFromArgs(args({ "value-base64": "AP8BAg==", "content-type": "application/octet-stream" }), temp),
      { value_base64: "AP8BAg==", content_type: "application/octet-stream" },
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("KV write modes are exclusive and reject the retired value contract", async () => {
  await assert.rejects(() => kvWriteFromArgs(args({}), "."), CliError);
  await assert.rejects(() => kvWriteFromArgs(args({ value: "stale" }), "."), CliError);
  await assert.rejects(
    () => kvWriteFromArgs(args({ "json-value": "null", "value-base64": "", "content-type": "application/octet-stream" }), "."),
    CliError,
  );
  await assert.rejects(() => kvWriteFromArgs(args({ file: "x" }), "."), CliError);
  await assert.rejects(
    () => kvWriteFromArgs(args({ "json-value": "null", "content-type": "application/json" }), "."),
    CliError,
  );
  await assert.rejects(
    () => kvWriteFromArgs(args({ "value-base64": "A".repeat(1_398_105), "content-type": "application/octet-stream" }), "."),
    CliError,
  );
});
