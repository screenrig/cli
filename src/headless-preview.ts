import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { usageError } from "./problems.js";

/** A local browser, driven over private pipes; no debugging port or installed service. */
export async function withPreviewBrowser<T>(env: NodeJS.Dict<string>, work: (browser: PreviewBrowser) => Promise<T>): Promise<T> {
  const candidates = [env.SCREENRIG_BROWSER, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe")];
  let binary: string | undefined;
  for (const candidate of candidates) if (candidate) { try { await access(candidate); binary = candidate; break; } catch { /* next installed browser */ } }
  if (!binary) throw usageError("Local card previews need Chromium or Chrome. Set SCREENRIG_BROWSER to its executable path.");
  const profile = await mkdtemp(path.join(env.TMPDIR ?? tmpdir(), "screenrig-preview-"));
  const child = spawn(binary, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-dev-shm-usage", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let serial = 0, buffered = "", stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const fail = (): void => { for (const call of pending.values()) call.reject(usageError(`Local preview browser stopped. ${stderr}`)); pending.clear(); };
  child.once("error", fail); child.once("exit", fail);
  (child.stdio[4] as Readable).on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    let end: number;
    while ((end = buffered.indexOf("\0")) >= 0) {
      const frame = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (!frame) continue;
      const answer = JSON.parse(frame);
      const call = pending.get(answer.id);
      if (!call) continue;
      pending.delete(answer.id);
      if (answer.error) call.reject(usageError(`Local preview: ${answer.error.message}`)); else call.resolve(answer.result);
    }
  });
  const call = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(usageError(`Local preview timed out: ${method}`)); }, 30_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    (child.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const browser: PreviewBrowser = {
    async render(url, width, height) {
      const { targetId } = await call("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
      try {
        await call("Page.enable", {}, sessionId);
        await call("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
        await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        await call("Page.navigate", { url }, sessionId);
        const result = await call("Runtime.evaluate", { expression: "new Promise((resolve,reject)=>{const until=Date.now()+20000;function wait(){if(window.previewError)reject(new Error(window.previewError));else if(window.previewReady)resolve(window.previewResult);else if(Date.now()>until)reject(new Error('Card did not render'));else setTimeout(wait,20)}wait()})", awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw usageError(`Card preview failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
        const image = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
        return { png: Buffer.from(image.data, "base64"), result: result.result.value };
      } finally { await call("Target.closeTarget", { targetId }).catch(() => undefined); }
    },
  };
  try { return await work(browser); }
  finally {
    // Stop and reap every Chromium child even after a render, navigation or pipe error.
    if (child.pid) { try { if (process.platform === "win32") child.kill(); else process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
    await closed;
    await rm(profile, { recursive: true, force: true });
  }
}

export interface PreviewBrowser {
  render(url: string, width: number, height: number): Promise<{ png: Buffer; result: any }>;
}
