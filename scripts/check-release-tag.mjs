#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER_VERSION, versionFromTag } from "./calver.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const tag = process.argv[2];

if (process.argv.length !== 3 || !tag) {
  throw new Error("usage: check-release-tag.mjs <vYY.MM.N>");
}

const version = versionFromTag(tag);
if (!version) {
  throw new Error(`release tag must be CalVer vYY.MM.N with SERIAL >= 1; received ${tag}`);
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
if (packageJson.version !== PLACEHOLDER_VERSION) {
  throw new Error(`committed package.json must stay ${PLACEHOLDER_VERSION}; CI stamps ${version}`);
}
if (packageLock.name !== packageJson.name || packageLock.version !== packageJson.version) {
  throw new Error("package-lock.json root name/version differs from package.json");
}
const lockRoot = packageLock.packages?.[""];
if (lockRoot?.name !== packageJson.name || lockRoot?.version !== packageJson.version) {
  throw new Error("package-lock.json package root name/version differs from package.json");
}

process.stdout.write(`release tag ${tag} is CalVer ${packageJson.name}@${version}\n`);
