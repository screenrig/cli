import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { readSdkTypes, SDK_TYPES_FILE } from "./adapters/sdk-types.js";
import { readAsset } from "./assets.js";
import { run } from "./main.js";
import { testTemp } from "./test-temp.js";

const TYPES = Buffer.from("export interface ScreenRig {\n    destroy(): void;\n}\n\ndeclare global {\n    interface Window {\n        screenrig: ScreenRig;\n    }\n}\n");

async function invoke(directory: string, argv: string[], sdkTypes?: () => Uint8Array) {
  let output = "";
  let errors = "";
  const stdout = new Writable({ write(chunk, _encoding, callback) { output += chunk; callback(); } });
  const stderr = new Writable({ write(chunk, _encoding, callback) { errors += chunk; callback(); } });
  const fs = { mkdir, open, rename, rm, chmod, stat, homedir: () => directory, settings: { XDG_CONFIG_HOME: path.join(directory, "config") } };
  const code = await run({
    argv, settings: fs.settings, stdout, stderr, fs, homedir: fs.homedir,
    cwd: () => directory, now: () => new Date("2026-11-11T00:00:00Z"), sleep: async () => undefined,
    ...(sdkTypes ? { sdkTypes } : {}),
  });
  stdout.end();
  stderr.end();
  return { code, output, errors };
}

async function workspace(t: { after(fn: () => Promise<void>): void }) {
  const directory = await testTemp("app-types-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "src"));
  return directory;
}

test("app types writes screenrig.d.ts into the named directory and reports its digest", async (t) => {
  const directory = await workspace(t);
  const result = await invoke(directory, ["--json", "app", "types", "src"], () => TYPES);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.errors, "");
  const envelope = JSON.parse(result.output);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data, {
    path: path.join("src", SDK_TYPES_FILE),
    bytes: TYPES.length,
    sha256: createHash("sha256").update(TYPES).digest("hex"),
    written: true,
  });
  assert.deepEqual(await readFile(path.join(directory, "src", SDK_TYPES_FILE)), TYPES);
  assert.deepEqual((await readdir(path.join(directory, "src"))).sort(), [SDK_TYPES_FILE], "no temporary file is left behind");
});

test("app types writes into the current directory when none is named", async (t) => {
  const directory = await workspace(t);
  const result = await invoke(directory, ["--json", "app", "types"], () => TYPES);
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(result.output).data.path, SDK_TYPES_FILE);
  assert.deepEqual(await readFile(path.join(directory, SDK_TYPES_FILE)), TYPES);
});

test("app types needs no credential and sends nothing", async (t) => {
  const directory = await workspace(t);
  // No config file, no token, no transport: an authenticated command would fail not_enrolled.
  const result = await invoke(directory, ["--json", "app", "types", "src"], () => TYPES);
  assert.equal(result.code, 0, result.output);
});

test("app types replaces a stale copy and leaves a current one untouched", async (t) => {
  const directory = await workspace(t);
  const target = path.join(directory, "src", SDK_TYPES_FILE);
  await writeFile(target, "// an older copy\n");
  const replaced = await invoke(directory, ["--json", "app", "types", "src"], () => TYPES);
  assert.equal(replaced.code, 0, replaced.output);
  assert.equal(JSON.parse(replaced.output).data.written, true);
  assert.deepEqual(await readFile(target), TYPES);

  const before = await stat(target);
  const again = await invoke(directory, ["--json", "app", "types", "src"], () => TYPES);
  assert.equal(again.code, 0, again.output);
  assert.equal(JSON.parse(again.output).data.written, false);
  const after = await stat(target);
  assert.equal(after.ino, before.ino, "a current copy is not rewritten");
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("app types prints a short human summary", async (t) => {
  const directory = await workspace(t);
  const first = await invoke(directory, ["--human", "app", "types", "src"], () => TYPES);
  assert.equal(first.code, 0, first.output);
  assert.match(first.output, /^SDK types written\npath: src[\\/]screenrig\.d\.ts\nbytes: \d+\nsha256: [a-f0-9]{64}\n$/);
  const second = await invoke(directory, ["--human", "app", "types", "src"], () => TYPES);
  assert.match(second.output, /^SDK types already current\n/);
});

test("app types refuses a missing directory, a file, and a target that is not a regular file", async (t) => {
  const directory = await workspace(t);
  await writeFile(path.join(directory, "notes.txt"), "text");
  const missing = await invoke(directory, ["--json", "app", "types", "nowhere"], () => TYPES);
  assert.equal(missing.code, 2);
  assert.equal(JSON.parse(missing.output).error.code, "usage_error");
  assert.match(JSON.parse(missing.output).error.detail, /nowhere does not exist/);

  const file = await invoke(directory, ["--json", "app", "types", "notes.txt"], () => TYPES);
  assert.equal(file.code, 2);
  assert.match(JSON.parse(file.output).error.detail, /notes\.txt is a file/);

  await mkdir(path.join(directory, "src", SDK_TYPES_FILE));
  const occupied = await invoke(directory, ["--json", "app", "types", "src"], () => TYPES);
  assert.equal(occupied.code, 2);
  assert.match(JSON.parse(occupied.output).error.detail, /not a regular file/);
  await rm(path.join(directory, "src", SDK_TYPES_FILE), { recursive: true });

  await writeFile(path.join(directory, "elsewhere.d.ts"), "// someone else's file\n");
  await symlink(path.join(directory, "elsewhere.d.ts"), path.join(directory, "src", SDK_TYPES_FILE));
  const linked = await invoke(directory, ["--json", "app", "types", "src"], () => TYPES);
  assert.equal(linked.code, 2);
  assert.equal(await readFile(path.join(directory, "elsewhere.d.ts"), "utf8"), "// someone else's file\n", "a symlink is never written through");
});

test("app types reports a missing packaged file without writing anything", async (t) => {
  const directory = await workspace(t);
  const result = await invoke(directory, ["--json", "app", "types", "src"], () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); });
  assert.notEqual(result.code, 0);
  assert.deepEqual(await readdir(path.join(directory, "src")), []);
});

test("the packaged declaration file declares window.screenrig and imports nothing", async (t) => {
  // Vendored from the backend SDK build with the browser runtime it describes.
  const text = readAsset("screenrig.d.ts").toString("utf8");
  assert.deepEqual(readSdkTypes(), readAsset("screenrig.d.ts"));
  assert.match(text, /export interface ScreenRig \{/);
  assert.match(text, /declare global \{\s+interface Window \{[^}]*screenrig: ScreenRig;/);
  assert.doesNotMatch(text, /^\s*import\b/m);
  assert.doesNotMatch(text, /\bexport\b[^;\n]*\bfrom\s*["']/);
  assert.ok(Buffer.byteLength(text) < 256 * 1024, "the Claude plugin directory reads at most 256 KiB of a file");
  t.diagnostic(`${Buffer.byteLength(text)} bytes`);
});
