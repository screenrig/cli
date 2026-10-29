import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help.js";
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

async function cli(argv: string[], transport: FakeTransport, env: Env, logger?: OperationLogger, stdin?: string): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
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
    ...(stdin !== undefined ? { stdin: Readable.from([stdin]), isStdinTty: () => false } : {}),
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

test("triggers create --pull sends the CAP sources from a file or stdin and the trigger keeps them", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const pull = {
    sources: ["https://alerts.example.com/cap.atom"],
    location: { name: "Campus", latitude: 49.25, longitude: -123, geocodes: [{ name: "UGC", value: "WAC033" }] },
    minSeverity: "moderate", events: ["*Warning"], statuses: ["Actual", "Exercise"], areaUnknown: "show",
  };
  await writeFile(path.join(env.cwd, "pull.json"), JSON.stringify(pull));
  const fromFile = await cli(["--json", "triggers", "create", "--name", "Campus alerts", "--tag", "Campus", "--for", "2h", "--pull", "pull.json"], transport, env);
  assert.equal(fromFile.code, 0, fromFile.stdout);
  assert.deepEqual(triggerCalls(transport).at(-1)!.body, { label: "Campus alerts", target: { tag: "Campus" }, default_for_seconds: 7200, pull });
  assert.deepEqual(fromFile.envelope.data.pull, pull);

  const fromStdin = await cli(["--json", "triggers", "create", "--name", "Lobby", "--screen-id", "scr_AAAAAAAAAAAAAAAA", "--pull", "-"], transport, env, undefined, JSON.stringify({ location: { latitude: 1, longitude: 2 } }));
  assert.equal(fromStdin.code, 0, fromStdin.stdout);
  assert.deepEqual(triggerCalls(transport).at(-1)!.body, { label: "Lobby", target: { screen_ids: ["scr_AAAAAAAAAAAAAAAA"] }, pull: { location: { latitude: 1, longitude: 2 } } });

  const shown = await cli(["--json", "triggers", "show", fromFile.envelope.data.id], transport, env);
  assert.deepEqual(shown.envelope.data.pull, pull);
});

test("triggers create help names --pull with its stdin form", () => {
  const pull = commandHelp(["triggers", "create"]).options.find((option) => option.name === "--pull");
  assert.ok(pull);
  assert.match(pull.description, /for stdin/);
});

test("triggers create --pull refuses unreadable or non-object input before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  await writeFile(path.join(env.cwd, "list.json"), "[]");
  await writeFile(path.join(env.cwd, "text.json"), '"sources"');
  await writeFile(path.join(env.cwd, "broken.json"), "{ not json");
  for (const file of ["list.json", "text.json", "broken.json", "missing.json"]) {
    const result = await cli(["--json", "triggers", "create", "--name", "x", "--tag", "Lobby", "--pull", file], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${file}: ${result.stdout}`);
  }
  const piped = await cli(["--json", "triggers", "create", "--name", "x", "--tag", "Lobby", "--pull", "-"], transport, env, undefined, "null");
  assert.equal(piped.code, ExitCode.Usage, piped.stdout);
  assert.match(piped.envelope.error?.detail ?? "", /--pull must hold a JSON object/);
  assert.equal(triggerCalls(transport).length, 0);
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
  assert.match(listHuman.stdout, /^ID\s+KIND\s+LABEL\s+TARGET\s+ALERT\s+LAST_RECEIVED$/m);
  assert.match(listHuman.stdout, new RegExp(`^${trigger.id}\\s+cap\\s+Campus alerts\\s+1 screens\\s+-$`, "m"));

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

// ---- overlay triggers ----

const STYLE = '{"theme":"signal","accent":"#FFB000"}';
const MAP = '{"alert_id":"{{body.groupKey}}","title":"{{body.title}}","state":"{{body.status}}"}';

async function writeTemp(name: string, text: string): Promise<string> {
  const dir = await testTemp("triggers-file-");
  const file = path.join(dir, name);
  await writeFile(file, text);
  return file;
}

test("triggers create --kind overlay sends the overlay, prints the secrets once and a placeholder example, and keeps them out of config and logs", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { logger, events } = createMemoryLogger({ command: ["triggers", "create"] });
  const style = await writeTemp("style.json", STYLE);
  const map = await writeTemp("map.json", MAP);
  const created = await cli(["--json", "triggers", "create", "--name", "Lobby sensors", "--kind", "overlay", "--show", "bar", "--edge", "top", "--tag", "Lobby",
    "--style", style, "--map", map, "--signing", "--for", "90s"], transport, env, logger);
  assert.equal(created.code, 0, created.stdout);
  const call = triggerCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, {
    kind: "overlay", label: "Lobby sensors", target: { tag: "Lobby" }, default_for_seconds: 90,
    overlay: { show: "bar", edge: "top", style: { theme: "signal", accent: "#FFB000" }, mapping: JSON.parse(MAP), signing: true },
  });
  assert.ok(call.headers?.["idempotency-key"]);
  const data = created.envelope.data;
  assert.equal(data.kind, "overlay");
  assert.match(data.url, /\/api\/triggers\/trg_\S+\/overlay$/);
  assert.match(data.password, /^srtg_[A-Za-z0-9_-]{43}$/);
  assert.match(data.signing_secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(created.envelope.warnings?.map((warning) => warning.code), ["trigger_password_shown_once", "trigger_signing_secret_shown_once"]);
  const config = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(config, /srtg_|whsec_/);
  assert.doesNotMatch(JSON.stringify(events), /srtg_[A-Za-z0-9_-]{43}|whsec_[A-Za-z0-9_-]{43}/, "the secrets never reach the operation log");

  const human = await cli(["--human", "triggers", "create", "--name", "Doorbell", "--kind", "overlay", "--show", "takeover", "--tag", "Lobby"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Created trigger trg_\S+$/m);
  assert.match(human.stdout, /^kind: overlay$/m);
  assert.match(human.stdout, /^hold: 10m when a post names no duration$/m);
  assert.match(human.stdout, /^show: takeover$/m);
  assert.match(human.stdout, /^password: srtg_\S{43}$/m);
  assert.doesNotMatch(human.stdout, /signing_secret/);
  assert.match(human.stdout, /^example: curl -X POST https:\/\/api\.screenrig\.ai\/api\/triggers\/trg_\S+\/overlay -H "Authorization: Bearer <password>" -H "Content-Type: application\/json" -d '\{"alert_id":"front-door","title":"Front door","message":"The front door is open","duration":"10m"\}'$/m);
  assert.doesNotMatch(human.stdout.split("example:")[1] ?? "", /srtg_/, "the example holds a placeholder, not the secret");
});

test("triggers create refuses overlay options that do not fit before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const style = await writeTemp("style.json", STYLE);
  const notObject = await writeTemp("bad.json", "[1]");
  for (const argv of [
    ["--name", "x", "--tag", "Lobby", "--kind", "overlay"],
    ["--name", "x", "--tag", "Lobby", "--show", "bar"],
    ["--name", "x", "--tag", "Lobby", "--kind", "overlay", "--show", "takeover", "--edge", "top"],
    ["--name", "x", "--tag", "Lobby", "--kind", "overlay", "--show", "popup"],
    ["--name", "x", "--tag", "Lobby", "--kind", "overlay", "--show", "bar", "--edge", "left"],
    ["--name", "x", "--tag", "Lobby", "--kind", "overlay", "--show", "bar", "--pull", "pull.json"],
    ["--name", "x", "--tag", "Lobby", "--signing"],
    ["--name", "x", "--tag", "Lobby", "--edge", "top"],
    ["--name", "x", "--tag", "Lobby", "--kind", "overlay", "--show", "bar", "--style", notObject],
    ["--name", "x", "--tag", "Lobby", "--kind", "overlay", "--show", "bar", "--map", notObject],
    ["--name", "x", "--tag", "Lobby", "--kind", "overlay", "--show", "bar", "--for", "9s"],
    ["--name", "x", "--tag", "Lobby", "--kind", "overlay", "--show", "bar", "--style", path.join(path.dirname(style), "missing.json")],
  ]) {
    const result = await cli(["--json", "triggers", "create", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
  }
  assert.equal(triggerCalls(transport).length, 0);
  assert.equal(triggerHoldSeconds("10s", "overlay"), 10);
  assert.throws(() => triggerHoldSeconds("10s"), /1m to 7d/);
});

test("triggers update sends only what is passed, prints a new signing secret once, and guards the revision", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const style = await writeTemp("style.json", STYLE);
  const map = await writeTemp("map.json", MAP);
  const created = await cli(["--json", "triggers", "create", "--name", "Lobby", "--kind", "overlay", "--show", "bar", "--tag", "Lobby"], transport, env);
  const id = created.envelope.data.id as string;

  const none = await cli(["--json", "triggers", "update", id], transport, env);
  assert.equal(none.code, ExitCode.Usage);
  const conflicting = await cli(["--json", "triggers", "update", id, "--enable", "--disable"], transport, env);
  assert.equal(conflicting.code, ExitCode.Usage);

  const edge = await cli(["--json", "triggers", "update", id, "--edge", "top", "--tag", "Cafe", "--name", "Cafe bars", "--for", "2m", "--expect-rev", "1"], transport, env);
  assert.equal(edge.code, 0, edge.stdout);
  let call = triggerCalls(transport).at(-1)!;
  assert.equal(call.method, "PATCH");
  assert.equal(call.path, `/api/triggers/${id}`);
  assert.deepEqual(call.body, { label: "Cafe bars", target: { tag: "Cafe" }, default_for_seconds: 120, overlay: { edge: "top" } });
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.equal(edge.envelope.data.overlay.edge, "top");
  assert.deepEqual(edge.envelope.warnings ?? [], []);
  const stale = await cli(["--json", "triggers", "update", id, "--disable", "--expect-rev", "1"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition);
  assert.equal(stale.envelope.error?.next?.command, `screenrig triggers show ${id}`);

  const many = await cli(["--json", "triggers", "update", id, "--style", style, "--map", map, "--disable", "--signing"], transport, env);
  assert.equal(many.code, 0, many.stdout);
  call = triggerCalls(transport).at(-1)!;
  assert.deepEqual(call.body, { overlay: { style: { theme: "signal", accent: "#FFB000" }, mapping: JSON.parse(MAP), enabled: false, signing: true } });
  assert.match(many.envelope.data.signing_secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(many.envelope.warnings?.map((warning) => warning.code), ["trigger_signing_secret_shown_once"]);
  assert.equal(many.envelope.data.overlay.enabled, false);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /whsec_/);

  // A trigger that already signs keeps its secret: nothing is printed.
  const again = await cli(["--human", "triggers", "update", id, "--signing"], transport, env);
  assert.doesNotMatch(again.stdout, /signing_secret|whsec_/);

  const cleared = await cli(["--json", "triggers", "update", id, "--clear-style", "--clear-map", "--enable", "--no-signing"], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  assert.deepEqual(triggerCalls(transport).at(-1)!.body, { overlay: { style: null, mapping: null, enabled: true, signing: false } });

  const cap = await create(transport, env);
  const wrong = await cli(["--json", "triggers", "update", cap.id, "--edge", "top"], transport, env);
  assert.equal(wrong.code, ExitCode.Client);
  const noPull = await cli(["--json", "triggers", "update", cap.id, "--no-pull"], transport, env);
  assert.equal(noPull.code, 0, noPull.stdout);
  assert.deepEqual(triggerCalls(transport).at(-1)!.body, { pull: null });

});

test("triggers show, test, clear and list report an overlay trigger's alerts", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const created = await cli(["--json", "triggers", "create", "--name", "Lobby", "--kind", "overlay", "--show", "bar", "--tag", "Lobby"], transport, env);
  const id = created.envelope.data.id as string;
  const tested = await cli(["--json", "triggers", "test", id], transport, env);
  assert.equal(tested.code, 0, tested.stdout);
  assert.equal(tested.envelope.data.outcome, "shown");
  assert.equal(tested.envelope.data.alert_id, "screenrig-test");
  const busy = await cli(["--json", "triggers", "test", id], transport, env);
  assert.equal(busy.code, ExitCode.Conflict);
  assert.equal(busy.envelope.error?.next?.command, `screenrig triggers clear ${id}`);

  const human = await cli(["--human", "triggers", "show", id], transport, env);
  assert.match(human.stdout, /^Overlay$/m);
  assert.match(human.stdout, /^show: bar on the bottom edge$/m);
  assert.match(human.stdout, /^alerts: 1$/m);
  assert.match(human.stdout, /^  screenrig-test  until 2026-08-14T17:01:00\.000Z  Test \| Test overlay \| This tests the overlay on these screens\.$/m);
  const list = await cli(["--human", "triggers", "list"], transport, env);
  assert.match(list.stdout, /bar: 1 alert, Test overlay/);

  const wrongId = await cli(["--json", "triggers", "clear", id, "--alert-id", "front-door"], transport, env);
  assert.equal(wrongId.code, 0);
  assert.equal(wrongId.envelope.data.overlay.alerts.length, 1, "an id that is not active changes nothing");
  assert.deepEqual(triggerCalls(transport).at(-1)!.body, { alert_id: "front-door" });
  const cleared = await cli(["--human", "triggers", "clear", id, "--alert-id", "screenrig-test"], transport, env);
  assert.equal(cleared.code, 0);
  assert.match(cleared.stdout, /No alert is active on trigger/);
  const all = await cli(["--json", "triggers", "clear", id], transport, env);
  assert.equal(all.code, 0);
  assert.equal(triggerCalls(transport).at(-1)!.body, undefined, "a clear without an id sends no body");
});

test("triggers deliveries reads the log with a limit", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const created = await cli(["--json", "triggers", "create", "--name", "Lobby", "--kind", "overlay", "--show", "bar", "--tag", "Lobby"], transport, env);
  const id = created.envelope.data.id as string;
  const result = await cli(["--json", "triggers", "deliveries", id, "--limit", "20"], transport, env);
  assert.equal(result.code, 0, result.stdout);
  const call = triggerCalls(transport).at(-1)!;
  assert.equal(call.method, "GET");
  assert.equal(call.path, `/api/triggers/${id}/deliveries`);
  assert.deepEqual(call.query, { limit: "20" });
  assert.deepEqual(result.envelope.data.items, []);
  const human = await cli(["--human", "triggers", "deliveries", id], transport, env);
  assert.match(human.stdout, /^No deliveries in the last seven days$/m);
  for (const limit of ["0", "101", "x"]) {
    assert.equal((await cli(["--json", "triggers", "deliveries", id, "--limit", limit], transport, env)).code, ExitCode.Usage, limit);
  }
  assert.equal((await cli(["--json", "triggers", "deliveries", "nope"], transport, env)).code, ExitCode.Usage);
});

test("triggers rotate-secret --signing prints the new signing secret once", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const plain = await cli(["--json", "triggers", "create", "--name", "Lobby", "--kind", "overlay", "--show", "bar", "--tag", "Lobby"], transport, env);
  const refused = await cli(["--json", "triggers", "rotate-secret", plain.envelope.data.id, "--signing"], transport, env);
  assert.equal(refused.code, ExitCode.Client);
  assert.equal((triggerCalls(transport).at(-1)!.body as { signing?: boolean }).signing, true);

  const signed = await cli(["--json", "triggers", "create", "--name", "Signed", "--kind", "overlay", "--show", "takeover", "--tag", "Lobby", "--signing"], transport, env);
  const rotated = await cli(["--json", "triggers", "rotate-secret", signed.envelope.data.id, "--signing"], transport, env);
  assert.equal(rotated.code, 0, rotated.stdout);
  assert.match(rotated.envelope.data.signing_secret, /^whsec_/);
  assert.notEqual(rotated.envelope.data.signing_secret, signed.envelope.data.signing_secret);
  assert.equal(rotated.envelope.data.password, undefined);
  assert.deepEqual(rotated.envelope.warnings?.map((warning) => warning.code), ["trigger_signing_secret_shown_once"]);
  const human = await cli(["--human", "triggers", "rotate-secret", signed.envelope.data.id, "--signing"], transport, env);
  assert.match(human.stdout, /^Rotated the signing secret of trigger trg_\S+$/m);
  assert.match(human.stdout, /^signing_secret: whsec_\S{43}$/m);
});

test("triggers help shows the overlay options and examples", async () => {
  for (const command of [["triggers", "create"], ["triggers", "update"], ["triggers", "deliveries"], ["triggers", "clear"], ["triggers", "rotate-secret"]]) {
    const help = commandHelp(command);
    assert.ok(help.examples && help.examples.length > 0, `${command.join(" ")} has an example`);
  }
  const create = JSON.stringify(commandHelp(["triggers", "create"]));
  for (const text of ["--kind", "--show", "--edge", "--style", "--map", "--signing", "overlay"]) assert.ok(create.includes(text), `create help mentions ${text}`);
  const guidance = JSON.stringify(commandHelp(["triggers", "create"]));
  assert.match(guidance, /alert_id/);
  assert.match(guidance, /Authorization: Bearer/);
  assert.match(guidance, /ScreenRig-Signature/);
  assert.doesNotMatch(guidance, /screentinker/i);
});
