import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { parseArgv } from "./argv.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { commandHelp } from "./help-tree.js";
import { createMemoryLogger } from "./log/logger.js";
import { run, type CliRuntime } from "./main.js";
import { cardWebhookTableLines, kvWebhookDeliveryTableLines } from "./kv-webhooks.js";
import { testTemp } from "./test-temp.js";
import { triggerDeliveryTableLines } from "./triggers.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";
import { readVerifySecret, singleStdin, verifyHeaderOption, verifyLines, verifyMembers, verifyText, verifyToleranceOption } from "./webhook-verify.js";

const NOW = new Date("2026-11-01T17:00:00.000Z");
const CARD = "crd_AAAAAAAAAAAAAAAAAAAAAAAA";
const WEBHOOK = "kvw_AAAAAAAAAAAAAAAAAAAAAA";
const TRIGGER = "trg_AAAAAAAAAAAAAAAA";
// Built in code, so no literal here looks like a credential.
const WEBHOOK_SECRET = `srkw_${"K".repeat(43)}`;
const VENDOR_SECRET = `gh_${"v".repeat(20)}_9z4q`;
const HMAC_SECRET = "It's a Secret to Everybody";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; hint?: string; next?: { command: string; reason: string } };
  warnings?: Array<{ code: string; message: string }>;
}
interface Env { fs: ConfigFs; cwd: string }

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<Env> {
  const configDir = await testTemp("verify-cfg-");
  const cwd = await testTemp("verify-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA",
    organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr",
  }, fs);
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, extra: Partial<CliRuntime> = {}): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const code = await run({
    argv, env: env.fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport, ...extra,
  });
  stdout.end();
  stderr.end();
  const text = await outP;
  const err = await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, stderr: err, envelope };
}

const stdin = (text: string): Partial<CliRuntime> => ({ stdin: Readable.from([Buffer.from(text)]), isStdinTty: () => false });
const json = (status: number, body: unknown): TransportResponse => ({ status, headers: { "content-type": "application/json" }, body });

type Write = { vendor: string; secret?: string; header?: string; encoding?: string; timestamp_header?: string; tolerance_seconds?: number };
/** WebhookVerify as a read shows it: the secret only as whether it is held and its last four characters. */
function verifyView(write: Write): Record<string, unknown> {
  const { secret, ...rest } = write;
  return { ...rest, secret: secret !== undefined ? { set: true, hint: `…${secret.slice(-4)}`, updated_at: "2026-11-01T17:00:00Z" } : write.vendor === "asana" ? { set: false } : { set: true, hint: "…kept", updated_at: "2026-11-01T16:00:00Z" } };
}

function webhook(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WEBHOOK, card_id: CARD, description: "", mapping: null, enabled: true, signing: false,
    url: `https://api.screenrig.ai/api/cards/${CARD}/kv-webhooks/${WEBHOOK}/write`, created_at: "2026-11-01T16:00:00Z", updated_at: "2026-11-01T16:00:00Z", ...over,
  };
}

/** Card webhook routes of the API, recording every request body. */
function cardBackend(): { transport: FakeTransport; calls: TransportRequest[] } {
  const transport = new FakeTransport();
  const calls: TransportRequest[] = [];
  const write = (req: TransportRequest, status: number, extra: Record<string, unknown> = {}) => {
    calls.push(req);
    const body = (req.body ?? {}) as { verify?: Write | null; handshake?: string | null; description?: string };
    return json(status, {
      ...webhook({ ...(body.description !== undefined ? { description: body.description } : {}), ...(body.verify ? { verify: verifyView(body.verify) } : {}), ...(body.handshake ? { handshake: body.handshake } : {}) }),
      ...extra,
    });
  };
  transport
    .on("POST", `/api/cards/${CARD}/kv-webhooks`, (req) => write(req, 201, { secret: WEBHOOK_SECRET }))
    .on("PATCH", `/api/cards/${CARD}/kv-webhooks/${WEBHOOK}`, (req) => write(req, 200))
    .on("GET", `/api/cards/${CARD}/kv-webhooks`, () => json(200, { items: [webhook({ verify: verifyView({ vendor: "github", secret: VENDOR_SECRET }) }), webhook({ id: "kvw_BBBBBBBBBBBBBBBBBBBBBB", handshake: "trello" }), webhook({ id: "kvw_CCCCCCCCCCCCCCCCCCCCCC" })] }))
    .on("GET", `/api/cards/${CARD}/kv-webhooks/${WEBHOOK}/deliveries`, () => json(200, { items: [
      { at: "2026-11-01T16:59:05.000Z", outcome: "handshake", status: 200, bytes: 0, request_id: "req_five" },
      { at: "2026-11-01T16:59:04.000Z", outcome: "refused", reason: "timestamp_stale", status: 404, bytes: 311, request_id: "req_four" },
      { at: "2026-11-01T16:59:03.000Z", outcome: "refused", reason: "signature_invalid", status: 404, bytes: 311, request_id: "req_three" },
      { at: "2026-11-01T16:59:02.000Z", outcome: "refused", reason: "secret_pending", status: 404, bytes: 12, files: 2, request_id: "req_two" },
      { at: "2026-11-01T16:59:01.000Z", outcome: "written", status: 200, bytes: 98, revision: 3, request_id: "req_one" },
    ] }));
  return { transport, calls };
}

function overlay(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { show: "bar", edge: "bottom", style: {}, enabled: true, signing: false, card_id: "crd_TRIGGERAAAAAAAAAAAA", alerts: [], screens: { targeted: 2, holding: 0, taken_over: 0, removed: 0, edge_taken: 0, skipped: 0, failed: 0 }, pending: false, ...over };
}

function trigger(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TRIGGER, kind: "overlay", label: "Payments", target: { tag: "Lobby" }, default_for_seconds: 600, url: `https://api.screenrig.ai/api/triggers/${TRIGGER}/overlay`, username: TRIGGER,
    overlay: overlay(), revision: 1, created_at: "2026-11-01T16:00:00Z", updated_at: "2026-11-01T16:00:00Z", ...over,
  };
}

/** Trigger routes of the API, recording every request body. */
function triggerBackend(): { transport: FakeTransport; calls: TransportRequest[] } {
  const transport = new FakeTransport();
  const calls: TransportRequest[] = [];
  const answer = (req: TransportRequest, status: number, extra: Record<string, unknown> = {}) => {
    calls.push(req);
    const body = (req.body ?? {}) as { label?: string; overlay?: { verify?: Write | null; handshake?: string | null; show?: string } };
    const sent = body.overlay ?? {};
    return json(status, {
      ...trigger({
        revision: status === 200 ? 2 : 1, ...(body.label ? { label: body.label } : {}),
        overlay: overlay({ ...(sent.show ? { show: sent.show } : {}), ...(sent.verify ? { verify: verifyView(sent.verify) } : {}), ...(sent.handshake ? { handshake: sent.handshake } : {}) }),
      }),
      ...extra,
    });
  };
  transport
    .on("POST", "/api/triggers", (req) => answer(req, 201, { password: `srtg_${"T".repeat(43)}` }))
    .on("PATCH", `/api/triggers/${TRIGGER}`, (req) => answer(req, 200))
    .on("GET", `/api/triggers/${TRIGGER}/deliveries`, () => json(200, { items: [
      { at: "2026-11-01T16:59:02.000Z", outcome: "handshake", status: 200, bytes: 0, request_id: "req_two" },
      { at: "2026-11-01T16:59:01.000Z", outcome: "refused", reason: "signature_missing", status: 404, bytes: 40, request_id: "req_one" },
    ] }));
  return { transport, calls };
}

const lastBody = (calls: TransportRequest[]): any => calls.at(-1)!.body;

test("verify header, tolerance and secret parsers", async () => {
  assert.equal(verifyHeaderOption("--verify-header")("X-Acme-Signature"), "X-Acme-Signature");
  for (const bad of ["", "X Acme", "X:Acme", "a".repeat(101), "Signature\n"]) assert.throws(() => verifyHeaderOption("--verify-header")(bad), /--verify-header takes a header name/, JSON.stringify(bad));
  assert.equal(verifyToleranceOption("1"), "1");
  assert.equal(verifyToleranceOption("86400"), "86400");
  for (const bad of ["0", "86401", "-5", "1.5", "five", ""]) assert.throws(() => verifyToleranceOption(bad), /--verify-tolerance takes whole seconds from 1 to 86400/, bad);

  const env = await enrolled();
  const runtime = { cwd: () => env.cwd } as unknown as CliRuntime;
  await writeFile(path.join(env.cwd, "plain.txt"), `${VENDOR_SECRET}\n`);
  await writeFile(path.join(env.cwd, "crlf.txt"), `${VENDOR_SECRET}\r\n\r\n`);
  await writeFile(path.join(env.cwd, "spaces.txt"), `${HMAC_SECRET}\n`);
  await writeFile(path.join(env.cwd, "empty.txt"), "\n");
  await writeFile(path.join(env.cwd, "two-lines.txt"), "one\ntwo\n");
  await writeFile(path.join(env.cwd, "control.txt"), "abc\u0007def");
  await writeFile(path.join(env.cwd, "long.txt"), "x".repeat(513));
  assert.equal(await readVerifySecret("plain.txt", runtime), VENDOR_SECRET);
  assert.equal(await readVerifySecret("crlf.txt", runtime), VENDOR_SECRET);
  assert.equal(await readVerifySecret("spaces.txt", runtime), HMAC_SECRET, "spaces inside a secret are the secret's");
  await assert.rejects(readVerifySecret("empty.txt", runtime), /holds no secret/);
  await assert.rejects(readVerifySecret("two-lines.txt", runtime), /one line of text/);
  await assert.rejects(readVerifySecret("control.txt", runtime), /one line of text/);
  await assert.rejects(readVerifySecret("long.txt", runtime), /longer than 512 characters/);
  await assert.rejects(readVerifySecret("missing.txt", runtime), /does not exist/);

  singleStdin([["--map", "-"], ["--verify-secret-file", "secret.txt"]]);
  singleStdin([["--map", undefined], ["--verify-secret-file", undefined]]);
  assert.throws(() => singleStdin([["--map", "-"], ["--verify-secret-file", "-"]]), /--map and --verify-secret-file cannot both read stdin/);
});

test("verifyText and verifyLines say the vendor, how a generic sender signs and whether the secret is held", () => {
  assert.equal(verifyText(undefined), "");
  assert.deepEqual(verifyLines(undefined, undefined), []);
  assert.equal(verifyText({ vendor: "github", secret: { set: true, hint: "…9z4q" } }), "github, secret held (…9z4q)");
  assert.equal(verifyText({ vendor: "github", secret: { set: true, hint: "" } }), "github, secret held");
  assert.equal(verifyText({ vendor: "stripe", secret: { set: false } }), "stripe, secret not held");
  assert.equal(verifyText({ vendor: "asana", secret: { set: false } }), "asana, waiting for Asana's handshake: events are refused until it arrives");
  assert.equal(verifyText({ vendor: "generic_hmac", header: "X-Acme-Signature", secret: { set: true, hint: "…ybody" } }), "generic_hmac, header X-Acme-Signature, hex, secret held (…ybody)");
  assert.equal(verifyText({ vendor: "generic_hmac", header: "X-Acme-Signature", encoding: "base64", timestamp_header: "X-Acme-Time", tolerance_seconds: 120, secret: { set: true, hint: "…ybody" } }),
    "generic_hmac, header X-Acme-Signature, base64, timestamp X-Acme-Time within 120s, secret held (…ybody)");
  assert.equal(verifyText({ vendor: "generic_hmac", header: "X-Acme-Signature", timestamp_header: "X-Acme-Time", secret: { set: true } }).includes("within 300s"), true, "the default window is 300 seconds");
  assert.deepEqual(verifyLines({ vendor: "slack", secret: { set: true, hint: "…abcd" } }, "trello"), ["verify: slack, secret held (…abcd)", "handshake: trello"]);
});

test("verifyMembers builds the verify and handshake members the flags ask for", async () => {
  const env = await enrolled();
  const runtime = { cwd: () => env.cwd } as unknown as CliRuntime;
  await writeFile(path.join(env.cwd, "secret.txt"), `${VENDOR_SECRET}\n`);
  const members = async (argv: string[], create = true) => verifyMembers(parseArgv(["kv", "webhook", create ? "create" : "update", ...(create ? [] : [WEBHOOK]), "--card", CARD, ...argv]), runtime, { create, subject: "the webhook" });
  assert.deepEqual(await members([]), {});
  assert.deepEqual(await members(["--verify", "github", "--verify-secret-file", "secret.txt"]), { verify: { vendor: "github", secret: VENDOR_SECRET } });
  assert.deepEqual(await members(["--verify", "generic_hmac", "--verify-secret-file", "secret.txt", "--verify-header", "X-Acme-Signature", "--verify-encoding", "base64", "--verify-timestamp-header", "X-Acme-Time", "--verify-tolerance", "120"]),
    { verify: { vendor: "generic_hmac", secret: VENDOR_SECRET, header: "X-Acme-Signature", encoding: "base64", timestamp_header: "X-Acme-Time", tolerance_seconds: 120 } });
  assert.deepEqual(await members(["--verify", "asana"]), { verify: { vendor: "asana" } });
  assert.deepEqual(await members(["--handshake", "monday"]), { handshake: "monday" });
  assert.deepEqual(await members(["--verify", "stripe"], false), { verify: { vendor: "stripe" } }, "an update that keeps the vendor leaves the secret to the server");
  assert.deepEqual(await members(["--clear-verify", "--clear-handshake"], false), { verify: null, handshake: null });
  await assert.rejects(members(["--verify", "github"]), /--verify github needs --verify-secret-file FILE/);
  await assert.rejects(members(["--verify", "generic_hmac", "--verify-secret-file", "secret.txt"]), /--verify generic_hmac needs --verify-header NAME/);
  await assert.rejects(members(["--verify", "github", "--verify-secret-file", "secret.txt", "--verify-header", "X-Sig"]), /--verify-header applies to --verify generic_hmac/);
  await assert.rejects(members(["--verify", "github", "--verify-secret-file", "secret.txt", "--verify-encoding", "hex"]), /--verify-encoding applies to --verify generic_hmac/);
  // The relationships declared on the command refuse these at parse time; the handler says the same where a caller skips them.
  await assert.rejects(members(["--verify", "generic_hmac", "--verify-secret-file", "secret.txt", "--verify-header", "X-Sig", "--verify-tolerance", "60"]), /--verify-tolerance requires --verify-timestamp-header|applies with --verify-timestamp-header/);
  await assert.rejects(members(["--verify", "asana", "--verify-secret-file", "secret.txt"]), /--verify asana takes no secret/);
  await assert.rejects(members(["--verify-secret-file", "secret.txt"]), /--verify-secret-file requires --verify|describes the vendor named by --verify/);
});

test("kv webhook create --verify sends the vendor and its sealed secret, and never prints or logs the secret", async () => {
  const env = await enrolled();
  const { transport, calls } = cardBackend();
  await writeFile(path.join(env.cwd, "github.secret"), `${VENDOR_SECRET}\n`);
  const { logger, events } = createMemoryLogger({ command: ["kv", "webhook", "create"] });
  const missingMap = await cli(["--json", "kv", "webhook", "create", "--card", CARD, "--verify", "github", "--verify-secret-file", "github.secret", "--description", "Pushes", "--map", "map.json"], transport, env, { logger });
  assert.equal(missingMap.code, 2, "the map file is missing, so nothing is sent");
  assert.equal(calls.length, 0);
  await writeFile(path.join(env.cwd, "map.json"), JSON.stringify({ title: "{{body.repository.full_name}}" }));
  const ok = await cli(["--json", "kv", "webhook", "create", "--card", CARD, "--verify", "github", "--verify-secret-file", "github.secret", "--description", "Pushes", "--map", "map.json"], transport, env, { logger });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.deepEqual(lastBody(calls), { description: "Pushes", mapping: { title: "{{body.repository.full_name}}" }, verify: { vendor: "github", secret: VENDOR_SECRET } });
  assert.match(calls.at(-1)!.headers?.["idempotency-key"] ?? "", /^[A-Za-z0-9_-]{8,}/, "a create is an idempotent write");
  assert.deepEqual(ok.envelope.data.verify, { vendor: "github", secret: { set: true, hint: "…9z4q", updated_at: "2026-11-01T17:00:00Z" } });
  assert.doesNotMatch(ok.stdout + ok.stderr, new RegExp(VENDOR_SECRET), "the vendor's secret is read back only as its hint");
  assert.ok(events.length > 0, "the operation log recorded the request");
  assert.doesNotMatch(JSON.stringify(events), new RegExp(VENDOR_SECRET), "the vendor's secret never reaches the operation log");
  assert.doesNotMatch(await readFile(path.join(env.fs.homedir(), "screenrig", "config.json"), "utf8"), new RegExp(VENDOR_SECRET), "or the saved config");

  const human = await cli(["--human", "kv", "webhook", "create", "--card", CARD, "--verify", "github", "--verify-secret-file", "-"], transport, env, stdin(`${VENDOR_SECRET}\n`));
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.deepEqual(lastBody(calls), { verify: { vendor: "github", secret: VENDOR_SECRET } });
  assert.match(human.stdout, /^verify: github, secret held \(…9z4q\)$/m);
  assert.doesNotMatch(human.stdout, new RegExp(VENDOR_SECRET));
});

test("kv webhook create takes a generic HMAC sender, Asana's handshake and a vendor handshake", async () => {
  const env = await enrolled();
  const { transport, calls } = cardBackend();
  await writeFile(path.join(env.cwd, "hmac.secret"), `${HMAC_SECRET}\n`);
  const generic = await cli(["--human", "kv", "webhook", "create", "--card", CARD, "--verify", "generic_hmac", "--verify-secret-file", "hmac.secret", "--verify-header", "X-Acme-Signature",
    "--verify-encoding", "base64", "--verify-timestamp-header", "X-Acme-Time", "--verify-tolerance", "120"], transport, env);
  assert.equal(generic.code, 0, generic.stdout + generic.stderr);
  assert.deepEqual(lastBody(calls), { verify: { vendor: "generic_hmac", secret: HMAC_SECRET, header: "X-Acme-Signature", encoding: "base64", timestamp_header: "X-Acme-Time", tolerance_seconds: 120 } });
  assert.match(generic.stdout, /^verify: generic_hmac, header X-Acme-Signature, base64, timestamp X-Acme-Time within 120s, secret held \(…body\)$/m);

  const asana = await cli(["--human", "kv", "webhook", "create", "--card", CARD, "--verify", "asana"], transport, env);
  assert.equal(asana.code, 0, asana.stdout + asana.stderr);
  assert.deepEqual(lastBody(calls), { verify: { vendor: "asana" } }, "Asana sends no secret: its handshake delivers it");
  assert.match(asana.stdout, /^verify: asana, waiting for Asana's handshake: events are refused until it arrives$/m);

  const handshake = await cli(["--json", "kv", "webhook", "create", "--card", CARD, "--handshake", "microsoft_graph", "--verify", "slack", "--verify-secret-file", "hmac.secret"], transport, env);
  assert.equal(handshake.code, 0, handshake.stdout + handshake.stderr);
  assert.deepEqual(lastBody(calls), { verify: { vendor: "slack", secret: HMAC_SECRET }, handshake: "microsoft_graph" });
  assert.equal(handshake.envelope.data.handshake, "microsoft_graph");
  const only = await cli(["--human", "kv", "webhook", "create", "--card", CARD, "--handshake", "azure_event_grid"], transport, env);
  assert.deepEqual(lastBody(calls), { handshake: "azure_event_grid" });
  assert.match(only.stdout, /^handshake: azure_event_grid$/m);
  assert.ok(!/^verify:/m.test(only.stdout));
});

test("kv webhook update sets, keeps and removes the verification and the handshake", async () => {
  const env = await enrolled();
  const { transport, calls } = cardBackend();
  await writeFile(path.join(env.cwd, "stripe.secret"), `${VENDOR_SECRET}\n`);
  const update = (...argv: string[]) => cli(["--json", "kv", "webhook", "update", WEBHOOK, "--card", CARD, ...argv], transport, env);
  assert.equal((await update("--verify", "stripe", "--verify-secret-file", "stripe.secret")).code, 0);
  assert.deepEqual(lastBody(calls), { verify: { vendor: "stripe", secret: VENDOR_SECRET } });
  const header = await update("--verify", "generic_hmac", "--verify-header", "X-Acme-Signature", "--verify-tolerance", "60", "--verify-timestamp-header", "X-Acme-Time");
  assert.equal(header.code, 0, header.stdout);
  assert.deepEqual(lastBody(calls), { verify: { vendor: "generic_hmac", header: "X-Acme-Signature", timestamp_header: "X-Acme-Time", tolerance_seconds: 60 } }, "without a secret the server keeps the stored one for the same vendor");
  assert.deepEqual(header.envelope.data.verify.secret.set, true);
  assert.equal((await update("--clear-verify")).code, 0);
  assert.deepEqual(lastBody(calls), { verify: null });
  assert.equal((await update("--handshake", "trello")).code, 0);
  assert.deepEqual(lastBody(calls), { handshake: "trello" });
  assert.equal((await update("--clear-handshake", "--clear-verify")).code, 0);
  assert.deepEqual(lastBody(calls), { verify: null, handshake: null });
  const human = await cli(["--human", "kv", "webhook", "update", WEBHOOK, "--card", CARD, "--verify", "asana", "--handshake", "monday"], transport, env);
  assert.match(human.stdout, /^Updated card webhook kvw_/m);
  assert.match(human.stdout, /^verify: asana, waiting for Asana's handshake/m);
  assert.match(human.stdout, /^handshake: monday$/m);
  assert.equal(calls.length, 6);
});

test("the vendor flags are refused before any request when they do not fit together", async () => {
  const env = await enrolled();
  const { transport, calls } = cardBackend();
  await writeFile(path.join(env.cwd, "secret.txt"), `${VENDOR_SECRET}\n`);
  await writeFile(path.join(env.cwd, "map.json"), "{}");
  await writeFile(path.join(env.cwd, "empty.txt"), "\n");
  await writeFile(path.join(env.cwd, "control.txt"), "abc\u0007def");
  const base = ["--json", "kv", "webhook", "create", "--card", CARD];
  for (const [argv, pattern] of [
    [["--verify", "github"], /--verify github needs --verify-secret-file/],
    [["--verify", "github", "--verify-secret-file", "empty.txt"], /holds no secret/],
    [["--verify", "github", "--verify-secret-file", "control.txt"], /one line of text/],
    [["--verify", "github", "--verify-secret-file", "missing.txt"], /does not exist/],
    [["--verify-secret-file", "secret.txt"], /requires --verify/],
    [["--verify-header", "X-Sig"], /requires --verify/],
    [["--verify", "generic_hmac", "--verify-secret-file", "secret.txt"], /needs --verify-header/],
    [["--verify", "generic_hmac", "--verify-secret-file", "secret.txt", "--verify-header", "bad header"], /--verify-header takes a header name/],
    [["--verify", "generic_hmac", "--verify-secret-file", "secret.txt", "--verify-header", "X-Sig", "--verify-tolerance", "9999999"], /--verify-tolerance takes whole seconds/],
    [["--verify", "generic_hmac", "--verify-secret-file", "secret.txt", "--verify-header", "X-Sig", "--verify-tolerance", "60"], /requires --verify-timestamp-header/],
    [["--verify", "github", "--verify-secret-file", "secret.txt", "--verify-encoding", "base64"], /applies to --verify generic_hmac/],
    [["--verify", "asana", "--verify-secret-file", "secret.txt"], /--verify asana takes no secret/],
    [["--verify", "github", "--verify-secret-file", "secret.txt", "--signing"], /--verify and --signing exclude each other/],
    [["--verify", "mailchimp", "--verify-secret-file", "secret.txt"], /--verify|mailchimp/],
    [["--handshake", "slack"], /--handshake|slack/],
    [["--verify", "github", "--verify-secret-file", "-", "--map", "-"], /cannot both read stdin/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli([...base, ...argv], transport, env, stdin("{}"));
    assert.equal(refused.code, 2, `${argv.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, argv.join(" "));
    assert.doesNotMatch(refused.stdout + refused.stderr, new RegExp(VENDOR_SECRET));
  }
  // A key of an application has no signature scheme: the flags belong to a card webhook.
  const app = await cli(["--json", "kv", "webhook", "create", "menu", "--app-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--verify", "github", "--verify-secret-file", "secret.txt"], transport, env);
  assert.equal(app.code, 2);
  assert.match(app.envelope.error?.detail ?? "", /--verify, --verify-secret-file apply to a card webhook/);
  const conflict = await cli(["--json", "kv", "webhook", "update", WEBHOOK, "--card", CARD, "--verify", "stripe", "--verify-secret-file", "secret.txt", "--clear-verify"], transport, env);
  assert.equal(conflict.code, 2);
  assert.match(conflict.envelope.error?.detail ?? conflict.stderr, /--clear-verify|--verify/);
  const clearHandshake = await cli(["--json", "kv", "webhook", "update", WEBHOOK, "--card", CARD, "--handshake", "trello", "--clear-handshake"], transport, env);
  assert.equal(clearHandshake.code, 2);
  assert.equal(calls.length, 0, "nothing was sent");
});

test("kv webhook list shows the vendor columns only when a webhook has one, and deliveries show handshakes and the new reasons", async () => {
  const env = await enrolled();
  const { transport } = cardBackend();
  const list = await cli(["--human", "kv", "webhook", "list", "--card", CARD], transport, env);
  assert.match(list.stdout, /^ID\s+ENABLED\s+SIGNING\s+VERIFY\s+HANDSHAKE\s+MAPPING\s+KEY_TEMPLATE\s+LAST_USED\s+URL\s+DESCRIPTION$/m);
  assert.match(list.stdout, /^kvw_AAAAAAAAAAAAAAAAAAAAAA\s+true\s+false\s+github\s+-\s+no\b/m);
  assert.match(list.stdout, /^kvw_BBBBBBBBBBBBBBBBBBBBBB\s+true\s+false\s+-\s+trello\s+no\b/m);
  const plain = cardWebhookTableLines([{ id: "kvw_x", card_id: CARD, description: "", mapping: null, enabled: true, signing: false, url: "https://x", created_at: "", updated_at: "" }]);
  assert.match(plain[0]!, /^ID\s+ENABLED\s+SIGNING\s+MAPPING\s+KEY_TEMPLATE\s+LAST_USED\s+URL\s+DESCRIPTION$/, "no vendor columns without a vendor");

  const deliveries = await cli(["--human", "kv", "webhook", "deliveries", WEBHOOK, "--card", CARD], transport, env);
  assert.equal(deliveries.code, 0, deliveries.stdout);
  assert.match(deliveries.stdout, /^AT\s+OUTCOME\s+REASON\s+STATUS\s+BYTES\s+REVISION\s+FILES\s+DETAIL$/m);
  assert.match(deliveries.stdout, /2026-11-01T16:59:05\.000Z\s+handshake\s+-\s+200\s+0\s+-\s+-/);
  assert.match(deliveries.stdout, /refused\s+timestamp_stale\s+404/);
  assert.match(deliveries.stdout, /refused\s+signature_invalid\s+404/);
  assert.match(deliveries.stdout, /refused\s+secret_pending\s+404\s+12\s+-\s+2\b/);
  const rows = kvWebhookDeliveryTableLines([{ at: "t", outcome: "written", status: 200, bytes: 1, request_id: "r" }]);
  assert.doesNotMatch(rows[0]!, /FILES/, "FILES appears only when a post carried file parts");
  const jsonRows = await cli(["--json", "kv", "webhook", "deliveries", WEBHOOK, "--card", CARD], transport, env);
  assert.deepEqual(jsonRows.envelope.data.items.map((item: { outcome: string; reason?: string }) => [item.outcome, item.reason]), [["handshake", undefined], ["refused", "timestamp_stale"], ["refused", "signature_invalid"], ["refused", "secret_pending"], ["written", undefined]]);
});

test("triggers create and update take the vendor flags for an overlay trigger", async () => {
  const env = await enrolled();
  const { transport, calls } = triggerBackend();
  await writeFile(path.join(env.cwd, "stripe.secret"), `${VENDOR_SECRET}\n`);
  const created = await cli(["--human", "triggers", "create", "--name", "Payments", "--kind", "overlay", "--show", "bar", "--tag", "Lobby", "--verify", "stripe", "--verify-secret-file", "stripe.secret"], transport, env);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  assert.deepEqual(lastBody(calls).overlay, { show: "bar", verify: { vendor: "stripe", secret: VENDOR_SECRET } });
  assert.match(created.stdout, /^verify: stripe, secret held \(…9z4q\)$/m);
  assert.doesNotMatch(created.stdout + created.stderr, new RegExp(VENDOR_SECRET));
  assert.match(calls.at(-1)!.headers?.["idempotency-key"] ?? "", /^[A-Za-z0-9_-]{8,}/);

  const handshake = await cli(["--json", "triggers", "create", "--name", "Boards", "--kind", "overlay", "--show", "takeover", "--tag", "Lobby", "--handshake", "trello"], transport, env);
  assert.equal(handshake.code, 0, handshake.stdout + handshake.stderr);
  assert.deepEqual(lastBody(calls).overlay, { show: "takeover", handshake: "trello" });
  const generic = await cli(["--json", "triggers", "create", "--name", "Alerts", "--kind", "overlay", "--show", "bar", "--tag", "Lobby", "--verify", "generic_hmac", "--verify-secret-file", "-", "--verify-header", "X-Acme-Signature", "--verify-timestamp-header", "X-Acme-Time", "--verify-tolerance", "30"], transport, env, stdin(`${HMAC_SECRET}\n`));
  assert.equal(generic.code, 0, generic.stdout + generic.stderr);
  assert.deepEqual(lastBody(calls).overlay.verify, { vendor: "generic_hmac", secret: HMAC_SECRET, header: "X-Acme-Signature", timestamp_header: "X-Acme-Time", tolerance_seconds: 30 });

  const update = (...argv: string[]) => cli(["--json", "triggers", "update", TRIGGER, ...argv], transport, env);
  assert.equal((await update("--verify", "github", "--verify-secret-file", "stripe.secret")).code, 0);
  assert.deepEqual(lastBody(calls), { overlay: { verify: { vendor: "github", secret: VENDOR_SECRET } } });
  assert.equal((await update("--verify", "linear")).code, 0);
  assert.deepEqual(lastBody(calls), { overlay: { verify: { vendor: "linear" } } }, "an update that keeps the vendor may leave the secret out");
  assert.equal((await update("--clear-verify")).code, 0);
  assert.deepEqual(lastBody(calls), { overlay: { verify: null } });
  assert.equal((await update("--handshake", "azure_event_grid")).code, 0);
  assert.deepEqual(lastBody(calls), { overlay: { handshake: "azure_event_grid" } });
  const cleared = await update("--clear-handshake", "--clear-verify", "--name", "Renamed");
  assert.equal(cleared.code, 0);
  assert.deepEqual(lastBody(calls), { label: "Renamed", overlay: { verify: null, handshake: null } });
  const shown = await cli(["--human", "triggers", "update", TRIGGER, "--verify", "asana", "--handshake", "monday"], transport, env);
  assert.match(shown.stdout, /^verify: asana, waiting for Asana's handshake/m);
  assert.match(shown.stdout, /^handshake: monday$/m);
});

test("the vendor flags of a trigger are refused before any request when they do not fit", async () => {
  const env = await enrolled();
  const { transport, calls } = triggerBackend();
  await writeFile(path.join(env.cwd, "secret.txt"), `${VENDOR_SECRET}\n`);
  await writeFile(path.join(env.cwd, "style.json"), "{}");
  const overlay = ["--json", "triggers", "create", "--name", "Payments", "--kind", "overlay", "--show", "bar", "--tag", "Lobby"];
  for (const [argv, pattern] of [
    [["--verify", "github"], /--verify github needs --verify-secret-file/],
    [["--verify", "github", "--verify-secret-file", "secret.txt", "--signing"], /--verify and --signing exclude each other/],
    [["--verify", "asana", "--verify-secret-file", "secret.txt"], /takes no secret/],
    [["--verify", "generic_hmac", "--verify-secret-file", "secret.txt"], /needs --verify-header/],
    [["--verify", "github", "--verify-secret-file", "-", "--style", "-"], /cannot both read stdin/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli([...overlay, ...argv], transport, env, stdin("{}"));
    assert.equal(refused.code, 2, `${argv.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, argv.join(" "));
  }
  // A CAP trigger has no vendor to verify.
  for (const flag of [["--verify", "github", "--verify-secret-file", "secret.txt"], ["--handshake", "trello"]]) {
    const cap = await cli(["--json", "triggers", "create", "--name", "Campus", "--tag", "Campus", ...flag], transport, env);
    assert.equal(cap.code, 2);
    assert.match(cap.envelope.error?.detail ?? "", /applies to an overlay trigger: add --kind overlay/);
  }
  assert.equal(calls.length, 0, "nothing was sent");
});

test("trigger deliveries show handshakes and the signature reasons", async () => {
  const env = await enrolled();
  const { transport } = triggerBackend();
  const human = await cli(["--human", "triggers", "deliveries", TRIGGER], transport, env);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /^AT\s+OUTCOME\s+REASON\s+STATUS\s+BYTES\s+ALERT\s+DETAIL$/m);
  assert.match(human.stdout, /handshake\s+-\s+200\s+0\s+-/);
  assert.match(human.stdout, /refused\s+signature_missing\s+404\s+40\s+-/);
  assert.doesNotMatch(triggerDeliveryTableLines([{ at: "t", outcome: "shown", status: 200, bytes: 1, request_id: "r" }])[0]!, /FILES/);
  assert.match(triggerDeliveryTableLines([{ at: "t", outcome: "ignored", status: 200, bytes: 1, files: 3, request_id: "r" }])[0]!, /\bFILES\b/);
});

test("help names the vendor flags, their relationships and the new delivery reasons", () => {
  for (const words of [["kv", "webhook", "create"], ["kv", "webhook", "update"], ["triggers", "create"], ["triggers", "update"]]) {
    const help = commandHelp(words);
    const names = help.options.map((option) => option.name);
    for (const flag of ["--verify", "--verify-secret-file", "--verify-header", "--verify-encoding", "--verify-timestamp-header", "--verify-tolerance", "--handshake"]) assert.ok(names.includes(flag), `${words.join(" ")} ${flag}`);
    assert.deepEqual(help.options.find((option) => option.name === "--verify")!.choices, ["github", "stripe", "shopify", "slack", "linear", "vercel", "asana", "generic_hmac"]);
    assert.deepEqual(help.options.find((option) => option.name === "--handshake")!.choices, ["microsoft_graph", "monday", "trello", "azure_event_grid"]);
    assert.deepEqual(help.options.find((option) => option.name === "--verify-encoding")!.choices, ["hex", "base64"]);
    assert.match(help.options.find((option) => option.name === "--verify-secret-file")!.description, /never an argument/);
    assert.ok(help.relationships.some((group) => group.kind === "requires" && group.options.join() === "--verify-secret-file,--verify"), words.join(" "));
    assert.ok(help.relationships.some((group) => group.kind === "requires" && group.options.join() === "--verify-tolerance,--verify-timestamp-header"), words.join(" "));
    assert.ok(help.examples.some((example) => example.includes("--verify ") || example.includes("--handshake ")), `${words.join(" ")} has a vendor example`);
  }
  for (const words of [["kv", "webhook", "update"], ["triggers", "update"]]) {
    const help = commandHelp(words);
    assert.ok(help.options.some((option) => option.name === "--clear-verify" && option.conflicts.includes("--verify")), words.join(" "));
    assert.ok(help.options.some((option) => option.name === "--clear-handshake" && option.conflicts.includes("--handshake")), words.join(" "));
    const change = help.relationships.find((group) => group.kind === "atLeastOne")!.options;
    for (const flag of ["--verify", "--clear-verify", "--handshake", "--clear-handshake"]) assert.ok(change.includes(flag), `${words.join(" ")} counts ${flag} as a change`);
  }
  for (const words of [["kv", "webhook", "deliveries"], ["triggers", "deliveries"]]) {
    const notes = commandHelp(words).notes.join("\n");
    for (const word of ["handshake", "signature_missing", "signature_invalid", "timestamp_missing", "timestamp_stale", "secret_pending", "handshake_invalid", "files"]) assert.ok(notes.includes(word), `${words.join(" ")} names ${word}`);
  }
  for (const words of [["kv", "webhook", "create"], ["triggers", "create"]]) {
    const notes = commandHelp(words).notes.join("\n");
    assert.match(notes, /asana/i);
    assert.match(notes, /X-Hub-Signature-256|signature in its own header/);
  }
  assert.match(commandHelp(["kv", "webhook"]).usage, /GitHub, Stripe, Shopify, Slack/);
  assert.match(commandHelp(["triggers"]).usage, /--handshake VENDOR/);
});
