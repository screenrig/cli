#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, symlink, writeFile, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const CLI_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI_BIN = join(CLI_ROOT, "dist", "bin.js");
const PUBLIC = join(ROOT, "public");
const RUNS = join(ROOT, "runs");
const EXAMPLES = join(ROOT, "examples");
const PORT = Number(process.env.PORT ?? 4545);
const HOST = process.env.HOST ?? "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".json": "application/json; charset=utf-8",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { "content-type": type, "content-length": buf.length });
  res.end(buf);
}

function sendJson(res, status, value) {
  send(res, status, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8");
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { code: "payload_too_large" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeRunId(id) {
  return typeof id === "string" && /^[0-9A-Za-z_-]{1,80}$/.test(id);
}

function safeFile(name) {
  return typeof name === "string" && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(name) && !name.includes("..");
}

async function listRuns() {
  if (!existsSync(RUNS)) return [];
  const names = (await readdir(RUNS)).sort().reverse();
  const runs = [];
  for (const id of names) {
    try {
      const meta = JSON.parse(await readFile(join(RUNS, id, "meta.json"), "utf8"));
      runs.push(meta);
    } catch {
      // skip incomplete runs
    }
  }
  return runs;
}

async function loadExamples() {
  if (!existsSync(EXAMPLES)) return [];
  const names = (await readdir(EXAMPLES)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
  const examples = [];
  for (const name of names) {
    examples.push({
      id: name.replace(/\.json$/, ""),
      name,
      source: await readFile(join(EXAMPLES, name), "utf8"),
    });
  }
  return examples;
}

async function linkExampleAssets(outDir) {
  const mediaSrc = join(EXAMPLES, "media");
  const mediaDest = join(outDir, "media");
  if (existsSync(mediaSrc) && !existsSync(mediaDest)) {
    await symlink(mediaSrc, mediaDest);
  }
  for (const name of await readdir(EXAMPLES)) {
    if (name.endsWith(".json") || name === "media") continue;
    const src = join(EXAMPLES, name);
    const dest = join(outDir, name);
    try {
      const info = await stat(src);
      if (info.isFile() && !existsSync(dest)) await symlink(src, dest);
    } catch {
      // skip missing extras
    }
  }
}

function envelopeError(envelope) {
  const err = envelope?.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") return err.detail ?? err.title ?? "compose failed";
  return "compose failed";
}

async function runCompose(specPath, outDir) {
  const args = [CLI_BIN, "--json", "compose", "render", specPath, "--output", outDir];
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: EXAMPLES,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180000,
    });
    return { stdout: result.stdout.toString(), status: 0 };
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error
      ? String(error.stdout ?? "")
      : "";
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr ?? "")
      : "";
    const status = error && typeof error === "object" && "code" in error && typeof error.code === "number"
      ? error.code
      : 1;
    return { stdout, stderr, status };
  }
}

async function handleGenerate(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    sendJson(res, 400, { ok: false, error: "JSON body required" });
    return;
  }
  const source = typeof payload.input === "string" ? payload.input : "";
  if (!source.trim()) {
    sendJson(res, 400, { ok: false, error: "input is empty" });
    return;
  }
  if (!existsSync(CLI_BIN)) {
    sendJson(res, 500, { ok: false, error: "CLI is not built. Run npm run build at the CLI root, then node server.mjs from tools/compositor." });
    return;
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outDir = join(RUNS, id);
  try {
    await mkdir(outDir, { recursive: true });
    const specPath = join(outDir, "input.json");
    await writeFile(specPath, source);
    await linkExampleAssets(outDir);
    const { stdout, stderr, status } = await runCompose(specPath, outDir);
    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      const message = stderr.trim() || stdout.trim() || `compose render exited ${status}`;
      sendJson(res, 400, { ok: false, error: message });
      return;
    }
    if (!envelope || envelope.ok !== true) {
      sendJson(res, 400, { ok: false, error: envelopeError(envelope) });
      return;
    }
    const data = envelope.data ?? {};
    const pages = (Array.isArray(data.pages) ? data.pages : []).map((page) => ({
      id: page.id,
      manifest: page.manifest,
      images: page.images,
    }));
    const meta = {
      id,
      created: new Date().toISOString(),
      combined: false,
      canvas: data.canvas,
      name: data.name ?? null,
      files: data.files,
      pages,
      images: data.images ?? pages[0]?.images ?? [],
      manifest: data.manifest ?? null,
      input: source,
    };
    await writeFile(join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    sendJson(res, 200, { ok: true, run: meta });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 400, { ok: false, error: message });
  }
}

async function serveStatic(res, filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      send(res, 404, "not found");
      return;
    }
  } catch {
    send(res, 404, "not found");
    return;
  }
  const type = TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  createReadStream(filePath).pipe(res);
}

await mkdir(RUNS, { recursive: true });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      await serveStatic(res, join(PUBLIC, "index.html"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runs") {
      sendJson(res, 200, { ok: true, runs: await listRuns() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/examples") {
      sendJson(res, 200, { ok: true, examples: await loadExamples() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/generate") {
      await handleGenerate(req, res);
      return;
    }
    const runMatch = url.pathname.match(/^\/runs\/([^/]+)\/(.+)$/);
    if (req.method === "GET" && runMatch) {
      const [, id, file] = runMatch;
      if (!safeRunId(id) || !safeFile(file)) {
        send(res, 400, "bad path");
        return;
      }
      await serveStatic(res, join(RUNS, id, file));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const rel = url.pathname.slice("/files/".length);
      if (!safeFile(rel)) {
        send(res, 400, "bad path");
        return;
      }
      await serveStatic(res, join(EXAMPLES, rel));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/")) {
      const name = url.pathname.slice(1);
      if (!safeFile(name) || name.includes("/")) {
        send(res, 404, "not found");
        return;
      }
      await serveStatic(res, join(PUBLIC, name));
      return;
    }
    send(res, 404, "not found");
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : "server error" });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`compositor lab  http://${HOST}:${PORT}/\n`);
});
