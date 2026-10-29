import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const API_URL = "https://api.screenrig.ai";
const TOKEN = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
const FILE = "med_AAAAAAAAAAAAAAAAAAAAAAAA";
const RULE = { from: "2026-11-27T00:00", until: "2026-11-30T00:00", except: ["2026-11-29"] };

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

async function withRuntime(argv: string[], transport: FakeTransport, configDir: string): Promise<{ code: number; stdout: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const fsLike = realFs(configDir);
  const runtime: CliRuntime = {
    argv, env: fsLike.env, stdout, stderr,
    now: () => new Date("2026-10-29T17:00:00.000Z"), sleep: async () => undefined,
    homedir: fsLike.homedir, cwd: () => configDir, fs: fsLike, transport, signedRawPut: async () => ({ status: 200 }),
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  await errP;
  return { code, stdout: await outP };
}

async function enrolled(configDir: string): Promise<void> {
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: API_URL, token: TOKEN, project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization" },
    realFs(configDir),
  );
}

const json = (status: number, body: unknown) => ({ status, headers: { "content-type": "application/json" }, body });
const media = (extra: Record<string, unknown> = {}) => ({ id: FILE, filename: "sale.png", primitive: "image", revision: 4, ...extra });

function backend(): FakeTransport {
  return new FakeTransport()
    .on("GET", `/api/media/${FILE}`, () => json(200, media()))
    .on("PATCH", `/api/media/${FILE}/availability`, (request) => json(200, media({ revision: 5, ...((request.body as { availability: unknown }).availability === null ? {} : { availability: (request.body as { availability: unknown }).availability }) })));
}

test("media availability is in help with its options and examples", () => {
  const help = commandHelp(["media", "availability"]);
  assert.match(help.synopsis[0]!, /media availability/);
  assert.ok(help.options.some((option) => option.name === "--file"));
  assert.ok(help.options.some((option) => option.name === "--clear"));
});

test("media availability --file sends the rule with the revision it read first", async () => {
  const configDir = await testTemp("media-availability-");
  await enrolled(configDir);
  const transport = backend();
  try {
    await writeFile(path.join(configDir, "rule.json"), JSON.stringify(RULE));
    const result = await withRuntime(["--json", "media", "availability", FILE, "--file", "rule.json"], transport, configDir);
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.deepEqual(transport.calls.map((call) => `${call.method} ${call.path}`), [`GET /api/media/${FILE}`, `PATCH /api/media/${FILE}/availability`]);
    const patch = transport.calls.at(-1)!;
    assert.deepEqual(patch.body, { availability: RULE });
    assert.equal(patch.headers?.["if-match"], '"4"');
    assert.ok(patch.headers?.["idempotency-key"]);
    assert.deepEqual((JSON.parse(result.stdout) as { data: { availability: unknown } }).data.availability, RULE);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media availability --expect-rev skips the read, and --clear sends null", async () => {
  const configDir = await testTemp("media-availability-clear-");
  await enrolled(configDir);
  const transport = backend();
  try {
    const result = await withRuntime(["--json", "media", "availability", FILE, "--clear", "--expect-rev", "7"], transport, configDir);
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.deepEqual(transport.calls.map((call) => `${call.method} ${call.path}`), [`PATCH /api/media/${FILE}/availability`]);
    assert.deepEqual(transport.calls[0]!.body, { availability: null });
    assert.equal(transport.calls[0]!.headers?.["if-match"], '"7"');
    assert.equal((JSON.parse(result.stdout) as { data: { availability?: unknown } }).data.availability, undefined);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media availability reads the rule from stdin", async () => {
  const configDir = await testTemp("media-availability-stdin-");
  await enrolled(configDir);
  const transport = backend();
  try {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outP = collect(stdout);
    const errP = collect(stderr);
    const stdin = new PassThrough();
    stdin.end(JSON.stringify({ windows: [{ days: ["mon", "tue"], start: "17:00", end: "22:00" }] }));
    const fsLike = realFs(configDir);
    const code = await run({
      argv: ["--json", "media", "availability", FILE, "--file", "-"], env: fsLike.env, stdout, stderr, stdin, isStdinTty: () => false,
      now: () => new Date("2026-10-29T17:00:00.000Z"), sleep: async () => undefined,
      homedir: fsLike.homedir, cwd: () => configDir, fs: fsLike, transport, signedRawPut: async () => ({ status: 200 }),
    } as CliRuntime);
    stdout.end(); stderr.end(); await errP;
    assert.equal(code, ExitCode.Success, await outP);
    assert.deepEqual(transport.calls.at(-1)!.body, { availability: { windows: [{ days: ["mon", "tue"], start: "17:00", end: "22:00" }] } });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media availability refuses bad input before any request", async () => {
  const configDir = await testTemp("media-availability-usage-");
  await enrolled(configDir);
  const transport = backend();
  try {
    await writeFile(path.join(configDir, "rule.json"), JSON.stringify(RULE));
    await writeFile(path.join(configDir, "broken.json"), "{not json");
    await writeFile(path.join(configDir, "empty.json"), "{}");
    await writeFile(path.join(configDir, "list.json"), "[]");
    await writeFile(path.join(configDir, "data.json"), JSON.stringify({ from: "2026-11-27T00:00", data: {} }));
    await writeFile(path.join(configDir, "unknown.json"), JSON.stringify({ between: "x" }));
    const cases: Array<[string[], RegExp]> = [
      [["media", "availability", FILE], /exactly one of --file/],
      [["media", "availability", FILE, "--file", "rule.json", "--clear"], /exactly one of --file/],
      [["media", "availability", FILE, "--file", "broken.json"], /not valid JSON/],
      [["media", "availability", FILE, "--file", "missing.json"], /does not exist/],
      [["media", "availability", FILE, "--file", "empty.json"], /empty rule/],
      [["media", "availability", FILE, "--file", "list.json"], /one JSON object/],
      [["media", "availability", FILE, "--file", "data.json"], /remove .{1,2}data.{1,2} from/],
      [["media", "availability", FILE, "--file", "unknown.json"], /does not take/],
      [["media", "availability", "poster.png", "--file", "rule.json"], /media ID/],
      [["media", "availability", FILE, "--file", "rule.json", "--expect-rev", "x"], /--expect-rev/],
    ];
    for (const [argv, pattern] of cases) {
      const result = await withRuntime(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
      assert.match(JSON.stringify(JSON.parse(result.stdout)), pattern, argv.join(" "));
    }
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media selector-preview passes --timezone and returns outside_window files", async () => {
  const configDir = await testTemp("media-selector-timezone-");
  await enrolled(configDir);
  const selector = { by: "tag", tag: "Sale" };
  const transport = new FakeTransport().on("POST", "/api/selectors/preview", () => json(200, {
    matched_count: 1, candidates: [{ media_id: "med_a", filename: "a.png" }], selector,
    excluded: [{ media_id: "med_b", filename: "b.png", reason: "outside_window" }],
  }));
  try {
    await writeFile(path.join(configDir, "selector.json"), JSON.stringify(selector));
    const zoned = await withRuntime(["media", "selector-preview", "selector.json", "--primitive", "image", "--timezone", "America/New_York"], transport, configDir);
    assert.equal(zoned.code, ExitCode.Success, zoned.stdout);
    assert.deepEqual(transport.calls.at(-1)!.body, { primitive: "image", selector, timezone: "America/New_York" });
    assert.equal((JSON.parse(zoned.stdout) as { data: { excluded: Array<{ reason: string }> } }).data.excluded[0]?.reason, "outside_window");
    const plain = await withRuntime(["media", "selector-preview", "selector.json", "--primitive", "image"], transport, configDir);
    assert.equal(plain.code, ExitCode.Success, plain.stdout);
    assert.deepEqual(transport.calls.at(-1)!.body, { primitive: "image", selector });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
