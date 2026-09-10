import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { commandHelp } from "./help.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { timeoutError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const API_URL = "https://api.screenrig.ai";
const TOKEN = "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
const PROMPT = "A dusk lobby photograph, warm tungsten, no people";

const GENERATED_MEDIA = {
  id: "med_01EXAMPLEGENERATED0000000",
  filename: "generated-16x9-1a2b3c4d.webp",
  primitive: "image",
  content_type: "image/webp",
  width: 1920,
  height: 1080,
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
  const help = commandHelp(["media", "generate"]);
  assert.match(help.synopsis[0]!, /media generate \[options\]/);
  for (const name of ["--prompt", "--aspect-ratio", "--quality", "--tag"]) {
    const option = help.options.find((item) => item.name === name);
    assert.equal(option?.type, "value");
    assert.ok(option?.description);
  }
  assert.match(help.usage, /--quality <low\|medium\|high>/);
  assert.equal(help.options.some((option) => option.name === "--no-wait"), false);
  assert.doesNotMatch(help.usage, /--quality.*auto/);
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
    assert.equal(transport.calls[0]?.timeout_ms, 150_000);
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

test("the generate budget sits above the backend's 90 s vendor timeout while short calls keep 30 s", async () => {
  const transport = generateTransport().on("GET", "/api/v1/media", () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: { items: [], next_cursor: null },
  }));
  const configDir = await testTemp("media-generate-budget-");
  const fsLike = await enrolled(configDir);
  try {
    const generated = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--quality", "high"],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(generated.code, ExitCode.Success, generated.stdout);
    const generate = transport.calls.find((call) => call.path === "/api/v1/media/generations");
    assert.ok(generate?.timeout_ms !== undefined);
    assert.ok(
      generate.timeout_ms > 90_000,
      `the blocking generate budget must exceed the server's 90 s vendor timeout, got ${generate.timeout_ms}`,
    );
    assert.equal(generate.timeout_ms, 150_000);

    const listed = await withRuntime(["--json", "media", "list"], transport, { configDir, fs: fsLike });
    assert.equal(listed.code, ExitCode.Success, listed.stdout);
    const list = transport.calls.find((call) => call.path === "/api/v1/media");
    assert.equal(list?.timeout_ms, 30_000, "the generic request budget is unchanged by the generate budget");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate reports elapsed_ms and announces that it blocks", async () => {
  const transport = generateTransport();
  const configDir = await testTemp("media-generate-elapsed-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--quality", "high"],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Success, result.stdout);
    const envelope = JSON.parse(result.stdout) as { data: { elapsed_ms: number } };
    assert.equal(typeof envelope.data.elapsed_ms, "number");
    const notice = JSON.parse(result.stderr.trim()) as {
      event: string;
      quality: string;
      typical_seconds: number;
      timeout_ms: number;
    };
    assert.equal(notice.event, "media_generate_started");
    assert.equal(notice.quality, "high");
    assert.ok(notice.typical_seconds > 0);
    assert.equal(notice.timeout_ms, 150_000);
    assert.doesNotMatch(result.stderr, new RegExp(PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a generate that times out says the still may exist and names the command that checks", async () => {
  const transport = new FakeTransport().on("POST", "/api/v1/media/generations", () => {
    throw timeoutError("API request timed out", "req_generatetimeout00000");
  });
  const configDir = await testTemp("media-generate-timeout-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--quality", "high", "--tag", "MenuBoard"],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Timeout, result.stdout);
    const envelope = JSON.parse(result.stdout) as {
      error: { code: string; detail: string; next?: { command: string; reason: string } };
    };
    assert.equal(envelope.error.code, "timeout");
    assert.match(envelope.error.detail, /may or may not have been created/);
    assert.match(envelope.error.detail, /same idempotency key/);
    assert.equal(envelope.error.next?.command, "screenrig media list --tag MenuBoard");
    assert.doesNotMatch(result.stdout, new RegExp(PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("an identical retry after a timeout reuses the idempotency key, and a resolved generation releases it", async () => {
  const configDir = await testTemp("media-generate-replay-");
  const fsLike = await enrolled(configDir);
  const failing = new FakeTransport().on("POST", "/api/v1/media/generations", () => {
    throw timeoutError("API request timed out", "req_generatetimeout00000");
  });
  try {
    const first = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--quality", "high"],
      failing,
      { configDir, fs: fsLike },
    );
    assert.equal(first.code, ExitCode.Timeout, first.stdout);
    const firstKey = failing.calls[0]?.headers?.["idempotency-key"];
    assert.ok(firstKey);

    const secondFailing = new FakeTransport().on("POST", "/api/v1/media/generations", () => {
      throw timeoutError("API request timed out", "req_generatetimeout00000");
    });
    const retried = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--quality", "high"],
      secondFailing,
      { configDir, fs: fsLike },
    );
    assert.equal(retried.code, ExitCode.Timeout, retried.stdout);
    assert.equal(
      secondFailing.calls[0]?.headers?.["idempotency-key"],
      firstKey,
      "the identical retry must replay under the original key so the server returns the still it may already have billed",
    );

    const different = new FakeTransport().on("POST", "/api/v1/media/generations", () => {
      throw timeoutError("API request timed out", "req_generatetimeout00000");
    });
    await withRuntime(
      ["--json", "media", "generate", "--prompt", `${PROMPT} at night`, "--quality", "high"],
      different,
      { configDir, fs: fsLike },
    );
    assert.notEqual(
      different.calls[0]?.headers?.["idempotency-key"],
      firstKey,
      "a different prompt must not inherit a key whose replay would return the earlier still",
    );

    const succeeding = generateTransport();
    const done = await withRuntime(
      ["--json", "media", "generate", "--prompt", `${PROMPT} at night`, "--quality", "high"],
      succeeding,
      { configDir, fs: fsLike },
    );
    assert.equal(done.code, ExitCode.Success, done.stdout);
    const resolvedKey = succeeding.calls[0]?.headers?.["idempotency-key"];

    const after = generateTransport();
    const again = await withRuntime(
      ["--json", "media", "generate", "--prompt", `${PROMPT} at night`, "--quality", "high"],
      after,
      { configDir, fs: fsLike },
    );
    assert.equal(again.code, ExitCode.Success, again.stdout);
    assert.notEqual(
      after.calls[0]?.headers?.["idempotency-key"],
      resolvedKey,
      "once a generation returns there is nothing left to replay, so the next run bills a new still",
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a server answer releases the stored key: a 402 does not make the next run replay", async () => {
  const configDir = await testTemp("media-generate-402-key-");
  const fsLike = await enrolled(configDir);
  const refused = new FakeTransport().on("POST", "/api/v1/media/generations", () => ({
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
  try {
    const first = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--quality", "high"],
      refused,
      { configDir, fs: fsLike },
    );
    assert.equal(first.code, ExitCode.Client, first.stdout);
    const refusedKey = refused.calls[0]?.headers?.["idempotency-key"];
    assert.ok(refusedKey);

    const funded = generateTransport();
    const second = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--quality", "high"],
      funded,
      { configDir, fs: fsLike },
    );
    assert.equal(second.code, ExitCode.Success, second.stdout);
    assert.notEqual(
      funded.calls[0]?.headers?.["idempotency-key"],
      refusedKey,
      "a request the server answered is not ambiguous, so its key is released rather than replayed",
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
