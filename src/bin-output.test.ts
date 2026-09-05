import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testTemp } from "./test-temp.js";

test("CLI drains a large JSON envelope through a backpressured child-process pipe", { timeout: 30000 }, async () => {
  const directory = await testTemp("bin-output-");
  try {
    const file = path.join(directory, "batch.json"), output = path.join(directory, "rendered");
    await mkdir(output);
    await writeFile(file, JSON.stringify({ pages: Array.from({ length: 36 }, (_, index) => ({ id: `page-${index}`, spec: { type: "Frame", width: 320, height: 180, children: Array.from({ length: 8 }, (_, textIndex) => ({ type: "Text", role: "title", text: `Page ${index} text ${textIndex}: diagnostics remain complete.` })) } })) }));
    const child = spawn(process.execPath, [fileURLToPath(new URL("./bin.js", import.meta.url)), "--json", "compose", "batch", file, "--output", output], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_CONFIG_HOME: directory, SCREENRIG_CONFIG: path.join(directory, "missing-config.json") } });
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    // Keep the OS pipe full at exit long enough to expose process.exit truncation.
    child.stdout.pause();
    const resume = setTimeout(() => child.stdout.resume(), 1000);
    const [code] = await once(child, "close");
    clearTimeout(resume);
    const stdout = Buffer.concat(chunks).toString("utf8");
    assert.equal(code, 0, Buffer.concat(errors).toString("utf8"));
    assert.equal(Buffer.concat(errors).length, 0);
    assert.ok(Buffer.byteLength(stdout) > 65536, "regression must exceed a typical pipe buffer");
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.rendered, 36);
    assert.deepEqual(envelope.data.pages, JSON.parse(await readFile(path.join(output, "compose-batch.json"), "utf8")).pages);
    assert.ok(stdout.endsWith("\n"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
