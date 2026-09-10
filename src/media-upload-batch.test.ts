import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { MediaUploadDeclaration, Operation } from "./adapters/protocol.js";
import { ApiClient } from "./client.js";
import { commandHelp } from "./help.js";
const USAGE = commandHelp(["media", "upload-batch"]).usage;
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { createMemoryLogger } from "./log/logger.js";
import { run, type CliRuntime } from "./main.js";
import {
  computeBackoffMs,
  deriveBatchIdempotencyKey,
  parseUploadBatchManifest,
  runMediaUploadBatch,
  UPLOAD_BATCH_BACKOFF_CAP_MS,
  UPLOAD_BATCH_BACKOFF_START_MS,
  UPLOAD_BATCH_MAX_ATTEMPTS,
  writeUploadBatchStateAtomic,
} from "./media-upload-batch.js";
import { silentProgressReporter } from "./media/progress.js";
import { DEFAULT_CODEC, DEFAULT_MAX_FPS, DEFAULT_WEBP_QUALITY, MAX_EDGE } from "./media/transcode.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const ACCOUNT_ID = "acc_AAAAAAAAAAAAAAAAAAAAAAAA";
const API_URL = "https://api.screenrig.ai";
const TOKEN = "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";

const DEFAULT_TRANSCODE = {
  codec: DEFAULT_CODEC,
  maxFps: DEFAULT_MAX_FPS,
  maxEdge: MAX_EDGE,
  webpQuality: DEFAULT_WEBP_QUALITY,
} as const;

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

function realFs(home: string): ConfigFs {
  return { mkdir, open, rename, rm, chmod, stat, homedir: () => home, env: { XDG_CONFIG_HOME: home } };
}

async function withRuntime(
  argv: string[],
  transport: FakeTransport,
  extra: Partial<CliRuntime> & { configDir: string; cwdDir: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const fsLike = extra.fs ?? realFs(extra.configDir);
  const runtime: CliRuntime = {
    argv,
    env: fsLike.env,
    stdout,
    stderr,
    now: extra.now ?? (() => new Date("2026-08-14T17:00:00.000Z")),
    sleep: extra.sleep ?? (async () => undefined),
    homedir: fsLike.homedir,
    cwd: extra.cwd ?? (() => extra.cwdDir),
    fs: fsLike,
    transport,
    signedRawPut: extra.signedRawPut ?? (async () => ({ status: 200 })),
    ...extra,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: await outP, stderr: await errP };
}

async function enrolled(configDir: string, accountId = ACCOUNT_ID): Promise<ConfigFs> {
  const fsLike = realFs(configDir);
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: API_URL, token: TOKEN, account_id: accountId },
    fsLike,
  );
  return fsLike;
}

interface BatchTransportOptions {
  rateLimitAt?: number;
  failAfter?: number;
  retryAfter?: string;
  failStatus?: number;
}

interface BatchTransport {
  transport: FakeTransport;
  declareCount: () => number;
  declareKeys: () => string[];
}

function batchTransport(options: BatchTransportOptions = {}): BatchTransport {
  const transport = new FakeTransport();
  const operations = new Map<string, Operation>();
  const uploads = new Map<string, { declaration: MediaUploadDeclaration; seq: number; opId: string }>();
  let seq = 0;
  let declares = 0;
  const declareKeys: string[] = [];
  transport.on("GET", "/api/v1/account", () => ({
    status: 200,
    headers: {},
    body: { id: ACCOUNT_ID },
  }));
  transport.on("POST", "/api/v1/media/uploads", (req: TransportRequest): TransportResponse => {
    declares += 1;
    declareKeys.push(req.headers?.["idempotency-key"] ?? "");
    if (options.rateLimitAt !== undefined && declares === options.rateLimitAt) {
      return {
        status: 429,
        headers: {
          "content-type": "application/problem+json",
          "retry-after": options.retryAfter ?? "1",
        },
        body: {
          status: 429,
          code: "rate_limited",
          title: "Rate limited",
          detail: "Too many media upload declarations.",
        },
      };
    }
    if (options.failAfter !== undefined && declares > options.failAfter) {
      const status = options.failStatus ?? 400;
      return {
        status,
        headers: { "content-type": "application/problem+json" },
        body: {
          status,
          code: status >= 500 ? "internal_error" : "invalid_request",
          title: status >= 500 ? "Internal error" : "Invalid request",
          detail: "Upload rejected by test transport.",
        },
      };
    }
    seq += 1;
    const id = `upload_${seq}`;
    const opId = `op_${seq}`;
    const declaration = req.body as MediaUploadDeclaration;
    uploads.set(id, { declaration, seq, opId });
    const operation: Operation = {
      id: opId,
      kind: "media.upload",
      state: "queued",
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:00.000Z",
    };
    operations.set(opId, operation);
    return {
      status: 201,
      headers: { "cache-control": "private, no-store" },
      body: {
        id,
        operation,
        upload_url: "https://storage.example.invalid/signed/object",
        method: "PUT",
        headers: { "content-type": declaration.content_type },
        expires_at: "2099-08-14T17:05:00.000Z",
      },
    };
  });
  transport.on("POST", /^\/api\/v1\/media\/uploads\/[^/]+\/commit$/, (req) => {
    const uploadId = req.path.split("/").at(-2) ?? "";
    const stored = uploads.get(uploadId);
    const mediaId = `med_${String(stored?.seq ?? 0).padStart(24, "A")}`;
    const opId = stored?.opId ?? "op_unknown";
    const operation: Operation = {
      id: opId,
      kind: "media.upload",
      state: "succeeded",
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:01.000Z",
      result: { media_id: mediaId, revision: 1 },
    };
    operations.set(opId, operation);
    return { status: 202, headers: {}, body: operation };
  });
  transport.on("GET", /^\/api\/v1\/operations\/[^/]+$/, (req) => {
    const id = req.path.split("/").pop() ?? "";
    const existing = operations.get(id) ?? {
      id,
      kind: "media.upload",
      state: "succeeded" as const,
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:01.000Z",
    };
    return { status: 200, headers: {}, body: existing };
  });
  return {
    transport,
    declareCount: () => declares,
    declareKeys: () => declareKeys,
  };
}

async function writePng(dir: string, name: string, payload: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, Buffer.from(payload));
  return file;
}

async function writeManifest(dir: string, files: string[]): Promise<string> {
  const manifest = path.join(dir, "manifest.json");
  await writeFile(
    manifest,
    `${JSON.stringify({ items: files.map((file) => ({ path: `./${path.basename(file)}` })) }, null, 2)}\n`,
  );
  return manifest;
}

test("USAGE lists media upload-batch", () => {
  assert.match(USAGE, /media upload-batch <manifest\.json> --state FILE \[--concurrency N\]/);
  assert.match(USAGE, /\[--no-transcode\] \[--tag TAG\] \[--no-progress\]/);
});

test("backoff honours Retry-After and otherwise uses capped equal jitter", () => {
  assert.equal(computeBackoffMs({ attemptIndex: 0, retryAfterSeconds: 2 }), 2000);
  assert.equal(computeBackoffMs({ attemptIndex: 9, retryAfterSeconds: 0 }), 0);
  assert.equal(computeBackoffMs({ attemptIndex: 0, random: () => 1 }), UPLOAD_BATCH_BACKOFF_START_MS);
  assert.equal(computeBackoffMs({ attemptIndex: 0, random: () => 0 }), UPLOAD_BATCH_BACKOFF_START_MS / 2);
  assert.equal(computeBackoffMs({ attemptIndex: 10, random: () => 1 }), UPLOAD_BATCH_BACKOFF_CAP_MS);
  assert.equal(UPLOAD_BATCH_MAX_ATTEMPTS, 8);
});

test("idempotency key is deterministic from the content hash", () => {
  const digest = "a".repeat(64);
  assert.equal(deriveBatchIdempotencyKey(digest), deriveBatchIdempotencyKey(digest));
  assert.equal(deriveBatchIdempotencyKey(digest), deriveBatchIdempotencyKey(digest, 0));
  assert.notEqual(deriveBatchIdempotencyKey(digest), deriveBatchIdempotencyKey("b".repeat(64)));
  assert.notEqual(deriveBatchIdempotencyKey(digest, 0), deriveBatchIdempotencyKey(digest, 1));
  assert.match(deriveBatchIdempotencyKey(digest), /^[A-Za-z0-9._~-]{8,200}$/);
});

test("manifest parser resolves paths relative to the manifest and bounds the item count", async () => {
  const dir = await testTemp("batch-manifest-");
  try {
    const items = parseUploadBatchManifest({ items: [{ path: "./still.png", tag: "lobby" }] }, dir);
    assert.equal(items[0]?.path, path.join(dir, "still.png"));
    assert.equal(items[0]?.displayPath, "./still.png");
    assert.equal(items[0]?.tag, "lobby");
    assert.throws(() => parseUploadBatchManifest({ items: [] }, dir), /1 to 1000/);
    assert.throws(() => parseUploadBatchManifest({ items: [{ path: "./a.png", extra: true }] }, dir), /unsupported field/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("120 accepted then a 429 with Retry-After is honoured and the item succeeds", async () => {
  const configDir = await testTemp("batch-429-cfg-");
  const cwdDir = await testTemp("batch-429-cwd-");
  const fsLike = await enrolled(configDir);
  const files: string[] = [];
  for (let i = 0; i < 121; i += 1) {
    files.push(await writePng(cwdDir, `img-${i}.png`, `pixel-${i}`));
  }
  const manifest = await writeManifest(cwdDir, files);
  const statePath = path.join(cwdDir, "upload-state.json");
  const backend = batchTransport({ rateLimitAt: 121, retryAfter: "1" });
  const sleeps: number[] = [];
  try {
    const result = await withRuntime(
      [
        "--json",
        "media",
        "upload-batch",
        manifest,
        "--state",
        statePath,
        "--no-transcode",
        "--no-progress",
        "--concurrency",
        "1",
      ],
      backend.transport,
      {
        configDir,
        cwdDir,
        fs: fsLike,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    assert.equal(result.code, ExitCode.Success, result.stdout);
    const envelope = JSON.parse(result.stdout) as {
      ok: true;
      data: {
        accepted: number;
        resumed: number;
        failed: unknown[];
        attempts: number;
        rate_limited: number;
        wait_ms: number;
      };
    };
    assert.equal(envelope.data.accepted, 121);
    assert.equal(envelope.data.resumed, 0);
    assert.equal(envelope.data.failed.length, 0);
    assert.equal(envelope.data.rate_limited, 1);
    assert.equal(envelope.data.attempts, 122);
    assert.equal(envelope.data.wait_ms, 1000);
    assert.deepEqual(sleeps, [1000]);
    assert.equal(backend.declareCount(), 122);
    assert.equal(result.stderr.trim(), "");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      api_url: string;
      account_id: string;
      items: Record<string, { media_id: string }>;
    };
    assert.equal(state.api_url, API_URL);
    assert.equal(state.account_id, ACCOUNT_ID);
    assert.equal(Object.keys(state.items).length, 121);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("a second run skips accepted hashes and reports resumed", async () => {
  const configDir = await testTemp("batch-resume-cfg-");
  const cwdDir = await testTemp("batch-resume-cwd-");
  const fsLike = await enrolled(configDir);
  const files: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    files.push(await writePng(cwdDir, `still-${i}.png`, `still-bytes-${i}`));
  }
  const manifest = await writeManifest(cwdDir, files);
  const statePath = path.join(cwdDir, "upload-state.json");
  const first = batchTransport({ failAfter: 2 });
  try {
    const interrupted = await withRuntime(
      [
        "--json",
        "media",
        "upload-batch",
        manifest,
        "--state",
        statePath,
        "--no-transcode",
        "--no-progress",
        "--concurrency",
        "1",
      ],
      first.transport,
      { configDir, cwdDir, fs: fsLike },
    );
    assert.equal(interrupted.code, ExitCode.Client, interrupted.stdout);
    const firstEnvelope = JSON.parse(interrupted.stdout) as {
      data: { accepted: number; resumed: number; failed: unknown[] };
    };
    assert.equal(firstEnvelope.data.accepted, 2);
    assert.equal(firstEnvelope.data.failed.length, 3);

    const second = batchTransport();
    const resumed = await withRuntime(
      [
        "--json",
        "media",
        "upload-batch",
        manifest,
        "--state",
        statePath,
        "--no-transcode",
        "--no-progress",
        "--concurrency",
        "1",
      ],
      second.transport,
      { configDir, cwdDir, fs: fsLike },
    );
    assert.equal(resumed.code, ExitCode.Success, resumed.stdout);
    const envelope = JSON.parse(resumed.stdout) as {
      data: {
        accepted: number;
        resumed: number;
        failed: unknown[];
        attempts: number;
        items: Array<{ path: string; source_filename: string; sha256: string; outcome: string; media_id?: string }>;
      };
    };
    assert.equal(envelope.data.resumed, 2);
    assert.equal(envelope.data.accepted, 3);
    assert.equal(envelope.data.failed.length, 0);
    assert.equal(second.declareCount(), 3);
    // Counts alone force a second `media list --tag` call to learn what the
    // batch created, and an untagged batch has no way back to its ids at all.
    assert.equal(envelope.data.items.length, 5);
    assert.deepEqual(
      envelope.data.items.map((item) => item.source_filename),
      ["still-0.png", "still-1.png", "still-2.png", "still-3.png", "still-4.png"],
      "items follow manifest order, not completion order",
    );
    for (const item of envelope.data.items) {
      assert.ok(item.media_id?.startsWith("med_"), JSON.stringify(item));
      assert.match(item.sha256, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(
      envelope.data.items.filter((item) => item.outcome === "resumed").map((item) => item.source_filename),
      ["still-0.png", "still-1.png"],
      "the two items already accepted in the interrupted run come back as resumed, with their ids",
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("attempts, wait_ms, and transfer_ms account for retries separately", async () => {
  const configDir = await testTemp("batch-account-cfg-");
  const cwdDir = await testTemp("batch-account-cwd-");
  const fsLike = await enrolled(configDir);
  await writePng(cwdDir, "one.png", "one-bytes");
  const manifest = await writeManifest(cwdDir, [path.join(cwdDir, "one.png")]);
  const statePath = path.join(cwdDir, "upload-state.json");
  const transport = new FakeTransport();
  const operations = new Map<string, Operation>();
  let declares = 0;
  transport.on("POST", "/api/v1/media/uploads", (req): TransportResponse => {
    declares += 1;
    if (declares === 1) {
      return {
        status: 503,
        headers: { "content-type": "application/problem+json" },
        body: { status: 503, code: "internal_error", title: "Unavailable", detail: "try again" },
      };
    }
    const declaration = req.body as MediaUploadDeclaration;
    const operation: Operation = {
      id: "op_1",
      kind: "media.upload",
      state: "queued",
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:00.000Z",
    };
    operations.set("op_1", {
      ...operation,
      state: "succeeded",
      result: { media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA", revision: 1 },
    });
    return {
      status: 201,
      headers: { "cache-control": "private, no-store" },
      body: {
        id: "upload_1",
        operation,
        upload_url: "https://storage.example.invalid/signed/object",
        method: "PUT",
        headers: { "content-type": declaration.content_type },
        expires_at: "2099-08-14T17:05:00.000Z",
      },
    };
  });
  transport.on("POST", /^\/api\/v1\/media\/uploads\/[^/]+\/commit$/, () => ({
    status: 202,
    headers: {},
    body: operations.get("op_1"),
  }));
  transport.on("GET", /^\/api\/v1\/operations\/[^/]+$/, () => ({
    status: 200,
    headers: {},
    body: operations.get("op_1"),
  }));
  const sleeps: number[] = [];
  let nowMs = Date.parse("2026-08-14T17:00:00.000Z");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  try {
    const result = await runMediaUploadBatch({
      runtime: {
        argv: [],
        env: fsLike.env,
        stdout,
        stderr,
        now: () => {
          nowMs += 13;
          return new Date(nowMs);
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        homedir: fsLike.homedir,
        cwd: () => cwdDir,
        fs: fsLike,
        signedRawPut: async () => ({ status: 200 }),
      },
      client: new ApiClient({ transport, token: TOKEN }),
      manifestPath: manifest,
      statePath,
      apiUrl: API_URL,
      accountId: ACCOUNT_ID,
      concurrency: 1,
      transcodeOptions: DEFAULT_TRANSCODE,
      noTranscode: true,
      reporter: silentProgressReporter(),
      json: true,
      noProgress: true,
      random: () => 1,
    });
    assert.equal(result.exitCode, ExitCode.Success);
    assert.equal(result.data.accepted, 1);
    assert.equal(result.data.attempts, 2);
    assert.equal(result.data.rate_limited, 0);
    assert.equal(result.data.wait_ms, UPLOAD_BATCH_BACKOFF_START_MS);
    assert.deepEqual(sleeps, [UPLOAD_BATCH_BACKOFF_START_MS]);
    assert.ok(result.data.transfer_ms > 0, "transfer_ms must count request time, not backoff");
    assert.notEqual(result.data.transfer_ms, result.data.wait_ms);
  } finally {
    stdout.end();
    stderr.end();
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("state file is 0600 and replaced atomically", async () => {
  const configDir = await testTemp("batch-mode-cfg-");
  const cwdDir = await testTemp("batch-mode-cwd-");
  const statePath = path.join(cwdDir, "upload-state.json");
  const stateRenames: string[] = [];
  const fsLike: ConfigFs = {
    mkdir,
    open,
    chmod,
    stat,
    rm,
    homedir: () => configDir,
    env: { XDG_CONFIG_HOME: configDir },
    rename: async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(statePath)) {
        assert.match(String(from), /\.tmp$/);
        stateRenames.push(String(from));
      }
      return rename(from, to);
    },
  };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: API_URL, token: TOKEN, account_id: ACCOUNT_ID },
    fsLike,
  );
  await writePng(cwdDir, "still.png", "mode-bytes");
  const manifest = await writeManifest(cwdDir, [path.join(cwdDir, "still.png")]);
  const backend = batchTransport();
  try {
    const result = await withRuntime(
      ["--json", "media", "upload-batch", manifest, "--state", statePath, "--no-transcode", "--no-progress", "--concurrency", "1"],
      backend.transport,
      { configDir, cwdDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Success, result.stdout);
    const info = await stat(statePath);
    assert.equal(info.mode & 0o777, 0o600);
    assert.ok(stateRenames.length >= 1, "state must be written via rename from a temp file");
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("state file refuses an api_url or account mismatch", async () => {
  const dir = await testTemp("batch-mismatch-");
  const fsLike = realFs(dir);
  const statePath = path.join(dir, "state.json");
  try {
    await writeUploadBatchStateAtomic(
      statePath,
      { api_url: API_URL, account_id: ACCOUNT_ID, items: {} },
      fsLike,
      Date.parse("2026-08-14T17:00:00.000Z"),
    );
    await writePng(dir, "still.png", "x");
    const manifest = await writeManifest(dir, [path.join(dir, "still.png")]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    await assert.rejects(
      () =>
        runMediaUploadBatch({
          runtime: {
            argv: [],
            env: fsLike.env,
            stdout,
            stderr,
            now: () => new Date("2026-08-14T17:00:00.000Z"),
            sleep: async () => undefined,
            homedir: fsLike.homedir,
            cwd: () => dir,
            fs: fsLike,
            signedRawPut: async () => ({ status: 200 }),
          },
          client: new ApiClient({ transport: new FakeTransport(), token: TOKEN }),
          manifestPath: manifest,
          statePath,
          apiUrl: API_URL,
          accountId: "acc_OTHERACCOUNTAAAAAAAAAAAAAA",
          concurrency: 1,
          transcodeOptions: DEFAULT_TRANSCODE,
          noTranscode: true,
          reporter: silentProgressReporter(),
          json: true,
          noProgress: true,
        }),
      /different account or API URL/,
    );
    stdout.end();
    stderr.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("operation log emits batch and per-item local pairs without signed material", async () => {
  const configDir = await testTemp("batch-log-cfg-");
  const cwdDir = await testTemp("batch-log-cwd-");
  const fsLike = await enrolled(configDir);
  await writePng(cwdDir, "still.png", "log-bytes");
  const manifest = await writeManifest(cwdDir, [path.join(cwdDir, "still.png")]);
  const statePath = path.join(cwdDir, "upload-state.json");
  const { logger, events } = createMemoryLogger({ command: ["media", "upload-batch"] });
  const backend = batchTransport();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  try {
    const result = await runMediaUploadBatch({
      runtime: {
        argv: [],
        env: fsLike.env,
        stdout,
        stderr,
        now: () => new Date("2026-08-14T17:00:00.000Z"),
        sleep: async () => undefined,
        homedir: fsLike.homedir,
        cwd: () => cwdDir,
        fs: fsLike,
        logger,
        signedRawPut: async () => ({ status: 200 }),
      },
      client: new ApiClient({ transport: backend.transport, token: TOKEN, logger }),
      manifestPath: manifest,
      statePath,
      apiUrl: API_URL,
      accountId: ACCOUNT_ID,
      concurrency: 1,
      transcodeOptions: DEFAULT_TRANSCODE,
      noTranscode: true,
      reporter: silentProgressReporter(),
      json: true,
      noProgress: true,
    });
    assert.equal(result.exitCode, ExitCode.Success);
    const tags = events.map((event) => event.tag);
    assert.ok(tags.includes("media_upload_batch"));
    assert.ok(tags.includes("media_upload_batch_item"));
    const itemEvents = events.filter((event) => event.tag === "media_upload_batch_item");
    assert.deepEqual(
      itemEvents.map((event) => event.phase),
      ["start", "finish"],
    );
    assert.equal(events.some((event) => event.phase === "progress"), false);
    const itemFinish = events.find((event) => event.tag === "media_upload_batch_item" && event.phase === "finish");
    assert.ok(itemFinish?.id?.startsWith("med_"));
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /storage\.example\.invalid|signature=|sr_live_tokid|Bearer /i);
    const key = backend.declareKeys()[0];
    assert.equal(key, deriveBatchIdempotencyKey(createHash("sha256").update("log-bytes").digest("hex")));
  } finally {
    stdout.end();
    stderr.end();
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("409 resource_conflict on a terminal operation recovers the media id from the list", async () => {
  const configDir = await testTemp("batch-409-recover-cfg-");
  const cwdDir = await testTemp("batch-409-recover-cwd-");
  const fsLike = await enrolled(configDir);
  const bytes = Buffer.from("recover-bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(cwdDir, "still.png"), bytes);
  const manifest = await writeManifest(cwdDir, [path.join(cwdDir, "still.png")]);
  const statePath = path.join(cwdDir, "upload-state.json");
  const transport = new FakeTransport();
  const declareKeys: string[] = [];
  transport.on("POST", "/api/v1/media/uploads", (req): TransportResponse => {
    declareKeys.push(req.headers?.["idempotency-key"] ?? "");
    return {
      status: 409,
      headers: { "content-type": "application/problem+json" },
      body: {
        status: 409,
        code: "resource_conflict",
        title: "Resource state conflicts with the request",
        detail: "operation is terminal",
      },
    };
  });
  transport.on("GET", "/api/v1/media", () => ({
    status: 200,
    headers: {},
    body: {
      items: [
        {
          id: "med_RECOVEREDAAAAAAAAAAAAAAAA",
          filename: "still.png",
          primitive: "image",
          content_type: "image/png",
          operation_id: "op_RECOVERED",
          sha256: digest,
          bytes: bytes.length,
          width: 1,
          height: 1,
          revision: 3,
          state: "ready",
          created_at: "2026-08-14T17:00:00.000Z",
          updated_at: "2026-08-14T17:00:01.000Z",
        },
      ],
    },
  }));
  try {
    const result = await withRuntime(
      ["--json", "media", "upload-batch", manifest, "--state", statePath, "--no-transcode", "--no-progress", "--concurrency", "1"],
      transport,
      { configDir, cwdDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Success, result.stdout);
    const envelope = JSON.parse(result.stdout) as { data: { accepted: number; failed: unknown[] } };
    assert.equal(envelope.data.accepted, 1);
    assert.equal(envelope.data.failed.length, 0);
    assert.equal(declareKeys.length, 1);
    assert.equal(declareKeys[0], deriveBatchIdempotencyKey(digest));
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      items: Record<string, { media_id: string; revision?: number }>;
    };
    assert.equal(state.items[digest]?.media_id, "med_RECOVEREDAAAAAAAAAAAAAAAA");
    assert.equal(state.items[digest]?.revision, 3);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("409 resource_conflict on a terminal operation re-declares with a fresh key when no media exists", async () => {
  const configDir = await testTemp("batch-409-rekey-cfg-");
  const cwdDir = await testTemp("batch-409-rekey-cwd-");
  const fsLike = await enrolled(configDir);
  const bytes = Buffer.from("rekey-bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(cwdDir, "still.png"), bytes);
  const manifest = await writeManifest(cwdDir, [path.join(cwdDir, "still.png")]);
  const statePath = path.join(cwdDir, "upload-state.json");
  const transport = new FakeTransport();
  const declareKeys: string[] = [];
  const operations = new Map<string, Operation>();
  transport.on("POST", "/api/v1/media/uploads", (req): TransportResponse => {
    const key = req.headers?.["idempotency-key"] ?? "";
    declareKeys.push(key);
    if (declareKeys.length === 1) {
      return {
        status: 409,
        headers: { "content-type": "application/problem+json" },
        body: {
          status: 409,
          code: "resource_conflict",
          title: "Resource state conflicts with the request",
          detail: "operation is terminal",
        },
      };
    }
    const declaration = req.body as MediaUploadDeclaration;
    const operation: Operation = {
      id: "op_rekey",
      kind: "media.upload",
      state: "queued",
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:00.000Z",
    };
    operations.set(operation.id, {
      ...operation,
      state: "succeeded",
      result: { media_id: "med_REKEYEDAAAAAAAAAAAAAAAAAA", revision: 1 },
    });
    return {
      status: 201,
      headers: { "cache-control": "private, no-store" },
      body: {
        id: "upload_rekey",
        operation,
        upload_url: "https://storage.example.invalid/signed/object",
        method: "PUT",
        headers: { "content-type": declaration.content_type },
        expires_at: "2099-08-14T17:05:00.000Z",
      },
    };
  });
  transport.on("GET", "/api/v1/media", () => ({ status: 200, headers: {}, body: { items: [] } }));
  transport.on("POST", /^\/api\/v1\/media\/uploads\/[^/]+\/commit$/, () => ({
    status: 202,
    headers: {},
    body: operations.get("op_rekey"),
  }));
  transport.on("GET", /^\/api\/v1\/operations\/[^/]+$/, () => ({
    status: 200,
    headers: {},
    body: operations.get("op_rekey"),
  }));
  try {
    const result = await withRuntime(
      ["--json", "media", "upload-batch", manifest, "--state", statePath, "--no-transcode", "--no-progress", "--concurrency", "1"],
      transport,
      { configDir, cwdDir, fs: fsLike, signedRawPut: async () => ({ status: 200 }) },
    );
    assert.equal(result.code, ExitCode.Success, result.stdout);
    const envelope = JSON.parse(result.stdout) as { data: { accepted: number; failed: unknown[]; attempts: number } };
    assert.equal(envelope.data.accepted, 1);
    assert.equal(envelope.data.failed.length, 0);
    assert.equal(declareKeys.length, 2);
    assert.equal(declareKeys[0], deriveBatchIdempotencyKey(digest, 0));
    assert.equal(declareKeys[1], deriveBatchIdempotencyKey(digest, 1));
    assert.notEqual(declareKeys[0], declareKeys[1]);
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      items: Record<string, { media_id: string; attempt?: number; idempotency_key?: string }>;
    };
    assert.equal(state.items[digest]?.media_id, "med_REKEYEDAAAAAAAAAAAAAAAAAA");
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("declare records the operation id in state before the signed PUT", async () => {
  const configDir = await testTemp("batch-op-before-put-cfg-");
  const cwdDir = await testTemp("batch-op-before-put-cwd-");
  const fsLike = await enrolled(configDir);
  const bytes = Buffer.from("inflight-bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(cwdDir, "still.png"), bytes);
  const manifest = await writeManifest(cwdDir, [path.join(cwdDir, "still.png")]);
  const statePath = path.join(cwdDir, "upload-state.json");
  const backend = batchTransport();
  try {
    const result = await withRuntime(
      ["--json", "media", "upload-batch", manifest, "--state", statePath, "--no-transcode", "--no-progress", "--concurrency", "1"],
      backend.transport,
      {
        configDir,
        cwdDir,
        fs: fsLike,
        signedRawPut: async () => {
          throw new Error("signed put interrupted");
        },
      },
    );
    assert.notEqual(result.code, ExitCode.Success);
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      items: Record<string, { media_id?: string; operation_id?: string; idempotency_key?: string }>;
    };
    assert.equal(state.items[digest]?.media_id, undefined);
    assert.match(state.items[digest]?.operation_id ?? "", /^op_/);
    assert.equal(state.items[digest]?.idempotency_key, deriveBatchIdempotencyKey(digest));
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("media upload-batch requires --state and rejects a bad concurrency", async () => {
  const configDir = await testTemp("batch-usage-cfg-");
  const cwdDir = await testTemp("batch-usage-cwd-");
  const fsLike = await enrolled(configDir);
  await writePng(cwdDir, "still.png", "x");
  const manifest = await writeManifest(cwdDir, [path.join(cwdDir, "still.png")]);
  try {
    const missing = await withRuntime(
      ["--json", "media", "upload-batch", manifest, "--no-transcode"],
      new FakeTransport(),
      { configDir, cwdDir, fs: fsLike },
    );
    assert.equal(missing.code, ExitCode.Usage);
    assert.match(missing.stdout, /requires --state/);
    const bad = await withRuntime(
      ["--json", "media", "upload-batch", manifest, "--state", "s.json", "--concurrency", "9", "--no-transcode"],
      new FakeTransport(),
      { configDir, cwdDir, fs: fsLike },
    );
    assert.equal(bad.code, ExitCode.Usage);
    assert.match(bad.stdout, /concurrency must be a whole number from 1 to 8/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwdDir, { recursive: true, force: true });
  }
});
