import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Alert, Screen } from "./adapters/protocol.js";
import {
  ALERT_ID_PATTERN, ALERT_MUTE_ID_PATTERN, alertEnd, alertForInstant, alertUntilInstant, durationText, screenAlertCountsLine, screenAlertListLines,
  screenAlertStateText,
} from "./alerts.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help-tree.js";
import { run, type CliRuntime } from "./main.js";
import { networkError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest } from "./transport/types.js";

const NOW = new Date("2026-10-27T17:00:00.000Z");
const alertId = (name: string) => `alr_${name.padEnd(22, "A")}`;
const muteId = (name: string) => `amt_${name.padEnd(22, "A")}`;
const OFFLINE = alertId("OFFLINE");
const HOT = alertId("HOT");
const RESOLVED = alertId("RESOLVED");
const MISSING = alertId("MISSING");
const MISSING_MUTE = muteId("MISSING");
const LOBBY = "scr_LOBBYAAAAAAAAAAAAAAAA";
const ENTRANCE = "scr_ENTRANCEAAAAAAAAAAAA";
const CAFE = "scr_CAFEAAAAAAAAAAAAAAAAA";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; hint?: string; next?: { command: string; reason: string } };
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
  const configDir = await testTemp("alerts-cfg-");
  const cwd = await testTemp("alerts-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, now: Date = NOW): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr,
    now: () => now,
    sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
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

const alertCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => /^\/api\/alert(?:s|-mutes)(?:\/|$)/.test(call.path));

function screen(id: string, label: string, tags: string[]): Screen {
  return {
    id, label, public_id: `pub_${id}`, state: "active", revision: 1, manifest_revision: 1, content_access_generation: 1, online: true,
    created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:00.000Z", tags,
  };
}

/** Two open alerts (12 minutes and 2 hours 5 minutes old) and one that resolved yesterday after 3 hours 30 minutes. */
function seeded(now: () => Date = () => NOW): FakeTransport {
  const transport = memoryBackend({ now });
  transport.putScreen!(screen(LOBBY, "Lobby TV", ["Lobby", "Floor2"]));
  transport.putScreen!(screen(ENTRANCE, "Entrance", ["Floor1"]));
  transport.putAlert!({ id: OFFLINE, screen_id: LOBBY, screen_name: "Lobby TV", condition: "screen_offline", state: "open", since: "2026-10-27T14:55:00Z" });
  transport.putAlert!({ id: HOT, screen_id: ENTRANCE, screen_name: "Entrance", condition: "running_hot", state: "open", since: "2026-10-27T16:48:00Z" });
  transport.putAlert!({ id: RESOLVED, screen_id: LOBBY, screen_name: "Lobby TV", condition: "not_playing", state: "resolved", since: "2026-10-26T09:00:00Z", resolved_at: "2026-10-26T12:30:00Z" });
  return transport;
}

test("alerts list reads the open alerts and prints the table with how long each has lasted and the counts line", async () => {
  const env = await enrolled();
  const transport = seeded();
  const json = await cli(["--json", "alerts", "list"], transport, env);
  assert.equal(json.code, 0, json.stdout);
  const call = alertCalls(transport).at(-1)!;
  assert.equal(call.method, "GET");
  assert.equal(call.path, "/api/alerts");
  assert.deepEqual(call.query ?? {}, {}, "no filter is sent unless one is asked for");
  assert.deepEqual(json.envelope.data.items.map((item: { id: string }) => item.id), [HOT, OFFLINE], "open alerts only, newest first");
  assert.deepEqual(json.envelope.data.counts, { open: 2, attention: 2 });
  assert.equal(json.envelope.data.next_cursor, null);
  assert.deepEqual(json.envelope.data.items[0], {
    id: HOT, screen_id: ENTRANCE, screen_name: "Entrance", condition: "running_hot", state: "open", since: "2026-10-27T16:48:00Z", muted: false, attention: true,
  });

  const human = await cli(["--human", "alerts", "list"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Alerts \(2\)$/m);
  assert.match(human.stdout, /^ID\s+SCREEN\s+CONDITION\s+SINCE\s+FOR\s+STATE$/m);
  assert.match(human.stdout, new RegExp(`^${HOT}\\s+Entrance\\s+running_hot\\s+2026-10-27T16:48:00Z\\s+12m\\s+open$`, "m"));
  assert.match(human.stdout, new RegExp(`^${OFFLINE}\\s+Lobby TV\\s+screen_offline\\s+2026-10-27T14:55:00Z\\s+2h 5m\\s+open$`, "m"));
  assert.match(human.stdout, /^counts: 2 open, 2 need attention$/m);
  assert.doesNotMatch(human.stdout, /next:/, "the last page offers no next page");
});

test("alerts list sends --state, --screen-id, --before and --limit, keeps the counts of the whole project and pages with a runnable next command", async () => {
  const env = await enrolled();
  const transport = seeded();
  const all = await cli(["--json", "alerts", "list", "--state", "all"], transport, env);
  assert.equal(all.code, 0, all.stdout);
  assert.deepEqual(alertCalls(transport).at(-1)!.query, { state: "all" });
  assert.deepEqual(all.envelope.data.items.map((item: { id: string }) => item.id), [HOT, OFFLINE, RESOLVED], "open first, then resolved");
  assert.deepEqual(all.envelope.data.counts, { open: 2, attention: 2 });

  const resolved = await cli(["--json", "alerts", "list", "--state=resolved"], transport, env);
  assert.deepEqual(alertCalls(transport).at(-1)!.query, { state: "resolved" });
  assert.deepEqual(resolved.envelope.data.items.map((item: { id: string }) => item.id), [RESOLVED]);
  assert.deepEqual(resolved.envelope.data.counts, { open: 2, attention: 2 }, "counts cover the whole project, whatever the filter");
  assert.equal(resolved.envelope.data.items[0].resolved_at, "2026-10-26T12:30:00Z");

  const lobby = await cli(["--json", "alerts", "list", "--state", "all", "--screen-id", LOBBY], transport, env);
  assert.deepEqual(alertCalls(transport).at(-1)!.query, { state: "all", screen_id: LOBBY });
  assert.deepEqual(lobby.envelope.data.items.map((item: { id: string }) => item.id), [OFFLINE, RESOLVED]);

  const first = await cli(["--json", "alerts", "list", "--state", "all", "--limit", "2"], transport, env);
  assert.deepEqual(alertCalls(transport).at(-1)!.query, { state: "all", limit: "2" });
  assert.equal(first.envelope.data.items.length, 2);
  const cursor = first.envelope.data.next_cursor as string;
  assert.equal(cursor, "alc1_2");
  const humanFirst = await cli(["--human", "alerts", "list", "--state", "all", "--limit", "2"], transport, env);
  assert.match(humanFirst.stdout, new RegExp(`^next: screenrig alerts list --state all --before ${cursor} --limit 2$`, "m"));
  const second = await cli(["--json", "alerts", "list", "--state", "all", "--limit", "2", "--before", cursor], transport, env);
  assert.deepEqual(alertCalls(transport).at(-1)!.query, { state: "all", limit: "2", before: cursor });
  assert.deepEqual(second.envelope.data.items.map((item: { id: string }) => item.id), [RESOLVED]);
  assert.equal(second.envelope.data.next_cursor, null);

  const humanResolved = await cli(["--human", "alerts", "list", "--state", "resolved"], transport, env);
  assert.match(humanResolved.stdout, new RegExp(`^${RESOLVED}\\s+Lobby TV\\s+not_playing\\s+2026-10-26T09:00:00Z\\s+3h 30m\\s+resolved$`, "m"));
  assert.match(humanResolved.stdout, /^counts: 2 open, 2 need attention$/m);
});

test("alerts list says what it did not find, and still gives the project's counts", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW });
  const empty = await cli(["--human", "alerts", "list"], transport, env);
  assert.match(empty.stdout, /^Alerts \(0\)\nNo open alerts\ncounts: 0 open, 0 need attention$/m);
  assert.match((await cli(["--human", "alerts", "list", "--state", "resolved"], transport, env)).stdout, /^No resolved alerts$/m);
  assert.match((await cli(["--human", "alerts", "list", "--state", "all"], transport, env)).stdout, /^No alerts$/m);
  assert.equal(screenAlertCountsLine({ open: 1, attention: 1 }), "counts: 1 open, 1 needs attention");
  assert.equal(screenAlertCountsLine(undefined), undefined);
  assert.deepEqual(screenAlertListLines(undefined, NOW, {}), ["Alerts (0)", "No open alerts"]);
});

test("alerts list validates its options before any request", async () => {
  const env = await enrolled();
  const transport = seeded();
  const before = transport.calls.length;
  for (const [args, message] of [
    [["--state", "closed"], /--state must be open, resolved, or all/],
    [["--limit", "0"], /--limit must be a whole number from 1 to 200/],
    [["--limit", "201"], /--limit must be a whole number from 1 to 200/],
    [["--limit", "1.5"], /--limit must be a whole number from 1 to 200/],
    [["--limit", "many"], /--limit must be a whole number from 1 to 200/],
    [["--before", "x".repeat(201)], /--before takes the data\.next_cursor of a previous alerts list page/],
    [["--screen-id", "pl_PLAYLIST"], /--screen-id takes a screen id \(scr_…\)/],
    [["--screen-id", LOBBY, "--screen-id", ENTRANCE], /--screen-id may be supplied only once/],
    [["--state", "open", "--state", "all"], /--state may be supplied only once/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "alerts", "list", ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, args.join(" "));
  }
  assert.equal(transport.calls.length, before, "invalid input never reaches the server");
  // The server rejects a cursor it did not issue.
  const stale = await cli(["--json", "alerts", "list", "--before", "elsewhere"], transport, env);
  assert.equal(stale.code, ExitCode.Client, stale.stdout);
  assert.equal(stale.envelope.error!.code, "invalid_request");
});

test("alerts show prints one alert, and an unknown or malformed id is refused with the next step", async () => {
  const env = await enrolled();
  const transport = seeded();
  const shown = await cli(["--json", "alerts", "show", OFFLINE], transport, env);
  assert.equal(shown.code, 0, shown.stdout);
  const call = alertCalls(transport).at(-1)!;
  assert.equal(call.method, "GET");
  assert.equal(call.path, `/api/alerts/${OFFLINE}`);
  assert.equal(shown.envelope.data.condition, "screen_offline");
  assert.equal(shown.envelope.data.attention, true);

  const human = await cli(["--human", "alerts", "show", OFFLINE], transport, env);
  assert.match(human.stdout, /^Alert$/m);
  for (const line of [
    `id: ${OFFLINE}`, `screen_id: ${LOBBY}`, "screen_name: Lobby TV", "condition: screen_offline", "state: open",
    "since: 2026-10-27T14:55:00Z", "for: 2h 5m", "attention: true", "muted: false",
  ]) {
    assert.match(human.stdout, new RegExp(`^${line}$`, "m"), line);
  }
  assert.doesNotMatch(human.stdout, /acknowledged|snoozed_until|resolved_at/);
  const resolved = await cli(["--human", "alerts", "show", RESOLVED], transport, env);
  assert.match(resolved.stdout, /^state: resolved$/m);
  assert.match(resolved.stdout, /^for: 3h 30m$/m, "a resolved alert shows how long it lasted");
  assert.match(resolved.stdout, /^resolved_at: 2026-10-26T12:30:00Z$/m);
  assert.match(resolved.stdout, /^attention: false$/m);

  const missing = await cli(["--json", "alerts", "show", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound, missing.stdout);
  assert.equal(missing.envelope.error!.next!.command, "screenrig alerts list --state all");
  assert.match(missing.envelope.error!.next!.reason, /plan's event retention/);

  const before = transport.calls.length;
  for (const id of ["scr_AAAAAAAAAAAAAAAAAAAAAAAA", muteId("MUTE"), "alr_short", `${OFFLINE}x/../y`]) {
    const malformed = await cli(["--json", "alerts", "show", id], transport, env);
    assert.equal(malformed.code, ExitCode.Usage, id);
    assert.equal(malformed.envelope.error!.next!.command, "screenrig alerts list", id);
  }
  assert.equal(transport.calls.length, before, "a malformed id is refused locally");
});

test("alert and mute ids are checked by shape, with or without an environment marker", () => {
  for (const id of [OFFLINE, `stage_${OFFLINE}`, `qa_${OFFLINE}`, `development_${OFFLINE}`, "alr_AAAAAAAAAAAAAAAA", "alr_AAAAAAAAAAAAAAAAAAAAAAAA", "alr_a-b_c-d_e-f_g-h_i-j"]) {
    assert.ok(ALERT_ID_PATTERN.test(id), id);
  }
  for (const id of ["alr_", "alr_AAAAAAAAAAAAAAA", "alr_AAAAAAAAAAAAAAAAAAAAAAAAA", "alr_AAAAAAAA.AAAAAAAAAA", "amt_AAAAAAAAAAAAAAAAAAAA", "prod_alr_AAAAAAAAAAAAAAAAAAAA", " alr_AAAAAAAAAAAAAAAAAAAA"]) {
    assert.ok(!ALERT_ID_PATTERN.test(id), id);
  }
  for (const id of [muteId("MUTE"), `stage_${muteId("MUTE")}`]) assert.ok(ALERT_MUTE_ID_PATTERN.test(id), id);
  for (const id of [OFFLINE, "amt_short", "amt_AAAAAAAAAAAAAAAAAAAAAAAAA"]) assert.ok(!ALERT_MUTE_ID_PATTERN.test(id), id);
});

test("alerts ack acknowledges an open alert with a write key and no body, and the alert stops needing attention", async () => {
  const env = await enrolled();
  const transport = seeded();
  const acked = await cli(["--json", "alerts", "ack", OFFLINE], transport, env);
  assert.equal(acked.code, 0, acked.stdout);
  const call = alertCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/alerts/${OFFLINE}/acknowledge`);
  assert.equal(call.body, undefined, "ack sends no body: acknowledged until it resolves");
  assert.ok(call.headers?.["idempotency-key"], "a write always sends an Idempotency-Key");
  assert.equal(acked.envelope.data.attention, false);
  assert.equal(acked.envelope.data.acknowledged_at, NOW.toISOString());
  assert.deepEqual(acked.envelope.data.acknowledged_by, { kind: "agent", id: "agt_AAAAAAAAAAAAAAAAAAAAAAAA", name: "ScreenRig CLI" });
  assert.equal(acked.envelope.data.snoozed_until, undefined);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/, "a completed write clears its recovery entry");

  const human = await cli(["--human", "alerts", "ack", OFFLINE], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, new RegExp(`^Acknowledged alert ${OFFLINE}\\. It stays acknowledged until it resolves\\.$`, "m"));
  assert.match(human.stdout, /^acknowledged_by: ScreenRig CLI \(agent agt_AAAAAAAAAAAAAAAAAAAAAAAA\)$/m);
  assert.match(human.stdout, /^attention: false$/m);

  const listed = await cli(["--human", "alerts", "list"], transport, env);
  assert.match(listed.stdout, new RegExp(`^${OFFLINE}\\s+Lobby TV\\s+screen_offline\\s+2026-10-27T14:55:00Z\\s+2h 5m\\s+open, acknowledged$`, "m"));
  assert.match(listed.stdout, /^counts: 2 open, 1 needs attention$/m);
});

test("alerts ack and snooze refuse a resolved alert with alert_not_open (exit 5) and point at the open ones", async () => {
  const env = await enrolled();
  const transport = seeded();
  for (const args of [["ack", RESOLVED], ["snooze", RESOLVED, "--for", "1h"]]) {
    const refused = await cli(["--json", "alerts", ...args], transport, env);
    assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
    assert.equal(refused.envelope.error!.code, "alert_not_open");
    assert.equal(refused.envelope.error!.next!.command, "screenrig alerts list");
    assert.match(refused.envelope.error!.next!.reason, new RegExp(`Alert ${RESOLVED} has resolved`));
    assert.equal(refused.envelope.warnings, undefined, "a definite refusal keeps no recovery state");
  }
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
  const missing = await cli(["--json", "alerts", "ack", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
  assert.equal(missing.envelope.error!.next!.command, "screenrig alerts list --state all");
  const before = transport.calls.length;
  const malformed = await cli(["--json", "alerts", "ack", "not-an-alert"], transport, env);
  assert.equal(malformed.code, ExitCode.Usage);
  assert.equal(transport.calls.length, before);
});

test("alerts snooze sends the instant for --for (this computer's clock) or --until (normalized to UTC)", async () => {
  const env = await enrolled();
  const transport = seeded();
  const hours = await cli(["--json", "alerts", "snooze", OFFLINE, "--for", "4h"], transport, env);
  assert.equal(hours.code, 0, hours.stdout);
  let call = alertCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/alerts/${OFFLINE}/acknowledge`);
  assert.deepEqual(call.body, { until: "2026-10-27T21:00:00Z" });
  assert.ok(call.headers?.["idempotency-key"]);
  assert.equal(hours.envelope.data.snoozed_until, "2026-10-27T21:00:00Z");
  assert.equal(hours.envelope.data.attention, false);

  const instant = await cli(["--json", "alerts", "snooze", OFFLINE, "--until", "2026-11-01T09:00:00-07:00"], transport, env);
  assert.equal(instant.code, 0, instant.stdout);
  call = alertCalls(transport).at(-1)!;
  assert.deepEqual(call.body, { until: "2026-11-01T16:00:00Z" });
  assert.equal(instant.envelope.data.snoozed_until, "2026-11-01T16:00:00Z", "a later snooze replaces the earlier one");

  const longest = await cli(["--json", "alerts", "snooze", HOT, "--for", "29d23h59m"], transport, env);
  assert.equal(longest.code, 0, longest.stdout);
  assert.deepEqual(alertCalls(transport).at(-1)!.body, { until: "2026-11-26T16:59:00Z" });

  const human = await cli(["--human", "alerts", "snooze", HOT, "--for", "90m"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, new RegExp(`^Snoozed alert ${HOT} until 2026-10-27T18:30:00Z\\. It needs attention again then if it is still open\\.$`, "m"));
  assert.match(human.stdout, /^snoozed_until: 2026-10-27T18:30:00Z$/m);
  const listed = await cli(["--human", "alerts", "list"], transport, env);
  assert.match(listed.stdout, new RegExp(`^${HOT}\\s+Entrance\\s+running_hot\\s+.*open, snoozed until 2026-10-27T18:30:00Z$`, "m"));
  assert.match(listed.stdout, /^counts: 2 open, 0 need attention$/m);
});

test("a snooze that has ended needs attention again, and the table says so", async () => {
  const env = await enrolled();
  let current = NOW;
  const transport = seeded(() => current);
  const snoozed = await cli(["--json", "alerts", "snooze", OFFLINE, "--for", "1h"], transport, env, current);
  assert.equal(snoozed.code, 0, snoozed.stdout);
  current = new Date("2026-10-27T18:30:00.000Z");
  const listed = await cli(["--human", "alerts", "list"], transport, env, current);
  assert.match(listed.stdout, new RegExp(`^${OFFLINE}\\s+.*\\s+3h 35m\\s+open, snooze ended$`, "m"));
  assert.match(listed.stdout, /^counts: 2 open, 2 need attention$/m);
});

test("alerts snooze validates --for and --until before any request, and leaves the 30-day limit on an instant to the server", async () => {
  const env = await enrolled();
  const transport = seeded();
  const before = transport.calls.length;
  for (const [args, message] of [
    [[], /Provide exactly one of --for or --until/],
    [["--for", "1h", "--until", "2026-11-01T09:00:00Z"], /--for cannot be used with --until|--until cannot be used with --for/],
    [["--for", "0m"], /--for takes a duration such as 30m, 1h, 4h or 2d/],
    [["--for", "soon"], /--for takes a duration/],
    [["--for", "-5m"], /--for takes a duration|--for requires a value/],
    [["--for", "1x"], /--for takes a duration/],
    [["--for", "OFF"], /--for takes a duration/],
    [["--for", "30d"], /--for must be under 30 days \(at most 29d23h59m\).*Use --until for an exact end/],
    [["--for", "29d23h59m1s"], /--for must be under 30 days/],
    [["--for", "31d"], /--for must be under 30 days/],
    [["--until", "2026-11-01"], /--until takes an RFC 3339 instant with seconds and an offset/],
    [["--until", "2026-11-01T09:00:00"], /--until takes an RFC 3339 instant/],
    [["--until", "tomorrow"], /--until takes an RFC 3339 instant/],
    [["--until", "2026-13-01T00:00:00Z"], /--until takes an RFC 3339 instant/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "alerts", "snooze", OFFLINE, ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, args.join(" "));
  }
  assert.equal(transport.calls.length, before, "invalid input never reaches the server");

  for (const until of ["2026-11-26T17:01:00Z", "2026-10-27T16:59:00Z", "2026-10-27T17:00:00Z"]) {
    const refused = await cli(["--json", "alerts", "snooze", OFFLINE, "--until", until], transport, env);
    assert.equal(refused.code, ExitCode.Client, `${until}: ${refused.stdout}`);
    assert.equal(refused.envelope.error!.code, "invalid_request");
    assert.equal(refused.envelope.warnings, undefined, "a definite refusal keeps no recovery state");
  }
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
});

test("--for and --until: durations count from now, instants are normalized, 30 days is the ceiling", () => {
  for (const [value, expected] of [
    ["30m", "2026-10-27T17:30:00Z"], ["1h", "2026-10-27T18:00:00Z"], ["2d", "2026-10-29T17:00:00Z"], ["1h30m", "2026-10-27T18:30:00Z"],
    ["90s", "2026-10-27T17:01:30Z"], ["29d23h59m", "2026-11-26T16:59:00Z"], [" 4h ", "2026-10-27T21:00:00Z"],
  ] as const) {
    assert.equal(alertForInstant(value, NOW), expected, value);
  }
  for (const value of ["0m", "30d", "29d23h59m1s", "31d", "", "soon", "1w", "off", "2026-11-01T09:00:00Z"]) {
    assert.throws(() => alertForInstant(value, NOW), /--for/, value);
  }
  assert.equal(alertUntilInstant("2026-11-01T16:00:00Z"), "2026-11-01T16:00:00Z");
  assert.equal(alertUntilInstant("2026-11-01T09:00:00-07:00"), "2026-11-01T16:00:00Z");
  assert.equal(alertUntilInstant("2026-11-01T16:00:00.250Z"), "2026-11-01T16:00:00.250Z");
  for (const value of ["", "2026-11-01", "2026-11-01T09:00:00", "2026-13-01T00:00:00Z", "4h", "none"]) {
    assert.throws(() => alertUntilInstant(value), /--until/, value);
  }
  assert.equal(alertEnd("4h", undefined, NOW), "2026-10-27T21:00:00Z");
  assert.equal(alertEnd(undefined, "2026-11-01T16:00:00Z", NOW), "2026-11-01T16:00:00Z");
  assert.throws(() => alertEnd(undefined, undefined, NOW), /exactly one of --for or --until/);
  assert.throws(() => alertEnd("1h", "2026-11-01T16:00:00Z", NOW), /exactly one of --for or --until/);
});

test("alerts mute sends screen ids, tags, the end and the note with a write key and prints the mute", async () => {
  const env = await enrolled();
  const transport = seeded();
  const created = await cli(["--json", "alerts", "mute", "--screen-id", LOBBY, "--for", "2h", "--note", "Display swap"], transport, env);
  assert.equal(created.code, 0, created.stdout);
  let call = alertCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/alert-mutes");
  assert.deepEqual(call.body, { screen_ids: [LOBBY], until: "2026-10-27T19:00:00Z", note: "Display swap" });
  assert.ok(call.headers?.["idempotency-key"]);
  assert.match(created.envelope.data.id, /^amt_/);
  assert.deepEqual(created.envelope.data.screen_ids, [LOBBY]);
  assert.deepEqual(created.envelope.data.tags, []);
  assert.equal(created.envelope.data.until, "2026-10-27T19:00:00Z");
  assert.equal(created.envelope.data.created_by.kind, "agent");
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/, "a completed create clears its recovery entry");

  const tags = await cli(["--json", "alerts", "mute", "--tag", "Floor1", "--tag", "Cafe,Patio", "--until", "2026-11-01T09:00:00-07:00"], transport, env);
  assert.equal(tags.code, 0, tags.stdout);
  call = alertCalls(transport).at(-1)!;
  assert.deepEqual(call.body, { tags: ["Floor1", "Cafe", "Patio"], until: "2026-11-01T16:00:00Z" }, "repeated and comma-separated tags join into one list; no note, no screen_ids");

  const both = await cli(["--json", "alerts", "mute", "--screen-id", `${LOBBY},${ENTRANCE}`, "--screen-id", CAFE, "--tag", "Lobby", "--for", "1d"], transport, env);
  assert.equal(both.code, 0, both.stdout);
  assert.deepEqual(alertCalls(transport).at(-1)!.body, { screen_ids: [LOBBY, ENTRANCE, CAFE], tags: ["Lobby"], until: "2026-10-28T17:00:00Z" }, "ids and tags may be combined in one mute");

  const human = await cli(["--human", "alerts", "mute", "--tag", "Lobby", "--for", "30m", "--note", "Cleaning"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Created mute amt_/m);
  assert.match(human.stdout, /^screen_ids: \(none\)$/m);
  assert.match(human.stdout, /^tags: Lobby$/m);
  assert.match(human.stdout, /^until: 2026-10-27T17:30:00Z$/m);
  assert.match(human.stdout, /^note: Cleaning$/m);
  assert.match(human.stdout, /^created_by: ScreenRig CLI \(agent agt_AAAAAAAAAAAAAAAAAAAAAAAA\)$/m);
});

test("alerts mute validates targets, the end and the note before any request", async () => {
  const env = await enrolled();
  const transport = seeded();
  const before = transport.calls.length;
  const target = ["--screen-id", LOBBY];
  const end = ["--for", "1h"];
  const manyIds = Array.from({ length: 101 }, (_, index) => `scr_S${String(index).padStart(10, "0")}`).join(",");
  const manyTags = Array.from({ length: 17 }, (_, index) => `t${index}`).join(",");
  for (const [args, message] of [
    [[...end], /Provide at least one of --screen-id or --tag/],
    [[...target], /Provide exactly one of --for or --until/],
    [[...target, ...end, "--until", "2026-11-01T09:00:00Z"], /--for cannot be used with --until|--until cannot be used with --for/],
    [["--screen-id", "pl_PLAYLIST", ...end], /--screen-id takes screen ids \(scr_…\), repeated or comma-separated/],
    [["--screen-id", `${LOBBY},,${ENTRANCE}`, ...end], /--screen-id takes screen ids/],
    [["--screen-id", LOBBY, "--screen-id", LOBBY, ...end], /--screen-id lists a screen more than once/],
    [["--screen-id", manyIds, ...end], /--screen-id accepts at most 100 screens; mute a tag instead/],
    [["--tag", "Lobby!", ...end], /--tag takes comma-separated tags of 1 to 32 letters or digits/],
    [["--tag", "Lobby", "--tag", "Lobby", ...end], /--tag lists a tag more than once/],
    [["--tag", manyTags, ...end], /--tag accepts at most 16 tags/],
    [[...target, "--for", "0m"], /--for takes a duration/],
    [[...target, "--for", "30d"], /--for must be under 30 days/],
    [[...target, "--until", "next week"], /--until takes an RFC 3339 instant/],
    [[...target, ...end, "--note", "x".repeat(201)], /--note must be at most 200 characters/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "alerts", "mute", ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, args.join(" "));
  }
  assert.equal(transport.calls.length, before, "invalid input never reaches the server");

  // A repeated option is allowed only for --screen-id and --tag.
  for (const flag of [["--for", "1h"], ["--note", "a"]]) {
    const refused = await cli(["--json", "alerts", "mute", ...target, "--for", "2h", ...flag, ...flag], transport, env);
    assert.equal(refused.code, ExitCode.Usage, refused.stdout);
    assert.match(refused.envelope.error!.detail, /may be supplied only once/);
  }
  // The server's own checks: a past end is invalid_request (exit 8).
  const past = await cli(["--json", "alerts", "mute", ...target, "--until", "2026-10-27T16:00:00Z"], transport, env);
  assert.equal(past.code, ExitCode.Client, past.stdout);
  assert.equal(past.envelope.error!.code, "invalid_request");
  const far = await cli(["--json", "alerts", "mute", ...target, "--until", "2026-12-25T00:00:00Z"], transport, env);
  assert.equal(far.code, ExitCode.Client, far.stdout);
  assert.match(far.envelope.error!.detail, /at most 30 days ahead/);
});

test("alert_mute_limit_reached is a definite conflict: exit 5, guidance, no saved key", async () => {
  const env = await enrolled();
  const transport = seeded();
  for (let index = 0; index < 50; index += 1) {
    const created = await cli(["--json", "alerts", "mute", "--tag", `T${index}`, "--for", "1h", "--note", `mute ${index}`], transport, env);
    assert.equal(created.code, 0, created.stdout);
  }
  const refused = await cli(["--json", "alerts", "mute", "--tag", "TooMany", "--for", "1h"], transport, env);
  assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
  assert.equal(refused.envelope.error!.code, "alert_mute_limit_reached");
  assert.equal(refused.envelope.error!.next!.command, "screenrig alerts mutes");
  assert.match(refused.envelope.error!.next!.reason, /at most 50 current mutes.*alerts unmute MUTE_ID.*by tag.*Nothing was created/);
  assert.equal(refused.envelope.warnings, undefined);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
  // Ending one makes room.
  const listed = await cli(["--json", "alerts", "mutes"], transport, env);
  assert.equal(listed.envelope.data.items.length, 50);
  const ended = await cli(["--json", "alerts", "unmute", listed.envelope.data.items[0].id], transport, env);
  assert.equal(ended.code, 0, ended.stdout);
  const again = await cli(["--json", "alerts", "mute", "--tag", "TooMany", "--for", "1h"], transport, env);
  assert.equal(again.code, 0, again.stdout);
});

test("an ambiguous alerts mute reruns with the saved key and the server replays the same mute; --for starts afresh and supersedes the saved key", async () => {
  const env = await enrolled();
  const backend = seeded();
  let lose = true;
  const original = backend.request.bind(backend);
  backend.request = async (req) => {
    const response = await original(req);
    if (lose && req.method === "POST" && req.path === "/api/alert-mutes") {
      lose = false;
      throw networkError("connection reset after the request was sent");
    }
    return response;
  };
  const argv = ["--json", "alerts", "mute", "--screen-id", LOBBY, "--until", "2026-11-01T16:00:00Z", "--note", "Display swap"];
  const lost = await cli(argv, backend, env);
  assert.equal(lost.code, ExitCode.Network, lost.stdout);
  assert.ok(lost.envelope.warnings?.some((warning) => warning.code === "write_recovery_saved"));
  const pending = await readFile(env.configPath, "utf8");
  assert.match(pending, /pending_writes/, "the key is saved for the rerun");
  assert.match(pending, /alerts mute/, "recovery list can name the command");
  assert.doesNotMatch(pending, /Display swap|scr_LOBBY/, "the ledger holds no request or response content");

  const rerun = await cli(argv, backend, env);
  assert.equal(rerun.code, 0, rerun.stdout);
  const posts = alertCalls(backend).filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.headers?.["idempotency-key"], posts[0]!.headers?.["idempotency-key"], "the rerun reuses the saved key");
  const listed = await cli(["--json", "alerts", "mutes"], backend, env);
  assert.equal(listed.envelope.data.items.length, 1, "the replay did not create a second mute");
  assert.equal(listed.envelope.data.items[0].id, rerun.envelope.data.id);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);

  // --for derives its instant from the clock: a rerun later is a different request, so it supersedes the obsolete saved key.
  lose = true;
  const forArgv = ["--json", "alerts", "mute", "--tag", "Lobby", "--for", "2h"];
  const lostFor = await cli(forArgv, backend, env, NOW);
  assert.equal(lostFor.code, ExitCode.Network, lostFor.stdout);
  assert.match(await readFile(env.configPath, "utf8"), /pending_writes/);
  const later = await cli(forArgv, backend, env, new Date(NOW.getTime() + 60_000));
  assert.equal(later.code, 0, later.stdout);
  assert.equal(later.envelope.data.until, "2026-10-27T19:01:00Z");
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/, "the superseded key is not left behind");
});

test("alerts snooze --for supersedes the saved key of an earlier ambiguous snooze of the same alert", async () => {
  const env = await enrolled();
  const backend = seeded();
  let lose = true;
  const original = backend.request.bind(backend);
  backend.request = async (req) => {
    const response = await original(req);
    if (lose && req.method === "POST" && req.path === `/api/alerts/${OFFLINE}/acknowledge`) {
      lose = false;
      throw networkError("connection reset after the request was sent");
    }
    return response;
  };
  const argv = ["--json", "alerts", "snooze", OFFLINE, "--for", "4h"];
  const lost = await cli(argv, backend, env, NOW);
  assert.equal(lost.code, ExitCode.Network, lost.stdout);
  assert.match(await readFile(env.configPath, "utf8"), /alerts snooze/);
  const later = await cli(argv, backend, env, new Date(NOW.getTime() + 120_000));
  assert.equal(later.code, 0, later.stdout);
  assert.equal(later.envelope.data.snoozed_until, "2026-10-27T21:02:00Z");
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
});

test("alerts mutes lists the current mutes soonest end first, and a mute that has ended drops out", async () => {
  const env = await enrolled();
  let current = NOW;
  const transport = seeded(() => current);
  const empty = await cli(["--human", "alerts", "mutes"], transport, env);
  assert.match(empty.stdout, /^Mutes \(0\)\nNo current mutes$/m);

  const later = await cli(["--json", "alerts", "mute", "--tag", "Floor1", "--for", "1d", "--note", "Repaint"], transport, env, current);
  const sooner = await cli(["--json", "alerts", "mute", "--screen-id", `${LOBBY},${ENTRANCE},${CAFE},scr_FOURTHAAAAAAAAAAAAAA`, "--for", "30m"], transport, env, current);
  const listed = await cli(["--json", "alerts", "mutes"], transport, env, current);
  assert.equal(listed.code, 0, listed.stdout);
  const call = alertCalls(transport).at(-1)!;
  assert.equal(call.method, "GET");
  assert.equal(call.path, "/api/alert-mutes");
  assert.deepEqual(listed.envelope.data.items.map((item: { id: string }) => item.id), [sooner.envelope.data.id, later.envelope.data.id]);

  const human = await cli(["--human", "alerts", "mutes"], transport, env, current);
  assert.match(human.stdout, /^Mutes \(2\)$/m);
  assert.match(human.stdout, /^ID\s+UNTIL\s+SCREENS\s+TAGS\s+BY\s+NOTE$/m);
  assert.match(human.stdout, new RegExp(`^${sooner.envelope.data.id}\\s+2026-10-27T17:30:00Z\\s+${LOBBY},${ENTRANCE},${CAFE} \\+1 more\\s+ScreenRig CLI$`, "m"));
  assert.match(human.stdout, new RegExp(`^${later.envelope.data.id}\\s+2026-10-28T17:00:00Z\\s+Floor1\\s+ScreenRig CLI\\s+Repaint$`, "m"));

  current = new Date("2026-10-27T18:00:00.000Z");
  const after = await cli(["--json", "alerts", "mutes"], transport, env, current);
  assert.deepEqual(after.envelope.data.items.map((item: { id: string }) => item.id), [later.envelope.data.id]);
});

test("alerts unmute ends a mute now and returns a deletion envelope", async () => {
  const env = await enrolled();
  const transport = seeded();
  const created = await cli(["--json", "alerts", "mute", "--screen-id", LOBBY, "--for", "2h"], transport, env);
  const id = created.envelope.data.id as string;
  const ended = await cli(["--json", "alerts", "unmute", id], transport, env);
  assert.equal(ended.code, 0, ended.stdout);
  const call = alertCalls(transport).at(-1)!;
  assert.equal(call.method, "DELETE");
  assert.equal(call.path, `/api/alert-mutes/${id}`);
  assert.ok(call.headers?.["idempotency-key"]);
  assert.deepEqual(ended.envelope.data, { id, deleted: true });
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
  assert.deepEqual((await cli(["--json", "alerts", "mutes"], transport, env)).envelope.data.items, []);

  const gone = await cli(["--json", "alerts", "unmute", id], transport, env);
  assert.equal(gone.code, ExitCode.NotFound, gone.stdout);
  assert.equal(gone.envelope.error!.next!.command, "screenrig alerts mutes");
  assert.match(gone.envelope.error!.next!.reason, /A mute that has ended is no longer listed or found/);
  const missing = await cli(["--json", "alerts", "unmute", MISSING_MUTE], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);

  const second = await cli(["--json", "alerts", "mute", "--screen-id", LOBBY, "--for", "2h"], transport, env);
  const human = await cli(["--human", "alerts", "unmute", second.envelope.data.id], transport, env);
  assert.match(human.stdout, new RegExp(`^Ended mute ${second.envelope.data.id}\\. Open alerts on its screens need attention again unless they are acknowledged or snoozed\\.$`, "m"));

  const before = transport.calls.length;
  for (const bad of [OFFLINE, "amt_short", "mute-1"]) {
    const refused = await cli(["--json", "alerts", "unmute", bad], transport, env);
    assert.equal(refused.code, ExitCode.Usage, bad);
    assert.equal(refused.envelope.error!.next!.command, "screenrig alerts mutes", bad);
    assert.match(refused.envelope.error!.detail, /A mute id looks like amt_/);
  }
  assert.equal(transport.calls.length, before, "a malformed id is refused locally");
});

test("a mute covers screens by id or by tag: its alerts are marked muted and stop needing attention until it ends", async () => {
  const env = await enrolled();
  const transport = seeded();
  const byTag = await cli(["--json", "alerts", "mute", "--tag", "Floor1", "--for", "1h"], transport, env);
  assert.equal(byTag.code, 0, byTag.stdout);
  const byId = await cli(["--json", "alerts", "mute", "--screen-id", LOBBY, "--for", "1h"], transport, env);
  assert.equal(byId.code, 0, byId.stdout);

  const listed = await cli(["--human", "alerts", "list"], transport, env);
  assert.match(listed.stdout, new RegExp(`^${HOT}\\s+Entrance\\s+running_hot\\s+.*open, muted$`, "m"));
  assert.match(listed.stdout, new RegExp(`^${OFFLINE}\\s+Lobby TV\\s+screen_offline\\s+.*open, muted$`, "m"));
  assert.match(listed.stdout, /^counts: 2 open, 0 need attention$/m);
  const shown = await cli(["--human", "alerts", "show", HOT], transport, env);
  assert.match(shown.stdout, /^muted: true$/m);
  assert.match(shown.stdout, /^attention: false$/m);

  // Acknowledged and muted reads as both; ending the mutes brings the unacknowledged one back.
  await cli(["--json", "alerts", "ack", OFFLINE], transport, env);
  assert.match((await cli(["--human", "alerts", "list"], transport, env)).stdout, new RegExp(`^${OFFLINE}\\s+.*open, acknowledged, muted$`, "m"));
  await cli(["--json", "alerts", "unmute", byTag.envelope.data.id], transport, env);
  await cli(["--json", "alerts", "unmute", byId.envelope.data.id], transport, env);
  const after = await cli(["--human", "alerts", "list"], transport, env);
  assert.match(after.stdout, new RegExp(`^${HOT}\\s+.*\\s+open$`, "m"));
  assert.match(after.stdout, new RegExp(`^${OFFLINE}\\s+.*\\s+open, acknowledged$`, "m"));
  assert.match(after.stdout, /^counts: 2 open, 1 needs attention$/m);
});

test("a Read only credential reads alerts, and a write it cannot make says how to get Manage access", async () => {
  const env = await enrolled();
  const refusal = {
    status: 403, headers: { "content-type": "application/problem+json" },
    body: { status: 403, code: "insufficient_access", title: "Insufficient access", detail: "This credential's access level cannot do this." },
  };
  const transport = new FakeTransport()
    .on("GET", "/api/alerts", () => ({ status: 200, headers: {}, body: { items: [], next_cursor: null, counts: { open: 0, attention: 0 } } }))
    .on("GET", "/api/alert-mutes", () => ({ status: 200, headers: {}, body: { items: [] } }))
    .on("POST", `/api/alerts/${OFFLINE}/acknowledge`, () => refusal)
    .on("POST", "/api/alert-mutes", () => refusal)
    .on("DELETE", `/api/alert-mutes/${muteId("MUTE")}`, () => refusal);
  for (const argv of [["alerts", "list"], ["alerts", "mutes"]]) {
    assert.equal((await cli(["--json", ...argv], transport, env)).code, 0, argv.join(" "));
  }
  for (const argv of [["alerts", "ack", OFFLINE], ["alerts", "snooze", OFFLINE, "--for", "1h"], ["alerts", "mute", "--tag", "Lobby", "--for", "1h"], ["alerts", "unmute", muteId("MUTE")]]) {
    const refused = await cli(["--json", ...argv], transport, env);
    assert.equal(refused.code, ExitCode.Auth, `${argv.join(" ")}: ${refused.stdout}`);
    assert.equal(refused.envelope.error!.code, "insufficient_access");
    assert.equal(refused.envelope.error!.next!.command, "screenrig login --access manage");
    assert.equal(refused.envelope.warnings, undefined, "a definite refusal keeps no recovery state");
  }
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
});

test("alert states read the standing of an open alert in words", () => {
  const alert = (overrides: Partial<Alert> = {}): Alert => ({
    id: OFFLINE, screen_id: LOBBY, condition: "screen_offline", state: "open", since: "2026-10-27T14:55:00Z", muted: false, attention: true, ...overrides,
  });
  const ack = { acknowledged_at: "2026-10-27T16:00:00Z" };
  assert.equal(screenAlertStateText(alert(), NOW), "open");
  assert.equal(screenAlertStateText(alert({ ...ack, attention: false }), NOW), "open, acknowledged");
  assert.equal(screenAlertStateText(alert({ ...ack, snoozed_until: "2026-10-27T18:00:00Z", attention: false }), NOW), "open, snoozed until 2026-10-27T18:00:00Z");
  assert.equal(screenAlertStateText(alert({ ...ack, snoozed_until: "2026-10-27T16:30:00Z" }), NOW), "open, snooze ended");
  assert.equal(screenAlertStateText(alert({ muted: true, attention: false }), NOW), "open, muted");
  assert.equal(screenAlertStateText(alert({ ...ack, muted: true, attention: false }), NOW), "open, acknowledged, muted");
  assert.equal(screenAlertStateText(alert({ state: "resolved", resolved_at: "2026-10-27T16:00:00Z", attention: false }), NOW), "resolved");
});

test("durations read in the two largest whole units", () => {
  for (const [ms, text] of [
    [-5_000, "0s"], [0, "0s"], [45_000, "45s"], [59_999, "59s"], [60_000, "1m"], [12 * 60_000, "12m"], [3_600_000, "1h"], [3_600_000 + 5 * 60_000, "1h 5m"],
    [2 * 3_600_000 + 5 * 60_000 + 59_000, "2h 5m"], [26 * 3_600_000, "1d 2h"], [48 * 3_600_000, "2d"], [48 * 3_600_000 + 30 * 60_000, "2d"],
  ] as const) {
    assert.equal(durationText(ms), text, String(ms));
  }
});

test("alerts commands tolerate a thin or odd answer: no counts, no names, an unnamed actor", async () => {
  const env = await enrolled();
  const thin: Alert = { id: OFFLINE, screen_id: LOBBY, condition: "screen_offline", state: "open", since: "2026-10-27T16:00:00Z", muted: false, attention: true };
  const transport = new FakeTransport()
    .on("GET", "/api/alerts", () => ({ status: 200, headers: {}, body: { items: [thin, { ...thin, id: HOT, screen_name: "N".repeat(60), acknowledged_at: "2026-10-27T16:30:00Z", attention: false, acknowledged_by: { kind: "bot", id: "bot_1" } }, { ...thin, id: RESOLVED, state: "resolved", attention: false }] } }))
    .on("GET", `/api/alerts/${HOT}`, () => ({ status: 200, headers: {}, body: { ...thin, id: HOT, acknowledged_at: "2026-10-27T16:30:00Z", attention: false, acknowledged_by: { kind: "person", id: "usr_PERSON", name: "Alex" } } }));
  const listed = await cli(["--human", "alerts", "list"], transport, env);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`^${OFFLINE}\\s+${LOBBY}\\s+screen_offline\\s+2026-10-27T16:00:00Z\\s+1h\\s+open$`, "m"), "an alert without a screen name shows its screen id");
  assert.match(listed.stdout, new RegExp(`^${HOT}\\s+${"N".repeat(39)}…\\s+`, "m"), "a long name is clipped in the table");
  assert.match(listed.stdout, new RegExp(`^${RESOLVED}\\s+${LOBBY}\\s+screen_offline\\s+2026-10-27T16:00:00Z\\s+resolved$`, "m"), "a resolved alert without its end shows no duration rather than a wrong one");
  assert.doesNotMatch(listed.stdout, /counts:/);
  const shown = await cli(["--human", "alerts", "show", HOT], transport, env);
  assert.match(shown.stdout, /^acknowledged_by: Alex \(person usr_PERSON\)$/m);
  assert.doesNotMatch(shown.stdout, /screen_name:/);
});

test("the alerts examples are runnable as written", async () => {
  const env = await enrolled();
  const transport = seeded();
  for (const name of ["list", "show", "ack", "snooze", "mute", "mutes", "unmute"]) {
    const help = commandHelp(["alerts", name]);
    assert.ok(help.examples.length > 0, name);
    for (const example of help.examples) {
      const words = [...example.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
      assert.deepEqual(words.slice(0, 2), ["screenrig", "alerts"], example);
      const argv = words.slice(1).map((word) => word.replace("alr_ALERTAAAAAAAAAAAAAAA", OFFLINE));
      const result = await cli(["--json", ...argv], transport, env);
      // A usage error would mean the example is wrong; anything else (success, or the server's own answer for a sample id) means it ran.
      assert.notEqual(result.code, ExitCode.Usage, `${example}: ${result.stdout}`);
    }
  }
  for (const example of commandHelp(["alerts", "show"]).examples.concat(commandHelp(["alerts", "ack"]).examples, commandHelp(["alerts", "snooze"]).examples)) {
    const id = /alr_[A-Za-z0-9_-]+/.exec(example)?.[0];
    assert.ok(id && ALERT_ID_PATTERN.test(id), `${example} carries a valid alert id`);
  }
  assert.ok(ALERT_MUTE_ID_PATTERN.test(/amt_[A-Za-z0-9_-]+/.exec(commandHelp(["alerts", "unmute"]).examples[0]!)![0]), "the unmute example carries a valid mute id");
});
