import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testTemp } from "./test-temp.js";

test("CLI drains a large JSON envelope through a backpressured child-process pipe", { timeout: 30000 }, async () => {
  const directory = await testTemp("bin-output-");
  try {
    // `app pack` runs offline and lists every packed file in its envelope: 2,500 files exceed a pipe buffer.
    const site = path.join(directory, "site");
    await mkdir(site);
    await writeFile(path.join(site, "index.html"), "<!doctype html><title>Large</title>\n");
    for (let start = 0; start < 2500; start += 250) {
      await Promise.all(Array.from({ length: 250 }, (_, offset) => writeFile(path.join(site, `file-${String(start + offset).padStart(4, "0")}.txt`), `file ${start + offset}\n`)));
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL("./bin.js", import.meta.url)), "--json", "app", "pack", site, "--output", path.join(directory, "site.tgz")], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_CONFIG_HOME: directory, SCREENRIG_CONFIG: path.join(directory, "missing-config.json") } });
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
    assert.equal(envelope.data.file_count, 2502);
    assert.equal(envelope.data.entries.length, 2502);
    assert.ok(stdout.endsWith("\n"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
