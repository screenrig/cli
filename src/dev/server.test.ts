import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { CliError } from "../problems.js";
import { testTemp } from "../test-temp.js";
import { assertDevPort, startDevServer, type DevHandle } from "./index.js";
import { harnessCss, harnessHtml, harnessScript } from "./page.js";
import type { LogEntry } from "./session.js";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><p id="x">v1</p></body></html>`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function sample(files: Record<string, string> = { "index.html": PAGE }): Promise<string> {
  const dir = await testTemp("dev-server-");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return dir;
}

async function run<T>(work: (handle: DevHandle, port: number, printed: LogEntry[], dir: string) => Promise<T>, options: { reload?: boolean; files?: Record<string, string> } = {}): Promise<T> {
  const dir = await sample(options.files);
  const port = await freePort();
  const printed: LogEntry[] = [];
  const handle = await startDevServer({ directory: dir, port, allowAnyPort: true, reload: options.reload ?? true, print: (entry) => printed.push(entry) });
  try {
    return await work(handle, port, printed, dir);
  } finally {
    await handle.close();
  }
}

interface Answer { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, host: string, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path ?? "/", headers: { host, ...(options.headers ?? {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

/** An event stream: events as they arrive. */
function stream(port: number, host: string): { events: Array<{ event: string; data: unknown }>; next(name: string, timeoutMs?: number): Promise<{ event: string; data: unknown }>; close(): void } {
  const events: Array<{ event: string; data: unknown }> = [];
  const waiting: Array<() => void> = [];
  let buffer = "";
  const req = http.get({ host: "127.0.0.1", port, path: "/_dev/events", headers: { host } }, (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (name && data) { events.push({ event: name, data: JSON.parse(data) }); for (const wake of waiting.splice(0)) wake(); }
      }
    });
  });
  req.on("error", () => undefined);
  return {
    events,
    async next(name, timeoutMs = 4000) {
      const started = Date.now();
      for (;;) {
        const found = events.findIndex((candidate) => candidate.event === name);
        if (found >= 0) return events.splice(found, 1)[0]!;
        if (Date.now() - started > timeoutMs) throw new Error(`no ${name} event within ${timeoutMs} ms; got ${events.map((event) => event.event).join(", ")}`);
        await new Promise<void>((resolve) => { waiting.push(resolve); setTimeout(resolve, 50); });
      }
    },
    close() { req.destroy(); },
  };
}

const PLAYER = "play.screenrig.localhost";

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  for (const started = Date.now(); !(await check()); ) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

test("one loopback server answers two hosts: the harness on the Player host and the release on its own", async () => {
  await run(async (handle, port) => {
    assert.equal((handle.server.address() as net.AddressInfo).address, "127.0.0.1");
    const page = await request(port, `${PLAYER}:${port}`);
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-type"]), /^text\/html/);
    assert.match(String(page.headers["content-security-policy"]), /^default-src 'none'; script-src 'self'/);
    assert.match(page.body, /<title>screenRIG app dev<\/title>/);
    const app = await request(port, `${handle.releaseHost}:${port}`, { path: "/index.html?kiosk=1" });
    assert.equal(app.status, 200);
    assert.match(app.body, /data-screenrig-sdk="1"/);
    assert.match(app.body, /<p id="x">v1<\/p>/);
    assert.equal(app.headers["x-content-type-options"], "nosniff");
    assert.equal(app.headers["referrer-policy"], "no-referrer");
    assert.match(String(app.headers["content-security-policy"]), new RegExp(`frame-ancestors 'self' http://${PLAYER}:${port}$`));
    const root = await request(port, `${handle.releaseHost}:${port}`);
    assert.equal(root.body, app.body);
    const runtime = await request(port, `${handle.releaseHost}:${port}`, { path: "/_screenrig/runtime.js" });
    assert.equal(runtime.status, 200);
    assert.match(String(runtime.headers["content-type"]), /^text\/javascript/);
    const head = await request(port, `${handle.releaseHost}:${port}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal((await request(port, `${handle.releaseHost}:${port}`, { path: "/missing.png" })).status, 404);
    assert.equal((await request(port, `${handle.releaseHost}:${port}`, { method: "POST" })).status, 405);
    assert.equal((await request(port, `${handle.releaseHost}:${port}`, { path: "/_dev/state" })).status, 404, "the release host never serves the harness's endpoints");
  });
});

test("any other host is refused: a name that resolves to loopback elsewhere cannot read the session", async () => {
  await run(async (_handle, port) => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `evil.example:${port}`, `${PLAYER}:${port + 1}`, PLAYER, `r-${"0".repeat(40)}.apps.screenrig.localhost:${port}`, `${PLAYER}.evil.example:${port}`]) {
      const answer = await request(port, host, { path: "/_dev/state" });
      assert.equal(answer.status, 421, host);
      assert.match(answer.body, new RegExp(`${PLAYER}:${port}`));
    }
  });
});

test("only the harness page may send commands: no Origin, another site and the application itself are refused", async () => {
  await run(async (handle, port) => {
    const body = JSON.stringify({ command: "clear-log" });
    const json = { "content-type": "application/json" };
    const player = `http://${PLAYER}:${port}`;
    for (const origin of [undefined, "http://evil.example", `http://${handle.releaseHost}:${port}`, "null"]) {
      const answer = await request(port, `${PLAYER}:${port}`, { method: "POST", path: "/_dev/command", headers: { ...json, ...(origin === undefined ? {} : { origin }) }, body });
      assert.equal(answer.status, 403, String(origin));
    }
    const crossSite = await request(port, `${PLAYER}:${port}`, { method: "POST", path: "/_dev/command", headers: { ...json, origin: player, "sec-fetch-site": "cross-site" }, body });
    assert.equal(crossSite.status, 403);
    const text = await request(port, `${PLAYER}:${port}`, { method: "POST", path: "/_dev/command", headers: { "content-type": "text/plain", origin: player }, body });
    assert.equal(text.status, 415);
    const ok = await request(port, `${PLAYER}:${port}`, { method: "POST", path: "/_dev/command", headers: { ...json, origin: player, "sec-fetch-site": "same-origin" }, body });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, result: {} });
    const bad = await request(port, `${PLAYER}:${port}`, { method: "POST", path: "/_dev/command", headers: { ...json, origin: player }, body: JSON.stringify({ command: "nope" }) });
    assert.equal(bad.status, 400);
    const broken = await request(port, `${PLAYER}:${port}`, { method: "POST", path: "/_dev/command", headers: { ...json, origin: player }, body: "{" });
    assert.equal(broken.status, 400);
    const large = await request(port, `${PLAYER}:${port}`, { method: "POST", path: "/_dev/message", headers: { ...json, origin: player }, body: JSON.stringify({ origin: "x", data: "a".repeat(300_000) }) }).catch(() => ({ status: 413 }));
    assert.equal(large.status, 413);
  });
});

test("the harness page is self-contained: no framework, no CDN, nothing beyond its own server", () => {
  const html = harnessHtml();
  const script = harnessScript();
  const css = harnessCss();
  for (const [name, text] of [["html", html], ["script", script], ["css", css]] as const) {
    assert.doesNotMatch(text, /(?:https?:)?\/\/(?!dev\.invalid)[a-z0-9.-]+\.[a-z]{2,}/i, `${name} names a remote host`);
    assert.doesNotMatch(text, /@import|<link[^>]+href="http|src="http/i, name);
  }
  assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]), ["/_dev/harness.css", "/_dev/harness.js"]);
  assert.doesNotThrow(() => new Script(script), "the page script parses");
  assert.ok(!script.includes("`") && !script.includes("${"));
  assert.match(script, /new EventSource\('\/_dev\/events'\)/);
});

test("the page and its state stream: the state first, then a frame event when the activation restarts", async () => {
  await run(async (_handle, port) => {
    const events = stream(port, `${PLAYER}:${port}`);
    try {
      const first = await events.next("state");
      const state = first.data as { host: { active: boolean; generation: number }; frame_src: string; log: unknown[]; capability_names: string[] };
      assert.equal(state.host.active, false);
      assert.equal(state.capability_names.length, 20);
      assert.match(state.frame_src, /^http:\/\/r-[a-f0-9]{40}\.apps\.screenrig\.localhost:\d+\/index\.html$/);
      assert.ok(state.log.some((entry) => (entry as { type: string }).type === "release.built"));
      const answer = await request(port, `${PLAYER}:${port}`, { method: "POST", path: "/_dev/command", headers: { "content-type": "application/json", origin: `http://${PLAYER}:${port}` }, body: JSON.stringify({ command: "restart" }) });
      assert.equal(answer.status, 200);
      const frame = await events.next("frame");
      assert.equal((frame.data as { action: string }).action, "restart");
      assert.equal((frame.data as { allow: string }).allow, "autoplay; fullscreen; clipboard-read; clipboard-write; camera; microphone", "hdmi input is granted, so the frame may use the camera");
    } finally {
      events.close();
    }
  });
});

test("a change to a file rebuilds the release and tells the page to reload the frame", async () => {
  await run(async (handle, port, printed, dir) => {
    const events = stream(port, `${PLAYER}:${port}`);
    try {
      await events.next("state");
      await writeFile(path.join(dir, "index.html"), PAGE.replace("v1", "v2"));
      const frame = await events.next("frame");
      assert.equal((frame.data as { action: string }).action, "restart");
      const app = await request(port, `${handle.releaseHost}:${port}`);
      assert.match(app.body, /<p id="x">v2<\/p>/);
      assert.ok(printed.some((entry) => entry.type === "release.changed"));
      // Nothing changes when only an ignored file does.
      printed.length = 0;
      await mkdir(path.join(dir, ".screenrig-dev"), { recursive: true });
      await writeFile(path.join(dir, ".screenrig-dev", "kv.json"), "{}");
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(printed.map((entry) => entry.type), []);
    } finally {
      events.close();
    }
  });
});

test("with reload off the page is told the files changed and the frame stays", async () => {
  await run(async (handle, port, _printed, dir) => {
    const events = stream(port, `${PLAYER}:${port}`);
    try {
      await events.next("state");
      await writeFile(path.join(dir, "index.html"), PAGE.replace("v1", "v3"));
      await until(async () => (JSON.parse((await request(port, `${PLAYER}:${port}`, { path: "/_dev/state" })).body) as { changed_since_load: boolean }).changed_since_load, "the changed flag");
      assert.equal(events.events.some((event) => event.event === "frame"), false);
      assert.match((await request(port, `${handle.releaseHost}:${port}`)).body, /v3/, "the new files are served for the next load");
    } finally {
      events.close();
    }
  }, { reload: false });
});

test("a refused build is reported on start and on every change, in the terminal and on the page, and the last good build keeps serving", async () => {
  const bad = `<!doctype html>\n<html><body>\n<button onclick="go()">x</button>\n</body></html>`;
  await run(async (handle, port, printed, dir) => {
    // Refused on start: nothing is served yet.
    const refusal = printed.find((entry) => entry.type === "release.refused");
    assert.ok(refusal);
    assert.equal(refusal.code, "inline_event_handler");
    assert.deepEqual([refusal.detail?.file, refusal.detail?.line], ["index.html", 3]);
    assert.equal((await request(port, `${handle.releaseHost}:${port}`)).status, 503);
    const initial = JSON.parse((await request(port, `${PLAYER}:${port}`, { path: "/_dev/state" })).body) as { refusal: { code: string; file: string; line: number } | null; release: unknown };
    assert.deepEqual([initial.refusal?.code, initial.refusal?.file, initial.refusal?.line, initial.release], ["inline_event_handler", "index.html", 3, null]);
    // Fixed: served, refusal cleared.
    await writeFile(path.join(dir, "index.html"), PAGE);
    await until(async () => (await request(port, `${handle.releaseHost}:${port}`)).status === 200, "the fixed build");
    assert.equal((JSON.parse((await request(port, `${PLAYER}:${port}`, { path: "/_dev/state" })).body) as { refusal: unknown }).refusal, null);
    // Broken again: refused on the change, and the good build is still served.
    printed.length = 0;
    await writeFile(path.join(dir, "index.html"), bad.replace("go()", "stop()"));
    await until(() => printed.some((entry) => entry.type === "release.refused"), "the second refusal");
    assert.match((await request(port, `${handle.releaseHost}:${port}`)).body, /<p id="x">v1<\/p>/);
    const state = JSON.parse((await request(port, `${PLAYER}:${port}`, { path: "/_dev/state" })).body) as { refusal: { detail: string }; release: { revision: number } };
    assert.match(state.refusal.detail, /inline event handler attribute 'onclick'/);
    assert.equal(state.release.revision, 1, "a refused build is no new revision");
  }, { files: { "index.html": bad } });
});

test("a port other than 18890 is refused before anything listens", async () => {
  for (const port of [8080, 18880, 0, 65535]) {
    assert.throws(() => assertDevPort(port), (error: unknown) => error instanceof CliError && error.problem.code === "unsupported_port" && /18890/.test(error.problem.detail) && error.exitCode === 2);
  }
  assert.doesNotThrow(() => assertDevPort(18890));
  const dir = await sample();
  await assert.rejects(startDevServer({ directory: dir, port: 8081, reload: true }), (error: unknown) => error instanceof CliError && error.problem.code === "unsupported_port");
  await assert.rejects(request(8081, `${PLAYER}:8081`), { code: "ECONNREFUSED" });
});

test("a port that is taken is a clear usage error, and the first server keeps serving", async () => {
  await run(async (_handle, port) => {
    const dir = await sample();
    await assert.rejects(startDevServer({ directory: dir, port, allowAnyPort: true, reload: true }), (error: unknown) => error instanceof CliError && error.problem.code === "usage_error" && /already in use/.test(error.problem.detail));
    assert.equal((await request(port, `${PLAYER}:${port}`)).status, 200);
  });
});
