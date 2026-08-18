import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, open, rename, chmod, stat, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { parseArgv } from "./argv.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const SCREEN_ID = "scr_PAIRINGAAAAAAAAAAAAAAAA";
const CAPTURE_ID = "shot_AAAAAAAAAAAAAAAA";
const REPLACED_CAPTURE_ID = "shot_BBBBBBBBBBBBBBBB";
const IMAGE_MARK = "PIXELDATA_MUST_NOT_PRINT";
const IMAGE_BYTES = Uint8Array.from(Buffer.from(IMAGE_MARK, "utf8"));
const IMAGE_SHA256 = createHash("sha256").update(IMAGE_BYTES).digest("hex");

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function withRuntime(
  argv: string[],
  transport: FakeTransport,
  extra?: Partial<CliRuntime> & { configDir?: string; cwdDir?: string },
): Promise<{ code: number; stdout: string; stderr: string; configDir: string; cwdDir: string }> {
  const configDir = extra?.configDir ?? await testTemp("screenshot-cfg-");
  const cwdDir = extra?.cwdDir ?? await testTemp("screenshot-cwd-");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const fsLike: ConfigFs = extra?.fs ?? {
    mkdir,
    open,
    rename,
    rm,
    chmod,
    stat,
    homedir: () => configDir,
    env: { XDG_CONFIG_HOME: configDir },
  };
  const runtime: CliRuntime = {
    argv,
    env: extra?.env ?? fsLike.env,
    stdout,
    stderr,
    now: extra?.now ?? (() => new Date("2026-08-14T17:00:00.000Z")),
    sleep: extra?.sleep ?? (async () => undefined),
    homedir: extra?.homedir ?? fsLike.homedir,
    cwd: extra?.cwd ?? (() => cwdDir),
    fs: extra?.fs ?? fsLike,
    transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: await outP, stderr: await errP, configDir, cwdDir };
}

async function enrolledFs(configDir: string): Promise<ConfigFs> {
  const fsLike: ConfigFs = {
    mkdir,
    open,
    rename,
    rm,
    chmod,
    stat,
    homedir: () => configDir,
    env: { XDG_CONFIG_HOME: configDir },
  };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  return fsLike;
}

function readyStatus(captureId = CAPTURE_ID): Record<string, unknown> {
  return {
    state: "ready",
    capture_id: captureId,
    bytes: IMAGE_BYTES.byteLength,
    sha256: IMAGE_SHA256,
    width: 480,
    height: 270,
  };
}

function screenshotTransport(options: {
  statuses: Array<Record<string, unknown>>;
  image?: TransportResponse;
}): FakeTransport {
  const transport = new FakeTransport();
  let statusIndex = 0;
  transport.on("POST", `/api/v1/screens/${SCREEN_ID}/screenshot`, () => ({
    status: 202,
    headers: { "cache-control": "no-store", "x-request-id": "req_screenshot" },
    body: { capture_id: CAPTURE_ID, expires_at: "2026-08-14T17:00:30.000Z" },
  }));
  transport.on("GET", `/api/v1/screens/${SCREEN_ID}/screenshot/status`, () => {
    const body = options.statuses[Math.min(statusIndex, options.statuses.length - 1)] ?? { state: "pending", capture_id: CAPTURE_ID };
    statusIndex += 1;
    return { status: 200, headers: { "cache-control": "no-store" }, body };
  });
  transport.on("GET", `/api/v1/screens/${SCREEN_ID}/screenshot`, () => options.image ?? {
    status: 200,
    headers: {
      "content-type": "image/webp",
      "content-length": String(IMAGE_BYTES.byteLength),
      "cache-control": "private, no-store",
    },
    body: IMAGE_BYTES,
  });
  return transport;
}

function screenshotCalls(transport: FakeTransport): TransportRequest[] {
  return transport.calls.filter((call) => String(call.path).includes("/screenshot"));
}

test("parseArgv keeps screen screenshot id and --output as a file path", () => {
  const missing = parseArgv(["screen", "screenshot"]);
  assert.deepEqual(missing.command, ["screen", "screenshot"]);
  assert.equal(missing.positionals[2], undefined);
  assert.equal(missing.flags.output, undefined);

  const defaults = parseArgv(["screen", "screenshot", SCREEN_ID]);
  assert.equal(defaults.positionals[2], SCREEN_ID);
  assert.equal(defaults.flags.output, undefined);

  const custom = parseArgv(["screen", "screenshot", SCREEN_ID, "--output", "lobby.webp"]);
  assert.equal(custom.flags.output, "lobby.webp");
});

test("screen screenshot requires a screen id before calling the server", async () => {
  const transport = screenshotTransport({ statuses: [readyStatus()] });
  const configDir = await testTemp("screenshot-id-");
  const fsLike = await enrolledFs(configDir);
  try {
    for (const argv of [["screen", "screenshot"], ["screen", "screenshot", "screen_1"], ["screen", "screenshot", "SCR_1"]]) {
      const result = await withRuntime(["--json", ...argv], transport, { fs: fsLike, configDir });
      assert.equal(result.code, ExitCode.Usage, result.stdout);
      const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string } };
      assert.equal(envelope.error.code, "usage_error");
      assert.match(envelope.error.detail, /requires <id>/);
    }
    assert.equal(screenshotCalls(transport).length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen screenshot writes ./<id>.webp by default and honors --output", async () => {
  const configDir = await testTemp("screenshot-out-");
  const cwdDir = await testTemp("screenshot-cwd-");
  const fsLike = await enrolledFs(configDir);
  try {
    const defaultTransport = screenshotTransport({ statuses: [readyStatus()] });
    const defaulted = await withRuntime(
      ["--json", "screen", "screenshot", SCREEN_ID, "--poll-ms", "1"],
      defaultTransport,
      { fs: fsLike, configDir, cwdDir },
    );
    assert.equal(defaulted.code, 0, defaulted.stdout);
    const defaultPath = path.resolve(cwdDir, `./${SCREEN_ID}.webp`);
    const defaultEnvelope = JSON.parse(defaulted.stdout) as { ok: boolean; data: { path: string } };
    assert.equal(defaultEnvelope.data.path, defaultPath);
    assert.deepEqual(await readFile(defaultPath), Buffer.from(IMAGE_BYTES));

    const customTransport = screenshotTransport({ statuses: [readyStatus()] });
    const customPath = path.join(cwdDir, "lobby.webp");
    const custom = await withRuntime(
      ["--json", "screen", "screenshot", SCREEN_ID, "--output", customPath, "--poll-ms", "1"],
      customTransport,
      { fs: fsLike, configDir, cwdDir },
    );
    assert.equal(custom.code, 0, custom.stdout);
    const customEnvelope = JSON.parse(custom.stdout) as { ok: boolean; data: { path: string } };
    assert.equal(customEnvelope.data.path, customPath);
    assert.deepEqual(await readFile(customPath), Buffer.from(IMAGE_BYTES));

    const directory = await withRuntime(
      ["--json", "screen", "screenshot", SCREEN_ID, "--output", cwdDir],
      screenshotTransport({ statuses: [readyStatus()] }),
      { fs: fsLike, configDir, cwdDir },
    );
    assert.equal(directory.code, ExitCode.Usage);
    assert.match(JSON.parse(directory.stdout).error.detail as string, /file path/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("screen screenshot downloads when status is ready and matching", async () => {
  const configDir = await testTemp("screenshot-ready-");
  const cwdDir = await testTemp("screenshot-ready-cwd-");
  const fsLike = await enrolledFs(configDir);
  const transport = screenshotTransport({
    statuses: [{ state: "pending", capture_id: CAPTURE_ID }, readyStatus()],
  });
  try {
    const result = await withRuntime(
      ["--json", "screen", "screenshot", SCREEN_ID, "--poll-ms", "1"],
      transport,
      { fs: fsLike, configDir, cwdDir },
    );
    assert.equal(result.code, 0, result.stdout);
    const methods = screenshotCalls(transport).map((call) => `${call.method} ${call.path}`);
    assert.deepEqual(methods, [
      `POST /api/v1/screens/${SCREEN_ID}/screenshot`,
      `GET /api/v1/screens/${SCREEN_ID}/screenshot/status`,
      `GET /api/v1/screens/${SCREEN_ID}/screenshot/status`,
      `GET /api/v1/screens/${SCREEN_ID}/screenshot`,
    ]);
    const post = transport.calls.find((call) => call.method === "POST" && call.path.endsWith("/screenshot"));
    assert.ok(post?.headers?.["idempotency-key"]);
    assert.equal(post?.body, undefined);
    const download = transport.calls.find((call) => call.method === "GET" && call.path.endsWith("/screenshot"));
    assert.equal(download?.binary, true);
    assert.equal(download?.query?.capture_id, CAPTURE_ID);
    assert.equal(download?.headers?.accept, "image/webp");
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("screen screenshot surfaces screenshot_unavailable when status is timed_out", async () => {
  const configDir = await testTemp("screenshot-timeout-");
  const cwdDir = await testTemp("screenshot-timeout-cwd-");
  const fsLike = await enrolledFs(configDir);
  const transport = screenshotTransport({
    statuses: [{ state: "timed_out", capture_id: CAPTURE_ID }],
  });
  try {
    const result = await withRuntime(
      ["--json", "screen", "screenshot", SCREEN_ID, "--poll-ms", "1"],
      transport,
      { fs: fsLike, configDir, cwdDir },
    );
    assert.equal(result.code, ExitCode.Conflict, result.stdout);
    const envelope = JSON.parse(result.stdout) as { error: { code: string; type: string; status: number } };
    assert.equal(envelope.error.code, "screenshot_unavailable");
    assert.equal(envelope.error.type, "https://screenrig.ai/problems/screenshot-unavailable");
    assert.equal(envelope.error.status, 409);
    assert.equal(transport.calls.some((call) => call.method === "GET" && call.path.endsWith("/screenshot") && call.binary), false);
    assert.equal(result.stdout.includes(IMAGE_MARK), false);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("screen screenshot surfaces resource_conflict when capture_id is replaced", async () => {
  const configDir = await testTemp("screenshot-replaced-");
  const cwdDir = await testTemp("screenshot-replaced-cwd-");
  const fsLike = await enrolledFs(configDir);
  const transport = screenshotTransport({
    statuses: [{ state: "pending", capture_id: REPLACED_CAPTURE_ID }],
  });
  try {
    const result = await withRuntime(
      ["--json", "screen", "screenshot", SCREEN_ID, "--poll-ms", "1"],
      transport,
      { fs: fsLike, configDir, cwdDir },
    );
    assert.equal(result.code, ExitCode.Conflict, result.stdout);
    const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string } };
    assert.equal(envelope.error.code, "resource_conflict");
    assert.equal(envelope.error.detail, "A later screenshot request replaced this one.");
    assert.equal(transport.calls.some((call) => call.binary), false);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("screen screenshot surfaces screenshot_unavailable when the wait deadline elapses", async () => {
  const configDir = await testTemp("screenshot-deadline-");
  const cwdDir = await testTemp("screenshot-deadline-cwd-");
  const fsLike = await enrolledFs(configDir);
  const transport = screenshotTransport({
    statuses: [{ state: "pending", capture_id: CAPTURE_ID }],
  });
  try {
    const result = await withRuntime(
      ["--json", "screen", "screenshot", SCREEN_ID, "--timeout", "0", "--poll-ms", "1"],
      transport,
      { fs: fsLike, configDir, cwdDir },
    );
    assert.equal(result.code, ExitCode.Conflict, result.stdout);
    const envelope = JSON.parse(result.stdout) as { error: { code: string; type: string } };
    assert.equal(envelope.error.code, "screenshot_unavailable");
    assert.equal(envelope.error.type, "https://screenrig.ai/problems/screenshot-unavailable");
    assert.equal(transport.calls.some((call) => call.binary), false);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("screen screenshot success envelope has metadata only and never prints pixels", async () => {
  const configDir = await testTemp("screenshot-envelope-");
  const cwdDir = await testTemp("screenshot-envelope-cwd-");
  const fsLike = await enrolledFs(configDir);
  const transport = screenshotTransport({ statuses: [readyStatus()] });
  try {
    const json = await withRuntime(
      ["--json", "screen", "screenshot", SCREEN_ID, "--poll-ms", "1"],
      transport,
      { fs: fsLike, configDir, cwdDir },
    );
    assert.equal(json.code, 0, json.stdout);
    const envelope = JSON.parse(json.stdout) as { ok: boolean; data: Record<string, unknown> };
    assert.equal(envelope.ok, true);
    assert.deepEqual(Object.keys(envelope.data).sort(), [
      "bytes",
      "capture_id",
      "height",
      "path",
      "screen_id",
      "sha256",
      "width",
    ]);
    assert.equal(envelope.data.screen_id, SCREEN_ID);
    assert.equal(envelope.data.capture_id, CAPTURE_ID);
    assert.equal(envelope.data.bytes, IMAGE_BYTES.byteLength);
    assert.equal(envelope.data.sha256, IMAGE_SHA256);
    assert.equal(envelope.data.width, 480);
    assert.equal(envelope.data.height, 270);
    assert.equal("pixels" in envelope.data, false);
    assert.equal("image" in envelope.data, false);
    assert.equal("base64" in envelope.data, false);
    assert.equal(json.stdout.includes(IMAGE_MARK), false);
    assert.equal(json.stderr.includes(IMAGE_MARK), false);

    const human = await withRuntime(
      ["screen", "screenshot", SCREEN_ID, "--poll-ms", "1"],
      screenshotTransport({ statuses: [readyStatus()] }),
      { fs: fsLike, configDir, cwdDir },
    );
    assert.equal(human.code, 0, human.stdout);
    assert.match(human.stdout, /screen_id:/);
    assert.match(human.stdout, /capture_id:/);
    assert.match(human.stdout, /path:/);
    assert.match(human.stdout, /bytes:/);
    assert.match(human.stdout, /sha256:/);
    assert.match(human.stdout, /width:/);
    assert.match(human.stdout, /height:/);
    assert.equal(human.stdout.includes(IMAGE_MARK), false);
    assert.equal(human.stderr.includes(IMAGE_MARK), false);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});
