import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { nodeRuntimeSupported } from "./node-runtime.js";

test("only patched Node release lines can execute the CLI", () => {
  for (const version of ["20.19.0", "22.11.0", "22.23.3", "23.9.0", "24.22.0", "25.9.0", "26.12.0", "26.12.1-rc.1", "invalid"]) {
    assert.equal(nodeRuntimeSupported(version), false, version);
  }
  for (const version of ["22.23.4", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0", "27.0.0"]) {
    assert.equal(nodeRuntimeSupported(version), true, version);
  }
});

test("an affected runtime stops before CLI command execution", () => {
  const entry = new URL("./bin.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `Object.defineProperty(process.versions, "node", {value: "24.22.0"}); await import(${JSON.stringify(entry)});`],
    { encoding: "utf8" });
  assert.equal(result.status, 69, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /requires Node.js 22\.23\.4\+/);
});
