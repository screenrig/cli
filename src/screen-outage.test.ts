import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Screen } from "./adapters/protocol.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { run, type CliRuntime } from "./main.js";
import { likelyCauseText, outageLines } from "./screen-outage.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

type Outage = NonNullable<Screen["last_outage"]>;

const ended: Outage = {
  offline_since: "2026-10-28T09:01:30Z", back_at: "2026-10-28T09:08:00Z", duration_s: 390, likely_cause: "device_restart",
  evidence: { device_uptime_s: 95, app_uptime_s: 80, report_at: "2026-10-28T09:08:10Z" },
};

function screen(online: boolean, outage?: Outage): Screen {
  return {
    id: "scr_LOBBY", label: "Lobby", state: "active", public_id: "pub_LOBBY", revision: 1, manifest_revision: 1, online, content_access_generation: 1,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...(outage ? { last_outage: outage } : {}),
  } as Screen;
}

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function cli(argv: string[], transport: FakeTransport): Promise<{ code: number; stdout: string }> {
  const configDir = await testTemp("outage-cfg-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  void collect(stderr);
  const runtime: CliRuntime = {
    argv, env: fs.env, stdout, stderr, now: () => new Date("2026-10-28T09:10:00Z"), sleep: async () => undefined,
    homedir: fs.homedir, cwd: () => configDir, fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: await out };
}

test("outageLines prints when the screen was gone, for how long, and the likely cause", () => {
  assert.deepEqual(outageLines(screen(true, ended)), [
    "Last outage: offline from 2026-10-28T09:01:30Z to 2026-10-28T09:08:00Z (6m 30s)",
    "Likely cause: the device restarted (power loss or reboot).",
  ]);
  for (const [cause, text] of [
    ["app_crash", "the Player crashed and restarted"],
    ["app_restart", "the Player restarted"],
    ["network", "the screen's network connection"],
    ["platform", "a screenRIG service interruption"],
  ] as const) {
    assert.equal(outageLines(screen(true, { ...ended, likely_cause: cause }))[1], `Likely cause: ${text}.`);
  }
  assert.equal(outageLines(screen(true, { ...ended, evidence: { ...ended.evidence, reboot_command: true } }))[1], "Likely cause: the device restarted after a reboot command.");
});

test("outageLines says nothing about a cause the server does not give or this CLI does not know", () => {
  const { likely_cause: _cause, ...unknown } = ended;
  assert.deepEqual(outageLines(screen(true, unknown as Outage)), ["Last outage: offline from 2026-10-28T09:01:30Z to 2026-10-28T09:08:00Z (6m 30s)"]);
  assert.equal(outageLines(screen(true, { ...ended, likely_cause: "cosmic_rays" }))[1], undefined);
  assert.equal(outageLines(screen(true, { ...ended, likely_cause: "__proto__" }))[1], undefined);
  assert.equal(likelyCauseText(42), undefined);
  assert.equal(likelyCauseText("device_restart", true), "the device restarted after a reboot command");
  assert.equal(likelyCauseText("network", true), "the screen's network connection");
});

test("outageLines tells an unfinished outage only for a screen that is offline now", () => {
  const open: Outage = { offline_since: "2026-10-28T09:01:30Z" };
  assert.deepEqual(outageLines(screen(false, open)), ["Last outage: offline since 2026-10-28T09:01:30Z"]);
  assert.deepEqual(outageLines(screen(true, open)), []);
});

test("outageLines prints only well-formed server values", () => {
  assert.deepEqual(outageLines(undefined), []);
  assert.deepEqual(outageLines(screen(true)), []);
  assert.deepEqual(outageLines(screen(true, { offline_since: "yesterday", back_at: "2026-10-28T09:08:00Z" } as Outage)), []);
  assert.deepEqual(outageLines(screen(true, { offline_since: "2026-10-28T09:01:30Z\nforged: line", back_at: "2026-10-28T09:08:00Z" } as Outage)), []);
  assert.deepEqual(outageLines(screen(true, { ...ended, duration_s: -5 })), [
    "Last outage: offline from 2026-10-28T09:01:30Z to 2026-10-28T09:08:00Z", "Likely cause: the device restarted (power loss or reboot).",
  ]);
  assert.equal(outageLines(screen(true, { ...ended, duration_s: 7_500 }))[0], "Last outage: offline from 2026-10-28T09:01:30Z to 2026-10-28T09:08:00Z (2h 5m)");
  assert.equal(outageLines(screen(true, { ...ended, duration_s: 90_000 }))[0], "Last outage: offline from 2026-10-28T09:01:30Z to 2026-10-28T09:08:00Z (1d 1h)");
  assert.equal(outageLines(screen(true, { ...ended, duration_s: 45 }))[0], "Last outage: offline from 2026-10-28T09:01:30Z to 2026-10-28T09:08:00Z (45s)");
});

test("screen show passes last_outage through and prints the Last outage block", async () => {
  const transport = new FakeTransport().on("GET", "/api/screens/scr_LOBBY", () => ({ status: 200, headers: {}, body: screen(true, ended) }));
  const json = await cli(["--json", "screen", "show", "scr_LOBBY"], transport);
  assert.equal(json.code, 0, json.stdout);
  assert.deepEqual((JSON.parse(json.stdout) as { data: { last_outage: Outage } }).data.last_outage, ended);
  const human = await cli(["--human", "screen", "show", "scr_LOBBY"], transport);
  assert.match(human.stdout, /\nLast outage: offline from 2026-10-28T09:01:30Z to 2026-10-28T09:08:00Z \(6m 30s\)\nLikely cause: the device restarted \(power loss or reboot\)\.(\n|$)/);

  const quiet = new FakeTransport().on("GET", "/api/screens/scr_LOBBY", () => ({ status: 200, headers: {}, body: screen(true) }));
  const none = await cli(["--human", "screen", "show", "scr_LOBBY"], quiet);
  assert.doesNotMatch(none.stdout, /Last outage|Likely cause/);
});
