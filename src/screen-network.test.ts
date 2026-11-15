import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import type { Screen, ScreenCommand } from "./adapters/protocol.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { commandHelp } from "./help-tree.js";
import { createMemoryLogger } from "./log/logger.js";
import { run } from "./main.js";
import { type CliRuntime } from "./runtime.js";
import { latestNetworkCommand, networkAddress, networkChangeText, networkDns, networkRollbackSeconds, networkWrite, wifiNameOption, wifiPasswordChecked } from "./screen-network.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";

const NOW = new Date("2026-08-14T17:00:00.000Z");
const LOBBY = "scr_LOBBYAAAAAAAAAAAAAAAAAA";
const PASSWORD = "correct horse battery";

interface Env { fs: ConfigFs; cwd: string; configPath: string }
interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; next?: { command: string; reason: string } };
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
  const configDir = await testTemp("network-cfg-");
  const cwd = await testTemp("network-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, settings: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, extra: Partial<CliRuntime> = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const runtime: CliRuntime = {
    argv, settings: env.fs.settings, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport, ...extra,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await out;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, stderr: await err, envelope };
}

function seeded(extra: Partial<Screen> = {}): FakeTransport {
  const transport = memoryBackend({ now: () => NOW });
  transport.putScreen!({
    id: LOBBY, label: "Lobby", public_id: `pub_${LOBBY}`, state: "active", online: true, revision: 3, manifest_revision: 1, content_access_generation: 1,
    timezone: "America/Los_Angeles", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
    host: { platform: "linux", capabilities: ["network.configure"] }, ...extra,
  } as Screen);
  return transport;
}

const posts = (transport: FakeTransport) => transport.calls.filter((call) => call.method === "POST" && call.path.endsWith("/network"));

test("networkWrite builds the body for each combination of flags", () => {
  assert.deepEqual(networkWrite({ wifi: "Lobby", dhcp: true }), { connection: "wifi", wifi: { ssid: "Lobby" }, ipv4: { mode: "automatic" } });
  assert.deepEqual(networkWrite({ wifi: "Lobby", hidden: true, secret: PASSWORD, dhcp: true, rollbackAfter: "300", expiresIn: "2h" }), {
    connection: "wifi", wifi: { ssid: "Lobby", hidden: true, password: PASSWORD }, ipv4: { mode: "automatic" }, rollback_after_s: 300, expires_in_s: 7200,
  });
  assert.deepEqual(networkWrite({ ethernet: true, dhcp: true }), { connection: "ethernet", ipv4: { mode: "automatic" } });
  assert.deepEqual(networkWrite({ ethernet: true, address: "10.0.4.20/24", gateway: "10.0.4.1" }), {
    connection: "ethernet", ipv4: { mode: "manual", address: "10.0.4.20", prefix: 24, gateway: "10.0.4.1" },
  });
  assert.deepEqual(networkWrite({ wifi: "Cafe", address: "192.168.1.50/8", gateway: "192.168.1.1", dns: "192.168.1.1, 1.1.1.1,8.8.8.8" }).ipv4,
    { mode: "manual", address: "192.168.1.50", prefix: 8, gateway: "192.168.1.1", dns: ["192.168.1.1", "1.1.1.1", "8.8.8.8"] });
});

test("local checks mirror the contract and name the flag", () => {
  assert.deepEqual(networkAddress("192.168.1.50/30"), { address: "192.168.1.50", prefix: 30 });
  for (const value of ["192.168.1.50", "192.168.1.50/7", "192.168.1.50/31", "192.168.1.256/24", "192.168.1/24", "192.168.1.50/24/1", "host/24", "192.168.01.5/24", ""]) {
    assert.throws(() => networkAddress(value), /--address takes an IPv4 address and prefix length/, JSON.stringify(value));
  }
  assert.deepEqual(networkDns("1.1.1.1"), ["1.1.1.1"]);
  for (const value of ["1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4", "dns.example.com", "1.1.1.1,", ""]) assert.throws(() => networkDns(value), /--dns takes/, JSON.stringify(value));
  assert.equal(networkRollbackSeconds("60"), 60);
  assert.equal(networkRollbackSeconds("600"), 600);
  for (const value of ["59", "601", "3m", "1.5", "-60", ""]) assert.throws(() => networkRollbackSeconds(value), /--rollback-after takes whole seconds from 60 to 600/, JSON.stringify(value));
  assert.equal(wifiNameOption("Lobby"), "Lobby");
  assert.throws(() => wifiNameOption(""), /--wifi takes/);
  assert.throws(() => wifiNameOption("a".repeat(33)), /--wifi takes/);
  assert.throws(() => wifiNameOption("two\nlines"), /--wifi takes/);
  assert.equal(wifiNameOption("é".repeat(16)), "é".repeat(16));
  assert.throws(() => wifiNameOption("é".repeat(17)), /--wifi takes/, "32 bytes, not 32 characters");
  assert.equal(wifiPasswordChecked(PASSWORD, "stdin"), PASSWORD);
  assert.equal(wifiPasswordChecked("a".repeat(64), "stdin"), "a".repeat(64));
  for (const value of ["short", "x".repeat(65), "tab\there-long", "naïve-password"]) {
    assert.throws(() => wifiPasswordChecked(value, "wifi.txt"), (error: Error) => /^The Wi-Fi password in wifi\.txt must be 8 to 63 printable ASCII characters or 64 hex digits\.$/.test(error.message) && !error.message.includes(value));
  }
  assert.throws(() => networkWrite({ wifi: "Lobby", ethernet: true, dhcp: true }), /exactly one of --wifi or --ethernet/);
  assert.throws(() => networkWrite({ dhcp: true }), /exactly one of --wifi or --ethernet/);
  assert.throws(() => networkWrite({ ethernet: true }), /exactly one of --dhcp or --address/);
  assert.throws(() => networkWrite({ ethernet: true, address: "10.0.0.2/24" }), /--address requires --gateway/);
  assert.throws(() => networkWrite({ ethernet: true, dhcp: true, dns: "1.1.1.1" }), /apply to --address/);
});

test("screen network set sends the write, reads the password from a file and keeps it out of every output", async () => {
  const env = await enrolled();
  await writeFile(path.join(env.cwd, "wifi.txt"), `${PASSWORD}\n`);
  const transport = seeded();
  const { logger, events } = createMemoryLogger({ command: ["screen", "network", "set"] });
  const result = await cli(["--json", "screen", "network", "set", LOBBY, "--wifi", "Lobby", "--password-file", "wifi.txt", "--dhcp", "--expect-rev", "3"], transport, env, { logger });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.envelope.ok, true);
  assert.match(result.envelope.data.command_id, /^cmd_/);
  assert.equal(result.envelope.data.command, "network");
  assert.equal(result.envelope.data.state, "sent");
  assert.deepEqual(Object.keys(result.envelope.data).sort(), ["command", "command_id", "expires_at", "state"]);
  const [call] = posts(transport);
  assert.equal(call!.path, `/api/screens/${LOBBY}/network`);
  assert.equal(call!.headers?.["if-match"], '"3"');
  assert.ok(call!.headers?.["idempotency-key"], "the write carries an Idempotency-Key");
  assert.deepEqual(call!.body, { connection: "wifi", wifi: { ssid: "Lobby", password: PASSWORD }, ipv4: { mode: "automatic" } });
  assertNoPassword(result, transport, events, await readFile(env.configPath, "utf8"));
  // The stored command says a password was given, never which.
  const stored = (await cli(["--json", "screen", "show", LOBBY], transport, env)).envelope.data.commands.at(-1);
  assert.equal(stored.type, "network");
  assert.deepEqual(stored.network, { connection: "wifi", wifi: { ssid: "Lobby", hidden: false, password_set: true }, ipv4: { mode: "automatic" }, rollback_after_s: 180 });
  const human = await cli(["--human", "screen", "network", "set", LOBBY, "--wifi", "Lobby", "--password-file", "wifi.txt", "--dhcp"], transport, env);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /^Network change accepted$/m);
  assert.match(human.stdout, /^change: Wi-Fi Lobby \(password set\), automatic addressing$/m);
  assert.match(human.stdout, /keeps it only if the screen reaches screenRIG again within 180 s; otherwise it restores its previous settings by itself/);
  assert.ok(!human.stdout.includes(PASSWORD) && !human.stderr.includes(PASSWORD));
});

function assertNoPassword(result: { stdout: string; stderr: string }, transport: FakeTransport, events: unknown[], config: string): void {
  assert.ok(!result.stdout.includes(PASSWORD), "stdout holds the password");
  assert.ok(!result.stderr.includes(PASSWORD), "stderr holds the password");
  assert.ok(!JSON.stringify(events).includes(PASSWORD), "the operation log holds the password");
  assert.ok(!config.includes(PASSWORD), "the config file holds the password");
  assert.ok(events.length > 0, "the operation log recorded the request");
  const holders = transport.calls.filter((call) => JSON.stringify(call).includes(PASSWORD));
  assert.equal(holders.length, 1, "only the one write carries the password");
  assert.equal(holders[0]!.method, "POST");
  assert.ok(holders[0]!.path.endsWith("/network"));
}

test("screen network set reads the password from stdin and refuses a terminal", async () => {
  const env = await enrolled();
  const transport = seeded();
  const { logger, events } = createMemoryLogger({ command: ["screen", "network", "set"] });
  const piped = await cli(["--json", "screen", "network", "set", LOBBY, "--wifi", "Lobby", "--hidden", "--password-file", "-", "--address", "192.168.1.50/24", "--gateway", "192.168.1.1", "--dns", "192.168.1.1,1.1.1.1", "--rollback-after", "240", "--expires-in", "30m"],
    transport, env, { stdin: Readable.from([Buffer.from(`${PASSWORD}\r\n`)]), isStdinTty: () => false, logger });
  assert.equal(piped.code, 0, piped.stdout + piped.stderr);
  assert.deepEqual(posts(transport)[0]!.body, {
    connection: "wifi", wifi: { ssid: "Lobby", hidden: true, password: PASSWORD },
    ipv4: { mode: "manual", address: "192.168.1.50", prefix: 24, gateway: "192.168.1.1", dns: ["192.168.1.1", "1.1.1.1"] },
    rollback_after_s: 240, expires_in_s: 1800,
  });
  assertNoPassword(piped, transport, events, await readFile(env.configPath, "utf8"));

  const tty = seeded();
  const refused = await cli(["--json", "screen", "network", "set", LOBBY, "--wifi", "Lobby", "--password-file", "-", "--dhcp"], tty, env, { stdin: Readable.from([Buffer.from(`${PASSWORD}\n`)]), isStdinTty: () => true });
  assert.equal(refused.code, 2, refused.stdout);
  assert.match(refused.envelope.error!.detail, /Pipe input when using '-'/);
  assert.equal(posts(tty).length, 0, "nothing is sent");
  assert.ok(!refused.stdout.includes(PASSWORD) && !refused.stderr.includes(PASSWORD));

  await writeFile(path.join(env.cwd, "weak.txt"), "short\n");
  const weak = await cli(["--json", "screen", "network", "set", LOBBY, "--wifi", "Lobby", "--password-file", "weak.txt", "--dhcp"], tty, env);
  assert.equal(weak.code, 2);
  assert.match(weak.envelope.error!.detail, /must be 8 to 63 printable ASCII characters or 64 hex digits/);
  assert.ok(!weak.stdout.includes("short\n") && !weak.stdout.includes('"short"'));
  assert.equal(posts(tty).length, 0);
});

test("an open network and an Ethernet change send no password; the offline screen holds the change queued", async () => {
  const env = await enrolled();
  const transport = seeded({ online: false });
  const open = await cli(["--json", "screen", "network", "set", LOBBY, "--wifi", "Guest", "--dhcp"], transport, env);
  assert.equal(open.code, 0, open.stdout + open.stderr);
  assert.equal(open.envelope.data.state, "queued");
  assert.deepEqual(posts(transport)[0]!.body, { connection: "wifi", wifi: { ssid: "Guest" }, ipv4: { mode: "automatic" } });
  const ethernet = await cli(["--human", "screen", "network", "set", LOBBY, "--ethernet", "--dhcp"], transport, env);
  assert.equal(ethernet.code, 0, ethernet.stdout + ethernet.stderr);
  assert.deepEqual(posts(transport)[1]!.body, { connection: "ethernet", ipv4: { mode: "automatic" } });
  assert.match(ethernet.stdout, /^change: Ethernet, automatic addressing$/m);
  assert.match(ethernet.stdout, /The screen is offline, so the change waits: .* Cancel it with screen command cancel scr_LOBBYAAAAAAAAAAAAAAAAAA cmd_/);
  // A queued change supersedes the earlier queued one.
  const read = (await cli(["--json", "screen", "network", "show", LOBBY], transport, env)).envelope.data;
  assert.equal(read.change.state, "queued");
  assert.equal(read.change.network.connection, "ethernet");
});

test("option relationships are refused before any request", async () => {
  const env = await enrolled();
  const transport = seeded();
  const base = ["--json", "screen", "network", "set", LOBBY];
  const cases: Array<[string[], RegExp]> = [
    [["--dhcp"], /exactly one of --wifi or --ethernet/],
    [["--wifi", "Lobby", "--ethernet", "--dhcp"], /cannot be used with|exactly one of --wifi or --ethernet/],
    [["--wifi", "Lobby"], /exactly one of --dhcp or --address/],
    [["--wifi", "Lobby", "--dhcp", "--address", "10.0.0.2/24", "--gateway", "10.0.0.1"], /cannot be used with|exactly one of --dhcp or --address/],
    [["--wifi", "Lobby", "--address", "10.0.0.2/24"], /--address and --gateway together/],
    [["--wifi", "Lobby", "--dhcp", "--gateway", "10.0.0.1"], /--address and --gateway together/],
    [["--wifi", "Lobby", "--dhcp", "--dns", "1.1.1.1"], /--dns requires --address/],
    [["--ethernet", "--dhcp", "--hidden"], /--hidden requires --wifi/],
    [["--ethernet", "--dhcp", "--password-file", "wifi.txt"], /--password-file requires --wifi/],
    [["--wifi", "Lobby", "--dhcp", "--rollback-after", "10"], /--rollback-after takes whole seconds from 60 to 600/],
    [["--wifi", "Lobby", "--address", "10.0.0.2/31", "--gateway", "10.0.0.1"], /--address takes an IPv4 address and prefix length/],
    [["--wifi", "Lobby", "--dhcp", "--expires-in", "10s"], /--expires-in/],
  ];
  for (const [flags, pattern] of cases) {
    const result = await cli([...base, ...flags], transport, env);
    assert.equal(result.code, 2, `${flags.join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error?.detail ?? result.stdout, pattern, flags.join(" "));
  }
  const fleet = await cli(["--json", "screen", "network", "set", "--tag", "Lobby", "--wifi", "Lobby", "--dhcp"], transport, env);
  assert.equal(fleet.code, 2, "there is no fleet form");
  assert.equal(transport.calls.filter((call) => call.method !== "GET").length, 0, "nothing was sent");
});

test("network_unsupported, protected_target and the other refusals point at the screen's own menu", async () => {
  const env = await enrolled();
  const plain = seeded({ host: { platform: "android", capabilities: ["reboot"] } } as Partial<Screen>);
  const unsupported = await cli(["--json", "screen", "network", "set", LOBBY, "--ethernet", "--dhcp"], plain, env);
  assert.equal(unsupported.code, 5, unsupported.stdout);
  assert.equal(unsupported.envelope.error!.code, "network_unsupported");
  assert.match(unsupported.envelope.error!.detail, /Nothing was sent: only the Raspberry Pi appliance and Linux Players installed to manage their host change their network remotely/);
  assert.match(unsupported.envelope.error!.detail, /Device Configuration menu/);
  assert.equal(unsupported.envelope.error!.next!.command, `screenrig screen show ${LOBBY}`);
  assert.match(unsupported.envelope.error!.next!.reason, /network\.configure.*Device Configuration menu/);

  const problem = (status: number, code: string, detail: string) => ({ status, headers: { "content-type": "application/problem+json" }, body: { type: `https://screenrig.ai/problems/${code}`, status, code, title: code, detail } });
  for (const [status, code, command, pattern] of [
    [409, "protected_target", `screenrig screen show ${LOBBY}`, /protected screen folder/],
    [409, "screen_archived", `screenrig screen unarchive ${LOBBY}`, /Unarchive it first/],
    [409, "resource_conflict", `screenrig screen show ${LOBBY}`, /Pair it first/],
  ] as const) {
    const transport = new FakeTransport().on("POST", `/api/screens/${LOBBY}/network`, () => problem(status, code, "The screen refused."));
    const refused = await cli(["--json", "screen", "network", "set", LOBBY, "--ethernet", "--dhcp"], transport, env);
    assert.equal(refused.code, 5, refused.stdout);
    assert.equal(refused.envelope.error!.code, code);
    assert.equal(refused.envelope.error!.next!.command, command);
    assert.match(refused.envelope.error!.next!.reason, pattern);
  }
  const invalid = new FakeTransport().on("POST", `/api/screens/${LOBBY}/network`, () => problem(400, "invalid_request", "ipv4.gateway: must be another host of the address's network"));
  const bad = await cli(["--json", "screen", "network", "set", LOBBY, "--ethernet", "--address", "10.0.0.2/24", "--gateway", "10.0.0.2"], invalid, env);
  assert.equal(bad.code, 8);
  assert.equal(bad.envelope.error!.code, "invalid_request");
  assert.match(bad.envelope.error!.detail, /ipv4\.gateway/);
});

const network = (extra: Partial<ScreenCommand> & { state: ScreenCommand["state"] }): ScreenCommand => ({
  id: "cmd_NETWORK0001", type: "network", requested_at: "2026-08-14T16:50:00Z", expires_at: "2026-08-14T17:50:00Z",
  network: { connection: "wifi", wifi: { ssid: "Lobby", hidden: false, password_set: true }, ipv4: { mode: "automatic" }, rollback_after_s: 180 }, ...extra,
});

test("screen network show reports the network and the newest change in plain words", async () => {
  const env = await enrolled();
  const health = { reported_at: "2026-08-14T16:59:00Z", network: { kind: "wifi", wifi_rssi_dbm: -58, hostname: "lobby-pi", interfaces: [{ name: "wlan0", kind: "wifi", addresses: ["192.168.1.50"] }] } };
  const cases: Array<[ScreenCommand, RegExp]> = [
    [network({ state: "sent", sent_at: "2026-08-14T16:50:01Z" }), /^Network change cmd_NETWORK0001 on trial: Wi-Fi Lobby \(password set\), automatic addressing, rolls back after 180 s$/m],
    [network({ state: "queued" }), /^Network change cmd_NETWORK0001 queued until 2026-08-14T17:50:00Z: it is sent when the screen comes online; Wi-Fi Lobby/m],
    [network({ state: "done", cause: "kept", done_at: "2026-08-14T16:51:00Z" }), /^Network change cmd_NETWORK0001 kept: Wi-Fi Lobby \(password set\), automatic addressing, rolls back after 180 s$/m],
    [network({ state: "failed", cause: "rolled_back", detail: "wrong_password" }), /^Network change cmd_NETWORK0001 rolled back: wrong_password \(the Wi-Fi password was refused\); the screen is back on its previous settings; Wi-Fi Lobby/m],
    [network({ state: "failed", cause: "refused_busy" }), /^Network change cmd_NETWORK0001 refused: .*; nothing changed; Wi-Fi Lobby/m],
    [network({ state: "cancelled" }), /^Network change cmd_NETWORK0001 cancelled: it never ran; /m],
  ];
  for (const [command, pattern] of cases) {
    const transport = seeded({ health, commands: [command] } as Partial<Screen>);
    const human = await cli(["--human", "screen", "network", "show", LOBBY], transport, env);
    assert.equal(human.code, 0, human.stdout + human.stderr);
    assert.match(human.stdout, /^Network of scr_LOBBYAAAAAAAAAAAAAAAAAA$/m);
    assert.match(human.stdout, /^network: wifi, -58 dBm$/m);
    assert.match(human.stdout, /^hostname: lobby-pi$/m);
    assert.match(human.stdout, /^address wlan0 \(wifi\): 192\.168\.1\.50$/m);
    assert.match(human.stdout, pattern);
    if (command.state === "queued") assert.match(human.stdout, /^Cancel it with screen command cancel scr_LOBBYAAAAAAAAAAAAAAAAAA cmd_NETWORK0001\.$/m);
    const json = (await cli(["--json", "screen", "network", "show", LOBBY], transport, env)).envelope;
    assert.deepEqual(Object.keys(json.data).sort(), ["change", "network"]);
    assert.equal(json.data.change.state, command.state);
    assert.equal(json.data.change.network.wifi.password_set, true, "password_set stays a boolean");
    assert.equal(json.data.network.hostname, "lobby-pi");
  }
  // Newest of several; none at all; no report.
  const older = network({ id: "cmd_NETWORK0000", state: "failed", cause: "rolled_back", detail: "no_link" });
  const newer = network({ id: "cmd_NETWORK0002", state: "done", cause: "kept" });
  const reboot: ScreenCommand = { id: "rbt_00000001", type: "reboot", state: "done", requested_at: "2026-08-14T16:55:00Z", expires_at: "2026-08-14T17:55:00Z" };
  assert.equal(latestNetworkCommand({ commands: [older, newer, reboot] } as Screen)?.id, "cmd_NETWORK0002");
  const transport = seeded({ commands: [reboot] } as Partial<Screen>);
  const empty = await cli(["--json", "screen", "network", "show", LOBBY], transport, env);
  assert.deepEqual(empty.envelope.data, { network: null, change: null });
  const emptyHuman = await cli(["--human", "screen", "network", "show", LOBBY], transport, env);
  assert.match(emptyHuman.stdout, /The Player has not reported its network\./);
  assert.match(emptyHuman.stdout, /No network change has been asked of this screen recently\./);
});

test("networkChangeText describes a manual change and never prints a password", () => {
  assert.equal(networkChangeText({ connection: "ethernet", ipv4: { mode: "manual", address: "10.0.4.20", prefix: 24, gateway: "10.0.4.1", dns: ["10.0.4.1", "1.1.1.1"] }, rollback_after_s: 300 }),
    "Ethernet, address 10.0.4.20/24, gateway 10.0.4.1, DNS 10.0.4.1, 1.1.1.1, rolls back after 300 s");
  assert.equal(networkChangeText({ connection: "wifi", wifi: { ssid: "Lobby", hidden: true, password: PASSWORD }, ipv4: { mode: "automatic" } }), "Wi-Fi Lobby (hidden, password set), automatic addressing");
});

test("screen show lists the network command and summarizes one still pending", async () => {
  const env = await enrolled();
  const pending = seeded({ commands: [network({ state: "sent", sent_at: "2026-08-14T16:50:01Z" })] } as Partial<Screen>);
  const shown = await cli(["--human", "screen", "show", LOBBY], pending, env);
  assert.equal(shown.code, 0, shown.stdout + shown.stderr);
  assert.match(shown.stdout, /^Commands$/m);
  assert.match(shown.stdout, /^network\s+cmd_NETWORK0001\s+sent\s+2026-08-14T17:50:00Z/m);
  assert.match(shown.stdout, /^Network change cmd_NETWORK0001 on trial: Wi-Fi Lobby \(password set\), automatic addressing, rolls back after 180 s$/m);
  const finished = seeded({ commands: [network({ state: "failed", cause: "rolled_back", detail: "no_link" })] } as Partial<Screen>);
  const done = await cli(["--human", "screen", "show", LOBBY], finished, env);
  assert.match(done.stdout, /^network\s+cmd_NETWORK0001\s+failed\s+.*rolled_back$/m);
  assert.match(done.stdout, /cmd_NETWORK0001 failed \(rolled_back\): no_link/);
  assert.doesNotMatch(done.stdout, /^Network change /m, "a finished change is in the table and screen network show, not the summary line");
});

test("screen network help declares the relationships, the scope and the rollback", () => {
  const help = commandHelp(["screen", "network", "set"]);
  assert.deepEqual(help.relationships, [
    { kind: "exactlyOne", options: ["--wifi", "--ethernet"] },
    { kind: "exactlyOne", options: ["--dhcp", "--address"] },
    { kind: "together", options: ["--address", "--gateway"] },
    { kind: "requires", options: ["--dns", "--address"] },
    { kind: "requires", options: ["--hidden", "--wifi"] },
    { kind: "requires", options: ["--password-file", "--wifi"] },
  ]);
  const notes = help.notes.join("\n");
  assert.match(notes, /Needs Manage access\./);
  assert.match(notes, /restores its previous settings by itself/);
  assert.match(notes, /read from the file or stdin, never from an argument/);
  assert.match(notes, /protected_target/);
  assert.match(notes, /Raspberry Pi appliance and Linux Players installed to manage their host/);
  assert.ok(help.options.some((option) => option.name === "--password-file"));
  assert.ok(!help.options.some((option) => option.name === "--password"), "no flag carries the password value");
  assert.ok(help.examples.length >= 3 && help.examples.every((example) => example.startsWith("screenrig screen network set")));
  assert.ok(commandHelp(["screen", "network", "show"]).examples.length > 0);
});
