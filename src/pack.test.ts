import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, symlink, link, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { packDirectory, parseTar, gzipDeterministic } from "./pack/index.js";
import { gunzipSync } from "node:zlib";
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

test("injector rejects duplicate, incompatible, and reserved-path collisions", async () => {
  const injector = new ArchiveSdkInjector(Buffer.from("window.screenrig = {};"));
  const entry = (html: string) => [{ path: "index.html", type: "file" as const, data: Buffer.from(html), size: Buffer.byteLength(html) }];
  await assert.rejects(() => injector.inject(entry('<script src="./_screenrig/runtime.js" data-screenrig-sdk="1"></script><script src="./_screenrig/runtime.js" data-screenrig-sdk="1"></script>')), /more than one/);
  await assert.rejects(() => injector.inject(entry('<script defer src="./_screenrig/runtime.js" data-screenrig-sdk="1"></script>')), /incompatible/);
  await assert.rejects(() => injector.inject(entry('<script defer src="./other.js" data-screenrig-sdk="2"></script>')), /incompatible/);
  await assert.rejects(() => injector.inject([...entry("<html></html>"), { path: SDK_RUNTIME_PATH, type: "file" as const, data: Buffer.alloc(0), size: 0 }]), /reserved/);
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
