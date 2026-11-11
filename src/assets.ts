import { readFileSync } from "node:fs";

/** Files this package ships in `assets/`. */
export type AssetName = "screenrig.runtime.js" | "screenrig.d.ts" | "playlist-write-v2.schema.json";

/** Read a packaged asset from `../assets/` beside `dist/`. */
export function readAsset(name: AssetName): Buffer {
  return readFileSync(new URL(`../assets/${name}`, import.meta.url));
}
