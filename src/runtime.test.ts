import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnRunProcess } from "./runtime.js";

for (const stream of ["stdout", "stderr"] as const) {
  test(`process streaming bounds unterminated ${stream} lines`, async () => {
    const seen: string[] = [];
    const result = await spawnRunProcess()({ command: process.execPath,
      args: ["-e", `process.${stream}.write('x'.repeat(100000)); setTimeout(()=>{},1000)`],
      maxLineChars: 1024, timeoutMs: 2000,
      ...(stream === "stdout" ? { onStdoutLine: (line: string) => { seen.push(line); } } : { onStderrLine: (line: string) => { seen.push(line); } }) });
    assert.equal(result.outputTruncated, true);
    assert.equal(result.stoppedEarly, true);
    assert.equal(result.stdout, ""); assert.equal(result.stderrTail, "");
    assert.equal(seen.length, 0);
  });
}

test("streamed stderr is not retained and rejection stops the process", async () => {
  const seen: string[] = [];
  const result = await spawnRunProcess()({ command: process.execPath,
    args: ["-e", "process.stderr.write('reject\\n'); setTimeout(()=>{},1000)"], timeoutMs: 2000,
    onStderrLine: (line) => { seen.push(line); return false; } });
  assert.deepEqual(seen, ["reject"]);
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.stderrTail, "");
});

test("streamed final lines are delivered and timeouts remain visible", async () => {
  const seen: string[] = [];
  const result = await spawnRunProcess()({ command: process.execPath, args: ["-e", "process.stderr.write('final')"],
    onStderrLine: (line) => { seen.push(line); } });
  assert.deepEqual(seen, ["final"]); assert.equal(result.code, 0); assert.equal(result.outputTruncated, false);
  const timeout = await spawnRunProcess()({ command: process.execPath, args: ["-e", "setTimeout(()=>{},2000)"], timeoutMs: 30 });
  assert.equal(timeout.timedOut, true);
});
