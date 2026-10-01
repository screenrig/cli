import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { Canvas } from "@napi-rs/canvas";
import type { ProblemNext } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { CliError, fileError, makeProblem } from "./problems.js";
import { removeOnSignal, shellQuote, tempPathFor } from "./temp-file.js";

/**
 * The native 2D renderer (`@napi-rs/canvas`) loads only when a command draws.
 * An npm install carries the platform package for this machine. The plugin
 * bundle does not: the first render downloads that one package from the npm
 * registry, checks it against the shipped runtime lock, and caches its binary.
 */
export type CanvasModule = typeof import("@napi-rs/canvas");

export interface RendererPackage {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
}

export interface RendererContext {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  /** The invocation to rerun, without the executable. */
  argv?: readonly string[];
  /** Test seam for the registry download. */
  fetch?: typeof fetch;
}

const RUNTIME_LOCK = new URL("../runtime-dependencies.lock.json", import.meta.url);
const DOWNLOAD_TIMEOUT_MS = 300_000;

let pending: Promise<CanvasModule> | undefined;
let loaded: CanvasModule | undefined;

/** Load the renderer once per process; a failed load can be retried. */
export function loadCanvas(context: RendererContext = {}): Promise<CanvasModule> {
  pending ??= importCanvas(context).then(
    (module) => (loaded = module),
    (error: unknown) => {
      pending = undefined;
      throw error;
    },
  );
  return pending;
}

/** The loaded renderer, for synchronous drawing code that runs after `loadCanvas()`. */
export function canvas(): CanvasModule {
  if (!loaded) throw new Error("The renderer was used before loadCanvas() finished.");
  return loaded;
}

export function createCanvas(width: number, height: number): Canvas {
  return canvas().createCanvas(width, height);
}

export function loadImage(...args: Parameters<CanvasModule["loadImage"]>): ReturnType<CanvasModule["loadImage"]> {
  return canvas().loadImage(...args);
}

export function globalFonts(): CanvasModule["GlobalFonts"] {
  return canvas().GlobalFonts;
}

async function importCanvas(context: RendererContext): Promise<CanvasModule> {
  const triple = rendererTriple(process.platform, process.arch, process.platform === "linux" && isMusl());
  if (!triple || !platformPackageInstalled(`@napi-rs/canvas-${triple}`)) {
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = await cachedRenderer(triple, context);
  }
  return import("@napi-rs/canvas");
}

/** The `@napi-rs/canvas-<triple>` suffix for this machine, named as the package's own loader names it. */
export function rendererTriple(platform: string, arch: string, musl: boolean): string | undefined {
  switch (platform) {
    case "linux":
      if (arch === "arm") return musl ? "linux-arm-musleabihf" : "linux-arm-gnueabihf";
      return `linux-${arch}-${musl ? "musl" : "gnu"}`;
    case "win32":
      return `win32-${arch}-msvc`;
    case "android":
      return arch === "arm" ? "android-arm-eabi" : `android-${arch}`;
    case "darwin":
    case "freebsd":
      return `${platform}-${arch}`;
    default:
      return undefined;
  }
}

function isMusl(): boolean {
  try {
    return readFileSync("/usr/bin/ldd", "utf8").includes("musl");
  } catch {
    // Fall through to the process report, as the package's loader does.
  }
  if (typeof process.report?.getReport !== "function") return false;
  (process.report as { excludeNetwork?: boolean }).excludeNetwork = true;
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] } | undefined;
  if (!report || report.header?.glibcVersionRuntime) return false;
  return (report.sharedObjects ?? []).some((file) => file.includes("libc.musl-") || file.includes("ld-musl-"));
}

function platformPackageInstalled(name: string): boolean {
  try {
    const fromHere = createRequire(import.meta.url);
    createRequire(fromHere.resolve("@napi-rs/canvas")).resolve(name);
    return true;
  } catch {
    return false;
  }
}

/** Per-user cache root: XDG_CACHE_HOME or ~/.cache, ~/Library/Caches on macOS, %LOCALAPPDATA% on Windows. */
export function rendererCacheRoot(env: NodeJS.ProcessEnv, home: string, platform: string = process.platform): string {
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.join(home, "AppData", "Local"), "screenrig");
  }
  if (platform === "darwin") return path.join(home, "Library", "Caches", "screenrig");
  const xdg = env.XDG_CACHE_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".cache"), "screenrig");
}

export function rendererBinaryPath(cacheRoot: string, triple: string, version: string): string {
  return path.join(cacheRoot, `canvas-${triple}-${version}`, `skia.${triple}.node`);
}

async function cachedRenderer(triple: string | undefined, context: RendererContext): Promise<string> {
  const argv = context.argv ?? process.argv.slice(2);
  const entry = triple ? lockedRendererPackage(`@napi-rs/canvas-${triple}`) : undefined;
  if (!triple || !entry) {
    throw rendererError(
      "renderer_unsupported",
      "Renderer unavailable for this machine",
      501,
      triple
        ? `Drawing needs the native renderer @napi-rs/canvas-${triple}, which is not installed, and this CLI has no download record for it.`
        : `Drawing needs the native renderer, which has no build for ${process.platform}-${process.arch}.`,
      "Draw on a machine the renderer supports, such as Linux, macOS or Windows on x64 or arm64, or reinstall the CLI with its optional dependencies. Commands that do not draw work here.",
      false,
      ExitCode.Unexpected,
      rerun(argv, "Run this command again on a machine the renderer supports."),
    );
  }
  const env = context.env ?? process.env;
  const home = (context.homedir ?? osHomedir)();
  const binary = rendererBinaryPath(rendererCacheRoot(env, home), triple, entry.version);
  return installRenderer({ entry, triple, binary, argv, fetch: context.fetch ?? fetch });
}

function lockedRendererPackage(name: string): RendererPackage | undefined {
  let lock: { packages?: unknown };
  try {
    lock = JSON.parse(readFileSync(RUNTIME_LOCK, "utf8")) as { packages?: unknown };
  } catch {
    return undefined;
  }
  const packages = Array.isArray(lock.packages) ? (lock.packages as Array<Partial<RendererPackage>>) : [];
  const entry = packages.find((item) => item?.name === name);
  return entry && typeof entry.version === "string" && typeof entry.resolved === "string" && typeof entry.integrity === "string"
    ? { name, version: entry.version, resolved: entry.resolved, integrity: entry.integrity }
    : undefined;
}

/** Return the cached binary, downloading and verifying it first when it is missing. */
export async function installRenderer(options: {
  entry: RendererPackage;
  triple: string;
  binary: string;
  argv: readonly string[];
  fetch: typeof fetch;
}): Promise<string> {
  const { entry, triple, binary, argv } = options;
  try {
    if ((await stat(binary)).isFile()) return binary;
  } catch {
    // Not cached yet.
  }
  const again = rerun(argv, "Run this command again; the renderer is downloaded once and then cached.");
  let tarball: Buffer;
  try {
    const response = await options.fetch(entry.resolved, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    tarball = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause?.code;
    const reason = `${error instanceof Error ? error.message : String(error)}${typeof cause === "string" ? ` (${cause})` : ""}`;
    throw rendererError(
      "renderer_download_failed",
      "Renderer download failed",
      503,
      `Drawing needs the native renderer for ${triple}, which is not cached yet, and downloading ${entry.name}@${entry.version} from ${entry.resolved} failed: ${reason}.`,
      "The first render on a machine downloads the renderer once from the npm registry (registry.npmjs.org) and caches it. Allow access to that host, then run the command again. Commands that do not draw work without it.",
      true,
      ExitCode.Network,
      again,
    );
  }
  if (!integrityMatches(tarball, entry.integrity)) {
    throw rendererError(
      "renderer_integrity_mismatch",
      "Renderer download failed verification",
      502,
      `The downloaded ${entry.name}@${entry.version} does not match the sha512 integrity this CLI was released with, so it was discarded.`,
      "Something between this machine and registry.npmjs.org changed the download. Fix or bypass that proxy or mirror, then run the command again.",
      false,
      ExitCode.Network,
      again,
    );
  }
  const node = extractTarFile(await promisify(gunzip)(tarball), `package/skia.${triple}.node`);
  if (!node) throw new Error(`${entry.name}@${entry.version} has no package/skia.${triple}.node`);
  const temporary = tempPathFor(binary);
  let release: (() => void) | undefined;
  try {
    await mkdir(path.dirname(binary), { recursive: true });
    release = removeOnSignal(temporary);
    await writeFile(temporary, node, { flag: "wx", mode: 0o755 });
    // A concurrent run may have won the rename; its file has the same bytes.
    await rename(temporary, binary).catch(async (error: unknown) => {
      if (!(await stat(binary).then((info) => info.isFile(), () => false))) throw error;
    });
  } catch (error) {
    const problem = fileError(`Cannot write the renderer cache at ${path.dirname(binary)}`, error);
    problem.problem.next = again;
    throw problem;
  } finally {
    await rm(temporary, { force: true });
    release?.();
  }
  return binary;
}

export function integrityMatches(bytes: Uint8Array, integrity: string): boolean {
  const actual = createHash("sha512").update(bytes).digest("base64");
  return integrity.split(/\s+/).some((value) => value === `sha512-${actual}`);
}

/** Read one regular file from an uncompressed ustar archive (npm package tarballs). */
export function extractTarFile(tar: Uint8Array, name: string): Buffer | undefined {
  const bytes = Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength);
  const field = (offset: number, length: number) => {
    const raw = bytes.subarray(offset, offset + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
  };
  for (let offset = 0; offset + 512 <= bytes.length;) {
    if (bytes.subarray(offset, offset + 512).every((value) => value === 0)) return undefined;
    const size = Number.parseInt(field(offset + 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) return undefined;
    const prefix = field(offset + 257, 6) === "ustar" ? field(offset + 345, 155) : "";
    const entry = prefix ? `${prefix}/${field(offset, 100)}` : field(offset, 100);
    const type = String.fromCharCode(bytes[offset + 156] ?? 0);
    const start = offset + 512;
    if (entry === name && (type === "0" || type === "\0")) {
      return start + size <= bytes.length ? Buffer.from(bytes.subarray(start, start + size)) : undefined;
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

function rerun(argv: readonly string[], reason: string): ProblemNext {
  return { command: `screenrig ${shellQuote(argv)}`, argv: [...argv], reason };
}

function rendererError(
  code: string,
  title: string,
  status: number,
  detail: string,
  hint: string,
  retryable: boolean,
  exitCode: ExitCode,
  next: ProblemNext,
): CliError {
  return new CliError({ ...makeProblem(code, title, status, detail, { hint, next }), retryable }, exitCode);
}
