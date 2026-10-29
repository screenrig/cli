import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Screen } from "./adapters/protocol.js";
import { formatEventLine } from "./commands.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { commandLines } from "./screen-commands.js";
import { displayLines, displayScheduleWrite, displayUntil, rebootScheduleLines, rebootScheduleWrite, rebootWindowList, rebootWindowOption } from "./screen-display.js";
import { testTemp } from "./test-temp.js";
import { memoryBackend, type FakeTransport } from "./transport/fake.js";

const NOW = new Date("2026-08-14T17:00:00.000Z");
const LOBBY = "scr_LOBBYAAAAAAAAAAAAAAAAAA";
const PLAIN = "scr_PLAINAAAAAAAAAAAAAAAAAA";
const HOURS = { enabled: true, windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "07:00", end: "19:00" }, { days: ["sat"] }] };

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
  const configDir = await testTemp("display-cfg-");
  const cwd = await testTemp("display-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  void collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await out;
  let envelope: { ok: boolean; data?: any; error?: { code: string; detail: string; next?: { command: string; reason: string } } } = { ok: false };
  try { envelope = JSON.parse(text); } catch { /* human */ }
  return { code, stdout: text, envelope };
}

function screen(id: string, extra: Partial<Screen> = {}): Screen {
  return {
    id, label: id.slice(4, 9), public_id: `pub_${id}`, state: "active", online: true, revision: 3, manifest_revision: 1, content_access_generation: 1,
    timezone: "America/Los_Angeles", tags: ["Lobby"], created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", ...extra,
  } as Screen;
}

function fleet(): FakeTransport {
  const transport = memoryBackend({ now: () => NOW });
  transport.putScreen!(screen(LOBBY, { host: { platform: "android", capabilities: ["reboot", "display_power.cec"] } as unknown as Screen["host"] }));
  transport.putScreen!(screen(PLAIN, { host: { platform: "web", capabilities: ["display_power.scrim"] } as unknown as Screen["host"] }));
  return transport;
}

test("display schedule files are checked locally with paths", () => {
  assert.deepEqual(displayScheduleWrite(HOURS), HOURS);
  assert.deepEqual(displayScheduleWrite({ ok: true, data: { display_schedule: { ...HOURS, updated_at: "x" } } }), HOURS, "show output round-trips");
  for (const [document, pattern] of [
    [{ windows: HOURS.windows }, /enabled must be true or false/],
    [{ enabled: true, windows: [] }, /windows must list 1 to 16/],
    [{ enabled: true, windows: [{ days: ["mon"], start: "07:00" }] }, /windows\[0\] must set both start and end/],
    [{ enabled: true, windows: [{ days: ["funday"] }] }, /windows\[0\]\.days\[0\]/],
    [{ enabled: true, windows: HOURS.windows, extra: 1 }, /unknown field "extra"/],
    [[], /must be an object/],
  ] as const) {
    assert.throws(() => displayScheduleWrite(document), pattern);
  }
});

test("--until is strict RFC 3339 normalized to UTC and --for is under 7 days", () => {
  assert.equal(displayUntil("2026-08-15T10:00:00-07:00", undefined, NOW), "2026-08-15T17:00:00Z");
  assert.equal(displayUntil(undefined, "2h", NOW), "2026-08-14T19:00:00Z");
  assert.equal(displayUntil(undefined, undefined, NOW), undefined);
  assert.throws(() => displayUntil("2026-08-15", undefined, NOW), /RFC 3339/);
  assert.throws(() => displayUntil(undefined, "7d", NOW), /6d23h59m/);
  assert.throws(() => displayUntil("2026-08-15T10:00:00Z", "2h", NOW), /not both/);
});

test("screen reboot: single route, reboot_unsupported explained, fleet needs --yes", async () => {
  const env = await enrolled();
  const transport = fleet();
  const ok = await cli(["--json", "screen", "reboot", LOBBY], transport, env);
  assert.equal(ok.code, ExitCode.Success, ok.stdout);
  assert.match(ok.envelope.data.reboot_id, /^rbt_/);
  const call = transport.calls.find((item) => item.path === `/api/screens/${LOBBY}/reboot`);
  assert.equal(call?.method, "POST");
  assert.ok(call?.headers?.["idempotency-key"]);

  const refused = await cli(["--json", "screen", "reboot", PLAIN], transport, env);
  assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
  assert.equal(refused.envelope.error?.code, "reboot_unsupported");
  assert.match(refused.envelope.error!.detail, /declares the reboot capability/);
  assert.equal(refused.envelope.error?.next?.command, `screenrig screen show ${PLAIN}`);

  const unconfirmed = await cli(["--json", "screen", "reboot", "--tag", "Lobby"], transport, env);
  assert.equal(unconfirmed.code, ExitCode.Usage);
  assert.equal(unconfirmed.envelope.error?.next?.command, "screenrig screen reboot --tag Lobby --yes");
  const two = await cli(["--json", "screen", "reboot", LOBBY, PLAIN], transport, env);
  assert.equal(two.code, ExitCode.Usage);
  assert.equal(transport.calls.filter((item) => item.path === "/api/screens/actions").length, 0);
  const confirmed = await cli(["--json", "screen", "reboot", "--tag", "Lobby", "--yes"], transport, env);
  assert.equal(confirmed.envelope.data.action, "reboot");
  assert.equal(confirmed.envelope.data.succeeded, 1);
  assert.equal(confirmed.envelope.data.failed, 1);
  assert.notEqual(confirmed.code, ExitCode.Success, "a partial fleet reboot follows the fleet exit rule");
});

test("screen play-page: closed body, accepted envelope, both problems explained, usage errors send nothing", async () => {
  const env = await enrolled();
  const transport = fleet();
  const PAGE = "pg_WELCOME";
  transport.putScreen!(screen(LOBBY, { playlist_id: "pl_LOBBY", host: { platform: "android", capabilities: ["play_page"] } as unknown as Screen["host"] }));
  transport.putScreen!(screen(PLAIN, { playlist_id: "pl_LOBBY", host: { platform: "web", capabilities: ["display_power.scrim"] } as unknown as Screen["host"] }));
  transport.putPlaylist!({ id: "pl_LOBBY", name: "Lobby", pages: [{ id: PAGE }] });
  const calls = () => transport.calls.filter((item) => item.path.endsWith("/play-page"));

  const ok = await cli(["--json", "screen", "play-page", LOBBY, "--page-id", PAGE], transport, env);
  assert.equal(ok.code, ExitCode.Success, ok.stdout);
  assert.deepEqual(Object.keys(ok.envelope.data).sort(), ["expires_at", "manifest_revision", "page_id", "playlist_id", "screen_id"]);
  assert.equal(ok.envelope.data.page_id, PAGE);
  assert.equal(ok.envelope.data.playlist_id, "pl_LOBBY");
  const call = calls()[0];
  assert.equal(call?.method, "POST");
  assert.equal(call?.path, `/api/screens/${LOBBY}/play-page`);
  assert.deepEqual(call?.body, { page_id: PAGE });
  assert.ok(call?.headers?.["idempotency-key"]);

  const human = await cli(["--human", "screen", "play-page", LOBBY, "--page-id", PAGE], transport, env);
  assert.equal(human.code, ExitCode.Success, human.stdout);
  assert.match(human.stdout, /Play-page accepted/);

  const elsewhere = await cli(["--json", "screen", "play-page", LOBBY, "--page-id", "pg_OTHER"], transport, env);
  assert.equal(elsewhere.code, ExitCode.Conflict, elsewhere.stdout);
  assert.equal(elsewhere.envelope.error?.code, "page_not_on_screen");
  assert.equal(elsewhere.envelope.error?.next?.command, `screenrig screen show ${LOBBY}`);

  const unsupported = await cli(["--json", "screen", "play-page", PLAIN, "--page-id", PAGE], transport, env);
  assert.equal(unsupported.code, ExitCode.Conflict, unsupported.stdout);
  assert.equal(unsupported.envelope.error?.code, "play_page_unsupported");
  assert.match(unsupported.envelope.error!.detail, /Nothing was sent/);

  const sent = calls().length;
  for (const [argv, pattern] of [
    [["screen", "play-page", LOBBY], /--page-id/],
    [["screen", "play-page", "--page-id", PAGE], /requires <id>/],
    [["screen", "play-page", LOBBY, PLAIN, "--page-id", PAGE], /extra arguments/],
    [["screen", "play-page", LOBBY, "--page-id", "x".repeat(129)], /1 to 128/],
  ] as const) {
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    assert.match(`${result.envelope.error?.detail ?? ""}`, pattern);
  }
  assert.equal(calls().length, sent, "usage errors must not reach the server");
});

test("screen display: --power or trailing on|off, until rules, fleet action, Display lines", async () => {
  const env = await enrolled();
  const transport = fleet();
  const off = await cli(["--json", "screen", "display", LOBBY, "--power", "off", "--for", "2h"], transport, env);
  assert.equal(off.code, ExitCode.Success, off.stdout);
  const call = transport.calls.find((item) => item.path === `/api/screens/${LOBBY}/display`);
  assert.deepEqual(call?.body, { power: "off", until: "2026-08-14T19:00:00Z" });
  assert.equal(off.envelope.data.display.requested, "off");
  const human = await cli(["--human", "screen", "display", LOBBY, "on"], transport, env);
  assert.match(human.stdout, /^Display on on scr_LOBBYAAAAAAAAAAAAAAAAAA until the display schedule's next boundary, or until replaced\nDisplay: on \(manual override until replaced\)/m);
  assert.deepEqual(transport.calls.filter((item) => item.path === `/api/screens/${LOBBY}/display`).at(-1)?.body, { power: "on" });
  const mixed = await cli(["--json", "screen", "display", LOBBY, "on", "--power", "off"], transport, env);
  assert.equal(mixed.code, ExitCode.Usage);
  const none = await cli(["--json", "screen", "display", LOBBY], transport, env);
  assert.equal(none.code, ExitCode.Usage);
  const badUntil = await cli(["--json", "screen", "display", LOBBY, "--power", "off", "--until", "tomorrow"], transport, env);
  assert.equal(badUntil.code, ExitCode.Usage);
  const tag = await cli(["--json", "screen", "display", "--tag", "Lobby", "--power", "off", "--until", "2026-08-15T07:00:00Z"], transport, env);
  assert.equal(tag.code, ExitCode.Success, tag.stdout);
  const actions = transport.calls.filter((item) => item.path === "/api/screens/actions").at(-1);
  assert.deepEqual(actions?.body, { selector: { by: "tag", tag: "Lobby" }, action: { type: "display", power: "off", until: "2026-08-15T07:00:00Z" } });
  const ids = await cli(["--json", "screen", "display", LOBBY, PLAIN, "off"], transport, env);
  assert.deepEqual((transport.calls.filter((item) => item.path === "/api/screens/actions").at(-1)?.body as { selector: unknown }).selector, { by: "ids", screen_ids: [LOBBY, PLAIN] });
  assert.equal(ids.envelope.data.succeeded, 2);
});

test("screen display-schedule show|set|clear, single and fleet", async () => {
  const env = await enrolled();
  const transport = fleet();
  await writeFile(path.join(env.cwd, "hours.json"), JSON.stringify(HOURS));
  const set = await cli(["--json", "screen", "display-schedule", "set", LOBBY, "--file", "hours.json", "--expect-rev", "3"], transport, env);
  assert.equal(set.code, ExitCode.Success, set.stdout);
  const put = transport.calls.find((item) => item.method === "PUT" && item.path === `/api/screens/${LOBBY}/display-schedule`);
  assert.deepEqual(put?.body, HOURS);
  assert.equal(put?.headers?.["if-match"], '"3"');
  const shown = await cli(["--human", "screen", "display-schedule", "show", LOBBY], transport, env);
  assert.match(shown.stdout, /Display schedule: enabled, 2 windows in America\/Los_Angeles\n  mon,tue,wed,thu,fri 07:00-19:00\n  sat all day/);
  const fleetSet = await cli(["--json", "screen", "display-schedule", "set", "--tag", "Lobby", "--file", "hours.json"], transport, env);
  assert.equal(fleetSet.envelope.data.action, "set_display_schedule");
  const cleared = await cli(["--json", "screen", "display-schedule", "clear", LOBBY], transport, env);
  assert.equal(cleared.code, ExitCode.Success);
  assert.equal(transport.calls.at(-1)?.method, "DELETE");
  const fleetClear = await cli(["--json", "screen", "display-schedule", "clear", LOBBY, PLAIN], transport, env);
  assert.equal(fleetClear.envelope.data.action, "clear_display_schedule");
  const bad = await cli(["--json", "screen", "display-schedule", "set", LOBBY, "--file", "missing.json"], transport, env);
  assert.notEqual(bad.code, ExitCode.Success);
});

test("Display lines show requested, source, until in the screen zone, schedule, and reported with stale", () => {
  assert.deepEqual(displayLines({
    requested: "off", source: "schedule", until: "2026-08-15T14:00:00Z",
    schedule: { enabled: true, windows: [{ days: ["mon"], start: "07:00", end: "19:00" }], updated_at: "2026-08-01T00:00:00Z" },
    reported: { power: "standby", connected: true, reported_at: "2026-08-14T16:00:00Z", stale: true },
  }, "America/Los_Angeles"), [
    "Display: off (display schedule until 2026-08-15 07:00 America/Los_Angeles)",
    "Display schedule: enabled, 1 window in America/Los_Angeles",
    "  mon 07:00-19:00",
    "Display reported: power standby, connected at 2026-08-14T16:00:00Z (stale: no report for over 35 minutes)",
  ]);
  assert.deepEqual(displayLines(undefined, undefined), []);
});

test("screen.reboot_requested and screen.display_changed render as logfmt", () => {
  const base = { cursor: "ev1_1", at: "2026-08-14T17:00:00Z", severity: "info", resource: { type: "screen", id: LOBBY } };
  assert.equal(formatEventLine({ ...base, type: "screen.reboot_requested", message: "Screen reboot requested", details: { reboot_id: "rbt_ABCDEFGH12", expires_at: "2026-08-14T17:10:00Z" } } as never),
    `at=2026-08-14T17:00:00Z type=screen.reboot_requested severity=info resource_type=screen resource_id=${LOBBY} expires_at=2026-08-14T17:10:00Z reboot_id=rbt_ABCDEFGH12`);
  assert.equal(formatEventLine({ ...base, type: "screen.display_changed", message: "Screen display override set", details: { change: "override", override_id: "dov_1", power: "off", until: null } } as never),
    `at=2026-08-14T17:00:00Z type=screen.display_changed severity=info resource_type=screen resource_id=${LOBBY} change=override override_id=dov_1 power=off until=none`);
  assert.equal(formatEventLine({ ...base, type: "screen.display_changed", message: "Screen display schedule updated", details: { change: "schedule", enabled: true, windows: 2 } } as never),
    `at=2026-08-14T17:00:00Z type=screen.display_changed severity=info resource_type=screen resource_id=${LOBBY} change=schedule enabled=true windows=2`);
});

test("screen display clear: DELETE with optional --expect-rev, fleet display_clear, pending hint", async () => {
  const env = await enrolled();
  const transport = fleet();
  await cli(["--json", "screen", "display", LOBBY, "--power", "off"], transport, env);
  const cleared = await cli(["--json", "screen", "display", "clear", LOBBY, "--expect-rev", "4"], transport, env);
  assert.equal(cleared.code, ExitCode.Success, cleared.stdout);
  const call = transport.calls.find((item) => item.method === "DELETE" && item.path === `/api/screens/${LOBBY}/display`);
  assert.equal(call?.headers?.["if-match"], '"4"');
  assert.equal(cleared.envelope.data.display, undefined, "no override and no schedule leaves no display state");
  const tag = await cli(["--json", "screen", "display", "clear", "--tag", "Lobby"], transport, env);
  assert.equal(tag.envelope.data.action, "display_clear");
  assert.equal(tag.envelope.data.succeeded, 2);
  const revOnFleet = await cli(["--json", "screen", "display", "clear", LOBBY, PLAIN, "--expect-rev", "2"], transport, env);
  assert.equal(revOnFleet.code, ExitCode.Usage);

  transport.putScreen!(screen("scr_PENDINGAAAAAAAAAAAAAAAA", { state: "pairing_pending", online: false }));
  const pending = await cli(["--json", "screen", "display", "scr_PENDINGAAAAAAAAAAAAAAAA", "--power", "off"], transport, env);
  assert.equal(pending.code, ExitCode.Conflict, pending.stdout);
  assert.match(pending.envelope.error!.next!.reason, /no paired Player yet/);
});

test("reboot schedule files are checked locally with paths, and show output round-trips", () => {
  assert.deepEqual(rebootScheduleWrite(HOURS), HOURS);
  assert.deepEqual(rebootScheduleWrite({ ok: true, data: { reboot_schedule: { ...HOURS, updated_at: "x" }, next_reboot_at: "2026-08-15T11:00:00Z" } }), HOURS, "show output round-trips");
  for (const [document, pattern] of [
    [{ windows: HOURS.windows }, /Reboot schedule file: enabled must be true or false/],
    [{ enabled: true, windows: [] }, /windows must list 1 to 16/],
    [{ enabled: true, windows: [{ days: ["mon"], start: "07:00" }] }, /windows\[0\] must set both start and end/],
    [{ enabled: true, windows: HOURS.windows, extra: 1 }, /unknown field "extra"/],
    [[], /screen reboot-schedule clear/],
  ] as const) {
    assert.throws(() => rebootScheduleWrite(document), pattern);
  }
});

test("--window reads DAYS HH:MM-HH:MM or the campaign DAYS@HH:MM-HH:MM, at least five minutes long, up to sixteen", () => {
  assert.deepEqual(rebootWindowList(rebootWindowOption("Mon-Sun 04:00-04:30")), [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "04:00", end: "04:30" }]);
  assert.deepEqual(rebootWindowList(rebootWindowOption("sat,sun@22:00-02:00", rebootWindowOption("Mon-Fri 04:00-04:05"))), [
    { days: ["mon", "tue", "wed", "thu", "fri"], start: "04:00", end: "04:05" }, { days: ["sat", "sun"], start: "22:00", end: "02:00" },
  ]);
  assert.deepEqual(rebootWindowList(rebootWindowOption("daily")), [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }], "a window without edges is the whole day");
  assert.throws(() => rebootWindowOption("Mon 04:00-04:04"), /5 minutes to 24 hours/);
  assert.throws(() => rebootWindowOption("Funday 04:00-05:00"), /--window "Funday 04:00-05:00": "funday" is not a day/);
  assert.throws(() => rebootWindowOption("Mon 25:00-26:00"), /--window/);
  let accumulated: string | undefined;
  for (let index = 0; index < 16; index += 1) accumulated = rebootWindowOption("Mon 04:00-04:30", accumulated);
  assert.throws(() => rebootWindowOption("Mon 04:00-04:30", accumulated), /at most 16 windows/);
});

test("screen reboot-schedule set sends the windows from --window, one screen or a fleet, with the revision guard", async () => {
  const env = await enrolled();
  const transport = fleet();
  const set = await cli(["--json", "screen", "reboot-schedule", "set", LOBBY, "--window", "Mon-Sun 04:00-04:30", "--expect-rev", "3"], transport, env);
  assert.equal(set.code, ExitCode.Success, set.stdout);
  const put = transport.calls.find((item) => item.method === "PUT" && item.path === `/api/screens/${LOBBY}/reboot-schedule`);
  assert.deepEqual(put?.body, { enabled: true, windows: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "04:00", end: "04:30" }] });
  assert.equal(put?.headers?.["if-match"], '"3"');
  assert.ok(put?.headers?.["idempotency-key"]);
  assert.equal(set.envelope.data.reboot_schedule.enabled, true);
  assert.equal(set.envelope.data.next_reboot_at, "2026-08-15T11:00:00.000Z");

  const two = await cli(["--json", "screen", "reboot-schedule", "set", LOBBY, "--window", "Mon-Fri 04:00-04:30", "--window", "Sat,Sun 05:00-06:00", "--disabled"], transport, env);
  assert.equal(two.code, ExitCode.Success, two.stdout);
  assert.deepEqual(transport.calls.filter((item) => item.method === "PUT").at(-1)?.body, {
    enabled: false, windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "04:00", end: "04:30" }, { days: ["sat", "sun"], start: "05:00", end: "06:00" }],
  });
  assert.equal(two.envelope.data.next_reboot_at, undefined, "a disabled schedule has no next reboot");

  await writeFile(path.join(env.cwd, "reboots.json"), JSON.stringify(HOURS));
  const file = await cli(["--json", "screen", "reboot-schedule", "set", LOBBY, "--file", "reboots.json"], transport, env);
  assert.equal(file.code, ExitCode.Success, file.stdout);
  assert.deepEqual(transport.calls.filter((item) => item.method === "PUT").at(-1)?.body, HOURS);

  const fleetSet = await cli(["--json", "screen", "reboot-schedule", "set", "--tag", "Lobby", "--window", "Mon-Sun 04:00-04:30"], transport, env);
  assert.equal(fleetSet.envelope.data.action, "set_reboot_schedule");
  assert.deepEqual((transport.calls.filter((item) => item.path === "/api/screens/actions").at(-1)?.body as { action: unknown }).action,
    { type: "set_reboot_schedule", enabled: true, windows: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "04:00", end: "04:30" }] });
  assert.equal(fleetSet.envelope.data.succeeded, 1);
  assert.equal(fleetSet.envelope.data.failed, 1, "the screen that cannot reboot fails alone");
  assert.equal(fleetSet.envelope.data.results.find((item: any) => item.screen_id === PLAIN).problem.code, "reboot_unsupported");
  assert.notEqual(fleetSet.code, ExitCode.Success);
  const ids = await cli(["--json", "screen", "reboot-schedule", "set", LOBBY, PLAIN, "--window", "daily@03:00-03:30", "--disabled"], transport, env);
  assert.deepEqual((transport.calls.filter((item) => item.path === "/api/screens/actions").at(-1)?.body as { selector: unknown }).selector, { by: "ids", screen_ids: [LOBBY, PLAIN] });
  assert.equal(ids.envelope.data.action, "set_reboot_schedule");
});

test("screen reboot-schedule set refuses what needs a timezone or a reboot-capable Player, and bad input sends nothing", async () => {
  const env = await enrolled();
  const transport = fleet();
  const refused = await cli(["--json", "screen", "reboot-schedule", "set", PLAIN, "--window", "Mon-Sun 04:00-04:30"], transport, env);
  assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
  assert.equal(refused.envelope.error?.code, "reboot_unsupported");
  assert.match(refused.envelope.error!.detail, /Nothing was stored/);
  assert.equal(refused.envelope.error?.next?.command, `screenrig screen show ${PLAIN}`);
  transport.putScreen!(screen("scr_NOZONEAAAAAAAAAAAAAAAAA", { timezone: undefined, host: { platform: "android", capabilities: ["reboot"] } as unknown as Screen["host"] }));
  const zone = await cli(["--json", "screen", "reboot-schedule", "set", "scr_NOZONEAAAAAAAAAAAAAAAAA", "--window", "Mon-Sun 04:00-04:30"], transport, env);
  assert.equal(zone.code, ExitCode.Client, zone.stdout);
  assert.equal(zone.envelope.error?.code, "invalid_request");
  assert.equal(zone.envelope.error?.next?.command, "screenrig screen set-timezone scr_NOZONEAAAAAAAAAAAAAAAAA --timezone ZONE");
  const sent = transport.calls.filter((item) => item.path.includes("reboot-schedule") || item.path === "/api/screens/actions").length;
  for (const argv of [
    ["screen", "reboot-schedule", "set", LOBBY],
    ["screen", "reboot-schedule", "set", LOBBY, "--window", "Mon 04:00-04:03"],
    ["screen", "reboot-schedule", "set", LOBBY, "--window", "Mon 04:00-05:00", "--file", "reboots.json"],
    ["screen", "reboot-schedule", "set", LOBBY, "--file", "reboots.json", "--disabled"],
    ["screen", "reboot-schedule", "set", LOBBY, "--window", "Mon 04:00-05:00", "--enabled", "--disabled"],
    ["screen", "reboot-schedule", "set", LOBBY, PLAIN, "--window", "Mon 04:00-05:00", "--expect-rev", "3"],
    ["screen", "reboot-schedule", "set", "--window", "Mon 04:00-05:00"],
  ]) {
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
  }
  assert.equal(transport.calls.filter((item) => item.path.includes("reboot-schedule") || item.path === "/api/screens/actions").length, sent, "usage errors must not reach the server");
});

test("screen reboot-schedule show prints the windows and the next reboot, clear removes them, single and fleet", async () => {
  const env = await enrolled();
  const transport = fleet();
  const none = await cli(["--human", "screen", "reboot-schedule", "show", LOBBY], transport, env);
  assert.match(none.stdout, /No reboot schedule/);
  await cli(["--json", "screen", "reboot-schedule", "set", LOBBY, "--window", "Mon-Fri 04:00-04:30"], transport, env);
  const json = await cli(["--json", "screen", "reboot-schedule", "show", LOBBY], transport, env);
  assert.equal(json.envelope.data.reboot_schedule.windows[0].start, "04:00");
  assert.equal(json.envelope.data.next_reboot_at, "2026-08-15T11:00:00.000Z");
  const shown = await cli(["--human", "screen", "reboot-schedule", "show", LOBBY], transport, env);
  assert.match(shown.stdout, /Reboot schedule: enabled, 1 window in America\/Los_Angeles\n  mon,tue,wed,thu,fri 04:00-04:30\nNext reboot: 2026-08-15 04:00 America\/Los_Angeles/);
  const screenShow = await cli(["--human", "screen", "show", LOBBY], transport, env);
  assert.match(screenShow.stdout, /Reboot schedule: enabled, 1 window in America\/Los_Angeles/);
  assert.match(screenShow.stdout, /"next_reboot_at": "2026-08-15T11:00:00.000Z"/, "screen show passes next_reboot_at through");
  const listed = await cli(["--json", "screen", "list"], transport, env);
  assert.equal(listed.envelope.data.items.find((item: any) => item.id === LOBBY).next_reboot_at, "2026-08-15T11:00:00.000Z");

  const cleared = await cli(["--json", "screen", "reboot-schedule", "clear", LOBBY, "--expect-rev", "4"], transport, env);
  assert.equal(cleared.code, ExitCode.Success, cleared.stdout);
  const del = transport.calls.at(-1);
  assert.equal(del?.method, "DELETE");
  assert.equal(del?.path, `/api/screens/${LOBBY}/reboot-schedule`);
  assert.equal(del?.headers?.["if-match"], '"4"');
  assert.equal(cleared.envelope.data.reboot_schedule, undefined);
  const fleetClear = await cli(["--json", "screen", "reboot-schedule", "clear", LOBBY, PLAIN], transport, env);
  assert.equal(fleetClear.envelope.data.action, "clear_reboot_schedule");
  assert.equal(fleetClear.envelope.data.succeeded, 2);
  const tagClear = await cli(["--json", "screen", "reboot-schedule", "clear", "--tag", "Lobby"], transport, env);
  assert.deepEqual((transport.calls.filter((item) => item.path === "/api/screens/actions").at(-1)?.body as { selector: unknown }).selector, { by: "tag", tag: "Lobby" });
  assert.equal(tagClear.code, ExitCode.Success, tagClear.stdout);
  const missing = await cli(["--json", "screen", "reboot-schedule", "show", "scr_MISSINGAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
});

test("Reboot schedule lines show the windows in the screen zone and the next reboot; commands show where a reboot came from", () => {
  assert.deepEqual(rebootScheduleLines({ enabled: true, windows: [{ days: ["mon"], start: "04:00", end: "04:30" }, { days: ["sat"] }], updated_at: "2026-08-01T00:00:00Z" }, "2026-08-15T11:00:00Z", "America/Los_Angeles"), [
    "Reboot schedule: enabled, 2 windows in America/Los_Angeles",
    "  mon 04:00-04:30",
    "  sat all day",
    "Next reboot: 2026-08-15 04:00 America/Los_Angeles",
  ]);
  assert.deepEqual(rebootScheduleLines({ enabled: false, windows: [{ days: ["mon"], start: "04:00", end: "04:30" }], updated_at: "x" }, null, undefined), ["Reboot schedule: disabled (no reboots), 1 window", "  mon 04:00-04:30"]);
  assert.deepEqual(rebootScheduleLines(undefined, undefined, "UTC"), []);
  const command = (id: string, source?: "schedule") => ({ id, type: "reboot" as const, state: "done" as const, requested_at: "2026-08-14T11:00:00Z", expires_at: "2026-08-14T11:30:00Z", sent_at: "2026-08-14T11:00:00Z", done_at: "2026-08-14T11:01:00Z", ...(source ? { source } : {}) });
  const withSource = commandLines({ id: LOBBY, commands: [command("rbt_MANUAL001"), command("rbt_SCHED0001", "schedule")] } as unknown as Screen);
  assert.match(withSource[1]!, /SOURCE$/);
  assert.match(withSource[2]!, /manual$/);
  assert.match(withSource[3]!, /schedule$/);
  const plain = commandLines({ id: LOBBY, commands: [command("rbt_MANUAL001")] } as unknown as Screen);
  assert.doesNotMatch(plain[1]!, /SOURCE/, "a screen with no scheduled reboot keeps its table");
});

test("scheduled reboot events render as logfmt without repeating their canned message", () => {
  const base = { cursor: "ev1_1", at: "2026-08-14T17:00:00Z", severity: "info", resource: { type: "screen", id: LOBBY } };
  assert.equal(formatEventLine({ ...base, type: "screen.reboot_requested", message: "Screen reboot requested", details: { reboot_id: "rbt_ABCDEFGH12", expires_at: "2026-08-14T17:30:00Z", state: "sent", source: "schedule" } } as never),
    `at=2026-08-14T17:00:00Z type=screen.reboot_requested severity=info resource_type=screen resource_id=${LOBBY} expires_at=2026-08-14T17:30:00Z reboot_id=rbt_ABCDEFGH12 source=schedule state=sent`);
  assert.equal(formatEventLine({ ...base, type: "screen.reboot_schedule_changed", message: "Screen reboot schedule updated", details: { enabled: true, windows: 1 } } as never),
    `at=2026-08-14T17:00:00Z type=screen.reboot_schedule_changed severity=info resource_type=screen resource_id=${LOBBY} enabled=true windows=1`);
  assert.equal(formatEventLine({ ...base, type: "screen.reboot_skipped", message: "Scheduled reboot skipped", details: { reason: "reboot_pending" } } as never),
    `at=2026-08-14T17:00:00Z type=screen.reboot_skipped severity=info resource_type=screen resource_id=${LOBBY} reason=reboot_pending`);
});
