#!/usr/bin/env node
import { chmod, lstat, lutimes, readdir, utimes } from "node:fs/promises";
import path from "node:path";

const EPOCH = new Date(0);

async function normalize(entry) {
  const metadata = await lstat(entry);
  if (metadata.isSymbolicLink()) {
    await lutimes(entry, EPOCH, EPOCH);
    return;
  }

  if (metadata.isDirectory()) {
    const children = (await readdir(entry)).sort((left, right) => left.localeCompare(right, "en"));
    for (const child of children) {
      await normalize(path.join(entry, child));
    }
    await chmod(entry, 0o755);
  } else if (metadata.isFile()) {
    const executable = (metadata.mode & 0o111) !== 0;
    await chmod(entry, executable ? 0o755 : 0o644);
  } else {
    throw new Error(`${entry}: unsupported release entry type`);
  }
  await utimes(entry, EPOCH, EPOCH);
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error("usage: normalize-release-tree.mjs <package-root>");
  }
  await normalize(path.resolve(process.argv[2]));
}

main().catch((error) => {
  process.stderr.write(`normalize-release-tree: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
