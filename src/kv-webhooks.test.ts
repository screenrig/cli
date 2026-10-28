import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { kvWebhookExample } from "./kv-webhooks.js";
import { createMemoryLogger } from "./log/logger.js";
import type { OperationLogger } from "./log/types.js";
import { run, type CliRuntime } from "./main.js";
import { isSensitiveValue, redactText } from "./redact.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest } from "./transport/types.js";

const APP = "app_AAAAAAAAAAAAAAAAAAAAAAAA";
const MISSING = "kvw_MISSINGAAAAAAAAAAAAAAA";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; next?: { command: string; reason: string } };
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
  const configDir = await testTemp("kv-webhooks-cfg-");
  const cwd = await testTemp("kv-webhooks-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
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

const webhookCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => call.path.includes("/kv-webhooks"));

async function create(transport: FakeTransport, env: Env, key = "menu") {
  const created = await cli(["--json", "kv", "webhook", "create", key, "--app-id", APP], transport, env);
  assert.equal(created.code, 0, created.stdout);
  return created.envelope.data as { id: string; secret: string; key: string; url: string };
}

test("kv webhook create sends the key and description, prints the secret once, and keeps it out of config and logs", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { logger, events } = createMemoryLogger({ command: ["kv", "webhook", "create"] });
  const created = await cli(["--json", "kv", "webhook", "create", "menu", "--app-id", APP, "--description", "  Point of sale "], transport, env, logger);
  assert.equal(created.code, 0, created.stdout);
  const call = webhookCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/applications/${APP}/kv-webhooks`);
  assert.deepEqual(call.body, { key: "menu", description: "Point of sale" });
  assert.ok(call.headers?.["idempotency-key"], "create always sends an Idempotency-Key");
  assert.match(created.envelope.data.id, /^kvw_/);
  assert.match(created.envelope.data.secret, /^srkw_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.envelope.data.url, `https://api.screenrig.ai/api/applications/${APP}/kv-webhooks/${created.envelope.data.id}/write`);
  assert.deepEqual(created.envelope.warnings?.map((warning) => warning.code), ["kv_webhook_secret_shown_once"]);
  assert.match(created.envelope.warnings![0]!.message, /Authorization: Bearer <data\.secret>/);
  assert.doesNotMatch(created.envelope.warnings![0]!.message, /srkw_[A-Za-z0-9_-]{43}/, "the warning never repeats the secret");

  const config = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(config, /srkw_/, "the secret never reaches config");
  assert.doesNotMatch(config, /pending_writes/, "a completed create clears its recovery entry");
  assert.ok(events.length > 0, "the operation log recorded the request");
  assert.doesNotMatch(JSON.stringify(events), /srkw_[A-Za-z0-9_-]{43}/, "the secret never reaches the operation log");

  const legacy = await cli(["--json", "kv", "webhook", "create", "prices", "--application-id", APP], transport, env);
  assert.equal(legacy.code, 0, legacy.stdout);
  assert.deepEqual(webhookCalls(transport).at(-1)!.body, { key: "prices" });

  const human = await cli(["--human", "kv", "webhook", "create", "weather", "--app-id", APP], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Created K\/V webhook kvw_\S+$/m);
  assert.match(human.stdout, /^key: weather$/m);
  assert.match(human.stdout, /^url: https:\/\/api\.screenrig\.ai\/api\/applications\/app_\S+\/kv-webhooks\/kvw_\S+\/write$/m);
  assert.match(human.stdout, /^Sensitive webhook secret \(store it only in the system that posts to the url above\)\nsecret: srkw_\S{43}$/m);
  assert.match(human.stdout, /^example: curl -X POST "https:\/\/api\.screenrig\.ai\/\S+\/write" -H "Authorization: Bearer srkw_\S{43}" -H "Content-Type: application\/json" --data '\{"message":"Hello"\}'$/m);
  assert.match(human.stdout, /^warning: data\.secret is this webhook's secret and is shown only in this answer\./m);
});

test("kv webhook create refuses a bad key, description or missing application before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  for (const argv of [
    ["menu"],
    ["--app-id", APP],
    ["-menu", "--app-id", APP],
    ["menu items", "--app-id", APP],
    ["k".repeat(257), "--app-id", APP],
    ["menu", "--app-id", APP, "--description", "x".repeat(201)],
    ["menu", "--app-id", APP, "--description", "line\nbreak"],
  ]) {
    const result = await cli(["--json", "kv", "webhook", "create", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
  }
  assert.equal(webhookCalls(transport).length, 0);
  const fake = "srkw_" + "S".repeat(43);
  assert.equal(kvWebhookExample("https://api.screenrig.ai/w", fake), `curl -X POST "https://api.screenrig.ai/w" -H "Authorization: Bearer ${fake}" -H "Content-Type: application/json" --data '{"message":"Hello"}'`);
});

test("kv webhook list never carries a secret; rotate-secret prints a new one once; delete stops the URL", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const webhook = await create(transport, env);

  const list = await cli(["--json", "kv", "webhook", "list", "--app-id", APP], transport, env);
  assert.equal(list.code, 0, list.stdout);
  assert.deepEqual(list.envelope.data.items.map((item: { id: string }) => item.id), [webhook.id]);
  assert.doesNotMatch(list.stdout, /srkw_/, "list never carries a secret");
  assert.equal(webhookCalls(transport).at(-1)!.method, "GET");
  const listHuman = await cli(["--human", "kv", "webhook", "list", "--app-id", APP], transport, env);
  assert.match(listHuman.stdout, /^K\/V webhooks \(1\)$/m);
  assert.match(listHuman.stdout, /^ID\s+KEY\s+LAST_USED\s+URL\s+DESCRIPTION$/m);
  assert.match(listHuman.stdout, new RegExp(`^${webhook.id}\\s+menu\\s+-\\s+https://\\S+/write$`, "m"));

  const rotated = await cli(["--json", "kv", "webhook", "rotate-secret", webhook.id, "--app-id", APP], transport, env);
  assert.equal(rotated.code, 0, rotated.stdout);
  const rotateCall = webhookCalls(transport).at(-1)!;
  assert.equal(rotateCall.method, "POST");
  assert.equal(rotateCall.path, `/api/applications/${APP}/kv-webhooks/${webhook.id}/rotate-secret`);
  assert.ok(rotateCall.headers?.["idempotency-key"]);
  assert.match(rotated.envelope.data.secret, /^srkw_/);
  assert.notEqual(rotated.envelope.data.secret, webhook.secret);
  assert.deepEqual(rotated.envelope.warnings?.map((warning) => warning.code), ["kv_webhook_secret_shown_once"]);
  assert.match(rotated.envelope.warnings![0]!.message, /previous secret stopped working/);
  const rotatedHuman = await cli(["--human", "kv", "webhook", "rotate-secret", webhook.id, "--app-id", APP], transport, env);
  assert.match(rotatedHuman.stdout, /^Rotated the secret of K\/V webhook kvw_\S+\n/m);
  assert.match(rotatedHuman.stdout, /^secret: srkw_\S{43}$/m);
  const config = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(config, /srkw_/);

  const deleted = await cli(["--json", "kv", "webhook", "delete", webhook.id, "--app-id", APP], transport, env);
  assert.equal(deleted.code, 0, deleted.stdout);
  assert.deepEqual(deleted.envelope.data, { id: webhook.id, deleted: true });
  const deleteCall = webhookCalls(transport).at(-1)!;
  assert.equal(deleteCall.method, "DELETE");
  assert.ok(deleteCall.headers?.["idempotency-key"]);
  const empty = await cli(["--human", "kv", "webhook", "list", "--app-id", APP], transport, env);
  assert.match(empty.stdout, /^No K\/V webhooks$/m);
});

test("kv webhook maps not_found and the application limit to guidance", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const missing = await cli(["--json", "kv", "webhook", "rotate-secret", MISSING, "--app-id", APP], transport, env);
  assert.equal(missing.code, ExitCode.NotFound, missing.stdout);
  assert.equal(missing.envelope.error?.next?.command, `screenrig kv webhook list --app-id ${APP}`);

  const noApp = await cli(["--json", "kv", "webhook", "list", "--app-id", "app_MISSINGAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(noApp.code, ExitCode.NotFound, noApp.stdout);
  assert.equal(noApp.envelope.error?.next?.command, "screenrig app list");

  const badId = await cli(["--json", "kv", "webhook", "delete", "trg_AAAAAAAAAAAAAAAA", "--app-id", APP], transport, env);
  assert.equal(badId.code, ExitCode.Usage, badId.stdout);
  assert.equal(webhookCalls(transport).filter((call) => call.path.includes("trg_")).length, 0);

  for (let index = 0; index < 20; index += 1) await create(transport, env, `key${index}`);
  const limited = await cli(["--json", "kv", "webhook", "create", "one-more", "--app-id", APP], transport, env);
  assert.equal(limited.code, ExitCode.Conflict, limited.stdout);
  assert.equal(limited.envelope.error?.code, "kv_webhook_limit_reached");
  assert.match(limited.envelope.error?.detail ?? "", /maximum of 20 K\/V webhooks/);
  assert.equal(limited.envelope.error?.next?.command, `screenrig kv webhook list --app-id ${APP}`);
});

test("srkw_ secrets are redacted from text and recognized as sensitive", () => {
  const secret = "srkw_" + "Q".repeat(43);
  assert.equal(redactText(`Basic kvw_A:${secret}`), "Basic kvw_A:srkw_***");
  assert.equal(isSensitiveValue(secret), true);
});

const CARD = "crd_AAAAAAAAAAAAAAAAAAAAAAAA";
const MAP = JSON.stringify({ title: "{{body.alert.title}}", items: { $each: "{{body.items}}", $limit: 20, $template: { text: "{{item.name}}" } } });

async function writeMap(env: Env, name: string, text: string): Promise<string> {
  await writeFile(path.join(env.cwd, name), text);
  return name;
}

test("kv webhook create --card sends the mapping and signing, prints both secrets once, and keeps them out of config and logs", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { logger, events } = createMemoryLogger({ command: ["kv", "webhook", "create"] });
  const file = await writeMap(env, "alert-map.json", MAP);
  const created = await cli(["--json", "kv", "webhook", "create", "--card", CARD, "--map", file, "--signing", "--description", "  CMS alerts "], transport, env, logger);
  assert.equal(created.code, 0, created.stdout);
  const call = webhookCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/cards/${CARD}/kv-webhooks`);
  assert.deepEqual(call.body, { description: "CMS alerts", mapping: JSON.parse(MAP), signing: true });
  assert.ok(call.headers?.["idempotency-key"], "create always sends an Idempotency-Key");
  assert.match(created.envelope.data.id, /^kvw_/);
  assert.match(created.envelope.data.secret, /^srkw_[A-Za-z0-9_-]{43}$/);
  assert.match(created.envelope.data.signing_secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.envelope.data.url, `https://api.screenrig.ai/api/cards/${CARD}/kv-webhooks/${created.envelope.data.id}/write`);
  assert.deepEqual(created.envelope.warnings?.map((warning) => warning.code), ["kv_webhook_secret_shown_once", "kv_webhook_signing_secret_shown_once"]);
  for (const warning of created.envelope.warnings ?? []) {
    assert.doesNotMatch(warning.message, /srkw_[A-Za-z0-9_-]{43}|whsec_[A-Za-z0-9_-]{43}/, "a warning never repeats a secret");
  }
  assert.match(created.envelope.warnings![1]!.message, /ScreenRig-Signature: t=<unix seconds>,v1=/);
  const config = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(config, /srkw_|whsec_/, "no secret reaches config");
  assert.doesNotMatch(config, /pending_writes/, "a completed create clears its recovery entry");
  assert.ok(events.length > 0, "the operation log recorded the request");
  assert.doesNotMatch(JSON.stringify(events), /srkw_[A-Za-z0-9_-]{43}|whsec_[A-Za-z0-9_-]{43}/, "no secret reaches the operation log");

  const human = await cli(["--human", "kv", "webhook", "create", "--card", CARD, "--signing"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Created card webhook kvw_\S+$/m);
  assert.match(human.stdout, /^card_id: crd_\S+$/m);
  assert.match(human.stdout, /^mapping: \(none: the posted object is the document\)$/m);
  assert.match(human.stdout, /^signing: true$/m);
  assert.match(human.stdout, /^secret: srkw_\S{43}$/m);
  assert.match(human.stdout, /^signing_secret: whsec_\S{43}$/m);
  assert.match(human.stdout, /^example: body='\{"message":"Hello"\}'; t=\$\(date \+%s\); sig=.*"\$SIGNING_SECRET".*ScreenRig-Signature: t=\$t,v1=\$sig/m);

  const plain = await cli(["--human", "kv", "webhook", "create", "--card", CARD], transport, env);
  assert.deepEqual(webhookCalls(transport).at(-1)!.body, {});
  assert.match(plain.stdout, /^example: curl -X POST "https:\/\/api\.screenrig\.ai\/api\/cards\/\S+\/write" -H "Authorization: Bearer srkw_\S{43}" -H "Content-Type: application\/json" --data '\{"message":"Hello"\}'$/m);
  assert.doesNotMatch(plain.stdout, /signing_secret/);

  const stdin = await cli(["--json", "kv", "webhook", "create", "--card", CARD, "--map", "-"], transport, env);
  assert.equal(stdin.code, ExitCode.Usage, "'-' needs piped input");
});

test("kv webhook create reads --map from stdin and refuses a template that is not a JSON object before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const piped = new PassThrough();
  piped.end(MAP);
  const stdout = new PassThrough(); const stderr = new PassThrough();
  const outP = collect(stdout); void collect(stderr);
  const code = await run({
    argv: ["--json", "kv", "webhook", "create", "--card", CARD, "--map", "-"], env: env.fs.env, stdout, stderr, stdin: piped,
    now: () => new Date("2026-08-14T17:00:00.000Z"), sleep: async () => undefined, homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  });
  stdout.end(); stderr.end();
  assert.equal(code, 0, await outP);
  assert.deepEqual((webhookCalls(transport).at(-1)!.body as { mapping: unknown }).mapping, JSON.parse(MAP));

  const before = webhookCalls(transport).length;
  for (const [name, text] of [["array.json", "[1]"], ["text.json", '"x"'], ["broken.json", "{"], ["null.json", "null"], ["big.json", JSON.stringify({ a: "x".repeat(70_000) })]] as const) {
    const file = await writeMap(env, name, text);
    const result = await cli(["--json", "kv", "webhook", "create", "--card", CARD, "--map", file], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${name}: ${result.stdout}`);
  }
  const missing = await cli(["--json", "kv", "webhook", "create", "--card", CARD, "--map", "nope.json"], transport, env);
  assert.equal(missing.code, ExitCode.Usage, missing.stdout);
  assert.equal(webhookCalls(transport).length, before, "nothing was sent");
});

test("kv webhook options pick exactly one target and refuse flags that belong to the other", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  for (const argv of [
    ["create"],
    ["create", "menu"],
    ["create", "menu", "--app-id", APP, "--card", CARD],
    ["create", "menu", "--card", CARD],
    ["create", "--app-id", APP],
    ["create", "menu", "--app-id", APP, "--signing"],
    ["create", "menu", "--app-id", APP, "--map", "m.json"],
    ["create", "--card", "scr_AAAAAAAAAAAAAAAAAAAAAAAA"],
    ["create", "--card", CARD, "--description", "x".repeat(201)],
    ["list"],
    ["list", "--app-id", APP, "--card", CARD],
    ["rotate-secret", "kvw_AAAAAAAAAAAAAAAAAAAAAA"],
    ["rotate-secret", "kvw_AAAAAAAAAAAAAAAAAAAAAA", "--app-id", APP, "--signing"],
    ["delete", "kvw_AAAAAAAAAAAAAAAAAAAAAA"],
    ["update", "kvw_AAAAAAAAAAAAAAAAAAAAAA", "--card", CARD],
    ["update", "kvw_AAAAAAAAAAAAAAAAAAAAAA", "--app-id", APP, "--disable"],
    ["update", "kvw_AAAAAAAAAAAAAAAAAAAAAA", "--card", CARD, "--enable", "--disable"],
    ["update", "kvw_AAAAAAAAAAAAAAAAAAAAAA", "--card", CARD, "--map", "m.json", "--clear-map"],
    ["update", "bad_id", "--card", CARD, "--disable"],
    ["update", "--card", CARD, "--disable"],
    ["deliveries", "kvw_AAAAAAAAAAAAAAAAAAAAAA"],
    ["deliveries", "kvw_AAAAAAAAAAAAAAAAAAAAAA", "--card", CARD, "--limit", "0"],
    ["deliveries", "kvw_AAAAAAAAAAAAAAAAAAAAAA", "--card", CARD, "--limit", "101"],
    ["deliveries", "kvw_AAAAAAAAAAAAAAAAAAAAAA", "--app-id", APP],
  ]) {
    const result = await cli(["--json", "kv", "webhook", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
  }
  assert.equal(webhookCalls(transport).length, 0, "no request was sent");
});

test("kv webhook list, update, rotate-secret, deliveries and delete work on a card webhook", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const created = await cli(["--json", "kv", "webhook", "create", "--card", CARD], transport, env);
  assert.equal(created.code, 0, created.stdout);
  const webhook = created.envelope.data as { id: string; secret: string };

  const list = await cli(["--json", "kv", "webhook", "list", "--card", CARD], transport, env);
  assert.equal(list.code, 0, list.stdout);
  assert.deepEqual(list.envelope.data.items.map((item: { id: string }) => item.id), [webhook.id]);
  assert.doesNotMatch(list.stdout, /srkw_|whsec_/, "list never carries a secret");
  assert.equal(webhookCalls(transport).at(-1)!.path, `/api/cards/${CARD}/kv-webhooks`);
  const listHuman = await cli(["--human", "kv", "webhook", "list", "--card", CARD], transport, env);
  assert.match(listHuman.stdout, /^Card webhooks \(1\)$/m);
  assert.match(listHuman.stdout, /^ID\s+ENABLED\s+SIGNING\s+MAPPING\s+LAST_USED\s+URL\s+DESCRIPTION$/m);
  assert.match(listHuman.stdout, new RegExp(`^${webhook.id}\\s+true\\s+false\\s+no\\s+-\\s+https://\\S+/write$`, "m"));

  // update sends only what it names, and the signing secret appears once.
  const file = await writeMap(env, "map.json", MAP);
  const updated = await cli(["--json", "kv", "webhook", "update", webhook.id, "--card", CARD, "--map", file, "--disable", "--signing", "--description", "Alerts"], transport, env);
  assert.equal(updated.code, 0, updated.stdout);
  const updateCall = webhookCalls(transport).at(-1)!;
  assert.equal(updateCall.method, "PATCH");
  assert.equal(updateCall.path, `/api/cards/${CARD}/kv-webhooks/${webhook.id}`);
  assert.deepEqual(updateCall.body, { description: "Alerts", mapping: JSON.parse(MAP), enabled: false, signing: true });
  assert.ok(updateCall.headers?.["idempotency-key"]);
  assert.equal(updated.envelope.data.enabled, false);
  assert.match(updated.envelope.data.signing_secret, /^whsec_/);
  assert.equal(updated.envelope.data.secret, undefined);
  assert.deepEqual(updated.envelope.warnings?.map((warning) => warning.code), ["kv_webhook_signing_secret_shown_once"]);
  const again = await cli(["--human", "kv", "webhook", "update", webhook.id, "--card", CARD, "--signing", "--enable"], transport, env);
  assert.match(again.stdout, /^Updated card webhook kvw_\S+$/m);
  assert.doesNotMatch(again.stdout, /signing_secret/, "a webhook that already signs keeps its secret");
  const cleared = await cli(["--json", "kv", "webhook", "update", webhook.id, "--card", CARD, "--clear-map", "--no-signing"], transport, env);
  assert.deepEqual(webhookCalls(transport).at(-1)!.body, { mapping: null, signing: false });
  assert.equal(cleared.envelope.data.mapping, null);

  const rotated = await cli(["--json", "kv", "webhook", "rotate-secret", webhook.id, "--card", CARD], transport, env);
  assert.equal(rotated.code, 0, rotated.stdout);
  const rotateCall = webhookCalls(transport).at(-1)!;
  assert.equal(rotateCall.path, `/api/cards/${CARD}/kv-webhooks/${webhook.id}/rotate-secret`);
  assert.equal(rotateCall.body, undefined);
  assert.match(rotated.envelope.data.secret, /^srkw_/);
  assert.notEqual(rotated.envelope.data.secret, webhook.secret);
  const signing = await cli(["--json", "kv", "webhook", "update", webhook.id, "--card", CARD, "--signing"], transport, env);
  assert.equal(signing.code, 0, signing.stdout);
  const rotatedSigning = await cli(["--json", "kv", "webhook", "rotate-secret", webhook.id, "--card", CARD, "--signing"], transport, env);
  assert.equal(rotatedSigning.code, 0, rotatedSigning.stdout);
  assert.deepEqual(webhookCalls(transport).at(-1)!.body, { signing: true });
  assert.match(rotatedSigning.envelope.data.signing_secret, /^whsec_/);
  assert.equal(rotatedSigning.envelope.data.secret, undefined);
  assert.deepEqual(rotatedSigning.envelope.warnings?.map((warning) => warning.code), ["kv_webhook_signing_secret_shown_once"]);
  const config = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(config, /srkw_|whsec_/);

  const deliveries = await cli(["--json", "kv", "webhook", "deliveries", webhook.id, "--card", CARD, "--limit", "1"], transport, env);
  assert.equal(deliveries.code, 0, deliveries.stdout);
  const readCall = webhookCalls(transport).at(-1)!;
  assert.equal(readCall.method, "GET");
  assert.equal(readCall.path, `/api/cards/${CARD}/kv-webhooks/${webhook.id}/deliveries`);
  assert.deepEqual(readCall.query, { limit: "1" });
  assert.equal(deliveries.envelope.data.items.length, 1);
  const deliveriesHuman = await cli(["--human", "kv", "webhook", "deliveries", webhook.id, "--card", CARD], transport, env);
  assert.match(deliveriesHuman.stdout, /^Deliveries of kvw_\S+ \(2\)$/m);
  assert.match(deliveriesHuman.stdout, /^AT\s+OUTCOME\s+REASON\s+STATUS\s+BYTES\s+REVISION\s+DETAIL$/m);
  assert.match(deliveriesHuman.stdout, /invalid\s+card_data_invalid\s+409\s+311\s+-\s+document\.title: must be at most 120 characters/);
  assert.match(deliveriesHuman.stdout, /written\s+-\s+200\s+98\s+3/);

  const deleted = await cli(["--json", "kv", "webhook", "delete", webhook.id, "--card", CARD], transport, env);
  assert.equal(deleted.code, 0, deleted.stdout);
  assert.deepEqual(deleted.envelope.data, { id: webhook.id, deleted: true });
  assert.equal(webhookCalls(transport).at(-1)!.path, `/api/cards/${CARD}/kv-webhooks/${webhook.id}`);
  const humanDeleted = await cli(["--human", "kv", "webhook", "delete", webhook.id, "--card", CARD], transport, env);
  assert.equal(humanDeleted.code, ExitCode.NotFound);
  const empty = await cli(["--human", "kv", "webhook", "list", "--card", CARD], transport, env);
  assert.match(empty.stdout, /^No card webhooks$/m);
});

test("kv webhook maps card problems to guidance and the card limit to a delete hint", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const noCard = await cli(["--json", "kv", "webhook", "list", "--card", "crd_MISSINGAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(noCard.code, ExitCode.NotFound, noCard.stdout);
  assert.equal(noCard.envelope.error?.code, "card_not_found");
  assert.equal(noCard.envelope.error?.next?.command, "screenrig card list");

  const missing = await cli(["--json", "kv", "webhook", "rotate-secret", MISSING, "--card", CARD], transport, env);
  assert.equal(missing.code, ExitCode.NotFound, missing.stdout);
  assert.equal(missing.envelope.error?.next?.command, `screenrig kv webhook list --card ${CARD}`);

  const unsigned = await cli(["--json", "kv", "webhook", "create", "--card", CARD], transport, env);
  const refused = await cli(["--json", "kv", "webhook", "rotate-secret", unsigned.envelope.data.id, "--card", CARD, "--signing"], transport, env);
  assert.equal(refused.code, ExitCode.Client, refused.stdout);
  assert.equal(refused.envelope.error?.code, "invalid_request");

  for (let index = 0; index < 19; index += 1) await cli(["--json", "kv", "webhook", "create", "--card", CARD], transport, env);
  const limited = await cli(["--json", "kv", "webhook", "create", "--card", CARD], transport, env);
  assert.equal(limited.code, ExitCode.Conflict, limited.stdout);
  assert.equal(limited.envelope.error?.code, "kv_webhook_limit_reached");
  assert.match(limited.envelope.error?.detail ?? "", /This card already has the maximum of 20 webhooks/);
  assert.equal(limited.envelope.error?.next?.command, `screenrig kv webhook list --card ${CARD}`);
});

test("whsec_ signing secrets are redacted from text and recognized as sensitive", () => {
  const secret = "whsec_" + "Q".repeat(43);
  assert.equal(redactText(`signing ${secret}`), "signing whsec_***");
  assert.equal(isSensitiveValue(secret), true);
});
