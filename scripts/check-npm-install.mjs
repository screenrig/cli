#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args, options = {}) {
  const result = spawnSync(npm, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${npm} ${args.join(" ")}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

function successfulEnvelope(args, cwd, environment) {
  const result = run(["exec", "--offline", "--yes=false", "--", "screenrig", "--json", ...args], {
    cwd,
    env: environment,
  });
  if (result.stderr) throw new Error(`${args.join(" ")}: stderr must stay empty`);
  const envelope = JSON.parse(result.stdout);
  if (envelope.ok !== true) throw new Error(`${args.join(" ")}: installed CLI returned a failure envelope`);
  return envelope;
}

let requestedSpec;
if (process.argv.length === 4 && process.argv[2] === "--spec") requestedSpec = process.argv[3];
else if (process.argv.length !== 2) throw new Error("usage: check-npm-install.mjs [--spec screenrig@VERSION]");

const registrySpec = `${packageJson.name}@${packageJson.version}`;
if (requestedSpec && requestedSpec !== registrySpec) {
  throw new Error(`registry smoke must install the exact release ${registrySpec}`);
}

const temporary = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "screenrig-npm-install."));
try {
  const cache = path.join(temporary, "npm-cache");
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ name: "screenrig-clean-install-smoke", version: "0.0.0", private: true }, null, 2)}\n`,
  );

  let spec = requestedSpec;
  const environment = { ...process.env, NPM_CONFIG_CACHE: cache };
  if (!spec) {
    const packed = run(["pack", "--json", "--pack-destination", temporary], { cwd: root, env: environment });
    const inventory = JSON.parse(packed.stdout);
    const filename = Array.isArray(inventory) ? inventory[0]?.filename : inventory?.filename;
    if (!filename) throw new Error("npm pack did not report an archive filename");
    spec = path.join(temporary, filename);
  }

  await writeFile(path.join(consumer, ".npmrc"), "audit=false\nfund=false\n", "utf8");
  run(["install", "--no-audit", "--no-fund", spec], {
    cwd: consumer,
    env: environment,
  });

  const version = successfulEnvelope(["version"], consumer, environment);
  if (version.data?.version !== packageJson.version) {
    throw new Error(`installed CLI returned version ${version.data?.version}; expected ${packageJson.version}`);
  }
  successfulEnvelope(["compose", "catalog"], consumer, environment);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write(`clean npm install smoke passed for ${registrySpec}\n`);
