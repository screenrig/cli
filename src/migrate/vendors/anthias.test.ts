import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { testTemp } from "../../test-temp.js";
import { harness, fakeProject } from "../project-fake.test.js";
import type { SourceCatalog } from "../types.js";
import { anthias } from "./anthias.js";
import { bytesOf, fixture, open, problemOf, router, scan, type Recorded } from "./more-helpers.test.js";

const DEVICE = "http://192.168.1.50";
const BASIC = `Basic ${Buffer.from("operator:fixture-password").toString("base64")}`;

/** A device: assets and settings from the fixtures, and the content of any asset in `files`. */
function device(options: { authentication?: boolean; files?: Record<string, Buffer | { url: string }> } = {}) {
  return router(async (request: Recorded) => {
    if (request.url.origin !== DEVICE) return new Response("not here", { status: 404 });
    if (options.authentication && request.headers.authorization !== BASIC) {
      if (request.headers.authorization) return Response.json({ detail: "Invalid username/password." }, { status: 401 });
      // The device redirects a request without credentials to its sign-in page.
      if (request.url.pathname === "/login/") return new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response(null, { status: 302, headers: { location: `/login/?next=${request.url.pathname}` } });
    }
    if (request.url.pathname === "/api/v2/assets") return Response.json(await fixture("anthias", "assets"));
    if (request.url.pathname === "/api/v2/device_settings") return Response.json(await fixture("anthias", "device_settings"));
    const content = /^\/api\/v2\/assets\/([0-9a-f]+)\/content$/.exec(request.url.pathname);
    if (content) {
      const entry = options.files?.[content[1]!];
      if (!entry) return Response.json({ detail: "Not found." }, { status: 404 });
      if ("url" in entry) return Response.json({ type: "url", url: entry.url });
      // The device streams {"type": "file", "filename": ..., "content": "<base64>", "mimetype": ...} in pieces of any size.
      const encoded = entry.toString("base64");
      const text = `{"type": "file", "filename": "poster \\"one\\"", "content": "${encoded}", "mimetype": "image/png"}`;
      const body = Buffer.from(text);
      const pieces = [0, 17, 300, 70_001, 1_000_003].filter((cut) => cut < body.length);
      return new Response(new ReadableStream({
        start(controller) {
          pieces.forEach((cut, index) => controller.enqueue(body.subarray(cut, pieces[index + 1] ?? body.length)));
          controller.close();
        },
      }));
    }
    return new Response("not found", { status: 404 });
  });
}

test("the device becomes one playlist and one waiting screen, exactly as the fixture says", async () => {
  const api = device();
  const catalog = await scan(anthias, api.fetch, { url: DEVICE });
  assert.deepEqual(catalog, await fixture<SourceCatalog>("anthias", "catalog.expected"));
  assert.deepEqual([...new Set(api.requests.map((request) => request.url.pathname))].sort(), ["/api/v2/assets", "/api/v2/device_settings"]);
  assert.ok(api.requests.every((request) => request.headers.authorization === undefined), "no credentials, none sent");
});

test("the address may carry a trailing slash or an API prefix", async () => {
  for (const url of [`${DEVICE}/`, `${DEVICE}/api`, `${DEVICE}/api/v2/`]) {
    const catalog = await scan(anthias, device().fetch, { url });
    assert.equal(catalog.account, DEVICE, url);
    assert.equal(catalog.label, "192.168.1.50");
  }
  assert.equal((await problemOf(scan(anthias, device().fetch, { url: "192.168.1.50" }))).code, "usage_error");
  assert.equal((await problemOf(scan(anthias, device().fetch, { url: "ftp://192.168.1.50" }))).code, "usage_error");
});

test("every reason an asset is listed, and every change an asset's own schedule makes, is the one the fixture expects", async () => {
  const catalog = await scan(anthias, device().fetch, { url: DEVICE });
  assert.deepEqual(catalog.not_imported.map((entry) => [entry.kind, entry.name, entry.reason]), [
    ["item", "Lobby camera", "It is a live stream."],
    ["media", "Switched off", "It is switched off on the device."],
    ["media", "Last winter", "It has passed its end date."],
    ["media", "Remote picture", "It plays from a web address, not from a file on the device."],
    ["media", "Converting", "The device is still processing it."],
    ["media", "Strange", "Its type is not image, video, webpage or streaming."],
  ]);
  assert.deepEqual(catalog.playlists[0]!.notes, [
    "Intro was set to start on 2026-11-15; it now plays at once.",
    "Intro played only on Mon, Tue, Wed, Thu and Fri; it now plays every day.",
    "Intro played only from 09:00 to 17:00; it now plays all day.",
    "3 items had an end date; they now stay in the playlist until you remove them.",
  ]);
  assert.equal(catalog.playlists[0]!.shuffle, true);
  assert.deepEqual(catalog.screens[0]!.timezone, "Europe/Stockholm");
  assert.deepEqual(catalog.playlists[0]!.items.map((item) => ("url" in item ? item.url : "media_id" in item ? item.media_id.slice(-4) : "?")), ["0001", "0002", "https://status.example.com/"]);
});

test("a username without a password, or the other way round, is a usage error", async () => {
  const half: Array<Record<string, string>> = [{ ANTHIAS_USERNAME: "operator" }, { ANTHIAS_PASSWORD: "fixture-password" }];
  for (const credentials of half) {
    const error = await problemOf(scan(anthias, device().fetch, { url: DEVICE, credentials }));
    assert.equal(error.code, "usage_error");
    assert.match(error.detail, /both ANTHIAS_USERNAME and ANTHIAS_PASSWORD, or neither/);
    assert.ok(!error.detail.includes("fixture-password"));
  }
});

test("with authentication on, Basic goes to the device only; without it the sign-in page is a refusal that names the variables", async () => {
  const credentials = { ANTHIAS_USERNAME: "operator", ANTHIAS_PASSWORD: "fixture-password" };
  const signedIn = device({ authentication: true });
  const catalog = await scan(anthias, signedIn.fetch, { url: DEVICE, credentials });
  assert.equal(catalog.media.length, 2);
  assert.ok(signedIn.requests.every((request) => request.headers.authorization === BASIC && request.url.origin === DEVICE));

  const refused = await problemOf(scan(anthias, device({ authentication: true }).fetch, { url: DEVICE }));
  assert.equal(refused.code, "vendor_refused");
  assert.match(refused.detail, /Check ANTHIAS_USERNAME and ANTHIAS_PASSWORD/);

  const wrong = await problemOf(scan(anthias, device({ authentication: true }).fetch, { url: DEVICE, credentials: { ANTHIAS_USERNAME: "operator", ANTHIAS_PASSWORD: "not-it-at-all" } }));
  assert.equal(wrong.code, "vendor_refused");
  assert.ok(!wrong.detail.includes("not-it-at-all") && !wrong.detail.includes("fixture-password"));

  const elsewhere = await problemOf(scan(anthias, router(async () => new Response("<html>hello</html>", { headers: { "content-type": "text/html" } })).fetch, { url: DEVICE, credentials }));
  assert.equal(elsewhere.code, "vendor_bad_response", "with credentials set, an HTML page is not a sign-in refusal");
  assert.equal((await problemOf(scan(anthias, router(async () => new Response("no", { status: 404 })).fetch, { url: DEVICE }))).code, "vendor_not_found");
});

test("a device's file arrives as base64 inside JSON, in any size, and is decoded to the file's own bytes", async () => {
  const small = bytesOf(2_000, 3);
  const large = bytesOf(3 * 1024 * 1024 + 17, 9);
  const catalog = await scan(anthias, device().fetch, { url: DEVICE });
  const [poster, intro] = catalog.media;
  const api = device({ files: { [poster!.id]: small, [intro!.id]: large } });
  const session = await open(anthias, api.fetch, { url: DEVICE });
  const dir = await testTemp("anthias-media-");
  try {
    const first = path.join(dir, "poster");
    assert.deepEqual(await session.fetchMedia(poster!, first), { bytes: small.length });
    assert.ok((await readFile(first)).equals(small));
    const second = path.join(dir, "intro");
    assert.deepEqual(await session.fetchMedia(intro!, second), { bytes: large.length });
    assert.ok((await readFile(second)).equals(large));
    assert.deepEqual((await readdir(dir)).sort(), ["intro", "poster"], "the JSON envelope is not left behind");
    assert.equal(api.requests[0]!.url.pathname, `/api/v2/assets/${poster!.id}/content`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a content answer that holds no file, or ends early, fails with vendor_bad_response and leaves nothing behind", async () => {
  const catalog = await scan(anthias, device().fetch, { url: DEVICE });
  const [poster, intro] = catalog.media;
  const dir = await testTemp("anthias-bad-");
  try {
    const url = await open(anthias, device({ files: { [poster!.id]: { url: "https://x.example.com/p.png" } } }).fetch, { url: DEVICE });
    const noFile = await problemOf(url.fetchMedia(poster!, path.join(dir, "a")));
    assert.equal(noFile.code, "vendor_bad_response");
    assert.match(noFile.detail, /holds no file/);
    const cut = router(async () => new Response('{"type": "file", "filename": "x", "content": "QUJDREVG'));
    const early = await problemOf((await open(anthias, cut.fetch, { url: DEVICE })).fetchMedia(intro!, path.join(dir, "b")));
    assert.equal(early.code, "vendor_bad_response");
    assert.match(early.detail, /ended before its file did/);
    const blank = router(async () => Response.json({ detail: "x" }));
    assert.equal((await problemOf((await open(anthias, blank.fetch, { url: DEVICE })).fetchMedia(intro!, path.join(dir, "c")))).code, "vendor_bad_response");
    const missing = await problemOf(url.fetchMedia(intro!, path.join(dir, "d")));
    assert.equal(missing.code, "vendor_not_found");
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate scan --from anthias runs from the command with the credentials in a file, and never prints the password", async () => {
  const configDir = await testTemp("anthias-cfg-");
  const cwd = await testTemp("anthias-cwd-");
  try {
    const project = fakeProject();
    const h = await harness(project, configDir, cwd);
    const api = device({ authentication: true });
    const result = await h.invoke(["migrate", "scan", "--from", "anthias", "--url", DEVICE, "--credentials", await credentialsFile(cwd)], { vendorFetch: api.fetch });
    assert.equal(result.code, 0, result.stdout);
    const report = result.json.data;
    assert.deepEqual(report.found, { media: 2, playlists: 1, layouts: 0, schedules: 0, groups: 0, screens: 1 });
    assert.deepEqual(report.importable, { media: 2, playlists: 1, layouts: 0, schedules: 0, groups: 0, screens: 1 });
    assert.equal(report.not_imported.length, 6);
    assert.ok(report.lossy.some((entry: { change: string }) => entry.change === "It played in random order; it now plays in order."));
    assert.ok(!result.stdout.includes("fixture-password") && !result.stderr.includes("fixture-password"));
    const scan = await readFile(path.join(cwd, "screenrig-migration-anthias", "scan.json"), "utf8");
    assert.ok(!scan.includes("fixture-password"));
    assert.equal(project.transport.calls.length, 0);
    const missing = await h.invoke(["migrate", "scan", "--from", "anthias", "--dir", "missing"], { vendorFetch: api.fetch });
    assert.equal(missing.code, 2);
    assert.match(missing.json.error.detail, /Anthias needs --url/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

async function credentialsFile(directory: string): Promise<string> {
  const file = path.join(directory, "anthias.env");
  await writeFile(file, "# the device operator\nANTHIAS_USERNAME=operator\nANTHIAS_PASSWORD=fixture-password\n", { mode: 0o600 });
  return file;
}
