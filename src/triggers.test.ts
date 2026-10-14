import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { createMemoryLogger } from "./log/logger.js";
import type { OperationLogger } from "./log/types.js";
import { run, type CliRuntime } from "./main.js";
import { redactText } from "./redact.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest } from "./transport/types.js";
import { triggerHoldSeconds } from "./triggers.js";

const MISSING = "trg_MISSINGAAAAAAAAA";

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
  const configDir = await testTemp("triggers-cfg-");
  const cwd = await testTemp("triggers-cwd-");
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

const triggerCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => call.path.startsWith("/api/triggers"));

async function create(transport: FakeTransport, env: Env, ...extra: string[]) {
  const created = await cli(["--json", "triggers", "create", "--name", "Campus alerts", ...(extra.length ? extra : ["--tag", "Campus"])], transport, env);
  assert.equal(created.code, 0, created.stdout);
  return created.envelope.data as { id: string; password: string; revision: number; url: string; username: string };
}

test("triggers create sends the target and hold, prints the password once, and keeps it out of config and logs", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { logger, events } = createMemoryLogger({ command: ["triggers", "create"] });
  const created = await cli(["--json", "triggers", "create", "--name", "  Campus alerts ", "--tag", "Campus", "--for", "2h"], transport, env, logger);
  assert.equal(created.code, 0, created.stdout);
  const call = triggerCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/triggers");
  assert.deepEqual(call.body, { label: "Campus alerts", target: { tag: "Campus" }, default_for_seconds: 7200 });
  assert.ok(call.headers?.["idempotency-key"], "create always sends an Idempotency-Key");
  assert.match(created.envelope.data.id, /^trg_/);
  assert.match(created.envelope.data.password, /^srtg_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.envelope.data.username, created.envelope.data.id);
  assert.deepEqual(created.envelope.warnings?.map((warning) => warning.code), ["trigger_password_shown_once"]);

  const config = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(config, /srtg_/, "the password never reaches config");
  assert.doesNotMatch(config, /pending_writes/, "a completed create clears its recovery entry");
  assert.ok(events.length > 0, "the operation log recorded the request");
  assert.doesNotMatch(JSON.stringify(events), /srtg_[A-Za-z0-9_-]{43}/, "the password never reaches the operation log");

  const screens = await cli(["--json", "triggers", "create", "--name", "Lobby", "--screen-id", "scr_AAAAAAAAAAAAAAAA", "--screen-id", "scr_BBBBBBBBBBBBBBBB,scr_CCCCCCCCCCCCCCCC"], transport, env);
  assert.equal(screens.code, 0, screens.stdout);
  assert.deepEqual(triggerCalls(transport).at(-1)!.body, { label: "Lobby", target: { screen_ids: ["scr_AAAAAAAAAAAAAAAA", "scr_BBBBBBBBBBBBBBBB", "scr_CCCCCCCCCCCCCCCC"] } });

  const human = await cli(["--human", "triggers", "create", "--name", "Gym", "--tag", "Gym"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Created trigger trg_\S+$/m);
  assert.match(human.stdout, /^target: tag Gym$/m);
  assert.match(human.stdout, /^hold: 1h when an alert has no <expires>$/m);
  assert.match(human.stdout, /^url: https:\/\/api\.screenrig\.ai\/api\/triggers\/trg_\S+\/cap$/m);
  assert.match(human.stdout, /^Sensitive CAP password \(enter it only in your emergency notification system, with the url and username above\)\npassword: srtg_\S{43}$/m);
  assert.match(human.stdout, /^warning: data\.password is this trigger's HTTP Basic password and is shown only in this answer\./m);
});

test("triggers create refuses a bad target or hold before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  for (const argv of [
    ["--name", "x"],
    ["--name", "x", "--tag", "Lobby", "--screen-id", "scr_AAAAAAAAAAAAAAAA"],
    ["--name", "x", "--tag", "not a tag"],
    ["--name", "x", "--screen-id", "pl_AAAAAAAAAAAAAAAA"],
    ["--name", "x", "--screen-id", "scr_AAAAAAAAAAAAAAAA,scr_AAAAAAAAAAAAAAAA"],
    ["--name", "x", "--tag", "Lobby", "--for", "30s"],
    ["--name", "x", "--tag", "Lobby", "--for", "8d"],
    ["--name", "", "--tag", "Lobby"],
  ]) {
    const result = await cli(["--json", "triggers", "create", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
  }
  assert.equal(triggerCalls(transport).length, 0);
  assert.equal(triggerHoldSeconds("1m"), 60);
  assert.equal(triggerHoldSeconds("7d"), 604_800);
  assert.equal(triggerHoldSeconds("1d12h"), 129_600);
});

test("triggers list, show, test and clear report the alert; test and delete refuse while it is active", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const trigger = await create(transport, env, "--screen-id", "scr_AAAAAAAAAAAAAAAA");

  const list = await cli(["--json", "triggers", "list"], transport, env);
  assert.equal(list.code, 0, list.stdout);
  assert.deepEqual(list.envelope.data.items.map((item: { id: string }) => item.id), [trigger.id]);
  assert.doesNotMatch(list.stdout, /srtg_/, "list never carries a password");
  const listHuman = await cli(["--human", "triggers", "list"], transport, env);
  assert.match(listHuman.stdout, /^ID\s+LABEL\s+TARGET\s+ALERT\s+LAST_RECEIVED$/m);
  assert.match(listHuman.stdout, new RegExp(`^${trigger.id}\\s+Campus alerts\\s+1 screens\\s+-$`, "m"));

  const tested = await cli(["--json", "triggers", "test", trigger.id], transport, env);
  assert.equal(tested.code, 0, tested.stdout);
  assert.equal(tested.envelope.data.outcome, "shown");
  assert.equal(tested.envelope.data.alert.status, "Exercise");
  assert.ok(triggerCalls(transport).at(-1)!.headers?.["idempotency-key"]);

  const again = await cli(["--json", "triggers", "test", trigger.id], transport, env);
  assert.equal(again.code, ExitCode.Conflict, again.stdout);
  assert.equal(again.envelope.error?.code, "resource_conflict");
  assert.equal(again.envelope.error?.next?.command, `screenrig triggers clear ${trigger.id}`);
  const blocked = await cli(["--json", "triggers", "delete", trigger.id], transport, env);
  assert.equal(blocked.code, ExitCode.Conflict, blocked.stdout);
  assert.equal(blocked.envelope.error?.next?.command, `screenrig triggers clear ${trigger.id}`);

  const shown = await cli(["--human", "triggers", "show", trigger.id], transport, env);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^Alert\nid: \S+\nstate: active\nstatus: Exercise\n/m);
  assert.match(shown.stdout, /^screens: 0 taken over of 1 targeted, 0 skipped, 0 failed; still writing screens$/m);
  assert.doesNotMatch(shown.stdout, /password|srtg_/);

  const cleared = await cli(["--json", "triggers", "clear", trigger.id], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  assert.equal(cleared.envelope.data.alert.state, "ended");
  assert.equal(cleared.envelope.data.alert.ended_reason, "cleared");
  const clearedHuman = await cli(["--human", "triggers", "clear", trigger.id], transport, env);
  assert.match(clearedHuman.stdout, /^state: ended \(cleared\)$/m);

  const deleted = await cli(["--json", "triggers", "delete", trigger.id], transport, env);
  assert.equal(deleted.code, 0, deleted.stdout);
  assert.deepEqual(deleted.envelope.data, { id: trigger.id, deleted: true });
});

test("triggers rotate-secret prints a new password once and guards the revision", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const trigger = await create(transport, env);

  const stale = await cli(["--json", "triggers", "rotate-secret", trigger.id, "--expect-rev", "9"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition, stale.stdout);
  assert.equal(stale.envelope.error?.code, "revision_conflict");
  assert.equal(stale.envelope.error?.next?.command, `screenrig triggers show ${trigger.id}`);
  assert.equal(triggerCalls(transport).at(-1)!.headers?.["if-match"], '"9"');

  const rotated = await cli(["--json", "triggers", "rotate-secret", trigger.id, "--expect-rev", String(trigger.revision)], transport, env);
  assert.equal(rotated.code, 0, rotated.stdout);
  assert.match(rotated.envelope.data.password, /^srtg_/);
  assert.notEqual(rotated.envelope.data.password, trigger.password);
  assert.deepEqual(rotated.envelope.warnings?.map((warning) => warning.code), ["trigger_password_shown_once"]);
  const config = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(config, /srtg_/);
});

test("triggers map not_found and the project limit to guidance", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const missing = await cli(["--json", "triggers", "show", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound, missing.stdout);
  assert.equal(missing.envelope.error?.next?.command, "screenrig triggers list");

  const badId = await cli(["--json", "triggers", "show", "flk_AAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(badId.code, ExitCode.Usage, badId.stdout);
  assert.equal(triggerCalls(transport).filter((call) => call.path.includes("flk_")).length, 0);

  for (let index = 0; index < 20; index += 1) await create(transport, env, "--tag", `T${index}`);
  const limited = await cli(["--json", "triggers", "create", "--name", "One more", "--tag", "Extra"], transport, env);
  assert.equal(limited.code, ExitCode.Conflict, limited.stdout);
  assert.equal(limited.envelope.error?.code, "trigger_limit_reached");
  assert.match(limited.envelope.error?.detail ?? "", /maximum of 20 triggers/);
  assert.equal(limited.envelope.error?.next?.command, "screenrig triggers list");
});

test("srtg_ passwords are redacted from text", () => {
  const password = "srtg_" + "Q".repeat(43);
  assert.equal(redactText(`Basic trg_A:${password}`), "Basic trg_A:srtg_***");
});
