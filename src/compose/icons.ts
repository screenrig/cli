import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";
import { familyRendersText, loadUserFonts } from "./fonts.js";
import { FREE_ICON_CODEPOINTS } from "./icon-free.js";

function usage(message: string): Error {
  return Object.assign(new Error(message), { code: "usage_error" });
}

const ICON_FAMILIES = [
  "Font Awesome 6 Pro",
  "Font Awesome 7 Free",
  "Font Awesome 6 Free",
  "Font Awesome 5 Pro",
  "Font Awesome 6 Brands",
  "Font Awesome 7 Brands",
  "Font Awesome 5 Brands",
] as const;

const ALIASES: Record<string, string> = {
  coffee: "mug-saucer",
};

const STANDARD_STRING_COUNT = 391;

let cachedIndex: Map<string, number> | undefined;

function readU16(buf: Buffer, offset: number): number {
  return buf.readUInt16BE(offset);
}

function readU32(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

function readTag(buf: Buffer, offset: number): string {
  return buf.subarray(offset, offset + 4).toString("ascii");
}

function parseSfnt(buf: Buffer): Record<string, { offset: number; length: number }> {
  const count = readU16(buf, 4);
  const tables: Record<string, { offset: number; length: number }> = {};
  for (let i = 0; i < count; i++) {
    const o = 12 + i * 16;
    tables[readTag(buf, o)] = { offset: readU32(buf, o + 8), length: readU32(buf, o + 12) };
  }
  return tables;
}

function readIndex(buf: Buffer, offset: number): { objects: Buffer[]; end: number } {
  const count = readU16(buf, offset);
  if (count === 0) return { objects: [], end: offset + 2 };
  const offSize = buf[offset + 2]!;
  const offsetsStart = offset + 3;
  const readOff = (i: number): number => {
    let value = 0;
    const p = offsetsStart + i * offSize;
    for (let k = 0; k < offSize; k++) value = (value << 8) | buf[p + k]!;
    return value;
  };
  const offsets: number[] = [];
  for (let i = 0; i <= count; i++) offsets.push(readOff(i));
  const dataStart = offsetsStart + (count + 1) * offSize - 1;
  const objects: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    objects.push(buf.subarray(dataStart + offsets[i]!, dataStart + offsets[i + 1]!));
  }
  return { objects, end: dataStart + offsets[count]! };
}

function parseDict(data: Buffer): Record<number, number[]> {
  const ops: Record<number, number[]> = {};
  let stack: number[] = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i]!;
    if (b <= 21) {
      let op = b;
      i += 1;
      if (b === 12) {
        op = 1200 + data[i]!;
        i += 1;
      }
      ops[op] = stack;
      stack = [];
    } else if (b === 30) {
      i += 1;
      while (i < data.length) {
        const nibble = data[i++]!;
        if ((nibble & 0x0f) === 0x0f || nibble >> 4 === 0x0f) break;
      }
      stack.push(0);
    } else if (b === 28) {
      stack.push(data.readInt16BE(i + 1));
      i += 3;
    } else if (b === 29) {
      stack.push(data.readInt32BE(i + 1));
      i += 5;
    } else if (b >= 32 && b <= 246) {
      stack.push(b - 139);
      i += 1;
    } else if (b >= 247 && b <= 250) {
      stack.push((b - 247) * 256 + data[i + 1]! + 108);
      i += 2;
    } else if (b >= 251 && b <= 254) {
      stack.push(-(b - 251) * 256 - data[i + 1]! - 108);
      i += 2;
    } else {
      i += 1;
    }
  }
  return ops;
}

function sidName(sid: number, strings: Buffer[]): string | undefined {
  if (sid < STANDARD_STRING_COUNT) return undefined;
  const custom = strings[sid - STANDARD_STRING_COUNT];
  return custom?.toString("utf8");
}

function parseCharset(buf: Buffer, offset: number, nGlyphs: number, strings: Buffer[]): Array<string | undefined> {
  const format = buf[offset]!;
  const names: Array<string | undefined> = [".notdef"];
  let p = offset + 1;
  const push = (sid: number): void => {
    names.push(sidName(sid, strings));
  };
  if (format === 0) {
    for (let i = 1; i < nGlyphs; i++) {
      push(readU16(buf, p));
      p += 2;
    }
  } else if (format === 1) {
    while (names.length < nGlyphs) {
      let sid = readU16(buf, p);
      const nLeft = buf[p + 2]!;
      p += 3;
      for (let i = 0; i <= nLeft && names.length < nGlyphs; i++) push(sid++);
    }
  } else if (format === 2) {
    while (names.length < nGlyphs) {
      let sid = readU16(buf, p);
      const nLeft = readU16(buf, p + 2);
      p += 4;
      for (let i = 0; i <= nLeft && names.length < nGlyphs; i++) push(sid++);
    }
  } else {
    return names;
  }
  return names;
}

function parseCmap(buf: Buffer): Map<number, number> {
  const n = readU16(buf, 2);
  const recs: number[] = [];
  for (let i = 0; i < n; i++) recs.push(readU32(buf, 8 + i * 8));
  const map = new Map<number, number>();
  const prefer = (gid: number, code: number): void => {
    const existing = map.get(gid);
    if (existing == null || (code >= 0xe000 && code <= 0xf8ff && !(existing >= 0xe000 && existing <= 0xf8ff))) {
      map.set(gid, code);
    }
  };
  for (const o of recs) {
    const fmt = readU16(buf, o);
    if (fmt === 4) {
      const segCount = readU16(buf, o + 6) / 2;
      const endOff = o + 14;
      const startOff = endOff + 2 + segCount * 2;
      const deltaOff = startOff + segCount * 2;
      const rangeOff = deltaOff + segCount * 2;
      for (let i = 0; i < segCount; i++) {
        const end = readU16(buf, endOff + i * 2);
        const start = readU16(buf, startOff + i * 2);
        const delta = buf.readInt16BE(deltaOff + i * 2);
        const range = readU16(buf, rangeOff + i * 2);
        for (let c = start; c <= end; c++) {
          let gid: number;
          if (range === 0) gid = (c + delta) & 0xffff;
          else {
            const ro = rangeOff + i * 2 + range + (c - start) * 2;
            const g = readU16(buf, ro);
            gid = g === 0 ? 0 : (g + delta) & 0xffff;
          }
          if (gid) prefer(gid, c);
        }
      }
    } else if (fmt === 12) {
      const nGroups = readU32(buf, o + 12);
      for (let i = 0; i < nGroups; i++) {
        const p = o + 16 + i * 12;
        const start = readU32(buf, p);
        const end = readU32(buf, p + 4);
        const startGid = readU32(buf, p + 8);
        for (let c = start; c <= end; c++) prefer(startGid + (c - start), c);
      }
    }
  }
  return map;
}

function extractCffIcons(buf: Buffer): Array<[string, number]> {
  const tables = parseSfnt(buf);
  const cffTable = tables["CFF "];
  const cmapTable = tables.cmap;
  if (!cffTable || !cmapTable) return [];
  const cff = buf.subarray(cffTable.offset, cffTable.offset + cffTable.length);
  let p = cff[2]!;
  const nameIndex = readIndex(cff, p);
  p = nameIndex.end;
  const topDict = readIndex(cff, p);
  p = topDict.end;
  const stringIndex = readIndex(cff, p);
  if (!topDict.objects[0]) return [];
  const dict = parseDict(topDict.objects[0]);
  const charsetOff = dict[15]?.[0];
  const charStringsOff = dict[17]?.[0];
  if (charsetOff == null || charStringsOff == null) return [];
  const nGlyphs = readIndex(cff, charStringsOff).objects.length;
  const names = parseCharset(cff, charsetOff, nGlyphs, stringIndex.objects);
  const cmap = parseCmap(buf.subarray(cmapTable.offset, cmapTable.offset + cmapTable.length));
  const out: Array<[string, number]> = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const cp = cmap.get(i);
    if (!name || !cp || name === ".notdef" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue;
    out.push([name, cp]);
  }
  return out;
}

function fontDirs(): string[] {
  const dirs: string[] = [];
  const dataHome = process.env.XDG_DATA_HOME;
  const userDataDir = dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local", "share");
  dirs.push(join(userDataDir, "fonts"), join(homedir(), ".fonts"));
  return dirs;
}

function parseInstalledIconFonts(): Array<[string, number]> {
  const found: Array<[string, number]> = [];
  for (const dir of fontDirs()) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/\.otf$/i.test(entry) || !/awesome/i.test(entry)) continue;
      try {
        found.push(...extractCffIcons(readFileSync(join(dir, entry))));
      } catch {
        // Skip unreadable or non-CFF Font Awesome files.
      }
    }
  }
  return found;
}

export function iconCodepoints(): Map<string, number> {
  if (cachedIndex) return cachedIndex;
  const index = new Map<string, number>(Object.entries(FREE_ICON_CODEPOINTS));
  for (const [name, cp] of parseInstalledIconFonts()) {
    if (!index.has(name)) index.set(name, cp);
  }
  cachedIndex = index;
  return index;
}

function normalizeIconName(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(/^fa-/, "");
  return ALIASES[stripped] ?? stripped;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    let prev = i;
    row[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cur = row[j + 1]!;
      const cost = a[i] === b[j] ? 0 : 1;
      row[j + 1] = Math.min(cur + 1, row[j]! + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length]!;
}

export function nearestIconNames(name: string, count = 3): string[] {
  const needle = normalizeIconName(name);
  return [...iconCodepoints().keys()]
    .map((candidate) => ({ candidate, distance: levenshtein(needle, candidate) }))
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, count)
    .map((entry) => entry.candidate);
}

export function resolveIconCodepoint(name: string, path: string): number {
  if (typeof name !== "string" || name.length === 0) {
    throw usage(`${path}.name required`);
  }
  const index = iconCodepoints();
  const normalized = normalizeIconName(name);
  const cp = index.get(normalized);
  if (cp != null) return cp;
  const nearest = nearestIconNames(normalized);
  throw usage(`${path}.name unknown icon ${name}. Nearest: ${nearest.join(", ")}`);
}

export function installedIconFamily(): string | undefined {
  loadUserFonts();
  return ICON_FAMILIES.find((family) => GlobalFonts.has(family));
}

export function resolveIconFont(codepoint: number): { family: string; weight: string } {
  loadUserFonts();
  const glyph = String.fromCodePoint(codepoint);
  const families = ICON_FAMILIES.filter((family) => GlobalFonts.has(family));
  if (families.length === 0) {
    throw usage("Font Awesome is not installed. Install Font Awesome Free or Pro, then run compose catalog.");
  }
  for (const family of families) {
    for (const weight of ["900", "400"]) {
      if (familyRendersText(family, glyph, weight)) return { family, weight };
    }
  }
  throw usage("icon glyph is not available in an installed Font Awesome family");
}
