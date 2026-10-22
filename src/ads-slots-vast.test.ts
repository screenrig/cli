import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { commandHelp } from "./help.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const API_URL = "https://api.screenrig.ai";
const TOKEN = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
const HEADERS = { "cache-control": "private, no-store" };
const VAST = "https://ads.example.com/vast?cb=[CACHEBUSTING]&screen=[SCREENRIG_SCREEN_ID]";
const OTHER_VAST = "https://ads.example.com:8443/other.xml";

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
    now: () => new Date("2026-10-21T17:00:00.000Z"), sleep: async () => undefined,
    homedir: fsLike.homedir, cwd: () => configDir, fs: fsLike, transport,
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

function slotTransport(stored: Record<string, unknown>): { transport: FakeTransport; writes: Array<Record<string, unknown>> } {
  const writes: Array<Record<string, unknown>> = [];
  const transport = new FakeTransport()
    .on("GET", "/api/advertising/slots", () => ({ status: 200, headers: HEADERS, body: { slots: [stored] } }))
    .on("POST", "/api/advertising/slots/ads_TEST", (request) => {
      assert.equal(request.headers?.["if-match"], '"3"');
      writes.push(request.body as Record<string, unknown>);
      return { status: 200, headers: HEADERS, body: { ...(request.body as object), id: "ads_TEST", revision: 4 } };
    })
    .on("POST", "/api/advertising/slots", (request) => {
      writes.push(request.body as Record<string, unknown>);
      return { status: 201, headers: HEADERS, body: { ...(request.body as object), id: "ads_NEW", revision: 1, muted: true } };
    });
  return { transport, writes };
}

const slot = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "ads_TEST", revision: 3, name: "Lobby video", enabled: true, accepted_media: ["video"],
  max_image_duration_ms: 15000, max_video_duration_ms: 30000, rate_override_mcr_per_15s: null, ...extra,
});

test("ads slot commands list the VAST flags and only update can clear the tag", () => {
  const create = commandHelp(["ads", "slots", "create"]);
  const update = commandHelp(["ads", "slots", "update"]);
  assert.ok(create.options.some((option) => option.name === "--vast-tag-url"));
  assert.ok(update.options.some((option) => option.name === "--vast-tag-url"));
  assert.ok(update.options.some((option) => option.name === "--clear-vast-tag-url"));
  assert.equal(create.options.some((option) => option.name === "--clear-vast-tag-url"), false);
});

test("ads slots create sends the VAST tag beside the canonical body", async () => {
  const configDir = await testTemp("ads-vast-create-");
  await enrolled(configDir);
  const { transport, writes } = slotTransport(slot());
  try {
    const created = await withRuntime(["--json", "ads", "slots", "create", "--name", "Lobby video", "--accepted-media", "video", "--vast-tag-url", VAST], transport, configDir);
    assert.equal(created.code, ExitCode.Success, created.stdout);
    assert.deepEqual(writes, [{
      enabled: true, name: "Lobby video", accepted_media: ["video"],
      max_image_duration_ms: 30000, max_video_duration_ms: 30000, vast_tag_url: VAST,
    }]);
    const plain = await withRuntime(["--json", "ads", "slots", "create", "--name", "Lobby", "--accepted-media", "image"], transport, configDir);
    assert.equal(plain.code, ExitCode.Success, plain.stdout);
    assert.equal("vast_tag_url" in writes[1]!, false, "no flag sends no tag");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("ads slots update keeps, replaces and clears the stored VAST tag", async () => {
  const configDir = await testTemp("ads-vast-update-");
  await enrolled(configDir);
  const { transport, writes } = slotTransport(slot({ vast_tag_url: VAST }));
  try {
    const renamed = await withRuntime(["--json", "ads", "slots", "update", "ads_TEST", "--name", "Renamed", "--expect-rev", "3"], transport, configDir);
    assert.equal(renamed.code, ExitCode.Success, renamed.stdout);
    assert.deepEqual(writes[0], {
      name: "Renamed", enabled: true, accepted_media: ["video"], max_image_duration_ms: 15000, max_video_duration_ms: 30000,
      rate_override_mcr_per_15s: null, vast_tag_url: VAST,
    });
    const replace = await withRuntime(["--json", "ads", "slots", "update", "ads_TEST", "--vast-tag-url", OTHER_VAST, "--expect-rev", "3"], transport, configDir);
    assert.equal(replace.code, ExitCode.Success, replace.stdout);
    assert.equal(writes[1]!.vast_tag_url, OTHER_VAST);
    assert.equal(writes[1]!.name, "Lobby video", "other fields keep the stored record");
    const clear = await withRuntime(["--json", "ads", "slots", "update", "ads_TEST", "--clear-vast-tag-url", "--expect-rev", "3"], transport, configDir);
    assert.equal(clear.code, ExitCode.Success, clear.stdout);
    assert.equal(writes[2]!.vast_tag_url, null);
    assert.equal(writes[2]!.name, "Lobby video");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("ads slots update omits the VAST tag when none is stored", async () => {
  const configDir = await testTemp("ads-vast-none-");
  await enrolled(configDir);
  const { transport, writes } = slotTransport(slot());
  try {
    const result = await withRuntime(["--json", "ads", "slots", "update", "ads_TEST", "--name", "Renamed", "--expect-rev", "3"], transport, configDir);
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.equal("vast_tag_url" in writes[0]!, false);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("ads slots refuse a VAST tag that is not an HTTPS URL, or both set and clear, before any request", async () => {
  const configDir = await testTemp("ads-vast-refuse-");
  await enrolled(configDir);
  const { transport } = slotTransport(slot({ vast_tag_url: VAST }));
  try {
    for (const argv of [
      ["ads", "slots", "create", "--name", "x", "--accepted-media", "video", "--vast-tag-url", "http://ads.example.com/vast.xml"],
      ["ads", "slots", "create", "--name", "x", "--accepted-media", "video", "--vast-tag-url", "ads.example.com/vast.xml"],
      ["ads", "slots", "create", "--name", "x", "--accepted-media", "video", "--vast-tag-url", `https://ads.example.com/${"a".repeat(2048)}`],
      ["ads", "slots", "update", "ads_TEST", "--expect-rev", "3", "--vast-tag-url", "ftp://ads.example.com/vast.xml"],
      ["ads", "slots", "update", "ads_TEST", "--expect-rev", "3", "--vast-tag-url", VAST, "--clear-vast-tag-url"],
      ["ads", "slots", "create", "--name", "x", "--accepted-media", "video", "--clear-vast-tag-url"],
    ]) {
      const result = await withRuntime(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    }
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
