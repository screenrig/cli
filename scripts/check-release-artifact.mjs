#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProductVersion } from "./calver.mjs";
import { loadRuntimeDependencyLock, NOTICES_FILE, RUNTIME_LOCK_FILE } from "./runtime-dependencies.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// The whole release: the bundled executable dist/bin.js, the flat dist/*.js
// chunks it loads per command group, the assets/ files it reads, and the files
// that travel with them.
const INVENTORY = [
  "package",
  "package/LICENSE",
  "package/README.md",
  "package/SECURITY.md",
  `package/${NOTICES_FILE}`,
  "package/assets",
  "package/dist",
  "package/dist/bin.js",
  "package/package.json",
  `package/${RUNTIME_LOCK_FILE}`,
];
const CHUNK = /^package\/dist\/[A-Za-z0-9_-]+\.js$/;
// The Claude plugin directory reads at most 256 KiB of a script.
const MAX_FILE_BYTES = 256 * 1024;

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
    const inventory = names.map((name) => name.replace(/\/$/, "")).sort();
    const assets = (await readdir(path.join(root, "assets"))).map((name) => `package/assets/${name}`);
    const unexpected = inventory.filter((name) => !INVENTORY.includes(name) && !assets.includes(name) && !CHUNK.test(name));
    const missing = [...INVENTORY, ...assets].filter((name) => !inventory.includes(name));
    if (unexpected.length || missing.length) {
      throw new Error(`release archive must hold ${INVENTORY.join(", ")}, every assets/ file and flat dist/*.js chunks; unexpected ${unexpected.join(", ") || "none"}; missing ${missing.join(", ") || "none"}`);
    }
    const oversized = verbose.map((line) => line.trim().split(/\s+/)).filter((fields) => Number(fields[2]) > MAX_FILE_BYTES).map((fields) => fields.at(-1));
    if (oversized.length) throw new Error(`release archive files over ${MAX_FILE_BYTES} bytes: ${oversized.join(", ")}`);
    run("tar", ["-xzf", artifact, "-C", temporary]);
    const packageRoot = path.join(temporary, "package");
    const readme = await readFile(path.join(packageRoot, "README.md"), "utf8");
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
    // Every package inside dist/bin.js is a locked runtime dependency, and every declared one is inside it.
    const notices = await readFile(path.join(packageRoot, NOTICES_FILE), "utf8");
    const noticed = [...notices.matchAll(/^(\S+)@(\d\S*) \(/gm)].map((match) => `${match[1]}@${match[2]}`);
    const locked = expected.packages;
    for (const entry of noticed) {
      if (!locked.some((dependency) => `${dependency.name}@${dependency.version}` === entry)) {
        throw new Error(`${NOTICES_FILE} names ${entry}, which is not a locked runtime dependency`);
      }
    }
    let packaged;
    try {
      packaged = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    } catch {
      throw new Error("release archive is missing package.json");
    }
    for (const name of Object.keys(packaged.dependencies ?? {})) {
      const dependency = locked.find((item) => item.name === name);
      if (!dependency || !noticed.includes(`${name}@${dependency.version}`)) {
        throw new Error(`${name} is a declared dependency without a ${NOTICES_FILE} entry`);
      }
    }
    if (!isProductVersion(packaged.version)) {
      throw new Error(`release archive package.json version must be YY.MM.N or YY.MM.0-dev; received ${packaged.version}`);
    }
    const home = path.join(temporary, "home");
    const environment = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(temporary, "config"),
    };
    delete environment.SCREENRIG_VERSION;
    const version = successfulEnvelope(packageRoot, ["version"], environment);
    if (version.data?.version !== packaged.version) {
      throw new Error(`bundled CLI returned ${version.data?.version}; package.json is ${packaged.version}`);
    }
    // Help loads its guidance chunk on demand, offline.
    successfulEnvelope(packageRoot, ["help", "playlist", "validate"], environment);
    successfulEnvelope(packageRoot, ["help", "--all"], environment);
  const playlistFile = path.join(temporary, "playlist.json");
  await writeFile(playlistFile, JSON.stringify({ name: "Offline validation", pages: [{ id: "page", canvas: { width: 1920, height: 1080, background: "#000000FF" }, transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "application", max_ms: 60000 }, primitives: [{ id: "app", primitive: "application", release_id: "rel_EXAMPLE", controller: true, rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "fill" }] }] }));
    successfulEnvelope(packageRoot, ["playlist", "validate", playlistFile], environment);
    // The release carries the pinned browser runtime in assets/; it must be the same bytes.
    const packed = successfulEnvelope(packageRoot, ["app", "pack", path.join(root, "fixtures", "pack", "ok-app"), "--output", path.join(temporary, "app.tgz")], environment);
    const runtime = createHash("sha256").update(await readFile(path.join(root, "assets", "screenrig.runtime.js"))).digest("hex");
    if (packed.data?.sdk_injection?.asset_sha256 !== runtime) throw new Error("bundled browser runtime differs from assets/screenrig.runtime.js");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  process.stdout.write("CLI release artifact check passed\n");
}

main().catch((error) => {
  process.stderr.write(`check-release-artifact: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
