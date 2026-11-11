import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic } from "../config.js";
import { run } from "../main.js";
import { testTemp } from "../test-temp.js";
import { FakeTransport, memoryBackend } from "../transport/fake.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const configDir = await testTemp("app-dev-");
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const fs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, settings: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_existing_secret",
  }, fs);
  const appDir = path.join(configDir, "app");
  await mkdir(appDir);
  await writeFile(path.join(appDir, "index.html"), "<!doctype html><html><head></head><body>hello</body></html>");
  return { configDir, fs, appDir };
}

async function dev(f: Awaited<ReturnType<typeof fixture>>, argv: string[], transport = new FakeTransport(), between?: () => Promise<void>) {
  let out = "";
  let err = "";
  const stdout = new Writable({ write(chunk, _encoding, callback) { out += chunk; callback(); } });
  const stderr = new Writable({ write(chunk, _encoding, callback) { err += chunk; callback(); } });
  const finished = run({
    argv, settings: f.fs.settings, stdout, stderr, fs: f.fs, homedir: f.fs.homedir, cwd: () => f.configDir, transport,
    now: () => new Date("2026-09-10T00:00:00Z"), sleep: async () => undefined,
  });
  if (between) await between();
  const code = await finished;
  return { code, out, err, lines: out.split("\n").filter(Boolean) };
}

function get(host: string, requestPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: 18890, path: requestPath, headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

test("a port other than 18890 is refused with the reason, before anything listens", async (t) => {
  const f = await fixture(t);
  const refused = await dev(f, ["--json", "app", "dev", f.appDir, "--port", "8080"]);
  assert.equal(refused.code, 2);
  const envelope = JSON.parse(refused.out);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "unsupported_port");
  assert.match(envelope.error.detail, /only on port 18890/);
  assert.match(envelope.error.hint, /without --port/);
  assert.equal(refused.err, "");
  assert.equal(await portFree(8080), true);
});

test("the directory must exist, --kv and --kv-from exclude each other, and --kv-from takes an application id", async (t) => {
  const f = await fixture(t);
  const missing = await dev(f, ["--json", "app", "dev", path.join(f.appDir, "nope")]);
  assert.equal(JSON.parse(missing.out).error.code, "usage_error");
  assert.match(JSON.parse(missing.out).error.detail, /does not exist/);
  const both = await dev(f, ["--json", "app", "dev", f.appDir, "--kv", "a.json", "--kv-from", "app_X"]);
  assert.match(JSON.parse(both.out).error.detail, /at most one of --kv or --kv-from/);
  const bad = await dev(f, ["--json", "app", "dev", f.appDir, "--kv-from", "nonsense"]);
  assert.match(JSON.parse(bad.out).error.detail, /application identifier/);
  const backend = memoryBackend();
  const transport = new FakeTransport()
    .on("GET", "/api/applications/app_NOPE/kv", () => ({ status: 404, headers: { "content-type": "application/problem+json" }, body: { type: "https://screenrig.ai/problems/not-found", title: "Not found", status: 404, code: "not_found", detail: "Application was not found." } }))
    .on("GET", /.*/, (req) => backend.request(req));
  const unreadable = await dev(f, ["--json", "app", "dev", f.appDir, "--kv-from", "app_NOPE"], transport);
  assert.equal(unreadable.code, 2);
  assert.match(JSON.parse(unreadable.out).error.detail, /Cannot read the stored values of app_NOPE: Application was not found/);
});

test("the command starts, announces its URLs first, streams builds and refusals, and stops after --timeout", async (t) => {
  if (!(await portFree(18890))) return t.skip("port 18890 is in use");
  const f = await fixture(t);
  const json = await dev(f, ["app", "dev", f.appDir, "--timeout", "300"], new FakeTransport(), async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const harness = await get("play.screenrig.localhost:18890", "/");
    assert.equal(harness.status, 200);
    assert.match(harness.body, /screenRIG app dev/);
  });
  assert.equal(json.code, 0, json.out + json.err);
  assert.equal(json.err, "");
  const envelopes = json.lines.map((line) => JSON.parse(line));
  assert.ok(envelopes.every((envelope) => envelope.ok === true && Array.isArray(envelope.warnings)));
  assert.equal(envelopes[0].data.event, "started");
  assert.equal(envelopes[0].data.url, "http://play.screenrig.localhost:18890/");
  assert.match(envelopes[0].data.app_url, /^http:\/\/r-[a-f0-9]{40}\.apps\.screenrig\.localhost:18890\/index\.html$/);
  assert.equal(envelopes[0].data.directory, f.appDir);
  assert.deepEqual(envelopes[0].data.kv, { mode: "file", location: path.join(f.appDir, ".screenrig-dev", "kv.json") });
  assert.equal(envelopes[1].data.event, "release.built");
  assert.equal(envelopes.at(-1).data.event, "stopped");
  assert.equal(await portFree(18890), true, "the server is closed when the command ends");

  const human = await dev(f, ["--human", "app", "dev", f.appDir, "--timeout", "200", "--no-reload", "--kv", "state/kv.json"]);
  assert.equal(human.code, 0, human.out + human.err);
  assert.match(human.out, /^screenRIG app dev\n {2}harness {4}http:\/\/play\.screenrig\.localhost:18890\/\n/);
  assert.match(human.out, new RegExp(`stored {5}${path.join(f.configDir, "state", "kv.json").replace(/[\\/.]/g, "\\$&")}`));
  assert.match(human.out, /reload {5}off/);
  assert.match(human.out, /^at=\S+ type=release\.built message="2 files, \d+ bytes" revision=1 file_count=2 expanded_bytes=\d+ sdk_sha256=[a-f0-9]{64}$/m);
});

test("a refused directory is reported on start and the command keeps running to show it on the page", async (t) => {
  if (!(await portFree(18890))) return t.skip("port 18890 is in use");
  const f = await fixture(t);
  await writeFile(path.join(f.appDir, "index.html"), "<!doctype html>\n<body>\n<a href=\"javascript:go()\">x</a>\n</body>");
  const result = await dev(f, ["app", "dev", f.appDir, "--timeout", "250"], new FakeTransport(), async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = JSON.parse((await get("play.screenrig.localhost:18890", "/_dev/state")).body);
    assert.equal(state.refusal.code, "javascript_url");
    assert.equal(state.refusal.line, 3);
  });
  assert.equal(result.code, 0, result.out);
  const refusal = result.lines.map((line) => JSON.parse(line)).find((envelope) => envelope.data.event === "release.refused");
  assert.equal(refusal.data.level, "error");
  assert.equal(refusal.data.code, "javascript_url");
  assert.equal(refusal.data.file, "index.html");
  assert.equal(refusal.data.line, 3);
});

test("--kv-from reads the application's real store through the signed-in CLI and writes nothing", async (t) => {
  if (!(await portFree(18890))) return t.skip("port 18890 is in use");
  const f = await fixture(t);
  const backend = memoryBackend();
  await backend.request({ method: "PUT", path: "/api/applications/app_REAL/kv/greeting", headers: {}, body: { value_base64: "aGVsbG8=", content_type: "text/plain" } });
  const transport = new FakeTransport().on("GET", /.*/, (req) => backend.request(req));
  const result = await dev(f, ["app", "dev", f.appDir, "--kv-from", "app_REAL", "--timeout", "400"], transport, async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const view = JSON.parse((await get("play.screenrig.localhost:18890", "/_dev/kv")).body);
    assert.deepEqual(view.items, [{ key: "greeting", revision: 1, content_type: "text/plain", bytes: 5, preview: "hello" }]);
    assert.deepEqual([view.mode, view.location], ["remote", "app_REAL"]);
  });
  assert.equal(result.code, 0, result.out + result.err);
  const started = JSON.parse(result.lines[0]!).data;
  assert.deepEqual(started.kv, { mode: "remote", location: "app_REAL" });
  assert.deepEqual([...new Set(transport.calls.map((call) => call.method))], ["GET"], "only reads reach the API");
});
