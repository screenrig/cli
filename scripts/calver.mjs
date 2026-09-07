#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLACEHOLDER_VERSION = "0.1.0";
export const RELEASE_VERSION = /^(\d{2})\.(0[1-9]|1[0-2])\.([1-9]\d*)$/;
export const DEV_VERSION = /^(\d{2})\.(0[1-9]|1[0-2])\.0-dev$/;
export const RELEASE_TAG = /^v(\d{2})\.(0[1-9]|1[0-2])\.([1-9]\d*)$/;

const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const TAG_ATTEMPTS = 8;

export function isReleaseVersion(value) {
  return typeof value === "string" && RELEASE_VERSION.test(value);
}

export function isDevVersion(value) {
  return typeof value === "string" && DEV_VERSION.test(value);
}

export function isProductVersion(value) {
  return isReleaseVersion(value) || isDevVersion(value);
}

export function untaggedDevVersion(now = new Date()) {
  const year = String(now.getUTCFullYear()).slice(-2);
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}.${month}.0-dev`;
}

export function versionFromTag(tag) {
  if (typeof tag !== "string" || !RELEASE_TAG.test(tag)) return undefined;
  return tag.slice(1);
}

export function compareReleaseVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function gitConfig(cwd, key) {
  const result = git(cwd, ["config", "--get", key]);
  return result.status === 0 ? result.stdout.trim() : "";
}

function ensureGitIdentity(cwd) {
  if (gitConfig(cwd, "user.name") && gitConfig(cwd, "user.email")) return;
  if (process.env.GITHUB_ACTIONS === "true") {
    git(cwd, ["config", "user.name", BOT_NAME]);
    git(cwd, ["config", "user.email", BOT_EMAIL]);
    return;
  }
  throw new Error("git user.name and user.email are required to create an annotated CalVer tag");
}

export function releaseTagsAtHead(cwd) {
  const result = git(cwd, ["tag", "--points-at", "HEAD"]);
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => versionFromTag(line.trim()))
    .filter(Boolean)
    .sort(compareReleaseVersions);
}

export function nextReleaseVersion(cwd, now = new Date()) {
  const year = String(now.getUTCFullYear()).slice(-2);
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const prefix = `v${year}.${month}.`;
  const result = git(cwd, ["tag", "--list", `${prefix}*`]);
  let serial = 0;
  if (result.status === 0) {
    for (const line of result.stdout.split("\n")) {
      const version = versionFromTag(line.trim());
      if (!version) continue;
      const parts = version.split(".");
      const value = Number(parts[2]);
      if (Number.isInteger(value) && value > serial) serial = value;
    }
  }
  return `${year}.${month}.${serial + 1}`;
}

export function resolvePackVersion({ env = process.env, cwd, now = new Date() } = {}) {
  const fromEnv = env.SCREENRIG_VERSION;
  if (isProductVersion(fromEnv)) return fromEnv;
  if (cwd) {
    const atHead = releaseTagsAtHead(cwd);
    if (atHead.length > 0) return atHead[atHead.length - 1];
  }
  return untaggedDevVersion(now);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function stampPackageRoot(root, version) {
  if (!isProductVersion(version)) {
    throw new Error(`refusing to stamp non-product version ${version}`);
  }
  const packagePath = path.join(root, "package.json");
  const pkg = await readJson(packagePath);
  pkg.version = version;
  await writeJson(packagePath, pkg);
  const lockPath = path.join(root, "package-lock.json");
  try {
    const lock = await readJson(lockPath);
    lock.version = version;
    if (lock.packages && typeof lock.packages === "object" && lock.packages[""] && typeof lock.packages[""] === "object") {
      lock.packages[""].version = version;
    }
    await writeJson(lockPath, lock);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function allocateTag(cwd, remote) {
  for (let attempt = 0; attempt < TAG_ATTEMPTS; attempt += 1) {
    const fetched = git(cwd, ["fetch", "--tags", "--force", remote]);
    if (fetched.status !== 0) {
      process.stderr.write("calver: failed to fetch tags; retrying\n");
    }
    const existing = releaseTagsAtHead(cwd);
    if (existing.length > 0) return existing[existing.length - 1];
    const version = nextReleaseVersion(cwd);
    const tag = `v${version}`;
    ensureGitIdentity(cwd);
    git(cwd, ["tag", "-d", tag]);
    const created = git(cwd, ["tag", "-a", tag, "-m", tag]);
    if (created.status !== 0) {
      process.stderr.write("calver: failed to create local tag; retrying\n");
      continue;
    }
    const pushed = git(cwd, ["push", remote, tag]);
    if (pushed.status === 0) return version;
    git(cwd, ["tag", "-d", tag]);
    process.stderr.write("calver: tag push rejected; retrying\n");
  }
  throw new Error("failed to allocate a CalVer tag for this commit");
}

function printUsage() {
  throw new Error("usage: calver.mjs print [--git [cwd]] | from-tag <vYY.MM.N> | stamp --root <dir> --version <ver> | tag [--cwd <dir>] [--remote origin]");
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "print") {
    let cwd;
    if (args[1] === "--git") cwd = path.resolve(args[2] || process.cwd());
    else if (args.length !== 1) printUsage();
    process.stdout.write(`${resolvePackVersion({ cwd })}\n`);
    return;
  }
  if (command === "from-tag") {
    if (args.length !== 2) printUsage();
    const version = versionFromTag(args[1]);
    if (!version) throw new Error(`release tag must be vYY.MM.N with SERIAL >= 1; received ${args[1]}`);
    process.stdout.write(`${version}\n`);
    return;
  }
  if (command === "stamp") {
    const rootFlag = args.indexOf("--root");
    const versionFlag = args.indexOf("--version");
    if (rootFlag < 0 || versionFlag < 0 || !args[rootFlag + 1] || !args[versionFlag + 1]) printUsage();
    const version = args[versionFlag + 1];
    await stampPackageRoot(path.resolve(args[rootFlag + 1]), version);
    process.stdout.write(`stamped ${version}\n`);
    return;
  }
  if (command === "tag") {
    const cwdFlag = args.indexOf("--cwd");
    const remoteFlag = args.indexOf("--remote");
    const cwd = path.resolve(cwdFlag >= 0 && args[cwdFlag + 1] ? args[cwdFlag + 1] : process.cwd());
    const remote = remoteFlag >= 0 && args[remoteFlag + 1] ? args[remoteFlag + 1] : "origin";
    process.stdout.write(`${allocateTag(cwd, remote)}\n`);
    return;
  }
  printUsage();
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`calver: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
