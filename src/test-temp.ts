import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export async function testTemp(prefix: string): Promise<string> {
  const base = path.join(ROOT, ".tmp");
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, prefix));
}
