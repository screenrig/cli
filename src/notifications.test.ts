import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { test } from "node:test";
import { commandHelp } from "./help-tree.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { createMemoryLogger } from "./log/logger.js";
import type { OperationLogger } from "./log/types.js";
import { run, type CliRuntime } from "./main.js";
import { networkError } from "./problems.js";
import { redactText } from "./redact.js";
import { testTemp } from "./test-temp.js";
import { deliveryGroupCell, notificationDeliveryTableLines, notificationLines, notificationTableLines, snoozedUntil } from "./notifications.js";
import type { Notification, NotificationDelivery } from "./adapters/protocol.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest } from "./transport/types.js";

const MISSING = "ntf_MISSINGAAAAAAAAAAAAAA";
const URL_OK = "https://hooks.example.com/screenrig/rcv_token_in_path";
const NOW = new Date("2026-08-14T17:00:00.000Z");

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
  const configDir = await testTemp("notifications-cfg-");
  const cwd = await testTemp("notifications-cwd-");
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
    now: () => NOW,
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

const notificationCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => call.path.startsWith("/api/notifications"));

async function createEmail(transport: FakeTransport, env: Env, ...extra: string[]) {
  const created = await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "screen_offline", ...extra], transport, env);
  assert.equal(created.code, 0, created.stdout);
  return created.envelope.data as { id: string; revision: number };
}

async function createWebhook(transport: FakeTransport, env: Env, ...extra: string[]) {
  const created = await cli(["--json", "notifications", "create", "--webhook", URL_OK, "--conditions", "screen_offline", "--events", "screen.*,playlist.updated", ...extra], transport, env);
  assert.equal(created.code, 0, created.stdout);
  return created.envelope.data as { id: string; secret: string; revision: number };
}

test("notifications create --email sends recipients and screen scope with a key and prints no secret", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const created = await cli(["--json", "notifications", "create", "--email", "owner,usr_PERSON", "--conditions", "screen_offline,display_disconnected", "--tag", "Lobby", "--tag", "Floor2,Entrance", "--hold", "5", "--description", "Screens offline"], transport, env);
  assert.equal(created.code, 0, created.stdout);
  const call = notificationCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/notifications");
  assert.deepEqual(call.body, {
    channel: "email", recipients: ["owner", "usr_PERSON"], conditions: ["screen_offline", "display_disconnected"],
    screen_tags: ["Lobby", "Floor2", "Entrance"], hold_minutes: 5, description: "Screens offline",
  });
  assert.ok(call.headers?.["idempotency-key"], "create always sends an Idempotency-Key");
  assert.match(created.envelope.data.id, /^ntf_/);
  assert.equal(created.envelope.data.channel, "email");
  assert.equal(created.envelope.data.secret, undefined);
  assert.ok(!created.envelope.warnings?.length, "an email notification has no secret to warn about");
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/, "a completed create clears its recovery entry");

  const zero = await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "crashing", "--hold", "0", "--disabled"], transport, env);
  assert.equal(zero.code, 0, zero.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { channel: "email", recipients: ["owner"], conditions: ["crashing"], hold_minutes: 0, enabled: false });
  assert.equal(zero.envelope.data.status, "disabled");

  const human = await cli(["--human", "notifications", "create", "--email", "owner", "--conditions", "storage_full"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Created notification ntf_/m);
  assert.match(human.stdout, /^channel: email$/m);
  assert.match(human.stdout, /^recipients: owner$/m);
  assert.match(human.stdout, /^conditions: storage_full$/m);
  assert.match(human.stdout, /^screen_tags: \(every screen\)$/m);
  assert.match(human.stdout, /^hold_minutes: 10$/m);
  assert.doesNotMatch(human.stdout, /secret|warning/);
});

test("notifications create --webhook prints the secret once with a warning and never persists it", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { logger, events } = createMemoryLogger({ command: ["notifications", "create"] });
  const created = await cli(["--json", "notifications", "create", "--webhook", URL_OK, "--conditions", "screen_offline,crashing", "--events", "screen.*,playlist.updated", "--description", "Ops bot"], transport, env, logger);
  assert.equal(created.code, 0, created.stdout);
  const call = notificationCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/notifications");
  assert.deepEqual(call.body, { channel: "webhook", url: URL_OK, conditions: ["screen_offline", "crashing"], event_types: ["screen.*", "playlist.updated"], description: "Ops bot" });
  assert.ok(call.headers?.["idempotency-key"]);
  assert.match(created.envelope.data.id, /^whk_/);
  assert.match(created.envelope.data.secret, /^whsec_/);
  assert.equal(created.envelope.data.enabled, true);
  assert.deepEqual(created.envelope.warnings?.map((warning) => warning.code), ["webhook_secret_shown_once"]);
  assert.match(created.envelope.warnings![0]!.message, /shown only in this answer/);
  assert.match(created.envelope.warnings![0]!.message, new RegExp(`notifications rotate-secret ${created.envelope.data.id}`));

  const config = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(config, /whsec_/, "the secret never reaches config");
  assert.doesNotMatch(config, /pending_writes/, "a completed create clears its recovery entry");
  const logged = JSON.stringify(events);
  assert.ok(events.length > 0, "the operation log recorded the request");
  assert.doesNotMatch(logged, /whsec_/, "the secret never reaches the operation log");
  assert.doesNotMatch(logged, /rcv_token_in_path/, "webhook URLs never reach the operation log");

  const eventsOnly = await cli(["--json", "notifications", "create", "--webhook", URL_OK, "--events", "screen.offline", "--disabled"], transport, env);
  assert.equal(eventsOnly.code, 0, eventsOnly.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { channel: "webhook", url: URL_OK, event_types: ["screen.offline"], enabled: false });

  const human = await cli(["--human", "notifications", "create", "--webhook", URL_OK, "--conditions", "running_hot"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Created notification whk_/m);
  assert.match(human.stdout, /^channel: webhook$/m);
  assert.match(human.stdout, /^secret: whsec_\S+$/m);
  assert.match(human.stdout, /^warning: data\.secret is this webhook's signing secret/m);
});

test("an ambiguous notifications create reruns with the saved key and the server replays the same secret", async () => {
  const env = await enrolled();
  const backend = memoryBackend();
  let lose = true;
  const original = backend.request.bind(backend);
  backend.request = async (req) => {
    const response = await original(req);
    if (lose && req.method === "POST" && req.path === "/api/notifications") {
      lose = false;
      throw networkError("connection reset after the request was sent");
    }
    return response;
  };
  const argv = ["--json", "notifications", "create", "--webhook", URL_OK, "--conditions", "screen_offline"];
  const lost = await cli(argv, backend, env);
  assert.equal(lost.code, ExitCode.Network, lost.stdout);
  assert.ok(lost.envelope.warnings?.some((warning) => warning.code === "write_recovery_saved"));
  const pending = await readFile(env.configPath, "utf8");
  assert.match(pending, /pending_writes/, "the key is saved for the rerun");
  assert.match(pending, /notifications create/, "recovery list can name the command");
  assert.doesNotMatch(pending, /whsec_|hooks\.example\.com/, "the ledger holds no request or response content");

  const rerun = await cli(argv, backend, env);
  assert.equal(rerun.code, 0, rerun.stdout);
  const posts = notificationCalls(backend).filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.headers?.["idempotency-key"], posts[0]!.headers?.["idempotency-key"], "the rerun reuses the saved key");
  assert.match(rerun.envelope.data.secret, /^whsec_/);
  const listed = await cli(["--json", "notifications", "list"], backend, env);
  assert.equal(listed.envelope.data.items.length, 1, "the replay did not create a second notification");
  assert.equal(listed.envelope.data.items[0].id, rerun.envelope.data.id);
  assert.equal(listed.envelope.data.items[0].secret, undefined, "list never carries a secret");
  const after = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(after, /whsec_|pending_writes/);
});

test("notifications create validates input and declared relationships before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const email = ["--email", "owner", "--conditions", "screen_offline"];
  const webhook = ["--webhook", URL_OK, "--conditions", "screen_offline"];
  const cases: Array<[string[], RegExp]> = [
    [["--webhook", "http://hooks.example.com/x", "--conditions", "screen_offline"], /--webhook must be an absolute https URL/],
    [["--webhook", "not a url", "--conditions", "screen_offline"], /--webhook must be an absolute https URL/],
    [["--webhook", "https://user:pass@hooks.example.com/x", "--conditions", "screen_offline"], /--webhook must not carry credentials/],
    [["--webhook", "https://hooks.example.com/x#frag", "--conditions", "screen_offline"], /--webhook must not carry a fragment/],
    [["--email", "owner", "--conditions", "screen_offline,bogus"], /--conditions does not take "bogus"; use screen_offline, display_disconnected, running_hot, storage_full, content_stuck, not_playing, loop_stalled, glass_blank, glass_frozen, crashing/],
    [["--email", "owner", "--conditions", "Screen_Offline"], /--conditions does not take "Screen_Offline"/],
    [["--email", "owner", "--conditions", "screen_offline,,running_hot"], /--conditions takes comma-separated conditions with no empty entries/],
    [["--email", "owner", "--conditions", "screen_offline,screen_offline"], /--conditions must not repeat a condition/],
    [[...email, "--hold", "-1"], /--hold must be a whole number of minutes from 0 to 1440/],
    [[...email, "--hold", "1441"], /--hold must be a whole number of minutes from 0 to 1440/],
    [[...email, "--hold", "1.5"], /--hold must be a whole number of minutes from 0 to 1440/],
    [[...email, "--hold", "soon"], /--hold must be a whole number of minutes from 0 to 1440/],
    [[...email, "--tag", "Lobby!"], /--tag takes comma-separated tags of 1 to 32 letters or digits/],
    [[...email, "--tag", "Lobby", "--tag", "Lobby"], /--tag lists a tag more than once/],
    [[...email, "--tag", Array.from({ length: 17 }, (_, index) => `t${index}`).join(",")], /--tag accepts at most 16 tags/],
    [[...email, "--description", "x".repeat(201)], /at most 200 characters/],
    [["--email", "owner,,usr_A", "--conditions", "screen_offline"], /--email takes comma-separated recipients with no empty entries/],
    [["--email", "owner,owner", "--conditions", "screen_offline"], /--email must not repeat a recipient/],
    [["--email", "owner usr_A", "--conditions", "screen_offline"], /--email recipients are owner or a project member's user id: no spaces/],
    [["--email", Array.from({ length: 21 }, (_, index) => `usr_${index}`).join(","), "--conditions", "screen_offline"], /--email takes at most 20 recipients/],
    [["--webhook", URL_OK, "--events", "screen"], /--events entries must be event types such as screen\.online/],
    [["--webhook", URL_OK, "--events", "screen.*,screen.*"], /--events must not repeat an event type/],
    [["--webhook", URL_OK, "--events", "screen.online,,screen.offline"], /--events takes comma-separated event types with no empty entries/],
    [["--webhook", URL_OK, "--events", Array.from({ length: 33 }, (_, index) => `a.t${index}`).join(",")], /--events takes at most 32 event types/],
    [[], /Provide exactly one of --email or --webhook/],
    [["--conditions", "screen_offline"], /Provide exactly one of --email or --webhook/],
    [["--email", "owner", "--webhook", URL_OK, "--conditions", "screen_offline"], /--email cannot be used with --webhook|--webhook cannot be used with --email/],
    [["--email", "owner"], /Provide at least one of --conditions or --events/],
    [["--webhook", URL_OK], /Provide at least one of --conditions or --events/],
    [["--email", "owner", "--events", "screen.*"], /--email requires --conditions/],
    [[...email, "--events", "screen.*"], /--events requires --webhook/],
    [[...webhook, "--url", URL_OK], /notifications create does not accept --url/],
  ];
  for (const [args, message] of cases) {
    const refused = await cli(["--json", "notifications", "create", ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, args.join(" "));
  }
  assert.equal(notificationCalls(transport).length, 0, "invalid input never reaches the server");
});

test("--conditions accepts glass_blank and glass_frozen beside the other conditions", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const created = await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "glass_blank,glass_frozen,loop_stalled"], transport, env);
  assert.equal(created.code, 0, created.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { channel: "email", recipients: ["owner"], conditions: ["glass_blank", "glass_frozen", "loop_stalled"] });
  assert.deepEqual(created.envelope.data.conditions, ["glass_blank", "glass_frozen", "loop_stalled"]);
  const updated = await cli(["--json", "notifications", "update", created.envelope.data.id, "--conditions", "glass_frozen"], transport, env);
  assert.equal(updated.code, 0, updated.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { conditions: ["glass_frozen"] });
});

test("--conditions accepts loop_stalled beside the other conditions", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const created = await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "not_playing,loop_stalled"], transport, env);
  assert.equal(created.code, 0, created.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { channel: "email", recipients: ["owner"], conditions: ["not_playing", "loop_stalled"] });
  assert.deepEqual(created.envelope.data.conditions, ["not_playing", "loop_stalled"]);
  const updated = await cli(["--json", "notifications", "update", created.envelope.data.id, "--conditions", "loop_stalled"], transport, env);
  assert.equal(updated.code, 0, updated.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { conditions: ["loop_stalled"] });
});

test("--conditions accepts not_playing on create and update, beside the other conditions", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const created = await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "screen_offline,not_playing"], transport, env);
  assert.equal(created.code, 0, created.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { channel: "email", recipients: ["owner"], conditions: ["screen_offline", "not_playing"] });
  assert.deepEqual(created.envelope.data.conditions, ["screen_offline", "not_playing"]);

  const updated = await cli(["--json", "notifications", "update", created.envelope.data.id, "--conditions", "not_playing,crashing"], transport, env);
  assert.equal(updated.code, 0, updated.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { conditions: ["not_playing", "crashing"] });

  const webhook = await cli(["--json", "notifications", "create", "--webhook", URL_OK, "--conditions", "not_playing"], transport, env);
  assert.equal(webhook.code, 0, webhook.stdout);
  assert.deepEqual(webhook.envelope.data.conditions, ["not_playing"]);

  const repeated = await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "not_playing,not_playing"], transport, env);
  assert.equal(repeated.code, ExitCode.Usage, repeated.stdout);
  assert.match(repeated.envelope.error!.detail, /--conditions must not repeat a condition/);
});

test("webhook_url_rejected shows the server's reason, exits 8, and clears the recovery key", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  for (const [url, reason] of [
    ["https://hooks.example.com:8080/x", "url port must be 443 (the default) or 8443."],
    ["https://127.0.0.1/x", "url host must be a public Internet address."],
  ] as const) {
    const refused = await cli(["--json", "notifications", "create", "--webhook", url, "--conditions", "screen_offline"], transport, env);
    assert.equal(refused.code, ExitCode.Client, refused.stdout);
    assert.equal(refused.envelope.error!.code, "webhook_url_rejected");
    assert.equal(refused.envelope.error!.detail, `The webhook URL was rejected: ${reason}`);
    assert.match(refused.envelope.error!.next!.command, /^screenrig notifications create --webhook /);
    assert.match(refused.envelope.error!.next!.reason, /port 443 \(the default\) or 8443.*public Internet addresses/);
    assert.equal(refused.envelope.warnings, undefined, "a definite refusal keeps no recovery state");
  }
  const human = await cli(["--human", "notifications", "create", "--webhook", "https://hooks.example.com:8080/x", "--conditions", "screen_offline"], transport, env);
  assert.equal(human.code, ExitCode.Client);
  assert.match(human.stderr, /webhook_url_rejected\/400/);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);

  const { id } = await createWebhook(transport, env);
  const update = await cli(["--json", "notifications", "update", id, "--url", "https://hooks.example.com:9443/x"], transport, env);
  assert.equal(update.code, ExitCode.Client);
  assert.equal(update.envelope.error!.code, "webhook_url_rejected");
  assert.match(update.envelope.error!.detail, /port must be 443/);
  assert.equal(update.envelope.error!.next!.command, `screenrig notifications update ${id} --url https://HOST/PATH`);
});

test("notification_limit_reached counts both channels: exit 5, guidance, no saved key", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  for (let index = 0; index < 20; index += 1) {
    if (index % 2) await createWebhook(transport, env, "--description", `hook ${index}`);
    else await createEmail(transport, env, "--description", `mail ${index}`);
  }
  const refused = await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "screen_offline"], transport, env);
  assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
  assert.equal(refused.envelope.error!.code, "notification_limit_reached");
  assert.match(refused.envelope.error!.detail, /maximum of 20 notifications of every channel together/);
  assert.equal(refused.envelope.error!.next!.command, "screenrig notifications list");
  assert.match(refused.envelope.error!.next!.reason, /notifications delete ID/);
  assert.equal(refused.envelope.warnings, undefined);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
  // The webhook routes count the same notifications.
  const legacy = await cli(["--json", "webhooks", "create", "--url", URL_OK, "--event-types", "screen.*"], transport, env);
  assert.equal(legacy.code, ExitCode.Conflict, legacy.stdout);
  assert.equal(legacy.envelope.error!.code, "webhook_limit_reached");
});

test("notifications list and show render JSON by default and tables in human mode", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const empty = await cli(["--human", "notifications", "list"], transport, env);
  assert.match(empty.stdout, /^Notifications \(0\)\nNo notifications$/m);
  const mail = await createEmail(transport, env, "--description", "Screens offline");
  const hook = await createWebhook(transport, env);

  const listed = await cli(["notifications", "list"], transport, env);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.envelope.data.items.map((item: { id: string }) => item.id), [mail.id, hook.id]);
  assert.equal(listed.envelope.data.items[1].secret, undefined, "list never carries a secret");
  const human = await cli(["--human", "notifications", "list"], transport, env);
  assert.match(human.stdout, /ID\s+CHANNEL\s+STATUS\s+ENABLED\s+CONDITIONS\s+EVENTS\s+TO/);
  assert.match(human.stdout, new RegExp(`${mail.id}\\s+email\\s+active\\s+true\\s+screen_offline\\s+owner$`, "m"));
  assert.match(human.stdout, new RegExp(`${hook.id}\\s+webhook\\s+active\\s+true\\s+screen_offline\\s+screen\\.\\*,playlist\\.updated\\s+https://hooks\\.example\\.com/`));
  assert.doesNotMatch(human.stdout, /whsec_/);

  const shown = await cli(["--json", "notifications", "show", mail.id], transport, env);
  assert.equal(shown.code, 0);
  assert.equal(notificationCalls(transport).at(-1)!.path, `/api/notifications/${mail.id}`);
  assert.equal(shown.envelope.data.revision, 1);
  const shownHuman = await cli(["--human", "notifications", "show", hook.id], transport, env);
  assert.match(shownHuman.stdout, /^status: active$/m);
  assert.match(shownHuman.stdout, /^url: https:\/\/hooks\.example\.com\//m);
  assert.match(shownHuman.stdout, /^event_types: screen\.\*, playlist\.updated$/m);
  assert.doesNotMatch(shownHuman.stdout, /whsec_/);

  const missing = await cli(["--json", "notifications", "show", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
  const before = transport.calls.length;
  const malformed = await cli(["--json", "notifications", "show", "scr_AAAAAAAAAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(malformed.code, ExitCode.Usage);
  assert.equal(malformed.envelope.error!.next!.command, "screenrig notifications list");
  assert.equal(transport.calls.length, before, "a malformed id is refused locally");
});

test("notifications update sends only supplied fields with the revision guard", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await createEmail(transport, env, "--description", "Screens offline");

  const changed = await cli(["--json", "notifications", "update", id, "--conditions", "screen_offline,running_hot", "--hold", "0", "--expect-rev", "1"], transport, env);
  assert.equal(changed.code, 0, changed.stdout);
  let call = notificationCalls(transport).at(-1)!;
  assert.equal(call.method, "PATCH");
  assert.equal(call.path, `/api/notifications/${id}`);
  assert.deepEqual(call.body, { conditions: ["screen_offline", "running_hot"], hold_minutes: 0 });
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.equal(changed.envelope.data.revision, 2);
  assert.equal(changed.envelope.data.hold_minutes, 0);

  const tagged = await cli(["--json", "notifications", "update", id, "--tag", "Lobby", "--tag", "Floor2"], transport, env);
  assert.equal(tagged.code, 0, tagged.stdout);
  call = notificationCalls(transport).at(-1)!;
  // Setting the tags clears any audience in the same request: the two exclude each other.
  assert.deepEqual(call.body, { screen_tags: ["Lobby", "Floor2"], audience: null });
  assert.equal(call.headers?.["if-match"], undefined, "no --expect-rev sends no If-Match");
  assert.deepEqual(tagged.envelope.data.screen_tags, ["Lobby", "Floor2"]);
  const everywhere = await cli(["--json", "notifications", "update", id, "--all-screens"], transport, env);
  assert.equal(everywhere.code, 0, everywhere.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { screen_tags: [], audience: null });
  assert.deepEqual(everywhere.envelope.data.screen_tags, []);

  const recipients = await cli(["--json", "notifications", "update", id, "--email", "owner,usr_OTHER"], transport, env);
  assert.equal(recipients.code, 0, recipients.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { recipients: ["owner", "usr_OTHER"] });

  const disabled = await cli(["--json", "notifications", "update", id, "--disable", "--clear-description"], transport, env);
  assert.equal(disabled.code, 0, disabled.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { description: "", enabled: false });
  assert.equal(disabled.envelope.data.enabled, false);
  assert.equal(disabled.envelope.data.description, undefined);

  const enabled = await cli(["--human", "notifications", "update", id, "--enable", "--description", "Back on"], transport, env);
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { description: "Back on", enabled: true });
  assert.match(enabled.stdout, new RegExp(`^Updated notification ${id}$`, "m"));
  assert.match(enabled.stdout, /^enabled: true$/m);

  const stale = await cli(["--json", "notifications", "update", id, "--disable", "--expect-rev", "1"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition, stale.stdout);
  assert.equal(stale.envelope.error!.code, "revision_conflict");
  assert.equal(stale.envelope.error!.next!.command, `screenrig notifications show ${id}`);
});

test("notifications update snoozes for a duration or until an instant, and off ends it", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await createEmail(transport, env);

  const hours = await cli(["--json", "notifications", "update", id, "--snooze", "4h"], transport, env);
  assert.equal(hours.code, 0, hours.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { snoozed_until: "2026-08-14T21:00:00Z" });
  assert.equal(hours.envelope.data.snoozed_until, "2026-08-14T21:00:00Z");
  const listed = await cli(["--human", "notifications", "list"], transport, env);
  assert.match(listed.stdout, /STATUS\s+ENABLED\s+SNOOZED_UNTIL\s+CONDITIONS/);
  assert.match(listed.stdout, /2026-08-14T21:00:00Z/);
  const shown = await cli(["--human", "notifications", "show", id], transport, env);
  assert.match(shown.stdout, /^snoozed_until: 2026-08-14T21:00:00Z$/m);

  const instant = await cli(["--json", "notifications", "update", id, "--snooze", "2026-09-01T09:00:00-07:00"], transport, env);
  assert.equal(instant.code, 0, instant.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { snoozed_until: "2026-09-01T16:00:00Z" });

  const off = await cli(["--json", "notifications", "update", id, "--snooze", "off"], transport, env);
  assert.equal(off.code, 0, off.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { snoozed_until: null }, "off sends null");
  assert.equal(off.envelope.data.snoozed_until, undefined);

  const before = notificationCalls(transport).length;
  for (const value of ["0m", "30d", "31d", "tomorrow", "2026-09-01", "2026-09-01T09:00:00", "-5m", "1x", "OFF"]) {
    const refused = await cli(["--json", "notifications", "update", id, `--snooze=${value}`], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${value}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, /--snooze (takes a duration|must be under 30 days)/, value);
  }
  assert.equal(notificationCalls(transport).length, before, "a bad snooze never reaches the server");
});

test("--snooze parsing: durations count from now, instants are normalized, 30 days is the ceiling", () => {
  for (const [value, expected] of [
    ["30m", "2026-08-14T17:30:00Z"],
    ["1h", "2026-08-14T18:00:00Z"],
    ["4h", "2026-08-14T21:00:00Z"],
    ["2d", "2026-08-16T17:00:00Z"],
    ["1h30m", "2026-08-14T18:30:00Z"],
    ["90s", "2026-08-14T17:01:30Z"],
    ["29d23h59m", "2026-09-13T16:59:00Z"],
    ["off", null],
    ["2026-09-01T16:00:00Z", "2026-09-01T16:00:00Z"],
    ["2026-09-01T09:00:00-07:00", "2026-09-01T16:00:00Z"],
  ] as const) {
    assert.equal(snoozedUntil(value, NOW), expected, value);
  }
  for (const value of ["0m", "30d", "29d23h59m1s", "31d", "", "soon", "1w", "2026-09-01", "2026-13-01T00:00:00Z"]) {
    assert.throws(() => snoozedUntil(value, NOW), /--snooze/, value);
  }
});

test("notifications update validates before any request and leaves channel rules to the server", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const mail = await createEmail(transport, env);
  const hook = await createWebhook(transport, env);

  const before = transport.calls.length;
  for (const [args, message] of [
    [[], /Provide at least one of --email or --url or --destination or --telegram-chat or --conditions or --clear-conditions or --events/],
    [["--enable", "--disable"], /--enable cannot be used with --disable/],
    [["--description", "x", "--clear-description"], /--clear-description cannot be used with --description|--description cannot be used with --clear-description/],
    [["--tag", "Lobby", "--all-screens"], /--all-screens cannot be used with --tag|--tag cannot be used with --all-screens/],
    [["--conditions", "screen_offline", "--clear-conditions"], /--clear-conditions cannot be used with --conditions|--conditions cannot be used with --clear-conditions/],
    [["--events", "screen.*", "--clear-events"], /--clear-events cannot be used with --events|--events cannot be used with --clear-events/],
    [["--email", "owner", "--url", URL_OK], /--email cannot be used with --url|--url cannot be used with --email/],
    [["--url", "http://x.example.com/"], /--url must be an absolute https URL/],
    [["--conditions", "bogus"], /--conditions does not take "bogus"/],
    [["--events", "screen"], /--events entries must be event types/],
    [["--hold", "1441"], /--hold must be a whole number of minutes/],
    [["--tag", "Lobby!"], /--tag takes comma-separated tags/],
    [["--email", "owner,owner"], /--email must not repeat a recipient/],
    [["--description", "x".repeat(201)], /at most 200 characters/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "notifications", "update", mail.id, ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, args.join(" "));
  }
  assert.equal(transport.calls.length, before);

  // A field of the other channel, or a set the channel cannot lose, is the server's invalid_request (exit 8).
  for (const [target, args] of [
    [mail.id, ["--url", URL_OK]],
    [mail.id, ["--events", "screen.*"]],
    [hook.id, ["--email", "owner"]],
    [mail.id, ["--clear-conditions"]],
  ] as const) {
    const refused = await cli(["--json", "notifications", "update", target, ...args], transport, env);
    assert.equal(refused.code, ExitCode.Client, `${args.join(" ")}: ${refused.stdout}`);
    assert.equal(refused.envelope.error!.code, "invalid_request");
  }
  const cleared = await cli(["--json", "notifications", "update", hook.id, "--clear-events"], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { event_types: [] });
  assert.deepEqual(cleared.envelope.data.event_types, []);
  const bare = await cli(["--json", "notifications", "update", hook.id, "--clear-conditions"], transport, env);
  assert.equal(bare.code, ExitCode.Client, "a webhook keeps conditions or events");
});

test("notifications delete returns a deletion envelope and honors --expect-rev", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await createEmail(transport, env);
  const stale = await cli(["--json", "notifications", "delete", id, "--expect-rev", "7"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition);
  const deleted = await cli(["--json", "notifications", "delete", id, "--expect-rev", "1"], transport, env);
  assert.equal(deleted.code, 0, deleted.stdout);
  const call = notificationCalls(transport).at(-1)!;
  assert.equal(call.method, "DELETE");
  assert.equal(call.path, `/api/notifications/${id}`);
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.deepEqual(deleted.envelope.data, { id, deleted: true });
  const gone = await cli(["--human", "notifications", "delete", id], transport, env);
  assert.equal(gone.code, ExitCode.NotFound);
  const { id: other } = await createWebhook(transport, env);
  const human = await cli(["--human", "notifications", "delete", other], transport, env);
  assert.match(human.stdout, new RegExp(`^Deleted notification ${other}\\. Its pending notices fail with webhook_deleted`, "m"));
});

test("notifications rotate-secret prints the new secret once, never persists it, and refuses email", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const first = await createWebhook(transport, env);
  const rotated = await cli(["--json", "notifications", "rotate-secret", first.id, "--expect-rev", "1"], transport, env);
  assert.equal(rotated.code, 0, rotated.stdout);
  const call = notificationCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/notifications/${first.id}/rotate-secret`);
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.match(rotated.envelope.data.secret, /^whsec_/);
  assert.notEqual(rotated.envelope.data.secret, first.secret);
  assert.equal(rotated.envelope.warnings?.[0]?.code, "webhook_secret_shown_once");
  assert.match(rotated.envelope.warnings![0]!.message, /accept both briefly/);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /whsec_|pending_writes/);
  const human = await cli(["--human", "notifications", "rotate-secret", first.id], transport, env);
  assert.match(human.stdout, new RegExp(`^Rotated the signing secret of notification ${first.id}$`, "m"));
  assert.match(human.stdout, /^secret: whsec_/m);

  const mail = await createEmail(transport, env);
  const email = await cli(["--json", "notifications", "rotate-secret", mail.id], transport, env);
  assert.equal(email.code, ExitCode.Client, email.stdout);
  assert.equal(email.envelope.error!.code, "invalid_request");
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/, "a definite refusal keeps no recovery state");
  const missing = await cli(["--json", "notifications", "rotate-secret", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
});

test("notifications test queues one delivery and deliveries pages the log", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await createEmail(transport, env);
  const tested = await cli(["--json", "notifications", "test", id], transport, env);
  assert.equal(tested.code, 0, tested.stdout);
  const call = notificationCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/notifications/${id}/test`);
  assert.ok(call.headers?.["idempotency-key"]);
  assert.equal(tested.envelope.data.event_type, "notification.test");
  assert.equal(tested.envelope.data.test, true);
  const human = await cli(["--human", "notifications", "test", id], transport, env);
  assert.match(human.stdout, new RegExp(`^Queued a test delivery to notification ${id}$`, "m"));
  assert.match(human.stdout, new RegExp(`screenrig notifications deliveries ${id} --limit 1`));

  const page = await cli(["--json", "notifications", "deliveries", id, "--limit", "1"], transport, env);
  assert.equal(page.code, 0, page.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.query, { limit: "1" });
  assert.equal(page.envelope.data.items.length, 1);
  assert.equal(page.envelope.data.next_cursor, "whc2_1_screen_offline");
  const nextPage = await cli(["--json", "notifications", "deliveries", id, "--before", "whc2_1_screen_offline"], transport, env);
  assert.deepEqual(notificationCalls(transport).at(-1)!.query, { before: "whc2_1_screen_offline" });
  assert.equal(nextPage.envelope.data.next_cursor, null);
  const table = await cli(["--human", "notifications", "deliveries", id, "--limit", "1"], transport, env);
  assert.match(table.stdout, /ID\s+EVENT_TYPE\s+STATE\s+ATTEMPTS\s+LAST_STATUS\s+LAST_ERROR\s+CREATED_AT/);
  assert.match(table.stdout, /notification\.test \(test\)\s+pending\s+0/);
  assert.match(table.stdout, new RegExp(`^next: screenrig notifications deliveries ${id} --before whc2_1_screen_offline --limit 1$`, "m"));

  const before = transport.calls.length;
  for (const args of [["--before", "cursor"], ["--limit", "0"], ["--limit", "201"], ["--limit", "1.5"]]) {
    const refused = await cli(["--json", "notifications", "deliveries", id, ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
  }
  const cursor = await cli(["--json", "notifications", "deliveries", id, "--before", "cursor"], transport, env);
  assert.match(cursor.envelope.error!.detail, /previous notifications deliveries page/);
  assert.equal(transport.calls.length, before);
  const missing = await cli(["--json", "notifications", "deliveries", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
});

test("deliveries shows screen notices with their condition, phase, screen and recipients reached", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await createEmail(transport, env);
  transport.putNotificationDelivery!(id, {
    id: "whd_NOTICEAAAAAAAAAAAAAA", notification_id: id, event_id: "ev1_7", event_type: "screen.offline", condition: "screen_offline", phase: "opened",
    screen_id: "scr_LOBBYAAAAAAAAAAAAAAAA", screen_name: "Lobby TV", since: "2026-08-14T16:40:00.000Z", emailed: 2, state: "succeeded", attempts: 1,
    created_at: "2026-08-14T16:50:00.000Z",
  });
  transport.putNotificationDelivery!(id, {
    id: "whd_SKIPPEDAAAAAAAAAAAAAA", notification_id: id, event_id: "ev1_9", event_type: "screen.online", condition: "screen_offline", phase: "resolved",
    screen_id: "scr_LOBBYAAAAAAAAAAAAAAAA", state: "skipped", attempts: 0, last_error: "no_recipients", created_at: "2026-08-14T16:55:00.000Z",
  });
  const json = await cli(["--json", "notifications", "deliveries", id], transport, env);
  assert.equal(json.code, 0, json.stdout);
  assert.equal(json.envelope.data.items[0].last_error, "no_recipients");
  assert.equal(json.envelope.data.items[1].emailed, 2);
  const human = await cli(["--human", "notifications", "deliveries", id], transport, env);
  assert.match(human.stdout, /ID\s+EVENT_TYPE\s+CONDITION\s+PHASE\s+SCREEN\s+STATE\s+ATTEMPTS\s+LAST_STATUS\s+LAST_ERROR\s+EMAILED\s+CREATED_AT/);
  assert.match(human.stdout, /screen\.offline\s+screen_offline\s+opened\s+Lobby TV\s+succeeded\s+1\s+2\s+2026-08-14T16:50:00\.000Z/);
  assert.match(human.stdout, /screen\.online\s+screen_offline\s+resolved\s+scr_LOBBYAAAAAAAAAAAAAAAA\s+skipped\s+0\s+no_recipients/);

  // A log of event deliveries only keeps the narrow table.
  const rows: NotificationDelivery[] = [{ id: "whd_EVENTAAAAAAAAAAAAAAAA", notification_id: id, event_id: "ev1_1", event_type: "playlist.updated", state: "failed", attempts: 3, last_status: 502, last_error: "http_status", created_at: "2026-08-14T16:00:00.000Z" }];
  const narrow = notificationDeliveryTableLines(rows);
  assert.match(narrow[0]!, /^ID\s+EVENT_TYPE\s+STATE\s+ATTEMPTS\s+LAST_STATUS\s+LAST_ERROR\s+CREATED_AT$/);
  assert.match(narrow[1]!, /playlist\.updated\s+failed\s+3\s+502\s+http_status/);
  assert.deepEqual(notificationDeliveryTableLines([]), ["No deliveries"]);
});

test("deliveries names the acknowledged and muted skip reasons as the server sends them", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await createEmail(transport, env);
  for (const [deliveryId, reason] of [["whd_ACKEDAAAAAAAAAAAAAAAA", "acknowledged"], ["whd_MUTEDAAAAAAAAAAAAAAAA", "muted"]] as const) {
    transport.putNotificationDelivery!(id, {
      id: deliveryId, notification_id: id, event_id: "ev1_7", event_type: "screen.offline", condition: "not_playing", phase: "opened",
      screen_id: "scr_LOBBYAAAAAAAAAAAAAAAA", screen_name: "Lobby TV", state: "skipped", attempts: 0, last_error: reason, created_at: "2026-08-14T16:55:00.000Z",
    });
  }
  const json = await cli(["--json", "notifications", "deliveries", id], transport, env);
  assert.deepEqual(json.envelope.data.items.map((item: { last_error: string }) => item.last_error), ["muted", "acknowledged"]);
  const human = await cli(["--human", "notifications", "deliveries", id], transport, env);
  assert.match(human.stdout, /not_playing\s+opened\s+Lobby TV\s+skipped\s+0\s+muted/);
  assert.match(human.stdout, /not_playing\s+opened\s+Lobby TV\s+skipped\s+0\s+acknowledged/);
  const help = await cli(["--human", "notifications", "deliveries", "--help"], transport, env);
  assert.match(help.stdout, /acknowledged \(someone acknowledged or snoozed the screen's alert during the hold\), muted \(a mute covers the screen\)/);
});

test("deliveries shows the group a notice said and the group a skipped screen belongs to", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await createEmail(transport, env);
  const group = "ngr_LEADERAAAAAAAAAAAAAAA";
  transport.putNotificationDelivery!(id, {
    id: "whd_LEADERAAAAAAAAAAAAAAA", notification_id: id, event_id: "ev1_8", event_type: "screen.offline", condition: "screen_offline", phase: "opened",
    screen_id: "scr_LOBBYAAAAAAAAAAAAAAAA", screen_name: "Lobby TV", state: "succeeded", attempts: 1, emailed: 2, created_at: "2026-08-14T16:56:00.000Z",
    group: { id: group, attribute: "network", value: "203.0.113.7", count: 8 },
  });
  transport.putNotificationDelivery!(id, {
    id: "whd_MEMBERAAAAAAAAAAAAAAA", notification_id: id, event_id: "ev1_9", event_type: "screen.offline", condition: "screen_offline", phase: "opened",
    screen_id: "scr_CAFEAAAAAAAAAAAAAAAAA", screen_name: "Cafe TV", state: "skipped", attempts: 0, last_error: "grouped", group_id: group, created_at: "2026-08-14T16:56:01.000Z",
  });
  const human = await cli(["--human", "notifications", "deliveries", id], transport, env);
  assert.match(human.stdout, /SCREEN\s+GROUP\s+STATE/);
  assert.match(human.stdout, new RegExp(`Lobby TV\\s+${group}: 8 screens · network 203\\.0\\.113\\.7\\s+succeeded`));
  assert.match(human.stdout, new RegExp(`Cafe TV\\s+${group}\\s+skipped\\s+0\\s+grouped`));
  const many: NotificationDelivery = { id: "whd_MANYAAAAAAAAAAAAAAAAA", notification_id: id, event_id: "ev1_1", event_type: "screen.offline", state: "succeeded", attempts: 1, created_at: "2026-08-14T16:00:00.000Z", group: { id: group, attribute: "many_networks", value: "6 networks", count: 6 } };
  assert.equal(deliveryGroupCell(many), `${group}: 6 screens · 6 networks`);
  assert.equal(deliveryGroupCell({ ...many, group: undefined }), undefined);
  const help = await cli(["--human", "notifications", "deliveries", "--help"], transport, env);
  assert.match(help.stdout, /grouped \(the screen fell into the condition with others/);
  assert.match(help.stdout, /no_longer_judged/);
});

test("notification test rate limiting keeps the exit-7 convention", async () => {
  const env = await enrolled();
  const id = "ntf_LIMITEDAAAAAAAAAAAAAAA";
  const transport = new FakeTransport().on("POST", `/api/notifications/${id}/test`, () => ({
    status: 429, headers: { "content-type": "application/problem+json", "retry-after": "12" },
    body: { status: 429, code: "rate_limited", title: "Too many requests", detail: "notification-test-project limit reached." },
  }));
  const limited = await cli(["--json", "notifications", "test", id], transport, env);
  assert.equal(limited.code, ExitCode.RateLimited, limited.stdout);
  assert.equal(limited.envelope.error!.code, "rate_limited");
  assert.equal(limited.envelope.error!.next, undefined);
  assert.match(limited.envelope.error!.detail, /notification-test-project limit reached\. Retry-After is 12 seconds\./);
});

test("a secret answer that stdout cannot accept keeps the saved key for a replay", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const argv = ["--json", "notifications", "create", "--webhook", URL_OK, "--conditions", "screen_offline"];
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
    now: () => NOW, sleep: async () => undefined,
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
  const posts = notificationCalls(transport).filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.headers?.["idempotency-key"], posts[0]!.headers?.["idempotency-key"]);
  const listed = await cli(["--json", "notifications", "list"], transport, env);
  assert.equal(listed.envelope.data.items.length, 1, "the replay returned the first notification");
  assert.equal(listed.envelope.data.items[0].id, rerun.envelope.data.id);
  assert.match(rerun.envelope.data.secret, /^whsec_/);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes|whsec_/, "a flushed answer clears the key");
});

test("a webhook answer without a secret clears the saved key and points at rotate-secret; email needs none", async () => {
  const env = await enrolled();
  const id = "whk_NOSECRETAAAAAAAAAAAAAA";
  const base = { id, channel: "webhook", url: URL_OK, conditions: ["screen_offline"], screen_tags: [], hold_minutes: 10, enabled: true, revision: 1, status: "active", created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:00.000Z" };
  const mailId = "ntf_NOSECRETAAAAAAAAAAAAAA";
  const transport = new FakeTransport()
    .on("POST", "/api/notifications", (req) => ({
      status: 201, headers: {},
      body: (req.body as { channel?: string }).channel === "email"
        ? { ...base, id: mailId, channel: "email", url: undefined, recipients: ["owner"] }
        : base,
    }))
    .on("POST", `/api/notifications/${id}/rotate-secret`, () => ({ status: 200, headers: {}, body: { ...base, revision: 2 } }));
  for (const argv of [["notifications", "create", "--webhook", URL_OK, "--conditions", "screen_offline"], ["notifications", "rotate-secret", id]]) {
    const answered = await cli(["--json", ...argv], transport, env);
    assert.equal(answered.code, ExitCode.Unexpected, answered.stdout);
    assert.equal(answered.envelope.error!.code, "unexpected_response");
    assert.match(answered.envelope.error!.detail, /Do not rerun it/);
    assert.equal(answered.envelope.error!.next!.command, `screenrig notifications rotate-secret ${id}`);
    assert.equal(answered.envelope.warnings, undefined, "no write_recovery_saved: a rerun would not help");
    assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
  }
  const email = await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "screen_offline"], transport, env);
  assert.equal(email.code, 0, email.stdout);
  assert.equal(email.envelope.data.id, mailId);
});

test("problem answers on notification routes keep their bodies out of the operation log", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("POST", "/api/notifications", () => ({
    status: 400, headers: { "content-type": "application/problem+json" },
    body: { status: 400, code: "webhook_url_rejected", title: "Rejected", detail: "url host must be a public Internet address.", errors: [{ field: "url", detail: "rcv_token_in_path" }] },
  }));
  const { logger, events } = createMemoryLogger({ command: ["notifications", "create"] });
  const refused = await cli(["--json", "notifications", "create", "--webhook", URL_OK, "--conditions", "screen_offline"], transport, env, logger);
  assert.equal(refused.code, ExitCode.Client);
  assert.ok(events.length > 0);
  assert.doesNotMatch(JSON.stringify(events), /rcv_token_in_path/);
});

test("redaction masks notification webhook secrets in free text", () => {
  assert.equal(redactText("secret whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA end"), "secret whsec_*** end");
});

test("a receiver URL withheld from a Read only credential is said, never printed as the URL", () => {
  const notification: Notification = {
    id: "whk_NOTIFICATIONAAAAAA", channel: "webhook", url: "", url_redacted: true, conditions: ["screen_offline"], event_types: [], screen_tags: [],
    hold_minutes: 10, enabled: true, status: "active", revision: 1, created_at: "2026-10-27T12:00:00Z", updated_at: "2026-10-27T12:00:00Z",
  };
  assert.ok(notificationLines(notification).includes("url: withheld from a Read only credential. A Manage sign-in (screenrig login --access manage) receives it."));
  const mail: Notification = { ...notification, id: "ntf_NOTIFICATIONAAAAAA", channel: "email", url: undefined, url_redacted: undefined, recipients: ["owner", "usr_PERSON"] };
  const table = notificationTableLines([notification, mail]);
  assert.match(table[1]!, /\(withheld\)$/);
  assert.match(table[2]!, /owner,usr_PERSON$/);
  assert.equal(table.at(-1), "URLs: withheld from a Read only credential. A Manage sign-in (screenrig login --access manage) receives them.");
  // A Manage credential's URL prints as before, with no note.
  assert.equal(notificationTableLines([{ ...notification, url: "https://hooks.example.net/in", url_redacted: undefined }]).length, 2);
  assert.deepEqual(notificationTableLines([]), ["No notifications"]);
});

// Built from parts so the fixture is not mistaken for a real incoming-webhook URL by secret scanners.
const slackUrl = (...parts: string[]): string => ["https://hooks.slack.com/services", ...parts].join("/");
const SLACK_URL = slackUrl("T0123ABCD", "B0123ABCD", "x9Zq0123456789abcdefghij");
const TEAMS_URL = "https://prod-12.westus.logic.azure.com:443/workflows/0a1b2c3d/triggers/manual/paths/invoke?api-version=2016-06-01&sig=ZmFrZXNpZ25hdHVyZQ";
const PAGERDUTY_KEY = "R0123456789abcdefghijklmnopqrstu";
const TELEGRAM_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
/** The fragments of each credential that must reach no output, config or log. */
const CREDENTIAL_PARTS = ["x9Zq0123456789abcdefghij", "ZmFrZXNpZ25hdHVyZQ", "R0123456789abcdefghijklmnopqrstu", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"];

test("notifications create posts to Slack, Teams, PagerDuty and Telegram with a sealed destination", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { logger, events } = createMemoryLogger({ command: ["notifications", "create"] });
  const cases: Array<{ flags: string[]; body: Record<string, unknown>; hint: string; channel: string }> = [
    { flags: ["--slack", SLACK_URL], channel: "slack", hint: "https://hooks.slack.com/…/ghij", body: { channel: "slack", destination: SLACK_URL, conditions: ["screen_offline"] } },
    { flags: ["--teams", TEAMS_URL], channel: "teams", hint: "prod-12.westus.logic.azure.com/…VyZQ", body: { channel: "teams", destination: TEAMS_URL, conditions: ["screen_offline"] } },
    { flags: ["--pagerduty", PAGERDUTY_KEY], channel: "pagerduty", hint: "…rstu", body: { channel: "pagerduty", destination: PAGERDUTY_KEY, conditions: ["screen_offline"] } },
    {
      flags: ["--telegram", TELEGRAM_TOKEN, "--telegram-chat", "-1001234567890"], channel: "telegram", hint: "…Dsaw",
      body: { channel: "telegram", destination: TELEGRAM_TOKEN, telegram_chat_id: "-1001234567890", conditions: ["screen_offline"] },
    },
  ];
  for (const test of cases) {
    const created = await cli(["--json", "notifications", "create", ...test.flags, "--conditions", "screen_offline"], transport, env, logger);
    assert.equal(created.code, 0, created.stdout);
    const call = notificationCalls(transport).at(-1)!;
    assert.equal(call.method, "POST");
    assert.deepEqual(call.body, test.body);
    assert.ok(call.headers?.["idempotency-key"], "create always sends an Idempotency-Key");
    assert.match(created.envelope.data.id, /^ntf_/);
    assert.equal(created.envelope.data.channel, test.channel);
    assert.equal(created.envelope.data.destination_hint, test.hint);
    assert.equal(created.envelope.data.destination, undefined);
    assert.equal(created.envelope.data.secret, undefined);
    assert.ok(!created.envelope.warnings?.length, "a chat notification has no secret to warn about");
    for (const part of CREDENTIAL_PARTS) assert.ok(!created.stdout.includes(part), `${test.channel} answer holds ${part}`);

    const human = await cli(["--human", "notifications", "create", ...test.flags, "--conditions", "storage_full"], transport, env);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, new RegExp(`^channel: ${test.channel}$`, "m"));
    assert.ok(human.stdout.includes(`destination: ${test.hint} (the credential is sealed and never shown)`), human.stdout);
    for (const part of CREDENTIAL_PARTS) assert.ok(!human.stdout.includes(part), `${test.channel} human output holds ${part}`);
  }
  const config = await readFile(env.configPath, "utf8");
  const logged = JSON.stringify(events);
  for (const part of CREDENTIAL_PARTS) {
    assert.ok(!config.includes(part), `config holds ${part}`);
    assert.ok(!logged.includes(part), `operation log holds ${part}`);
  }
  assert.doesNotMatch(config, /pending_writes/, "a completed create clears its recovery entry");

  const listed = await cli(["--human", "notifications", "list"], transport, env);
  assert.match(listed.stdout, /https:\/\/hooks\.slack\.com\/…\/ghij/);
  assert.match(listed.stdout, /…Dsaw -> -1001234567890/);
  for (const part of CREDENTIAL_PARTS) assert.ok(!listed.stdout.includes(part), `list holds ${part}`);
});

test("a - credential is read from one line of stdin and never from the arguments", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const created = await cli(["--json", "notifications", "create", "--slack", "-", "--conditions", "screen_offline"], transport, env, undefined, `${SLACK_URL}\nignored second line\n`);
  assert.equal(created.code, 0, created.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { channel: "slack", destination: SLACK_URL, conditions: ["screen_offline"] });
  const telegram = await cli(["--json", "notifications", "create", "--telegram", "-", "--telegram-chat", "@opsroom", "--conditions", "crashing"], transport, env, undefined, `  ${TELEGRAM_TOKEN}\r\n`);
  assert.equal(telegram.code, 0, telegram.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { channel: "telegram", destination: TELEGRAM_TOKEN, telegram_chat_id: "@opsroom", conditions: ["crashing"] });
  const before = notificationCalls(transport).length;
  const empty = await cli(["--json", "notifications", "create", "--pagerduty", "-", "--conditions", "screen_offline"], transport, env, undefined, "\n");
  assert.equal(empty.code, ExitCode.Usage, empty.stdout);
  assert.match(empty.envelope.error!.detail, /--pagerduty - reads the credential from one line of stdin, and stdin had none/);
  const tty = await cli(["--json", "notifications", "create", "--pagerduty", "-", "--conditions", "screen_offline"], transport, env);
  assert.equal(tty.code, ExitCode.Usage, tty.stdout);
  assert.match(tty.envelope.error!.detail, /Pipe input when using '-'/);
  assert.equal(notificationCalls(transport).length, before, "a credential that could not be read sends nothing");

  const id = created.envelope.data.id as string;
  const replaced = await cli(["--json", "notifications", "update", id, "--destination", "-"], transport, env, undefined, `${slackUrl("T9", "B9", "replacedSecret1234")}\n`);
  assert.equal(replaced.code, 0, replaced.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { destination: slackUrl("T9", "B9", "replacedSecret1234") });
  assert.equal(replaced.envelope.data.destination_hint, "https://hooks.slack.com/…/1234");
  assert.ok(!replaced.stdout.includes("replacedSecret"));
});

test("notifications create refuses a channel mix and a Telegram token without its chat before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const cases: Array<[string[], RegExp]> = [
    [["--slack", SLACK_URL, "--teams", TEAMS_URL, "--conditions", "screen_offline"], /--slack cannot be used with --teams|--teams cannot be used with --slack/],
    [["--slack", SLACK_URL, "--email", "owner", "--conditions", "screen_offline"], /--slack cannot be used with --email|--email cannot be used with --slack/],
    [["--slack", SLACK_URL], /Provide at least one of --conditions or --events/],
    [["--telegram", TELEGRAM_TOKEN, "--conditions", "screen_offline"], /Provide --telegram and --telegram-chat together/],
    [["--telegram-chat", "-100123", "--slack", SLACK_URL, "--conditions", "screen_offline"], /Provide --telegram and --telegram-chat together/],
    [["--telegram", TELEGRAM_TOKEN, "--telegram-chat", "my chat", "--conditions", "screen_offline"], /--telegram-chat takes a chat id such as -1001234567890/],
    [["--pagerduty", PAGERDUTY_KEY, "--events", "screen.*", "--conditions", "screen_offline"], /--events requires --webhook/],
    [["--slack", SLACK_URL, "--url", SLACK_URL, "--conditions", "screen_offline"], /notifications create does not accept --url/],
  ];
  for (const [args, message] of cases) {
    const refused = await cli(["--json", "notifications", "create", ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, args.join(" "));
    for (const part of CREDENTIAL_PARTS) assert.ok(!refused.stdout.includes(part) && !refused.stderr.includes(part), `a usage error echoes ${part}`);
  }
  assert.equal(notificationCalls(transport).length, 0, "invalid input never reaches the server");
});

test("a destination the server rejects is a status-derived failure with guidance and no echo", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const bad = "https://example.org/services/T0123ABCD/B0123ABCD/leakedSecretValue";
  const refused = await cli(["--json", "notifications", "create", "--slack", bad, "--conditions", "screen_offline"], transport, env);
  assert.equal(refused.code, ExitCode.Client, refused.stdout);
  assert.equal(refused.envelope.error!.code, "notification_destination_rejected");
  assert.match(refused.envelope.error!.detail, /^The destination was rejected: destination must be a slack credential/);
  assert.match(refused.envelope.error!.detail, /Nothing was created or changed/);
  assert.equal(refused.envelope.error!.next!.command, "screenrig notifications create --slack - --conditions screen_offline");
  assert.ok(!refused.stdout.includes("leakedSecretValue"));
  const office = await cli(["--json", "notifications", "create", "--teams", "https://contoso.webhook.office.com/webhookb2/leakedSecretValue", "--conditions", "screen_offline"], transport, env);
  assert.equal(office.envelope.error!.code, "notification_destination_rejected");
  assert.match(office.envelope.error!.detail, /Office 365 connector URLs are retired; create a Teams Workflows webhook/);

  const created = await cli(["--json", "notifications", "create", "--pagerduty", PAGERDUTY_KEY, "--conditions", "screen_offline"], transport, env);
  const id = created.envelope.data.id as string;
  const update = await cli(["--json", "notifications", "update", id, "--destination", "short"], transport, env);
  assert.equal(update.code, ExitCode.Client, update.stdout);
  assert.equal(update.envelope.error!.next!.command, `screenrig notifications update ${id} --destination -`);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/, "a refusal saves no key");
});

test("notifications update replaces a destination or a Telegram chat and a chat notification has no signing secret", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const telegram = (await cli(["--json", "notifications", "create", "--telegram", TELEGRAM_TOKEN, "--telegram-chat", "-1001234567890", "--conditions", "screen_offline"], transport, env)).envelope.data as { id: string };
  const chat = await cli(["--json", "notifications", "update", telegram.id, "--telegram-chat", "@opsroom"], transport, env);
  assert.equal(chat.code, 0, chat.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { telegram_chat_id: "@opsroom" });
  assert.equal(chat.envelope.data.telegram_chat_id, "@opsroom");
  const both = await cli(["--json", "notifications", "update", telegram.id, "--destination", "987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "--expect-rev", "2"], transport, env);
  assert.equal(both.code, 0, both.stdout);
  assert.deepEqual(notificationCalls(transport).at(-1)!.body, { destination: "987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw" });
  assert.equal(notificationCalls(transport).at(-1)!.headers?.["if-match"], '"2"');
  const refused = await cli(["--json", "notifications", "update", telegram.id, "--email", "owner", "--destination", "x"], transport, env);
  assert.equal(refused.code, ExitCode.Usage, refused.stdout);
  assert.match(refused.envelope.error!.detail, /--email cannot be used with --destination|--destination cannot be used with --email|Provide at most one of --email or --url or --destination/);
  const rotate = await cli(["--json", "notifications", "rotate-secret", telegram.id], transport, env);
  assert.equal(rotate.code, ExitCode.Client, rotate.stdout);
  const slack = (await cli(["--json", "notifications", "create", "--slack", SLACK_URL, "--conditions", "screen_offline"], transport, env)).envelope.data as { id: string };
  const wrongField = await cli(["--json", "notifications", "update", slack.id, "--telegram-chat", "@opsroom"], transport, env);
  assert.equal(wrongField.code, ExitCode.Client, wrongField.stdout);
  assert.equal(wrongField.envelope.error!.code, "invalid_request");
  const tested = await cli(["--json", "notifications", "test", slack.id], transport, env);
  assert.equal(tested.code, 0, tested.stdout);
  assert.equal(tested.envelope.data.test, true);
});

test("notification lines and tables show the masked destination of a chat channel", () => {
  const items: Notification[] = [
    { id: "ntf_SLACKAAAAAAAAAAAAAAAA", channel: "slack", destination_hint: "https://hooks.slack.com/…/ghij", conditions: ["screen_offline"], screen_tags: [], hold_minutes: 10, enabled: true, revision: 1, status: "active", created_at: "2026-10-28T10:00:00Z", updated_at: "2026-10-28T10:00:00Z" },
    { id: "ntf_TELEGRAMAAAAAAAAAAAAA", channel: "telegram", destination_hint: "…Dsaw", telegram_chat_id: "@opsroom", conditions: ["crashing"], screen_tags: [], hold_minutes: 0, enabled: true, revision: 3, status: "failing", created_at: "2026-10-28T10:00:00Z", updated_at: "2026-10-28T10:00:00Z" },
  ] as Notification[];
  const lines = notificationLines(items[1]);
  assert.ok(lines.includes("destination: …Dsaw (the credential is sealed and never shown)"), lines.join("\n"));
  assert.ok(lines.includes("telegram_chat: @opsroom"));
  const table = notificationTableLines(items).join("\n");
  assert.match(table, /https:\/\/hooks\.slack\.com\/…\/ghij/);
  assert.match(table, /…Dsaw -> @opsroom/);
  assert.doesNotMatch(table, /withheld/);
});

test("notification lines and tables say who unsubscribed from an email notification", () => {
  const base = { channel: "email", recipients: ["owner", "usr_ADA"], conditions: ["screen_offline"], screen_tags: [], hold_minutes: 10, enabled: true, revision: 2, status: "active", created_at: "2026-10-28T10:00:00Z", updated_at: "2026-10-28T10:00:00Z" };
  const stopped = { ...base, id: "ntf_STOPPEDAAAAAAAAAAAAAA", unsubscribed: [{ user_id: "usr_ADA", at: "2026-10-28T11:00:00Z" }, { user_id: "usr_BOB", at: "2026-10-28T12:00:00Z" }] } as Notification;
  const quiet = { ...base, id: "ntf_QUIETAAAAAAAAAAAAAAAA" } as Notification;
  const lines = notificationLines(stopped);
  assert.ok(lines.includes("unsubscribed: 2 (usr_ADA, usr_BOB; notifications resubscribe ntf_STOPPEDAAAAAAAAAAAAAA --user USER_ID mails one again)"), lines.join("\n"));
  assert.ok(!notificationLines(quiet).some((line) => line.startsWith("unsubscribed")), "a notification nobody stopped says nothing");
  const table = notificationTableLines([stopped, quiet]);
  assert.match(table[0]!, /UNSUBSCRIBED$/);
  assert.match(table[1]!, /ntf_STOPPED\S* +email .* 2$/);
  assert.match(table[2]!, /ntf_QUIET\S* +email .* 0$/);
  assert.doesNotMatch(notificationTableLines([quiet])[0]!, /UNSUBSCRIBED/);
});

test("notifications resubscribe mails an unsubscribed person again and reads the list from show", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await createEmail(transport, env);
  transport.putNotificationUnsubscribed!(id, ["usr_ADA", "usr_BOB"]);
  const shown = await cli(["--json", "notifications", "show", id], transport, env);
  assert.deepEqual(shown.envelope.data.unsubscribed.map((person: { user_id: string }) => person.user_id), ["usr_ADA", "usr_BOB"]);
  assert.equal(shown.envelope.data.revision, 2);
  const human = await cli(["--human", "notifications", "show", id], transport, env);
  assert.match(human.stdout, /^unsubscribed: 2 \(usr_ADA, usr_BOB;/m);
  const listed = await cli(["--human", "notifications", "list"], transport, env);
  assert.match(listed.stdout, /UNSUBSCRIBED/);

  const resubscribed = await cli(["--json", "notifications", "resubscribe", id, "--user", "usr_ADA"], transport, env);
  assert.equal(resubscribed.code, 0, resubscribed.stdout);
  const call = notificationCalls(transport).at(-1)!;
  assert.equal(call.method, "DELETE");
  assert.equal(call.path, `/api/notifications/${id}/unsubscribed/usr_ADA`);
  assert.ok(call.headers?.["idempotency-key"]);
  assert.deepEqual(resubscribed.envelope.data.unsubscribed.map((person: { user_id: string }) => person.user_id), ["usr_BOB"]);
  assert.equal(resubscribed.envelope.data.revision, 3);

  // Again changes nothing; the last person leaves the list and the member with it.
  const same = await cli(["--json", "notifications", "resubscribe", id, "--user", "usr_ADA"], transport, env);
  assert.equal(same.code, 0, same.stdout);
  assert.equal(same.envelope.data.revision, 3);
  const last = await cli(["--human", "notifications", "resubscribe", id, "--user", "usr_BOB"], transport, env);
  assert.match(last.stdout, new RegExp(`^Notification ${id} emails usr_BOB again, if they had unsubscribed\\.`, "m"));
  assert.doesNotMatch(last.stdout, /unsubscribed:/);
  assert.equal(((await cli(["--json", "notifications", "show", id], transport, env)).envelope.data as Notification).unsubscribed, undefined);
});

test("notifications resubscribe needs a user, refuses a malformed one and finds only an email notification", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await createEmail(transport, env);
  const before = notificationCalls(transport).length;
  for (const args of [["notifications", "resubscribe", id], ["notifications", "resubscribe", id, "--user", "has space"], ["notifications", "resubscribe", id, "--user", "u".repeat(201)], ["notifications", "resubscribe", "nope", "--user", "usr_ADA"]]) {
    const refused = await cli(["--json", ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
  }
  assert.equal(notificationCalls(transport).length, before, "a refused command sent nothing");
  const hook = await createWebhook(transport, env);
  const wrong = await cli(["--json", "notifications", "resubscribe", hook.id, "--user", "usr_ADA"], transport, env);
  assert.equal(wrong.code, ExitCode.NotFound, wrong.stdout);
  const odd = await cli(["--json", "notifications", "resubscribe", id, "--user", "usr/ADA?"], transport, env);
  assert.equal(notificationCalls(transport).at(-1)!.path, `/api/notifications/${id}/unsubscribed/usr%2FADA%3F`);
  assert.equal(odd.code, 0, "an id with reserved characters stays one path segment, and nobody by that id changes nothing");
});

test("notifications create sends the severity filter, overrides, active hours and an audience, and show prints them", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const created = await cli([
    "--json", "notifications", "create", "--email", "owner", "--conditions", "screen_offline,not_playing,glass_blank",
    "--min-severity", "error", "--severity", "not_playing=error", "--severity", "glass_blank=info",
    "--active-hours", "Mon-Fri 08:00-22:00", "--active-hours", "sat@10:00-14:00", "--timezone", "America/Los_Angeles", "--outside-hours", "drop",
    "--all-tags", "level2,overhead",
  ], transport, env);
  assert.equal(created.code, 0, created.stdout);
  const call = notificationCalls(transport).at(-1)!;
  assert.deepEqual(call.body, {
    channel: "email", recipients: ["owner"], conditions: ["screen_offline", "not_playing", "glass_blank"],
    audience: { all: [{ tag: "level2" }, { tag: "overhead" }] },
    min_severity: "error", severity: { not_playing: "error", glass_blank: "info" },
    active_hours: { timezone: "America/Los_Angeles", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "08:00", end: "22:00" }, { days: ["sat"], start: "10:00", end: "14:00" }], outside: "drop" },
  });
  assert.equal(created.envelope.data.min_severity, "error");
  assert.equal(created.envelope.data.screen_tags.length, 0);
  const id = created.envelope.data.id as string;

  const human = await cli(["--human", "notifications", "show", id], transport, env);
  assert.match(human.stdout, /^audience: tag level2 and tag overhead$/m);
  assert.doesNotMatch(human.stdout, /^screen_tags:/m, "an audience stands in for the tags");
  assert.match(human.stdout, /^min_severity: error$/m);
  assert.match(human.stdout, /^severity: not_playing=error, glass_blank=info$/m);
  assert.match(human.stdout, /^active_hours: America\/Los_Angeles mon-fri@08:00-22:00; sat@10:00-14:00 \(outside the hours: drop\)$/m);
  const list = await cli(["--human", "notifications", "list"], transport, env);
  assert.match(list.stdout, /RULES/);
  assert.match(list.stdout, /min error; severity not_playing=error,glass_blank=info; hours America\/Los_Angeles mon-fri@08:00-22:00; sat@10:00-14:00 \(outside the hours: drop\); audience tag level2 and tag overhead/);
});

test("notifications create takes --any-tag, a one-tag --all-tags, and an audience from a file, stdin or inline JSON", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const base = ["--json", "notifications", "create", "--email", "owner", "--conditions", "screen_offline"];
  const any = await cli([...base, "--any-tag", "Lobby", "--any-tag", "Floor2"], transport, env);
  assert.equal(any.code, 0, any.stdout);
  assert.deepEqual((notificationCalls(transport).at(-1)!.body as { audience: unknown }).audience, { any: [{ tag: "Lobby" }, { tag: "Floor2" }] });
  const one = await cli([...base, "--all-tags", "Lobby"], transport, env);
  assert.deepEqual((notificationCalls(transport).at(-1)!.body as { audience: unknown }).audience, { tag: "Lobby" });
  assert.equal(one.code, 0, one.stdout);
  const rule = { any: [{ all: [{ tag: "level2" }, { tag: "overhead" }] }, { screen_id: "scr_LOBBYAAAAAAAAAAAAAAAAAA" }] };
  await writeFile(path.join(env.cwd, "audience.json"), JSON.stringify(rule));
  for (const [value, stdin] of [["audience.json", undefined], ["@audience.json", undefined], ["-", JSON.stringify(rule)], [JSON.stringify(rule), undefined]] as const) {
    const result = await cli([...base, "--audience", value], transport, env, undefined, stdin);
    assert.equal(result.code, 0, `${value}: ${result.stdout}`);
    assert.deepEqual((notificationCalls(transport).at(-1)!.body as { audience: unknown }).audience, rule, value);
    assert.equal((notificationCalls(transport).at(-1)!.body as { screen_tags?: unknown }).screen_tags, undefined);
  }
  const shown = await cli(["--human", "notifications", "show", (any.envelope.data as { id: string }).id], transport, env);
  assert.match(shown.stdout, /^audience: tag Lobby or tag Floor2$/m);
  const server = await cli([...base, "--audience", "{\"nope\":1}"], transport, env);
  assert.equal(server.code, 0, "the server owns the rule's members; the fake accepts any object");
  const before = notificationCalls(transport).length;
  const failures: Array<[string[], RegExp]> = [
    [["--audience", "missing.json"], /missing\.json does not exist/],
    [["--audience", "[1]"], /--audience (must be a JSON object|is not valid JSON)|Input is not valid JSON|must be a JSON object/],
    [["--tag", "Lobby", "--any-tag", "Lobby"], /--tag cannot be used with --any-tag|--any-tag cannot be used with --tag/],
    [["--any-tag", "Lobby", "--all-tags", "Lobby"], /cannot be used with/],
    [["--all-tags", "Lobby", "--audience", "{}"], /cannot be used with/],
    [["--tag", "Lobby", "--audience", "{}"], /cannot be used with/],
    [["--any-tag", "Lobby!"], /--any-tag takes tags of 1 to 32 letters or digits/],
    [["--all-tags", "Lobby,Lobby"], /--all-tags lists a tag more than once/],
  ];
  for (const [args, message] of failures) {
    const refused = await cli([...base, ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, args.join(" "));
  }
  assert.equal(notificationCalls(transport).length, before, "invalid input never reaches the server");
});

test("notifications create validates severity and active hours flags before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const email = ["--email", "owner", "--conditions", "screen_offline"];
  const cases: Array<[string[], RegExp]> = [
    [["--min-severity", "fatal"], /--min-severity/],
    [["--severity", "not_playing"], /--severity takes CONDITION=LEVEL/],
    [["--severity", "bogus=error"], /--severity does not take the condition "bogus"/],
    [["--severity", "not_playing=fatal"], /--severity does not take the level "fatal"/],
    [["--severity", "not_playing=error", "--severity", "not_playing=info"], /--severity names not_playing more than once/],
    [["--active-hours", "Mon-Fri 08:00-22:00"], /--active-hours requires --timezone/],
    [["--timezone", "America/Los_Angeles"], /--timezone requires --active-hours/],
    [["--outside-hours", "drop"], /--outside-hours requires --active-hours/],
    [["--active-hours", "Mon-Fri 08:00-22:00", "--timezone", "Mars/Olympus"], /--timezone takes an IANA timezone name/],
    [["--active-hours", "Funday 08:00-22:00", "--timezone", "UTC"], /--active-hours "Funday 08:00-22:00": "funday" is not a day/],
    [["--active-hours", "Mon-Fri 25:00-26:00", "--timezone", "UTC"], /--active-hours/],
    [["--active-hours", "Mon 08:00-22:00", "--timezone", "UTC", "--outside-hours", "later"], /--outside-hours/],
    [[...Array.from({ length: 17 }, () => ["--active-hours", "Mon 08:00-22:00"]).flat(), "--timezone", "UTC"], /--active-hours accepts at most 16 windows/],
  ];
  for (const [args, message] of cases) {
    const refused = await cli(["--json", "notifications", "create", ...email, ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, args.join(" "));
  }
  assert.equal(notificationCalls(transport).length, 0, "invalid input never reaches the server");
});

test("notifications update sets, replaces and clears the severity filter, overrides, hours and audience", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await createEmail(transport, env, "--tag", "Lobby");
  const patch = async (...args: string[]) => {
    const result = await cli(["--json", "notifications", "update", id, ...args], transport, env);
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stdout}`);
    return { body: notificationCalls(transport).filter((call) => call.method === "PATCH").at(-1)!.body, data: result.envelope.data };
  };

  const filter = await patch("--min-severity", "warning");
  assert.deepEqual(filter.body, { min_severity: "warning" });
  assert.equal(filter.data.min_severity, "warning");
  assert.deepEqual((await patch("--clear-min-severity")).body, { min_severity: null });
  const overrides = await patch("--severity", "not_playing=error", "--severity", "glass_blank=error");
  assert.deepEqual(overrides.body, { severity: { not_playing: "error", glass_blank: "error" } });
  assert.deepEqual(overrides.data.severity, { not_playing: "error", glass_blank: "error" });
  const cleared = await patch("--clear-severity");
  assert.deepEqual(cleared.body, { severity: null });
  assert.equal(cleared.data.severity, undefined);

  const hours = await patch("--active-hours", "Mon-Fri 08:00-22:00", "--timezone", "America/Los_Angeles");
  assert.deepEqual(hours.body, { active_hours: { timezone: "America/Los_Angeles", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "08:00", end: "22:00" }] } });
  assert.equal(hours.data.active_hours.outside, "hold", "the server shows outside");
  // A new outside setting or zone alone keeps the windows the notification has, and is guarded by the revision just read.
  const reads = () => notificationCalls(transport).filter((call) => call.method === "GET").length;
  const readsBefore = reads();
  const drop = await patch("--outside-hours", "drop");
  assert.equal(reads(), readsBefore + 1);
  assert.deepEqual(drop.body, { active_hours: { timezone: "America/Los_Angeles", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "08:00", end: "22:00" }], outside: "drop" } });
  assert.equal(notificationCalls(transport).filter((call) => call.method === "PATCH").at(-1)!.headers?.["if-match"], `"${hours.data.revision}"`);
  const zone = await patch("--timezone", "Europe/London");
  assert.deepEqual(zone.body, { active_hours: { timezone: "Europe/London", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "08:00", end: "22:00" }], outside: "drop" } });
  assert.deepEqual((await patch("--clear-active-hours")).body, { active_hours: null });
  const readsAfter = reads();
  const nothing = await cli(["--json", "notifications", "update", id, "--outside-hours", "drop"], transport, env);
  assert.equal(nothing.code, ExitCode.Usage, nothing.stdout);
  assert.match(nothing.envelope.error!.detail, /give --active-hours for a notification that has none/);
  assert.equal(reads(), readsAfter + 1);
  assert.equal(notificationCalls(transport).filter((call) => call.method === "PATCH").length, 8);

  // The audience and the tags exclude each other: each switch clears the other in the same request.
  const audience = await patch("--any-tag", "Lobby,Floor2");
  assert.deepEqual(audience.body, { audience: { any: [{ tag: "Lobby" }, { tag: "Floor2" }] }, screen_tags: [] });
  assert.deepEqual(audience.data.audience, { any: [{ tag: "Lobby" }, { tag: "Floor2" }] });
  assert.deepEqual(audience.data.screen_tags, []);
  const all = await patch("--all-tags", "level2", "--all-tags", "overhead");
  assert.deepEqual(all.body, { audience: { all: [{ tag: "level2" }, { tag: "overhead" }] }, screen_tags: [] });
  await writeFile(path.join(env.cwd, "audience.json"), JSON.stringify({ tag: "Lobby" }));
  assert.deepEqual((await patch("--audience", "audience.json")).body, { audience: { tag: "Lobby" }, screen_tags: [] });
  const tags = await patch("--tag", "Cafe");
  assert.deepEqual(tags.body, { screen_tags: ["Cafe"], audience: null });
  assert.equal(tags.data.audience, undefined);
  await patch("--any-tag", "Lobby");
  const everywhere = await patch("--all-screens");
  assert.deepEqual(everywhere.body, { screen_tags: [], audience: null });
  assert.equal(everywhere.data.audience, undefined);

  const piped = await cli(["--json", "notifications", "update", id, "--audience", "-"], transport, env, undefined, JSON.stringify({ any: [{ tag: "Piped" }] }));
  assert.equal(piped.code, 0, piped.stdout);
  assert.deepEqual(piped.envelope.data.audience, { any: [{ tag: "Piped" }] });
  const refused: Array<[string[], RegExp]> = [
    [["--min-severity", "warning", "--clear-min-severity"], /cannot be used with/],
    [["--severity", "not_playing=error", "--clear-severity"], /cannot be used with/],
    [["--clear-active-hours", "--timezone", "UTC"], /cannot be used with/],
    [["--clear-active-hours", "--active-hours", "Mon 08:00-09:00"], /cannot be used with/],
    [["--all-screens", "--any-tag", "Lobby"], /cannot be used with/],
    [["--audience", "{}", "--all-tags", "Lobby"], /cannot be used with/],
    [["--severity", "bogus=error"], /--severity does not take the condition/],
    [["--active-hours", "Mon 08:00-22:00"], /--active-hours needs --timezone/],
  ];
  const count = notificationCalls(transport).length;
  for (const [args, message] of refused) {
    const result = await cli(["--json", "notifications", "update", id, ...args], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error!.detail, message, args.join(" "));
  }
  assert.equal(notificationCalls(transport).length, count, "invalid input never reaches the server");
});

test("notifications create and update expose severity, active hours and audience in help, with the stdin and choices the flags accept", () => {
  const create = commandHelp(["notifications", "create"]);
  for (const name of ["--min-severity", "--severity", "--active-hours", "--timezone", "--outside-hours", "--audience", "--any-tag", "--all-tags"]) {
    assert.ok(create.options.some((option) => option.name === name), `create takes ${name}`);
  }
  const update = commandHelp(["notifications", "update"]);
  for (const name of ["--clear-min-severity", "--clear-severity", "--clear-active-hours", "--audience", "--any-tag", "--all-tags"]) {
    assert.ok(update.options.some((option) => option.name === name), `update takes ${name}`);
  }
  assert.ok(create.examples.some((example) => example.includes("--active-hours")));
  assert.ok(update.examples.some((example) => example.includes("--clear-severity")));
  assert.match((create.usage + create.notes.join("\n")).replace(/\s+/g, " "), /error for screen_offline and warning for every other condition/);
});

test("notification lines show the severity filter, overrides, hours and audience only while they are set", () => {
  const plain = { id: "ntf_PLAINAAAAAAAAAAAAAAA", channel: "email", recipients: ["owner"], conditions: ["screen_offline"], screen_tags: ["Lobby"], hold_minutes: 10, enabled: true, revision: 1, status: "active", created_at: "x", updated_at: "x" } as Notification;
  const lines = notificationLines(plain);
  assert.ok(!lines.some((line) => /^(min_severity|severity|active_hours|audience):/.test(line)), "a notification created before the rules shows none");
  assert.ok(lines.includes("screen_tags: Lobby"));
  assert.ok(!notificationTableLines([plain]).join("\n").includes("RULES"));
  const ruled = { ...plain, screen_tags: [], audience: { all: [{ any: [{ tag: "A" }, { tag: "B" }] }, { folder: "sfd_X" }] }, min_severity: "info", severity: { crashing: "error" }, active_hours: { timezone: "UTC", windows: [{ days: ["sat", "sun"] }] } } as Notification;
  const shown = notificationLines(ruled);
  assert.ok(shown.includes("audience: (tag A or tag B) and folder sfd_X"));
  assert.ok(shown.includes("min_severity: info"));
  assert.ok(shown.includes("severity: crashing=error"));
  assert.ok(shown.includes("active_hours: UTC sat,sun (outside the hours: hold)"));
});

test("a webhook delivery's severity and the planned_reboot and outside_hours skips read as the server sends them", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await createEmail(transport, env);
  for (const [deliveryId, reason] of [["whd_HOURSAAAAAAAAAAAAAAAA", "outside_hours"], ["whd_REBOOTAAAAAAAAAAAAAAA", "planned_reboot"], ["whd_BELOWAAAAAAAAAAAAAAAA", "below_severity"]] as const) {
    transport.putNotificationDelivery!(id, {
      id: deliveryId, notification_id: id, event_id: "ev1_7", event_type: "screen.offline", condition: "screen_offline", phase: "opened",
      screen_id: "scr_LOBBYAAAAAAAAAAAAAAAA", screen_name: "Lobby TV", state: "skipped", attempts: 0, last_error: reason, created_at: "2026-08-14T16:55:00.000Z",
    });
  }
  const human = await cli(["--human", "notifications", "deliveries", id], transport, env);
  for (const reason of ["outside_hours", "planned_reboot", "below_severity"]) assert.match(human.stdout, new RegExp(`skipped\\s+0\\s+${reason}`));
  const help = await cli(["--human", "notifications", "deliveries", "--help"], transport, env);
  assert.match(help.stdout, /outside_hours \(the notification's active hours were closed/);
  assert.match(help.stdout, /planned_reboot \(the screen went offline/);
});

test("reach_dropped and group_empty are conditions of every notification, beside the thresholds the first one takes", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const both = await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "reach_dropped,group_empty"], transport, env);
  assert.equal(both.code, 0, both.stdout);
  assert.deepEqual((notificationCalls(transport).at(-1)!.body as { conditions: string[] }).conditions, ["reach_dropped", "group_empty"]);
  assert.equal((notificationCalls(transport).at(-1)!.body as { reach_drop?: unknown }).reach_drop, undefined, "no threshold sends none: any drop notifies");

  const created = await cli(["--json", "notifications", "create", "--webhook", URL_OK, "--conditions", "reach_dropped,screen_offline", "--reach-drop-screens", "2", "--reach-drop-percent", "20", "--severity", "reach_dropped=error"], transport, env);
  assert.equal(created.code, 0, created.stdout);
  assert.deepEqual((notificationCalls(transport).at(-1)!.body as { reach_drop: unknown }).reach_drop, { screens: 2, percent: 20 });
  assert.deepEqual((notificationCalls(transport).at(-1)!.body as { severity: unknown }).severity, { reach_dropped: "error" });
  const id = created.envelope.data.id as string;
  const human = await cli(["--human", "notifications", "show", id], transport, env);
  assert.match(human.stdout, /^reach_drop: at least 2 screens and at least 20% of the screens it reached when published$/m);
  assert.match(human.stdout, /^conditions: reach_dropped, screen_offline$/m);
  const list = await cli(["--human", "notifications", "list"], transport, env);
  assert.match(list.stdout, /reach drop at least 2 screens and at least 20%/);

  const only = await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "reach_dropped", "--reach-drop-percent", "10"], transport, env);
  assert.deepEqual((notificationCalls(transport).at(-1)!.body as { reach_drop: unknown }).reach_drop, { percent: 10 });
  assert.equal(only.code, 0, only.stdout);
  const onlyHuman = await cli(["--human", "notifications", "show", only.envelope.data.id], transport, env);
  assert.match(onlyHuman.stdout, /^reach_drop: at least 10% of the screens it reached when published$/m);
});

test("notifications create and update validate the reach-drop flags before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const email = ["--email", "owner"];
  const cases: Array<[string[], RegExp]> = [
    [[...email, "--conditions", "screen_offline", "--reach-drop-screens", "2"], /add reach_dropped to --conditions/],
    [[...email, "--conditions", "reach_dropped", "--reach-drop-screens", "0"], /--reach-drop-screens takes a whole number of screens, 1 or more/],
    [[...email, "--conditions", "reach_dropped", "--reach-drop-screens", "1.5"], /--reach-drop-screens/],
    [[...email, "--conditions", "reach_dropped", "--reach-drop-percent", "0"], /--reach-drop-percent takes a whole percent from 1 to 100/],
    [[...email, "--conditions", "reach_dropped", "--reach-drop-percent", "101"], /--reach-drop-percent/],
    [[...email, "--conditions", "reach_dropped", "--reach-drop-percent", "ten"], /--reach-drop-percent/],
  ];
  for (const [args, message] of cases) {
    const refused = await cli(["--json", "notifications", "create", ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, args.join(" "));
  }
  assert.equal(notificationCalls(transport).length, 0, "invalid input never reaches the server");
});

test("notifications update replaces, clears and refuses the reach-drop threshold", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = (await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "reach_dropped"], transport, env)).envelope.data as { id: string };
  const patch = async (...args: string[]) => {
    const result = await cli(["--json", "notifications", "update", id, ...args], transport, env);
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stdout}`);
    return { body: notificationCalls(transport).filter((call) => call.method === "PATCH").at(-1)!.body, data: result.envelope.data };
  };
  const set = await patch("--reach-drop-screens", "3", "--reach-drop-percent", "25");
  assert.deepEqual(set.body, { reach_drop: { screens: 3, percent: 25 } });
  assert.deepEqual(set.data.reach_drop, { screens: 3, percent: 25 });
  assert.deepEqual((await patch("--reach-drop-percent", "50")).body, { reach_drop: { percent: 50 } }, "the threshold is replaced as a whole");
  const cleared = await patch("--clear-reach-drop");
  assert.deepEqual(cleared.body, { reach_drop: null });
  assert.equal(cleared.data.reach_drop, undefined);
  const both = await patch("--conditions", "reach_dropped,group_empty", "--reach-drop-screens", "2");
  assert.deepEqual(both.body, { conditions: ["reach_dropped", "group_empty"], reach_drop: { screens: 2 } });

  const count = notificationCalls(transport).length;
  for (const [args, message] of [
    [["--clear-reach-drop", "--reach-drop-screens", "2"], /cannot be used with/],
    [["--conditions", "group_empty", "--reach-drop-screens", "2"], /add reach_dropped to --conditions/],
    [["--reach-drop-percent", "200"], /--reach-drop-percent/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "notifications", "update", id, ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, args.join(" "));
  }
  assert.equal(notificationCalls(transport).length, count, "invalid input never reaches the server");
  // The server refuses a threshold on a notification that lacks the condition, and the refusal is shown.
  const server = await cli(["--json", "notifications", "update", id, "--conditions", "screen_offline"], transport, env);
  assert.equal(server.code, ExitCode.Client, server.stdout);
});

test("a group_empty delivery names the tag or folder in an AUDIENCE_GROUP column that appears only then", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = (await cli(["--json", "notifications", "create", "--email", "owner", "--conditions", "group_empty,reach_dropped"], transport, env)).envelope.data as { id: string };
  transport.putNotificationDelivery!(id, {
    id: "whd_EMPTYAAAAAAAAAAAAAAAA", notification_id: id, event_id: "ev1_8", event_type: "campaign.group_changed", condition: "group_empty", phase: "opened",
    screen_id: "cmp_PROMOAAAAAAAAAAAAAA", screen_name: "Lobby promo", audience_group: "tag:Lobby", state: "succeeded", attempts: 1, created_at: "2026-10-29T16:55:00.000Z",
  });
  const json = await cli(["--json", "notifications", "deliveries", id], transport, env);
  assert.equal(json.envelope.data.items[0].audience_group, "tag:Lobby");
  const human = await cli(["--human", "notifications", "deliveries", id], transport, env);
  assert.match(human.stdout, /AUDIENCE_GROUP/);
  assert.match(human.stdout, /group_empty\s+opened\s+Lobby promo\s+tag:Lobby\s+succeeded/);
  transport.putNotificationDelivery!(id, {
    id: "whd_DROPPEDAAAAAAAAAAAAAA", notification_id: id, event_id: "ev1_9", event_type: "campaign.reach_changed", condition: "reach_dropped", phase: "opened",
    screen_id: "cmp_PROMOAAAAAAAAAAAAAA", screen_name: "Lobby promo", state: "skipped", attempts: 0, last_error: "condition_cleared", created_at: "2026-10-29T16:56:00.000Z",
  });
  const plain = notificationDeliveryTableLines([{ id: "whd_X", notification_id: id, event_id: "e", event_type: "screen.offline", state: "succeeded", attempts: 1, created_at: "x" } as NotificationDelivery]);
  assert.doesNotMatch(plain.join("\n"), /AUDIENCE_GROUP/);
  const help = commandHelp(["notifications", "create"]);
  assert.match(help.options.find((option) => option.name === "--conditions")?.description ?? "", /reach_dropped, group_empty/);
  for (const name of ["--reach-drop-screens", "--reach-drop-percent"]) assert.ok(help.options.some((option) => option.name === name), name);
  const update = commandHelp(["notifications", "update"]);
  assert.deepEqual(update.options.find((option) => option.name === "--clear-reach-drop")?.conflicts, ["--reach-drop-screens", "--reach-drop-percent"]);
});
