#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tag = process.argv[2];

if (process.argv.length !== 3 || !tag) {
  throw new Error("usage: check-release-tag.mjs <vMAJOR.MINOR.PATCH>");
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const commands = await readFile(path.join(root, "src", "commands.ts"), "utf8");
const expectedTag = `v${packageJson.version}`;

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`release tag must be stable semantic version ${expectedTag}; received ${tag}`);
}
if (tag !== expectedTag) {
  throw new Error(`release tag ${tag} does not match package version ${packageJson.version}`);
}
if (packageLock.name !== packageJson.name || packageLock.version !== packageJson.version) {
  throw new Error("package-lock.json root name/version differs from package.json");
}
const lockRoot = packageLock.packages?.[""];
if (lockRoot?.name !== packageJson.name || lockRoot?.version !== packageJson.version) {
  throw new Error("package-lock.json package root name/version differs from package.json");
}
if (!commands.includes(`export const CLI_VERSION = "${packageJson.version}";`)) {
  throw new Error("src/commands.ts CLI_VERSION differs from package.json");
}

process.stdout.write(`release tag ${tag} matches ${packageJson.name}@${packageJson.version}\n`);
