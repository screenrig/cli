import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  extractTarFile,
  installRenderer,
  integrityMatches,
  rendererBinaryPath,
  rendererCacheRoot,
  rendererTriple,
  type RendererPackage,
} from "./canvas.js";
import { CliError } from "./problems.js";
import { testTemp } from "./test-temp.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A minimal ustar archive: 512-byte headers, octal sizes, zero-block trailer. */
function ustar(entries: Array<{ name: string; body?: Buffer; type?: string; prefix?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write(entry.type ?? "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    if (entry.prefix) header.write(entry.prefix, 345, 155, "utf8");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function sha512(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function rendererTarball(triple: string, binary: Buffer): Buffer {
  return gzipSync(ustar([
    { name: "package/package.json", body: Buffer.from("{}") },
    { name: "package/README.md", body: Buffer.alloc(700, 0x61) },
    { name: `package/skia.${triple}.node`, body: binary },
  ]));
}

function fakeFetch(bytes: Buffer, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(new Uint8Array(bytes));
  }) as typeof fetch;
}

const refuseNetwork = (async () => {
  throw new Error("network must not be used");
}) as typeof fetch;

function lockEntry(triple: string, tarball: Buffer): RendererPackage {
  return {
    name: `@napi-rs/canvas-${triple}`,
    version: "1.0.7",
    resolved: `https://registry.npmjs.org/@napi-rs/canvas-${triple}/-/canvas-${triple}-1.0.7.tgz`,
    integrity: sha512(tarball),
  };
}

test("tar reader returns one regular file by its package path, including ustar prefixes", () => {
  const archive = ustar([
    { name: "package/", type: "5" },
    { name: "package/a.txt", body: Buffer.from("first") },
    { name: "skia.linux-x64-gnu.node", prefix: "package", body: Buffer.alloc(1300, 7) },
  ]);
  assert.deepEqual(extractTarFile(archive, "package/a.txt"), Buffer.from("first"));
  assert.deepEqual(extractTarFile(archive, "package/skia.linux-x64-gnu.node"), Buffer.alloc(1300, 7));
  assert.equal(extractTarFile(archive, "package/missing.node"), undefined);
  assert.equal(extractTarFile(archive, "package/"), undefined);
  // A truncated body is never returned as a short file.
  assert.equal(extractTarFile(archive.subarray(0, 512 * 4), "package/skia.linux-x64-gnu.node"), undefined);
});

test("renderer triple matches every platform package the lock records", async () => {
  assert.equal(rendererTriple("linux", "x64", false), "linux-x64-gnu");
  assert.equal(rendererTriple("linux", "x64", true), "linux-x64-musl");
  assert.equal(rendererTriple("linux", "arm64", true), "linux-arm64-musl");
  assert.equal(rendererTriple("linux", "arm", false), "linux-arm-gnueabihf");
  assert.equal(rendererTriple("darwin", "arm64", false), "darwin-arm64");
  assert.equal(rendererTriple("win32", "x64", false), "win32-x64-msvc");
  assert.equal(rendererTriple("android", "arm64", false), "android-arm64");
  assert.equal(rendererTriple("aix", "ppc64", false), undefined);
  const lock = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<string, { os?: string[]; cpu?: string[]; libc?: string[] }>;
  };
  const platformPackages = Object.entries(lock.packages).filter(([key]) => key.startsWith("node_modules/@napi-rs/canvas-"));
  assert.ok(platformPackages.length >= 10);
  for (const [key, entry] of platformPackages) {
    const triple = rendererTriple(entry.os?.[0] ?? "", entry.cpu?.[0] ?? "", entry.libc?.[0] === "musl");
    assert.equal(`node_modules/@napi-rs/canvas-${triple}`, key);
  }
});

test("renderer cache lives in the per-user cache directory, keyed by package and version", () => {
  assert.equal(rendererCacheRoot({ XDG_CACHE_HOME: "/x/cache" }, "/home/u", "linux"), "/x/cache/screenrig");
  assert.equal(rendererCacheRoot({ XDG_CACHE_HOME: "relative" }, "/home/u", "linux"), "/home/u/.cache/screenrig");
  assert.equal(rendererCacheRoot({}, "/home/u", "linux"), "/home/u/.cache/screenrig");
  assert.equal(rendererCacheRoot({ XDG_CACHE_HOME: "/x/cache" }, "/Users/u", "darwin"), "/Users/u/Library/Caches/screenrig");
  assert.equal(rendererCacheRoot({ LOCALAPPDATA: "/AppData/Local" }, "/home/u", "win32"), "/AppData/Local/screenrig");
  assert.equal(rendererBinaryPath("/c/screenrig", "linux-x64-gnu", "1.0.7"), path.join("/c/screenrig", "canvas-linux-x64-gnu-1.0.7", "skia.linux-x64-gnu.node"));
});

test("first render downloads, verifies and caches the binary; the next one uses the cache", async () => {
  const directory = await testTemp("canvas-cache-");
  try {
    const binary = Buffer.alloc(4096, 3);
    const tarball = rendererTarball("linux-x64-gnu", binary);
    const entry = lockEntry("linux-x64-gnu", tarball);
    const target = rendererBinaryPath(path.join(directory, "screenrig"), "linux-x64-gnu", entry.version);
    const calls: string[] = [];
    const options = { entry, triple: "linux-x64-gnu", binary: target, argv: ["compose", "catalog"] };
    assert.equal(await installRenderer({ ...options, fetch: fakeFetch(tarball, calls) }), target);
    assert.deepEqual(calls, [entry.resolved]);
    assert.deepEqual(await readFile(target), binary);
    assert.deepEqual(await readdir(path.dirname(target)), [path.basename(target)], "no temp file is left behind");
    assert.equal(await installRenderer({ ...options, fetch: refuseNetwork }), target);
    assert.ok(integrityMatches(tarball, `sha1-unused ${entry.integrity}`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a download that differs from the locked integrity is refused and never cached", async () => {
  const directory = await testTemp("canvas-integrity-");
  try {
    const entry = lockEntry("linux-x64-gnu", rendererTarball("linux-x64-gnu", Buffer.alloc(64, 1)));
    const target = rendererBinaryPath(path.join(directory, "screenrig"), "linux-x64-gnu", entry.version);
    const tampered = rendererTarball("linux-x64-gnu", Buffer.alloc(64, 2));
    await assert.rejects(
      installRenderer({ entry, triple: "linux-x64-gnu", binary: target, argv: ["compose", "catalog"], fetch: fakeFetch(tampered, []) }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.problem.code, "renderer_integrity_mismatch");
        assert.equal(error.problem.retryable, false);
        assert.ok(error.problem.hint);
        assert.deepEqual(error.problem.next?.argv, ["compose", "catalog"]);
        return true;
      },
    );
    assert.equal(existsSync(path.dirname(target)), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unreachable registry is a retryable renderer_download_failed that reruns the command", async () => {
  const directory = await testTemp("canvas-offline-");
  try {
    const entry = lockEntry("linux-x64-gnu", Buffer.from("unused"));
    const offline = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as typeof fetch;
    const argv = ["playlist", "preview", "my playlist.json", "--output", "./preview"];
    await assert.rejects(
      installRenderer({ entry, triple: "linux-x64-gnu", binary: path.join(directory, "skia.node"), argv, fetch: offline }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.problem.code, "renderer_download_failed");
        assert.equal(error.problem.retryable, true);
        assert.match(error.problem.detail, /ECONNREFUSED/);
        assert.match(error.problem.hint ?? "", /registry\.npmjs\.org/);
        assert.deepEqual(error.problem.next?.argv, argv);
        assert.equal(error.problem.next?.command, "screenrig playlist preview 'my playlist.json' --output ./preview");
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("only the loader imports the renderer, and only dynamically", async () => {
  const offenders: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.name.endsWith(".js") && !item.name.endsWith(".test.js") && item.name !== "canvas.js") {
        if (/from\s+["']@napi-rs\/canvas["']|import\(["']@napi-rs\/canvas["']\)/.test(await readFile(file, "utf8"))) offenders.push(file);
      }
    }
  };
  await walk(path.join(ROOT, "dist"));
  assert.deepEqual(offenders, []);
});

test("commands that do not draw run without the platform renderer package", { timeout: 60000 }, async () => {
  // Outside this checkout, so node_modules resolution cannot reach the dev install.
  const directory = await mkdtemp(path.join(tmpdir(), "screenrig-no-renderer-"));
  try {
    const packageRoot = path.join(directory, "package");
    await cp(path.join(ROOT, "dist"), path.join(packageRoot, "dist"), { recursive: true });
    await cp(path.join(ROOT, "assets"), path.join(packageRoot, "assets"), { recursive: true });
    await cp(path.join(ROOT, "package.json"), path.join(packageRoot, "package.json"));
    const lock = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { dev?: boolean; version?: string; resolved?: string; integrity?: string }>;
    };
    const runtime = Object.entries(lock.packages).filter(([key, entry]) => key.startsWith("node_modules/") && !entry.dev);
    for (const [key] of runtime) {
      if (key.startsWith("node_modules/@napi-rs/canvas-")) continue;
      await cp(path.join(ROOT, key), path.join(packageRoot, key), { recursive: true });
    }
    // The shipped lock names every platform package; point them at a closed port.
    await writeFile(path.join(packageRoot, "runtime-dependencies.lock.json"), JSON.stringify({
      packages: runtime.map(([key, entry]) => ({
        path: key,
        name: key.slice("node_modules/".length),
        version: entry.version,
        resolved: key.startsWith("node_modules/@napi-rs/canvas-") ? "http://127.0.0.1:9/renderer.tgz" : entry.resolved,
        integrity: entry.integrity,
      })),
    }));
    const probe = createRequire(path.join(packageRoot, "dist", "canvas.js"));
    const triple = rendererTriple(process.platform, process.arch, false);
    assert.throws(() => probe.resolve(`@napi-rs/canvas-${triple}`), "the temp package must not reach a platform renderer package");

    const home = path.join(directory, "home");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      LOCALAPPDATA: path.join(home, "local"),
      SCREENRIG_CONFIG: path.join(home, "missing-config.json"),
    };
    delete env.NODE_PATH;
    delete env.NAPI_RS_NATIVE_LIBRARY_PATH;
    const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(packageRoot, "dist", "bin.js"), ...args], { encoding: "utf8", env, cwd: directory });

    for (const args of [["--json", "version"], ["--json", "doctor"], ["--json", "playlist", "--help"]]) {
      const result = cli(...args);
      assert.equal(result.stderr, "", `${args.join(" ")} stderr`);
      const envelope = JSON.parse(result.stdout) as { ok: boolean };
      assert.equal(envelope.ok, true, `${args.join(" ")}: ${result.stdout}`);
    }
    assert.match(cli("--help").stdout, /compose/);
    assert.equal(existsSync(path.join(home, "cache")), false, "nothing is downloaded or cached without a render");

    const drawing = cli("--json", "compose", "catalog");
    assert.equal(drawing.stderr, "");
    const failure = JSON.parse(drawing.stdout) as { ok: boolean; error: { code: string; retryable?: boolean; next?: { argv?: string[] } } };
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, "renderer_download_failed");
    assert.equal(failure.error.retryable, true);
    assert.deepEqual(failure.error.next?.argv, ["--json", "compose", "catalog"]);
    assert.equal(drawing.status, 10);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
