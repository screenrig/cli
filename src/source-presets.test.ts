import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { parseArgv } from "./argv.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help-tree.js";
import { run } from "./main.js";
import { type CliRuntime } from "./runtime.js";
import { presetCardTypes, presetSettingValue, sourcePresetLines, sourcePresetName, sourcePresetTableLines, SOURCE_PRESETS_PATH, type SourcePreset } from "./source-presets.js";
import type { Source } from "./sources.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const NOW = new Date("2026-11-01T17:00:00.000Z");
const SOURCE = "src_PRESETAAAAAAAAAAAAAAA";
const PLAIN = "src_PLAINAAAAAAAAAAAAAAAA";
const CARD = "crd_WALLAAAAAAAAAAAAAAAAAA";
// Built in code, so no literal here looks like a credential.
const BOT_TOKEN = `xoxb-${"1".repeat(12)}-${"a".repeat(24)}`;

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
  const configDir = await testTemp("presets-cfg-");
  const cwd = await testTemp("presets-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, settings: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA",
    organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr",
  }, fs);
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const code = await run({
    argv, settings: env.fs.settings, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  } satisfies CliRuntime);
  stdout.end();
  stderr.end();
  const text = await outP;
  const err = await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, stderr: err, envelope };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse => ({ status, headers: { "content-type": "application/json", ...headers }, body });
const problem = (status: number, code: string, detail: string, extras: Record<string, unknown> = {}): TransportResponse => ({ status, headers: { "content-type": "application/problem+json" }, body: { status, code, title: detail, detail, ...extras } });

const SLACK: SourcePreset = {
  name: "slack-channel", title: "Slack channel", category: "Messaging", kind: "json",
  description: "The latest messages of a Slack channel on a screen.",
  cards: [{ type: "workplace-posts", default: true }, { type: "message-wall", default: false }],
  fields: [
    { name: "channel", label: "Channel ID", type: "text", required: true, pattern: "^[CG][A-Z0-9]{8,14}$", max_length: 20, example: "C0123456789", help: "The ID of the channel, not its name." },
    { name: "channel_label", label: "Channel name to show", type: "text", required: false, max_length: 40, example: "#announcements", help: "Leave it out to show none." },
  ],
  secrets: [{ name: "token", label: "Slack bot token", help: "The bot token of an internal Slack app.", how_to_get: "At api.slack.com/apps choose Create New App, then add the scope channels:history.", required: true }],
  refresh_seconds: 60, min_refresh_seconds: 60, stale_after_seconds: 900,
  attribution: { text: "Messages are read from your own Slack workspace through an app you create there.", terms: "https://slack.com/terms-of-service/api" },
  docs: "/docs/sources#slack-channel",
};

const TRAVEL: SourcePreset = {
  name: "google-travel-times", title: "Travel times", category: "Maps", kind: "json", description: "Drive and transit times from one place to up to eight others.",
  cards: [{ type: "travel-times", default: true }],
  fields: [
    { name: "origin", label: "Start", type: "text", required: true, max_length: 200, example: "1 Main St", help: "An address." },
    { name: "mode", label: "Travel mode", type: "choice", required: false, default: "drive", options: [{ value: "drive", label: "Drive" }, { value: "transit", label: "Public transit" }], help: "How people travel." },
    { name: "destinations", label: "Destinations", type: "list", required: true, min_items: 1, max_items: 8, help: "Where to.", fields: [
      { name: "name", label: "Name", type: "text", required: true, max_length: 40, help: "What the board calls it." },
      { name: "address", label: "Address", type: "text", required: true, max_length: 200, help: "Where it is." },
    ] },
  ],
  secrets: [{ name: "api_key", label: "Google Cloud API key", help: "With the Routes API enabled.", how_to_get: "In the Google Cloud console create an API key and enable the Routes API.", required: true }],
  refresh_seconds: 900, min_refresh_seconds: 300, stale_after_seconds: 3600,
  attribution: { text: "Routes from the Google Routes API." }, docs: "/docs/sources#google-travel-times",
};

function source(over: Partial<Source> = {}): Source {
  return {
    id: SOURCE, name: "Team wall", kind: "json", target: { card_id: CARD }, enabled: true, preset: "slack-channel", settings: { channel: "C0123456789", channel_label: "#announcements" },
    config: { url: "https://slack.com/api/conversations.history?channel=C0123456789", auth: "bearer" },
    secrets: { token: { set: true, hint: "…aaaa", updated_at: "2026-11-01T16:00:00Z" } }, refresh_seconds: 60, stale_after_seconds: 900, revision: 4,
    status: { state: "ok", last_attempt_at: "2026-11-01T16:55:00Z", last_success_at: "2026-11-01T16:55:00Z", last_change_at: "2026-11-01T16:00:00Z", next_run_at: "2026-11-01T17:00:20Z", failures: 0, stale: false, data_expires_at: null, error: null, warnings: [], stats: { messages: 12 } },
    created_at: "2026-11-01T15:00:00Z", updated_at: "2026-11-01T16:00:00Z", ...over,
  };
}

/** The preset and source routes of the API, scripted; every call is recorded. */
function backend(): { transport: FakeTransport; calls: TransportRequest[] } {
  const transport = new FakeTransport();
  const calls: TransportRequest[] = [];
  const record = (req: TransportRequest) => { calls.push(req); };
  transport
    .on("GET", SOURCE_PRESETS_PATH, (req) => { record(req); return json(200, { items: [SLACK, TRAVEL] }, { "cache-control": "no-store" }); })
    .on("GET", `${SOURCE_PRESETS_PATH}/slack-channel`, (req) => { record(req); return json(200, SLACK); })
    .on("GET", `${SOURCE_PRESETS_PATH}/google-travel-times`, (req) => { record(req); return json(200, TRAVEL); })
    .on("GET", /^\/api\/source-presets\/[a-z-]+$/, (req) => { record(req); return problem(404, "not_found", "The source preset was not found."); })
    .on("POST", "/api/sources", (req) => {
      record(req);
      const body = req.body as { name: string; preset?: string; settings?: Record<string, unknown>; kind?: string; config?: Record<string, unknown>; target: { card_id: string } };
      return json(201, source({ name: body.name, target: body.target, ...(body.preset ? { preset: body.preset, settings: body.settings ?? {} } : { preset: null, settings: null, kind: body.kind ?? "ics", config: body.config ?? {} }), revision: 1 }));
    })
    .on("POST", "/api/sources/test", (req) => { record(req); return json(200, { document: { posts: [{ id: "1.0", text: "Hello" }] }, valid: true, warnings: [], stats: { messages: 1 }, fetched_at: NOW.toISOString() }); })
    .on("GET", `/api/sources/${SOURCE}`, (req) => { record(req); return json(200, source(), { etag: '"4"' }); })
    .on("GET", `/api/sources/${PLAIN}`, (req) => { record(req); return json(200, source({ id: PLAIN, preset: null, settings: null, kind: "ics", config: { calendars: [{ key: "lobby" }], days: 7 } }), { etag: '"2"' }); })
    .on("PATCH", `/api/sources/${SOURCE}`, (req) => { record(req); return json(200, source({ revision: 5 })); });
  return { transport, calls };
}

const lastBody = (calls: TransportRequest[]): any => calls.at(-1)!.body;
const writes = (calls: TransportRequest[]): TransportRequest[] => calls.filter((call) => call.method !== "GET");

test("a preset name is lower-case words joined by hyphens, and a --set value is text unless it is a JSON array, object or null", () => {
  assert.equal(sourcePresetName("slack-channel"), "slack-channel");
  assert.equal(sourcePresetName("bonusly"), "bonusly");
  assert.equal(sourcePresetName("google-travel-times"), "google-travel-times");
  for (const bad of ["Slack", "slack_channel", "-slack", "slack-", "slack--channel", "", "1slack", "slack channel"]) assert.throws(() => sourcePresetName(bad), /A preset name is lower-case words joined by hyphens/, bad);
  assert.equal(presetSettingValue("C0123456789"), "C0123456789");
  assert.equal(presetSettingValue("14"), "14", "a number stays the text a text field's pattern reads");
  assert.equal(presetSettingValue("true"), "true");
  assert.equal(presetSettingValue("#announcements"), "#announcements");
  assert.equal(presetSettingValue('"quoted"'), "quoted");
  assert.deepEqual(presetSettingValue('[{"name":"Gym","address":"1 Main"}]'), [{ name: "Gym", address: "1 Main" }]);
  assert.deepEqual(presetSettingValue('{"a":1}'), { a: 1 });
  assert.equal(presetSettingValue("null"), null, "null removes an optional setting on update");
  assert.equal(presetSettingValue("not json {"), "not json {");
});

test("source presets lists each preset with the card it fills and its category", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const json1 = await cli(["--json", "source", "presets"], transport, env);
  assert.equal(json1.code, 0, json1.stdout);
  assert.deepEqual(json1.envelope.data.items.map((item: SourcePreset) => item.name), ["slack-channel", "google-travel-times"]);
  assert.equal(calls.at(-1)!.path, "/api/source-presets");
  assert.equal(calls.at(-1)!.method, "GET");
  assert.equal(calls.at(-1)!.headers?.["idempotency-key"], undefined, "a read has no idempotency key");
  const human = await cli(["--human", "source", "presets"], transport, env);
  assert.match(human.stdout, /^Source presets \(2\)$/m);
  assert.match(human.stdout, /^NAME\s+TITLE\s+CARD\s+CATEGORY$/m);
  assert.match(human.stdout, /^slack-channel\s+Slack channel\s+workplace-posts, message-wall\s+Messaging$/m);
  assert.match(human.stdout, /^google-travel-times\s+Travel times\s+travel-times\s+Maps$/m);
  assert.match(human.stdout, /Next: screenrig source presets NAME shows a preset's fields, its secrets and how to get them\./);
  assert.deepEqual(sourcePresetTableLines([]), ["No source presets"]);
  assert.deepEqual(presetCardTypes({ ...SLACK, cards: [{ type: "message-wall", default: false }, { type: "workplace-posts", default: true }] }), ["workplace-posts", "message-wall"], "the card it is made for comes first");
});

test("source presets NAME shows the fields, the secrets and where to get each", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const shown = await cli(["--human", "source", "presets", "slack-channel"], transport, env);
  assert.equal(shown.code, 0, shown.stdout);
  assert.equal(calls.at(-1)!.path, "/api/source-presets/slack-channel");
  for (const expected of [
    "name: slack-channel", "title: Slack channel", "category: Messaging", "kind: json",
    "cards: workplace-posts (the one it is made for), message-wall; --card names an instance of one of them (card create)",
    "refresh: every 1m (at least 1m); the card keeps its last good data for 15m when the source cannot refresh",
    "data: Messages are read from your own Slack workspace through an app you create there. Terms: https://slack.com/terms-of-service/api",
    "docs: https://screenrig.ai/docs/sources#slack-channel",
    "Fields (--set FIELD=VALUE, or --settings JSON; a list takes a JSON array):",
    "  channel (text, required): Channel ID",
    "    The ID of the channel, not its name.",
    "    example: C0123456789; pattern: ^[CG][A-Z0-9]{8,14}$; at most 20 characters",
    "  channel_label (text): Channel name to show",
    "Secrets (--secret NAME=@FILE, or NAME=- for stdin):",
    "  token (required): Slack bot token",
    "    how to get it: At api.slack.com/apps choose Create New App, then add the scope channels:history.",
    "Next: screenrig source test --preset slack-channel --card crd_CARD --set channel=C0123456789 --secret token=@FILE",
    "Then the same command as source create, with --name.",
  ]) assert.ok(shown.stdout.includes(expected), `${expected}\n${shown.stdout}`);
  const jsonShown = await cli(["--json", "source", "presets", "slack-channel"], transport, env);
  assert.equal(jsonShown.envelope.data.fields[0].name, "channel");
  assert.equal(jsonShown.envelope.data.secrets[0].how_to_get.startsWith("At api.slack.com"), true);

  const travel = await cli(["--human", "source", "presets", "google-travel-times"], transport, env);
  assert.match(travel.stdout, /^ {2}mode \(choice\): Travel mode$/m);
  assert.match(travel.stdout, /one of: drive \(Drive\), transit \(Public transit\)/);
  assert.match(travel.stdout, /default: drive/);
  assert.match(travel.stdout, /^ {2}destinations \(list, required\): Destinations$/m);
  assert.match(travel.stdout, /a JSON array of 1 to 8 items, each an object with:/);
  assert.match(travel.stdout, /^ {6}name \(text, required\): Name$/m);
  assert.match(travel.stdout, /^ {6}address \(text, required\): Address$/m);
  // The next step is a command that can be pasted: a value with spaces is quoted, a list is a JSON array of one item.
  assert.ok(travel.stdout.includes(`Next: screenrig source test --preset google-travel-times --card crd_CARD --set origin='1 Main St' --set destinations='[{"name":"VALUE","address":"VALUE"}]' --secret api_key=@FILE`), travel.stdout);
  assert.match(travel.stdout, /cards: travel-times; --card names an instance of that card/);
  assert.match(travel.stdout, /refresh: every 15m \(at least 5m\); the card keeps its last good data for 1h/);
  assert.ok(!sourcePresetLines({ ...SLACK, secrets: [], attribution: { text: "Public." } }).some((line) => line.startsWith("Secrets (")));
  assert.ok(sourcePresetLines({ ...SLACK, secrets: [] }).includes("Secrets: none; the data is public."));
  assert.deepEqual(sourcePresetLines(undefined), []);
});

test("source presets refuses a bad name locally and names the list when the preset is unknown", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const bad = await cli(["--json", "source", "presets", "Slack_Channel"], transport, env);
  assert.equal(bad.code, ExitCode.Usage);
  assert.equal(bad.envelope.error?.next?.command, "screenrig source presets");
  assert.equal(calls.length, 0, "nothing was sent");
  const unknown = await cli(["--json", "source", "presets", "no-such-preset"], transport, env);
  assert.equal(unknown.code, 4);
  assert.equal(unknown.envelope.error?.code, "not_found");
  assert.equal(unknown.envelope.error?.next?.command, "screenrig source presets");
});

test("source create --preset sends the preset, its fields and its secrets, never a kind or a config", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  await writeFile(path.join(env.cwd, "slack.token"), `${BOT_TOKEN}\n`);
  const created = await cli(["--json", "source", "create", "--preset", "slack-channel", "--card", CARD, "--name", "  Team wall ", "--set", "channel=C0123456789", "--set", "channel_label=#announcements", "--secret", "token=@slack.token", "--refresh", "2m", "--stale-after", "30m"], transport, env);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const sent = calls.find((call) => call.method === "POST" && call.path === "/api/sources")!;
  assert.deepEqual(sent.body, {
    name: "Team wall", preset: "slack-channel", settings: { channel: "C0123456789", channel_label: "#announcements" }, target: { card_id: CARD },
    secrets: { token: BOT_TOKEN }, refresh_seconds: 120, stale_after_seconds: 1800,
  });
  assert.match(sent.headers?.["idempotency-key"] ?? "", /^[A-Za-z0-9_-]{8,}/, "a create is an idempotent write");
  assert.equal(created.envelope.data.preset, "slack-channel");
  assert.ok(!(created.stdout + created.stderr).includes(BOT_TOKEN));
  const human = await cli(["--human", "source", "create", "--preset", "slack-channel", "--card", CARD, "--name", "Team wall", "--set", "channel=C0123456789", "--secret", "token=-"], transport, env);
  assert.equal(human.code, 2, "stdin is not piped, so the secret cannot be read");
  assert.match(human.stdout + human.stderr, /Pipe input when using '-'/);
});

test("a preset field is text as written, and a list field takes a JSON array", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const created = await cli(["--json", "source", "create", "--preset", "google-travel-times", "--card", CARD, "--name", "Commute", "--set", "origin=1 Main St", "--set", "mode=transit", "--set", "store=123", "--set", "open=true",
    "--set", 'destinations=[{"name":"Gym","address":"9 Oak Ave"},{"name":"Office","address":"4 Pine Rd"}]', "--set", 'dotted="quoted text"', "--secret", "api_key=literal-key-value"], transport, env);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  assert.deepEqual(lastBody(calls).settings, {
    origin: "1 Main St", mode: "transit", store: "123", open: "true", destinations: [{ name: "Gym", address: "9 Oak Ave" }, { name: "Office", address: "4 Pine Rd" }], dotted: "quoted text",
  });
  const fromFile = await cli(["--json", "source", "create", "--preset", "google-travel-times", "--card", CARD, "--name", "Commute", "--settings", '{"origin":"A","destinations":[{"name":"B","address":"C"}]}', "--set", "origin=Z", "--secret", "api_key=literal-key-value"], transport, env);
  assert.equal(fromFile.code, 0, fromFile.stdout);
  assert.deepEqual(lastBody(calls).settings, { origin: "Z", destinations: [{ name: "B", address: "C" }] }, "--set overrides --settings, as for a kind");
  const bare = await cli(["--json", "source", "create", "--preset", "slack-channel", "--card", CARD, "--name", "Open"], transport, env);
  assert.equal(bare.code, 0, bare.stdout);
  assert.deepEqual(lastBody(calls).settings, {}, "the server names the fields it needs");
  assert.ok(!("secrets" in lastBody(calls)));
});

test("source create takes --kind or --preset, and a preset takes no connection", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  for (const [argv, pattern] of [
    [["--card", CARD, "--name", "n"], /Provide exactly one of --kind or --preset/],
    [["--kind", "json", "--preset", "slack-channel", "--card", CARD, "--name", "n"], /Provide exactly one of --kind or --preset/],
    [["--preset", "Slack_Channel", "--card", CARD, "--name", "n"], /A preset name is lower-case words joined by hyphens/],
    [["--preset", "slack-channel", "--card", CARD, "--name", "n", "--connection-id", "pcn_CONNECTION"], /--connection-id applies to a microsoft365 or google_calendar source, not to a preset/],
    [["--preset", "slack-channel", "--card", CARD, "--name", "n", "--settings", "[1]"], /--settings must be a JSON object/],
    [["--preset", "slack-channel", "--card", CARD, "--name", "n", "--set", "channel=1", "--set", "channel=2"], /--set channel is given twice/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "source", "create", ...argv], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${argv.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, argv.join(" "));
  }
  assert.equal(calls.length, 0, "nothing was sent");
});

test("source test --preset previews an unsaved preset source; a saved one takes --set as its fields", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  await writeFile(path.join(env.cwd, "slack.token"), `${BOT_TOKEN}\n`);
  const preview = await cli(["--json", "source", "test", "--preset", "slack-channel", "--card", CARD, "--set", "channel=C0123456789", "--secret", "token=@slack.token"], transport, env);
  assert.equal(preview.code, 0, preview.stdout + preview.stderr);
  assert.deepEqual(lastBody(calls), { preset: "slack-channel", target: { card_id: CARD }, settings: { channel: "C0123456789" }, secrets: { token: BOT_TOKEN } });
  assert.equal(calls.at(-1)!.headers?.["idempotency-key"], undefined, "a preview writes nothing, so it carries no idempotency key");
  assert.equal(preview.envelope.data.valid, true);

  const saved = await cli(["--json", "source", "test", SOURCE, "--set", "channel=C9999999999"], transport, env);
  assert.equal(saved.code, 0, saved.stdout);
  assert.deepEqual(lastBody(calls), { source_id: SOURCE, settings: { channel: "C9999999999" } }, "a preset source's fields override its own, never a config");
  const plain = await cli(["--json", "source", "test", PLAIN, "--set", "days=2"], transport, env);
  assert.equal(plain.code, 0, plain.stdout);
  assert.deepEqual(lastBody(calls), { source_id: PLAIN, config: { calendars: [{ key: "lobby" }], days: 2 } }, "a source that has no preset keeps the config merge");

  for (const [argv, pattern] of [
    [["test", "--preset", "slack-channel"], /takes a saved <source_id>, or --kind and --card/],
    [["test", "--kind", "json", "--preset", "slack-channel", "--card", CARD], /--preset|--kind/],
    [["test", SOURCE, "--preset", "slack-channel"], /--preset describes a source that is not saved/],
    [["test", "--preset", "slack-channel", "--card", CARD, "--connection-id", "pcn_CONNECTION"], /--connection-id applies to a microsoft365 or google_calendar source, not to a preset/],
  ] as Array<[string[], RegExp]>) {
    const before = calls.length;
    const refused = await cli(["--json", "source", ...argv], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${argv.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, argv.join(" "));
    assert.equal(calls.length, before, "nothing was sent");
  }
});

test("source update on a preset source sends its fields as settings, merged by the server and not guarded by a read", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  await writeFile(path.join(env.cwd, "new.token"), `${BOT_TOKEN}\n`);
  await writeFile(path.join(env.cwd, "fields.json"), JSON.stringify({ channel: "C1111111111" }));
  const changed = await cli(["--json", "source", "update", SOURCE, "--set", "channel=C9999999999", "--set", "channel_label=null", "--secret", "token=@new.token"], transport, env);
  assert.equal(changed.code, 0, changed.stdout + changed.stderr);
  assert.equal(calls.filter((call) => call.method === "GET").length, 1, "the saved source is read to see that a preset made it");
  const patch = calls.find((call) => call.method === "PATCH")!;
  assert.deepEqual(patch.body, { settings: { channel: "C9999999999", channel_label: null }, secrets: { token: BOT_TOKEN } }, "null removes an optional field");
  assert.equal(patch.headers?.["if-match"], undefined, "the server merges, so a conflict with another change is not the caller's");
  const guarded = await cli(["--json", "source", "update", SOURCE, "--set", "channel=C2222222222", "--expect-rev", "4"], transport, env);
  assert.equal(guarded.code, 0, guarded.stdout);
  assert.equal(calls.filter((call) => call.method === "PATCH").at(-1)!.headers?.["if-match"], '"4"');
  const fromFile = await cli(["--json", "source", "update", SOURCE, "--settings", "@fields.json"], transport, env);
  assert.equal(fromFile.code, 0, fromFile.stdout);
  assert.deepEqual(lastBody(calls), { settings: { channel: "C1111111111" } });
  const withoutRead = await cli(["--json", "source", "update", SOURCE, "--name", "Renamed", "--refresh", "5m"], transport, env);
  assert.equal(withoutRead.code, 0, withoutRead.stdout);
  assert.deepEqual(lastBody(calls), { name: "Renamed", refresh_seconds: 300 });
  assert.equal(calls.filter((call) => call.method === "GET").length, 3, "a rename reads nothing");
  const connection = await cli(["--json", "source", "update", SOURCE, "--connection-id", "pcn_CONNECTION"], transport, env);
  assert.equal(connection.code, ExitCode.Usage);
  assert.match(connection.envelope.error?.detail ?? "", /this source is made from a preset/);
  assert.equal(writes(calls).length, 4, "the refused update sent no write");
});

test("source show names a preset source's preset and fields, and a config sent to one names the way back", async () => {
  const env = await enrolled();
  const { transport } = backend();
  const shown = await cli(["--human", "source", "show", SOURCE], transport, env);
  assert.equal(shown.code, 0, shown.stdout);
  assert.match(shown.stdout, /^kind: json$/m);
  assert.match(shown.stdout, /^preset: slack-channel$/m);
  assert.match(shown.stdout, /^settings: \{"channel":"C0123456789","channel_label":"#announcements"\}$/m);
  assert.match(shown.stdout, /^config: \{"url":"https:\/\/slack\.com\/api\/conversations\.history/m);
  const plain = await cli(["--human", "source", "show", PLAIN], transport, env);
  assert.ok(!/^preset:/m.test(plain.stdout) && !/^settings:/m.test(plain.stdout), "a source that has no preset shows neither");

  const refused = new FakeTransport()
    .on("PATCH", `/api/sources/${SOURCE}`, () => problem(400, "invalid_request", "config is not accepted for a source made from a preset.", { errors: [{ field: "config", detail: "a source made from a preset takes settings" }] }))
    .on("GET", `/api/sources/${SOURCE}`, () => json(200, source({ preset: null, settings: null })));
  const config = await cli(["--json", "source", "update", SOURCE, "--settings", '{"url":"https://example.com/x.json"}'], refused, env);
  assert.equal(config.code, 8);
  assert.equal(config.envelope.error?.code, "invalid_request");
  assert.equal(config.envelope.error?.next?.command, `screenrig source show ${SOURCE}`);
  assert.match(config.envelope.error?.next?.reason ?? "", /change its fields with --set FIELD=VALUE/);
});

test("source help names the presets, the preset and connection flags, and a working example", () => {
  const group = commandHelp(["source"]);
  for (const text of ["source presets lists them", "source presets NAME", "--preset NAME", "--connection-id pcn_", "toast", "include and exclude", "header.NAME", "query.NAME", "oauth2", "token_request", "pagination", "graphql", "body_format", "{{today-1d}}", "data.request"]) {
    assert.ok(group.usage.includes(text), text);
  }
  const presets = commandHelp(["source", "presets"]);
  assert.equal(presets.kind, "command");
  assert.ok(presets.examples.length > 0 && presets.examples.every((example) => example.startsWith("screenrig source presets")));
  assert.match(presets.notes.join("\n"), /Read only: nothing is created/);
  const create = commandHelp(["source", "create"]);
  assert.equal(create.options.find((option) => option.name === "--kind")!.required, false, "--kind is one of two ways to name what the source reads");
  assert.ok(create.options.some((option) => option.name === "--preset"));
  assert.ok(create.options.some((option) => option.name === "--connection-id"));
  assert.deepEqual(create.relationships.find((group) => group.kind === "exactlyOne")?.options, ["--kind", "--preset"]);
  assert.ok(create.examples.some((example) => example.includes("--preset slack-channel")));
  assert.ok(create.examples.some((example) => example.includes("--kind toast")));
  assert.ok(create.examples.some((example) => example.includes("header.X-Api-Key")));
  assert.ok(create.examples.some((example) => example.includes("--connection-id pcn_CONNECTION")));
  assert.ok(create.examples.some((example) => example.includes("exclude=")));
  const test = commandHelp(["source", "test"]);
  assert.ok(test.options.find((option) => option.name === "--preset")!.conflicts.includes("--kind"));
  assert.ok(test.examples.some((example) => example.includes("--preset slack-channel")));
  assert.match(test.notes.join("\n"), /data\.request/);
  assert.ok(commandHelp(["source", "update"]).examples.some((example) => example.includes("src_PRESETSOURCE")));
  assert.throws(() => parseArgv(["source", "create", "--kind", "json", "--preset", "slack-channel", "--card", CARD, "--name", "n"]), /Provide exactly one of --kind or --preset/);
  assert.equal(parseArgv(["source", "create", "--preset", "slack-channel", "--card", CARD, "--name", "n"]).flags.preset, "slack-channel");
});
