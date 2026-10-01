import { readFileSync } from "node:fs";

/** Files this package ships in `assets/`. */
export type AssetName = "screenrig.runtime.js" | "playlist-write.schema.json" | "playlist-write-v2.schema.json";

/**
 * Read a packaged asset. The single-file release bundle replaces this module
 * with one that carries the files inline, JSON minified (`scripts/bundle-release.mjs`).
 */
export function readAsset(name: AssetName): Buffer {
  return readFileSync(new URL(`../assets/${name}`, import.meta.url));
}
