import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ScreenHealth } from "./adapters/protocol.js";
import { formatEventLine } from "./commands.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { run, type CliRuntime } from "./main.js";
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
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  void collect(stderr);
  const runtime: CliRuntime = {
    argv, env: fs.env, stdout, stderr, now: () => new Date("2026-09-25T10:05:00Z"), sleep: async () => undefined,
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
    "last 24h: 0 crashes, 1 renderer restarts",
  ]);
  const troubled = healthLines({ reported_at: "2026-09-25T09:00:00Z", stale: true, temperature_c: 83, display: { connected: false }, crashes_24h: 4 });
  assert.equal(troubled[0], "Health (stale: no report for over 15 minutes)");
  assert.ok(troubled.includes("temperature: 83.0 °C (hot)"));
  assert.ok(troubled.includes("attention: display disconnected, hot 83°C, crashing 4/24h"));
  assert.deepEqual(healthLines(undefined), []);
});

test("healthIssues flags disconnected, hot at 80 °C, crashing at 3, and stale", () => {
  assert.deepEqual(healthIssues(healthy), []);
  assert.deepEqual(healthIssues({ ...healthy, temperature_c: 79.9, crashes_24h: 2 }), []);
  assert.deepEqual(healthIssues({ ...healthy, stale: true, display: { connected: false }, temperature_c: 80, crashes_24h: 3 }),
    ["stale", "display disconnected", "hot 80°C", "crashing 3/24h"]);
});

test("screen show passes health through and prints the Health block; list adds HEALTH only when needed", async () => {
  const transport = new FakeTransport()
    .on("GET", "/api/v1/screens/scr_LOBBY", () => ({ status: 200, headers: {}, body: screen("scr_LOBBY", "Lobby", healthy) }))
    .on("GET", "/api/v1/screens", () => ({ status: 200, headers: {}, body: { items: [screen("scr_LOBBY", "Lobby", healthy), screen("scr_BAR", "Bar")] } }));
  const json = await cli(["--json", "screen", "show", "scr_LOBBY"], transport);
  assert.equal(json.code, 0, json.stdout);
  assert.deepEqual((JSON.parse(json.stdout) as { data: { health: ScreenHealth } }).data.health, healthy);
  const human = await cli(["--human", "screen", "show", "scr_LOBBY"], transport);
  assert.match(human.stdout, /\nHealth\nreported_at: 2026-09-25T10:00:00Z\n/);
  const calm = await cli(["--human", "screen", "list"], transport);
  assert.doesNotMatch(calm.stdout, /HEALTH/);

  const hot = new FakeTransport().on("GET", "/api/v1/screens", () => ({
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
