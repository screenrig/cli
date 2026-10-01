#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProductVersion } from "./calver.mjs";
import { isRendererPlatformPackage, loadRuntimeDependencyLock, NOTICES_FILE, RUNTIME_LOCK_FILE } from "./runtime-dependencies.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// The whole release: one bundled executable and the files that travel with it.
const INVENTORY = [
  "package",
  "package/LICENSE",
  "package/README.md",
  "package/SECURITY.md",
  `package/${NOTICES_FILE}`,
  "package/dist",
  "package/dist/bin.js",
  "package/package.json",
  `package/${RUNTIME_LOCK_FILE}`,
].sort();

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

async function nativeFiles(directory) {
  const entries = await readdir(directory, { recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.endsWith(".node"));
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
    if (JSON.stringify(inventory) !== JSON.stringify(INVENTORY)) {
      throw new Error(`release archive must hold exactly ${INVENTORY.join(", ")}; it holds ${inventory.join(", ")}`);
    }
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
    const locked = expected.packages.filter((dependency) => !isRendererPlatformPackage(dependency));
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
      XDG_CACHE_HOME: path.join(home, "cache"),
      LOCALAPPDATA: path.join(home, "cache"),
    };
    delete environment.SCREENRIG_VERSION;
    delete environment.NAPI_RS_NATIVE_LIBRARY_PATH;
    const version = successfulEnvelope(packageRoot, ["version"], environment);
    if (version.data?.version !== packaged.version) {
      throw new Error(`bundled CLI returned ${version.data?.version}; package.json is ${packaged.version}`);
    }
    if ((await nativeFiles(home)).length !== 0) throw new Error("version must not fetch the renderer");
    // The first render fetches this machine's renderer from the lock's registry URL and caches it.
    successfulEnvelope(packageRoot, ["compose", "catalog"], environment);
    if ((await nativeFiles(home)).length !== 1) throw new Error("compose catalog did not cache exactly one renderer binary");
  const playlistFile = path.join(temporary, "playlist.json");
  await writeFile(playlistFile, JSON.stringify({ name: "Offline validation", pages: [{ id: "page", canvas: { width: 1920, height: 1080, background: "#000000FF" }, transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "application", max_ms: 60000 }, primitives: [{ id: "app", primitive: "application", release_id: "rel_EXAMPLE", controller: true, rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "fill" }] }] }));
    successfulEnvelope(packageRoot, ["playlist", "validate", playlistFile], environment);
    // The bundle carries the pinned browser runtime inline; it must be the same bytes.
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
