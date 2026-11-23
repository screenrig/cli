import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { packError, rethrowRule } from "./limits.js";
import { compileIgnore, posixNormalize, toPosixRelative } from "./paths.js";
import { admitPath } from "./release-core.js";
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
  const seen = { normalized: new Set<string>(), folded: new Set<string>() };
  let fileCount = 0;
  let expandedBytes = 0;

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
      let admitted: boolean;
      try {
        admitted = admitPath(posixPath, isDir, limits, seen, extraIgnore);
      } catch (error) {
        rethrowRule(error);
      }
      if (!admitted) {
        return;
      }
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
    if (fileCount >= limits.application_file_count) {
      throw packError("too_many_files", `Archive exceeds the ${limits.application_file_count} file limit at ${posixPath}`);
    }
    if (st.size > limits.application_expanded_bytes - expandedBytes) {
      throw packError("expanded_too_large", `Expanded size exceeds ${limits.application_expanded_bytes} at ${posixPath}`);
    }
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let data: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino ||
          opened.size !== st.size || opened.nlink !== 1 || isSparse(opened)) {
        throw packError("unsupported_entry", `File changed while packing: ${posixPath}`);
      }
      data = Buffer.allocUnsafe(st.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, Math.min(256 * 1024, data.length - offset), offset);
        if (bytesRead === 0) throw packError("unsupported_entry", `File changed while packing: ${posixPath}`);
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
        throw packError("unsupported_entry", `File changed while packing: ${posixPath}`);
      }
    } finally {
      await handle.close();
    }
    fileCount += 1;
    expandedBytes += data.length;
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
