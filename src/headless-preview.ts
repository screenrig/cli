import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { usageError } from "./problems.js";
import { redactText } from "./redact.js";

const PREVIEW_ORIGIN = "https://screenrig-preview.invalid";
const PREVIEW_CSP = "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'";

export interface PreviewAsset { bytes: Buffer; type: string }

// Browser errors can carry inline data: URIs, which are bulk; collapse them. Credentials are redacted.
function diagnostic(value: string): string {
  return redactText(value.replace(/data:[^\s"'<>]+/g, "[inline resource]")).slice(0, 1000);
}

/** A local browser, driven over private pipes; no debugging port or installed service. */
export async function withPreviewBrowser<T>(env: NodeJS.Dict<string>, work: (browser: PreviewBrowser) => Promise<T>): Promise<T> {
  const candidates = [env.SCREENRIG_BROWSER, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe")];
  let binary: string | undefined;
  for (const candidate of candidates) if (candidate) { try { await access(candidate); binary = candidate; break; } catch { /* next installed browser */ } }
  if (!binary) throw usageError("Local card previews need Chromium or Chrome. Set SCREENRIG_BROWSER to its executable path.");
  const profile = await mkdtemp(path.join(env.TMPDIR ?? tmpdir(), "screenrig-preview-"));
  // Chromium cannot start its own sandbox as root. Other users keep it enabled.
  const rootFlags = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  const child = spawn(binary, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", ...rootFlags, "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const listeners = new Set<(message: any) => void>();
  let serial = 0, buffered = "", stderr = "";
  let stopped: string | undefined;
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const failure = (): Error => usageError(diagnostic(`Local preview browser stopped: ${stopped}. ${stderr}`));
  const fail = (cause: string): void => {
    stopped ??= cause;
    for (const call of pending.values()) call.reject(failure());
    pending.clear();
    for (const listener of listeners) listener({ method: "Browser.stopped" });
  };
  child.once("error", (error) => fail(error.message));
  child.once("close", (code, signal) => fail(signal ? `signal ${signal}` : `exit ${code}`));
  const input = child.stdio[3] as Writable;
  const output = child.stdio[4] as Readable;
  input.on("error", (error) => fail(error.message));
  output.on("error", (error) => fail(error.message));
  output.once("end", () => fail("browser closed its debugging pipe"));
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    let end: number;
    while ((end = buffered.indexOf("\0")) >= 0) {
      const frame = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (!frame) continue;
      let answer: any;
      try { answer = JSON.parse(frame); }
      catch { fail("invalid browser protocol response"); continue; }
      if (answer.method) { for (const listener of listeners) listener(answer); continue; }
      const call = pending.get(answer.id);
      if (!call) continue;
      pending.delete(answer.id);
      if (answer.error) call.reject(usageError(`Local preview: ${answer.error.message}`)); else call.resolve(answer.result);
    }
  });
  const call = (method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<any> => new Promise((resolve, reject) => {
    if (stopped) { reject(failure()); return; }
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(usageError(diagnostic(`Local preview timed out: ${method}. ${stderr}`))); }, timeoutMs);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const browser: PreviewBrowser = {
    async render(html, width, height, assets = new Map()) {
      const { targetId } = await call("Target.createTarget", { url: "about:blank" });
      let sessionId: string | undefined;
      const document: PreviewAsset = { bytes: Buffer.from(html), type: "text/html; charset=utf-8" };
      const loaded = new Set<string>();
      const errors: string[] = [];
      const requests = new Map<string, string>();
      let loadWaiter: (() => void) | undefined;
      let loadTimer: ReturnType<typeof setTimeout> | undefined;
      let rejectDelivery: (error: unknown) => void;
      const deliveryFailure = new Promise<never>((_, reject) => { rejectDelivery = reject; });
      void deliveryFailure.catch(() => undefined);
      const pageCall = (method: string, params: object = {}): Promise<any> => Promise.race([call(method, params, sessionId), deliveryFailure]);
      const remember = (message: string): void => { errors.push(diagnostic(message)); if (errors.length > 8) errors.shift(); };
      const observe = (message: any): void => {
        if (message.method === "Browser.stopped") { loadWaiter?.(); return; }
        if (message.sessionId !== sessionId) return;
        const p = message.params;
        if (message.method === "Fetch.requestPaused") {
          // Fulfill every request through the private pipe. The reserved origin
          // needs neither DNS nor a socket, and external resources never escape.
          const url = new URL(p.request.url);
          const asset = url.origin === PREVIEW_ORIGIN && p.request.method === "GET"
            ? (url.pathname === "/" ? document : assets.get(url.pathname)) : undefined;
          const responseHeaders = [{ name: "Content-Type", value: asset?.type ?? "text/plain" }];
          if (asset === document) responseHeaders.push({ name: "Content-Security-Policy", value: PREVIEW_CSP }, { name: "Cache-Control", value: "no-store" });
          void call("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: asset ? 200 : 404, responseHeaders, body: (asset?.bytes ?? Buffer.alloc(0)).toString("base64") }, sessionId).catch(error => {
            remember(`Preview resource delivery failed: ${error instanceof Error ? error.message : String(error)}`);
            rejectDelivery(error);
          });
        }
        if (message.method === "Page.lifecycleEvent" && p.name === "load") { loaded.add(`${p.frameId}:${p.loaderId}`); loadWaiter?.(); }
        if (message.method === "Runtime.exceptionThrown") remember(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
        if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(p.type)) remember(`Console ${p.type}: ${p.args.map((arg: any) => arg.description ?? (typeof arg.value === "string" ? arg.value : arg.type)).join(" ")}`);
        if (message.method === "Log.entryAdded" && ["error", "warning"].includes(p.entry.level)) remember(`${p.entry.text} ${p.entry.url ?? ""}`);
        if (message.method === "Network.requestWillBeSent") { if (requests.size >= 256) requests.delete(requests.keys().next().value!); requests.set(p.requestId, diagnostic(p.request.url)); }
        if (message.method === "Network.responseReceived" && p.response.status >= 400) remember(`HTTP ${p.response.status}: ${p.response.url}`);
        if (message.method === "Network.loadingFailed") remember(`Resource failed: ${requests.get(p.requestId) ?? p.type}: ${p.errorText}${p.blockedReason ? ` (${p.blockedReason})` : ""}`);
        if (message.method === "Network.loadingFailed" || message.method === "Network.loadingFinished") requests.delete(p.requestId);
      };
      listeners.add(observe);
      try {
        ({ sessionId } = await call("Target.attachToTarget", { targetId, flatten: true }));
        await pageCall("Page.enable");
        await pageCall("Page.setLifecycleEventsEnabled", { enabled: true });
        await pageCall("Runtime.enable");
        await pageCall("Log.enable");
        await pageCall("Network.enable");
        await pageCall("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
        await pageCall("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
        await pageCall("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        await pageCall("Page.bringToFront");
        const navigation = await pageCall("Page.navigate", { url: `${PREVIEW_ORIGIN}/` });
        if (navigation.errorText) throw usageError(`Local preview navigation failed: ${navigation.errorText}`);
        // Page.navigate can answer before the new document and its scripts load.
        // Match its loader so an about:blank load cannot satisfy this wait.
        if (navigation.loaderId) await Promise.race([new Promise<void>((resolve, reject) => {
          loadTimer = setTimeout(() => { loadWaiter = undefined; reject(usageError("Local preview timed out loading the card page.")); }, 30_000);
          loadWaiter = () => {
            if (!stopped && !loaded.has(`${navigation.frameId}:${navigation.loaderId}`)) return;
            clearTimeout(loadTimer); loadWaiter = undefined;
            if (stopped) reject(failure()); else resolve();
          };
          loadWaiter();
        }), deliveryFailure]);
        const result = await pageCall("Runtime.evaluate", { expression: "new Promise((resolve,reject)=>{const until=Date.now()+20000;function wait(){if(window.previewError)reject(new Error(window.previewError));else if(window.previewReady)resolve(window.previewResult);else if(Date.now()>until)reject(new Error('Card did not render'));else setTimeout(wait,20)}wait()})", awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw usageError(`Card preview failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
        const image = await pageCall("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        return { png: Buffer.from(image.data, "base64"), result: result.result.value };
      } catch (error) {
        throw usageError(diagnostic(error instanceof Error ? error.message : String(error)) + (errors.length ? `\nBrowser diagnostics:\n${errors.join("\n")}` : ""));
      } finally {
        clearTimeout(loadTimer); loadWaiter = undefined;
        listeners.delete(observe);
        await call("Target.closeTarget", { targetId }, undefined, 1000).catch(() => undefined);
      }
    },
  };
  try { return await work(browser); }
  finally {
    // Stop and reap every Chromium child even after a render, navigation or pipe error.
    if (child.pid) { try { if (process.platform === "win32") child.kill(); else process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
    await closed;
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export interface PreviewBrowser {
  render(html: string, width: number, height: number, assets?: ReadonlyMap<string, PreviewAsset>): Promise<{ png: Buffer; result: any }>;
}
