import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ScreenHealth } from "./adapters/protocol.js";
import { formatEventLine } from "./handlers/events.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { run } from "./main.js";
import { type CliRuntime } from "./runtime.js";
import { healthChangesText, healthIssues, healthLines } from "./screen-health.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const healthy: ScreenHealth = {
  reported_at: "2026-09-25T10:00:00Z", stale: false, uptime_s: 90_061, app_uptime_s: 3_720,
  memory: { used_bytes: 1_073_741_824, total_bytes: 4_294_967_296 }, cpu: { load_1m: 0.42, cores: 4 },
  temperature_c: 61.5, display: { connected: true, power: "on" }, network: { kind: "wifi", wifi_rssi_dbm: -58 },
  crashes_24h: 0, renderer_restarts_24h: 1,
};

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function cli(argv: string[], transport: FakeTransport): Promise<{ code: number; stdout: string }> {
  const configDir = await testTemp("health-cfg-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, settings: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  void collect(stderr);
  const runtime: CliRuntime = {
    argv, settings: fs.settings, stdout, stderr, now: () => new Date("2026-09-25T10:05:00Z"), sleep: async () => undefined,
    homedir: fs.homedir, cwd: () => configDir, fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: await out };
}

function screen(id: string, label: string, health?: ScreenHealth) {
  return {
    id, label, state: "active", public_id: `pub_${id}`, revision: 1, manifest_revision: "man_1", online: true,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...(health ? { health } : {}),
  };
}

test("healthLines prints a compact block and marks a stale report", () => {
  assert.deepEqual(healthLines(healthy), [
    "Health",
    "reported_at: 2026-09-25T10:00:00Z",
    "uptime: device 1d 1h, player 1h 2m",
    "memory: 25% of 4.0 GiB",
    "cpu: load 0.42, 4 cores",
    "temperature: 61.5 °C",
    "display: connected, power on",
    "network: wifi, -58 dBm",
    "platform: unknown",
    "last 24h: 0 crashes, 1 renderer restarts",
  ]);
  const troubled = healthLines({ reported_at: "2026-09-25T09:00:00Z", stale: true, temperature_c: 83, display: { connected: false }, crashes_24h: 4 });
  assert.equal(troubled[0], "Health (stale: no report for over 35 minutes)");
  assert.ok(troubled.includes("temperature: 83.0 °C (hot)"));
  assert.ok(troubled.includes("attention: display disconnected, hot 83°C, crashing 4/24h"));
  assert.deepEqual(healthLines(undefined), []);
});

test("healthLines prints the platform the Player reports", () => {
  const lines = healthLines({
    ...healthy,
    platform: {
      os_name: "android", os_version: "12", os_build: "STTE.230319.008", sdk_int: 31, security_patch: "2026-09-05",
      soc_manufacturer: "Amlogic", soc_model: "S905D3",
      web_engine: { name: "android-webview", version: "130.0.6723.103", package: "com.google.android.webview" },
    },
  });
  assert.ok(lines.includes("os: android 12 (API 31)"));
  assert.ok(lines.includes("build: STTE.230319.008"));
  assert.ok(lines.includes("security_patch: 2026-09-05 (reported by the device)"));
  assert.ok(lines.includes("chip: Amlogic S905D3"));
  assert.ok(lines.includes("web_engine: android-webview 130.0.6723.103 (com.google.android.webview)"));
  assert.ok(!lines.includes("platform: unknown"));
});

test("healthLines prints the host name and each interface's local addresses", () => {
  const lines = healthLines({
    ...healthy,
    network: {
      kind: "ethernet", hostname: "screenrig-ab12cd",
      interfaces: [
        { name: "eth0", kind: "ethernet", addresses: ["192.0.2.10", "2001:db8::10"] },
        { name: "wg0", kind: "tunnel", addresses: ["198.51.100.2"] },
        { name: "br0", kind: "unknown", addresses: ["203.0.113.1"] },
      ],
    },
  });
  const at = lines.indexOf("network: ethernet");
  assert.deepEqual(lines.slice(at, at + 5), [
    "network: ethernet",
    "hostname: screenrig-ab12cd",
    "address eth0 (ethernet): 192.0.2.10, 2001:db8::10",
    "address wg0 (tunnel): 198.51.100.2",
    "address br0: 203.0.113.1",
  ]);
});

test("healthLines prints CPU utilization and the Player share when the Player reports them", () => {
  const lines = healthLines({ ...healthy, cpu: { load_1m: 0.42, cores: 4, utilization_percent: 37.4, app_percent: 12.6 } });
  assert.ok(lines.includes("cpu: load 0.42, 4 cores, 37% busy, player 13%"), lines.join("\n"));
});

test("healthIssues flags disconnected, hot at 80 °C, crashing at 3, and stale", () => {
  assert.deepEqual(healthIssues(healthy), []);
  assert.deepEqual(healthIssues({ ...healthy, temperature_c: 79.9, crashes_24h: 2 }), []);
  assert.deepEqual(healthIssues({ ...healthy, stale: true, display: { connected: false }, temperature_c: 80, crashes_24h: 3 }),
    ["stale", "display disconnected", "hot 80°C", "crashing 3/24h"]);
});

test("screen show passes health through and prints the Health block; list adds HEALTH only when needed", async () => {
  const transport = new FakeTransport()
    .on("GET", "/api/screens/scr_LOBBY", () => ({ status: 200, headers: {}, body: screen("scr_LOBBY", "Lobby", healthy) }))
    .on("GET", "/api/screens", () => ({ status: 200, headers: {}, body: { items: [screen("scr_LOBBY", "Lobby", healthy), screen("scr_BAR", "Bar")] } }));
  const json = await cli(["--json", "screen", "show", "scr_LOBBY"], transport);
  assert.equal(json.code, 0, json.stdout);
  assert.deepEqual((JSON.parse(json.stdout) as { data: { health: ScreenHealth } }).data.health, healthy);
  const human = await cli(["--human", "screen", "show", "scr_LOBBY"], transport);
  assert.match(human.stdout, /\nHealth\nreported_at: 2026-09-25T10:00:00Z\n/);
  const calm = await cli(["--human", "screen", "list"], transport);
  assert.doesNotMatch(calm.stdout, /HEALTH/);

  const hot = new FakeTransport().on("GET", "/api/screens", () => ({
    status: 200, headers: {},
    body: { items: [screen("scr_LOBBY", "Lobby", healthy), screen("scr_BAR", "Bar", { ...healthy, temperature_c: 85, display: { connected: false } }), screen("scr_NEW", "New")] },
  }));
  const flagged = await cli(["--human", "screen", "list"], hot);
  const lines = flagged.stdout.split("\n");
  assert.match(lines.find((line) => line.startsWith("ID"))!, /HEALTH$/);
  assert.match(lines.find((line) => line.startsWith("scr_LOBBY"))!, /\bok$/);
  assert.match(lines.find((line) => line.startsWith("scr_BAR"))!, /display disconnected, hot 85°C$/);
  assert.match(lines.find((line) => line.startsWith("scr_NEW"))!, /active$/);
});

test("screen.health_changed renders its changes compactly", () => {
  const line = formatEventLine({
    cursor: "ev1_9", type: "screen.health_changed", severity: "warning", message: "Screen health changed", at: "2026-09-25T10:00:00Z",
    resource: { type: "screen", id: "scr_LOBBY" },
    details: {
      reported_at: "2026-09-25T10:00:00Z",
      changes: [
        { change: "display_disconnected" },
        { change: "display_power", from: "on", to: "standby" },
        { change: "temperature_high", temperature_c: 82.5 },
        { change: "crash_spike", crashes_24h: 5, previous: 1 },
      ],
    },
  } as never);
  assert.equal(line, 'at=2026-09-25T10:00:00Z type=screen.health_changed severity=warning resource_type=screen resource_id=scr_LOBBY changes="display_disconnected,display_power from=on to=standby,temperature_high temperature_c=82.5,crash_spike crashes_24h=5 previous=1" reported_at=2026-09-25T10:00:00Z');
  assert.equal(healthChangesText([{ change: "Bad Name" }, "x"]), undefined);
});

test("a battery the device reports prints in the health block, and running on it is an issue", () => {
  const unplugged: ScreenHealth = { ...healthy, battery: { level_percent: 41.6, charging: false, source: "none", temperature_c: 31.25 } };
  assert.ok(healthLines(unplugged).includes("battery: 42%, on battery, not charging, 31.3 °C"));
  assert.ok(healthLines(unplugged).includes("attention: on battery 42%"));
  assert.deepEqual(healthIssues(unplugged), ["on battery 42%"]);
  assert.deepEqual(healthIssues({ ...healthy, battery: { source: "none" } }), ["on battery"], "no level reported");

  const plugged: ScreenHealth = { ...healthy, battery: { level_percent: 88, charging: true, source: "ac" } };
  assert.ok(healthLines(plugged).includes("battery: 88%, powered by ac, charging"));
  assert.deepEqual(healthIssues(plugged), []);
  assert.deepEqual(healthIssues({ ...healthy, battery: {} }), []);
  assert.ok(!healthLines(healthy).some((line) => line.startsWith("battery:")), "a device with no battery prints no battery line");
});

test("screen list flags a screen that runs on its battery", async () => {
  const transport = new FakeTransport().on("GET", "/api/screens", () => ({
    status: 200, headers: {},
    body: { items: [screen("scr_LOBBY", "Lobby", healthy), screen("scr_KIOSK", "Kiosk", { ...healthy, battery: { level_percent: 20, source: "none" } })] },
  }));
  const listed = await cli(["--human", "screen", "list"], transport);
  const lines = listed.stdout.split("\n");
  assert.match(lines.find((line) => line.startsWith("scr_LOBBY"))!, /\bok$/);
  assert.match(lines.find((line) => line.startsWith("scr_KIOSK"))!, /on battery 20%$/);
});

test("screen.health_changed renders the battery changes", () => {
  const line = formatEventLine({
    cursor: "ev1_10", type: "screen.health_changed", severity: "warning", message: "Screen health changed", at: "2026-09-25T10:00:00Z",
    resource: { type: "screen", id: "scr_KIOSK" },
    details: { reported_at: "2026-09-25T10:00:00Z", changes: [{ change: "on_battery", level_percent: 64 }, { change: "plugged_in", source: "usb" }] },
  } as never);
  assert.match(line ?? "", /changes="on_battery level_percent=64,plugged_in source=usb"/);
});

test("screen list passes the platform filters to the server and refuses malformed ones before any request", async () => {
  const transport = new FakeTransport().on("GET", "/api/screens", () => ({ status: 200, headers: {}, body: { items: [screen("scr_LOBBY", "Lobby", healthy)] } }));
  const listed = await cli(["--json", "screen", "list", "--security-patch-before", "2026-06-01", "--web-engine", "android-webview", "--web-engine-below", "120"], transport);
  assert.equal(listed.code, 0, listed.stdout);
  const query = transport.calls.at(-1)?.query;
  assert.equal(query?.security_patch_before, "2026-06-01");
  assert.equal(query?.web_engine, "android-webview");
  assert.equal(query?.web_engine_below, "120");
  const before = transport.calls.length;
  for (const bad of [["--security-patch-before", "2026-02-30"], ["--web-engine", "Chrome"], ["--web-engine-below", "0"]]) {
    const refused = await cli(["--json", "screen", "list", ...bad], transport);
    assert.equal(refused.code, 2, bad.join(" "));
  }
  assert.equal(transport.calls.length, before);
});
