#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeDependencyLock, RUNTIME_LOCK_FILE } from "./runtime-dependencies.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}

function successfulEnvelope(packageRoot, args, environment) {
  const result = run(process.execPath, [path.join(packageRoot, "dist", "bin.js"), "--json", ...args], {
    cwd: packageRoot,
    env: environment,
  });
  if (result.stderr) throw new Error(`${args.join(" ")}: stderr must stay empty`);
  const envelope = JSON.parse(result.stdout);
  if (envelope.ok !== true) throw new Error(`${args.join(" ")}: CLI returned a failure envelope`);
  return envelope;
}

async function main() {
  if (process.argv.length !== 3) throw new Error("usage: check-release-artifact.mjs <screenrig-cli.tgz>");
  const artifact = path.resolve(process.argv[2]);
  const temporary = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "screenrig-release-check."));
  try {
    const names = run("tar", ["-tzf", artifact]).stdout.split("\n").filter(Boolean);
    const verbose = run("tar", ["-tvzf", artifact]).stdout.split("\n").filter(Boolean);
    if (
      names.length === 0 ||
      names.length !== verbose.length ||
      names.some((name) => {
        const parts = name.split("/");
        return parts[0] !== "package" || parts.some((part) => part === "." || part === "..");
      }) ||
      verbose.some((line) => !line.startsWith("-") && !line.startsWith("d"))
    ) {
      throw new Error("release archive has an unsafe or empty inventory");
    }
    run("tar", ["-xzf", artifact, "-C", temporary]);
    const packageRoot = path.join(temporary, "package");
    let readme;
    try {
      readme = await readFile(path.join(packageRoot, "README.md"), "utf8");
      await readFile(path.join(packageRoot, "SECURITY.md"), "utf8");
    } catch {
      throw new Error("release archive is missing README.md or SECURITY.md");
    }
    if (!readme.includes("[security policy](SECURITY.md)")) {
      throw new Error("release archive README does not link its bundled SECURITY.md");
    }
    const expected = await loadRuntimeDependencyLock(root);
    let actual;
    try {
      actual = JSON.parse(await readFile(path.join(packageRoot, RUNTIME_LOCK_FILE), "utf8"));
    } catch {
      throw new Error(`release archive is missing a valid ${RUNTIME_LOCK_FILE}`);
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("runtime dependency manifest differs from package-lock.json");
    for (const dependency of expected.packages) {
      let metadata;
      try {
        metadata = JSON.parse(await readFile(path.join(packageRoot, dependency.path, "package.json"), "utf8"));
      } catch {
        throw new Error(`${dependency.path}: bundled runtime dependency is missing or invalid`);
      }
      if (metadata.name !== dependency.name || metadata.version !== dependency.version) {
        throw new Error(`${dependency.path}: bundled package metadata differs from the runtime dependency manifest`);
      }
    }
    const environment = { ...process.env, XDG_CONFIG_HOME: path.join(temporary, "config") };
    const version = successfulEnvelope(packageRoot, ["version"], environment);
    if (version.data?.version !== "0.1.0") throw new Error("offline bundled CLI returned the wrong version");
    successfulEnvelope(packageRoot, ["compose", "catalog"], environment);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  process.stdout.write("CLI release artifact check passed\n");
}

main().catch((error) => {
  process.stderr.write(`check-release-artifact: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
