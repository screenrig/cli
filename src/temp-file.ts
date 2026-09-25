import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

/**
 * A private temp file beside `target`: same directory (so the final rename is
 * atomic), a random suffix, created exclusively (`wx`, 0600) so it never
 * follows or reuses an existing path. Until `release` runs, SIGINT and SIGTERM
 * remove it before the signal's default action.
 */
export interface TempFile {
  path: string;
  handle: FileHandle;
  release: () => void;
}

export function tempPathFor(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(8).toString("hex")}.part`);
}

export function removeOnSignal(file: string): () => void {
  const signals = ["SIGINT", "SIGTERM"] as const;
  let released = false;
  const handler = (signal: NodeJS.Signals) => {
    try { rmSync(file, { force: true }); } catch { /* best effort while exiting */ }
    release();
    // Nobody else handles it: restore the default action (exit by signal).
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const release = () => {
    if (released) return;
    released = true;
    for (const signal of signals) process.removeListener(signal, handler);
  };
  for (const signal of signals) process.on(signal, handler);
  return release;
}

export async function openTempFile(target: string): Promise<TempFile> {
  const file = tempPathFor(target);
  const handle = await open(file, "wx", 0o600);
  return { path: file, handle, release: removeOnSignal(file) };
}

/** POSIX sh single-quoting for a copy-paste command line. */
export function shellQuote(argv: readonly string[]): string {
  return argv.map((arg) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(" ");
}
