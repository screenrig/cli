import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { testTemp } from "./test-temp.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "sync-contract-snapshots.mjs");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function sync(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], { cwd: ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** A source root holding the exact bytes the CLI currently vendors. */
async function canonicalSourceRoot(prefix: string): Promise<string> {
  const root = await testTemp(prefix);
  const manifest = JSON.parse(await readFile(path.join(ROOT, "vendor", "manifest.json"), "utf8")) as {
    files: Array<{ path: string; source: string }>;
  };
  for (const file of manifest.files) {
    const destination = path.join(root, file.source);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ROOT, file.path), destination);
  }
  return root;
}

test("plain --check verifies internal consistency and does not require a backend checkout", async () => {
  const result = await sync(["--check"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /internal consistency only/);
  assert.match(result.stdout, /pass --source-root to check for backend drift/);
});

test("--check --source-root passes when the vendored snapshot matches the backend", async () => {
  const root = await canonicalSourceRoot("vendor-match-");
  try {
    const result = await sync(["--check", "--source-root", root]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /verified against/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--check --source-root fails on drift and names the file and both digests", async () => {
  const root = await canonicalSourceRoot("vendor-drift-");
  try {
    const drifted = path.join(root, "api", "openapi.yaml");
    await writeFile(drifted, `${await readFile(drifted, "utf8")}\n# backend moved on\n`);

    const result = await sync(["--check", "--source-root", root]);
    assert.equal(result.code, 1, "drift must fail the gate");
    assert.match(result.stderr, /does not match the backend checkout/);
    assert.match(result.stderr, /vendor\/openapi\.yaml/);
    // The operator must be able to act on this, so both digests must appear.
    assert.match(result.stderr, /vendored\s+[0-9a-f]{64}\s+\d+ bytes/);
    assert.match(result.stderr, /canonical\s+[0-9a-f]{64}\s+\d+ bytes/);
    assert.match(result.stderr, /--sync --source-root/);
    // An unchanged input must not be reported as drifted.
    assert.ok(!result.stderr.includes("screenrig.runtime.js"), result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing, unreadable, or valueless --source-root is an error, never a silent pass", async () => {
  const absent = await sync(["--check", "--source-root", path.join(ROOT, "no-such-backend")]);
  assert.equal(absent.code, 1);
  assert.match(absent.stderr, /Cannot verify contract drift/);
  assert.match(absent.stderr, /unreadable/);

  const notADirectory = await sync(["--check", "--source-root", path.join(ROOT, "package.json")]);
  assert.equal(notADirectory.code, 1);
  assert.match(notADirectory.stderr, /not a directory/);

  const valueless = await sync(["--check", "--source-root"]);
  assert.equal(valueless.code, 1);
  assert.match(valueless.stderr, /--source-root requires a path/);

  // A readable root that simply lacks the canonical inputs must also fail.
  const empty = await testTemp("vendor-empty-");
  try {
    const result = await sync(["--check", "--source-root", empty]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Missing canonical inputs/);
    assert.match(result.stderr, /api\/openapi\.yaml/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
