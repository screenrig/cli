import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import type { CampaignStatus, Screen, ScreenVerdict } from "./adapters/protocol.js";
import {
  campaignAudienceText, campaignCountsText, campaignExplainTime, campaignInstant, campaignStandingDetail, campaignWhenText, campaignWindow, campaignWindowSpec,
  verdictDetail,
} from "./campaigns.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help.js";
import { run, type CliRuntime } from "./main.js";
import { networkError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest } from "./transport/types.js";

const PLAYLIST = "pl_CAMPAIGNAAAAAAAAAAAAAAAA";
const OTHER_PLAYLIST = "pl_OTHERAAAAAAAAAAAAAAAAAAAA";
const UNAPPROVED = "pl_UNAPPROVEDAAAAAAAAAAAAAAA";
const MISSING = "cmp_MISSINGAAAAAAAAA";
const A = "scr_AAAAAAAAAAAAAAAAAAAAAAAA";
const B = "scr_BBBBBBBBBBBBBBBBBBBBBBBB";
const C = "scr_CCCCCCCCCCCCCCCCCCCCCCCC";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; next?: { command: string; reason: string }; errors?: Array<{ field?: string }> };
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
  const configDir = await testTemp("campaigns-cfg-");
  const cwd = await testTemp("campaigns-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, stdin?: string): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr,
    now: () => new Date("2026-08-14T17:00:00.000Z"),
    sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
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

const campaignCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => call.path.startsWith("/api/campaigns"));
const lastCall = (transport: FakeTransport): TransportRequest => campaignCalls(transport).at(-1)!;

function backend(): FakeTransport {
  const transport = memoryBackend();
  for (const id of [PLAYLIST, OTHER_PLAYLIST, UNAPPROVED]) transport.putPlaylist!({ id });
  return transport;
}

function screen(id: string, overrides: Partial<Screen> = {}): Screen {
  return {
    id, label: `Screen ${id.slice(4, 5)}`, public_id: `pub_${id}`, state: "active", revision: 1, manifest_revision: 1,
    content_access_generation: 1, online: true, created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:00.000Z",
    tags: [], playlist_id: PLAYLIST, timezone: "America/Los_Angeles", ...overrides,
  };
}

async function create(transport: FakeTransport, env: Env, ...extra: string[]) {
  const created = await cli(["--json", "campaign", "create", "--name", "Holiday hours", "--playlist-id", PLAYLIST, ...(extra.length ? extra : ["--tag", "Lobby"])], transport, env);
  assert.equal(created.code, 0, created.stdout);
  return created.envelope.data as { id: string; revision: number; priority: number; paused: boolean; audience: unknown };
}

test("campaign create sends the name, playlist, tag audience, bounds, windows and priority, and prints the campaign", async () => {
  const env = await enrolled();
  const transport = backend();
  const created = await cli(["--json", "campaign", "create", "--name", "  Holiday hours ", "--playlist-id", PLAYLIST, "--tag", "Lobby",
    "--from", "2026-12-20T00:00", "--until", "2027-01-02T00:00", "--window", "mon-fri@09:00-17:00", "--window", "sat,sun", "--priority", "10"], transport, env);
  assert.equal(created.code, 0, created.stdout);
  const call = lastCall(transport);
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/campaigns");
  assert.deepEqual(call.body, {
    name: "Holiday hours", playlist_id: PLAYLIST, audience: { tag: "Lobby" }, from: "2026-12-20T00:00", until: "2027-01-02T00:00",
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }, { days: ["sat", "sun"] }], priority: 10,
  });
  assert.ok(call.headers?.["idempotency-key"], "create always sends an Idempotency-Key");
  assert.match(created.envelope.data.id, /^cmp_/);
  assert.equal(created.envelope.data.revision, 1);
  assert.equal(created.envelope.data.paused, false);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/, "a completed create clears its recovery entry");

  const human = await cli(["--human", "campaign", "create", "--name", "Closed sign", "--playlist-id", PLAYLIST, "--all-screens", "--window", "daily@22:00-06:00"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Created campaign cmp_\S+\. Screens in its audience switch to the playlist within a minute while it holds; screenrig campaign screens cmp_\S+ shows each screen's standing\.$/m);
  assert.match(human.stdout, /^audience: every screen$/m);
  assert.match(human.stdout, /^when: daily@22:00-06:00 \(civil times in each screen's timezone\)$/m);
  assert.match(human.stdout, /^priority: 0$/m);
  assert.match(human.stdout, /^paused: false$/m);
});

test("campaign create maps every audience flag onto the audience rule", async () => {
  const env = await enrolled();
  const transport = backend();
  const nested = '{"all":[{"tag":"North"},{"any":[{"tag":"Cafe"},{"tag":"Patio"}]}]}';
  const cases: Array<[string[], unknown]> = [
    [["--tag", "Lobby"], { tag: "Lobby" }],
    [["--tag", "Lobby", "--tag", "Floor2,North"], { all: [{ tag: "Lobby" }, { tag: "Floor2" }, { tag: "North" }] }],
    [["--any-tag", "Cafe"], { any: [{ tag: "Cafe" }] }],
    [["--any-tag", "Cafe,Patio", "--any-tag", "Bar"], { any: [{ tag: "Cafe" }, { tag: "Patio" }, { tag: "Bar" }] }],
    [["--screen-id", A], { screen_id: A }],
    [["--screen-id", `${A},${B}`, "--screen-id", C], { any: [{ screen_id: A }, { screen_id: B }, { screen_id: C }] }],
    [["--all-screens"], { all: [] }],
    [["--audience", nested], JSON.parse(nested)],
  ];
  for (const [flags, audience] of cases) {
    const created = await cli(["--json", "campaign", "create", "--name", "Menu", "--playlist-id", PLAYLIST, ...flags], transport, env);
    assert.equal(created.code, 0, `${flags.join(" ")}: ${created.stdout}`);
    assert.deepEqual((lastCall(transport).body as { audience: unknown }).audience, audience, flags.join(" "));
    assert.deepEqual(created.envelope.data.audience, audience, flags.join(" "));
  }
  const body = lastCall(transport).body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["audience", "name", "playlist_id"], "optional members are sent only when set");
});

test("campaign create --audience reads a file with @FILE and stdin with -", async () => {
  const env = await enrolled();
  const transport = backend();
  const rule = { all: [{ tag: "North" }, { screen_id: A }] };
  await writeFile(path.join(env.cwd, "audience.json"), JSON.stringify(rule));
  const fromFile = await cli(["--json", "campaign", "create", "--name", "File", "--playlist-id", PLAYLIST, "--audience", "@audience.json"], transport, env);
  assert.equal(fromFile.code, 0, fromFile.stdout);
  assert.deepEqual((lastCall(transport).body as { audience: unknown }).audience, rule);
  const fromStdin = await cli(["--json", "campaign", "create", "--name", "Stdin", "--playlist-id", PLAYLIST, "--audience", "-"], transport, env, JSON.stringify({ tag: "Piped" }));
  assert.equal(fromStdin.code, 0, fromStdin.stdout);
  assert.deepEqual((lastCall(transport).body as { audience: unknown }).audience, { tag: "Piped" });

  const before = campaignCalls(transport).length;
  for (const [value, stdin] of [["@missing.json", undefined], ["{ not json", undefined], ["[]", undefined], ["null", undefined], ["-", "7"], ["@", undefined]] as const) {
    const refused = await cli(["--json", "campaign", "create", "--name", "x", "--playlist-id", PLAYLIST, "--audience", value], transport, env, stdin);
    assert.equal(refused.code, ExitCode.Usage, `${value}: ${refused.stdout}`);
  }
  assert.equal(campaignCalls(transport).length, before, "an unreadable audience sends no request");
});

test("campaign create --paused creates the campaign paused and says no screen changes", async () => {
  const env = await enrolled();
  const transport = backend();
  const created = await cli(["--human", "campaign", "create", "--name", "Later", "--playlist-id", PLAYLIST, "--tag", "Lobby", "--paused"], transport, env);
  assert.equal(created.code, 0, created.stderr);
  assert.equal((lastCall(transport).body as { paused?: boolean }).paused, true);
  assert.match(created.stdout, /^Created campaign cmp_\S+, paused\. No screen changes until screenrig campaign resume cmp_\S+\.$/m);
  assert.match(created.stdout, /^paused: true$/m);
});

test("campaign create refuses a bad input before any request", async () => {
  const env = await enrolled();
  const transport = backend();
  const base = ["--name", "Menu", "--playlist-id", PLAYLIST];
  const cases: Array<[string[], RegExp]> = [
    [["--playlist-id", PLAYLIST, "--tag", "Lobby"], /--name/],
    [["--name", "Menu", "--tag", "Lobby"], /--playlist-id/],
    [["--name", "", "--playlist-id", PLAYLIST, "--tag", "Lobby"], /--name requires a value/],
    [["--name", "   ", "--playlist-id", PLAYLIST, "--tag", "Lobby"], /1 to 120 characters/],
    [["--name", "x".repeat(121), "--playlist-id", PLAYLIST, "--tag", "Lobby"], /1 to 120 characters/],
    [["--name", "Bad\u0007", "--playlist-id", PLAYLIST, "--tag", "Lobby"], /without controls/],
    [["--name", "Menu", "--playlist-id", A, "--tag", "Lobby"], /playlist id/],
    [base, /exactly one of --tag or --any-tag or --screen-id or --all-screens or --audience/],
    [[...base, "--tag", "Lobby", "--all-screens"], /cannot be used with/],
    [[...base, "--tag", "Lobby", "--audience", "{}"], /cannot be used with/],
    [[...base, "--any-tag", "Cafe", "--screen-id", A], /cannot be used with/],
    [[...base, "--tag", "not a tag"], /1 to 32 letters or digits/],
    [[...base, "--tag", "x".repeat(33)], /1 to 32 letters or digits/],
    [[...base, "--tag", "Lobby", "--tag", "Lobby"], /more than once/],
    [[...base, "--any-tag", "Cafe,,Patio"], /1 to 32 letters or digits/],
    [[...base, "--screen-id", "pl_AAAAAAAAAAAAAAAA"], /screen ids/],
    [[...base, "--screen-id", `${A},${A}`], /more than once/],
    [[...base, "--tag", Array.from({ length: 500 }, (_, index) => `T${index}`).join(",")], /at most 499 tags/],
    [[...base, "--screen-id", Array.from({ length: 500 }, (_, index) => `scr_${String(index).padStart(8, "0")}`).join(",")], /at most 499 screens/],
    [[...base, "--all-screens", "--from", "2026-12-24"], /YYYY-MM-DDTHH:MM/],
    [[...base, "--all-screens", "--from", "2026-12-24T18:00:00"], /YYYY-MM-DDTHH:MM/],
    [[...base, "--all-screens", "--from", "2026-12-24T18:00Z"], /YYYY-MM-DDTHH:MM/],
    [[...base, "--all-screens", "--from", "2026-02-29T10:00"], /YYYY-MM-DDTHH:MM/],
    [[...base, "--all-screens", "--until", "2026-12-24T24:00"], /YYYY-MM-DDTHH:MM/],
    [[...base, "--all-screens", "--from", "2026-12-24T18:00", "--until", "2026-12-24T18:00"], /--until must be later than --from/],
    [[...base, "--all-screens", "--from", "2026-12-24T18:00", "--until", "2026-12-23T18:00"], /--until must be later than --from/],
    [[...base, "--all-screens", "--window", "weekdays"], /not a day/],
    [[...base, "--all-screens", "--window", "mon@9:00-17:00"], /HH:MM-HH:MM/],
    [[...base, "--all-screens", "--window", "mon@09:00"], /HH:MM-HH:MM/],
    [[...base, "--all-screens", "--window", "mon@09:00-24:00"], /HH:MM-HH:MM/],
    [[...base, "--all-screens", ...Array.from({ length: 17 }, () => ["--window", "mon"]).flat()], /at most 16 windows/],
    [[...base, "--all-screens", "--priority", "101"], /0 to 100/],
    [[...base, "--all-screens", "--priority", "-1"], /0 to 100|requires a value/],
    [[...base, "--all-screens", "--priority", "high"], /0 to 100/],
    [[...base, "--all-screens", "--priority", "1", "--priority", "2"], /only once/],
    [[...base, "--all-screens", "--name", "Again"], /only once/],
  ];
  for (const [flags, detail] of cases) {
    const refused = await cli(["--json", "campaign", "create", ...flags], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${flags.join(" ").slice(0, 120)}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? "", detail, flags.join(" ").slice(0, 120));
  }
  assert.equal(campaignCalls(transport).length, 0);
});

test("campaign windows parse days, ranges, wrapping ranges and times into mon-to-sun days", () => {
  const weekdays = ["mon", "tue", "wed", "thu", "fri"];
  assert.deepEqual(campaignWindow("mon-fri@09:00-17:00"), { days: weekdays, start: "09:00", end: "17:00" });
  assert.deepEqual(campaignWindow("sat,sun"), { days: ["sat", "sun"] });
  assert.deepEqual(campaignWindow("daily"), { days: [...weekdays, "sat", "sun"] });
  assert.deepEqual(campaignWindow("daily@22:00-06:00"), { days: [...weekdays, "sat", "sun"], start: "22:00", end: "06:00" });
  assert.deepEqual(campaignWindow("fri-mon"), { days: ["mon", "fri", "sat", "sun"] });
  assert.deepEqual(campaignWindow("sat-tue@10:00-14:00"), { days: ["mon", "tue", "sat", "sun"], start: "10:00", end: "14:00" });
  assert.deepEqual(campaignWindow("mon-mon"), { days: ["mon"] });
  assert.deepEqual(campaignWindow("Mon, WED-fri @ 22:00-06:00"), { days: ["mon", "wed", "thu", "fri"], start: "22:00", end: "06:00" });
  assert.deepEqual(campaignWindow("mon-fri,wed,mon"), { days: weekdays }, "days are sent once, in mon to sun order");
  assert.deepEqual(campaignWindow("sun,mon"), { days: ["mon", "sun"] });
  assert.deepEqual(campaignWindow("mon@09:00-09:00"), { days: ["mon"], start: "09:00", end: "09:00" });
  assert.deepEqual(campaignWindow("tue@00:00-23:59"), { days: ["tue"], start: "00:00", end: "23:59" });
  for (const bad of ["", "@09:00-17:00", "mon-", "-fri", "funday", "mon,,tue", "mon-tue-wed", "daily,mon", "mon@", "mon@09:00", "mon@9:00-17:00", "mon@09:00-17:0", "mon@09:00-25:00", "mon@09:60-17:00", "mon@09:00-17:00-18:00", "mon@09:00~17:00", "mon;tue"]) {
    assert.throws(() => campaignWindow(bad), (error: any) => error.problem?.code === "usage_error" && /--window/.test(error.problem.detail), JSON.stringify(bad));
  }
});

test("campaign window specs print in --window spelling and parse back to the same window", () => {
  const cases: Array<[string[], string | undefined, string]> = [
    [["mon", "tue", "wed", "thu", "fri"], "09:00", "mon-fri@09:00-17:00"],
    [["mon", "tue"], undefined, "mon,tue"],
    [["mon", "wed", "fri"], undefined, "mon,wed,fri"],
    [["sat", "sun"], undefined, "sat,sun"],
    [["mon", "tue", "wed", "thu", "fri", "sat", "sun"], undefined, "daily"],
    [["mon", "tue", "wed", "fri", "sat", "sun"], undefined, "mon-wed,fri-sun"],
    [["mon", "wed", "thu", "fri"], undefined, "mon,wed-fri"],
  ];
  for (const [days, start, spec] of cases) {
    const window = { days: days as never, ...(start ? { start, end: "17:00" } : {}) };
    assert.equal(campaignWindowSpec(window), spec);
    assert.deepEqual(campaignWindow(spec), window, spec);
  }
});

test("campaign --from and --until take real civil minutes", () => {
  const from = campaignInstant("--from");
  for (const good of ["2026-12-24T18:00", "2028-02-29T00:00", "2026-12-31T23:59", "0001-01-01T00:00"]) assert.equal(from(good), good);
  for (const bad of ["", "2026-12-24", "2026-12-24 18:00", "2026-12-24T18:00:00", "2026-12-24T18:00Z", "2026-12-24T18:00+01:00", "2026-02-29T10:00", "2026-04-31T10:00", "2026-13-01T10:00", "2026-00-10T10:00", "2026-12-00T10:00", "2026-12-24T24:00", "2026-12-24T18:60", "26-12-24T18:00"]) {
    assert.throws(() => from(bad), (error: any) => error.problem?.code === "usage_error" && /--from takes a civil date and time/.test(error.problem.detail), JSON.stringify(bad));
  }
});

test("campaign update sends only the changed members, null clears, and --expect-rev guards the revision", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await create(transport, env, "--tag", "Lobby", "--from", "2026-12-20T00:00", "--until", "2027-01-02T00:00", "--window", "sat,sun");

  const changed = await cli(["--json", "campaign", "update", campaign.id, "--name", " Weekend ", "--playlist-id", OTHER_PLAYLIST, "--any-tag", "Cafe,Patio",
    "--from", "2026-12-21T00:00", "--clear-until", "--window", "mon-fri@07:00-11:00", "--window", "sat@10:00-14:00", "--priority", "20", "--expect-rev", String(campaign.revision)], transport, env);
  assert.equal(changed.code, 0, changed.stdout);
  const call = lastCall(transport);
  assert.equal(call.method, "PATCH");
  assert.equal(call.path, `/api/campaigns/${campaign.id}`);
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.deepEqual(call.body, {
    name: "Weekend", playlist_id: OTHER_PLAYLIST, audience: { any: [{ tag: "Cafe" }, { tag: "Patio" }] }, from: "2026-12-21T00:00", until: null,
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "07:00", end: "11:00" }, { days: ["sat"], start: "10:00", end: "14:00" }], priority: 20,
  });
  assert.equal(changed.envelope.data.revision, 2);
  assert.equal(changed.envelope.data.until, undefined);
  assert.equal(changed.envelope.data.name, "Weekend");

  const cleared = await cli(["--json", "campaign", "update", campaign.id, "--clear-from", "--clear-until", "--clear-windows"], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  assert.deepEqual(lastCall(transport).body, { from: null, until: null, windows: null });
  assert.equal(lastCall(transport).headers?.["if-match"], undefined);
  assert.equal(cleared.envelope.data.from, undefined);
  assert.equal(cleared.envelope.data.windows, undefined);
  const human = await cli(["--human", "campaign", "update", campaign.id, "--all-screens"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Updated campaign cmp_\S+\. Every screen of its old and new audience re-resolves within a minute\.$/m);
  assert.match(human.stdout, /^audience: every screen$/m);
  assert.match(human.stdout, /^when: always$/m);
});

test("campaign update needs a change and refuses conflicting options before any request", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await create(transport, env);
  const before = campaignCalls(transport).length;
  const cases: Array<[string[], RegExp]> = [
    [[], /Provide at least one of --name or --playlist-id/],
    [["--expect-rev", "1"], /Provide at least one of/],
    [["--tag", "Lobby", "--all-screens"], /cannot be used with/],
    [["--from", "2026-12-24T18:00", "--clear-from"], /cannot be used with/],
    [["--until", "2026-12-24T18:00", "--clear-until"], /cannot be used with/],
    [["--window", "sat", "--clear-windows"], /cannot be used with/],
    [["--from", "2026-12-24T18:00", "--until", "2026-12-24T09:00"], /--until must be later than --from/],
    [["--name", " "], /1 to 120 characters/],
    [["--playlist-id", A], /playlist id/],
    [["--priority", "101"], /0 to 100/],
    [["--expect-rev", "zero", "--name", "x"], /--expect-rev/],
  ];
  for (const [flags, detail] of cases) {
    const refused = await cli(["--json", "campaign", "update", campaign.id, ...flags], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${flags.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? "", detail, flags.join(" "));
  }
  const badId = await cli(["--json", "campaign", "update", "flk_AAAAAAAAAAAAAAAA", "--name", "x"], transport, env);
  assert.equal(badId.code, ExitCode.Usage);
  assert.equal(badId.envelope.error?.next?.command, "screenrig campaign list");
  assert.equal(campaignCalls(transport).length, before);
});

test("campaign update, pause, resume and delete map a stale revision to the show command", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await create(transport, env);
  for (const argv of [["update", campaign.id, "--priority", "5"], ["pause", campaign.id], ["resume", campaign.id], ["delete", campaign.id]]) {
    const stale = await cli(["--json", "campaign", ...argv, "--expect-rev", "9"], transport, env);
    assert.equal(stale.code, ExitCode.Precondition, `${argv[0]}: ${stale.stdout}`);
    assert.equal(stale.envelope.error?.code, "revision_conflict");
    assert.equal(stale.envelope.error?.next?.command, `screenrig campaign show ${campaign.id}`);
    assert.equal(lastCall(transport).headers?.["if-match"], '"9"');
  }
  const shown = await cli(["--json", "campaign", "show", campaign.id], transport, env);
  assert.equal(shown.envelope.data.revision, 1, "a refused write changes nothing");
});

test("campaign pause and resume send paused true and false", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await create(transport, env);

  const paused = await cli(["--json", "campaign", "pause", campaign.id, "--expect-rev", "1"], transport, env);
  assert.equal(paused.code, 0, paused.stdout);
  assert.equal(lastCall(transport).method, "PATCH");
  assert.deepEqual(lastCall(transport).body, { paused: true });
  assert.equal(lastCall(transport).headers?.["if-match"], '"1"');
  assert.ok(lastCall(transport).headers?.["idempotency-key"]);
  assert.equal(paused.envelope.data.paused, true);
  assert.equal(paused.envelope.data.revision, 2);

  const resumed = await cli(["--human", "campaign", "resume", campaign.id], transport, env);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual(lastCall(transport).body, { paused: false });
  assert.equal(lastCall(transport).headers?.["if-match"], undefined);
  assert.match(resumed.stdout, /^Resumed campaign cmp_\S+\. Screens in its audience switch to the playlist within a minute while it holds;/m);
  assert.match(resumed.stdout, /^paused: false$/m);
  const humanPause = await cli(["--human", "campaign", "pause", campaign.id], transport, env);
  assert.match(humanPause.stdout, /^Paused campaign cmp_\S+\. Screens that showed it return to what they would show without it within a minute; screenrig campaign resume cmp_\S+ starts it again\.$/m);
});

test("campaign delete sends the revision guard and answers deleted", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await create(transport, env);
  const deleted = await cli(["--json", "campaign", "delete", campaign.id, "--expect-rev", String(campaign.revision)], transport, env);
  assert.equal(deleted.code, 0, deleted.stdout);
  assert.equal(lastCall(transport).method, "DELETE");
  assert.equal(lastCall(transport).headers?.["if-match"], '"1"');
  assert.ok(lastCall(transport).headers?.["idempotency-key"]);
  assert.deepEqual(deleted.envelope.data, { id: campaign.id, deleted: true });

  const gone = await cli(["--json", "campaign", "delete", campaign.id], transport, env);
  assert.equal(gone.code, ExitCode.NotFound, gone.stdout);
  assert.equal(gone.envelope.error?.next?.command, "screenrig campaign list");
  const other = await create(transport, env);
  const human = await cli(["--human", "campaign", "delete", other.id], transport, env);
  assert.match(human.stdout, new RegExp(`^Deleted campaign ${other.id}\\. Screens that showed it return to what they would show without it within a minute\\.$`, "m"));
});

test("campaign list prints campaigns in the precedence order the server returns", async () => {
  const env = await enrolled();
  const transport = backend();
  const empty = await cli(["--human", "campaign", "list"], transport, env);
  assert.match(empty.stdout, /^Campaigns \(0\), in the order screens read them\nNo campaigns$/m);

  const first = await create(transport, env, "--tag", "Lobby");
  const urgent = await create(transport, env, "--any-tag", "Cafe,Lobby", "--priority", "50", "--window", "mon-fri@07:00-11:00");
  const newest = await create(transport, env, "--all-screens", "--paused");
  const listed = await cli(["--json", "campaign", "list"], transport, env);
  assert.equal(listed.code, 0, listed.stdout);
  assert.equal(lastCall(transport).method, "GET");
  assert.equal(lastCall(transport).path, "/api/campaigns");
  assert.deepEqual(listed.envelope.data.items.map((item: { id: string }) => item.id), [urgent.id, newest.id, first.id]);

  const human = await cli(["--human", "campaign", "list"], transport, env);
  assert.match(human.stdout, /^Campaigns \(3\), in the order screens read them$/m);
  const lines = human.stdout.split("\n");
  const header = lines.find((line) => line.startsWith("ID "))!;
  assert.match(header, /^ID\s+NAME\s+PLAYLIST\s+AUDIENCE\s+WHEN\s+PRIORITY\s+PAUSED$/);
  const rows = lines.slice(lines.indexOf(header) + 1).filter(Boolean);
  assert.equal(rows.length, 3);
  assert.match(rows[0]!, new RegExp(`^${urgent.id}\\s+Holiday hours\\s+${PLAYLIST}\\s+tag Cafe or tag Lobby\\s+mon-fri@07:00-11:00\\s+50\\s+no$`));
  assert.match(rows[1]!, new RegExp(`^${newest.id}\\s+Holiday hours\\s+${PLAYLIST}\\s+every screen\\s+always\\s+0\\s+yes$`));
});

test("campaign show prints the audience and clock readably and answers not_found with the campaign list", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await create(transport, env, "--tag", "Lobby", "--tag", "Floor2", "--from", "2026-12-20T00:00", "--window", "mon-fri@09:00-17:00", "--window", "sat,sun", "--priority", "7");
  const shown = await cli(["--human", "campaign", "show", campaign.id], transport, env);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(lastCall(transport).method, "GET");
  assert.equal(lastCall(transport).path, `/api/campaigns/${campaign.id}`);
  for (const line of [
    `^id: ${campaign.id}$`, "^name: Holiday hours$", `^playlist_id: ${PLAYLIST}$`, "^audience: tag Lobby and tag Floor2$",
    "^when: from 2026-12-20T00:00; mon-fri@09:00-17:00; sat,sun \\(civil times in each screen's timezone\\)$",
    "^priority: 7$", "^paused: false$", "^revision: 1$", "^created_at: ", "^updated_at: ",
  ]) assert.match(shown.stdout, new RegExp(line, "m"));
  const json = await cli(["--json", "campaign", "show", campaign.id], transport, env);
  assert.deepEqual(json.envelope.data.audience, { all: [{ tag: "Lobby" }, { tag: "Floor2" }] });

  const missing = await cli(["--json", "campaign", "show", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound, missing.stdout);
  assert.equal(missing.envelope.error?.next?.command, "screenrig campaign list");
  assert.match(missing.envelope.error?.next?.reason ?? "", /ads campaigns list names an advertising campaign/);
  for (const bad of ["trg_AAAAAAAAAAAAAAAA", "cmp_", "campaign", "../cmp_A"]) {
    const refused = await cli(["--json", "campaign", "show", bad], transport, env);
    assert.equal(refused.code, ExitCode.Usage, bad);
  }
  assert.equal((await cli(["--json", "campaign", "show"], transport, env)).code, ExitCode.Usage);
});

test("campaign audiences read as text", () => {
  assert.equal(campaignAudienceText({ all: [] }), "every screen");
  assert.equal(campaignAudienceText({ tag: "Lobby" }), "tag Lobby");
  assert.equal(campaignAudienceText({ screen_id: A }), `screen ${A}`);
  assert.equal(campaignAudienceText({ all: [{ tag: "a" }, { tag: "b" }] }), "tag a and tag b");
  assert.equal(campaignAudienceText({ any: [{ tag: "a" }] }), "tag a");
  assert.equal(campaignAudienceText({ all: [{ tag: "North" }, { any: [{ tag: "Cafe" }, { tag: "Patio" }] }] }), "tag North and (tag Cafe or tag Patio)");
  assert.equal(campaignAudienceText({ any: [{ screen_id: "scr_A" }, { all: [{ tag: "x" }, { tag: "y" }] }] }), "screen scr_A or (tag x and tag y)");
  assert.equal(campaignAudienceText(undefined), "");
  assert.equal(campaignWhenText({}), "always");
  assert.equal(campaignWhenText({ until: "2027-01-02T00:00", windows: [{ days: ["sat", "sun"] }] }), "until 2027-01-02T00:00; sat,sun");
});

test("campaign screens reads the reach with counts, pages by cursor and prints each standing", async () => {
  const env = await enrolled();
  const transport = backend();
  transport.putScreen!(screen(A, { tags: ["Lobby"] }));
  transport.putScreen!(screen(B, { tags: ["Lobby"], playlist_id: undefined }));
  transport.putScreen!(screen(C, { tags: ["Lobby", "Floor2"], timezone: undefined }));
  transport.putScreen!(screen("scr_DDDDDDDDDDDDDDDDDDDDDDDD", { tags: ["Cafe"] }));
  transport.putScreen!(screen("scr_EEEEEEEEEEEEEEEEEEEEEEEE", { tags: ["Lobby"], state: "archived" }));
  const campaign = await create(transport, env, "--tag", "Lobby", "--window", "mon-fri@09:00-17:00");

  const reach = await cli(["--json", "campaign", "screens", campaign.id], transport, env);
  assert.equal(reach.code, 0, reach.stdout);
  assert.equal(lastCall(transport).method, "GET");
  assert.equal(lastCall(transport).path, `/api/campaigns/${campaign.id}/screens`);
  assert.deepEqual(lastCall(transport).query ?? {}, {});
  assert.deepEqual(reach.envelope.data.counts, { audience: 3, playing: 1, blocked: 2 });
  assert.deepEqual(reach.envelope.data.items.map((item: CampaignStatus) => [item.screen_id, item.status, item.reason]), [
    [A, "playing", undefined], [B, "blocked", "no_default_playlist"], [C, "blocked", "no_timezone"],
  ]);
  assert.equal(reach.envelope.data.next_cursor, undefined);

  const human = await cli(["--human", "campaign", "screens", campaign.id], transport, env);
  assert.match(human.stdout, new RegExp(`^Campaign ${campaign.id} reaches 3 screens$`, "m"));
  assert.match(human.stdout, /^counts: 1 playing, 2 blocked$/m);
  assert.match(human.stdout, /^SCREEN\s+NAME\s+STATUS\s+DETAIL$/m);
  assert.match(human.stdout, new RegExp(`^${A}\\s+Screen A\\s+playing$`, "m"));
  assert.match(human.stdout, new RegExp(`^${B}\\s+Screen B\\s+blocked\\s+the screen has no default playlist: screenrig screen assign SCREEN_ID --playlist-id PLAYLIST_ID$`, "m"));
  assert.match(human.stdout, new RegExp(`^${C}\\s+Screen C\\s+blocked\\s+the screen has no timezone: screenrig screen set-timezone SCREEN_ID --timezone ZONE$`, "m"));
  assert.doesNotMatch(human.stdout, /^next:/m);

  const first = await cli(["--json", "campaign", "screens", campaign.id, "--limit", "2"], transport, env);
  assert.deepEqual(lastCall(transport).query, { limit: "2" });
  assert.equal(first.envelope.data.items.length, 2);
  assert.equal(first.envelope.data.next_cursor, B);
  assert.deepEqual(first.envelope.data.counts, { audience: 3, playing: 1, blocked: 2 }, "counts cover the whole audience, not the page");
  const firstHuman = await cli(["--human", "campaign", "screens", campaign.id, "--limit", "2"], transport, env);
  assert.match(firstHuman.stdout, new RegExp(`^next: screenrig campaign screens ${campaign.id} --cursor ${B} --limit 2$`, "m"));
  const second = await cli(["--json", "campaign", "screens", campaign.id, "--limit", "2", "--cursor", B], transport, env);
  assert.deepEqual(lastCall(transport).query, { limit: "2", cursor: B });
  assert.deepEqual(second.envelope.data.items.map((item: CampaignStatus) => item.screen_id), [C]);
  assert.equal(second.envelope.data.next_cursor, undefined);

  const none = await create(transport, env, "--tag", "Nowhere");
  const empty = await cli(["--human", "campaign", "screens", none.id], transport, env);
  assert.match(empty.stdout, new RegExp(`^Campaign ${none.id} reaches 0 screens$`, "m"));
  assert.match(empty.stdout, new RegExp(`^No live screen is in the audience\\. screenrig campaign show ${none.id} prints the audience, and screenrig screen tag sets a screen's tags\\.$`, "m"));
});

test("campaign screens validates its limit, cursor and id before any request", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await create(transport, env);
  const before = campaignCalls(transport).length;
  for (const flags of [["--limit", "0"], ["--limit", "501"], ["--limit", "ten"], ["--limit", "1.5"], ["--cursor", ""], ["--limit", "5", "--limit", "6"]]) {
    const refused = await cli(["--json", "campaign", "screens", campaign.id, ...flags], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${flags.join(" ")}: ${refused.stdout}`);
  }
  assert.equal((await cli(["--json", "campaign", "screens", "scr_AAAAAAAAAAAAAAAA"], transport, env)).code, ExitCode.Usage);
  assert.equal((await cli(["--json", "campaign", "screens", campaign.id, "--limit", "500"], transport, env)).code, 0);
  assert.equal(campaignCalls(transport).length, before + 1);
  const missing = await cli(["--json", "campaign", "screens", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
  assert.equal(missing.envelope.error?.next?.command, "screenrig campaign list");
});

test("campaign explain says why each campaign plays on a screen or not, in precedence order", async () => {
  const env = await enrolled();
  const transport = backend();
  transport.putScreen!(screen(A, { tags: ["Lobby", "North"] }));
  transport.putScreen!(screen(B, { tags: ["Lobby"], playlist_id: undefined }));
  const base = await create(transport, env, "--tag", "Lobby");
  const urgent = await create(transport, env, "--tag", "North", "--priority", "40");
  const elsewhere = await create(transport, env, "--tag", "Cafe");
  const paused = await create(transport, env, "--all-screens", "--paused");

  const explained = await cli(["--json", "campaign", "explain", A], transport, env);
  assert.equal(explained.code, 0, explained.stdout);
  assert.equal(transport.calls.at(-1)!.method, "GET");
  assert.equal(transport.calls.at(-1)!.path, `/api/screens/${A}/campaigns`);
  assert.equal(explained.envelope.data.screen_id, A);
  assert.deepEqual(explained.envelope.data.effective_playlist, { id: PLAYLIST, source: "campaign", entry_id: urgent.id });
  assert.deepEqual(explained.envelope.data.items.map((item: CampaignStatus) => [item.campaign_id, item.status, item.reason, item.by]), [
    [urgent.id, "playing", undefined, undefined],
    [paused.id, "paused", undefined, undefined],
    [elsewhere.id, "not_in_audience", undefined, undefined],
    [base.id, "outranked", "campaign", urgent.id],
  ]);

  const human = await cli(["--human", "campaign", "explain", A], transport, env);
  assert.match(human.stdout, new RegExp(`^Screen ${A} plays ${PLAYLIST} \\(campaign ${urgent.id}\\)$`, "m"));
  assert.match(human.stdout, /^Campaigns, in precedence order \(4\)$/m);
  assert.match(human.stdout, /^CAMPAIGN\s+STATUS\s+DETAIL$/m);
  assert.match(human.stdout, new RegExp(`^${urgent.id}\\s+playing$`, "m"));
  assert.match(human.stdout, new RegExp(`^${paused.id}\\s+paused\\s+the campaign is paused$`, "m"));
  assert.match(human.stdout, new RegExp(`^${elsewhere.id}\\s+not_in_audience\\s+the screen is not in the audience$`, "m"));
  assert.match(human.stdout, new RegExp(`^${base.id}\\s+outranked\\s+campaign ${urgent.id} wins$`, "m"));

  const blocked = await cli(["--human", "campaign", "explain", B], transport, env);
  assert.match(blocked.stdout, new RegExp(`^Screen ${B} plays no playlist$`, "m"));
  assert.match(blocked.stdout, new RegExp(`^${base.id}\\s+blocked\\s+the screen has no default playlist: screenrig screen assign ${B} --playlist-id PLAYLIST_ID$`, "m"));

  transport.putScreen!(screen(C, { tags: ["Lobby"], takeover: { playlist_id: OTHER_PLAYLIST, until: null, set_at: "2026-08-14T17:00:00.000Z" } }));
  const takeover = await cli(["--human", "campaign", "explain", C], transport, env);
  assert.match(takeover.stdout, new RegExp(`^Screen ${C} plays ${OTHER_PLAYLIST} \\(takeover until cleared\\)$`, "m"));
  assert.match(takeover.stdout, new RegExp(`^${base.id}\\s+outranked\\s+a screen takeover wins$`, "m"));

  const none = await cli(["--human", "campaign", "explain", "scr_DDDDDDDDDDDDDDDDDDDDDDDD"], transport, env);
  assert.equal(none.code, ExitCode.NotFound, none.stdout);
  const noneJson = await cli(["--json", "campaign", "explain", "scr_DDDDDDDDDDDDDDDDDDDDDDDD"], transport, env);
  assert.equal(noneJson.envelope.error?.next?.command, "screenrig screen list");
  for (const bad of ["cmp_AAAAAAAAAAAAAAAA", "screen", "scr_"]) {
    assert.equal((await cli(["--json", "campaign", "explain", bad], transport, env)).code, ExitCode.Usage, bad);
  }
  assert.equal((await cli(["--json", "campaign", "explain"], transport, env)).code, ExitCode.Usage);
});

test("campaign explain with no campaigns says so", async () => {
  const env = await enrolled();
  const transport = backend();
  transport.putScreen!(screen(A));
  const human = await cli(["--human", "campaign", "explain", A], transport, env);
  assert.match(human.stdout, new RegExp(`^Screen ${A} plays ${PLAYLIST} \\(default\\)$`, "m"));
  assert.match(human.stdout, /^No campaigns in this project$/m);
});

test("campaign explain --at asks about another time and shows a verdict per candidate", async () => {
  const env = await enrolled();
  const transport = backend();
  transport.putScreen!(screen(A, { tags: ["Lobby", "North"] }));
  transport.putScreen!(screen(B, { tags: ["Lobby"], timezone: undefined }));
  const base = await create(transport, env, "--tag", "Lobby");
  const urgent = await create(transport, env, "--tag", "North", "--priority", "40");
  const paused = await create(transport, env, "--all-screens", "--paused");

  const explained = await cli(["--json", "campaign", "explain", A, "--at", "2026-12-24T18:00", "--to", "2026-12-25T18:00"], transport, env);
  assert.equal(explained.code, 0, explained.stdout);
  const call = transport.calls.at(-1)!;
  assert.equal(call.path, `/api/screens/${A}/campaigns`);
  assert.deepEqual(call.query, { at: "2026-12-24T18:00", to: "2026-12-25T18:00" });
  const at = explained.envelope.data.at;
  assert.equal(at.local, "2026-12-24T18:00");
  assert.equal(at.timezone, "America/Los_Angeles");
  assert.deepEqual(at.effective_playlist, { id: PLAYLIST, source: "campaign", entry_id: urgent.id });
  assert.deepEqual(at.verdicts.map((item: ScreenVerdict) => [item.kind, item.id, item.verdict, item.reason, item.by]), [
    ["campaign", urgent.id, "won", undefined, undefined],
    ["campaign", paused.id, "off", "paused", undefined],
    ["campaign", base.id, "outranked", undefined, { kind: "campaign", id: urgent.id }],
  ]);
  assert.equal(at.timeline.length, 1);
  assert.equal(at.not_judged[0].code, "configuration_history");
  assert.equal(explained.envelope.data.items.length, 3, "items stay the state now");

  const human = await cli(["--human", "campaign", "explain", A, "--at", "2026-12-24T18:00"], transport, env);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, new RegExp(`^Screen ${A} at 2026-12-24 18:00 America/Los_Angeles \\(2026-12-24T18:00:00.000Z\\) plays ${PLAYLIST} \\(campaign ${urgent.id}\\)$`, "m"));
  assert.match(human.stdout, /^Takeover, campaigns and schedule entries, in the order the screen reads them$/m);
  assert.match(human.stdout, /^CANDIDATE\s+PLAYLIST\s+VERDICT\s+DETAIL$/m);
  assert.match(human.stdout, new RegExp(`^campaign ${urgent.id}\\s+${PLAYLIST}\\s+won$`, "m"));
  assert.match(human.stdout, new RegExp(`^campaign ${paused.id}\\s+${PLAYLIST}\\s+off\\s+the campaign is paused$`, "m"));
  assert.match(human.stdout, new RegExp(`^campaign ${base.id}\\s+${PLAYLIST}\\s+outranked\\s+campaign ${urgent.id} wins$`, "m"));
  assert.match(human.stdout, /^Not judged$/m);
  assert.doesNotMatch(human.stdout, /^Switches from/m);
  const withTimeline = await cli(["--human", "campaign", "explain", A, "--at", "2026-12-24T18:00:00-08:00", "--to", "2026-12-25T18:00:00-08:00"], transport, env);
  assert.deepEqual(transport.calls.at(-1)!.query, { at: "2026-12-24T18:00:00-08:00", to: "2026-12-25T18:00:00-08:00" });
  assert.match(withTimeline.stdout, /^Switches from 2026-12-24 18:00 America\/Los_Angeles to 2026-12-25 18:00 America\/Los_Angeles$/m);
  assert.match(withTimeline.stdout, /^FROM\s+TO\s+PLAYS$/m);

  // --to alone starts now; a plain explain sends no query and has no at block.
  await cli(["--json", "campaign", "explain", A, "--to", "2099-01-01T00:00:00Z"], transport, env);
  assert.deepEqual(transport.calls.at(-1)!.query, { to: "2099-01-01T00:00:00Z" });
  const plain = await cli(["--json", "campaign", "explain", A], transport, env);
  assert.equal(transport.calls.at(-1)!.query, undefined);
  assert.equal(plain.envelope.data.at, undefined);

  // The server's refusals reach the caller with the field named.
  const reversed = await cli(["--json", "campaign", "explain", A, "--at", "2026-12-24T18:00", "--to", "2026-12-24T17:00"], transport, env);
  assert.equal(reversed.code, ExitCode.Client, reversed.stdout);
  assert.equal(reversed.envelope.error?.errors?.[0]?.field, "to");
  const zoneless = await cli(["--json", "campaign", "explain", B, "--at", "2026-12-24T18:00"], transport, env);
  assert.equal(zoneless.code, ExitCode.Client, "a screen with no timezone cannot read a time on its clock");
  assert.equal(zoneless.envelope.error?.errors?.[0]?.field, "at");
  const exact = await cli(["--json", "campaign", "explain", B, "--at", "2026-12-24T18:00:00Z"], transport, env);
  assert.equal(exact.code, 0, exact.stdout);
  assert.equal(exact.envelope.data.at.local, undefined);
});

test("campaign explain checks --at and --to before any request", async () => {
  const env = await enrolled();
  const transport = backend();
  transport.putScreen!(screen(A));
  const before = transport.calls.length;
  for (const bad of ["tomorrow", "2026-12-24", "2026-12-24T18", "2026-12-24T25:00", "2026-02-30T10:00", "2026-12-24T18:00Z", "2026-12-24T18:00:00+25:00", "18:00"]) {
    for (const flag of ["--at", "--to"]) {
      assert.equal((await cli(["--json", "campaign", "explain", A, flag, bad], transport, env)).code, ExitCode.Usage, `${flag} ${bad}`);
    }
  }
  assert.equal(transport.calls.length, before);
  for (const good of ["2026-12-24T18:00", "2026-12-24T18:00:30", "2026-12-24T18:00:00Z", "2026-12-24T18:00:00.5Z", "2026-12-24T18:00:00-08:00"]) {
    assert.equal(campaignExplainTime("--at")(good), good);
  }
});

test("verdicts read as short details with the fix when the screen is known", () => {
  const verdict = (fields: Partial<ScreenVerdict>): ScreenVerdict => ({ kind: "campaign", id: "cmp_X", playlist_id: PLAYLIST, verdict: "won", ...fields });
  assert.equal(verdictDetail(verdict({}), A, "UTC"), "");
  assert.equal(verdictDetail(verdict({ verdict: "outranked", by: { kind: "takeover" } }), A, "UTC"), "the screen takeover wins");
  assert.equal(verdictDetail(verdict({ verdict: "outranked", by: { kind: "schedule", id: "office" } }), A, "UTC"), "schedule entry office wins");
  assert.equal(verdictDetail(verdict({ verdict: "not_started", next_start: "2026-12-24T18:00:00Z" }), A, "UTC"), "before its from; starts 2026-12-24 18:00 UTC");
  assert.equal(verdictDetail(verdict({ verdict: "outside_hours" }), A, "UTC"), "outside its windows; no start within eight days");
  assert.equal(verdictDetail(verdict({ kind: "takeover", verdict: "ended", until: "2026-12-24T18:00:00Z" }), A, "America/Los_Angeles"), "ended 2026-12-24 10:00 America/Los_Angeles");
  assert.equal(verdictDetail(verdict({ verdict: "ended" }), A, "UTC"), "until has passed");
  assert.equal(verdictDetail(verdict({ verdict: "off", reason: "no_timezone" }), A, "UTC"), `the screen has no timezone: screenrig screen set-timezone ${A} --timezone ZONE`);
  assert.equal(verdictDetail(verdict({ verdict: "off", reason: "playlist_unavailable" }), A, "UTC"), "the playlist is missing or unapproved");
});

test("campaign standings read as short details with the fix when the screen is known", () => {
  const status = (fields: Partial<CampaignStatus>): CampaignStatus => ({ campaign_id: "cmp_X", screen_id: A, status: "playing", ...fields });
  assert.equal(campaignStandingDetail(status({})), "");
  assert.equal(campaignStandingDetail(status({ status: "pending" })), "the switch lands within a minute");
  assert.equal(campaignStandingDetail(status({ status: "waiting", next_start: "2026-12-24T18:00:00Z" })), "outside from, until and windows now; starts 2026-12-24T18:00:00Z");
  assert.equal(campaignStandingDetail(status({ status: "waiting" })), "outside from, until and windows now; no start within eight days");
  assert.equal(campaignStandingDetail(status({ status: "ended" })), "until has passed");
  assert.equal(campaignStandingDetail(status({ status: "paused" })), "the campaign is paused");
  assert.equal(campaignStandingDetail(status({ status: "not_in_audience" })), "the screen is not in the audience");
  assert.equal(campaignStandingDetail(status({ status: "outranked", reason: "takeover" })), "a screen takeover wins");
  assert.equal(campaignStandingDetail(status({ status: "outranked", reason: "campaign", by: "cmp_Y" })), "campaign cmp_Y wins");
  assert.equal(campaignStandingDetail(status({ status: "blocked", reason: "playlist_unavailable" })), "the playlist is missing, unapproved or does not fit the screen");
  assert.equal(campaignStandingDetail(status({ status: "blocked", reason: "no_timezone" }), A), `the screen has no timezone: screenrig screen set-timezone ${A} --timezone ZONE`);
  assert.equal(campaignCountsText({ audience: 12, waiting: 2, playing: 8, blocked: 1, not_in_audience: 0, ended: 0 }), "8 playing, 2 waiting, 1 blocked");
  assert.equal(campaignCountsText({ audience: 0 }), "");
  assert.equal(campaignCountsText(undefined), "");
});

test("campaign writes surface the server's refusals with the next step", async () => {
  const env = await enrolled();
  const transport = backend();

  const unapproved = await cli(["--json", "campaign", "create", "--name", "Menu", "--playlist-id", UNAPPROVED, "--tag", "Lobby"], transport, env);
  assert.equal(unapproved.code, ExitCode.Conflict, unapproved.stdout);
  assert.equal(unapproved.envelope.error?.code, "playlist_not_approved");
  assert.equal(unapproved.envelope.error?.next?.command, "screenrig reviews list");
  const campaign = await create(transport, env);
  const swapped = await cli(["--json", "campaign", "update", campaign.id, "--playlist-id", UNAPPROVED], transport, env);
  assert.equal(swapped.envelope.error?.code, "playlist_not_approved");

  const unknown = await cli(["--json", "campaign", "create", "--name", "Menu", "--playlist-id", "pl_UNKNOWNAAAAAAAAAAAAAAAAA", "--tag", "Lobby"], transport, env);
  assert.equal(unknown.code, ExitCode.Client, unknown.stdout);
  assert.equal(unknown.envelope.error?.code, "invalid_request");
  assert.equal(unknown.envelope.error?.next?.command, "screenrig playlist list");

  // The server judges the members of a raw rule and names the field.
  const invalidRule = await cli(["--json", "campaign", "create", "--name", "Menu", "--playlist-id", PLAYLIST, "--audience", '{"tag":"not a tag"}'], transport, env);
  assert.equal(invalidRule.code, ExitCode.Client, invalidRule.stdout);
  assert.equal(invalidRule.envelope.error?.errors?.[0]?.field, "audience.tag");
  const wrongBounds = await cli(["--json", "campaign", "update", campaign.id, "--until", "2020-01-01T00:00", "--from", "2021-01-01T00:00"], transport, env);
  assert.equal(wrongBounds.code, ExitCode.Usage, "both bounds in one request are compared locally");
  const storedFrom = await cli(["--json", "campaign", "update", campaign.id, "--from", "2026-12-24T18:00"], transport, env);
  assert.equal(storedFrom.code, 0, storedFrom.stdout);
  const earlierUntil = await cli(["--json", "campaign", "update", campaign.id, "--until", "2026-12-01T00:00"], transport, env);
  assert.equal(earlierUntil.code, ExitCode.Client, "the server compares a lone bound with the stored one");
  assert.equal(earlierUntil.envelope.error?.errors?.[0]?.field, "until");
});

test("campaign create at the project limit names campaign delete", async () => {
  const env = await enrolled();
  const transport = backend();
  for (let index = 0; index < 100; index += 1) {
    const made = await transport.request({ method: "POST", path: "/api/campaigns", body: { name: `Campaign ${index}`, playlist_id: PLAYLIST, audience: { tag: "Lobby" } } });
    assert.equal(made.status, 201);
  }
  const limited = await cli(["--json", "campaign", "create", "--name", "One more", "--playlist-id", PLAYLIST, "--tag", "Lobby"], transport, env);
  assert.equal(limited.code, ExitCode.Conflict, limited.stdout);
  assert.equal(limited.envelope.error?.code, "campaign_limit_reached");
  assert.match(limited.envelope.error?.detail ?? "", /maximum of 100 campaigns\. Nothing was created\./);
  assert.equal(limited.envelope.error?.next?.command, "screenrig campaign list");
  assert.match(limited.envelope.error?.next?.reason ?? "", /campaign delete ID/);
});

test("an interrupted campaign create is replayed with its saved key and creates one campaign", async () => {
  const env = await enrolled();
  const transport = backend();
  let lose = true;
  const original = transport.request.bind(transport);
  transport.request = async (req) => {
    const response = await original(req);
    if (lose && req.method === "POST" && req.path === "/api/campaigns") {
      lose = false;
      throw networkError("connection reset after the request was sent");
    }
    return response;
  };
  const argv = ["--json", "campaign", "create", "--name", "Holiday hours", "--playlist-id", PLAYLIST, "--tag", "Lobby"];
  const lost = await cli(argv, transport, env);
  assert.equal(lost.code, ExitCode.Network, lost.stdout);
  assert.ok(lost.envelope.warnings?.some((warning) => warning.code === "write_recovery_saved"));
  assert.match(await readFile(env.configPath, "utf8"), /pending_writes/);

  const rerun = await cli(argv, transport, env);
  assert.equal(rerun.code, 0, rerun.stdout);
  const posts = campaignCalls(transport).filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.headers?.["idempotency-key"], posts[0]!.headers?.["idempotency-key"], "the rerun reuses the saved key");
  const listed = await cli(["--json", "campaign", "list"], transport, env);
  assert.equal(listed.envelope.data.items.length, 1, "the replay did not create a second campaign");
  assert.equal(listed.envelope.data.items[0].id, rerun.envelope.data.id);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);

  const reused = await cli(["--json", "--idempotency-key", "campaign-key-0001", "campaign", "create", "--name", "First", "--playlist-id", PLAYLIST, "--all-screens"], transport, env);
  assert.equal(reused.code, 0, reused.stdout);
  const mismatch = await cli(["--json", "--idempotency-key", "campaign-key-0001", "campaign", "create", "--name", "Second", "--playlist-id", PLAYLIST, "--all-screens"], transport, env);
  assert.equal(mismatch.code, ExitCode.Conflict, mismatch.stdout);
  assert.equal(mismatch.envelope.error?.code, "idempotency_mismatch");
});

test("screen show and list name the campaign that decides what a screen plays", async () => {
  const env = await enrolled();
  const transport = backend();
  transport.putScreen!(screen(A, { effective_playlist: { id: OTHER_PLAYLIST, source: "campaign", entry_id: "cmp_HOLIDAYAAAAAAAAA", until: "2026-12-24T18:00:00Z" } }));
  const shown = await cli(["--human", "screen", "show", A], transport, env);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`^Assigned: ${OTHER_PLAYLIST} \\(campaign cmp_HOLIDAYAAAAAAAAA until 2026-12-24 10:00 America/Los_Angeles\\)$`, "m"));
  const listed = await cli(["--human", "screen", "list"], transport, env);
  assert.match(listed.stdout, /^ID\s+LABEL\s+STATE\s+ASSIGNED$/m);
  assert.match(listed.stdout, new RegExp(`^${A}\\s+Screen A\\s+active\\s+${OTHER_PLAYLIST} \\(campaign cmp_HOLIDAYAAAAAAAAA until 2026-12-24 10:00 America/Los_Angeles\\)$`, "m"));
});

test("campaign help names the audience flags, the screens it schedules and how to recover", () => {
  const root = commandHelp();
  const group = root.commands.find((command) => command.name === "campaign")!;
  assert.match(group.summary, /Schedule your screens; ads campaigns buy ad time on other screens/);
  assert.ok(group.summary.length <= 69, "the root listing keeps the summary on one line");
  assert.deepEqual(commandHelp(["campaign"]).commands.map((command) => command.name), ["list", "show", "create", "update", "pause", "resume", "delete", "screens", "explain"]);
  assert.match(commandHelp(["campaign"]).usage, /It schedules your own screens: ads campaigns\s+buy ad time on other screens/);

  const create = commandHelp(["campaign", "create"]);
  assert.deepEqual(create.relationships, [{ kind: "exactlyOne", options: ["--tag", "--any-tag", "--screen-id", "--all-screens", "--audience"] }]);
  assert.match(create.usage, /Switches every screen in the audience to --playlist-id while the campaign holds, and back when it stops, within a minute\./);
  assert.match(create.usage, /campaign screens ID lists every screen's standing and campaign explain SCREEN_ID says why/);
  assert.match(create.usage, /DAYS or DAYS@HH:MM-HH:MM/);
  assert.match(create.options.find((option) => option.name === "--audience")!.description, /for stdin/);
  assert.deepEqual(create.options.find((option) => option.name === "--tag")!.conflicts, ["--any-tag", "--screen-id", "--all-screens", "--audience"]);
  for (const name of ["--name", "--playlist-id"]) assert.equal(create.options.find((option) => option.name === name)!.required, true, name);

  const update = commandHelp(["campaign", "update"]);
  assert.deepEqual(update.relationships.map((relationship) => relationship.kind), ["atLeastOne", "atMostOne"]);
  assert.deepEqual(update.relationships[1]!.options, ["--tag", "--any-tag", "--screen-id", "--all-screens", "--audience"]);
  assert.deepEqual(update.options.find((option) => option.name === "--clear-from")!.conflicts, ["--from"]);
  assert.deepEqual(update.options.find((option) => option.name === "--window")!.conflicts, ["--clear-windows"]);
  for (const action of ["update", "pause", "resume", "delete"]) {
    const option = commandHelp(["campaign", action]).options.find((item) => item.name === "--expect-rev");
    assert.deepEqual(option?.aliases, ["--if-match"], action);
  }
  assert.match(commandHelp(["campaign", "screens"]).usage, /pass data\.next_cursor back as --cursor/);
  assert.match(commandHelp(["campaign", "explain"]).usage, /Read only\./);
  const explain = commandHelp(["campaign", "explain"]);
  assert.deepEqual(explain.options.filter((option) => option.name === "--at" || option.name === "--to").map((option) => option.name), ["--at", "--to"]);
  assert.match(explain.usage, /--at TIME asks what the screen shows at another time/);
  assert.match(explain.usage, /won \(the one shown\), outranked/);
  assert.match(commandHelp(["campaign", "pause"]).usage, /within a minute/);
  assert.match(commandHelp(["campaign", "delete"]).usage, /within a minute/);

  const everything = JSON.stringify([commandHelp(["campaign"]), ...["list", "show", "create", "update", "pause", "resume", "delete", "screens", "explain"].map((action) => commandHelp(["campaign", action]))]);
  assert.doesNotMatch(everything, /\b(beta|coming soon|not yet|planned|in development|not available yet|experimental)\b/i);
  assert.doesNotMatch(everything, /localhost|MCP|\/home\//);
});
