#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER_VERSION, isReleaseVersion, resolvePackVersion, versionFromTag } from "./calver.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
// Windows command shims cannot be spawned without a shell. Invoke npm's JS
// entry point with this Node runtime so paths and arguments need no shell quoting.
const npm = process.platform === "win32" ? process.execPath : "npm";
const npmArgs = process.platform === "win32"
  ? [process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];

function run(args, options = {}) {
  const result = spawnSync(npm, [...npmArgs, ...args], { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")}: ${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`);
  }
  return result;
}

function successfulEnvelope(args, cwd, environment) {
  const result = run(["exec", "--loglevel=error", "--offline", "--yes=false", "--", "screenrig", "--json", ...args], {
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

let expectedVersion;
if (requestedSpec) {
  const match = /^screenrig@(v?.+)$/.exec(requestedSpec);
  const specVersion = match?.[1]?.startsWith("v") ? versionFromTag(match[1]) : match?.[1];
  if (!isReleaseVersion(specVersion)) {
    throw new Error(`registry smoke must install an exact CalVer release; received ${requestedSpec}`);
  }
  expectedVersion = specVersion;
} else {
  expectedVersion = packageJson.version === PLACEHOLDER_VERSION ? resolvePackVersion({ env: {} }) : packageJson.version;
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
  // npm installs this machine's renderer package, so a render must not fetch one.
  const userCache = path.join(temporary, "user-cache");
  const environment = { ...process.env, NPM_CONFIG_CACHE: cache, XDG_CACHE_HOME: userCache, LOCALAPPDATA: userCache };
  if (process.platform === "darwin") environment.HOME = path.join(temporary, "home");
  const rendererCache = process.platform === "darwin"
    ? path.join(environment.HOME, "Library", "Caches", "screenrig")
    : path.join(userCache, "screenrig");
  delete environment.SCREENRIG_VERSION;
  delete environment.NAPI_RS_NATIVE_LIBRARY_PATH;
  if (!spec) {
    const packed = run(["pack", "--json", "--pack-destination", temporary], { cwd: root, env: environment });
    const inventory = JSON.parse(packed.stdout);
    // npm 12 keys pack results by package name; earlier npm returns an array.
    const filename = Array.isArray(inventory) ? inventory[0]?.filename : inventory?.filename ?? inventory?.[packageJson.name]?.filename;
    if (!filename) throw new Error("npm pack did not report an archive filename");
    spec = path.join(temporary, filename);
  }

  await writeFile(path.join(consumer, ".npmrc"), "audit=false\nfund=false\n", "utf8");
  run(["install", "--no-audit", "--no-fund", spec], {
    cwd: consumer,
    env: environment,
  });

  const version = successfulEnvelope(["version"], consumer, environment);
  if (version.data?.version !== expectedVersion) {
    throw new Error(`installed CLI returned version ${version.data?.version}; expected ${expectedVersion}`);
  }
  successfulEnvelope(["compose", "catalog"], consumer, environment);
  if (existsSync(rendererCache)) throw new Error("an npm install must render with its installed platform package, not a fetched renderer");
  const playlistFile = path.join(temporary, "playlist.json");
  await writeFile(playlistFile, JSON.stringify({ name: "Offline validation", pages: [{ id: "page", canvas: { width: 1920, height: 1080, background: "#000000FF" }, transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "application", max_ms: 60000 }, primitives: [{ id: "app", primitive: "application", release_id: "rel_EXAMPLE", controller: true, rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "fill" }] }] }));
  successfulEnvelope(["playlist", "validate", playlistFile], consumer, environment);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write(`clean npm install smoke passed for ${packageJson.name}@${expectedVersion}\n`);
