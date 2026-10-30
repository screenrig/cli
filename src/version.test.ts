import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLI_VERSION,
  cliDistribution,
  PLACEHOLDER_VERSION,
  isDevVersion,
  isProductVersion,
  isReleaseVersion,
  resolveCliVersion,
  untaggedDevVersion,
  versionFromTag,
} from "./version.js";

test("distribution distinguishes a standalone install from an enclosing screenRIG bundle", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "screenrig-distribution-"));
  try {
    const url = pathToFileURL(path.join(temporary, "cli", "dist", "bin.js")).href;
    assert.equal(cliDistribution(url, "26.10.1").kind, "standalone");
    assert.match(cliDistribution(url, "26.10.1").agent_setup, /plugin list/);
    // The plugin's bootstrap helper beside the CLI marks the bundle; the
    // release stamps the plugin version into the CLI package.
    const scripts = path.join(temporary, "skills", "screenrig", "scripts");
    await mkdir(scripts, { recursive: true });
    await writeFile(path.join(scripts, "screenrig-plugin-freshness"), "#!/usr/bin/env node\n");
    const distribution = cliDistribution(url, "26.10.1");
    assert.equal(distribution.kind, "plugin_bundle");
    assert.equal(distribution.plugin_version, "26.10.1");
    assert.match(distribution.bootstrap!, /screenrig-plugin-freshness.*--bootstrap --json$/);
    assert.equal(cliDistribution(url, "not-a-version").kind, "standalone");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

const root = fileURLToPath(new URL("..", import.meta.url));
const calver = path.join(root, "scripts", "calver.mjs");

test("untagged local trees use YY.MM.0-dev in UTC", () => {
  assert.equal(untaggedDevVersion(new Date("2026-09-07T12:00:00.000Z")), "26.09.0-dev");
  assert.equal(untaggedDevVersion(new Date("2026-01-01T00:00:00.000Z")), "26.01.0-dev");
  assert.equal(untaggedDevVersion(new Date("2026-12-31T23:59:59.000Z")), "26.12.0-dev");
  assert.equal(isDevVersion("26.09.0-dev"), true);
  assert.equal(isReleaseVersion("26.09.0-dev"), false);
  assert.equal(isReleaseVersion("26.09.1"), true);
  assert.equal(isReleaseVersion("26.09.0"), false);
  assert.equal(isProductVersion("0.1.0"), false);
});

test("placeholder package.json is not a product version", () => {
  assert.equal(PLACEHOLDER_VERSION, "0.1.0");
  assert.equal(
    resolveCliVersion({ env: {}, packageVersion: PLACEHOLDER_VERSION, now: new Date("2026-09-07T00:00:00.000Z") }),
    "26.09.0-dev",
  );
});

test("stamped package.json and SCREENRIG_VERSION win in that order", () => {
  assert.equal(resolveCliVersion({ env: {}, packageVersion: "26.09.2" }), "26.09.2");
  assert.equal(
    resolveCliVersion({ env: { SCREENRIG_VERSION: "26.09.3" }, packageVersion: "26.09.2" }),
    "26.09.3",
  );
  assert.equal(
    resolveCliVersion({ env: { SCREENRIG_VERSION: "not-a-version" }, packageVersion: "26.09.2" }),
    "26.09.2",
  );
});

test("release tags map to YY.MM.N and reject serial 0", () => {
  assert.equal(versionFromTag("v26.09.1"), "26.09.1");
  assert.equal(versionFromTag("v26.09.0"), undefined);
  assert.equal(versionFromTag("v26.09.0-dev"), undefined);
  assert.equal(versionFromTag("v0.1.0"), undefined);
});

test("running CLI_VERSION is the stamped or untagged product version", () => {
  assert.equal(isProductVersion(CLI_VERSION), true);
  assert.notEqual(CLI_VERSION, PLACEHOLDER_VERSION);
});

test("calver.mjs prints, parses tags, and stamps package.json", async () => {
  const printed = spawnSync(process.execPath, [calver, "print"], {
    cwd: root,
    env: { ...process.env, SCREENRIG_VERSION: "" },
    encoding: "utf8",
  });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout.trim(), untaggedDevVersion());

  const fromTag = spawnSync(process.execPath, [calver, "from-tag", "v26.09.4"], { cwd: root, encoding: "utf8" });
  assert.equal(fromTag.status, 0, fromTag.stderr);
  assert.equal(fromTag.stdout.trim(), "26.09.4");

  const temporary = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "screenrig-calver-"));
  try {
    const packageJson = { name: "screenrig", version: PLACEHOLDER_VERSION };
    const lock = { name: "screenrig", version: PLACEHOLDER_VERSION, packages: { "": { name: "screenrig", version: PLACEHOLDER_VERSION } } };
    await writeFile(path.join(temporary, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    await writeFile(path.join(temporary, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    const stamped = spawnSync(process.execPath, [calver, "stamp", "--root", temporary, "--version", "26.09.5"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(stamped.status, 0, stamped.stderr);
    const pkg = JSON.parse(await readFile(path.join(temporary, "package.json"), "utf8")) as { version: string };
    const lockFile = JSON.parse(await readFile(path.join(temporary, "package-lock.json"), "utf8")) as {
      version: string;
      packages: { "": { version: string } };
    };
    assert.equal(pkg.version, "26.09.5");
    assert.equal(lockFile.version, "26.09.5");
    assert.equal(lockFile.packages[""].version, "26.09.5");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
