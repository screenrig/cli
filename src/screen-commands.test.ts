import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Screen } from "./adapters/protocol.js";
import { formatEventLine } from "./commands.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help.js";
import { run, type CliRuntime } from "./main.js";
import { commandLines, commandResultText, expiresInSeconds, identifyDurationMs, replacedByLines, suspendMessage, suspensionLines } from "./screen-commands.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";

const START = new Date("2026-08-14T17:00:00.000Z");
const LOBBY = "scr_LOBBYAAAAAAAAAAAAAAAAAA";
const DARK = "scr_DARKAAAAAAAAAAAAAAAAAAAA";
const PLAIN = "scr_PLAINAAAAAAAAAAAAAAAAAA";
const OLD = "scr_OLDAAAAAAAAAAAAAAAAAAAAA";
const NEW = "scr_NEWAAAAAAAAAAAAAAAAAAAAA";

interface Env { fs: ConfigFs; cwd: string }
interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; hint?: string; next?: { command: string; reason: string } };
  warnings?: Array<{ code: string; message: string }>;
}

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<Env> {
  const configDir = await testTemp("screen-commands-cfg-");
  const cwd = await testTemp("screen-commands-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env): Promise<{ code: number; stdout: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  void collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr, now: () => START, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await out;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human */ }
  return { code, stdout: text, envelope };
}

function screen(id: string, extra: Partial<Screen> = {}): Screen {
  return {
    id, label: id.slice(4, 9), public_id: `pub_${id}`, state: "active", online: true, revision: 3, manifest_revision: 1, content_access_generation: 1,
    timezone: "America/Los_Angeles", tags: ["Lobby"], created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", ...extra,
  } as Screen;
}

const host = (...capabilities: string[]) => ({ platform: "android", capabilities }) as unknown as Screen["host"];

/** LOBBY and PLAIN are online; DARK is offline. Only LOBBY and DARK declare reboot and identify. */
function fleet(clock: { now: Date } = { now: START }): FakeTransport {
  const transport = memoryBackend({ now: () => clock.now });
  transport.putScreen!(screen(LOBBY, { host: host("reboot", "identify", "display_power.cec") }));
  transport.putScreen!(screen(DARK, { online: false, host: host("reboot", "identify") }));
  transport.putScreen!(screen(PLAIN, { host: host("display_power.scrim") }));
  return transport;
}

const posts = (transport: FakeTransport, suffix: string) => transport.calls.filter((item) => item.method === "POST" && item.path.endsWith(suffix));

test("--expires-in and --duration are whole-unit durations inside the contract's bounds", () => {
  for (const [text, seconds] of [["60s", 60], ["90s", 90], ["30m", 1800], ["2h", 7200], ["1h30m", 5400], ["24h", 86400], ["1d", 86400], [" 2h ", 7200]] as const) {
    assert.equal(expiresInSeconds(text), seconds, text);
  }
  for (const text of ["59s", "25h", "1d1s", "2d", "0s", "0m", "90", "2 hours", "", "-5m", "1.5h", "2H", "h", "1h1h", "30m1h", "soon"]) {
    assert.throws(() => expiresInSeconds(text), /--expires-in (takes a duration with a unit, such as 90s, 30m, 2h, or 1d, from 60s to 24h|must be from 60s to 24h)\./, JSON.stringify(text));
  }
  assert.throws(() => expiresInSeconds("59s"), /must be from 60s to 24h/);
  assert.throws(() => expiresInSeconds("soon"), /takes a duration with a unit/);

  assert.equal(identifyDurationMs("2s"), 2000);
  assert.equal(identifyDurationMs("60s"), 60_000);
  assert.equal(identifyDurationMs("1m30s"), 90_000);
  assert.equal(identifyDurationMs("10m"), 600_000);
  for (const text of ["1s", "601s", "11m", "1h", "0s", "60", "two minutes", ""]) {
    assert.throws(() => identifyDurationMs(text), /--duration (takes a duration with a unit, such as 30s, 2m, or 1m30s, from 2s to 10m|must be from 2s to 10m)\./, JSON.stringify(text));
  }
});

test("a suspension message is trimmed, 1 to 280 characters, with line feed the only control character", () => {
  assert.equal(suspendMessage("  Closed for stocktake  "), "Closed for stocktake");
  assert.equal(suspendMessage("Closed\nBack at 9am"), "Closed\nBack at 9am");
  assert.equal(suspendMessage("x".repeat(280)).length, 280);
  assert.equal([...suspendMessage("🙂".repeat(280))].length, 280, "characters, not UTF-16 units");
  for (const text of ["", "   ", "\n\n", "x".repeat(281), "🙂".repeat(281), "tab\there", "bell\u0007", "carriage\rreturn", "escape\u001b[2J", "c1\u009b"]) {
    assert.throws(() => suspendMessage(text), /--message must be 1 to 280 characters, and line feed is the only control character\./, JSON.stringify(text));
  }
});

test("screen identify: no body by default, --duration becomes duration_ms, refusals explained, bad durations never sent", async () => {
  const env = await enrolled();
  const transport = fleet();
  const ok = await cli(["--json", "screen", "identify", LOBBY], transport, env);
  assert.equal(ok.code, ExitCode.Success, ok.stdout);
  assert.deepEqual(Object.keys(ok.envelope.data).sort(), ["duration_ms", "expires_at", "identify_id"]);
  assert.match(ok.envelope.data.identify_id, /^idf_[A-Za-z0-9_-]{8,64}$/);
  assert.equal(ok.envelope.data.duration_ms, 60_000);
  assert.equal(ok.envelope.data.expires_at, "2026-08-14T17:01:00.000Z");
  const first = posts(transport, "/identify")[0]!;
  assert.equal(first.path, `/api/screens/${LOBBY}/identify`);
  assert.equal(first.body, undefined, "the server's 60 seconds applies");
  assert.ok(first.headers?.["idempotency-key"]);

  const long = await cli(["--json", "screen", "identify", LOBBY, "--duration", "2m"], transport, env);
  assert.equal(long.code, ExitCode.Success, long.stdout);
  assert.deepEqual(posts(transport, "/identify").at(-1)?.body, { duration_ms: 120_000 });
  assert.equal(long.envelope.data.duration_ms, 120_000);

  const human = await cli(["--human", "screen", "identify", LOBBY, "--duration", "30s"], transport, env);
  assert.equal(human.code, ExitCode.Success, human.stdout);
  assert.match(human.stdout, /^Identify accepted\nscreen_id: scr_LOBBYAAAAAAAAAAAAAAAAAA\nidentify_id: idf_\S+\nduration_ms: 30000\nexpires_at: 2026-08-14T17:01:00\.000Z\n/m);
  assert.match(human.stdout, /The Player shows the screen's name over its content for the duration/);

  const unsupported = await cli(["--json", "screen", "identify", PLAIN], transport, env);
  assert.equal(unsupported.code, ExitCode.Conflict, unsupported.stdout);
  assert.equal(unsupported.envelope.error?.code, "identify_unsupported");
  assert.match(unsupported.envelope.error!.detail, /Nothing was sent\. Only a Player that declares the identify capability in its host report shows the overlay; update this device's Player, or show the name with screen toast\./);
  assert.equal(unsupported.envelope.error?.next?.command, `screenrig screen show ${PLAIN}`);

  transport.putScreen!(screen("scr_PENDINGAAAAAAAAAAAAAAAA", { state: "pairing_pending", online: false }));
  const pending = await cli(["--json", "screen", "identify", "scr_PENDINGAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(pending.code, ExitCode.Conflict, pending.stdout);
  assert.equal(pending.envelope.error?.code, "resource_conflict");
  assert.match(pending.envelope.error!.next!.reason, /no Player to show an overlay/);
  transport.putScreen!(screen("scr_ARCHIVEDAAAAAAAAAAAAAAAA", { state: "archived" }));
  const archived = await cli(["--json", "screen", "identify", "scr_ARCHIVEDAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(archived.code, ExitCode.Conflict, archived.stdout);
  assert.equal(archived.envelope.error?.code, "screen_archived");
  assert.equal(archived.envelope.error?.next?.command, "screenrig screen unarchive scr_ARCHIVEDAAAAAAAAAAAAAAAA");

  const missing = await cli(["--json", "screen", "identify", "scr_MISSINGAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(missing.code, ExitCode.NotFound, missing.stdout);

  const sent = posts(transport, "/identify").length;
  for (const [argv, pattern, code] of [
    [["screen", "identify", LOBBY, "--duration", "1s"], /--duration must be from 2s to 10m/, ExitCode.Usage],
    [["screen", "identify", LOBBY, "--duration", "11m"], /--duration must be from 2s to 10m/, ExitCode.Usage],
    [["screen", "identify", LOBBY, "--duration", "60"], /--duration takes a duration with a unit/, ExitCode.Usage],
    [["screen", "identify"], /screen identify requires <id>\./, ExitCode.Usage],
    [["screen", "identify", LOBBY, DARK], /extra arguments/, ExitCode.Usage],
  ] as const) {
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, code, `${argv.join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error?.detail ?? "", pattern);
  }
  assert.equal(posts(transport, "/identify").length, sent, "usage errors must not reach the server");
});

test("screen suspend and resume: closed bodies, revision guard, show prints the notice, refusals explained", async () => {
  const env = await enrolled();
  const transport = fleet();
  const suspended = await cli(["--json", "screen", "suspend", LOBBY, "--message", "  Closed for stocktake. Back at 9am.  "], transport, env);
  assert.equal(suspended.code, ExitCode.Success, suspended.stdout);
  const call = posts(transport, "/suspend")[0]!;
  assert.equal(call.path, `/api/screens/${LOBBY}/suspend`);
  assert.deepEqual(call.body, { message: "Closed for stocktake. Back at 9am." });
  assert.ok(call.headers?.["idempotency-key"]);
  assert.equal(call.headers?.["if-match"], undefined, "If-Match is optional");
  assert.deepEqual(suspended.envelope.data.suspension, { message: "Closed for stocktake. Back at 9am.", since: "2026-08-14T17:00:00.000Z" });
  assert.equal(suspended.envelope.data.revision, 4);

  const human = await cli(["--human", "screen", "suspend", LOBBY, "--message", "Closed", "--expect-rev", "4"], transport, env);
  assert.equal(human.code, ExitCode.Success, human.stdout);
  assert.equal(posts(transport, "/suspend").at(-1)?.headers?.["if-match"], '"4"');
  assert.match(human.stdout, /^Suspended screen scr_LOBBYAAAAAAAAAAAAAAAAAA\nsince: 2026-08-14T17:00:00\.000Z\nrevision: 5\nThe screen shows your notice instead of its content until screen resume scr_LOBBYAAAAAAAAAAAAAAAAAA; its playlist, schedule and settings are unchanged\./m);

  // A later suspend replaces the message and keeps since.
  const clock = { now: START };
  const later = fleet(clock);
  await cli(["--json", "screen", "suspend", LOBBY, "--message", "One"], later, env);
  clock.now = new Date(START.getTime() + 3_600_000);
  const replaced = await cli(["--json", "screen", "suspend", LOBBY, "--message", "Two\nlines"], later, env);
  assert.deepEqual(replaced.envelope.data.suspension, { message: "Two\nlines", since: "2026-08-14T17:00:00.000Z" });

  const shown = await cli(["--human", "screen", "show", LOBBY], transport, env);
  assert.match(shown.stdout, /^Suspended since 2026-08-14T17:00:00\.000Z: Closed\nThe screen shows this notice instead of its content; its playlist, schedule and settings are unchanged\. screen resume scr_LOBBYAAAAAAAAAAAAAAAAAA ends it\.$/m);
  const shownJson = await cli(["--json", "screen", "show", LOBBY], transport, env);
  assert.equal(shownJson.envelope.data.suspension.message, "Closed");

  const stale = await cli(["--json", "screen", "suspend", LOBBY, "--message", "Closed", "--expect-rev", "1"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition, stale.stdout);
  assert.equal(stale.envelope.error?.code, "revision_conflict");

  const resumed = await cli(["--human", "screen", "resume", LOBBY], transport, env);
  assert.equal(resumed.code, ExitCode.Success, resumed.stdout);
  const resume = posts(transport, "/resume")[0]!;
  assert.equal(resume.path, `/api/screens/${LOBBY}/resume`);
  assert.equal(resume.body, undefined, "resume takes no body");
  assert.ok(resume.headers?.["idempotency-key"]);
  assert.match(resumed.stdout, /^Resumed screen scr_LOBBYAAAAAAAAAAAAAAAAAA\nrevision: 6\nThe screen shows its own content again\./m);
  const after = await cli(["--json", "screen", "show", LOBBY], transport, env);
  assert.equal(after.envelope.data.suspension, undefined);
  assert.doesNotMatch((await cli(["--human", "screen", "show", LOBBY], transport, env)).stdout, /Suspended since/);

  // A screen that is not suspended answers unchanged: the revision stays.
  const again = await cli(["--json", "screen", "resume", LOBBY, "--expect-rev", "6"], transport, env);
  assert.equal(again.code, ExitCode.Success, again.stdout);
  assert.equal(again.envelope.data.revision, 6);
  assert.equal(posts(transport, "/resume").at(-1)?.headers?.["if-match"], '"6"');

  transport.putScreen!(screen("scr_ARCHIVEDAAAAAAAAAAAAAAAA", { state: "archived" }));
  for (const argv of [["suspend", "scr_ARCHIVEDAAAAAAAAAAAAAAAA", "--message", "Closed"], ["resume", "scr_ARCHIVEDAAAAAAAAAAAAAAAA"]]) {
    const refused = await cli(["--json", "screen", ...argv], transport, env);
    assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
    assert.equal(refused.envelope.error?.code, "screen_archived");
    assert.equal(refused.envelope.error?.next?.command, "screenrig screen unarchive scr_ARCHIVEDAAAAAAAAAAAAAAAA");
  }

  const sent = posts(transport, "/suspend").length;
  for (const [argv, pattern] of [
    [["screen", "suspend", LOBBY], /screen suspend requires --message\./],
    [["screen", "suspend", "--message", "Closed"], /screen suspend requires <id>\./],
    [["screen", "suspend", LOBBY, "--message", "   "], /--message must be 1 to 280 characters/],
    [["screen", "suspend", LOBBY, "--message", "x".repeat(281)], /--message must be 1 to 280 characters/],
    [["screen", "suspend", LOBBY, "--message", "bell\u0007"], /line feed is the only control character/],
    [["screen", "suspend", LOBBY, "--message", "Closed", "--expect-rev", "oops"], /--expect-rev|revision/i],
    [["screen", "resume"], /screen resume requires <id>\./],
  ] as Array<[string[], RegExp]>) {
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error?.detail ?? "", pattern, argv.join(" "));
  }
  assert.equal(posts(transport, "/suspend").length, sent, "usage errors must not reach the server");
});

test("screen replace: sends {with} under an idempotency key, the kept screen takes the device and the other is archived as replaced", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => START });
  transport.putScreen!(screen(OLD, {
    label: "Lobby", online: false, tags: ["Lobby"], playlist_id: "pl_LOBBY", host: host("reboot"),
    health: { reported_at: "2026-08-13T00:00:00Z", stale: true } as Screen["health"],
    commands: [{ id: "rbt_OLDQUEUED1", type: "reboot", state: "queued", requested_at: "2026-08-13T00:00:00Z", expires_at: "2026-08-15T00:00:00Z" }],
  }));
  transport.putScreen!(screen(NEW, { label: "New", host: host("reboot", "identify", "display.wall") }));

  const replaced = await cli(["--json", "screen", "replace", OLD, "--with", NEW], transport, env);
  assert.equal(replaced.code, ExitCode.Success, replaced.stdout);
  const call = posts(transport, "/replace")[0]!;
  assert.equal(call.path, `/api/screens/${OLD}/replace`);
  assert.deepEqual(call.body, { with: NEW });
  assert.ok(call.headers?.["idempotency-key"], "replace always carries an idempotency key");
  assert.equal(call.headers?.["if-match"], undefined, "If-Match is optional");
  assert.equal(replaced.envelope.data.id, OLD);
  assert.equal(replaced.envelope.data.label, "Lobby");
  assert.equal(replaced.envelope.data.playlist_id, "pl_LOBBY");
  assert.deepEqual(replaced.envelope.data.host.capabilities, ["reboot", "identify", "display.wall"], "the kept screen takes the replacement's Player");
  assert.equal(replaced.envelope.data.health, undefined, "device read models start over");
  assert.equal(replaced.envelope.data.commands, undefined);
  assert.equal(replaced.envelope.data.revision, 4);

  const gone = await cli(["--json", "screen", "show", NEW], transport, env);
  assert.equal(gone.envelope.data.state, "archived");
  assert.equal(gone.envelope.data.archive_reason, "replaced");
  assert.equal(gone.envelope.data.replaced_by, OLD);
  const human = await cli(["--human", "screen", "show", NEW], transport, env);
  assert.match(human.stdout, /^Archived \(replaced\) at 2026-08-14T17:00:00\.000Z\nA screen replace moved this screen's device onto another screen, so this screen keeps no device binding\.\nscreen unarchive cannot restore it; screen delete scr_NEWAAAAAAAAAAAAAAAAAAAAA removes it\.\nReplaced by scr_OLDAAAAAAAAAAAAAAAAAAAAA: its device now opens that screen, and a browser that still opens this screen's public URL plays that screen\.$/m);
  assert.doesNotMatch(human.stdout, /Restore with screen unarchive/);

  const unknown = await cli(["--human", "screen", "replace", OLD, "--with", "scr_OTHERAAAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(unknown.code, ExitCode.NotFound, "an unknown replacement is not_found");
});

test("screen replace: every refusal keeps its exit code and explains the next step; usage errors never reach the server", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => START });
  transport.putScreen!(screen(OLD, { host: host("reboot") }));
  transport.putScreen!(screen(NEW, { host: host("reboot") }));
  transport.putScreen!(screen("scr_PENDINGAAAAAAAAAAAAAAAA", { state: "pairing_pending", online: false }));
  transport.putScreen!(screen("scr_ARCHIVEDAAAAAAAAAAAAAAAA", { state: "archived" }));
  transport.putScreen!(screen("scr_WALLAAAAAAAAAAAAAAAAAAAA", { wall: { outputs: ["HDMI-A-1", "HDMI-A-2"], arrangement: "row" } as Screen["wall"], host: host("display.wall") }));

  const pending = await cli(["--json", "screen", "replace", OLD, "--with", "scr_PENDINGAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(pending.code, ExitCode.Conflict, pending.stdout);
  assert.equal(pending.envelope.error?.code, "resource_conflict");
  assert.equal(pending.envelope.error?.next?.command, "screenrig screen show scr_PENDINGAAAAAAAAAAAAAAAA");
  assert.match(pending.envelope.error!.next!.reason, /Replace needs two active screens with a paired Player: scr_OLDAAAAAAAAAAAAAAAAAAAAA, which keeps its settings, and scr_PENDINGAAAAAAAAAAAAAAAA, whose device takes over\./);

  const archived = await cli(["--json", "screen", "replace", OLD, "--with", "scr_ARCHIVEDAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(archived.code, ExitCode.Conflict, archived.stdout);
  assert.equal(archived.envelope.error?.code, "screen_archived");
  assert.match(archived.envelope.error!.next!.reason, /one archived as replaced cannot be restored/);
  const archivedKept = await cli(["--json", "screen", "replace", "scr_ARCHIVEDAAAAAAAAAAAAAAAA", "--with", NEW], transport, env);
  assert.equal(archivedKept.envelope.error?.code, "screen_archived");

  // A video wall needs a replacement Player that declares display.wall.
  const wall = await cli(["--json", "screen", "replace", "scr_WALLAAAAAAAAAAAAAAAAAAAA", "--with", NEW], transport, env);
  assert.equal(wall.code, ExitCode.Conflict, wall.stdout);
  assert.equal(wall.envelope.error?.code, "wall_unsupported");
  assert.match(wall.envelope.error!.detail, /Nothing was changed\./);
  assert.equal(wall.envelope.error?.next?.command, `screenrig screen show ${NEW}`);

  const missing = await cli(["--json", "screen", "replace", "scr_MISSINGAAAAAAAAAAAAAAAA", "--with", NEW], transport, env);
  assert.equal(missing.code, ExitCode.NotFound, missing.stdout);
  assert.equal(missing.envelope.error?.code, "not_found");

  const stale = await cli(["--json", "screen", "replace", OLD, "--with", NEW, "--expect-rev", "99"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition, stale.stdout);
  assert.equal(stale.envelope.error?.code, "revision_conflict");
  const guarded = await cli(["--json", "screen", "replace", OLD, "--with", NEW, "--expect-rev", "3"], transport, env);
  assert.equal(guarded.code, ExitCode.Success, guarded.stdout);
  assert.equal(posts(transport, "/replace").at(-1)?.headers?.["if-match"], '"3"');

  const sent = posts(transport, "/replace").length;
  for (const [argv, pattern] of [
    [["screen", "replace", OLD, "--with", OLD], /--with must name another screen than <id>/],
    [["screen", "replace", OLD], /screen replace requires --with\./],
    [["screen", "replace", "--with", NEW], /screen replace requires <id>\./],
    [["screen", "replace", OLD, NEW, "--with", NEW], /extra arguments/],
  ] as Array<[string[], RegExp]>) {
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error?.detail ?? "", pattern, argv.join(" "));
  }
  assert.equal(posts(transport, "/replace").length, sent, "usage errors must not reach the server");
});

test("reboot and reload to an offline screen queue; show lists the commands; screen command cancel cancels only a queued one", async () => {
  const env = await enrolled();
  const clock = { now: START };
  const transport = fleet(clock);

  const queued = await cli(["--json", "screen", "reboot", DARK], transport, env);
  assert.equal(queued.code, ExitCode.Success, queued.stdout);
  assert.deepEqual(queued.envelope.data, { reboot_id: "rbt_00000001", expires_at: "2026-08-15T17:00:00.000Z", state: "queued" });
  assert.equal(posts(transport, "/reboot")[0]!.body, undefined, "an empty body keeps the server's 24 hours");
  const sentToOnline = await cli(["--json", "screen", "reboot", LOBBY], transport, env);
  assert.equal(sentToOnline.envelope.data.state, "sent");

  const human = await cli(["--human", "screen", "reboot", DARK], transport, env);
  assert.match(human.stdout, /^Reboot accepted\nscreen_id: scr_DARKAAAAAAAAAAAAAAAAAAAA\nreboot_id: rbt_\S+\nstate: queued\nexpires_at: 2026-08-15T17:00:00\.000Z\n/m);
  assert.match(human.stdout, /The screen is offline, so the reboot waits: it is sent when the screen comes online before expires_at, and screen show lists it under commands \(done once the device reports it booted\)\. Cancel it with screen command cancel scr_DARKAAAAAAAAAAAAAAAAAAAA rbt_\S+\./);

  // The second queued reboot supersedes the first, and a reload queues beside them.
  const reload = await cli(["--json", "screen", "reload", DARK], transport, env);
  assert.equal(reload.envelope.data.state, "queued");
  const shown = await cli(["--human", "screen", "show", DARK], transport, env);
  assert.match(shown.stdout, /^Commands\nTYPE\s+ID\s+STATE\s+EXPIRES\s+SENT\s+DONE$/m);
  assert.match(shown.stdout, /^reboot\s+rbt_00000001\s+superseded\s+2026-08-15T17:00:00\.000Z$/m);
  assert.match(shown.stdout, /^reboot\s+rbt_00000003\s+queued\s+2026-08-15T17:00:00\.000Z$/m);
  assert.match(shown.stdout, /^reload\s+rld_00000004\s+queued\s+2026-08-15T17:00:00\.000Z$/m);
  assert.match(shown.stdout, /^rbt_00000003 is queued: it is sent when the screen comes online before it expires\. Cancel it with screen command cancel scr_DARKAAAAAAAAAAAAAAAAAAAA rbt_00000003\.$/m);
  const lobby = await cli(["--human", "screen", "show", LOBBY], transport, env);
  assert.match(lobby.stdout, /^reboot\s+rbt_00000002\s+sent\s+2026-08-15T17:00:00\.000Z\s+2026-08-14T17:00:00\.000Z$/m);
  assert.doesNotMatch(lobby.stdout, /is queued: it is sent/);

  const cancelled = await cli(["--json", "screen", "command", "cancel", DARK, "rbt_00000003"], transport, env);
  assert.equal(cancelled.code, ExitCode.Success, cancelled.stdout);
  const call = posts(transport, "/cancel")[0]!;
  assert.equal(call.path, `/api/screens/${DARK}/commands/rbt_00000003/cancel`);
  assert.equal(call.body, undefined);
  assert.ok(call.headers?.["idempotency-key"]);
  assert.equal(call.headers?.["if-match"], undefined, "If-Match is optional");
  assert.equal(cancelled.envelope.data.id, DARK, "the answer is the screen");
  assert.equal(cancelled.envelope.data.commands.find((item: { id: string }) => item.id === "rbt_00000003").state, "cancelled");
  const text = await cli(["--human", "screen", "command", "cancel", DARK, "rld_00000004", "--expect-rev", "3"], transport, env);
  assert.equal(text.code, ExitCode.Success, text.stdout);
  assert.equal(posts(transport, "/cancel").at(-1)?.headers?.["if-match"], '"3"');
  assert.match(text.stdout, /^Cancelled command rld_00000004 on scr_DARKAAAAAAAAAAAAAAAAAAAA: it is never sent\.$/m);

  // Only a queued command can be cancelled: sent, done, expired, cancelled and superseded are refused.
  for (const [screenId, commandId, detail] of [
    [DARK, "rbt_00000003", /no longer queued/],
    [DARK, "rbt_00000001", /no longer queued/],
    [LOBBY, "rbt_00000002", /already sent/],
  ] as const) {
    const refused = await cli(["--json", "screen", "command", "cancel", screenId, commandId], transport, env);
    assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
    assert.equal(refused.envelope.error?.code, "resource_conflict");
    assert.match(refused.envelope.error!.detail, detail);
    assert.equal(refused.envelope.error?.next?.command, `screenrig screen show ${screenId}`);
  }
  const unknown = await cli(["--json", "screen", "command", "cancel", DARK, "rbt_NOSUCHONE"], transport, env);
  assert.equal(unknown.code, ExitCode.NotFound, unknown.stdout);
  assert.equal(unknown.envelope.error?.code, "not_found");
  assert.equal(unknown.envelope.error?.next?.command, `screenrig screen show ${DARK}`);
  const noScreen = await cli(["--json", "screen", "command", "cancel", "scr_MISSINGAAAAAAAAAAAAAAAA", "rbt_00000003"], transport, env);
  assert.equal(noScreen.code, ExitCode.NotFound, noScreen.stdout);
  assert.equal(noScreen.envelope.error?.next, undefined, "a missing screen keeps the generic not_found guidance");
  const stale =await cli(["--json", "screen", "command", "cancel", DARK, "rbt_00000003", "--expect-rev", "1"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition, stale.stdout);

  // A queued command past its expiry reads expired, and expired is not cancellable.
  const short = await cli(["--json", "screen", "reload", DARK, "--expires-in", "1h"], transport, env);
  clock.now = new Date(START.getTime() + 2 * 3_600_000);
  const expired = await cli(["--human", "screen", "show", DARK], transport, env);
  assert.match(expired.stdout, new RegExp(`^reload\\s+${short.envelope.data.reload_id}\\s+expired\\s+2026-08-14T18:00:00\\.000Z$`, "m"));
  assert.doesNotMatch(expired.stdout, /is queued: it is sent/);
  const late = await cli(["--json", "screen", "command", "cancel", DARK, short.envelope.data.reload_id], transport, env);
  assert.equal(late.code, ExitCode.Conflict, late.stdout);
  assert.match(late.envelope.error!.detail, /no longer queued/);

  const sentCalls = posts(transport, "/cancel").length;
  for (const [argv, pattern] of [
    [["screen", "command", "cancel", DARK], /screen command cancel requires <id> <command_id>\./],
    [["screen", "command", "cancel"], /screen command cancel requires <id> <command_id>\./],
    [["screen", "command", "cancel", DARK, "rbt_00000003", "extra"], /extra arguments/],
  ] as Array<[string[], RegExp]>) {
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error?.detail ?? "", pattern, argv.join(" "));
  }
  assert.equal(posts(transport, "/cancel").length, sentCalls, "usage errors must not reach the server");
  assert.equal((await cli(["--json", "screen", "command", "--help"], transport, env)).code, ExitCode.Success);
});

const MAINTENANCE_CASES = [
  { name: "clear-cache", route: "/clear-cache", type: "clear_cache", title: "Clear cache accepted" },
  { name: "restart-app", route: "/restart-app", type: "restart_app", title: "Restart app accepted" },
  { name: "update-software", route: "/update", type: "update", title: "Update software accepted" },
] as const;

/** LOBBY (online) and DARK (offline) declare all three capabilities; PLAIN declares none; OLD is archived. */
function maintenanceFleet(clock: { now: Date } = { now: START }): FakeTransport {
  const transport = memoryBackend({ now: () => clock.now });
  transport.putScreen!(screen(LOBBY, { host: host("clear_cache", "restart_app", "update") }));
  transport.putScreen!(screen(DARK, { online: false, host: host("clear_cache", "restart_app", "update") }));
  transport.putScreen!(screen(PLAIN, { host: host("reboot") }));
  transport.putScreen!(screen(OLD, { state: "archived", host: host("clear_cache", "restart_app", "update") }));
  transport.putScreen!(screen(NEW, { state: "pairing_pending" }));
  return transport;
}

test("clear-cache, restart-app and update-software: one screen sent or queued, JSON and human answers, lifetime and revision guard", async () => {
  const env = await enrolled();
  for (const item of MAINTENANCE_CASES) {
    const transport = maintenanceFleet();
    const sent = await cli(["--json", "screen", item.name, LOBBY], transport, env);
    assert.equal(sent.code, ExitCode.Success, sent.stdout);
    assert.equal(posts(transport, item.route)[0]!.path, `/api/screens/${LOBBY}${item.route}`);
    assert.equal(posts(transport, item.route)[0]!.body, undefined, "an empty body keeps the server's 24 hours");
    assert.ok(posts(transport, item.route)[0]!.headers?.["idempotency-key"]);
    assert.equal(sent.envelope.data.command, item.type);
    assert.equal(sent.envelope.data.state, "sent");
    assert.match(sent.envelope.data.command_id, /^cmd_\d{8}$/);
    assert.equal(sent.envelope.data.expires_at, "2026-08-15T17:00:00.000Z");

    const queued = await cli(["--human", "screen", item.name, DARK, "--expires-in", "2h", "--expect-rev", "3"], transport, env);
    assert.equal(queued.code, ExitCode.Success, queued.stdout);
    assert.deepEqual(posts(transport, item.route).at(-1)!.body, { expires_in_s: 7200 });
    assert.equal(posts(transport, item.route).at(-1)!.headers?.["if-match"], '"3"');
    assert.match(queued.stdout, new RegExp(`^${item.title}\\nscreen_id: ${DARK}\\ncommand_id: cmd_\\d{8}\\ncommand: ${item.type}\\nstate: queued\\nexpires_at: 2026-08-14T19:00:00\\.000Z\\n`, "m"));
    assert.match(queued.stdout, new RegExp(`The screen is offline, so ${item.name} waits: it is sent when the screen comes online before expires_at, and screen show lists it under commands \\(done or failed, with the cause the Player reports\\)\\. Cancel it with screen command cancel ${DARK} cmd_\\d{8}\\.`));
    const onlineHuman = await cli(["--human", "screen", item.name, LOBBY], transport, env);
    assert.match(onlineHuman.stdout, /^state: sent$/m);
    assert.match(onlineHuman.stdout, /screen show lists the result under commands \(done or failed, with the cause the Player reports\)\./);

    const stale = await cli(["--json", "screen", item.name, LOBBY, "--expect-rev", "1"], transport, env);
    assert.equal(stale.code, ExitCode.Precondition, stale.stdout);
  }
});

test("a queued maintenance command shows in screen show, supersedes an older queued one of its type, and is cancelled by screen command cancel", async () => {
  const env = await enrolled();
  const transport = maintenanceFleet();
  const first = await cli(["--json", "screen", "clear-cache", DARK], transport, env);
  const second = await cli(["--json", "screen", "clear-cache", DARK], transport, env);
  const restart = await cli(["--json", "screen", "restart-app", DARK], transport, env);
  const shown = await cli(["--human", "screen", "show", DARK], transport, env);
  assert.match(shown.stdout, new RegExp(`^clear_cache\\s+${first.envelope.data.command_id}\\s+superseded\\s+2026-08-15T17:00:00\\.000Z$`, "m"));
  assert.match(shown.stdout, new RegExp(`^clear_cache\\s+${second.envelope.data.command_id}\\s+queued\\s+2026-08-15T17:00:00\\.000Z$`, "m"));
  assert.match(shown.stdout, new RegExp(`^restart_app\\s+${restart.envelope.data.command_id}\\s+queued\\s+`, "m"));
  const cancelled = await cli(["--json", "screen", "command", "cancel", DARK, restart.envelope.data.command_id], transport, env);
  assert.equal(cancelled.code, ExitCode.Success, cancelled.stdout);
  assert.equal(cancelled.envelope.data.commands.find((item: { id: string }) => item.id === restart.envelope.data.command_id).state, "cancelled");
});

test("clear-cache, restart-app and update-software refused for a Player without the capability: command_unsupported explained, nothing recorded", async () => {
  const env = await enrolled();
  for (const item of MAINTENANCE_CASES) {
    const transport = maintenanceFleet();
    const refused = await cli(["--json", "screen", item.name, PLAIN], transport, env);
    assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
    assert.equal(refused.envelope.ok, false);
    assert.equal(refused.envelope.error?.code, "command_unsupported");
    assert.match(refused.envelope.error!.detail, new RegExp(`Nothing was sent\\. A Player that does not declare the ${item.type} capability in its host report \\(screen show lists host capabilities\\)`));
    assert.equal(refused.envelope.error?.next?.command, `screenrig screen show ${PLAIN}`);
    assert.match(refused.envelope.error?.next?.reason ?? "", new RegExp(`screen ${item.name} reaches only a Player that declares ${item.type}`));
    const shown = await cli(["--json", "screen", "show", PLAIN], transport, env);
    assert.equal(shown.envelope.data.commands, undefined, "a refused command is never recorded");

    const archived = await cli(["--json", "screen", item.name, OLD], transport, env);
    assert.equal(archived.code, ExitCode.Conflict, archived.stdout);
    assert.equal(archived.envelope.error?.code, "screen_archived");
    assert.equal(archived.envelope.error?.next?.command, `screenrig screen unarchive ${OLD}`);
    const pending = await cli(["--json", "screen", item.name, NEW], transport, env);
    assert.equal(pending.code, ExitCode.Conflict, pending.stdout);
    assert.equal(pending.envelope.error?.code, "resource_conflict");
    assert.equal(pending.envelope.error?.next?.command, `screenrig screen show ${NEW}`);
    const missing = await cli(["--json", "screen", item.name, "scr_MISSINGAAAAAAAAAAAAAAAA"], transport, env);
    assert.equal(missing.code, ExitCode.NotFound, missing.stdout);
  }
});

test("a server problem hint on command_unsupported reaches the output", async () => {
  const env = await enrolled();
  const hint = "This screen's Player does not support this action (clear_cache, restart_app or update). Read the screen's host capabilities, or use screen reload to refresh content.";
  const transport = new FakeTransport().on("POST", `/api/screens/${PLAIN}/clear-cache`, () => ({
    status: 409, headers: { "content-type": "application/problem+json" },
    body: { type: "https://screenrig.ai/problems/command-unsupported", title: "Screen cannot do this remotely", status: 409, code: "command_unsupported", detail: "The screen's Player does not declare clear_cache.", hint },
  }));
  const refused = await cli(["--json", "screen", "clear-cache", PLAIN], transport, env);
  assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
  assert.equal(refused.envelope.error?.hint, hint);
});

test("maintenance fleet actions: --tag, --folder and ids behind --yes, per-screen results, partial failure follows the fleet exit rule", async () => {
  const env = await enrolled();
  for (const item of MAINTENANCE_CASES) {
    const transport = maintenanceFleet();
    const actions = () => transport.calls.filter((call) => call.path === "/api/screens/actions");
    const bare = await cli(["--json", "screen", item.name, "--tag", "Lobby"], transport, env);
    assert.equal(bare.code, ExitCode.Usage, bare.stdout);
    assert.match(bare.envelope.error!.detail, new RegExp(`screen ${item.name} with several screens, --tag or --folder acts on every matching Player; add --yes to confirm\\.`));
    assert.equal(bare.envelope.error?.next?.command, `screenrig screen ${item.name} --tag Lobby --yes`);
    assert.equal(actions().length, 0, "an unconfirmed fleet never reaches the server");
    const revision = await cli(["--json", "screen", item.name, "--tag", "Lobby", "--yes", "--expect-rev", "3"], transport, env);
    assert.equal(revision.code, ExitCode.Usage, revision.stdout);
    assert.equal(actions().length, 0);

    const byTag = await cli(["--json", "screen", item.name, "--tag", "Lobby", "--yes", "--expires-in", "30m"], transport, env);
    assert.deepEqual(actions().at(-1)?.body, { selector: { by: "tag", tag: "Lobby" }, action: { type: item.type, expires_in_s: 1800 } });
    assert.equal(byTag.envelope.data.action, item.type);
    assert.notEqual(byTag.code, ExitCode.Success, "PLAIN declares no capability, so the fleet exit rule applies");
    assert.ok(byTag.envelope.warnings?.some((warning) => warning.code === "fleet_partial_failure"));
    const outcome = Object.fromEntries(byTag.envelope.data.results.map((entry: { screen_id: string; status: string; command?: { state: string; command: string }; problem?: { code: string } }) =>
      [entry.screen_id, entry.status === "ok" ? `${entry.command?.command}:${entry.command?.state}` : entry.problem?.code]));
    assert.deepEqual(outcome, { [LOBBY]: `${item.type}:sent`, [DARK]: `${item.type}:queued`, [PLAIN]: "command_unsupported" });

    const byIds = await cli(["--human", "screen", item.name, LOBBY, DARK, "--yes", "--expires-in", "2h"], transport, env);
    assert.equal(byIds.code, ExitCode.Success, byIds.stdout);
    assert.deepEqual(actions().at(-1)?.body, { selector: { by: "ids", screen_ids: [LOBBY, DARK] }, action: { type: item.type, expires_in_s: 7200 } });
    assert.match(byIds.stdout, new RegExp(`^Fleet ${item.name}: matched 2, succeeded 2, failed 0$`, "m"));
    assert.match(byIds.stdout, new RegExp(`^${DARK}\\s+ok\\s+${item.type} queued, expires 2026-08-14T19:00:00\\.000Z$`, "m"));
    assert.match(byIds.stdout, new RegExp(`^${LOBBY}\\s+ok\\s+${item.type} sent, expires 2026-08-14T19:00:00\\.000Z$`, "m"));

    const byFolder = await cli(["--json", "screen", item.name, "--folder", "sfd_NORTH", "--yes"], transport, env);
    assert.deepEqual(actions().at(-1)?.body, { selector: { by: "folder", folder_id: "sfd_NORTH" }, action: { type: item.type } }, "no expires_in_s unless --expires-in is given");
    assert.equal(byFolder.code, ExitCode.Success, "an empty folder matches nothing");
    assert.ok(byFolder.envelope.warnings?.some((warning) => warning.code === "fleet_no_match"));

    const sentCalls = transport.calls.length;
    for (const argv of [
      ["screen", item.name],
      ["screen", item.name, LOBBY, "--tag", "Lobby"],
      ["screen", item.name, "--tag", "Lobby", "--folder", "sfd_NORTH", "--yes"],
      ["screen", item.name, LOBBY, "--expires-in", "59s"],
      ["screen", item.name, "--tag", "Lobby", "--yes", "--expires-in", "25h"],
      ["screen", item.name, LOBBY, "--expires-in", "soon"],
    ]) {
      const result = await cli(["--json", ...argv], transport, env);
      assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    }
    assert.equal(transport.calls.length, sentCalls, "usage errors must not reach the server");
  }
});

test("a malformed maintenance answer is a local contract error", async () => {
  const env = await enrolled();
  for (const body of [
    { status: "accepted" },
    { command_id: "rbt_ABCDEFGH", command: "clear_cache", expires_at: "2026-08-15T17:00:00.000Z", state: "sent" },
    { command_id: "cmd_ABCDEFGH", command: "update", expires_at: "2026-08-15T17:00:00.000Z", state: "sent" },
    { command_id: "cmd_ABCDEFGH", command: "clear_cache", expires_at: "soon", state: "sent" },
    { command_id: "cmd_ABCDEFGH", command: "clear_cache", expires_at: "2026-08-15T17:00:00.000Z" },
    { command_id: "cmd_ABCDEFGH", command: "clear_cache", expires_at: "2026-08-15T17:00:00.000Z", state: "done" },
  ]) {
    const transport = new FakeTransport().on("POST", `/api/screens/${LOBBY}/clear-cache`, () => ({ status: 202, headers: {}, body }));
    const result = await cli(["--json", "screen", "clear-cache", LOBBY], transport, env);
    assert.notEqual(result.code, ExitCode.Success, JSON.stringify(body));
    assert.match(result.envelope.error!.detail, /ScreenMaintenanceAccepted/);
  }
});

test("--expires-in is expires_in_s on the single route and in the fleet action; omitted, nothing is sent", async () => {
  const env = await enrolled();
  const transport = fleet();
  const reload = await cli(["--json", "screen", "reload", DARK, "--expires-in", "2h"], transport, env);
  assert.equal(reload.code, ExitCode.Success, reload.stdout);
  assert.deepEqual(posts(transport, "/reload")[0]!.body, { expires_in_s: 7200 });
  assert.equal(reload.envelope.data.expires_at, "2026-08-14T19:00:00.000Z");
  assert.equal(reload.envelope.data.state, "queued");
  const reboot = await cli(["--json", "screen", "reboot", LOBBY, "--expires-in", "90s", "--expect-rev", "3"], transport, env);
  assert.equal(reboot.code, ExitCode.Success, reboot.stdout);
  assert.deepEqual(posts(transport, "/reboot")[0]!.body, { expires_in_s: 90 });
  assert.equal(posts(transport, "/reboot")[0]!.headers?.["if-match"], '"3"');
  assert.equal(reboot.envelope.data.expires_at, "2026-08-14T17:01:30.000Z");
  assert.equal(reboot.envelope.data.state, "sent");
  const day = await cli(["--json", "screen", "reload", LOBBY, "--expires-in", "24h"], transport, env);
  assert.deepEqual(posts(transport, "/reload").at(-1)!.body, { expires_in_s: 86_400 });
  assert.equal(day.envelope.data.state, "sent");
  await cli(["--json", "screen", "reload", LOBBY], transport, env);
  assert.equal(posts(transport, "/reload").at(-1)!.body, undefined);

  const actions = () => transport.calls.filter((item) => item.path === "/api/screens/actions");
  const fleetReload = await cli(["--json", "screen", "reload", "--tag", "Lobby", "--expires-in", "30m"], transport, env);
  assert.equal(fleetReload.code, ExitCode.Success, fleetReload.stdout);
  assert.deepEqual(actions().at(-1)?.body, { selector: { by: "tag", tag: "Lobby" }, action: { type: "reload", expires_in_s: 1800 } });
  const states = Object.fromEntries(fleetReload.envelope.data.results.map((item: { screen_id: string; reload: { state: string; expires_at: string } }) => [item.screen_id, item.reload]));
  assert.equal(states[LOBBY].state, "sent");
  assert.equal(states[DARK].state, "queued");
  assert.equal(states[PLAIN].state, "sent");
  assert.equal(states[DARK].expires_at, "2026-08-14T17:30:00.000Z");
  const humanFleet = await cli(["--human", "screen", "reload", LOBBY, DARK, "--expires-in", "45m"], transport, env);
  assert.deepEqual((actions().at(-1)?.body as { action: unknown }).action, { type: "reload", expires_in_s: 2700 });
  assert.match(humanFleet.stdout, /^Fleet reload: matched 2, succeeded 2, failed 0$/m);
  assert.match(humanFleet.stdout, new RegExp(`^${LOBBY}\\s+ok\\s+reload sent, expires 2026-08-14T17:45:00\\.000Z$`, "m"));
  assert.match(humanFleet.stdout, new RegExp(`^${DARK}\\s+ok\\s+reload queued, expires 2026-08-14T17:45:00\\.000Z$`, "m"));

  await cli(["--json", "screen", "reload", "--tag", "Lobby"], transport, env);
  assert.deepEqual(actions().at(-1)?.body, { selector: { by: "tag", tag: "Lobby" }, action: { type: "reload" } }, "no expires_in_s unless --expires-in is given");

  const fleetReboot = await cli(["--json", "screen", "reboot", "--tag", "Lobby", "--yes", "--expires-in", "1d"], transport, env);
  assert.deepEqual(actions().at(-1)?.body, { selector: { by: "tag", tag: "Lobby" }, action: { type: "reboot", expires_in_s: 86_400 } });
  assert.notEqual(fleetReboot.code, ExitCode.Success, "PLAIN declares no reboot, so a partial fleet failure follows the fleet exit rule");
  const rebootStates = Object.fromEntries(fleetReboot.envelope.data.results.map((item: { screen_id: string; status: string; reboot?: { state: string } }) => [item.screen_id, item.status === "ok" ? item.reboot?.state : item.status]));
  assert.deepEqual(rebootStates, { [LOBBY]: "sent", [DARK]: "queued", [PLAIN]: "failed" });
  const humanReboot = await cli(["--human", "screen", "reboot", LOBBY, DARK, "--yes", "--expires-in", "2h"], transport, env);
  assert.match(humanReboot.stdout, new RegExp(`^${DARK}\\s+ok\\s+reboot queued, expires 2026-08-14T19:00:00\\.000Z$`, "m"));
  await cli(["--json", "screen", "reboot", "--tag", "Lobby", "--yes"], transport, env);
  assert.deepEqual(actions().at(-1)?.body, { selector: { by: "tag", tag: "Lobby" }, action: { type: "reboot" } });

  const sent = transport.calls.length;
  for (const [argv, pattern] of [
    [["screen", "reload", DARK, "--expires-in", "59s"], /--expires-in must be from 60s to 24h/],
    [["screen", "reload", "--tag", "Lobby", "--expires-in", "25h"], /--expires-in must be from 60s to 24h/],
    [["screen", "reboot", DARK, "--expires-in", "soon"], /--expires-in takes a duration with a unit, such as 90s, 30m, 2h, or 1d/],
    [["screen", "reboot", "--tag", "Lobby", "--yes", "--expires-in", "90"], /--expires-in takes a duration with a unit/],
    [["screen", "reload", DARK, "--expires-in"], /--expires-in/],
  ] as Array<[string[], RegExp]>) {
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error?.detail ?? "", pattern, argv.join(" "));
  }
  assert.equal(transport.calls.length, sent, "invalid lifetimes must not reach the server");
});

test("an answer without state, or with a state outside queued or sent, is refused", async () => {
  const env = await enrolled();
  const transport = new FakeTransport()
    .on("POST", `/api/screens/${OLD}/reload`, () => ({ status: 202, headers: {}, body: { reload_id: "rld_NOSTATE001", expires_at: "2026-08-14T17:10:00.000Z" } }))
    .on("POST", `/api/screens/${NEW}/reload`, () => ({ status: 202, headers: {}, body: { reload_id: "rld_ODDSTATE01", expires_at: "2026-08-14T17:10:00.000Z", state: "later" } }));
  for (const id of [OLD, NEW]) {
    const refused = await cli(["--json", "screen", "reload", id], transport, env);
    assert.notEqual(refused.code, ExitCode.Success, refused.stdout);
    assert.match(refused.envelope.error!.detail, /ScreenReloadAccepted/);
  }
});

test("commandLines, suspensionLines and replacedByLines print only well-formed server values", () => {
  assert.deepEqual(commandLines(undefined), []);
  assert.deepEqual(commandLines(screen(LOBBY)), []);
  assert.deepEqual(commandLines(screen(LOBBY, { commands: [] })), []);
  // A result the Player reported adds the CAUSE column and a detail line; a table without causes keeps its columns.
  assert.deepEqual(commandLines(screen(LOBBY, {
    commands: [
      { id: "cmd_CLEAR0001", type: "clear_cache", state: "done", requested_at: "2026-08-14T10:00:00Z", expires_at: "2026-08-15T10:00:00Z", sent_at: "2026-08-14T10:00:01Z", done_at: "2026-08-14T10:00:09Z", cause: "cleared" },
      { id: "cmd_UPDATE001", type: "update", state: "failed", requested_at: "2026-08-14T11:00:00Z", expires_at: "2026-08-15T11:00:00Z", sent_at: "2026-08-14T11:00:01Z", done_at: "2026-08-14T11:00:40Z", cause: "download_failed", detail: "Release server unreachable\u001b[2J\nforged" },
      { id: "cmd_RESTART01", type: "restart_app", state: "sent", requested_at: "2026-08-14T12:00:00Z", expires_at: "2026-08-15T12:00:00Z", sent_at: "2026-08-14T12:00:01Z", cause: "BAD CAUSE\n" },
    ],
  })), [
    "Commands",
    "TYPE         ID             STATE   EXPIRES               SENT                  DONE                  CAUSE",
    "clear_cache  cmd_CLEAR0001  done    2026-08-15T10:00:00Z  2026-08-14T10:00:01Z  2026-08-14T10:00:09Z  cleared",
    "update       cmd_UPDATE001  failed  2026-08-15T11:00:00Z  2026-08-14T11:00:01Z  2026-08-14T11:00:40Z  download_failed",
    "restart_app  cmd_RESTART01  sent    2026-08-15T12:00:00Z  2026-08-14T12:00:01Z",
    "cmd_UPDATE001 failed (download_failed): Release server unreachable [2J forged",
  ]);
  assert.deepEqual(commandLines(screen(LOBBY, {
    commands: [
      { id: "rbt_ABCDEFGH", type: "reboot", state: "done", requested_at: "2026-08-14T10:00:00Z", expires_at: "2026-08-15T10:00:00Z", sent_at: "2026-08-14T10:05:00Z", done_at: "2026-08-14T10:06:30Z" },
      { id: "rld_ABCDEFGH", type: "reload", state: "queued", requested_at: "2026-08-14T11:00:00Z", expires_at: "2026-08-15T11:00:00Z" },
    ],
  })), [
    "Commands",
    "TYPE    ID            STATE   EXPIRES               SENT                  DONE",
    "reboot  rbt_ABCDEFGH  done    2026-08-15T10:00:00Z  2026-08-14T10:05:00Z  2026-08-14T10:06:30Z",
    "reload  rld_ABCDEFGH  queued  2026-08-15T11:00:00Z",
    `rld_ABCDEFGH is queued: it is sent when the screen comes online before it expires. Cancel it with screen command cancel ${LOBBY} rld_ABCDEFGH.`,
  ]);
  // Anything that is not a token, an enum value or an RFC 3339 time stays out of the terminal.
  const hostile = commandLines(screen(LOBBY, {
    commands: [
      { id: "rbt_ABCDEFGH\u001b[2J", type: "reboot", state: "queued" },
      { id: "rbt_ABC", type: "reboot", state: "queued" },
      { id: "rbt_GOODGOOD", type: "wipe", state: "queued" },
      { id: "rbt_GOODGOOD", type: "reboot", state: "exploded" },
      null,
      { id: "rld_GOODGOOD", type: "reload", state: "sent", expires_at: "tomorrow\nforged line", sent_at: "2026-08-14T10:05:00Z\u001b[2Jspoof" },
    ] as unknown as Screen["commands"],
  }));
  assert.equal(hostile.length, 3);
  assert.equal(hostile[2], "reload  rld_GOODGOOD  sent");
  assert.doesNotMatch(hostile.join("\n"), /\u001b|forged line|tomorrow/);

  assert.deepEqual(suspensionLines(undefined), []);
  assert.deepEqual(suspensionLines(screen(LOBBY)), []);
  assert.deepEqual(suspensionLines(screen(LOBBY, { suspension: { message: "Closed for stocktake", since: "2026-08-14T10:00:00Z" } })), [
    "Suspended since 2026-08-14T10:00:00Z: Closed for stocktake",
    `The screen shows this notice instead of its content; its playlist, schedule and settings are unchanged. screen resume ${LOBBY} ends it.`,
  ]);
  const notice = suspensionLines(screen(LOBBY, { suspension: { message: "Line one\nforged: line\u001b[2J", since: "not a time" } }));
  assert.equal(notice[0], "Suspended: Line one forged: line [2J", "server text: control characters become spaces, and a bad time is left out");
  assert.deepEqual(suspensionLines(screen(LOBBY, { suspension: { message: 42, since: "2026-08-14T10:00:00Z" } as unknown as Screen["suspension"] })), []);

  assert.deepEqual(replacedByLines(undefined), []);
  assert.deepEqual(replacedByLines(screen(OLD)), []);
  assert.deepEqual(replacedByLines(screen(NEW, { replaced_by: OLD })), [
    `Replaced by ${OLD}: its device now opens that screen, and a browser that still opens this screen's public URL plays that screen.`,
  ]);
  assert.deepEqual(replacedByLines(screen(NEW, { replaced_by: "scr_OLD\nforged" })), []);
  assert.deepEqual(replacedByLines(screen(NEW, { replaced_by: "not a screen" })), []);

  assert.equal(commandResultText("reload", { state: "queued", expires_at: "2026-08-14T17:45:00Z" }), "reload queued, expires 2026-08-14T17:45:00Z");
  assert.equal(commandResultText("reboot", { state: "sent", expires_at: "2026-08-14T17:45:00Z" }), "reboot sent, expires 2026-08-14T17:45:00Z");
  assert.equal(commandResultText("reload", { expires_at: "2026-08-14T17:45:00Z" }), "reload expires 2026-08-14T17:45:00Z");
  assert.equal(commandResultText("reload", { state: "maybe", expires_at: "2026-08-14T17:45:00Z" }), "reload expires 2026-08-14T17:45:00Z");
  assert.equal(commandResultText("reload", { state: "queued", expires_at: "later" }), undefined);
  assert.equal(commandResultText("reboot", undefined), undefined);
  assert.equal(commandResultText("clear_cache", { state: "queued", expires_at: "2026-08-14T17:45:00Z" }), "clear_cache queued, expires 2026-08-14T17:45:00Z");
});

test("screen.suspended prints the notice once, as message; screen.resumed and screen.replaced add no repeated sentence", () => {
  const base = { cursor: "ev1_1", at: "2026-08-14T17:00:00Z", severity: "info", resource: { type: "screen", id: LOBBY } };
  assert.equal(formatEventLine({ ...base, type: "screen.suspended", message: "Screen suspended", details: { message: "Closed for stocktake" } } as never),
    `at=2026-08-14T17:00:00Z type=screen.suspended severity=info resource_type=screen resource_id=${LOBBY} message="Closed for stocktake"`);
  assert.equal(formatEventLine({ ...base, type: "screen.resumed", message: "Screen resumed" } as never),
    `at=2026-08-14T17:00:00Z type=screen.resumed severity=info resource_type=screen resource_id=${LOBBY}`);
  assert.equal(formatEventLine({ ...base, type: "screen.replaced", message: "Screen replaced by another device", details: { from_screen_id: NEW } } as never),
    `at=2026-08-14T17:00:00Z type=screen.replaced severity=info resource_type=screen resource_id=${LOBBY} from_screen_id=${NEW}`);
});

test("help names each new command's arguments, required options and the parity usage forms", () => {
  const forms = {
    "screen identify": { args: ["id"], options: ["--duration"], required: [] },
    "screen suspend": { args: ["id"], options: ["--message", "--expect-rev"], required: ["--message"] },
    "screen resume": { args: ["id"], options: ["--expect-rev"], required: [] },
    "screen replace": { args: ["id"], options: ["--with", "--expect-rev"], required: ["--with"] },
    "screen command cancel": { args: ["id", "command_id"], options: ["--expect-rev"], required: [] },
  } as const;
  for (const [name, form] of Object.entries(forms)) {
    const help = commandHelp(name.split(" "));
    assert.deepEqual(help.arguments.map((argument) => argument.name), form.args, name);
    assert.ok(help.arguments.every((argument) => argument.required && !argument.variadic), `${name}: one screen, no fleet`);
    assert.deepEqual(help.options.map((option) => option.name).filter((option) => option !== "--help"), form.options, name);
    assert.deepEqual(help.options.filter((option) => option.required).map((option) => option.name), form.required, name);
    assert.ok(help.examples.length > 0, name);
    assert.ok(help.notes.length > 0, name);
  }
  assert.match(commandHelp(["screen", "identify"]).usage, /screen identify \[options\] <id>/);
  assert.match(commandHelp(["screen", "command", "cancel"]).usage, /screen command cancel \[options\] <id> <command_id>/);
  assert.equal(commandHelp(["screen", "command"]).kind, "group");
  for (const name of ["reload", "reboot", "clear-cache", "restart-app", "update-software"]) {
    const help = commandHelp(["screen", name]);
    assert.match(help.usage, new RegExp(`screen ${name} \\[options\\] \\[id\\.\\.\\.\\]`), "the usage line is unchanged");
    const option = help.options.find((item) => item.name === "--expires-in");
    assert.equal(option?.type, "value");
    assert.match(option?.description ?? "", /60s to 24h.*default 24h/);
  }
  for (const [name, capability] of [["clear-cache", "clear_cache"], ["restart-app", "restart_app"], ["update-software", "update"]] as const) {
    const help = commandHelp(["screen", name]);
    assert.deepEqual(help.options.map((option) => option.name).filter((option) => option !== "--help"), ["--tag", "--folder", "--yes", "--expires-in", "--expect-rev"], name);
    assert.match(help.usage, new RegExp(`declares the\\s+${capability} capability`), `${name} states the Player must support it`);
    assert.match(help.usage, /command_unsupported/, name);
    assert.match(help.usage, /screen show lists host capabilities/, name);
    assert.ok(help.examples.length >= 3, name);
  }
  assert.match(commandHelp(["screen", "reboot"]).usage, /an offline screen holds\s+it queued \(state queued\) and is sent it when it comes online, for 24 hours by\s+default/);
  assert.match(commandHelp(["screen", "show"]).usage, /data\.commands lists the screen's recent commands[\s\S]*clear_cache, restart_app and update[\s\S]*CAUSE column[\s\S]*data\.suspension[\s\S]*data\.replaced_by/);
});
