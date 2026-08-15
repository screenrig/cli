import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("CLI and pack sources never use wildcard postMessage origins", async () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const files = ["commands.ts", "client.ts", "transport/http.ts", "main.ts"];
  for (const relative of files) {
    const text = await readFile(path.join(root, relative), "utf8");
    assert.doesNotMatch(text, /targetOrigin\s*:\s*['"]\*/);
    assert.doesNotMatch(text, /postMessage\([^,]+,\s*['"]\*['"]/);
  }
});
