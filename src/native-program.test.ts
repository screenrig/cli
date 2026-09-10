import assert from "node:assert/strict";
import { chmod, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { networkError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

async function runtimeFor(argv: string[], transport: FakeTransport, authenticated: boolean) {
  const configDir = await testTemp("native-program-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  if (authenticated) {
    await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), {
      api_url: "https://api.screenrig.ai",
      token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }, fs);
  }
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let errors = "";
  stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
  const runtime: CliRuntime = {
    argv: ["--json", ...argv], env: fs.env, stdout, stderr, fs, transport,
    now: () => new Date("2026-09-10T12:00:00Z"), sleep: async () => undefined,
    homedir: fs.homedir, cwd: () => configDir,
  };
  return {
    runtime, configDir, output: () => output, errors: () => errors,
    async dispose() {
      stdout.end();
      stderr.end();
      await rm(configDir, { recursive: true, force: true });
    },
  };
}

for (const outcome of ["success", "rejection"] as const) {
  test(`native action waits for deferred transport ${outcome} and emits one envelope`, { timeout: 5000 }, async () => {
    let started!: () => void;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const responseReady = new Promise<void>((resolve) => { release = resolve; });
    const transport = new FakeTransport().on("GET", "/api/v1/account", async () => {
      started();
      await responseReady;
      if (outcome === "rejection") throw networkError("Deferred transport failed.");
      return { status: 200, headers: {}, body: { id: "acc_TEST", revision: 1, credit_remaining: 2000 } };
    });
    const fixture = await runtimeFor(["account", "show"], transport, true);
    let settled = false;
    const pending = run(fixture.runtime).then((code) => { settled = true; return code; });
    try {
      assert.equal(await Promise.race([requested.then(() => "requested"), pending.then(() => "completed")]), "requested");
      await setImmediate();
      assert.equal(settled, false, "run must await the action's transport promise");
      assert.equal(fixture.output(), "", "no envelope may be emitted before the action finishes");
      release();
      const code = await pending;
      assert.equal(code, outcome === "success" ? ExitCode.Success : ExitCode.Network);
      const lines = fixture.output().trim().split("\n");
      assert.equal(lines.length, 1, fixture.output());
      const envelope = JSON.parse(lines[0]!);
      assert.equal(envelope.ok, outcome === "success");
      if (outcome === "success") assert.equal(envelope.data.id, "acc_TEST");
      else assert.equal(envelope.error.code, "transport_error");
      assert.equal(fixture.errors(), "");
      assert.equal(transport.calls.length, 1);
    } finally {
      release();
      await pending;
      await fixture.dispose();
    }
  });
}

test("unauthenticated native mutation actions reject before local preparation or transport", async () => {
  for (const argv of [
    ["app", "update", "app_TEST", "missing-app", "--if-match", "1"],
    ["media", "generate", "--prompt", "A sample information board"],
    ["media", "upload-batch", "missing-manifest.json", "--state", "resume.json"],
  ]) {
    const transport = new FakeTransport();
    const fixture = await runtimeFor(argv, transport, false);
    fixture.runtime.cwd = () => { assert.fail("unauthenticated action started local preparation"); };
    fixture.runtime.runProcess = async () => { assert.fail("unauthenticated action started a child process"); };
    fixture.runtime.signedRawPut = async () => { assert.fail("unauthenticated action started an upload"); };
    try {
      assert.equal(await run(fixture.runtime), ExitCode.Auth, fixture.output());
      const envelope = JSON.parse(fixture.output());
      assert.equal(envelope.error.code, "not_enrolled");
      assert.equal(envelope.error.next.command, "screenrig agent enroll --email ADDRESS");
      assert.equal(transport.calls.length, 0);
      assert.deepEqual(await readdir(fixture.configDir), [], "authentication failure must not create retry or enrollment state");
    } finally {
      await fixture.dispose();
    }
  }
});
