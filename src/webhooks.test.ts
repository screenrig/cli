import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { createMemoryLogger } from "./log/logger.js";
import type { OperationLogger } from "./log/types.js";
import { run, type CliRuntime } from "./main.js";
import { networkError } from "./problems.js";
import { redactText } from "./redact.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest } from "./transport/types.js";

const MISSING = "whk_MISSINGAAAAAAAAAAAAAA";
const URL_OK = "https://hooks.example.com/screenrig/rcv_token_in_path";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; next?: { command: string; reason: string }; errors?: unknown[] };
  warnings?: Array<{ code: string; message: string }>;
}

interface Env { fs: ConfigFs; cwd: string; configPath: string }

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<Env> {
  const configDir = await testTemp("webhooks-cfg-");
  const cwd = await testTemp("webhooks-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, logger?: OperationLogger): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr,
    now: () => new Date("2026-08-14T17:00:00.000Z"),
    sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
    ...(logger ? { logger } : {}),
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  const err = await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, stderr: err, envelope };
}

const webhookCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => call.path.startsWith("/api/v1/webhooks"));

async function create(transport: FakeTransport, env: Env, ...extra: string[]) {
  const created = await cli(["--json", "webhooks", "create", "--url", URL_OK, "--event-types", "screen.*,playlist.updated", ...extra], transport, env);
  assert.equal(created.code, 0, created.stdout);
  return created.envelope.data as { id: string; secret: string; revision: number };
}

test("webhooks create prints the secret once with a warning and never persists it", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { logger, events } = createMemoryLogger({ command: ["webhooks", "create"] });
  const created = await cli(["--json", "webhooks", "create", "--url", URL_OK, "--event-types", "screen.*,playlist.updated", "--description", "Ops bot"], transport, env, logger);
  assert.equal(created.code, 0, created.stdout);
  const call = webhookCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/v1/webhooks");
  assert.deepEqual(call.body, { url: URL_OK, event_types: ["screen.*", "playlist.updated"], description: "Ops bot" });
  assert.ok(call.headers?.["idempotency-key"], "create always sends an Idempotency-Key");
  assert.match(created.envelope.data.secret, /^whsec_/);
  assert.equal(created.envelope.data.enabled, true);
  assert.deepEqual(created.envelope.warnings?.map((warning) => warning.code), ["webhook_secret_shown_once"]);
  assert.match(created.envelope.warnings![0]!.message, /shown only in this answer/);
  assert.match(created.envelope.warnings![0]!.message, new RegExp(`rotate-secret ${created.envelope.data.id}`));

  const config = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(config, /whsec_/, "the secret never reaches config");
  assert.doesNotMatch(config, /pending_writes/, "a completed create clears its recovery entry");
  const logged = JSON.stringify(events);
  assert.ok(events.length > 0, "the operation log recorded the request");
  assert.doesNotMatch(logged, /whsec_/, "the secret never reaches the operation log");
  assert.doesNotMatch(logged, /rcv_token_in_path/, "webhook URLs never reach the operation log");

  const disabled = await cli(["--json", "webhooks", "create", "--url", URL_OK, "--event-types", "screen.offline", "--disabled"], transport, env);
  assert.equal(disabled.code, 0, disabled.stdout);
  assert.deepEqual(webhookCalls(transport).at(-1)!.body, { url: URL_OK, event_types: ["screen.offline"], enabled: false });

  const human = await cli(["--human", "webhooks", "create", "--url", URL_OK, "--event-types", "screen.online"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Created webhook whk_/m);
  assert.match(human.stdout, /^secret: whsec_\S+$/m);
  assert.match(human.stdout, /^warning: data\.secret is this webhook's signing secret/m);
});

test("an ambiguous create reruns with the saved key and the server replays the same secret", async () => {
  const env = await enrolled();
  const backend = memoryBackend();
  let lose = true;
  const original = backend.request.bind(backend);
  backend.request = async (req) => {
    const response = await original(req);
    if (lose && req.method === "POST" && req.path === "/api/v1/webhooks") {
      lose = false;
      throw networkError("connection reset after the request was sent");
    }
    return response;
  };
  const argv = ["--json", "webhooks", "create", "--url", URL_OK, "--event-types", "screen.*"];
  const lost = await cli(argv, backend, env);
  assert.equal(lost.code, ExitCode.Network, lost.stdout);
  assert.ok(lost.envelope.warnings?.some((warning) => warning.code === "write_recovery_saved"));
  const pending = await readFile(env.configPath, "utf8");
  assert.match(pending, /pending_writes/, "the key is saved for the rerun");
  assert.doesNotMatch(pending, /whsec_|hooks\.example\.com/, "the ledger holds no request or response content");

  const rerun = await cli(argv, backend, env);
  assert.equal(rerun.code, 0, rerun.stdout);
  const posts = webhookCalls(backend).filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.headers?.["idempotency-key"], posts[0]!.headers?.["idempotency-key"], "the rerun reuses the saved key");
  assert.match(rerun.envelope.data.secret, /^whsec_/);
  const listed = await cli(["--json", "webhooks", "list"], backend, env);
  assert.equal(listed.envelope.data.items.length, 1, "the replay did not create a second webhook");
  assert.equal(listed.envelope.data.items[0].id, rerun.envelope.data.id);
  assert.equal(listed.envelope.data.items[0].secret, undefined, "list never carries a secret");
  const after = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(after, /whsec_|pending_writes/);
});

test("webhooks create validates URL scheme and event types before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const cases: Array<[string[], RegExp]> = [
    [["--url", "http://hooks.example.com/x", "--event-types", "screen.*"], /absolute https URL/],
    [["--url", "not a url", "--event-types", "screen.*"], /absolute https URL/],
    [["--url", URL_OK, "--event-types", "screen"], /event types such as screen\.online/],
    [["--url", URL_OK, "--event-types", "screen.*,screen.*"], /must not repeat/],
    [["--url", URL_OK, "--event-types", "screen.online,,screen.offline"], /no empty entries/],
    [["--url", URL_OK, "--event-types", Array.from({ length: 33 }, (_, index) => `a.t${index}`).join(",")], /at most 32/],
    [["--url", URL_OK, "--event-types", "screen.*", "--description", "x".repeat(201)], /at most 200 characters/],
    [["--event-types", "screen.*"], /requires --url/],
    [["--url", "https://user:pass@hooks.example.com/x", "--event-types", "screen.*"], /must not carry credentials/],
    [["--url", "https://token@hooks.example.com/x", "--event-types", "screen.*"], /must not carry credentials/],
    [["--url", "https://hooks.example.com/x#frag", "--event-types", "screen.*"], /must not carry a fragment/],
  ];
  for (const [args, message] of cases) {
    const refused = await cli(["--json", "webhooks", "create", ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message);
  }
  assert.equal(webhookCalls(transport).length, 0, "invalid input never reaches the server");
});

test("webhook_url_rejected shows the server's reason, exits 8, and clears the recovery key", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  for (const [url, reason] of [
    ["https://hooks.example.com:8080/x", "url port must be 443 (the default) or 8443."],
    ["https://127.0.0.1/x", "url host must be a public Internet address."],
  ] as const) {
    const refused = await cli(["--json", "webhooks", "create", "--url", url, "--event-types", "screen.*"], transport, env);
    assert.equal(refused.code, ExitCode.Client, refused.stdout);
    assert.equal(refused.envelope.error!.code, "webhook_url_rejected");
    assert.equal(refused.envelope.error!.detail, `The webhook URL was rejected: ${reason}`);
    assert.match(refused.envelope.error!.next!.reason, /port 443 \(the default\) or 8443.*public Internet addresses/);
    assert.equal(refused.envelope.warnings, undefined, "a definite refusal keeps no recovery state");
  }
  const human = await cli(["--human", "webhooks", "create", "--url", "https://hooks.example.com:8080/x", "--event-types", "screen.*"], transport, env);
  assert.equal(human.code, ExitCode.Client);
  assert.match(human.stderr, /webhook_url_rejected\/400/);
  assert.match(human.stderr, /url port must be 443 \(the default\) or 8443/);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);

  const id = (await create(transport, env)).id;
  const update = await cli(["--json", "webhooks", "update", id, "--url", "https://hooks.example.com:9443/x"], transport, env);
  assert.equal(update.code, ExitCode.Client);
  assert.equal(update.envelope.error!.code, "webhook_url_rejected");
  assert.match(update.envelope.error!.detail, /port must be 443/);
});

test("webhook_limit_reached is a definite conflict: exit 5, guidance, no saved key", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  for (let index = 0; index < 10; index += 1) await create(transport, env, "--description", `hook ${index}`);
  const refused = await cli(["--json", "webhooks", "create", "--url", URL_OK, "--event-types", "screen.*"], transport, env);
  assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
  assert.equal(refused.envelope.error!.code, "webhook_limit_reached");
  assert.match(refused.envelope.error!.detail, /maximum of 10 webhooks/);
  assert.equal(refused.envelope.error!.next!.command, "screenrig webhooks list");
  assert.match(refused.envelope.error!.next!.reason, /webhooks delete ID/);
  assert.equal(refused.envelope.warnings, undefined);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
});

test("webhooks list and show render JSON by default and tables in human mode", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const empty = await cli(["--human", "webhooks", "list"], transport, env);
  assert.match(empty.stdout, /^Webhooks \(0\)\nNo webhooks$/m);
  const { id } = await create(transport, env, "--description", "Ops bot");
  const listed = await cli(["webhooks", "list"], transport, env);
  assert.equal(listed.code, 0);
  assert.equal(listed.envelope.data.items[0].id, id);
  const human = await cli(["--human", "webhooks", "list"], transport, env);
  assert.match(human.stdout, /ID\s+STATUS\s+ENABLED\s+EVENT_TYPES\s+URL/);
  assert.match(human.stdout, new RegExp(`${id}\\s+active\\s+true\\s+screen\\.\\*,playlist\\.updated\\s+https://hooks\\.example\\.com/`));
  assert.doesNotMatch(human.stdout, /whsec_/);

  const shown = await cli(["--json", "webhooks", "show", id], transport, env);
  assert.equal(shown.code, 0);
  assert.equal(webhookCalls(transport).at(-1)!.path, `/api/v1/webhooks/${id}`);
  assert.equal(shown.envelope.data.revision, 1);
  const shownHuman = await cli(["--human", "webhooks", "show", id], transport, env);
  assert.match(shownHuman.stdout, /^status: active$/m);
  assert.match(shownHuman.stdout, /^description: Ops bot$/m);

  const missing = await cli(["--json", "webhooks", "show", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
  const before = transport.calls.length;
  const malformed = await cli(["--json", "webhooks", "show", "scr_AAAAAAAAAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(malformed.code, ExitCode.Usage);
  assert.equal(malformed.envelope.error!.next!.command, "screenrig webhooks list");
  assert.equal(transport.calls.length, before, "a malformed id is refused locally");
});

test("webhooks update sends only supplied fields with the revision guard", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await create(transport, env, "--description", "Ops bot");

  const events = await cli(["--json", "webhooks", "update", id, "--event-types", "screen.offline", "--expect-rev", "1"], transport, env);
  assert.equal(events.code, 0, events.stdout);
  let call = webhookCalls(transport).at(-1)!;
  assert.equal(call.method, "PATCH");
  assert.deepEqual(call.body, { event_types: ["screen.offline"] });
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.equal(events.envelope.data.revision, 2);

  const disabled = await cli(["--json", "webhooks", "update", id, "--disable", "--clear-description"], transport, env);
  assert.equal(disabled.code, 0, disabled.stdout);
  call = webhookCalls(transport).at(-1)!;
  assert.deepEqual(call.body, { description: "", enabled: false });
  assert.equal(call.headers?.["if-match"], undefined, "no --expect-rev sends no If-Match");
  assert.equal(disabled.envelope.data.enabled, false);
  assert.equal(disabled.envelope.data.description, undefined);

  const enabled = await cli(["--human", "webhooks", "update", id, "--enable", "--url", "https://hooks.example.com:8443/next", "--description", "New"], transport, env);
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.deepEqual(webhookCalls(transport).at(-1)!.body, { url: "https://hooks.example.com:8443/next", description: "New", enabled: true });
  assert.match(enabled.stdout, new RegExp(`^Updated webhook ${id}$`, "m"));
  assert.match(enabled.stdout, /^enabled: true$/m);

  const stale = await cli(["--json", "webhooks", "update", id, "--disable", "--expect-rev", "1"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition, stale.stdout);
  assert.equal(stale.envelope.error!.code, "revision_conflict");
  assert.equal(stale.envelope.error!.next!.command, `screenrig webhooks show ${id}`);

  const before = transport.calls.length;
  for (const [args, message] of [
    [[], /at least one of --url or --event-types/],
    [["--enable", "--disable"], /Conflicting options/],
    [["--description", "x", "--clear-description"], /Conflicting options/],
    [["--url", "http://x.example.com/"], /absolute https URL/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "webhooks", "update", id, ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message);
  }
  assert.equal(transport.calls.length, before);
});

test("webhooks delete returns a deletion envelope and honors --expect-rev", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await create(transport, env);
  const stale = await cli(["--json", "webhooks", "delete", id, "--expect-rev", "7"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition);
  const deleted = await cli(["--json", "webhooks", "delete", id, "--expect-rev", "1"], transport, env);
  assert.equal(deleted.code, 0, deleted.stdout);
  const call = webhookCalls(transport).at(-1)!;
  assert.equal(call.method, "DELETE");
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.deepEqual(deleted.envelope.data, { id, deleted: true });
  const gone = await cli(["--human", "webhooks", "delete", id], transport, env);
  assert.equal(gone.code, ExitCode.NotFound);
  const { id: other } = await create(transport, env);
  const human = await cli(["--human", "webhooks", "delete", other], transport, env);
  assert.match(human.stdout, new RegExp(`^Deleted webhook ${other}\\. Its pending deliveries fail with webhook_deleted\\.$`, "m"));
});

test("webhooks rotate-secret prints the new secret once and never persists it", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const first = await create(transport, env);
  const rotated = await cli(["--json", "webhooks", "rotate-secret", first.id, "--expect-rev", "1"], transport, env);
  assert.equal(rotated.code, 0, rotated.stdout);
  const call = webhookCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/v1/webhooks/${first.id}/rotate-secret`);
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.match(rotated.envelope.data.secret, /^whsec_/);
  assert.notEqual(rotated.envelope.data.secret, first.secret);
  assert.equal(rotated.envelope.warnings?.[0]?.code, "webhook_secret_shown_once");
  assert.match(rotated.envelope.warnings![0]!.message, /accept both briefly/);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /whsec_|pending_writes/);
  const human = await cli(["--human", "webhooks", "rotate-secret", first.id], transport, env);
  assert.match(human.stdout, new RegExp(`^Rotated the signing secret of webhook ${first.id}$`, "m"));
  assert.match(human.stdout, /^secret: whsec_/m);
  const missing = await cli(["--json", "webhooks", "rotate-secret", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
});

test("webhooks test queues one delivery and deliveries pages the log", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await create(transport, env);
  const tested = await cli(["--json", "webhooks", "test", id], transport, env);
  assert.equal(tested.code, 0, tested.stdout);
  const call = webhookCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/v1/webhooks/${id}/test`);
  assert.ok(call.headers?.["idempotency-key"]);
  assert.equal(tested.envelope.data.event_type, "webhook.test");
  assert.equal(tested.envelope.data.test, true);
  const human = await cli(["--human", "webhooks", "test", id], transport, env);
  assert.match(human.stdout, new RegExp(`^Queued a test delivery to webhook ${id}$`, "m"));
  assert.match(human.stdout, new RegExp(`screenrig webhooks deliveries ${id} --limit 1`));

  const page = await cli(["--json", "webhooks", "deliveries", id, "--limit", "1"], transport, env);
  assert.equal(page.code, 0, page.stdout);
  assert.deepEqual(webhookCalls(transport).at(-1)!.query, { limit: "1" });
  assert.equal(page.envelope.data.items.length, 1);
  assert.equal(page.envelope.data.next_cursor, "whc1_1");
  const nextPage = await cli(["--json", "webhooks", "deliveries", id, "--before", "whc1_1"], transport, env);
  assert.deepEqual(webhookCalls(transport).at(-1)!.query, { before: "whc1_1" });
  assert.equal(nextPage.envelope.data.next_cursor, null);
  const table = await cli(["--human", "webhooks", "deliveries", id, "--limit", "1"], transport, env);
  assert.match(table.stdout, /ID\s+EVENT_TYPE\s+STATE\s+ATTEMPTS\s+LAST_STATUS\s+LAST_ERROR\s+CREATED_AT/);
  assert.match(table.stdout, /webhook\.test \(test\)\s+pending\s+0/);
  assert.match(table.stdout, new RegExp(`^next: screenrig webhooks deliveries ${id} --before whc1_1 --limit 1$`, "m"));

  const before = transport.calls.length;
  for (const args of [["--before", "cursor"], ["--limit", "0"], ["--limit", "201"], ["--limit", "1.5"]]) {
    const refused = await cli(["--json", "webhooks", "deliveries", id, ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
  }
  assert.equal(transport.calls.length, before);
  const missing = await cli(["--json", "webhooks", "deliveries", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
});

test("webhook test rate limiting keeps the exit-7 convention", async () => {
  const env = await enrolled();
  const id = "whk_LIMITEDAAAAAAAAAAAAAAA";
  const transport = new FakeTransport().on("POST", `/api/v1/webhooks/${id}/test`, () => ({
    status: 429, headers: { "content-type": "application/problem+json", "retry-after": "12" },
    body: { status: 429, code: "rate_limited", title: "Too many requests", detail: "webhook-test-project limit reached." },
  }));
  const limited = await cli(["--json", "webhooks", "test", id], transport, env);
  assert.equal(limited.code, ExitCode.RateLimited, limited.stdout);
  assert.equal(limited.envelope.error!.code, "rate_limited");
  assert.equal(limited.envelope.error!.next!.command, "retry the same command");
});

test("a secret answer that stdout cannot accept keeps the saved key for a replay", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const argv = ["--json", "webhooks", "create", "--url", URL_OK, "--event-types", "screen.*"];
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    },
  });
  broken.on("error", () => undefined);
  const stderr = new PassThrough();
  const errP = collect(stderr);
  const code = await run({
    argv, env: env.fs.env, stdout: broken as unknown as CliRuntime["stdout"], stderr,
    now: () => new Date("2026-08-14T17:00:00.000Z"), sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  });
  stderr.end();
  assert.equal(code, ExitCode.Unexpected, "a lost secret answer is a failure");
  assert.match(await errP, /saved write key is kept; rerun the identical command within 24 hours/);
  const pending = await readFile(env.configPath, "utf8");
  assert.match(pending, /pending_writes/, "the key survives the failed write");
  assert.doesNotMatch(pending, /whsec_/);

  const rerun = await cli(argv, transport, env);
  assert.equal(rerun.code, 0, rerun.stdout);
  const posts = webhookCalls(transport).filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.headers?.["idempotency-key"], posts[0]!.headers?.["idempotency-key"]);
  const listed = await cli(["--json", "webhooks", "list"], transport, env);
  assert.equal(listed.envelope.data.items.length, 1, "the replay returned the first webhook");
  assert.equal(listed.envelope.data.items[0].id, rerun.envelope.data.id);
  assert.match(rerun.envelope.data.secret, /^whsec_/);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes|whsec_/, "a flushed answer clears the key");
});

test("a 2xx answer without a secret clears the saved key and points at rotate-secret", async () => {
  const env = await enrolled();
  const id = "whk_NOSECRETAAAAAAAAAAAAAA";
  const webhook = { id, url: URL_OK, event_types: ["screen.*"], enabled: true, revision: 1, status: "active", created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:00.000Z" };
  const transport = new FakeTransport()
    .on("POST", "/api/v1/webhooks", () => ({ status: 201, headers: {}, body: webhook }))
    .on("POST", `/api/v1/webhooks/${id}/rotate-secret`, () => ({ status: 200, headers: {}, body: { ...webhook, revision: 2 } }));
  for (const argv of [["webhooks", "create", "--url", URL_OK, "--event-types", "screen.*"], ["webhooks", "rotate-secret", id]]) {
    const answered = await cli(["--json", ...argv], transport, env);
    assert.equal(answered.code, ExitCode.Unexpected, answered.stdout);
    assert.equal(answered.envelope.error!.code, "unexpected_response");
    assert.match(answered.envelope.error!.detail, /Do not rerun it/);
    assert.equal(answered.envelope.error!.next!.command, `screenrig webhooks rotate-secret ${id}`);
    assert.equal(answered.envelope.warnings, undefined, "no write_recovery_saved: a rerun would not help");
    assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
  }
});

test("problem answers on webhook routes keep their bodies out of the operation log", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("POST", "/api/v1/webhooks", () => ({
    status: 400, headers: { "content-type": "application/problem+json" },
    body: { status: 400, code: "webhook_url_rejected", title: "Rejected", detail: "url host must be a public Internet address.", errors: [{ field: "url", detail: "rcv_token_in_path" }] },
  }));
  const { logger, events } = createMemoryLogger({ command: ["webhooks", "create"] });
  const refused = await cli(["--json", "webhooks", "create", "--url", URL_OK, "--event-types", "screen.*"], transport, env, logger);
  assert.equal(refused.code, ExitCode.Client);
  assert.ok(events.length > 0);
  assert.doesNotMatch(JSON.stringify(events), /rcv_token_in_path/);
});

test("redaction masks webhook secrets in free text", () => {
  assert.equal(redactText("secret whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA end"), "secret whsec_*** end");
});
