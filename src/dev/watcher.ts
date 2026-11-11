import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { isBuiltinIgnored } from "../pack/paths.js";

export interface WatchHandle {
  close(): void;
  /** How changes are noticed: the platform's file events, or a poll when they are unavailable. */
  readonly mode: "events" | "poll";
}

export interface WatchOptions {
  debounceMs?: number;
  pollMs?: number;
  /** Absolute paths whose changes are not the application's (the K/V file). */
  ignore?: (absolute: string) => boolean;
  onWarning?: (message: string) => void;
}

/**
 * Calls `onChange` once after a burst of changes to the application's files has
 * been quiet for `debounceMs`. A change to a file the packer never reads
 * (dot directories, vendor, key files) is not a change. Where recursive file
 * events fail, the directory is polled instead.
 */
export function watchDirectory(directory: string, onChange: () => void, options: WatchOptions = {}): WatchHandle {
  const debounceMs = options.debounceMs ?? 150;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let watcher: FSWatcher | undefined;
  let closed = false;
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!closed) onChange(); }, debounceMs);
  };
  const startPolling = (reason: string): void => {
    if (poll || closed) return;
    options.onWarning?.(`File events are unavailable (${reason}); checking ${directory} every ${options.pollMs ?? 2000} ms instead.`);
    poll = setInterval(() => { if (!closed) onChange(); }, options.pollMs ?? 2000);
    poll.unref();
  };
  let mode: "events" | "poll" = "events";
  try {
    watcher = watch(directory, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename) {
        const name = filename.toString();
        if (isBuiltinIgnored(name.split(path.sep).join("/"), false)) return;
        if (options.ignore?.(path.resolve(directory, name))) return;
      }
      schedule();
    });
    watcher.on("error", (error) => { watcher?.close(); watcher = undefined; mode = "poll"; startPolling(error.message); });
  } catch (error) {
    mode = "poll";
    startPolling(error instanceof Error ? error.message : String(error));
  }
  return {
    get mode() { return mode; },
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
    },
  };
}
