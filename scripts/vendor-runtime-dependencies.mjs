#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeDependencyLock, RUNTIME_LOCK_FILE, verifyIntegrity } from "./runtime-dependencies.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function runTar(args, label) {
  const result = spawnSync("tar", args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (result.status !== 0) throw new Error(`${label}: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}

function inspectPackageArchive(archive, label) {
  const names = runTar(["-tzf", archive], label).split("\n").filter(Boolean);
  const verbose = runTar(["-tvzf", archive], label).split("\n").filter(Boolean);
  if (names.length === 0 || names.length !== verbose.length) throw new Error(`${label}: invalid package archive inventory`);
  for (const name of names) {
    const parts = name.split("/");
    if (parts[0] !== "package" || parts.some((part) => part === ".." || part === ".")) {
      throw new Error(`${label}: unsafe package archive path ${name}`);
    }
  }
  for (const line of verbose) {
    if (!line.startsWith("-") && !line.startsWith("d")) throw new Error(`${label}: package archive contains a link or special file`);
  }
}

async function main() {
  const destinationFlag = process.argv.indexOf("--destination");
  if (destinationFlag < 0 || !process.argv[destinationFlag + 1] || process.argv.length !== 4) {
    throw new Error("usage: vendor-runtime-dependencies.mjs --destination <package-root>");
  }
  const destination = path.resolve(process.argv[destinationFlag + 1]);
  const runtimeLock = await loadRuntimeDependencyLock(root);
  const temporary = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "screenrig-runtime-deps."));
  try {
    for (const dependency of runtimeLock.packages) {
      const response = await fetch(dependency.resolved, { redirect: "error", signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`${dependency.name}: registry returned HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      verifyIntegrity(bytes, dependency.integrity, dependency.name);
      const archive = path.join(temporary, `${runtimeLock.packages.indexOf(dependency)}.tgz`);
      await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
      inspectPackageArchive(archive, dependency.name);
      const target = path.join(destination, dependency.path);
      await mkdir(target, { recursive: true });
      runTar(["-xzf", archive, "-C", target, "--strip-components=1"], dependency.name);
      const metadata = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
      if (metadata.name !== dependency.name || metadata.version !== dependency.version) {
        throw new Error(`${dependency.name}: extracted package metadata differs from package-lock.json`);
      }
    }
    await writeFile(path.join(destination, RUNTIME_LOCK_FILE), `${JSON.stringify(runtimeLock, null, 2)}\n`, "utf8");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  process.stdout.write(`vendored ${runtimeLock.packages.length} exact runtime dependencies\n`);
}

main().catch((error) => {
  process.stderr.write(`vendor-runtime-dependencies: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
