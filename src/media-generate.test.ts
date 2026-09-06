import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { USAGE } from "./commands.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const API_URL = "https://api.screenrig.ai";
const TOKEN = "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
const PROMPT = "A dusk lobby photograph, warm tungsten, no people";

const GENERATED_MEDIA = {
  id: "med_01EXAMPLEGENERATED0000000",
  filename: "generated.png",
  primitive: "image",
  content_type: "image/png",
  state: "ready",
} as const;

const GENERATE_DEBITS = {
  low: { credits: 600, usd: "0.06" },
  medium: { credits: 1200, usd: "0.12" },
  high: { credits: 5000, usd: "0.50" },
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
  extra: Partial<CliRuntime> & { configDir: string },
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
    cwd: extra.cwd ?? (() => extra.configDir),
    fs: fsLike,
    transport,
    ...extra,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: await outP, stderr: await errP };
}

async function enrolled(configDir: string): Promise<ConfigFs> {
  const fsLike = realFs(configDir);
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: API_URL, token: TOKEN },
    fsLike,
  );
  return fsLike;
}

function generateTransport(): FakeTransport {
  return new FakeTransport().on("POST", "/api/v1/media/generations", (req) => {
    const body = (req.body ?? {}) as { quality?: string; aspect_ratio?: string };
    const quality = body.quality === "low" || body.quality === "high" ? body.quality : "medium";
    const debit = GENERATE_DEBITS[quality];
    return {
      status: 201,
      headers: { "content-type": "application/json", etag: '"1"' },
      body: {
        media: GENERATED_MEDIA,
        usage: {
          quality,
          aspect_ratio: body.aspect_ratio ?? "16:9",
          credits: debit.credits,
          usd: debit.usd,
        },
      },
    };
  });
}

test("USAGE lists media generate", () => {
  assert.match(
    USAGE,
    /media generate --prompt TEXT \[--aspect-ratio RATIO\] \[--quality low\|medium\|high\] \[--tag TAG\]/,
  );
  assert.doesNotMatch(USAGE, /media generate.*--no-wait/);
  assert.doesNotMatch(USAGE, /--quality auto/);
});

test("media generate stores the still and returns med_… plus usage", async () => {
  const transport = generateTransport();
  const configDir = await testTemp("media-generate-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--tag", "LobbyDusk"],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Success, result.stdout);
    const envelope = JSON.parse(result.stdout) as {
      ok: true;
      data: {
        id: string;
        media_id: string;
        media: { id: string };
        usage: { credits: number; usd: string; quality: string };
      };
    };
    assert.equal(envelope.data.id, "med_01EXAMPLEGENERATED0000000");
    assert.equal(envelope.data.media_id, envelope.data.id);
    assert.equal(envelope.data.media.id, envelope.data.id);
    assert.equal(envelope.data.usage.quality, "medium");
    assert.equal(envelope.data.usage.credits, 1200);
    assert.equal(envelope.data.usage.usd, "0.12");
    assert.doesNotMatch(result.stdout, /gpt-image-2|\$30|billed_as|image_output_tokens/);
    assert.doesNotMatch(result.stdout, /b64_json|data:image|iVBOR/);
    assert.doesNotMatch(result.stdout, new RegExp(PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0]?.method, "POST");
    assert.equal(transport.calls[0]?.path, "/api/v1/media/generations");
    assert.deepEqual(transport.calls[0]?.body, {
      prompt: PROMPT,
      aspect_ratio: "16:9",
      quality: "medium",
      tag: "LobbyDusk",
    });
    assert.ok(transport.calls[0]?.headers?.["idempotency-key"]);
    assert.equal(transport.calls[0]?.timeout_ms, 60_000);
    assert.equal(transport.calls.filter((call) => call.path === "/api/v1/media/uploads").length, 0);
    assert.equal(transport.calls.filter((call) => call.method === "PUT").length, 0);
    assert.equal(transport.calls.filter((call) => call.path.startsWith("/api/v1/operations")).length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate forwards aspect_ratio and quality", async () => {
  const transport = generateTransport();
  const configDir = await testTemp("media-generate-ratio-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      [
        "--json",
        "media",
        "generate",
        "--prompt",
        PROMPT,
        "--aspect-ratio",
        "9:16",
        "--quality",
        "high",
      ],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.deepEqual(transport.calls[0]?.body, {
      prompt: PROMPT,
      aspect_ratio: "9:16",
      quality: "high",
    });
    const envelope = JSON.parse(result.stdout) as { data: { usage: { credits: number; usd: string; quality: string } } };
    assert.equal(envelope.data.usage.quality, "high");
    assert.equal(envelope.data.usage.credits, 5000);
    assert.equal(envelope.data.usage.usd, "0.50");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate bills low quality at 600 credits / $0.06", async () => {
  const transport = generateTransport();
  const configDir = await testTemp("media-generate-low-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--quality", "low"],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.equal((transport.calls[0]?.body as { quality?: string }).quality, "low");
    const envelope = JSON.parse(result.stdout) as { data: { usage: { credits: number; usd: string; quality: string } } };
    assert.equal(envelope.data.usage.quality, "low");
    assert.equal(envelope.data.usage.credits, 600);
    assert.equal(envelope.data.usage.usd, "0.06");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate rejects auto quality before any request", async () => {
  const transport = generateTransport();
  const configDir = await testTemp("media-generate-auto-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--quality", "auto"],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Usage, result.stdout);
    const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string } };
    assert.equal(envelope.error.code, "usage_error");
    assert.match(envelope.error.detail, /low, medium, or high/);
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate rejects a 201 without usage.usd", async () => {
  const transport = new FakeTransport().on("POST", "/api/v1/media/generations", () => ({
    status: 201,
    headers: { "content-type": "application/json", etag: '"1"' },
    body: {
      media: GENERATED_MEDIA,
      usage: { quality: "medium", aspect_ratio: "16:9", credits: 1200 },
    },
  }));
  const configDir = await testTemp("media-generate-usd-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Usage, result.stdout);
    const envelope = JSON.parse(result.stdout) as { error: { code: string } };
    assert.equal(envelope.error.code, "usage_error");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate rejects a 201 without usage.credits", async () => {
  const transport = new FakeTransport().on("POST", "/api/v1/media/generations", () => ({
    status: 201,
    headers: { "content-type": "application/json", etag: '"1"' },
    body: {
      media: GENERATED_MEDIA,
      usage: { quality: "medium", aspect_ratio: "16:9" },
    },
  }));
  const configDir = await testTemp("media-generate-credits-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Usage, result.stdout);
    const envelope = JSON.parse(result.stdout) as { error: { code: string } };
    assert.equal(envelope.error.code, "usage_error");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate rejects a missing prompt before any request", async () => {
  const transport = generateTransport();
  const configDir = await testTemp("media-generate-prompt-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(["--json", "media", "generate"], transport, { configDir, fs: fsLike });
    assert.equal(result.code, ExitCode.Usage, result.stdout);
    const envelope = JSON.parse(result.stdout) as { ok: false; error: { code: string } };
    assert.equal(envelope.error.code, "usage_error");
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate rejects an unknown aspect ratio before any request", async () => {
  const transport = generateTransport();
  const configDir = await testTemp("media-generate-aspect-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--aspect-ratio", "21:9"],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Usage, result.stdout);
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate maps 402 to payment_required and does not retry", async () => {
  const transport = new FakeTransport().on("POST", "/api/v1/media/generations", () => ({
    status: 402,
    headers: { "content-type": "application/problem+json" },
    body: {
      type: "https://screenrig.ai/problems/payment-required",
      title: "Prepaid credit is required",
      status: 402,
      detail: "Prepaid credit remaining is below the generation debit.",
      code: "payment_required",
    },
  }));
  const configDir = await testTemp("media-generate-402-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Client, result.stdout);
    const envelope = JSON.parse(result.stdout) as { error: { code: string; status: number } };
    assert.equal(envelope.error.code, "payment_required");
    assert.equal(envelope.error.status, 402);
    assert.equal(transport.calls.length, 1);
    assert.doesNotMatch(result.stdout, new RegExp(PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate does not poll a 202", async () => {
  const transport = new FakeTransport().on("POST", "/api/v1/media/generations", () => ({
    status: 202,
    headers: { "content-type": "application/json" },
    body: { id: "op_AAAAAAAAAAAAAAAAAAAAAAAA", state: "queued" },
  }));
  const configDir = await testTemp("media-generate-202-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Usage, result.stdout);
    const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string } };
    assert.equal(envelope.error.code, "usage_error");
    assert.match(envelope.error.detail, /does not poll/);
    assert.equal(transport.calls.filter((call) => call.path.startsWith("/api/v1/operations")).length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
