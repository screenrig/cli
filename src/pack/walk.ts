import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { packError } from "./limits.js";
import {
  caseFold,
  compileIgnore,
  hasIllegalChars,
  hasTraversal,
  isBuiltinIgnored,
  pathDepth,
  posixNormalize,
  toPosixRelative,
  utf8Bytes,
} from "./paths.js";
import type { ArchiveEntry } from "./types.js";
import type { ArchiveLimits } from "./types.js";

const FILE_TYPE_NAMES: Record<number, string> = {
  0: "unknown",
};

function fileTypeLabel(stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; isFIFO(): boolean; isSocket(): boolean; isCharacterDevice(): boolean; isBlockDevice(): boolean }): string {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return FILE_TYPE_NAMES[0] ?? "unsupported";
}

function isSparse(stat: { size: number; blocks?: number }): boolean {
  if (typeof stat.blocks !== "number") {
    return false;
  }
  return stat.blocks * 512 < stat.size;
}

export async function loadScreenrigIgnore(root: string): Promise<(posixPath: string, isDir: boolean) => boolean> {
  try {
    const raw = await readFile(path.join(root, ".screenrigignore"), "utf8");
    return compileIgnore(raw.split(/\r?\n/));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return () => false;
    }
    throw err;
  }
}

export async function walkDirectory(root: string, limits: ArchiveLimits): Promise<ArchiveEntry[]> {
  const extraIgnore = await loadScreenrigIgnore(root);
  const entries: ArchiveEntry[] = [];
  const seenNormalized = new Set<string>();
  const seenFolded = new Set<string>();

  async function visit(absolute: string): Promise<void> {
    const relative = toPosixRelative(root, absolute);
    const posixPath = posixNormalize(relative);
    let st;
    try {
      st = await lstat(absolute);
    } catch (err) {
      throw packError(
        "unsupported_entry",
        `Unable to stat ${posixPath || "."}: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }

    const isDir = st.isDirectory();
    if (posixPath) {
      if (hasTraversal(posixPath) || posixPath.startsWith("/") || hasIllegalChars(posixPath)) {
        throw packError("path_traversal", `Rejected path ${posixPath}`);
      }
      if (utf8Bytes(posixPath) > limits.application_path_bytes) {
        throw packError("path_too_long", `Path exceeds ${limits.application_path_bytes} bytes: ${posixPath}`);
      }
      if (pathDepth(posixPath) > limits.application_path_depth) {
        throw packError("path_too_deep", `Path exceeds depth ${limits.application_path_depth}: ${posixPath}`);
      }
      if (isBuiltinIgnored(posixPath, isDir) || extraIgnore(posixPath, isDir)) {
        return;
      }
      if (seenNormalized.has(posixPath)) {
        throw packError("duplicate_path", `Duplicate normalized path: ${posixPath}`);
      }
      const folded = caseFold(posixPath);
      if (seenFolded.has(folded)) {
        throw packError("duplicate_path", `Duplicate case-folded path: ${posixPath}`);
      }
      seenNormalized.add(posixPath);
      seenFolded.add(folded);
    }

    if (st.isSymbolicLink()) {
      throw packError("symlink_rejected", `Symlinks are not allowed: ${posixPath || "."}`);
    }
    if (st.isFIFO()) {
      throw packError("fifo_rejected", `FIFOs are not allowed: ${posixPath || "."}`);
    }
    if (st.isSocket()) {
      throw packError("socket_rejected", `Sockets are not allowed: ${posixPath || "."}`);
    }
    if (st.isCharacterDevice() || st.isBlockDevice()) {
      throw packError("device_rejected", `Device files are not allowed: ${posixPath || "."}`);
    }
    if (!st.isFile() && !st.isDirectory()) {
      throw packError("unsupported_entry", `Unsupported filesystem entry (${fileTypeLabel(st)}): ${posixPath || "."}`);
    }
    if (st.isFile() && st.nlink > 1) {
      throw packError("hardlink_rejected", `Hardlinks are not allowed: ${posixPath || "."}`);
    }
    if (st.isFile() && isSparse(st)) {
      throw packError("sparse_rejected", `Sparse files are not allowed: ${posixPath || "."}`);
    }

    if (st.isDirectory()) {
      if (posixPath) {
        entries.push({ path: posixPath, type: "directory", size: 0 });
      }
      const children = await readdir(absolute);
      children.sort((a, b) => Buffer.compare(Buffer.from(a.normalize("NFC")), Buffer.from(b.normalize("NFC"))));
      for (const child of children) {
        await visit(path.join(absolute, child));
      }
      return;
    }

    if (st.size > limits.application_file_bytes) {
      throw packError(
        "file_too_large",
        `File exceeds ${limits.application_file_bytes} bytes: ${posixPath}`,
      );
    }
    const data = await readFile(absolute);
    if (data.length !== st.size) {
      throw packError("sparse_rejected", `File size changed or is sparse: ${posixPath}`);
    }
    entries.push({ path: posixPath, type: "file", data, size: data.length });
  }

  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw packError("unsupported_entry", "Application source must be a real directory");
  }
  await visit(root);

  const files = entries.filter((entry) => entry.type === "file");
  if (files.length > limits.application_file_count) {
    throw packError(
      "too_many_files",
      `Archive contains ${files.length} files; limit is ${limits.application_file_count}`,
    );
  }
  const expanded = files.reduce((sum, entry) => sum + entry.size, 0);
  if (expanded > limits.application_expanded_bytes) {
    throw packError(
      "expanded_too_large",
      `Expanded size ${expanded} exceeds ${limits.application_expanded_bytes}`,
    );
  }
  if (!files.some((entry) => entry.path === "index.html")) {
    throw packError("missing_index", "Application directory must contain index.html at the archive root");
  }
  return entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
