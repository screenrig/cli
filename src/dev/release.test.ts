import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { SDK_RUNTIME_PATH, SDK_SCRIPT_TAG } from "../adapters/sdk-injection.js";
import { readAsset } from "../assets.js";
import { packDirectory } from "../pack/index.js";
import { testTemp } from "../test-temp.js";
import { releaseCsp, harnessCsp } from "./csp.js";
import { appOrigin, isReleaseHost, parseHostHeader, playerOrigin, releaseHostFor } from "./origins.js";
import { buildDevRelease, contentTypeOf, lookupFile } from "./release.js";

async function sample(files: Record<string, string>): Promise<string> {
  const dir = await testTemp("dev-release-");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return dir;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title><style>body{margin:0}</style></head><body><script>window.x = 1;</script></body></html>`;

test("the served release is what app pack packs: the same files, the injected runtime and the hoisted assets", async () => {
  const dir = await sample({ "index.html": PAGE, "js/app.js": "export const a = 1;\n", "img/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" });
  const built = await buildDevRelease(dir, 1);
  assert.ok(built.ok);
  const packed = await packDirectory(dir);
  const served = [...built.release.files.values()].map((file) => ({ path: file.path, size: file.data.length }));
  assert.deepEqual(served, packed.entries.filter((entry) => entry.type === "file").map((entry) => ({ path: entry.path, size: entry.size })));
  assert.equal(built.release.sdk_sha256, packed.sdk_injection.asset_sha256);
  const runtime = built.release.files.get(SDK_RUNTIME_PATH)!;
  assert.ok(runtime.data.equals(readAsset("screenrig.runtime.js")), "the pinned runtime, byte for byte");
  const index = built.release.files.get("index.html")!.data.toString("utf8");
  assert.ok(index.includes(SDK_SCRIPT_TAG), "the runtime script comes first");
  assert.match(index, /<link rel="stylesheet" href="\.\/_screenrig-inline-[a-f0-9]{32}\.css">/);
  assert.match(index, /<script src="\.\/_screenrig-inline-[a-f0-9]{32}\.js"><\/script>/);
  assert.ok(!/<style>|<script>/.test(index), "inline blocks are hoisted into files");
  assert.equal(built.release.file_count, packed.file_count);
  assert.equal(built.release.files.get("js/app.js")!.type, "text/javascript; charset=utf-8");
});

test("an inline event handler or a javascript: URL is refused with its file and line, as app pack refuses it", async () => {
  const handler = await sample({ "index.html": `<!doctype html>\n<html>\n<body>\n<button onclick="go()">go</button>\n</body></html>` });
  const refused = await buildDevRelease(handler, 1);
  assert.ok(!refused.ok);
  assert.equal(refused.refusal.code, "inline_event_handler");
  assert.equal(refused.refusal.file, "index.html");
  assert.equal(refused.refusal.line, 4);
  await assert.rejects(packDirectory(handler), /inline event handler/);
  const url = await sample({ "index.html": `<!doctype html><a href="javascript:alert(1)">x</a>` });
  const second = await buildDevRelease(url, 1);
  assert.ok(!second.ok);
  assert.equal(second.refusal.code, "javascript_url");
  const none = await sample({ "other.html": PAGE });
  const missing = await buildDevRelease(none, 1);
  assert.ok(!missing.ok);
  assert.equal(missing.refusal.code, "missing_index");
  const gone = await buildDevRelease(path.join(handler, "no-such-directory"), 1);
  assert.ok(!gone.ok);
  assert.ok(gone.refusal.detail.length > 0);
});

test("the dot files and the dev K/V directory never ship", async () => {
  const dir = await sample({ "index.html": PAGE, ".screenrig-dev/kv.json": "{}", ".env": "x=1", "node_modules/m/index.js": "1" });
  const built = await buildDevRelease(dir, 1);
  assert.ok(built.ok);
  assert.ok(![...built.release.files.keys()].some((name) => name.startsWith(".") || name.includes("node_modules")));
});

test("a request path names a file; / and a directory serve index.html; nothing escapes the release", async () => {
  const dir = await sample({ "index.html": PAGE, "docs/index.html": PAGE, "docs/readme.txt": "hi", "a b/c.txt": "spaced" });
  const built = await buildDevRelease(dir, 1);
  assert.ok(built.ok);
  const at = (requestPath: string) => lookupFile(built.release, requestPath)?.path;
  assert.equal(at("/"), "index.html");
  assert.equal(at("/index.html"), "index.html");
  assert.equal(at("/docs/"), "docs/index.html");
  assert.equal(at("/docs"), "docs/index.html");
  assert.equal(at("/docs/readme.txt"), "docs/readme.txt");
  assert.equal(at("/a%20b/c.txt"), "a b/c.txt");
  assert.equal(at("/_screenrig/runtime.js"), SDK_RUNTIME_PATH);
  for (const hostile of ["/../etc/passwd", "/docs/../../x", "/%2e%2e/x", "/docs/%2e%2e/%2e%2e/x", "/a%00b", "/docs\\readme.txt", "/%zz", "/missing.txt", "/docs/readme.txt/"]) assert.equal(at(hostile), undefined, hostile);
});

test("content types follow the extension", () => {
  assert.equal(contentTypeOf("a/b.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeOf("x.WOFF2"), "font/woff2");
  assert.equal(contentTypeOf("x.mjs"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeOf("noext"), "application/octet-stream");
});

test("the release host is stable per directory and is the host the runtime trusts", async () => {
  const dir = await sample({ "index.html": PAGE });
  const host = releaseHostFor(dir);
  assert.match(host, /^r-[a-f0-9]{40}\.apps\.screenrig\.localhost$/);
  assert.equal(releaseHostFor(dir), host);
  assert.notEqual(releaseHostFor(`${dir}2`), host);
  assert.ok(isReleaseHost(host));
  assert.equal(isReleaseHost("play.screenrig.localhost"), false);
  assert.equal(playerOrigin(18890), "http://play.screenrig.localhost:18890");
  assert.equal(appOrigin(host, 18890), `http://${host}:18890`);
  assert.deepEqual(parseHostHeader("Play.ScreenRig.localhost:18890"), { hostname: "play.screenrig.localhost", port: "18890" });
  assert.equal(parseHostHeader("a b"), undefined);
  assert.equal(parseHostHeader(undefined), undefined);
});

test("the release policy is the one releases get, naming the Player as the one external ancestor", () => {
  const policy = releaseCsp("http://play.screenrig.localhost:18890");
  assert.equal(createHash("sha256").update(policy).digest("hex").length, 64);
  assert.match(policy, /^default-src 'self' https: http: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http: blob:; style-src 'self' 'unsafe-inline' https: http:;/);
  assert.ok(policy.endsWith("object-src 'none'; base-uri 'self'; form-action 'self' https:; frame-ancestors 'self' http://play.screenrig.localhost:18890"));
  const harness = harnessCsp("http://r-1.apps.screenrig.localhost:18890");
  assert.match(harness, /frame-src http:\/\/r-1\.apps\.screenrig\.localhost:18890;/);
  assert.match(harness, /frame-ancestors 'none'$/);
  assert.match(harness, /default-src 'none'/);
});
