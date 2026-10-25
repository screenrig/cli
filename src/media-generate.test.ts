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
const TOKEN = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
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
    { api_url: API_URL, token: TOKEN, project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization" },
    fsLike,
  );
  return fsLike;
}

const GENERATE_OPERATION = "op_01EXAMPLEGENERATE0000000";

function generationOperation(state: string, extra: Record<string, unknown> = {}) {
  return {
    id: GENERATE_OPERATION,
    kind: "media.generate",
    state,
    created_at: "2026-08-14T17:00:00Z",
    updated_at: "2026-08-14T17:00:00Z",
    ...extra,
  };
}

/**
 * The server as `Prefer: respond-async` meets it: the POST answers 202 with the
 * operation at once, the operation is polled until it succeeds, and the stored
 * still is read for the envelope. `running` is how many polls see it unfinished.
 */
function generateTransport(options: { running?: number } = {}): FakeTransport {
  let quality = "medium";
  let polls = 0;
  return new FakeTransport()
    .on("POST", "/api/media/generations", (req) => {
      const body = (req.body ?? {}) as { quality?: string };
      quality = body.quality === "low" || body.quality === "high" ? body.quality : "medium";
      return { status: 202, headers: { "content-type": "application/json", "preference-applied": "respond-async" }, body: generationOperation("queued") };
    })
    .on("GET", `/api/operations/${GENERATE_OPERATION}`, () => {
      polls += 1;
      if (polls <= (options.running ?? 0)) {
        return { status: 200, headers: { "content-type": "application/json" }, body: generationOperation("running") };
      }
      const debit = GENERATE_DEBITS[quality as keyof typeof GENERATE_DEBITS];
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: generationOperation("succeeded", {
          result: { media_id: GENERATED_MEDIA.id, usage: { quality, credits: debit.credits, usd: debit.usd } },
        }),
      };
    })
    .on("GET", `/api/media/${GENERATED_MEDIA.id}`, () => ({ status: 200, headers: { "content-type": "application/json" }, body: GENERATED_MEDIA }));
}

/** A server that predates the operation and answers the POST with the finished still. */
function legacyGenerateTransport(): FakeTransport {
  return new FakeTransport().on("POST", "/api/media/generations", () => ({
    status: 201,
    headers: { "content-type": "application/json", etag: '"1"' },
    body: { media: GENERATED_MEDIA, usage: { quality: "medium", credits: 1200, usd: "0.12" } },
  }));
}

function operationCalls(transport: FakeTransport) {
  return transport.calls.filter((call) => call.path.startsWith("/api/operations"));
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
    assert.equal((envelope.data.media as { filename?: string }).filename, GENERATED_MEDIA.filename, "the envelope still carries the stored still");
    assert.equal(envelope.data.usage.quality, "medium");
    assert.equal(envelope.data.usage.credits, 1200);
    assert.equal(envelope.data.usage.usd, "0.12");
    assert.doesNotMatch(result.stdout, /gpt-image-2|\$30|billed_as|image_output_tokens/);
    assert.doesNotMatch(result.stdout, /b64_json|data:image|iVBOR/);
    assert.doesNotMatch(result.stdout, new RegExp(PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(transport.calls[0]?.method, "POST");
    assert.equal(transport.calls[0]?.path, "/api/media/generations");
    assert.deepEqual(transport.calls[0]?.body, {
      prompt: PROMPT,
      aspect_ratio: "16:9",
      quality: "medium",
      tag: "LobbyDusk",
    });
    assert.ok(transport.calls[0]?.headers?.["idempotency-key"]);
    assert.equal(transport.calls[0]?.headers?.prefer, "respond-async", "the POST asks for the operation, not a held-open request");
    assert.equal(transport.calls[0]?.timeout_ms, 30_000, "the POST is an ordinary short request");
    assert.equal(operationCalls(transport).length, 1);
    assert.equal(operationCalls(transport)[0]?.path, `/api/operations/${GENERATE_OPERATION}`);
    assert.equal(transport.calls.filter((call) => call.path === "/api/media/uploads").length, 0);
    assert.equal(transport.calls.filter((call) => call.method === "PUT").length, 0);
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

test("media generate rejects an operation result without usage.usd", async () => {
  const transport = new FakeTransport()
    .on("POST", "/api/media/generations", () => ({ status: 202, headers: { "content-type": "application/json" }, body: generationOperation("queued") }))
    .on("GET", `/api/operations/${GENERATE_OPERATION}`, () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: generationOperation("succeeded", { result: { media_id: GENERATED_MEDIA.id, usage: { quality: "medium", credits: 1200 } } }),
    }));
  const configDir = await testTemp("media-generate-usd-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Unexpected, result.stdout);
    const envelope = JSON.parse(result.stdout) as { error: { code: string; hint?: string; next?: { command: string } } };
    assert.equal(envelope.error.code, "unexpected_response");
    assert.match(envelope.error.hint ?? "", /media list/);
    assert.equal(envelope.error.next?.command, "screenrig media list --primitive image");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate rejects an operation result without usage.credits", async () => {
  const transport = new FakeTransport()
    .on("POST", "/api/media/generations", () => ({ status: 202, headers: { "content-type": "application/json" }, body: generationOperation("queued") }))
    .on("GET", `/api/operations/${GENERATE_OPERATION}`, () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: generationOperation("succeeded", { result: { media_id: GENERATED_MEDIA.id, usage: { quality: "medium" } } }),
    }));
  const configDir = await testTemp("media-generate-credits-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Unexpected, result.stdout);
    const envelope = JSON.parse(result.stdout) as { error: { code: string; hint?: string; next?: { command: string } } };
    assert.equal(envelope.error.code, "unexpected_response");
    assert.match(envelope.error.hint ?? "", /media list/);
    assert.equal(envelope.error.next?.command, "screenrig media list --primitive image");
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
  const transport = new FakeTransport().on("POST", "/api/media/generations", () => ({
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

test("media generate polls the operation of a 202 until it succeeds", async () => {
  const transport = generateTransport({ running: 2 });
  const configDir = await testTemp("media-generate-202-");
  const fsLike = await enrolled(configDir);
  let slept = 0;
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT],
      transport,
      { configDir, fs: fsLike, sleep: async () => { slept += 1; } },
    );
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.equal(operationCalls(transport).length, 3, "two polls see it running, the third sees it succeeded");
    assert.equal(slept, 2);
    const envelope = JSON.parse(result.stdout) as { operation_id?: string; data: { media_id: string; usage: { credits: number } } };
    assert.equal(envelope.data.media_id, GENERATED_MEDIA.id);
    assert.equal(envelope.data.usage.credits, GENERATE_DEBITS.medium.credits);
    assert.equal(envelope.operation_id, GENERATE_OPERATION);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate follows an operation whose id carries the environment marker", async () => {
  const id = "stage_op_01EXAMPLEGENERATE0000000";
  const transport = new FakeTransport()
    .on("POST", "/api/media/generations", () => ({ status: 202, headers: { "content-type": "application/json" }, body: { ...generationOperation("queued"), id } }))
    .on("GET", `/api/operations/${id}`, () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        ...generationOperation("succeeded", { result: { media_id: GENERATED_MEDIA.id, usage: { quality: "medium", credits: 1200, usd: "0.12" } } }),
        id,
      },
    }))
    .on("GET", `/api/media/${GENERATED_MEDIA.id}`, () => ({ status: 200, headers: { "content-type": "application/json" }, body: GENERATED_MEDIA }));
  const configDir = await testTemp("media-generate-stage-op-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(["--json", "media", "generate", "--prompt", PROMPT], transport, { configDir, fs: fsLike });
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.equal((JSON.parse(result.stdout) as { operation_id?: string }).operation_id, id);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate still accepts a server that answers the POST with the finished still", async () => {
  const transport = legacyGenerateTransport();
  const configDir = await testTemp("media-generate-legacy-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(["--json", "media", "generate", "--prompt", PROMPT], transport, { configDir, fs: fsLike });
    assert.equal(result.code, ExitCode.Success, result.stdout);
    const envelope = JSON.parse(result.stdout) as { data: { media_id: string; usage: { credits: number } } };
    assert.equal(envelope.data.media_id, GENERATED_MEDIA.id);
    assert.equal(envelope.data.usage.credits, 1200);
    assert.equal(operationCalls(transport).length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a 202 without an operation id leaves the outcome unknown and says how to check", async () => {
  const transport = new FakeTransport().on("POST", "/api/media/generations", () => ({
    status: 202,
    headers: { "content-type": "application/json" },
    body: { state: "queued" },
  }));
  const configDir = await testTemp("media-generate-202-noid-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(["--json", "media", "generate", "--prompt", PROMPT], transport, { configDir, fs: fsLike });
    assert.equal(result.code, ExitCode.Unexpected, result.stdout);
    const envelope = JSON.parse(result.stdout) as { error: { code: string; hint?: string } };
    assert.equal(envelope.error.code, "unexpected_response");
    assert.match(envelope.error.hint ?? "", /unknown whether one was created/);
    assert.equal(operationCalls(transport).length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a generation the server fails surfaces its problem and releases the key", async () => {
  const configDir = await testTemp("media-generate-failed-op-");
  const fsLike = await enrolled(configDir);
  const failing = new FakeTransport()
    .on("POST", "/api/media/generations", () => ({ status: 202, headers: { "content-type": "application/json" }, body: generationOperation("queued") }))
    .on("GET", `/api/operations/${GENERATE_OPERATION}`, () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: generationOperation("failed", {
        error: {
          code: "dependency_timeout",
          detail: "Image generation timed out: nothing was billed.",
          next: { command: "screenrig media generate --quality medium PROMPT", reason: "a shorter prompt finishes well inside the limit" },
        },
      }),
    }));
  try {
    const first = await withRuntime(["--json", "media", "generate", "--prompt", PROMPT, "--quality", "high"], failing, { configDir, fs: fsLike });
    assert.equal(first.code, ExitCode.OperationFailed, first.stdout);
    const envelope = JSON.parse(first.stdout) as { error: { code: string; detail: string; operation_id?: string; next?: { command: string } } };
    assert.equal(envelope.error.code, "dependency_timeout");
    assert.match(envelope.error.detail, /nothing was billed/);
    assert.equal(envelope.error.operation_id, GENERATE_OPERATION);
    assert.match(envelope.error.next?.command ?? "", /media generate/);
    const failedKey = failing.calls[0]?.headers?.["idempotency-key"];
    assert.ok(failedKey);

    const retry = generateTransport();
    const second = await withRuntime(["--json", "media", "generate", "--prompt", PROMPT, "--quality", "high"], retry, { configDir, fs: fsLike });
    assert.equal(second.code, ExitCode.Success, second.stdout);
    assert.notEqual(retry.calls[0]?.headers?.["idempotency-key"], failedKey, "the server ended that operation, so a new run starts a new generation");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a wait that ends while the generation runs keeps the key, and the identical command resumes it", async () => {
  const configDir = await testTemp("media-generate-wait-");
  const fsLike = await enrolled(configDir);
  const stuck = new FakeTransport()
    .on("POST", "/api/media/generations", () => ({ status: 202, headers: { "content-type": "application/json" }, body: generationOperation("queued") }))
    .on("GET", `/api/operations/${GENERATE_OPERATION}`, () => ({ status: 200, headers: { "content-type": "application/json" }, body: generationOperation("running") }));
  try {
    const first = await withRuntime(
      ["--json", "--timeout", "40", "media", "generate", "--prompt", PROMPT, "--quality", "high"],
      stuck,
      { configDir, fs: fsLike, sleep: () => new Promise((resolve) => setTimeout(resolve, 5)) },
    );
    assert.equal(first.code, ExitCode.Timeout, first.stdout);
    const envelope = JSON.parse(first.stdout) as { error: { code: string; hint?: string; next?: { command: string } } };
    assert.equal(envelope.error.code, "timeout");
    assert.match(envelope.error.hint ?? "", /operations wait op_01EXAMPLEGENERATE0000000/);
    assert.match(envelope.error.hint ?? "", /identical media generate command/);
    assert.equal(envelope.error.next?.command, `screenrig operations wait ${GENERATE_OPERATION}`);
    const firstKey = stuck.calls[0]?.headers?.["idempotency-key"];
    assert.ok(firstKey);

    const resumed = generateTransport();
    const second = await withRuntime(["--json", "media", "generate", "--prompt", PROMPT, "--quality", "high"], resumed, { configDir, fs: fsLike });
    assert.equal(second.code, ExitCode.Success, second.stdout);
    assert.equal(resumed.calls[0]?.headers?.["idempotency-key"], firstKey, "the identical command replays under the key, which returns the same operation");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("no generate request is held open: the POST and every poll keep the 30 s request budget", async () => {
  const transport = generateTransport({ running: 1 }).on("GET", "/api/media", () => ({
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
    for (const call of transport.calls) {
      assert.ok(call.timeout_ms !== undefined && call.timeout_ms <= 30_000, `${call.method} ${call.path} held open for ${call.timeout_ms} ms`);
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate reports elapsed_ms and announces that it waits", async () => {
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
    assert.equal(notice.timeout_ms, 180_000);
    assert.doesNotMatch(result.stderr, new RegExp(PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate --no-progress suppresses the notice while returning the generated media", async () => {
  const transport = generateTransport();
  const configDir = await testTemp("media-generate-no-progress-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["media", "generate", "--prompt", PROMPT, "--no-progress"],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.equal(result.stderr, "");
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { media: { id: string }; usage: { credits: number; usd: string } };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.media.id, GENERATED_MEDIA.id);
    assert.equal(envelope.data.usage.credits, GENERATE_DEBITS.medium.credits);
    assert.equal(envelope.data.usage.usd, GENERATE_DEBITS.medium.usd);
    assert.equal(transport.calls.length, 3, "the POST, one poll and the read of the stored still");
    assert.equal(transport.calls[0]?.method, "POST");
    assert.equal(transport.calls[0]?.path, "/api/media/generations");
    assert.deepEqual(transport.calls[0]?.body, {
      prompt: PROMPT,
      aspect_ratio: "16:9",
      quality: "medium",
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a generate that times out says the still may exist and names the command that checks", async () => {
  const transport = new FakeTransport().on("POST", "/api/media/generations", () => {
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
  const failing = new FakeTransport().on("POST", "/api/media/generations", () => {
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

    const secondFailing = new FakeTransport().on("POST", "/api/media/generations", () => {
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

    const different = new FakeTransport().on("POST", "/api/media/generations", () => {
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
  const refused = new FakeTransport().on("POST", "/api/media/generations", () => ({
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

test("media generate fails clearly on an empty 200 instead of reporting success", async () => {
  const transport = new FakeTransport().on("POST", "/api/media/generations", () => ({
    status: 200,
    headers: { "x-request-id": "req_EMPTYEMPTYEMPTYEMPTY" },
    body: undefined,
    rawText: "",
  }));
  const configDir = await testTemp("media-generate-empty-");
  const fsLike = await enrolled(configDir);
  try {
    const result = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT, "--tag", "lobby"],
      transport,
      { configDir, fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Unexpected, result.stdout);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; detail: string; hint?: string; request_id?: string; next?: { command: string } } };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "unexpected_response");
    assert.match(envelope.error.detail, /HTTP 200 with an empty body/);
    assert.equal(envelope.error.request_id, "req_EMPTYEMPTYEMPTYEMPTY");
    assert.match(envelope.error.hint ?? "", /media upload/);
    assert.equal(envelope.error.next?.command, "screenrig media list --tag lobby");
    assert.doesNotMatch(result.stdout, new RegExp(PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media generate 402 tells the agent to stop and use its own image tools, keeping a server hint", async () => {
  const problem = (extra: Record<string, unknown>) => new FakeTransport().on("POST", "/api/media/generations", () => ({
    status: 402,
    headers: { "content-type": "application/problem+json" },
    body: {
      type: "https://screenrig.ai/problems/payment-required",
      title: "Prepaid credit is required",
      status: 402,
      detail: "Prepaid credit remaining is below the generation debit.",
      code: "payment_required",
      ...extra,
    },
  }));
  const configDir = await testTemp("media-generate-402-hint-");
  const fsLike = await enrolled(configDir);
  try {
    const local = await withRuntime(["--json", "media", "generate", "--prompt", PROMPT], problem({}), { configDir, fs: fsLike });
    const localError = (JSON.parse(local.stdout) as { error: { hint?: string; next?: { command: string } } }).error;
    assert.match(localError.hint ?? "", /Stop retrying/);
    assert.match(localError.hint ?? "", /media upload/);
    assert.doesNotMatch(localError.hint ?? "", /buy|purchase|top.?up|stripe|x402/i);
    assert.equal(localError.next?.command, "screenrig billing balance");

    const served = await withRuntime(
      ["--json", "media", "generate", "--prompt", PROMPT],
      problem({ hint: "Server says: make the image yourself.", next: { command: "screenrig media upload FILE", reason: "Upload your own image.", argv: ["media", "upload", "FILE"] } }),
      { configDir, fs: fsLike },
    );
    const servedError = (JSON.parse(served.stdout) as { error: { hint?: string; next?: { command: string; argv?: string[] } } }).error;
    assert.equal(servedError.hint, "Server says: make the image yourself.");
    assert.equal(servedError.next?.command, "screenrig media upload FILE");
    assert.deepEqual(servedError.next?.argv, ["media", "upload", "FILE"]);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
