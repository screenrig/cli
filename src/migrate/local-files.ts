import { constants } from "node:fs";
import { copyFile, link, lstat, open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { usageError } from "../problems.js";
import { ZipArchive, type ZipEntry } from "./zip.js";

/** One file the person supplied with --files: a path inside the folder or zip, POSIX separators. */
export interface LocalEntry {
  path: string;
  bytes: number;
  /** Set on an entry that cannot be read out; the reason is a sentence for the report. */
  unreadable?: string;
}

/** A folder or .zip of files, read without trusting any name in it. */
export interface LocalFiles {
  /** Base name of the folder or zip, for the default playlist name and the account label. */
  readonly label: string;
  entries(): readonly LocalEntry[];
  /** Entries whose base name equals `filename` (case-insensitive, NFC), and whose size equals `bytes` when both are known. */
  match(filename: string, bytes?: number): LocalEntry[];
  /** The first bytes of an entry, enough to tell what it is. */
  head(entry: LocalEntry, length?: number): Promise<Buffer>;
  /** A whole small entry (a CSV file). */
  read(entry: LocalEntry): Promise<Buffer>;
  /** Puts the entry's bytes at `destination`, which must not exist. */
  extract(entry: LocalEntry, destination: string): Promise<{ bytes: number }>;
}

export function baseName(entryPath: string): string {
  const segments = entryPath.split(/[\\/]/);
  return segments[segments.length - 1] ?? entryPath;
}

function matchKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function indexed(entries: readonly LocalEntry[]): LocalFiles["match"] {
  const byName = new Map<string, LocalEntry[]>();
  for (const entry of entries) {
    const key = matchKey(baseName(entry.path));
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }
  return (filename, bytes) => (byName.get(matchKey(baseName(filename))) ?? [])
    .filter((entry) => bytes === undefined || entry.bytes === bytes);
}

const byPath = (a: LocalEntry, b: LocalEntry): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

async function walk(root: string, relative: string, into: LocalEntry[]): Promise<void> {
  const directory = relative === "" ? root : path.join(root, ...relative.split("/"));
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name.startsWith(".") || item.name === "__MACOSX" || item.isSymbolicLink()) continue;
    const child = relative === "" ? item.name : `${relative}/${item.name}`;
    if (item.isDirectory()) {
      await walk(root, child, into);
    } else if (item.isFile()) {
      into.push({ path: child, bytes: (await lstat(path.join(root, ...child.split("/")))).size });
    }
  }
}

async function folderFiles(root: string): Promise<LocalFiles> {
  const entries: LocalEntry[] = [];
  await walk(root, "", entries);
  entries.sort(byPath);
  const real = (entry: LocalEntry): string => path.join(root, ...entry.path.split("/"));
  return {
    label: path.basename(path.resolve(root)),
    entries: () => entries,
    match: indexed(entries),
    async head(entry, length = 64) {
      const handle = await open(real(entry), "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    read: (entry) => readFile(real(entry)),
    async extract(entry, destination) {
      // A hard link keeps a large folder from being copied twice; another device or filesystem copies.
      try {
        await link(real(entry), destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
        await copyFile(real(entry), destination, constants.COPYFILE_EXCL);
      }
      return { bytes: entry.bytes };
    },
  };
}

function zipReason(entry: ZipEntry): string | undefined {
  if (!entry.unreadable) return undefined;
  return entry.unreadable === "encrypted"
    ? "It is encrypted in the zip."
    : `It uses zip compression method ${entry.unreadable.method}, which this CLI cannot read.`;
}

async function zipFiles(file: string): Promise<LocalFiles> {
  const archive = await ZipArchive.open(file);
  const byName = new Map<string, ZipEntry>();
  const entries: LocalEntry[] = archive.entries.map((entry) => {
    const reason = zipReason(entry);
    const local: LocalEntry = { path: entry.name.replaceAll("\\", "/"), bytes: entry.bytes, ...(reason ? { unreadable: reason } : {}) };
    byName.set(local.path, entry);
    return local;
  });
  entries.sort(byPath);
  const raw = (entry: LocalEntry): ZipEntry => {
    const found = byName.get(entry.path);
    if (!found) throw usageError("That file is not in the zip.");
    return found;
  };
  return {
    label: path.basename(file).replace(/\.zip$/i, ""),
    entries: () => entries,
    match: indexed(entries),
    head: (entry, length) => archive.head(raw(entry), length),
    read: (entry) => archive.read(raw(entry)),
    extract: (entry, destination) => archive.extract(raw(entry), destination),
  };
}

/** A folder, or a .zip, as --files names it. */
export async function openLocalFiles(source: string): Promise<LocalFiles> {
  let info;
  try {
    info = await stat(source);
  } catch {
    throw usageError("--files names a path that does not exist. Give a folder, or a .zip you downloaded.");
  }
  if (info.isDirectory()) return folderFiles(source);
  if (info.isFile()) return zipFiles(source);
  throw usageError("--files must be a folder or a .zip file.");
}
