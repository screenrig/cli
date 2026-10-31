import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { CampaignPatch, CampaignRevision, SchedulePreview, ScheduleCalendar, ScreenScheduleRevision } from "./adapters/protocol.js";
import { calendarInstantOption, campaignRevisionLines, schedulePreviewLines, screenScheduleRevisionLines } from "./change-control.js";
import { verdictDetail } from "./campaigns.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help-tree.js";
import { run, type CliRuntime } from "./main.js";
import { scheduleEntries, scheduleTableLines } from "./screen-control.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const PLAYLIST = "pl_CAMPAIGNAAAAAAAAAAAAAAAA";
const A = "scr_AAAAAAAAAAAAAAAAAAAAAAAA";
const B = "scr_BBBBBBBBBBBBBBBBBBBBBBBB";
const FOLDER = "sfd_AAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = new Date("2026-08-14T17:00:00.000Z");

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
  const configDir = await testTemp("change-cfg-");
  const cwd = await testTemp("change-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  const err = await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human */ }
  return { code, stdout: text, stderr: err, envelope };
}

const last = (transport: FakeTransport): TransportRequest => transport.calls.at(-1)!;
const json = (status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse => ({ status, headers: { "content-type": "application/json", ...headers }, body });
const problem = (status: number, code: string, detail: string): TransportResponse => ({ status, headers: { "content-type": "application/problem+json" }, body: { status, code, title: code, detail } });

function backend(): FakeTransport {
  const transport = memoryBackend({ now: () => NOW });
  transport.putPlaylist!({ id: PLAYLIST });
  return transport;
}

async function draft(transport: FakeTransport, env: Env): Promise<{ id: string; revision: number }> {
  const created = await cli(["--json", "campaign", "create", "--name", "Holiday hours", "--playlist-id", PLAYLIST, "--tag", "Lobby", "--paused"], transport, env);
  assert.equal(created.code, 0, created.stdout);
  return created.envelope.data;
}

const calendar = (overrides: Partial<ScheduleCalendar> = {}): ScheduleCalendar => ({
  from: "2026-08-14T17:00:00Z", to: "2026-08-21T17:00:00Z", screens: 2,
  groups: [{
    key: "g1", screens: 2, screen_ids: [A, B], timezone: "America/Los_Angeles", displays: 1,
    levels: [{ id: "campaign:cmp_ONE", source: "campaign", playlist_id: "pl_ONE" }], conflicts: [],
    spans: [], on_screen: [{ display: 1, from: "2026-08-14T17:00:00Z", to: "2026-08-15T17:00:00Z", level_id: "campaign:cmp_ONE" }],
  }],
  ...overrides,
});

test("schedule entries take paused, refuse a non-boolean, and the table marks drafts", () => {
  const entries = scheduleEntries({ entries: [
    { id: "live", playlist_id: "pl_A", windows: [{ days: ["mon"] }] },
    { id: "wip", playlist_id: "pl_B", windows: [{ days: ["tue"] }], paused: true },
  ] });
  assert.deepEqual(entries.map((item) => item.paused), [undefined, true]);
  assert.throws(() => scheduleEntries({ entries: [{ playlist_id: "pl_A", windows: [{ days: ["mon"] }], paused: "yes" }] }), /paused must be true \(a draft\) or false/);
  const lines = scheduleTableLines(entries.map((item, index) => ({ ...item, id: item.id ?? `e${index}` })));
  assert.match(lines.join("\n"), /^wip\s+pl_B\s+.*draft \(paused\)$/m);
  assert.match(lines.join("\n"), /^live\s+pl_A\s+.*$/m);
});

test("screen schedule set sends paused and screen schedule show marks the draft", async () => {
  const env = await enrolled();
  const transport = backend();
  await cli(["--json", "screen", "set-timezone", A, "--timezone", "America/Los_Angeles"], transport, env);
  await transport.request({ method: "PUT", path: "/api/playlists/pl_DEFAULT", body: { name: "Default", pages: [] } });
  await cli(["--json", "screen", "update", A, "--playlist-id", "pl_DEFAULT"], transport, env);
  await writeFile(path.join(env.cwd, "s.json"), JSON.stringify({ entries: [{ id: "wip", playlist_id: "pl_DEFAULT", windows: [{ days: ["mon"] }], paused: true }] }));
  const set = await cli(["--json", "screen", "schedule", "set", A, "--file", "s.json"], transport, env);
  assert.equal(set.code, 0, set.stdout);
  assert.deepEqual((last(transport).body as { entries: Array<{ paused?: boolean }> }).entries[0]!.paused, true);
  const shown = await cli(["--human", "screen", "schedule", "show", A], transport, env);
  assert.match(shown.stdout, /^wip\s+pl_DEFAULT\s+.*draft \(paused\)$/m);
  const screen = await cli(["--human", "screen", "show", A], transport, env);
  assert.match(screen.stdout, new RegExp(`^Playlist schedule: 1 entry, 1 draft \\(screen schedule show ${A}\\)$`, "m"));
});

test("campaign publish unpauses, and a test option replaces the audience in the same write", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await draft(transport, env);

  const folder = await cli(["--json", "campaign", "publish", campaign.id, "--test-folder", FOLDER, "--expect-rev", "1"], transport, env);
  assert.equal(folder.code, 0, folder.stdout);
  assert.equal(last(transport).method, "PATCH");
  assert.deepEqual(last(transport).body, { paused: false, audience: { folder: FOLDER } });
  assert.equal(last(transport).headers?.["if-match"], '"1"');
  assert.ok(last(transport).headers?.["idempotency-key"]);
  assert.equal(folder.envelope.data.paused, false);

  await cli(["--json", "campaign", "pause", campaign.id], transport, env);
  const screens = await cli(["--human", "campaign", "publish", campaign.id, "--test-screen", `${A},${B}`], transport, env);
  assert.equal(screens.code, 0, screens.stderr);
  assert.deepEqual(last(transport).body, { paused: false, audience: { any: [{ screen_id: A }, { screen_id: B }] } });
  assert.match(screens.stdout, /^Published campaign cmp_\S+ to a test audience\. Only the screens named here switch to the playlist within a minute; screenrig campaign revisions cmp_\S+ lists the draft/m);

  await cli(["--json", "campaign", "pause", campaign.id], transport, env);
  const plain = await cli(["--human", "campaign", "publish", campaign.id], transport, env);
  assert.deepEqual(last(transport).body, { paused: false });
  assert.match(plain.stdout, /^Published campaign cmp_\S+\. Screens in its audience switch to the playlist within a minute while it holds;/m);

  const both = await cli(["--json", "campaign", "publish", campaign.id, "--test-folder", FOLDER, "--test-screen", A], transport, env);
  assert.equal(both.code, ExitCode.Usage, both.stdout);
  const stale = await cli(["--json", "campaign", "publish", campaign.id, "--expect-rev", "99"], transport, env);
  assert.equal(stale.envelope.error?.code, "revision_conflict");
  assert.equal(stale.envelope.error?.next?.command, `screenrig campaign show ${campaign.id}`);
});

test("campaign promote sends the revision, reads the current revision when --expect-rev is absent, and names the revisions list on a refusal", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await draft(transport, env);
  await cli(["--json", "campaign", "publish", campaign.id, "--test-folder", FOLDER], transport, env);
  transport.on("POST", /^\/api\/campaigns\/[^/]+\/promote$/, (req) => {
    const body = req.body as { revision: number };
    if (body.revision === 2) return problem(400, "invalid_request", "revision: 2 was not paused, so it is not a draft.");
    return json(200, { id: campaign.id, revision: body.revision === 1 && req.headers?.["if-match"] === '"2"' ? 3 : 2, paused: false });
  });

  const promoted = await cli(["--human", "campaign", "promote", campaign.id, "--revision", "1"], transport, env);
  assert.equal(promoted.code, 0, promoted.stderr);
  const calls = transport.calls.filter((call) => call.path.startsWith(`/api/campaigns/${campaign.id}`));
  assert.deepEqual(calls.slice(-2).map((call) => `${call.method} ${call.path}`), [`GET /api/campaigns/${campaign.id}`, `POST /api/campaigns/${campaign.id}/promote`]);
  assert.deepEqual(last(transport).body, { revision: 1 });
  assert.equal(last(transport).headers?.["if-match"], '"2"', "the revision read just before the write");
  assert.ok(last(transport).headers?.["idempotency-key"]);
  assert.match(promoted.stdout, /^Promoted revision 1 of campaign cmp_\S+: its audience is now the campaign's\./m);

  const guarded = await cli(["--json", "campaign", "promote", campaign.id, "--revision", "1", "--expect-rev", "2"], transport, env);
  assert.equal(guarded.code, 0, guarded.stdout);
  assert.equal(last(transport).method, "POST", "an explicit --expect-rev reads nothing first");
  assert.equal(last(transport).headers?.["if-match"], '"2"');

  const unchanged = await cli(["--human", "campaign", "promote", campaign.id, "--revision", "5", "--expect-rev", "2"], transport, env);
  assert.equal(unchanged.code, 0, unchanged.stderr);
  assert.match(unchanged.stdout, /^Revision 5 holds the audience campaign cmp_\S+ already has; nothing changed\.$/m);
  const refused = await cli(["--json", "campaign", "promote", campaign.id, "--revision", "2", "--expect-rev", "2"], transport, env);
  assert.equal(refused.envelope.error?.code, "invalid_request");
  assert.equal(refused.envelope.error?.next?.command, `screenrig campaign revisions ${campaign.id}`);

  const missing = await cli(["--json", "campaign", "promote", campaign.id], transport, env);
  assert.equal(missing.code, ExitCode.Usage, "--revision is required");
  const bad = await cli(["--json", "campaign", "promote", campaign.id, "--revision", "0"], transport, env);
  assert.equal(bad.code, ExitCode.Usage);
});

test("campaign restore copies a revision forward with the revision guard", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await draft(transport, env);
  // Revision 9 holds what the campaign has already, so the write answers the revision it was guarded with.
  transport.on("POST", /^\/api\/campaigns\/[^/]+\/revisions\/\d+\/restore$/, (req) => req.path.includes(campaign.id) ? json(200, { id: campaign.id, revision: req.path.includes("/9/") ? 1 : 2 }) : problem(404, "not_found", "The campaign was not found in this project."));

  const restored = await cli(["--human", "campaign", "restore", campaign.id, "--revision", "1", "--expect-rev", "1"], transport, env);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(last(transport).method, "POST");
  assert.equal(last(transport).path, `/api/campaigns/${campaign.id}/revisions/1/restore`);
  assert.equal(last(transport).headers?.["if-match"], '"1"');
  assert.equal(last(transport).body, undefined);
  assert.match(restored.stdout, /^Restored revision 1 of campaign cmp_\S+ as a new revision\./m);

  const read = await cli(["--human", "campaign", "restore", campaign.id, "--revision", "9"], transport, env);
  assert.equal(read.code, 0, read.stderr);
  assert.equal(transport.calls.at(-2)!.method, "GET", "the current revision is read just before the write");
  assert.match(read.stdout, /^Revision 9 holds the content campaign cmp_\S+ already has; nothing changed\.$/m);
  const missing = await cli(["--json", "campaign", "restore", MISSING_ID, "--revision", "1", "--expect-rev", "1"], transport, env);
  assert.equal(missing.envelope.error?.code, "not_found");
  assert.equal(missing.envelope.error?.next?.command, "screenrig campaign list");
});

const MISSING_ID = "cmp_MISSINGAAAAAAAAA";

test("campaign revisions lists one page, pages with --after, and says when a campaign is still a draft", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await draft(transport, env);
  const items = [{ revision: 2, created_at: "2026-08-14T17:00:30Z", change: "edited", current: true, author: { type: "agent", name: "Signage agent" }, campaign: { id: campaign.id, name: "Holiday hours", playlist_id: PLAYLIST, paused: true } },
    { revision: 1, created_at: "2026-08-14T17:00:00Z", change: "created", current: false, campaign: { id: campaign.id, name: "Holiday hours", playlist_id: PLAYLIST, paused: true } }];
  transport.on("GET", /^\/api\/campaigns\/[^/]+\/revisions$/, (req) => json(200, req.query?.after === "CUR" ? { items: items.slice(1), next_cursor: null } : { items: items.slice(0, 1), next_cursor: "CUR" }));

  const first = await cli(["--human", "campaign", "revisions", campaign.id], transport, env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^Campaign cmp_\S+ revisions \(1\)$/m);
  assert.match(first.stdout, /^2 \(current\)\s+edited\s+paused\s+2026-08-14T17:00:30Z\s+Signage agent \(agent\)\s+Holiday hours\s+pl_CAMPAIGN/m);
  assert.match(first.stdout, new RegExp(`^next: screenrig campaign revisions ${campaign.id} --after CUR$`, "m"));
  assert.doesNotMatch(first.stdout, /is a draft/, "only the last page can say no revision was published");

  const second = await cli(["--human", "campaign", "revisions", campaign.id, "--after", "CUR"], transport, env);
  assert.deepEqual(last(transport).query, { after: "CUR" });
  assert.match(second.stdout, /No revision has been published: this campaign is a draft\./);
  const raw = await cli(["--json", "campaign", "revisions", campaign.id], transport, env);
  assert.equal(raw.envelope.data.next_cursor, "CUR");
});

test("campaign preview of a new campaign reads the create flags and prints who gains and loses it", async () => {
  const env = await enrolled();
  const transport = backend();
  const preview: SchedulePreview = { gained: { count: 2, screen_ids: [A, B] }, lost: { count: 0, screen_ids: [] }, calendar: { before: calendar({ groups: [] }), after: calendar() } };
  transport.on("POST", "/api/campaigns/preview", () => json(200, preview));
  const result = await cli(["--human", "campaign", "preview", "--name", "Holiday hours", "--playlist-id", PLAYLIST, "--tag", "Lobby", "--paused", "--calendar-from", "2026-12-01T00:00:00Z", "--calendar-to", "2027-01-01T00:00:00Z"], transport, env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(last(transport).method, "POST");
  assert.equal(last(transport).path, "/api/campaigns/preview");
  assert.deepEqual(last(transport).body, { body: { name: "Holiday hours", playlist_id: PLAYLIST, audience: { tag: "Lobby" }, paused: true }, from: "2026-12-01T00:00:00Z", to: "2027-01-01T00:00:00Z" });
  assert.equal(last(transport).headers?.["idempotency-key"], undefined, "a preview writes nothing, so it needs no key");
  assert.match(result.stdout, /^Preview of a new campaign\. Nothing was changed\.$/m);
  assert.match(result.stdout, new RegExp(`^Gains 2 screens: ${A}, ${B}$`, "m"));
  assert.match(result.stdout, /^Loses no screens$/m);
  assert.match(result.stdout, /^Before$/m);
  assert.match(result.stdout, /^After$/m);
  assert.match(result.stdout, /2026-08-14 10:00 → 2026-08-15 10:00  campaign:cmp_ONE \(pl_ONE\)$/m);
  const raw = await cli(["--json", "campaign", "preview", "--name", "Holiday hours", "--playlist-id", PLAYLIST, "--tag", "Lobby"], transport, env);
  assert.deepEqual(raw.envelope.data, preview);
});

test("campaign preview of a change reads the update flags, --publish and --paused", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await draft(transport, env);
  const same = calendar();
  transport.on("POST", "/api/campaigns/preview", () => json(200, { gained: { count: 0, screen_ids: [] }, lost: { count: 1, screen_ids: [B] }, calendar: { before: same, after: same } }));

  const publish = await cli(["--human", "campaign", "preview", campaign.id, "--publish", "--folder", FOLDER, "--priority", "5", "--clear-until"], transport, env);
  assert.equal(publish.code, 0, publish.stderr);
  assert.deepEqual(last(transport).body, { id: campaign.id, body: { audience: { folder: FOLDER }, until: null, priority: 5, paused: false } });
  assert.match(publish.stdout, new RegExp(`^Preview of the change to campaign ${campaign.id}\\. Nothing was changed\\.$`, "m"));
  assert.match(publish.stdout, /^Gains no screens$/m);
  assert.match(publish.stdout, new RegExp(`^Loses 1 screen: ${B}$`, "m"));
  assert.match(publish.stdout, /^Calendar 2026-08-14T17:00:00Z to 2026-08-21T17:00:00Z: no change$/m);

  await cli(["--json", "campaign", "preview", campaign.id, "--paused"], transport, env);
  assert.deepEqual(last(transport).body, { id: campaign.id, body: { paused: true } });
});

for (const [flag, values, patch] of [
  ["window", ["mon@09:00-10:00", "fri@17:00-18:00"], { windows: [{ days: ["mon"], start: "09:00", end: "10:00" }, { days: ["fri"], start: "17:00", end: "18:00" }] }],
  ["monthly", ["15", "last-sun@09:00-14:00"], { monthly: [{ day: 15 }, { nth: -1, weekday: "sun", start: "09:00", end: "14:00" }] }],
  ["date", ["2026-12-24", "2026-12-31@18:00-22:00"], { dates: [{ date: "2026-12-24" }, { date: "2026-12-31", start: "18:00", end: "22:00" }] }],
  ["except", ["2026-12-26", "2026-12-25"], { except: ["2026-12-25", "2026-12-26"] }],
  ["tag", ["North", "Cafe"], { audience: { all: [{ tag: "North" }, { tag: "Cafe" }] } }],
  ["any-tag", ["North", "Cafe"], { audience: { any: [{ tag: "North" }, { tag: "Cafe" }] } }],
  ["screen-id", [A, B], { audience: { any: [{ screen_id: A }, { screen_id: B }] } }],
] satisfies Array<[string, string[], CampaignPatch]>) {
  for (const existing of [false, true]) {
    test(`campaign preview of ${existing ? "a change" : "a new campaign"} accumulates repeated --${flag} without writing`, async () => {
      const env = await enrolled();
      const transport = backend();
      const id = existing ? (await draft(transport, env)).id : undefined;
      const same = calendar();
      transport.on("POST", "/api/campaigns/preview", () => json(200, { gained: { count: 0, screen_ids: [] }, lost: { count: 0, screen_ids: [] }, calendar: { before: same, after: same } }));
      const target = id !== undefined ? [id] : ["--name", "Holiday hours", "--playlist-id", PLAYLIST, ...(patch.audience ? [] : ["--tag", "Lobby"])];
      const before = transport.calls.length;
      const result = await cli(["--json", "campaign", "preview", ...target, ...values.flatMap((value) => [`--${flag}`, value])], transport, env);
      assert.equal(result.code, ExitCode.Success, result.stdout);
      assert.equal(transport.calls.length, before + 1, "only the preview was requested");
      const request = last(transport);
      assert.equal(request.method, "POST");
      assert.equal(request.path, "/api/campaigns/preview");
      assert.deepEqual(request.body, id !== undefined
        ? { id, body: patch }
        : { body: { name: "Holiday hours", playlist_id: PLAYLIST, audience: { tag: "Lobby" }, ...patch } });
      assert.equal(request.headers?.["idempotency-key"], undefined, "preview never writes a campaign");
    });
  }
}

test("campaign preview sends data conditions and explicit clears without writing a campaign", async () => {
  const env = await enrolled();
  const transport = backend();
  const campaign = await draft(transport, env);
  const same = calendar();
  transport.on("POST", "/api/campaigns/preview", () => json(200, { gained: { count: 0, screen_ids: [] }, lost: { count: 0, screen_ids: [] }, calendar: { before: same, after: same } }));
  const before = transport.calls.length;
  const created = await cli(["--json", "campaign", "preview", "--name", "Room", "--playlist-id", PLAYLIST, "--folder", FOLDER, "--data", "crd_ROOM"], transport, env);
  assert.equal(created.code, 0, created.stdout);
  assert.deepEqual(last(transport).body, { body: { name: "Room", playlist_id: PLAYLIST, audience: { folder: FOLDER }, data: { key: "crd_ROOM" } } });
  const changed = await cli(["--json", "campaign", "preview", campaign.id, "--data", "crd_ROOM:/available=true"], transport, env);
  assert.equal(changed.code, 0, changed.stdout);
  assert.deepEqual(last(transport).body, { id: campaign.id, body: { data: { key: "crd_ROOM", path: "/available", equals: true } } });
  const cleared = await cli(["--json", "campaign", "preview", campaign.id, "--clear-data"], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  assert.deepEqual(last(transport).body, { id: campaign.id, body: { data: null } });
  assert.ok(transport.calls.slice(before).every((call) => call.method === "POST" && call.path === "/api/campaigns/preview"));
});

test("campaign preview refuses bad input before any request", async () => {
  const env = await enrolled();
  const transport = backend();
  const before = transport.calls.length;
  const cases: Array<[string[], RegExp]> = [
    [["campaign", "preview", "--name", "X", "--playlist-id", PLAYLIST], /takes exactly one of --tag/],
    [["campaign", "preview", "--tag", "Lobby"], /name|Provide/i],
    [["campaign", "preview", "cmp_ONEAAAAAAAAAAAAA"], /requires at least one change to preview/],
    [["campaign", "preview", "--name", "X", "--playlist-id", PLAYLIST, "--tag", "Lobby", "--publish"], /previews a new campaign; --publish changes an existing one/],
    [["campaign", "preview", "--name", "X", "--playlist-id", PLAYLIST, "--tag", "Lobby", "--clear-from"], /previews a new campaign; --clear-from changes an existing one/],
    [["campaign", "preview", "--name", "X", "--playlist-id", PLAYLIST, "--tag", "Lobby", "--clear-data"], /previews a new campaign; --clear-data changes an existing one/],
    [["campaign", "preview", "cmp_ONEAAAAAAAAAAAAA", "--paused", "--publish"], /cannot be used with|conflict/i],
    [["campaign", "preview", "cmp_ONEAAAAAAAAAAAAA", "--tag", "A", "--folder", FOLDER], /at most one|cannot be used with/i],
    [["campaign", "preview", "cmp_ONEAAAAAAAAAAAAA", "--priority", "1", "--priority", "2"], /--priority may be supplied only once/],
    [["campaign", "preview", "cmp_ONEAAAAAAAAAAAAA", "--tag", "North", "--tag", "Cafe", "--folder", FOLDER], /at most one|cannot be used with/i],
    [["campaign", "preview", "cmp_ONEAAAAAAAAAAAAA", "--window", "mon@09:00-10:00", "--window", "fri@17:00-18:00", "--clear-windows"], /cannot be used with|conflict/i],
    [["campaign", "preview", "cmp_ONEAAAAAAAAAAAAA", ...Array.from({ length: 17 }, () => ["--window", "mon@09:00-10:00"]).flat()], /--window accepts at most 16/],
    [["campaign", "preview", "cmp_ONEAAAAAAAAAAAAA", "--paused", "--calendar-from", "2026-12-01"], /--calendar-from takes an instant with a zone/],
  ];
  for (const [argv, message] of cases) {
    const refused = await cli(["--json", ...argv], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${argv.join(" ")}: ${refused.stdout}`);
    assert.match(`${refused.envelope.error?.detail}`, message, argv.join(" "));
  }
  assert.equal(transport.calls.length, before, "nothing was requested");
});

test("calendar instants need a zone", () => {
  const parse = calendarInstantOption("--calendar-to");
  assert.equal(parse("2026-12-01T00:00:00Z"), "2026-12-01T00:00:00Z");
  assert.equal(parse("2026-12-01T00:00:00-05:00"), "2026-12-01T00:00:00-05:00");
  for (const bad of ["2026-12-01", "2026-12-01T00:00", "tomorrow", "2026-13-45T00:00:00Z"]) assert.throws(() => parse(bad), /takes an instant with a zone/, bad);
});

test("revision pages read as tables with authors, restores and the next page", () => {
  const campaigns = campaignRevisionLines("cmp_X", { items: [
    { revision: 4, created_at: "t4", change: "promoted", restored_from: 1, current: true, author: { type: "person", name: "Ada" }, campaign: { name: "N", playlist_id: "pl_P", paused: false } },
    { revision: 3, created_at: "t3", change: "edited", current: false, campaign: { name: "N", playlist_id: "pl_P", paused: true } },
  ] as CampaignRevision[], next_cursor: "NEXT" });
  assert.match(campaigns.join("\n"), /^4 \(current\)\s+promoted from 1\s+live\s+t4\s+Ada \(person\)\s+N\s+pl_P$/m);
  assert.match(campaigns.join("\n"), /^3\s+edited\s+paused\s+t3\s+—\s+N\s+pl_P$/m);
  assert.equal(campaigns.at(-1), "next: screenrig campaign revisions cmp_X --after NEXT");
  assert.deepEqual(campaignRevisionLines("cmp_X", { items: [] }), ["Campaign cmp_X revisions (0)", "No revisions"]);

  const schedules = screenScheduleRevisionLines("scr_X", { items: [
    { revision: 7, created_at: "t7", change: "restored", restored_from: 5, current: true, entries: [{ id: "a", playlist_id: "pl_A" }, { id: "b", playlist_id: "pl_B", paused: true }] },
    { revision: 5, created_at: "t5", change: "baseline", current: false, entries: [] },
  ] as ScreenScheduleRevision[], next_cursor: null });
  assert.match(schedules.join("\n"), /^7 \(current\)\s+restored from 5\s+2\s+1\s+t7\s+—$/m);
  assert.match(schedules.join("\n"), /^5\s+baseline\s+0\s+0\s+t5\s+—$/m);
  assert.doesNotMatch(schedules.join("\n"), /next:/);
});

test("a preview prints a long reach compactly, groups by zone and shows drafts", () => {
  const ids = Array.from({ length: 30 }, (_, index) => `scr_${String(index).padStart(24, "A")}`);
  const after = calendar({ groups: [{ ...calendar().groups[0]!, spans: [{ from: "2026-08-16T17:00:00Z", to: "2026-08-17T17:00:00Z", level_id: "schedule:wip", state: "paused" }], paused_levels: [{ id: "schedule:wip", source: "schedule", playlist_id: "pl_WIP" }] }] });
  const text = schedulePreviewLines("a 2-entry playlist schedule on scr_A", { gained: { count: 30, screen_ids: ids }, lost: { count: 0, screen_ids: [] }, calendar: { before: calendar(), after } }).join("\n");
  assert.match(text, /^Preview of a 2-entry playlist schedule on scr_A\. Nothing was changed\.$/m);
  assert.match(text, /^Gains 30 screens: .* and 20 more \(the JSON lists up to 30 ids\)$/m);
  assert.match(text, /^  2 screens, America\/Los_Angeles$/m);
  assert.match(text, /^    2026-08-16 10:00 → 2026-08-17 10:00  draft schedule:wip \(pl_WIP\)$/m);
});

test("screen schedule revisions and restore use the schedule history routes", async () => {
  const env = await enrolled();
  const transport = new FakeTransport();
  const rows = [{ revision: 6, created_at: "2026-08-14T17:00:00Z", change: "edited", current: true, entries: [{ id: "a", playlist_id: "pl_A", paused: true }] }];
  transport.on("GET", `/api/screens/${A}/playlist-schedule/revisions`, () => json(200, { items: rows, next_cursor: null }));
  transport.on("GET", `/api/screens/${A}`, () => json(200, { id: A, revision: 6 }));
  transport.on("POST", `/api/screens/${A}/playlist-schedule/revisions/4/restore`, (req) => json(200, { id: A, revision: req.headers?.["if-match"] === '"6"' ? 7 : Number(req.headers?.["if-match"]?.replaceAll('"', "")), timezone: "UTC" }));

  const listed = await cli(["--human", "screen", "schedule", "revisions", A, "--after", "X"], transport, env);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(last(transport).path, `/api/screens/${A}/playlist-schedule/revisions`);
  assert.deepEqual(last(transport).query, { after: "X" });
  assert.match(listed.stdout, /^6 \(current\)\s+edited\s+1\s+1\s+2026-08-14T17:00:00Z\s+—$/m);

  const restored = await cli(["--human", "screen", "schedule", "restore", A, "--revision", "4", "--note", "Back to the holiday plan"], transport, env);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(last(transport).method, "POST");
  assert.equal(last(transport).headers?.["if-match"], '"6"', "read from the screen just before the write");
  assert.ok(last(transport).headers?.["idempotency-key"]);
  assert.match(decodeURIComponent(String(Object.entries(last(transport).headers ?? {}).find(([name]) => /note/i.test(name))?.[1])), /Back to the holiday plan/);
  assert.match(restored.stdout, new RegExp(`^Restored revision 4 of the playlist schedule on ${A}$`, "m"));
  assert.equal(transport.calls.filter((call) => call.path === `/api/screens/${A}` && call.method === "GET").length, 1);

  const guarded = await cli(["--json", "screen", "schedule", "restore", A, "--revision", "4", "--expect-rev", "6"], transport, env);
  assert.equal(guarded.code, 0, guarded.stdout);
  assert.equal(transport.calls.filter((call) => call.path === `/api/screens/${A}` && call.method === "GET").length, 1, "--expect-rev reads nothing");
  const unchanged = await cli(["--human", "screen", "schedule", "restore", A, "--revision", "4", "--expect-rev", "7"], transport, env);
  assert.match(unchanged.stdout, /; it already held that content, so nothing changed$/m);
  assert.equal((await cli(["--json", "screen", "schedule", "restore", A], transport, env)).code, ExitCode.Usage, "--revision is required");
});

test("screen schedule restore under Propose access answers pending_review", async () => {
  const env = await enrolled();
  const transport = new FakeTransport();
  transport.on("POST", `/api/screens/${A}/playlist-schedule/revisions/3/restore`, () => json(202, {
    status: "pending_review",
    review: { id: "rvw_AAAAAAAAAAAAAAAAAAAAAAAA", kind: "screen_change", state: "pending", url: "https://screenrig.ai/dashboard/reviews/rvw_AAAAAAAAAAAAAAAAAAAAAAAA", subject: { type: "screen", id: A, name: "Lobby" }, impact: { screens: 1 } },
  }));
  const pending = await cli(["--json", "screen", "schedule", "restore", A, "--revision", "3", "--expect-rev", "2"], transport, env);
  assert.equal(pending.code, 0, pending.stdout);
  assert.equal(pending.envelope.data.status, "pending_review");
  assert.equal(pending.envelope.warnings?.[0]?.code, "pending_review");
});

test("screen schedule preview sends the entries and the calendar window, and refuses bad files before any request", async () => {
  const env = await enrolled();
  const transport = new FakeTransport();
  const preview: SchedulePreview = { gained: { count: 1, screen_ids: [A] }, lost: { count: 0, screen_ids: [] }, calendar: { before: calendar({ groups: [] }), after: calendar() } };
  transport.on("POST", `/api/screens/${A}/playlist-schedule/preview`, () => json(200, preview));
  await writeFile(path.join(env.cwd, "s.json"), JSON.stringify({ entries: [{ id: "wip", playlist_id: "pl_A", windows: [{ days: ["mon"] }], paused: false }] }));
  const result = await cli(["--human", "screen", "schedule", "preview", A, "--file", "s.json", "--calendar-to", "2026-09-01T00:00:00Z"], transport, env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(last(transport).method, "POST");
  assert.deepEqual(last(transport).body, { entries: [{ id: "wip", playlist_id: "pl_A", windows: [{ days: ["mon"] }], paused: false }], to: "2026-09-01T00:00:00Z" });
  assert.equal(last(transport).headers?.["idempotency-key"], undefined);
  assert.match(result.stdout, new RegExp(`^Preview of a 1-entry playlist schedule on ${A}\\. Nothing was changed\\.$`, "m"));
  assert.match(result.stdout, new RegExp(`^Gains 1 screen: ${A}$`, "m"));

  await writeFile(path.join(env.cwd, "bad.json"), JSON.stringify({ entries: [{ playlist_id: "pl_A", windows: [{ days: ["mon"] }], paused: 1 }] }));
  const calls = transport.calls.length;
  const bad = await cli(["--json", "screen", "schedule", "preview", A, "--file", "bad.json"], transport, env);
  assert.equal(bad.code, ExitCode.Usage, bad.stdout);
  assert.match(bad.envelope.error!.detail, /paused must be true/);
  assert.equal(transport.calls.length, calls);
  assert.equal((await cli(["--json", "screen", "schedule", "preview", A], transport, env)).code, ExitCode.Usage, "--file is required");
});

test("explain says a paused schedule entry is a draft and a paused campaign is paused", () => {
  const entry = { kind: "schedule" as const, id: "wip", playlist_id: "pl_A", verdict: "off" as const, reason: "paused" as const };
  assert.equal(verdictDetail(entry, "scr_A", undefined), "the schedule entry is paused (a draft)");
  assert.equal(verdictDetail({ ...entry, kind: "campaign", id: "cmp_X" }, "scr_A", undefined), "the campaign is paused");
});

test("help documents the change control commands, their flags and relationships", () => {
  assert.deepEqual(commandHelp(["campaign"]).commands.map((command) => command.name), ["list", "show", "create", "update", "preview", "publish", "promote", "revisions", "restore", "pause", "resume", "delete", "screens", "explain"]);
  assert.deepEqual(commandHelp(["screen", "schedule"]).commands.map((command) => command.name), ["show", "set", "clear", "revisions", "restore", "preview"]);

  const publish = commandHelp(["campaign", "publish"]);
  assert.deepEqual(publish.options.find((option) => option.name === "--test-folder")!.conflicts, ["--test-screen"]);
  assert.deepEqual(publish.options.find((option) => option.name === "--test-screen")!.conflicts, ["--test-folder"]);
  assert.match(publish.usage, /campaign promote ID --revision N/);
  for (const action of ["promote", "restore"]) {
    const help = commandHelp(["campaign", action]);
    assert.equal(help.options.find((option) => option.name === "--revision")!.required, true, action);
    assert.equal(help.options.find((option) => option.name === "--expect-rev")!.required, false, action);
    assert.match(help.usage, /--expect-rev is the campaign's current revision, not N/, action);
  }
  const preview = commandHelp(["campaign", "preview"]);
  assert.deepEqual(preview.relationships, [{ kind: "atMostOne", options: ["--tag", "--any-tag", "--screen-id", "--folder", "--all-screens", "--audience"] }]);
  assert.deepEqual(preview.options.find((option) => option.name === "--publish")!.conflicts, ["--paused"]);
  assert.match(preview.usage, /Read only: nothing is written\./);

  const restore = commandHelp(["screen", "schedule", "restore"]);
  assert.ok(restore.options.some((option) => option.name === "--note"));
  assert.match(restore.usage, /pending_review/);
  const schedulePreview = commandHelp(["screen", "schedule", "preview"]);
  assert.equal(schedulePreview.options.find((option) => option.name === "--file")!.required, true);
  assert.match(commandHelp(["screen", "schedule", "set"]).usage, /paused: true makes the entry a draft/);
  assert.match(commandHelp(["campaign"]).usage, /A paused campaign is a draft/);

  const everything = JSON.stringify([commandHelp(["campaign"]), ...["preview", "publish", "promote", "revisions", "restore"].map((action) => commandHelp(["campaign", action])),
    ...["revisions", "restore", "preview"].map((action) => commandHelp(["screen", "schedule", action]))]);
  assert.doesNotMatch(everything, /\b(beta|coming soon|not yet|planned|in development|not available yet|experimental)\b/i);
  assert.doesNotMatch(everything, /localhost|MCP|\/home\//);
});
