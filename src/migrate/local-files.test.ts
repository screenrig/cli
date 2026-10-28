import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testTemp } from "../test-temp.js";
import { openLocalFiles } from "./local-files.js";

const SIGNAGE = fileURLToPath(new URL("../../fixtures/migrate/files/signage/", import.meta.url));

test("extracting a file out of a folder leaves the original's inode alone, however many extract it at once", async () => {
  const dir = await testTemp("local-files-");
  try {
    const files = await openLocalFiles(SIGNAGE);
    const entry = files.entries().find((candidate) => candidate.path === "images/welcome.png")!;
    const original = path.join(SIGNAGE, "images", "welcome.png");
    const before = await stat(original);
    const targets = Array.from({ length: 6 }, (_, index) => path.join(dir, `copy-${index}.png`));
    const results = await Promise.all(targets.map((target) => files.extract(entry, target)));
    assert.deepEqual(results.map((result) => result.bytes), targets.map(() => entry.bytes));
    const bytes = await readFile(original);
    for (const target of targets) assert.deepEqual(await readFile(target), bytes);
    // A hard link, or its removal later, would move the original's change time and fail an upload that is reading it.
    const after = await stat(original);
    assert.deepEqual([after.ctimeMs, after.mtimeMs, after.nlink, after.ino], [before.ctimeMs, before.mtimeMs, before.nlink, before.ino]);
    for (const target of targets) assert.notEqual((await stat(target)).ino, before.ino, "each copy is a file of its own");
    await rm(targets[0]!);
    assert.equal((await stat(original)).ctimeMs, before.ctimeMs, "removing a copy does not touch the original either");
    await assert.rejects(files.extract(entry, targets[1]!), { code: "EEXIST" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
