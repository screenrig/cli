import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../src", import.meta.url));

async function sources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

// Parsed flags are keyed by the option's own name, so the revision guard is
// flags["expect-rev"]. A lookup under the old key "if-match" is always undefined
// and would drop the guard from a write without any error.
test("no handler reads the revision guard under the old flag key", async () => {
  const pattern = /flags(?:\[|,\s*)\s*["']if-match["']|requireFlagValue\(\s*args,\s*["']if-match["']|hasOwn\(\s*args\.flags,\s*["']if-match["']/;
  for (const file of await sources(SOURCE)) {
    assert.doesNotMatch(await readFile(file, "utf8"), pattern, path.relative(SOURCE, file));
  }
});
