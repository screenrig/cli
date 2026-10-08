import path from "node:path";
import type { ConfigFs } from "./config.js";

interface Entry {
  kind: "file" | "dir";
  data: string;
  mode: number;
  mtimeMs: number;
}

function errno(code: string, target: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: ${target}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * A ConfigFs whose paths under `root` live only in this process's memory.
 * Service-client runs keep their config, lock and token here, so nothing is
 * written to disk and the user's config is never read or changed. Paths
 * outside `root` go to `base`.
 */
export function memoryConfigFs(base: ConfigFs, root: string): ConfigFs {
  const entries = new Map<string, Entry>([[root, { kind: "dir", data: "", mode: 0o700, mtimeMs: Date.now() }]]);
  const inside = (target: string) => {
    const resolved = path.resolve(String(target));
    return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
  };
  const children = (dir: string) => [...entries.keys()].filter((key) => key.startsWith(`${dir}${path.sep}`));

  const handle = (target: string, entry: Entry | undefined, writable: boolean) => ({
    readFile: async () => {
      if (!entry || entry.kind !== "file") throw errno("EISDIR", target);
      return entry.data;
    },
    writeFile: async (data: string | Uint8Array) => {
      if (!writable || !entry) throw errno("EBADF", target);
      entry.data = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      entry.mtimeMs = Date.now();
    },
    sync: async () => undefined,
    close: async () => undefined,
  });

  const fs: ConfigFs = {
    ...base,
    mkdir: (async (target: string, options?: { recursive?: boolean; mode?: number }) => {
      const at = inside(target);
      if (!at) return base.mkdir(target, options as never);
      if (entries.has(at)) {
        if (options?.recursive) return undefined;
        throw errno("EEXIST", at);
      }
      if (!entries.has(path.dirname(at)) && !options?.recursive) throw errno("ENOENT", at);
      entries.set(at, { kind: "dir", data: "", mode: options?.mode ?? 0o700, mtimeMs: Date.now() });
      return undefined;
    }) as ConfigFs["mkdir"],
    open: (async (target: string, flags?: string, mode?: number) => {
      const at = inside(target);
      if (!at) return base.open(target, flags as never, mode);
      const existing = entries.get(at);
      if (flags === "w" || flags === "wx") {
        if (flags === "wx" && existing) throw errno("EEXIST", at);
        if (!entries.has(path.dirname(at))) throw errno("ENOENT", at);
        const entry: Entry = { kind: "file", data: "", mode: mode ?? 0o600, mtimeMs: Date.now() };
        entries.set(at, entry);
        return handle(at, entry, true);
      }
      if (!existing) throw errno("ENOENT", at);
      return handle(at, existing, false);
    }) as unknown as ConfigFs["open"],
    rename: (async (from: string, to: string) => {
      const source = inside(from);
      const target = inside(to);
      if (!source && !target) return base.rename(from, to);
      if (!source || !target) throw errno("EXDEV", String(from));
      const entry = entries.get(source);
      if (!entry) throw errno("ENOENT", source);
      for (const child of children(source)) {
        entries.set(target + child.slice(source.length), entries.get(child)!);
        entries.delete(child);
      }
      entries.delete(source);
      entries.set(target, entry);
    }) as ConfigFs["rename"],
    rm: (async (target: string, options?: { recursive?: boolean; force?: boolean }) => {
      const at = inside(target);
      if (!at) return base.rm(target, options);
      if (!entries.has(at)) {
        if (options?.force) return;
        throw errno("ENOENT", at);
      }
      for (const child of children(at)) entries.delete(child);
      entries.delete(at);
    }) as ConfigFs["rm"],
    chmod: (async (target: string, mode: number) => {
      const at = inside(target);
      if (!at) return base.chmod(target, mode);
      const entry = entries.get(at);
      if (!entry) throw errno("ENOENT", at);
      entry.mode = mode;
    }) as ConfigFs["chmod"],
    stat: (async (target: string) => {
      const at = inside(target);
      if (!at) return base.stat(target);
      const entry = entries.get(at);
      if (!entry) throw errno("ENOENT", at);
      return { mode: entry.mode, mtimeMs: entry.mtimeMs, isDirectory: () => entry.kind === "dir", isFile: () => entry.kind === "file", size: entry.data.length };
    }) as unknown as ConfigFs["stat"],
  };
  return fs;
}
