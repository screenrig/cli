import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import type { Screen } from "./adapters/protocol.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help-tree.js";
import { createMemoryLogger } from "./log/logger.js";
import { run } from "./main.js";
import { type CliRuntime } from "./runtime.js";
import { displayLines } from "./screen-display.js";
import {
  brightnessPatch, displayCecPatch, displayIdleAfterOption, displayIdlePatch, displayIdleWakeOption, displayOutputModeOption, displayOutputObservationLines, displayOutputPatch,
  displaySettingsLines, kioskLines, kioskLockPatch, menuPinFileOption, menuPinLines, menuPinWrite,
} from "./screen-device-settings.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";

const NOW = new Date("2026-08-14T17:00:00.000Z");
const LOBBY = "scr_LOBBYAAAAAAAAAAAAAAAAAA";

interface Env { fs: ConfigFs; cwd: string }
interface Envelope { ok: boolean; data?: any; error?: { code: string; detail: string; next?: { command: string } } }

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<Env> {
  const configDir = await testTemp("device-settings-cfg-");
  const cwd = await testTemp("device-settings-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, settings: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  void collect(stderr);
  const runtime: CliRuntime = {
    argv, settings: env.fs.settings, stdout, stderr, now: () => NOW, sleep: async () => undefined,
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

function seeded(extra: Partial<Screen> = {}): FakeTransport {
  const transport = memoryBackend({ now: () => NOW });
  transport.putScreen!({
    id: LOBBY, label: "Lobby", public_id: `pub_${LOBBY}`, state: "active", online: true, revision: 3, manifest_revision: 1, content_access_generation: 1,
    timezone: "America/Los_Angeles", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", ...extra,
  } as Screen);
  return transport;
}

const patches = (transport: FakeTransport) => transport.calls.filter((call) => call.method === "PATCH");

test("--after is a whole number of seconds from 30 to 86400", () => {
  for (const value of ["30", "300", "86400"]) assert.equal(displayIdleAfterOption(value), value);
  for (const value of ["29", "86401", "0", "-30", "1.5", "60s", "abc", "", " "]) {
    assert.throws(() => displayIdleAfterOption(value), /--after takes a whole number of seconds from 30 to 86400/, JSON.stringify(value));
  }
});

test("--wake takes touch, presence or both, each once, and is stored touch first", () => {
  assert.equal(displayIdleWakeOption("touch"), "touch");
  assert.equal(displayIdleWakeOption("presence"), "presence");
  assert.equal(displayIdleWakeOption("touch,presence"), "touch,presence");
  assert.equal(displayIdleWakeOption("presence,touch"), "touch,presence");
  for (const value of ["", "gesture", "touch,gesture", "touch,touch", "touch,,presence", "Touch"]) {
    assert.throws(() => displayIdleWakeOption(value), /--wake takes touch, presence or touch,presence/, JSON.stringify(value));
  }
});

test("each setting builds a patch with only its own member, and --off sends null", () => {
  assert.deepEqual(displayIdlePatch("300", "touch", false), { display: { idle: { after_s: 300, wake: ["touch"] } } });
  assert.deepEqual(displayIdlePatch("30", "presence,touch", false), { display: { idle: { after_s: 30, wake: ["touch", "presence"] } } });
  assert.deepEqual(displayIdlePatch(undefined, undefined, true), { display: { idle: null } });
  assert.throws(() => displayIdlePatch("300", undefined, false), /--after and --wake together, or --off/);
  assert.throws(() => displayIdlePatch(undefined, "touch", false), /--after and --wake together, or --off/);
  assert.throws(() => displayIdlePatch(undefined, undefined, false), /--after and --wake together, or --off/, "nothing given never clears idle");
  assert.throws(() => displayIdlePatch("300", "touch", true), /not both/);
  assert.deepEqual(brightnessPatch("auto"), { display: { brightness: { mode: "auto" } } });
  assert.deepEqual(brightnessPatch("fixed"), { display: { brightness: { mode: "fixed" } } });
  assert.throws(() => brightnessPatch("dim"), /--mode auto or fixed/);
  assert.throws(() => brightnessPatch(undefined), /--mode auto or fixed/);
  assert.deepEqual(kioskLockPatch(true, false), { kiosk: { lock: true } });
  assert.deepEqual(kioskLockPatch(false, true), { kiosk: { lock: false } });
  assert.throws(() => kioskLockPatch(false, false), /--on or --off/);
  assert.throws(() => kioskLockPatch(true, true), /--on or --off/);
});

test("screen display-idle patches only display.idle, with the revision guard when asked", async () => {
  const env = await enrolled();
  const transport = seeded();
  const set = await cli(["--json", "screen", "display-idle", LOBBY, "--after", "300", "--wake", "presence,touch", "--expect-rev", "3"], transport, env);
  assert.equal(set.code, ExitCode.Success, set.stdout);
  const call = patches(transport).at(-1)!;
  assert.equal(call.path, `/api/screens/${LOBBY}`);
  assert.deepEqual(call.body, { display: { idle: { after_s: 300, wake: ["touch", "presence"] } } });
  assert.equal(call.headers?.["if-match"], '"3"');
  assert.ok(call.headers?.["idempotency-key"], "the write is replay-safe");
  assert.deepEqual(set.envelope.data.display.idle, { after_s: 300, wake: ["touch", "presence"] });

  const unguarded = await cli(["--json", "screen", "display-idle", LOBBY, "--after", "30", "--wake", "touch"], transport, env);
  assert.equal(unguarded.code, ExitCode.Success, unguarded.stdout);
  assert.equal(patches(transport).at(-1)!.headers?.["if-match"], undefined);
  assert.deepEqual(unguarded.envelope.data.display.idle, { after_s: 30, wake: ["touch"] });
});

test("screen display-idle --off sends null and leaves brightness alone", async () => {
  const env = await enrolled();
  const transport = seeded();
  await cli(["--json", "screen", "brightness", LOBBY, "--mode", "auto"], transport, env);
  await cli(["--json", "screen", "display-idle", LOBBY, "--after", "600", "--wake", "touch"], transport, env);
  const off = await cli(["--json", "screen", "display-idle", LOBBY, "--off"], transport, env);
  assert.equal(off.code, ExitCode.Success, off.stdout);
  assert.deepEqual(patches(transport).at(-1)!.body, { display: { idle: null } });
  assert.equal(off.envelope.data.display.idle, undefined);
  assert.deepEqual(off.envelope.data.display.brightness, { mode: "auto" });
  const human = await cli(["--human", "screen", "display-idle", LOBBY, "--off"], transport, env);
  assert.match(human.stdout, new RegExp(`^Turned off display idle on ${LOBBY}$`, "m"));
});

test("screen brightness patches only display.brightness", async () => {
  const env = await enrolled();
  const transport = seeded();
  await cli(["--json", "screen", "display-idle", LOBBY, "--after", "120", "--wake", "touch"], transport, env);
  const auto = await cli(["--json", "screen", "brightness", LOBBY, "--mode", "auto", "--expect-rev", "5"], transport, env);
  assert.equal(auto.code, ExitCode.Success, auto.stdout);
  const call = patches(transport).at(-1)!;
  assert.deepEqual(call.body, { display: { brightness: { mode: "auto" } } });
  assert.equal(call.headers?.["if-match"], '"5"');
  assert.deepEqual(auto.envelope.data.display.idle, { after_s: 120, wake: ["touch"] }, "a member left out stays");
  const fixed = await cli(["--json", "screen", "brightness", LOBBY, "--mode", "fixed"], transport, env);
  assert.deepEqual(patches(transport).at(-1)!.body, { display: { brightness: { mode: "fixed" } } });
  assert.deepEqual(fixed.envelope.data.display.brightness, { mode: "fixed" });
  const human = await cli(["--human", "screen", "brightness", LOBBY, "--mode", "auto"], transport, env);
  assert.match(human.stdout, new RegExp(`^Set display brightness on ${LOBBY}: auto$`, "m"));
});

test("screen kiosk-lock --on and --off send kiosk.lock true and false", async () => {
  const env = await enrolled();
  const transport = seeded();
  const on = await cli(["--json", "screen", "kiosk-lock", LOBBY, "--on", "--expect-rev", "3"], transport, env);
  assert.equal(on.code, ExitCode.Success, on.stdout);
  const call = patches(transport).at(-1)!;
  assert.deepEqual(call.body, { kiosk: { lock: true } });
  assert.equal(call.headers?.["if-match"], '"3"');
  assert.deepEqual(on.envelope.data.kiosk, { lock: true });
  const off = await cli(["--json", "screen", "kiosk-lock", LOBBY, "--off"], transport, env);
  assert.equal(off.code, ExitCode.Success, off.stdout);
  assert.deepEqual(patches(transport).at(-1)!.body, { kiosk: { lock: false } });
  assert.equal(off.envelope.data.kiosk, undefined, "the screen carries the lock only while it is on");
  const human = await cli(["--human", "screen", "kiosk-lock", LOBBY, "--on"], transport, env);
  assert.match(human.stdout, new RegExp(`^Locked kiosk on ${LOBBY}: the Player pins itself to the screen$`, "m"));
});

test("--mode is auto or a video mode WIDTHxHEIGHTxFPS with an optional p or i", () => {
  for (const value of ["auto", "3840x2160x60p", "1920x1080x59.94i", "1280x720x50", "1920x1080x60p"]) assert.equal(displayOutputModeOption(value), value);
  for (const value of ["", "4k", "3840x2160", "3840x2160x60x", "0x1080x60p", "1920x1080x60.1234p", "AUTO", "1920x1080x60pp", "99999999x1080x60p"]) {
    assert.throws(() => displayOutputModeOption(value), /--mode takes auto or a video mode/, JSON.stringify(value));
  }
  assert.deepEqual(displayOutputPatch("3840x2160x60p", false), { display: { output: { mode: "3840x2160x60p" } } });
  assert.deepEqual(displayOutputPatch(undefined, true), { display: { output: null } });
  assert.throws(() => displayOutputPatch(undefined, false), /--mode MODE or --clear/);
  assert.throws(() => displayOutputPatch("auto", true), /--mode MODE or --clear/);
  assert.deepEqual(displayCecPatch(true, false, false), { display: { cec: { take_input: true } } });
  assert.deepEqual(displayCecPatch(false, true, false), { display: { cec: { take_input: false } } });
  assert.deepEqual(displayCecPatch(false, false, true), { display: { cec: null } });
  assert.throws(() => displayCecPatch(false, false, false), /exactly one of --on, --off or --clear/);
  assert.throws(() => displayCecPatch(true, true, false), /exactly one of --on, --off or --clear/);
});

test("screen display-output and display-cec patch only their own member; the other settings stay", async () => {
  const env = await enrolled();
  const transport = seeded();
  await cli(["--json", "screen", "brightness", LOBBY, "--mode", "auto"], transport, env);
  const set = await cli(["--json", "screen", "display-output", LOBBY, "--mode", "3840x2160x60p", "--expect-rev", "4"], transport, env);
  assert.equal(set.code, ExitCode.Success, set.stdout);
  const call = patches(transport).at(-1)!;
  assert.deepEqual(call.body, { display: { output: { mode: "3840x2160x60p" } } });
  assert.equal(call.headers?.["if-match"], '"4"');
  assert.deepEqual(set.envelope.data.display.output, { mode: "3840x2160x60p" });
  assert.deepEqual(set.envelope.data.display.brightness, { mode: "auto" }, "a member left out stays");
  const cec = await cli(["--json", "screen", "display-cec", LOBBY, "--on"], transport, env);
  assert.equal(cec.code, ExitCode.Success, cec.stdout);
  assert.deepEqual(patches(transport).at(-1)!.body, { display: { cec: { take_input: true } } });
  assert.deepEqual(cec.envelope.data.display.cec, { take_input: true });
  assert.deepEqual(cec.envelope.data.display.output, { mode: "3840x2160x60p" });
  const off = await cli(["--json", "screen", "display-cec", LOBBY, "--off"], transport, env);
  assert.deepEqual(off.envelope.data.display.cec, { take_input: false });
  const cleared = await cli(["--json", "screen", "display-cec", LOBBY, "--clear"], transport, env);
  assert.deepEqual(patches(transport).at(-1)!.body, { display: { cec: null } });
  assert.equal(cleared.envelope.data.display.cec, undefined);
  const clearedOutput = await cli(["--json", "screen", "display-output", LOBBY, "--clear"], transport, env);
  assert.deepEqual(patches(transport).at(-1)!.body, { display: { output: null } });
  assert.equal(clearedOutput.envelope.data.display.output, undefined);
  assert.deepEqual(clearedOutput.envelope.data.display.brightness, { mode: "auto" });
  const human = await cli(["--human", "screen", "display-output", LOBBY, "--mode", "auto"], transport, env);
  assert.match(human.stdout, new RegExp(`^Set display output on ${LOBBY}: auto$`, "m"));
});

test("screen show lists the display output, CEC and the modes the Player reports", async () => {
  const env = await enrolled();
  const modes = ["1920x1080x60p", "3840x2160x30p", "3840x2160x60p"];
  const transport = seeded({
    display: { requested: "on", source: "default", output: { mode: "3840x2160x60p" }, cec: { take_input: true } },
    observation: { observed_at: "2026-08-14T16:00:00Z", surfaces: [], display_output: { mode: "1920x1080x60p", modes } },
  } as Partial<Screen>);
  const json = await cli(["--json", "screen", "show", LOBBY], transport, env);
  assert.deepEqual(json.envelope.data.observation.display_output, { mode: "1920x1080x60p", modes }, "the modes are in the envelope");
  const human = await cli(["--human", "screen", "show", LOBBY], transport, env);
  assert.match(human.stdout, /^Display output: 3840x2160x60p$/m);
  assert.match(human.stdout, /^Display CEC: takes the TV's input/m);
  assert.match(human.stdout, /^Output mode in force: 1920x1080x60p$/m);
  assert.match(human.stdout, /^Output modes the Player can set \(3\): 1920x1080x60p, 3840x2160x30p, 3840x2160x60p$/m);
  assert.deepEqual(displayOutputObservationLines(undefined), []);
  assert.deepEqual(displayOutputObservationLines({}), []);
});

test("invalid input is refused before any request", async () => {
  const env = await enrolled();
  const transport = seeded();
  const cases: Array<[string[], RegExp]> = [
    [["display-idle", LOBBY, "--after", "29", "--wake", "touch"], /--after takes a whole number of seconds from 30 to 86400/],
    [["display-idle", LOBBY, "--after", "86401", "--wake", "touch"], /--after takes a whole number of seconds from 30 to 86400/],
    [["display-idle", LOBBY, "--after", "soon", "--wake", "touch"], /--after takes a whole number of seconds/],
    [["display-idle", LOBBY, "--after", "60", "--wake", "gesture"], /--wake takes touch, presence or touch,presence/],
    [["display-idle", LOBBY, "--after", "60", "--wake", "touch,touch"], /--wake takes touch, presence or touch,presence/],
    [["display-idle", LOBBY, "--after", "60"], /Provide --after and --wake together/],
    [["display-idle", LOBBY, "--wake", "touch"], /Provide exactly one of --after or --off/],
    [["display-idle", LOBBY], /Provide exactly one of --after or --off/],
    [["display-idle", LOBBY, "--off", "--after", "60", "--wake", "touch"], /cannot be used with|Provide exactly one of --after or --off/],
    [["display-idle", LOBBY, "--off", "--wake", "touch"], /cannot be used with|Provide --after and --wake together/],
    [["brightness", LOBBY], /--mode/],
    [["brightness", LOBBY, "--mode", "dim"], /auto|fixed/],
    [["display-output", LOBBY], /Provide exactly one of --mode or --clear/],
    [["display-output", LOBBY, "--mode", "4k"], /--mode takes auto or a video mode/],
    [["display-output", LOBBY, "--mode", "auto", "--clear"], /cannot be used with|Provide exactly one of --mode or --clear/],
    [["display-cec", LOBBY], /Provide exactly one of --on or --off or --clear/],
    [["display-cec", LOBBY, "--on", "--off"], /cannot be used with|Provide exactly one of --on or --off or --clear/],
    [["kiosk-lock", LOBBY], /Provide exactly one of --on or --off/],
    [["kiosk-lock", LOBBY, "--on", "--off"], /cannot be used with|Provide exactly one of --on or --off/],
  ];
  for (const [argv, pattern] of cases) {
    const result = await cli(["--json", "screen", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    assert.equal(result.envelope.error?.code, "usage_error", argv.join(" "));
    assert.match(result.envelope.error?.detail ?? "", pattern, argv.join(" "));
  }
  assert.equal(patches(transport).length, 0, "a rejected invocation never reaches the server");
});

test("a refusal from the server reaches the caller with its code", async () => {
  const env = await enrolled();
  const refusing = (status: number, code: string, title: string): FakeTransport => {
    const transport = seeded();
    const answer = transport.request.bind(transport);
    transport.request = async (req) => req.method === "PATCH" ? {
      status, headers: { "content-type": "application/problem+json" },
      body: { type: `https://screenrig.ai/problems/${code}`, title, status, code, detail: `${title}.` },
    } : answer(req);
    return transport;
  };
  const protectedScreen = await cli(["--json", "screen", "display-idle", LOBBY, "--after", "300", "--wake", "touch"], refusing(409, "protected_target", "Protected target"), env);
  assert.equal(protectedScreen.code, ExitCode.Conflict, protectedScreen.stdout);
  assert.equal(protectedScreen.envelope.error?.code, "protected_target");
  const proposed = await cli(["--json", "screen", "kiosk-lock", LOBBY, "--on"], refusing(403, "insufficient_access", "Insufficient access"), env);
  assert.equal(proposed.code, ExitCode.Auth, proposed.stdout);
  assert.equal(proposed.envelope.error?.code, "insufficient_access");
  const stale = await cli(["--json", "screen", "brightness", LOBBY, "--mode", "auto", "--expect-rev", "1"], refusing(412, "revision_conflict", "Revision conflict"), env);
  assert.equal(stale.code, ExitCode.Precondition, stale.stdout);
  assert.equal(stale.envelope.error?.code, "revision_conflict");
});

test("help states the options, their relationships and an example for each command", () => {
  const idle = commandHelp(["screen", "display-idle"]);
  assert.deepEqual(idle.options.filter((option) => ["--after", "--wake", "--off", "--expect-rev"].includes(option.name)).map((option) => option.name).sort(), ["--after", "--expect-rev", "--off", "--wake"]);
  assert.deepEqual(idle.relationships, [{ kind: "exactlyOne", options: ["--after", "--off"] }, { kind: "together", options: ["--after", "--wake"] }]);
  assert.ok(idle.examples.some((example) => /--after 300 --wake touch$/.test(example)));
  assert.ok(idle.examples.some((example) => /--off$/.test(example)));
  assert.match(idle.notes.join("\n"), /display_power\.idle/);
  const brightness = commandHelp(["screen", "brightness"]);
  assert.ok(brightness.options.some((option) => option.name === "--mode"));
  assert.ok(brightness.examples.some((example) => /--mode auto$/.test(example)));
  const kiosk = commandHelp(["screen", "kiosk-lock"]);
  assert.deepEqual(kiosk.relationships, [{ kind: "exactlyOne", options: ["--on", "--off"] }]);
  assert.ok(kiosk.examples.some((example) => /--on$/.test(example)));
  assert.match(kiosk.notes.join("\n"), /kiosk_lock/);
});

test("screen show prints the idle, brightness and kiosk settings and the battery", async () => {
  const env = await enrolled();
  const transport = seeded({
    display: { requested: "on", source: "default", idle: { after_s: 300, wake: ["touch", "presence"] }, brightness: { mode: "auto" } },
    kiosk: { lock: true },
    health: { reported_at: "2026-08-14T16:55:00Z", stale: false, battery: { level_percent: 41.6, charging: false, source: "none", temperature_c: 31.25 } },
  } as Partial<Screen>);
  const shown = await cli(["--human", "screen", "show", LOBBY], transport, env);
  assert.equal(shown.code, ExitCode.Success, shown.stdout);
  assert.match(shown.stdout, /^Display idle: dark after 300 s, wakes on touch or presence$/m);
  assert.match(shown.stdout, /^Display brightness: auto$/m);
  assert.match(shown.stdout, /^Kiosk lock: on$/m);
  assert.match(shown.stdout, /^battery: 42%, on battery, not charging, 31\.3 °C$/m);
  assert.match(shown.stdout, /^attention: on battery 42%$/m);
  const json = await cli(["--json", "screen", "show", LOBBY], transport, env);
  assert.deepEqual(json.envelope.data.display.idle, { after_s: 300, wake: ["touch", "presence"] });
  assert.deepEqual(json.envelope.data.kiosk, { lock: true });
  assert.equal(json.envelope.data.health.battery.source, "none");
});

test("display and kiosk lines name only what the screen carries", () => {
  assert.deepEqual(displaySettingsLines({ requested: "on", source: "default" }), []);
  assert.deepEqual(displaySettingsLines({ requested: "on", source: "default", brightness: { mode: "fixed" } }), ["Display brightness: fixed"]);
  assert.deepEqual(displaySettingsLines({ requested: "on", source: "default", idle: { after_s: 60, wake: ["presence"] } }), ["Display idle: dark after 60 s, wakes on presence"]);
  assert.deepEqual(displayLines({ requested: "on", source: "default", idle: { after_s: 60, wake: ["touch"] } }, undefined), [
    "Display: on (default)",
    "Display idle: dark after 60 s, wakes on touch",
  ]);
  assert.deepEqual(kioskLines(undefined), []);
  assert.deepEqual(kioskLines({ lock: true }), ["Kiosk lock: on"]);
});

// ---- screen menu-pin ---------------------------------------------------------------------------

// Eight digits that are no part of the clock, an id, a revision or the test token.
const PIN = "73519462";
const PLAIN = "scr_PLAINAAAAAAAAAAAAAAAAA";

function pinFleet(): FakeTransport {
  const transport = memoryBackend({ now: () => NOW });
  const base = { label: "Lobby", state: "active", online: true, revision: 3, manifest_revision: 1, content_access_generation: 1, timezone: "America/Los_Angeles", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" };
  transport.putScreen!({ ...base, id: LOBBY, public_id: `pub_${LOBBY}`, host: { platform: "android", capabilities: ["menu_pin"] } } as unknown as Screen);
  transport.putScreen!({ ...base, id: PLAIN, public_id: `pub_${PLAIN}`, host: { platform: "web", capabilities: [] } } as unknown as Screen);
  return transport;
}

/** The runtime's stderr and stdin and its operation log too: the places a PIN could leak to. */
async function pinCli(argv: string[], transport: FakeTransport, env: Env, stdin?: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const { logger, events } = createMemoryLogger({ command: ["screen", "menu-pin"], now: () => NOW });
  const runtime: CliRuntime = {
    argv, settings: env.fs.settings, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport, logger,
    ...(stdin === undefined ? {} : { stdin: Readable.from([Buffer.from(stdin)]), isStdinTty: () => false }),
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await out;
  const errText = await err;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human */ }
  return { code, stdout: text, stderr: errText, envelope, everything: `${text}\n${errText}\n${JSON.stringify(events)}` };
}

const pinWrites = (transport: FakeTransport) => transport.calls.filter((call) => call.path.endsWith("/menu-pin"));

test("the PIN is 4 to 8 digits with one trailing line break dropped, and a refusal never repeats it", () => {
  for (const text of ["1234", "12345678", `${PIN}\n`, `${PIN}\r\n`, "0000"]) assert.deepEqual(menuPinWrite(text), { pin: text.replace(/\r?\n$/, "") });
  for (const text of ["", "\n", "123", "123456789", "12 34", "1234\n\n", " 1234", "12a4", "١٢٣٤", `${PIN}x`, `${PIN}9`, `${PIN}\nmore`]) {
    assert.throws(() => menuPinWrite(text), (error: Error) => /must be 4 to 8 digits/.test(error.message) && !error.message.includes(PIN), JSON.stringify(text));
  }
  assert.equal(menuPinFileOption("pin.txt"), "pin.txt");
  assert.equal(menuPinFileOption("-"), "-");
  assert.equal(menuPinFileOption("./4821"), "./4821");
  for (const value of ["1234", PIN, "0"]) {
    assert.throws(() => menuPinFileOption(value), (error: Error) => /takes a file name, or - for stdin, never the PIN itself/.test(error.message) && !error.message.includes(value));
  }
});

test("screen menu-pin set reads the PIN from a file or stdin and sends it only in the body", async () => {
  const env = await enrolled();
  const transport = pinFleet();
  await writeFile(path.join(env.cwd, "pin.txt"), `${PIN}\n`);
  const fromFile = await pinCli(["--json", "screen", "menu-pin", "set", LOBBY, "--pin-file", "pin.txt", "--expect-rev", "3"], transport, env);
  assert.equal(fromFile.code, ExitCode.Success, fromFile.stdout + fromFile.stderr);
  const put = pinWrites(transport).at(-1)!;
  assert.equal(put.method, "PUT");
  assert.equal(put.path, `/api/screens/${LOBBY}/menu-pin`);
  assert.deepEqual(put.body, { pin: PIN });
  assert.equal(put.headers?.["if-match"], '"3"');
  assert.ok(put.headers?.["idempotency-key"], "the write is replay-safe");
  assert.equal(fromFile.envelope.data.menu_pin.requested.set, true);
  assert.match(fromFile.envelope.data.menu_pin.requested.menu_pin_id, /^pin_/);
  assert.ok(!fromFile.everything.includes(PIN), "no output, error or log event carries the PIN");

  await writeFile(path.join(env.cwd, "crlf.txt"), `${PIN}\r\n`);
  const crlf = await pinCli(["--json", "screen", "menu-pin", "set", LOBBY, "--pin-file", "crlf.txt"], transport, env);
  assert.equal(crlf.code, ExitCode.Success, crlf.stdout + crlf.stderr);
  assert.deepEqual(pinWrites(transport).at(-1)!.body, { pin: PIN });
  assert.equal(pinWrites(transport).at(-1)!.headers?.["if-match"], undefined);

  const piped = await pinCli(["--human", "screen", "menu-pin", "set", LOBBY, "--pin-file", "-"], transport, env, `${PIN}\n`);
  assert.equal(piped.code, ExitCode.Success, piped.stdout + piped.stderr);
  assert.deepEqual(pinWrites(transport).at(-1)!.body, { pin: PIN });
  assert.match(piped.stdout, new RegExp(`^Settings menu PIN set on ${LOBBY}; the screen applies it when it next connects$`, "m"));
  assert.match(piped.stdout, /^revision: 6$/m);
  assert.ok(!piped.everything.includes(PIN));
  assert.ok(!(await pinCli(["--json", "screen", "show", LOBBY], transport, env)).everything.includes(PIN), "screen show never has it either");
});

test("screen menu-pin set refuses a PIN typed as an argument, a bad length or a bad file, and sends nothing", async () => {
  const env = await enrolled();
  const transport = pinFleet();
  await writeFile(path.join(env.cwd, "pin.txt"), PIN);
  await writeFile(path.join(env.cwd, "bad.txt"), `${PIN}9`);
  await writeFile(path.join(env.cwd, "short.txt"), "123\n");
  await writeFile(path.join(env.cwd, "text.txt"), `${PIN}x\n`);
  await writeFile(path.join(env.cwd, "two.txt"), `${PIN}\n${PIN}\n`);
  await writeFile(path.join(env.cwd, "empty.txt"), "");
  await writeFile(path.join(env.cwd, "big.txt"), "1".repeat(200));
  const attempts: Array<[string[], string | undefined, RegExp]> = [
    [["--pin-file", PIN], undefined, /--pin-file takes a file name, or - for stdin, never the PIN itself/],
    [[`--pin-file=${PIN}`], undefined, /--pin-file takes a file name/],
    [["--pin", PIN], undefined, /requires --pin-file/],
    [["--pin", PIN, "--pin-file", "pin.txt"], undefined, /does not accept --pin\./],
    [[`--pin=${PIN}`, "--pin-file", "pin.txt"], undefined, /does not accept --pin\./],
    [["--pin-file", "pin.txt", PIN], undefined, /does not accept extra arguments/],
    [[], undefined, /requires --pin-file/],
    [["--pin-file", "bad.txt"], undefined, /must be 4 to 8 digits/],
    [["--pin-file", "short.txt"], undefined, /must be 4 to 8 digits/],
    [["--pin-file", "text.txt"], undefined, /must be 4 to 8 digits/],
    [["--pin-file", "two.txt"], undefined, /must be 4 to 8 digits/],
    [["--pin-file", "empty.txt"], undefined, /must be 4 to 8 digits/],
    [["--pin-file", "big.txt"], undefined, /size limit/],
    [["--pin-file", "-"], `${PIN}9\n`, /must be 4 to 8 digits/],
    [["--pin-file", "-"], "12ab", /must be 4 to 8 digits/],
    [["--pin-file", "missing.txt"], undefined, /missing\.txt does not exist/],
  ];
  for (const [flags, stdin, message] of attempts) {
    const refused = await pinCli(["--json", "screen", "menu-pin", "set", LOBBY, ...flags], transport, env, stdin);
    assert.equal(refused.code, ExitCode.Usage, `${flags.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? "", message, flags.join(" "));
    assert.ok(!refused.everything.includes(PIN), `${flags.join(" ")}: a refusal never repeats the PIN`);
  }
  assert.equal(pinWrites(transport).length, 0, "no request reached the server");
  const noTty = await pinCli(["--json", "screen", "menu-pin", "set", LOBBY, "--pin-file", "-"], transport, env);
  assert.equal(noTty.code, ExitCode.Usage);
  assert.match(noTty.envelope.error?.detail ?? "", /Pipe input when using '-'/);
});

test("screen menu-pin set explains a screen without the capability, a bad PIN from the server and a stale revision", async () => {
  const env = await enrolled();
  const transport = pinFleet();
  const unsupported = await pinCli(["--json", "screen", "menu-pin", "set", PLAIN, "--pin-file", "-"], transport, env, `${PIN}\n`);
  assert.equal(unsupported.code, ExitCode.Conflict, unsupported.stdout);
  assert.equal(unsupported.envelope.error?.code, "menu_pin_unsupported");
  assert.equal(unsupported.envelope.error?.next?.command, `screenrig screen show ${PLAIN}`);
  assert.ok(!unsupported.everything.includes(PIN));
  assert.equal((await pinCli(["--json", "screen", "show", PLAIN], transport, env)).envelope.data.menu_pin, undefined, "nothing was recorded");

  const stale = await pinCli(["--json", "screen", "menu-pin", "clear", LOBBY, "--expect-rev", "1"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition, stale.stdout);
  assert.equal(stale.envelope.error?.code, "revision_conflict");
});

test("screen menu-pin clear sends DELETE with no body and says the screen applies it when it next connects", async () => {
  const env = await enrolled();
  const transport = pinFleet();
  const cleared = await pinCli(["--json", "screen", "menu-pin", "clear", LOBBY, "--expect-rev", "3"], transport, env);
  assert.equal(cleared.code, ExitCode.Success, cleared.stdout + cleared.stderr);
  const call = pinWrites(transport).at(-1)!;
  assert.equal(call.method, "DELETE");
  assert.equal(call.path, `/api/screens/${LOBBY}/menu-pin`);
  assert.equal(call.body, undefined);
  assert.equal(call.headers?.["if-match"], '"3"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.equal(cleared.envelope.data.menu_pin.requested.set, false);
  const human = await pinCli(["--human", "screen", "menu-pin", "clear", LOBBY], transport, env);
  assert.match(human.stdout, new RegExp(`^Settings menu PIN removed on ${LOBBY}; the screen applies it when it next connects, and its wrong-PIN lockout ends$`, "m"));
  const unsupported = await pinCli(["--json", "screen", "menu-pin", "clear", PLAIN], transport, env);
  assert.equal(unsupported.envelope.error?.code, "menu_pin_unsupported");
  const noId = await pinCli(["--json", "screen", "menu-pin", "clear"], transport, env);
  assert.equal(noId.code, ExitCode.Usage);
});

test("screen show prints one Settings menu PIN line: set or not set, who changed it and when, and a change still waiting", () => {
  assert.deepEqual(menuPinLines(undefined), []);
  assert.deepEqual(menuPinLines({}), []);
  assert.deepEqual(menuPinLines({ reported: { set: false, reported_at: "2026-08-14T16:55:00Z", stale: false } }), ["Settings menu PIN: not set"]);
  assert.deepEqual(menuPinLines({ reported: { set: true, changed_by: "device", changed_at: "2026-08-14T12:00:00Z", reported_at: "2026-08-14T16:55:00Z", stale: false } }),
    ["Settings menu PIN: set (on the screen, 2026-08-14T12:00:00Z)"]);
  assert.deepEqual(menuPinLines({ reported: { set: true, changed_by: "remote", changed_at: "2026-08-14T13:00:00Z", reported_at: "2026-08-14T16:55:00Z", stale: true } }),
    ["Settings menu PIN: set (remotely, 2026-08-14T13:00:00Z; stale: no report for over 35 minutes)"]);
  const requested = { menu_pin_id: "pin_SECRETIDAAAAAAAA", set: true, set_at: "2026-08-14T15:00:00Z" };
  const waiting = menuPinLines({ requested });
  assert.deepEqual(waiting, ["Settings menu PIN: a new PIN requested 2026-08-14T15:00:00Z, waiting for the screen to apply it"]);
  assert.deepEqual(menuPinLines({ requested: { ...requested, set: false }, reported: { set: true, changed_by: "device", changed_at: "2026-08-14T12:00:00Z", reported_at: "2026-08-14T16:55:00Z", stale: false } }),
    ["Settings menu PIN: removal requested 2026-08-14T15:00:00Z, waiting for the screen to apply it (the screen last reported set)"], "a change before the request has not applied it");
  assert.deepEqual(menuPinLines({ requested, reported: { set: true, changed_by: "remote", changed_at: "2026-08-14T15:00:20Z", reported_at: "2026-08-14T16:55:00Z", stale: false } }),
    ["Settings menu PIN: set (remotely, 2026-08-14T15:00:20Z)"], "applied: the report shows the change");
  assert.deepEqual(menuPinLines({ requested, reported: { set: false, changed_by: "device", changed_at: "2026-08-14T15:30:00Z", reported_at: "2026-08-14T16:55:00Z", stale: false } }),
    ["Settings menu PIN: not set (on the screen, 2026-08-14T15:30:00Z)"], "a change made on the device after the request wins");
  assert.ok(![...waiting, ...menuPinLines({ requested })].join("\n").includes("pin_SECRETIDAAAAAAAA"), "the request's id is never printed");
});

test("screen show carries Settings menu PIN only when the screen has the state, and --json leaves the PIN out", async () => {
  const env = await enrolled();
  const plain = await cli(["--human", "screen", "show", LOBBY], seeded(), env);
  assert.doesNotMatch(plain.stdout, /Settings menu PIN/);
  const transport = seeded({ menu_pin: { reported: { set: true, changed_by: "device", changed_at: "2026-08-14T12:00:00Z", reported_at: "2026-08-14T16:55:00Z", stale: false } } });
  const human = await cli(["--human", "screen", "show", LOBBY], transport, env);
  assert.match(human.stdout, /^Settings menu PIN: set \(on the screen, 2026-08-14T12:00:00Z\)$/m);
  const json = await cli(["--json", "screen", "show", LOBBY], transport, env);
  assert.equal(json.envelope.data.menu_pin.reported.set, true);
});

test("screen menu-pin help names the PIN file, the stdin form and the recovery use, and never takes the PIN as an argument", () => {
  const set = commandHelp(["screen", "menu-pin", "set"]);
  assert.deepEqual(set.arguments.map((argument) => argument.name), ["id"]);
  assert.deepEqual(set.options.map((option) => option.name).filter((name) => name !== "--help"), ["--pin-file", "--expect-rev"]);
  assert.deepEqual(set.options.filter((option) => option.required).map((option) => option.name), ["--pin-file"]);
  assert.match(set.options.find((option) => option.name === "--pin-file")?.description ?? "", /or - for stdin \(never an argument\)/);
  assert.ok(set.examples.length > 0 && set.notes.length > 0);
  assert.match(set.usage, /menu_pin_unsupported/);
  const clear = commandHelp(["screen", "menu-pin", "clear"]);
  assert.deepEqual(clear.options.map((option) => option.name).filter((name) => name !== "--help"), ["--expect-rev"]);
  assert.match(clear.usage, /forgotten PIN is recovered[\s\S]*wrong-PIN lockout/);
  assert.equal(commandHelp(["screen", "menu-pin"]).kind, "group");
});
