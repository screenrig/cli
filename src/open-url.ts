import { spawn } from "node:child_process";

export type OpenUrl = (url: string) => Promise<boolean>;
export type OpenPath = (filePath: string) => Promise<boolean>;

/** How long an opener may run before it counts as having launched something. */
const OPENER_SETTLE_MS = 2000;

/**
 * Run an opener detached. It counts as opened only when it exits 0, or is
 * still running after a short settle time (a browser it started in place). An
 * opener that cannot start or exits non-zero, as xdg-open does with no
 * desktop, did not open anything, so the caller prints the URL instead.
 */
export function spawnDetached(command: string, argv: string[], settleMs = OPENER_SETTLE_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (opened: boolean) => { if (!settled) { settled = true; resolve(opened); } };
    const child = spawn(command, argv, { detached: true, stdio: "ignore", shell: false });
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    child.once("spawn", () => {
      const timer = setTimeout(() => { child.unref(); finish(true); }, settleMs);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    });
  });
}

/** A Linux or BSD session with neither X11 nor Wayland has no browser to open. */
export function hasDesktop(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export const openExternalUrl: OpenUrl = async (url) => {
  const target = new URL(url);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && (target.hostname === "localhost" || target.hostname === "127.0.0.1" || target.hostname.endsWith(".localhost")))) return false;
  if (!hasDesktop()) return false;
  const [command, argv] = process.platform === "darwin"
    ? ["open", [target.href]]
    : process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", target.href]]
      : ["xdg-open", [target.href]];
  return spawnDetached(command, argv);
};

/** Open a local filesystem path. Refuses a NUL byte. Does not accept URLs. */
export const openLocalPath: OpenPath = async (filePath) => {
  if (filePath.includes("\0")) return false;
  if (!hasDesktop()) return false;
  const [command, argv] = process.platform === "darwin"
    ? ["open", [filePath]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", filePath]]
      : ["xdg-open", [filePath]];
  return spawnDetached(command, argv);
};
