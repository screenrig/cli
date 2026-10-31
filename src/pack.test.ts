import assert from "node:assert/strict";
import { mkdir, open, writeFile, readFile, readdir, symlink, link, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DEFAULT_ARCHIVE_LIMITS, walkDirectory, packDirectory, parseTar, gzipDeterministic, hoistInlineAssets } from "./pack/index.js";
import { crc32 } from "./pack/archive.js";
import { gunzipSync } from "node:zlib";
import { createContext, runInContext } from "node:vm";
import { CliError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { ArchiveSdkInjector, SDK_RUNTIME_PATH } from "./adapters/sdk-injection.js";

const fixtures = fileURLToPath(new URL("../fixtures/pack/ok-app", import.meta.url));

async function tempDir(): Promise<string> {
  return testTemp("pack-");
}

test("packs the ok-app fixture deterministically", async () => {
  const a = await packDirectory(fixtures);
  const b = await packDirectory(fixtures);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.compressed_bytes, b.compressed_bytes);
  assert.ok(a.entries.some((entry) => entry.path === "index.html"));
  assert.ok(a.entries.some((entry) => entry.path === "assets/app.css"));
  assert.ok(a.entries.some((entry) => entry.path === "screenrig.json"));
  assert.ok(!a.entries.some((entry) => entry.path.includes("node_modules")));
  assert.ok(!a.entries.some((entry) => entry.path.endsWith(".map")));
  assert.ok(!a.entries.some((entry) => entry.path === "secret.txt"));
  assert.ok(!a.entries.some((entry) => entry.path.includes(".screenrigignore")));
  assert.equal(a.sdk_injection.injected, true);
  assert.ok(a.entries.some((entry) => entry.path === SDK_RUNTIME_PATH));
  const tar = gunzipSync(a.archive);
  const listed = parseTar(tar);
  const names = listed.map((entry) => entry.path);
  const sorted = [...names].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
  assert.deepEqual(names, sorted);
  assert.equal(a.archive[8], 0x02);
  assert.equal(a.archive[9], 0xff);
  assert.equal(a.archive.readUInt32LE(4), 0);
});

test("does not modify the source directory", async () => {
  const before = await readFile(path.join(fixtures, "index.html"));
  await packDirectory(fixtures);
  const after = await readFile(path.join(fixtures, "index.html"));
  assert.deepEqual(before, after);
});

test("packs the pinned runtime with fail-closed production and localhost origin mapping", async () => {
  const runtime = await readFile(fileURLToPath(new URL("../assets/screenrig.runtime.js", import.meta.url)));
  const source = runtime.toString("utf8");
  assert.match(source, /https:\/\/play\.screenrig\.ai/);
  assert.match(source, /http:\/\/play\.screenrig\.localhost:8088/);
  assert.match(source, /r-\[a-f0-9\]\{40\}/);
  assert.doesNotMatch(source, /data-screenrig-player-origin|SCREENRIG_PLAYER_ORIGIN/);

  const injected = await new ArchiveSdkInjector(runtime).inject([
    { path: "index.html", type: "file", data: Buffer.from("<html><head></head></html>"), size: 26 },
  ]);
  const packedRuntime = injected.entries.find((entry) => entry.path === SDK_RUNTIME_PATH);
  const packedIndex = injected.entries.find((entry) => entry.path === "index.html");
  assert.deepEqual(packedRuntime?.data, runtime);
  assert.equal(injected.asset_sha256, createHash("sha256").update(runtime).digest("hex"));
  assert.match(packedIndex?.data?.toString("utf8") ?? "", /<script src="\.\/_screenrig\/runtime\.js" data-screenrig-sdk="1"><\/script>/);
  assert.doesNotMatch(packedIndex?.data?.toString("utf8") ?? "", /<script\b[^>]*\b(?:async|defer)\b[^>]*data-screenrig-sdk/);
});

test("the pinned runtime carries screenrig.skip, so a repacked release can skip its page", async () => {
  const source = (await readFile(fileURLToPath(new URL("../assets/screenrig.runtime.js", import.meta.url)))).toString("utf8");
  assert.match(source, /async skip\(/);
  assert.match(source, /"page\.skip"/);
  assert.match(source, /skip_after_ready/);
});

test("injector rejects duplicate, incompatible, and reserved-path collisions", async () => {
  const injector = new ArchiveSdkInjector(Buffer.from("window.screenrig = {};"));
  const entry = (html: string) => [{ path: "index.html", type: "file" as const, data: Buffer.from(html), size: Buffer.byteLength(html) }];
  await assert.rejects(() => injector.inject(entry('<script src="./_screenrig/runtime.js" data-screenrig-sdk="1"></script><script src="./_screenrig/runtime.js" data-screenrig-sdk="1"></script>')), /more than one/);
  await assert.rejects(() => injector.inject(entry('<script defer src="./_screenrig/runtime.js" data-screenrig-sdk="1"></script>')), /incompatible/);
  await assert.rejects(() => injector.inject(entry('<script defer src="./other.js" data-screenrig-sdk="2"></script>')), /incompatible/);
  await assert.rejects(() => injector.inject([...entry("<html></html>"), { path: SDK_RUNTIME_PATH, type: "file" as const, data: Buffer.alloc(0), size: 0 }]), /reserved/);
});

test("packed applications install the SDK before customer startup scripts", async () => {
  const root = await tempDir();
  const runtime = Buffer.from("window.screenrig = { waitUntilActive: () => Promise.resolve() };");
  const injector = new ArchiveSdkInjector(runtime);
  const boot = "window.startup = { sdk: typeof window.screenrig, waiting: window.screenrig.waitUntilActive() instanceof Promise };";
  const layouts = [
    ["head-classic", '<html><head><script src="./boot.js"></script></head><body></body></html>'],
    ["head-inline", `<html><head><script>${boot}</script></head><body></body></html>`],
    ["body-classic", '<html><head></head><body><script src="./boot.js"></script></body></html>'],
    ["head-deferred", '<html><head><script defer src="./boot.js"></script></head><body></body></html>'],
    ["head-module", '<html><head><script type="module" src="./boot.js"></script></head><body></body></html>'],
    ["head-async", '<html><head><script async src="./boot.js"></script></head><body></body></html>'],
    ["no-head", '<html><script src="./boot.js"></script></html>'],
    ["unclosed-head", '<html><head><script src="./boot.js"></script><body></body></html>'],
  ] as const;
  try {
    for (const [layout, body] of layouts) {
      const directory = path.join(root, layout);
      await mkdir(directory);
      const html = `<!doctype html>${body}`;
      await writeFile(path.join(directory, "index.html"), html);
      await writeFile(path.join(directory, "boot.js"), boot);
      const packed = await packDirectory(directory, { injector });
      assert.equal(packed.sha256, (await packDirectory(directory, { injector })).sha256, layout);
      const tar = gunzipSync(packed.archive);
      let offset = 0;
      const entries = parseTar(tar).map((entry) => {
        const start = offset + 512;
        offset = start + Math.ceil(entry.size / 512) * 512;
        return { ...entry, data: tar.subarray(start, start + entry.size) };
      });
      const packedHtml = entries.find((entry) => entry.path === "index.html")!.data!.toString("utf8");
      assert.ok(packedHtml.startsWith("<!doctype html>"), `${layout}: preserve document mode`);
      const scripts = [...packedHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)];
      assert.equal(scripts.length, 2, layout);
      assert.equal(scripts[0]![1], `./${SDK_RUNTIME_PATH}`, layout);
      // Even an immediately executed customer script can call the installed SDK.
      // Module/deferred scheduling can only delay startup further.
      const window: { startup?: { sdk: string; waiting: boolean } } = {};
      const context = createContext({ window });
      for (const script of scripts) {
        const source = entries.find((entry) => entry.path === script[1]!.replace(/^\.\//, ""))!.data!.toString("utf8");
        runInContext(source, context);
      }
      assert.equal(window.startup?.sdk, "object", layout);
      assert.equal(window.startup?.waiting, true, layout);
      assert.equal(await readFile(path.join(directory, "index.html"), "utf8"), html, layout);
      assert.equal(await readFile(path.join(directory, "boot.js"), "utf8"), boot, layout);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK injection preserves the prologue and inert head metadata", async () => {
  const prefix = '\ufeff<!doctype html><!-- <head><script src="fake.js"></script></head> -->\n'
    + '<HTML lang="en"><HEAD data-label="a > b"><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="script-src &#39;self&#39;">'
    + '<base href="./"><link rel="stylesheet" href="./app.css">'
    + '<title>Literal <script src="fake.js"></script></title>'
    + '<style>/* <script src="fake.js"></script> */</style>'
    + '<noscript><link rel="stylesheet" href="./fallback.css"></noscript>';
  const suffix = '<script src="./boot.js"></script></HEAD><body></body></HTML>';
  const html = prefix + suffix;
  const result = await new ArchiveSdkInjector(Buffer.from("window.screenrig = {};")).inject([
    { path: "index.html", type: "file", data: Buffer.from(html), size: Buffer.byteLength(html) },
  ]);
  const packedHtml = result.entries.find((entry) => entry.path === "index.html")!.data!.toString("utf8");
  assert.equal(packedHtml, `${prefix}<script src="./${SDK_RUNTIME_PATH}" data-screenrig-sdk="1"></script>\n${suffix}`);
});

test("SDK injection leaves a compatible existing marker unchanged", async () => {
  const html = `<!doctype html><html><head><script src="./${SDK_RUNTIME_PATH}" data-screenrig-sdk="1"></script><script src="./boot.js"></script></head></html>`;
  const result = await new ArchiveSdkInjector(Buffer.from("window.screenrig = {};")).inject([
    { path: "index.html", type: "file", data: Buffer.from(html), size: Buffer.byteLength(html) },
  ]);
  assert.equal(result.entries.find((entry) => entry.path === "index.html")!.data!.toString("utf8"), html);
});

test("rejects missing index.html", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "readme.txt"), "nope");
  await assert.rejects(() => packDirectory(dir), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.problem.code, "missing_index");
    return true;
  });
  await rm(dir, { recursive: true, force: true });
});

test("rejects traversal-style names and illegal characters", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "index.html"), "<html></html>");
  const nested = path.join(dir, "ok");
  await mkdir(nested);
  await writeFile(path.join(nested, "x\ny.txt"), "bad");
  await assert.rejects(() => packDirectory(dir), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.problem.code, "path_traversal");
    return true;
  });
  await rm(dir, { recursive: true, force: true });
});

test("rejects symlinks", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "index.html"), "<html></html>");
  await symlink(path.join(dir, "index.html"), path.join(dir, "link.html"));
  await assert.rejects(() => packDirectory(dir), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.problem.code, "symlink_rejected");
    return true;
  });
  await rm(dir, { recursive: true, force: true });
});

test("rejects hardlinks", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "index.html"), "<html></html>");
  await writeFile(path.join(dir, "a.txt"), "hello");
  await link(path.join(dir, "a.txt"), path.join(dir, "b.txt"));
  await assert.rejects(() => packDirectory(dir), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.problem.code, "hardlink_rejected");
    return true;
  });
  await rm(dir, { recursive: true, force: true });
});

test("rejects FIFOs", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "index.html"), "<html></html>");
  const fifo = path.join(dir, "pipe.fifo");
  const result = spawnSync("mkfifo", [fifo]);
  if (result.status !== 0) {
    await rm(dir, { recursive: true, force: true });
    return;
  }
  await assert.rejects(() => packDirectory(dir), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.problem.code, "fifo_rejected");
    return true;
  });
  await rm(dir, { recursive: true, force: true });
});

test("rejects duplicate case-folded names", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "index.html"), "<html></html>");
  await writeFile(path.join(dir, "Readme.txt"), "a");
  await writeFile(path.join(dir, "readme.txt"), "b");
  const names = await readdir(dir);
  if (names.filter((name) => name.toLowerCase() === "readme.txt").length < 2) {
    await rm(dir, { recursive: true, force: true });
    return;
  }
  await assert.rejects(() => packDirectory(dir), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.problem.code, "duplicate_path");
    return true;
  });
  await rm(dir, { recursive: true, force: true });
});

test("rejects files that exceed per-file and depth limits", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "index.html"), "<html></html>");
  await writeFile(path.join(dir, "big.bin"), Buffer.alloc(64));
  await assert.rejects(
    () => packDirectory(dir, { limits: { application_file_bytes: 16 } }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.problem.code, "file_too_large");
      return true;
    },
  );
  const deep = path.join(dir, "a/b/c/d");
  await mkdir(deep, { recursive: true });
  await writeFile(path.join(deep, "x.txt"), "z");
  await assert.rejects(
    () => packDirectory(dir, { limits: { application_path_depth: 2, application_file_bytes: 1024 } }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.problem.code, "path_too_deep");
      return true;
    },
  );
  await rm(dir, { recursive: true, force: true });
});

test("gzip of identical tar bytes is identical", () => {
  const payload = Buffer.from("abc");
  assert.deepEqual(gzipDeterministic(payload), gzipDeterministic(payload));
});

test("CRC-32 matches standard known vectors", () => {
  assert.equal(crc32(Buffer.alloc(0)), 0x00000000);
  assert.equal(crc32(Buffer.from("123456789", "ascii")), 0xcbf43926);
  assert.equal(crc32(Buffer.from("The quick brown fox jumps over the lazy dog", "ascii")), 0x414fa339);
});

test("deterministic gzip writes the payload CRC-32 and size into its trailer", () => {
  const payload = Buffer.from("123456789", "ascii");
  const archive = gzipDeterministic(payload);
  assert.equal(archive.readUInt32LE(archive.length - 8), 0xcbf43926);
  assert.equal(archive.readUInt32LE(archive.length - 4), payload.length);
  assert.deepEqual(gunzipSync(archive), payload);
});

test("sparse files are rejected when detectable", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "index.html"), "<html></html>");
  const sparse = path.join(dir, "sparse.bin");
  const result = spawnSync("truncate", ["-s", "1048576", sparse]);
  if (result.status !== 0) {
    await rm(dir, { recursive: true, force: true });
    return;
  }
  await assert.rejects(() => packDirectory(dir), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.problem.code, "sparse_rejected");
    return true;
  });
  await rm(dir, { recursive: true, force: true });
});


for (const [limit, value, code] of [
  ["application_file_count", 1, "too_many_files"],
  ["application_expanded_bytes", 5, "expanded_too_large"],
] as const) {
  test(`packer enforces ${limit} before reading the rejected file`, async (t) => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "a.txt"), "1234");
    await writeFile(path.join(dir, "index.html"), "5678");
    const handle = await open(path.join(dir, "a.txt"));
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const read = prototype.read;
    const reads = t.mock.method(prototype, "read", read);
    try {
      await assert.rejects(walkDirectory(dir, { ...DEFAULT_ARCHIVE_LIMITS, [limit]: value }),
        (error: unknown) => error instanceof CliError && error.problem.code === code);
      assert.equal(reads.mock.callCount(), 1, "only the admitted first file is read");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

function inlineEntry(path: string, html: string) {
  return { path, type: "file" as const, data: Buffer.from(html, "utf8"), size: Buffer.byteLength(html) };
}

test("hoists inline style and executable script into external files", () => {
  const html = `<!doctype html><html><head><style>body{background:#123}</style></head><body><script>console.log("hi")</script><script type="module">export default 1</script></body></html>`;
  const entries = hoistInlineAssets([inlineEntry("index.html", html)]);
  const rewritten = entries.find((entry) => entry.path === "index.html")!.data!.toString("utf8");
  assert.doesNotMatch(rewritten, /<style>/);
  assert.doesNotMatch(rewritten, /console\.log/);
  assert.doesNotMatch(rewritten, /export default/);
  const link = /<link rel="stylesheet" href="([^"]+)">/.exec(rewritten);
  const classic = /<script src="([^"]+)"><\/script>/.exec(rewritten);
  const module = /<script type="module" src="([^"]+)"><\/script>/.exec(rewritten);
  assert.ok(link && classic && module);
  const content = (href: string) => entries.find((entry) => entry.path === path.posix.normalize(href))!.data!.toString("utf8");
  assert.equal(content(link![1]!), "body{background:#123}");
  assert.equal(content(classic![1]!), 'console.log("hi")');
  assert.equal(content(module![1]!), "export default 1");
  assert.ok(entries.every((entry) => entry.path.startsWith("_screenrig/inline/") || entry.path === "index.html"));
});

for (const artwork of [
  `<svg><style>#tile{fill:rgb(12,34,56);stroke:rgb(90,80,70);opacity:0.6}</style><rect id="tile" width="150" height="70"/></svg>`,
  `<svg><defs><style media="screen">#tile{fill:rgb(12,34,56)}</style></defs><rect id="tile"/></svg>`,
  `<svg><g><g/><style>rect{fill:red}</style><rect/></g></svg>`,
  `<svg><foreignObject><div><svg><style>rect{fill:red}</style><rect/></svg></div></foreignObject></svg>`,
  `<svg><style/><rect/></svg>`,
]) {
  test(`preserves SVG styles and following shapes: ${artwork}`, () => {
    const entry = inlineEntry("index.html", artwork);
    assert.deepEqual(hoistInlineAssets([entry]), [entry]);
  });
}

test("hoists HTML styles across SVG integration points and back into the document", () => {
  const svgStyle = `<style>rect{fill:red}</style>`;
  const htmlStyle = `<style>p{color:blue}</style>`;
  const html = `<svg>${svgStyle}<foreignObject><div><br>${htmlStyle}</div></foreignObject><desc>${htmlStyle}</desc><title>${htmlStyle}</title>${svgStyle}</svg>${htmlStyle}<svg/>${htmlStyle}`;
  const entries = hoistInlineAssets([inlineEntry("index.html", html)]);
  const rewritten = entries.find((entry) => entry.path === "index.html")!.data!.toString("utf8");
  assert.equal(rewritten.split(svgStyle).length - 1, 2);
  assert.ok(!rewritten.includes(htmlStyle));
  assert.equal((rewritten.match(/<link rel="stylesheet"/g) ?? []).length, 5);
  assert.equal(entries.filter((entry) => entry.path.endsWith(".css")).length, 1);
  assert.equal(entries.find((entry) => entry.path.endsWith(".css"))!.data!.toString("utf8"), "p{color:blue}");
});

test("SVG-looking text in comments and HTML raw text does not change style handling", () => {
  const html = `<!-- <svg> --><title><svg></title><textarea><svg></textarea><script type="application/json">"<svg>"</script><style>p{color:red}</style>`;
  const entries = hoistInlineAssets([inlineEntry("index.html", html)]);
  assert.equal(entries.find((entry) => entry.path.endsWith(".css"))!.data!.toString("utf8"), "p{color:red}");
});

test("preserving SVG styles still checks unsafe attributes on following shapes", () => {
  assert.throws(
    () => hoistInlineAssets([inlineEntry("index.html", `<svg><style>rect{fill:red}</style><rect onclick="go()"/></svg>`)]),
    (error: unknown) => error instanceof CliError && error.problem.code === "inline_event_handler",
  );
});

test("packed archives preserve direct and defs SVG styles deterministically", async () => {
  const dir = await tempDir();
  try {
    for (const artwork of [
      `<svg><style>rect{fill:rgb(12,34,56);stroke:rgb(90,80,70);opacity:0.6}</style><rect width="150" height="70"/></svg>`,
      `<svg><defs><style>rect{fill:rgb(12,34,56);stroke:rgb(90,80,70);opacity:0.6}</style></defs><rect width="150" height="70"/></svg>`,
    ]) {
      const html = `<!doctype html><html><head></head><body>${artwork}</body></html>`;
      await writeFile(path.join(dir, "index.html"), html);
      const packed = await packDirectory(dir);
      assert.equal((await packDirectory(dir)).sha256, packed.sha256);
      assert.ok(gunzipSync(packed.archive).toString("utf8").includes(artwork));
      assert.ok(!packed.entries.some((entry) => entry.path.endsWith(".css")));
      assert.equal(await readFile(path.join(dir, "index.html"), "utf8"), html);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [name, attributes] of [
  ["named references", `data-label="R&amp;D &copy; &NotEqualTilde; &unknown;"`],
  ["decimal references", `data-label='Caf&#233; &#128; &#0; &#1114112;'`],
  ["hexadecimal references", `data-label="Caf&#xE9; &#x1F680;"`],
  ["quotes and nested references", `data-label='"quoted" &quot; &apos; &#39; &amp;quot;'`],
  ["unquoted references", `data-label=R&amp;D`],
  ["references without semicolons", `data-label="&copy &amp=raw &notit; &#49"`],
  ["attribute spelling and empty values", `DATA-Label = 'R&amp;D' data-flag data-empty=""`],
] as const) {
  test(`hoisted script preserves ${name} in attributes`, () => {
    const script = "document.body.dataset.label = document.currentScript.dataset.label";
    const entries = hoistInlineAssets([inlineEntry("index.html", `<script ${attributes}>${script}</script>`)]);
    const rewritten = entries.find((entry) => entry.path === "index.html")!.data!.toString("utf8");
    assert.ok(rewritten.startsWith(`<script ${attributes} src="`), rewritten);
    assert.equal(entries.find((entry) => entry.path.endsWith(".js"))!.data!.toString("utf8"), script);
  });
}

for (const media of ["screen and (min-width: &#49;px)", "screen and (width &gt; 1px)"]) {
  test(`hoisted stylesheet preserves media="${media}"`, () => {
    const entries = hoistInlineAssets([inlineEntry("index.html", `<style media="${media}" title='R&amp;D'>p{color:red}</style>`)]);
    const rewritten = entries.find((entry) => entry.path === "index.html")!.data!.toString("utf8");
    assert.match(rewritten, /^<link rel="stylesheet" href="[^"]+"/);
    assert.ok(rewritten.endsWith(` media="${media}" title='R&amp;D'>`), rewritten);
    assert.equal(entries.find((entry) => entry.path.endsWith(".css"))!.data!.toString("utf8"), "p{color:red}");
  });
}

test("hoisted script still removes inline async and defer attributes", () => {
  const entries = hoistInlineAssets([inlineEntry("index.html", `<script ASYNC defer="defer" data-label='R&amp;D'>void 0</script>`)]);
  const rewritten = entries.find((entry) => entry.path === "index.html")!.data!.toString("utf8");
  assert.ok(rewritten.startsWith(`<script data-label='R&amp;D' src="`), rewritten);
  assert.doesNotMatch(rewritten, /async|defer/i);
});

test("packed archive preserves authored script and style attributes deterministically", async () => {
  const dir = await tempDir();
  const html = `<!doctype html><html><head><style media="screen and (min-width: &#49;px)">p{color:red}</style></head><body><script data-label='R&amp;D &quot;Caf&#233;&quot;'>void 0</script><script src="app.js" data-label="R&amp;D"></script></body></html>`;
  await writeFile(path.join(dir, "index.html"), html);
  try {
    const packed = await packDirectory(dir);
    assert.equal((await packDirectory(dir)).sha256, packed.sha256);
    const unpacked = gunzipSync(packed.archive).toString("utf8");
    assert.ok(unpacked.includes(` media="screen and (min-width: &#49;px)">`));
    assert.ok(unpacked.includes(`<script data-label='R&amp;D &quot;Caf&#233;&quot;' src="`));
    assert.ok(unpacked.includes(`<script src="app.js" data-label="R&amp;D"></script>`));
    assert.equal(await readFile(path.join(dir, "index.html"), "utf8"), html);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hoisted assets resolve relative to a nested HTML page", () => {
  const entries = hoistInlineAssets([inlineEntry("pages/board.html", "<style>p{margin:0}</style>")]);
  const rewritten = entries.find((entry) => entry.path === "pages/board.html")!.data!.toString("utf8");
  const href = /<link rel="stylesheet" href="([^"]+)">/.exec(rewritten)![1]!;
  const resolved = path.posix.normalize(path.posix.join("pages", href));
  assert.ok(resolved.startsWith("_screenrig/inline/"));
  assert.equal(entries.find((entry) => entry.path === resolved)!.data!.toString("utf8"), "p{margin:0}");
});

test("leaves external scripts and non-executable script data blocks inline", () => {
  const dataBlock = `<script type="application/json">{"ok":true}</script>`;
  const external = `<script src="./app.js"></script>`;
  const entries = hoistInlineAssets([inlineEntry("index.html", `<head></head><body>${dataBlock}${external}</body>`)]);
  const rewritten = entries.find((entry) => entry.path === "index.html")!.data!.toString("utf8");
  assert.match(rewritten, /<script type="application\/json">\{"ok":true\}<\/script>/);
  assert.match(rewritten, /<script src="\.\/app\.js"><\/script>/);
  assert.equal(entries.length, 1);
});

test("refuses an inline event handler and a javascript: URL with the file and line", () => {
  const handler = `<div>\n  <button onclick="go()">Go</button>\n</div>`;
  assert.throws(
    () => hoistInlineAssets([inlineEntry("pages/board.html", handler)]),
    (error: unknown) => error instanceof CliError && error.problem.code === "inline_event_handler" && /pages\/board\.html:2/.test(error.problem.detail),
  );
  const javascriptUrl = `<a href="jAvAsCrIpT&#58;go()">x</a>`;
  assert.throws(
    () => hoistInlineAssets([inlineEntry("index.html", javascriptUrl)]),
    (error: unknown) => error instanceof CliError && error.problem.code === "javascript_url",
  );
});

test("app pack hoists inline blocks end to end and refuses inline handlers", async () => {
  const hoisted = await tempDir();
  await writeFile(path.join(hoisted, "index.html"), `<!doctype html><html><head><style>h1{color:red}</style></head><body><script>1+1</script></body></html>`);
  try {
    const result = await packDirectory(hoisted);
    assert.ok(result.entries.some((entry) => entry.path.startsWith("_screenrig/inline/") && entry.path.endsWith(".css")));
    assert.ok(result.entries.some((entry) => entry.path.startsWith("_screenrig/inline/") && entry.path.endsWith(".js")));
  } finally {
    await rm(hoisted, { recursive: true, force: true });
  }

  const refused = await tempDir();
  await writeFile(path.join(refused, "index.html"), `<body onload="boot()"></body>`);
  try {
    await assert.rejects(
      () => packDirectory(refused),
      (error: unknown) => error instanceof CliError && error.problem.code === "inline_event_handler",
    );
  } finally {
    await rm(refused, { recursive: true, force: true });
  }
});
