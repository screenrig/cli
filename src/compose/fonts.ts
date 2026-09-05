import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

export const FONT_FALLBACKS = ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans", "Liberation Sans"] as const;
function usage(message: string): Error { return Object.assign(new Error(message), { code: "usage_error" }); }

let userFontsLoaded = false;

export function loadUserFonts(): void {
  // Canvas loads ~/.fonts on Linux, but not the standard XDG user font directory.
  if (!userFontsLoaded && process.platform === "linux" && !process.env.DISABLE_SYSTEM_FONTS_LOAD) {
    const dataHome = process.env.XDG_DATA_HOME;
    const userDataDir = dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local", "share");
    GlobalFonts.loadFontsFromDir(join(userDataDir, "fonts"));
    userFontsLoaded = true;
  }
}

export function resolveFontFamily(name: string | undefined): string {
  loadUserFonts();
  if (name != null && name !== "") {
    if (!GlobalFonts.has(name)) {
      const related = GlobalFonts.families.map((family) => family.family).filter((family) => family.toLowerCase().includes(name.toLowerCase())).slice(0, 5);
      throw usage(`font family not installed: ${name}. ${related.length ? `Installed matches: ${related.join(", ")}.` : "Run compose catalog to choose an installed font family."}`);
    }
    return name;
  }
  for (const family of FONT_FALLBACKS) {
    if (GlobalFonts.has(family)) {
      return family;
    }
  }
  throw usage(
    `none of the fallback fonts were installed: ${FONT_FALLBACKS.join(", ")}`,
  );
}


interface TextFontResolution { family: string; fallback_from?: string; missing_codepoints: string[] }
const glyphCache = new Map<string, string>();
function glyphSignature(character: string, family: string, weight: string): string {
  const key = `${family}\0${weight}\0${character}`;
  const cached = glyphCache.get(key);
  if (cached !== undefined) return cached;
  const canvas = createCanvas(128, 128), ctx = canvas.getContext("2d");
  ctx.font = `${weight} 64px "${family}"`;
  ctx.fillText(character, 8, 88);
  const signature = `${ctx.measureText(character).width}:${createHash("sha256").update(ctx.getImageData(0, 0, 128, 128).data).digest("hex")}`;
  glyphCache.set(key, signature);
  return signature;
}
function missingCharacters(text: string, family: string, weight: string): string[] {
  const missing = glyphSignature("\u{10ffff}", family, weight);
  // Two unassigned sentinels must agree before treating their raster as .notdef.
  if (missing !== glyphSignature("\u{10fffe}", family, weight)) return [];
  return [...new Set([...text])].filter((character) => !/[\p{White_Space}\p{Cf}\p{Mn}\p{Me}]/u.test(character) && glyphSignature(character, family, weight) === missing);
}

/** Napi can silently paint .notdef even with a CSS fallback list. Detect that
 * raster at the requested weight and select a measured fallback for this Text.
 * This is a missing-glyph check, not a promise of language shaping correctness. */
export function resolveTextFont(text: string, family: string, weight: string): TextFontResolution {
  const missing = missingCharacters(text, family, weight);
  if (!missing.length) return { family, missing_codepoints: [] };
  const codepoints = missing.map((character) => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
  const candidates = [...FONT_FALLBACKS, ...GlobalFonts.families.map((entry) => entry.family).filter((name) => /noto|symbol|emoji/i.test(name)).sort()].filter((name) => name !== family && GlobalFonts.has(name));
  for (const candidate of [...new Set(candidates)].slice(0, 16)) {
    if (!missingCharacters(text, candidate, weight).length) return { family: candidate, fallback_from: family, missing_codepoints: codepoints };
  }
  return { family, missing_codepoints: codepoints };
}
