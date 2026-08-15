import { spawn } from "node:child_process";

export type OpenUrl = (url: string) => Promise<boolean>;

export const openExternalUrl: OpenUrl = async (url) => {
  const target = new URL(url);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && (target.hostname === "localhost" || target.hostname === "127.0.0.1" || target.hostname.endsWith(".localhost")))) return false;
  const [command, argv] = process.platform === "darwin"
    ? ["open", [target.href]]
    : process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", target.href]]
      : ["xdg-open", [target.href]];
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, argv, { detached: true, stdio: "ignore", shell: false });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
};
