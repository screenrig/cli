import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdir, open, readFile, rename, chmod, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { EVENT_STREAM_BACKOFF_CAP_MS, EVENT_STREAM_BACKOFF_MS, formatEventLine } from "./commands.js";
import { run, type CliRuntime } from "./main.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import { ExitCode } from "./exit-codes.js";
import { CliError, makeProblem, networkError } from "./problems.js";
import type { ConfigFs } from "./config.js";
import { isWorldOrGroupReadable, writeConfigAtomic, readConfigFile } from "./config.js";
import type { Operation } from "./adapters/protocol.js";
import { SDK_PROTOCOL_VERSION } from "./adapters/sdk-injection.js";
import { testTemp } from "./test-temp.js";
import { resetFfmpegToolchainCache } from "./media/ffmpeg.js";

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function withRuntime(
  argv: string[],
  transport: FakeTransport,
  extra?: Partial<CliRuntime>,
): Promise<{ code: number; stdout: string; stderr: string; configDir: string }> {
  const configDir = extra?.fs ? "" : await testTemp("cfg-");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const fsLike: ConfigFs = extra?.fs ?? {
    mkdir,
    open,
    rename,
    rm,
    chmod,
    stat,
    homedir: () => configDir,
    env: { XDG_CONFIG_HOME: configDir },
  };
  const runtime: CliRuntime = {
    argv,
    env: fsLike.env,
    stdout,
    stderr,
    now: () => new Date("2026-08-14T17:00:00.000Z"),
    sleep: async () => undefined,
    homedir: fsLike.homedir,
    cwd: () => process.cwd(),
    fs: fsLike,
    transport,
    ...extra,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: await outP, stderr: await errP, configDir };
}

test("first authenticated use enrolls, persists, verifies, resumes, and pairs the screen", async () => {
  const transport = memoryBackend();
  const { code, stdout, configDir } = await withRuntime(
    ["--json", "screen", "pair", "abc234", "--label", "Lobby"],
    transport,
  );
  assert.equal(code, 0);
  const envelope = JSON.parse(stdout) as {
    ok: boolean;
    data: { public_url: string; screen: { id: string; label: string } };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.screen.label, "Lobby");
  assert.equal(envelope.data.public_url, "https://play.screenrig.ai/s/scr_public_pairing");
  assert.ok(!stdout.includes("sr_live_tokidAAAAAAAAAAAAAAAA_AAAA"));
  const methods = transport.calls.map((call) => `${call.method} ${call.path}`);
  assert.deepEqual(methods.slice(0, 3), [
    "POST /api/v1/enrollments",
    "GET /api/v1/account",
    "POST /api/v1/screens/pair",
  ]);
  assert.ok(transport.calls[0]?.headers?.["idempotency-key"]);
  assert.ok(transport.calls[0]?.headers?.["x-request-id"]);
  const enrollBody = transport.calls[0]?.body as { client_id?: string; beta_key?: string };
  assert.match(enrollBody.client_id ?? "", /^cli_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(enrollBody).sort(), ["client_id"]);
  const verification = transport.calls.find((call) => call.path === "/api/v1/account");
  assert.match(verification?.headers?.authorization ?? "", /^Bearer sr_live_/);
  const pairing = transport.calls.find((call) => call.path === "/api/v1/screens/pair");
  assert.deepEqual(pairing?.body, { code: "ABC234", label: "Lobby" });
  for (const call of transport.calls) {
    assert.ok(!call.path.includes("/bootstrap"));
    assert.ok(!JSON.stringify(call.body ?? {}).includes("bootstrap"));
  }
  const cfgPath = path.join(configDir, "screenrig", "config.json");
  const st = await stat(cfgPath);
  assert.equal(st.mode & 0o777, 0o600);
  const config = await readConfigFile(cfgPath, {
    mkdir,
    open,
    rename,
    rm,
    chmod,
    stat,
    homedir: () => configDir,
    env: { XDG_CONFIG_HOME: configDir },
  });
  assert.equal(config?.account_id, "acc_AAAAAAAAAAAAAAAAAAAAAAAA");
  assert.ok(config?.token);
  assert.equal(config?.enrollment, undefined);
  assert.ok(!JSON.stringify(config).includes("pairing"));
  await rm(configDir, { recursive: true, force: true });
});

test("first-use enroll includes beta_key when --beta-key is set", async () => {
  const transport = memoryBackend();
  const { code, stdout, configDir } = await withRuntime(
    ["--json", "--beta-key", "screenrig-beta-program", "account", "show"],
    transport,
  );
  assert.equal(code, 0, stdout);
  const enroll = transport.calls.find((call) => call.path === "/api/v1/enrollments");
  const body = enroll?.body as { client_id?: string; beta_key?: string };
  assert.match(body.client_id ?? "", /^cli_[A-Za-z0-9_-]{43}$/);
  assert.equal(body.beta_key, "screenrig-beta-program");
  assert.deepEqual(Object.keys(body).sort(), ["beta_key", "client_id"]);
  await rm(configDir, { recursive: true, force: true });
});

test("first-use enroll includes beta_key from SCREENRIG_BETA_KEY when the flag is unset", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("enroll-beta-env-");
  const fsLike = {
    mkdir,
    open,
    rename,
    rm,
    chmod,
    stat,
    homedir: () => configDir,
    env: { XDG_CONFIG_HOME: configDir, SCREENRIG_BETA_KEY: "screenrig-beta-program" },
  };
  const result = await withRuntime(["--json", "account", "show"], transport, { fs: fsLike });
  assert.equal(result.code, 0, result.stdout);
  const enroll = transport.calls.find((call) => call.path === "/api/v1/enrollments");
  assert.deepEqual(enroll?.body, {
    client_id: (enroll?.body as { client_id: string }).client_id,
    beta_key: "screenrig-beta-program",
  });
  await rm(configDir, { recursive: true, force: true });
});

test("first-use enroll prefers --beta-key over SCREENRIG_BETA_KEY", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("enroll-beta-flag-wins-");
  const fsLike = {
    mkdir,
    open,
    rename,
    rm,
    chmod,
    stat,
    homedir: () => configDir,
    env: { XDG_CONFIG_HOME: configDir, SCREENRIG_BETA_KEY: "from-env" },
  };
  const result = await withRuntime(
    ["--json", "--beta-key", "from-flag", "account", "show"],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, 0, result.stdout);
  const enroll = transport.calls.find((call) => call.path === "/api/v1/enrollments");
  assert.equal((enroll?.body as { beta_key?: string }).beta_key, "from-flag");
  await rm(configDir, { recursive: true, force: true });
});

test("existing credential skips enrollment and directly runs the original command", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("existing-command-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );
  const result = await withRuntime(["--json", "screen", "list"], transport, { fs: fsLike });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(transport.calls.some((call) => call.path === "/api/v1/enrollments"), false);
  assert.equal(transport.calls[0]?.path, "/api/v1/screens");
  await rm(configDir, { recursive: true, force: true });
});

test("auth revoke requires explicit confirmation and never auto-enrolls", async () => {
  const transport = new FakeTransport();
  const configDir = await testTemp("revoke-confirm-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  const original = { api_url: "https://api.screenrig.ai", token: "sr_live_current_private_secret", account_id: "acc_current" };
  await writeConfigAtomic(configPath, original, fsLike);

  let result = await withRuntime(["--json", "auth", "revoke"], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Usage);
  assert.match((JSON.parse(result.stdout) as { error: { detail: string } }).error.detail, /requires --yes/);
  assert.deepEqual(await readConfigFile(configPath, fsLike), original);
  assert.equal(transport.calls.length, 0);

  await rm(configPath, { force: true });
  result = await withRuntime(["--json", "auth", "revoke", "--yes"], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Usage);
  assert.match((JSON.parse(result.stdout) as { error: { detail: string } }).error.detail, /No stored ScreenRig account credential/);
  assert.equal(transport.calls.length, 0);
  await rm(configDir, { recursive: true, force: true });
});

test("auth revoke confirms server success before atomically removing all local credential state", async () => {
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/account/credential/revoke", () => ({
    status: 204,
    headers: { "cache-control": "private, no-store", "x-request-id": "req_revokeAAAAAAAAAAAAAAAA" },
    body: undefined,
  }));
  const configDir = await testTemp("revoke-success-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  const token = "sr_live_current_private_secret";
  await writeConfigAtomic(configPath, {
    api_url: "https://api.screenrig.ai",
    token,
    account_id: "acc_current",
    enrollment: { client_id: `cli_${"a".repeat(43)}`, idempotency_key: "enrollment-retry-key" },
    screen_provision: { idempotency_key: "screen-provision-key", label: "Demo" },
    browser_setup: { idempotency_key: "browser-setup-key", code: "ABC234" },
  }, fsLike);

  const result = await withRuntime(["--json", "auth", "revoke", "--yes"], transport, { fs: fsLike });
  assert.equal(result.code, 0, result.stdout);
  const envelope = JSON.parse(result.stdout) as { ok: true; data: Record<string, unknown> };
  assert.deepEqual(envelope.data, {
    revoked: true,
    local_credential_removed: true,
    account_preserved: true,
    screens_preserved: true,
    recoverable: false,
  });
  assert.doesNotMatch(result.stdout, /current_private_secret|acc_current|enrollment-retry-key|browser-setup-key/);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]?.path, "/api/v1/account/credential/revoke");
  assert.equal(transport.calls[0]?.headers?.authorization, `Bearer ${token}`);
  assert.equal(transport.calls[0]?.headers?.["idempotency-key"], undefined);
  assert.deepEqual(await readConfigFile(configPath, fsLike), {
    api_url: "https://api.screenrig.ai",
    updated_at: "2026-08-14T17:00:00.000Z",
  });
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  await rm(configDir, { recursive: true, force: true });
});

test("auth revoke retains local state on a server failure and gives a safe retry", async () => {
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/account/credential/revoke", () => ({
    status: 503,
    headers: { "content-type": "application/problem+json" },
    body: {
      type: "https://screenrig.ai/problems/dependency-unavailable",
      title: "Required dependency is unavailable",
      status: 503,
      detail: "Credential revocation is temporarily unavailable.",
      code: "dependency_unavailable",
    },
  }));
  const configDir = await testTemp("revoke-failure-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  const original = {
    api_url: "https://api.screenrig.ai",
    token: "sr_live_current_private_secret",
    account_id: "acc_current",
    browser_setup: { idempotency_key: "browser-setup-key", code: "ABC234" },
  };
  await writeConfigAtomic(configPath, original, fsLike);

  const result = await withRuntime(["--json", "auth", "revoke", "--yes"], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Server);
  const envelope = JSON.parse(result.stdout) as { error: { code: string; next: { command: string; reason: string } } };
  assert.equal(envelope.error.code, "dependency_unavailable");
  assert.equal(envelope.error.next.command, "screenrig auth revoke --yes");
  assert.match(envelope.error.next.reason, /Local credential state was retained/);
  assert.deepEqual(await readConfigFile(configPath, fsLike), original);
  assert.doesNotMatch(result.stdout, /current_private_secret|browser-setup-key/);
  await rm(configDir, { recursive: true, force: true });
});

test("auth revoke retries the exact revoked bearer after cleanup failure and completes local cleanup", async () => {
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/account/credential/revoke", () => ({
    status: 204,
    headers: { "cache-control": "private, no-store" },
    body: undefined,
  }));
  const configDir = await testTemp("revoke-cleanup-failure-");
  const configPath = path.join(configDir, "screenrig", "config.json");
  const realFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const original = {
    api_url: "https://api.screenrig.ai",
    token: "sr_live_current_private_secret",
    account_id: "acc_current",
  };
  await writeConfigAtomic(configPath, original, realFs);
  const interruptedFs: ConfigFs = {
    ...realFs,
    rename: async (from, to) => {
      if (to === configPath) {
        throw new Error("simulated cleanup failure sr_live_current_private_secret");
      }
      await rename(from, to);
    },
  };

  const result = await withRuntime(["--json", "auth", "revoke", "--yes"], transport, { fs: interruptedFs });
  assert.equal(result.code, ExitCode.Config);
  const envelope = JSON.parse(result.stdout) as { error: { detail: string; next: { command: string } } };
  assert.match(envelope.error.detail, /server revoked.*atomic local cleanup failed/i);
  assert.equal(envelope.error.next.command, "screenrig auth revoke --yes");
  assert.doesNotMatch(result.stdout, /current_private_secret/);
  assert.deepEqual(await readConfigFile(configPath, realFs), original);

  const retry = await withRuntime(["--json", "auth", "revoke", "--yes"], transport, { fs: realFs });
  assert.equal(retry.code, 0, retry.stdout);
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[1]?.headers?.authorization, `Bearer ${original.token}`);
  assert.deepEqual(await readConfigFile(configPath, realFs), {
    api_url: "https://api.screenrig.ai",
    updated_at: "2026-08-14T17:00:00.000Z",
  });
  await rm(configDir, { recursive: true, force: true });
});

test("screen pair normalizes safe lowercase input and reports canonical uppercase", async () => {
  const transport = memoryBackend();
  const result = await withRuntime(["screen", "pair", "abc234", "--label", "Lobby"], transport);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /Screen paired/);
  assert.match(result.stdout, /code: ABC234/);
  assert.deepEqual(transport.calls.at(-1)?.body, { code: "ABC234", label: "Lobby" });
});

test("screen pair rejects ambiguous or malformed codes before claiming", async () => {
  const transport = memoryBackend();
  const result = await withRuntime(["--json", "screen", "pair", "ABCI01"], transport);
  assert.equal(result.code, ExitCode.Usage);
  assert.equal(transport.calls.some((call) => call.path === "/api/v1/screens/pair"), false);
  assert.match(result.stdout, /23456789ABCDEFGHJKMNPQRSTUVWXYZ/);
});

test("screen provision requires exactly one explicit delivery mode", async () => {
  for (const argv of [
    ["--json", "screen", "provision"],
    ["--json", "screen", "provision", "--open", "--print-url"],
  ]) {
    const transport = memoryBackend();
    const result = await withRuntime(argv, transport);
    assert.equal(result.code, ExitCode.Usage);
    assert.equal(transport.calls.some((call) => call.path === "/api/v1/screens/provision"), false);
    await rm(result.configDir, { recursive: true, force: true });
  }
});

test("screen provision --open launches by argv and returns only safe fields", async () => {
  const transport = memoryBackend();
  const opened: string[] = [];
  const result = await withRuntime(
    ["--json", "screen", "provision", "--open", "--label", "Demo"],
    transport,
    { openUrl: async (url) => { opened.push(url); return true; } },
  );
  assert.equal(result.code, 0, result.stdout);
  assert.match(opened[0] ?? "", /#provision=[A-Za-z0-9_-]{43}$/);
  const envelope = JSON.parse(result.stdout) as { data: Record<string, unknown> };
  assert.deepEqual(Object.keys(envelope.data).sort(), ["expires_at", "opened", "public_url", "screen_id"]);
  assert.equal(envelope.data.opened, true);
  assert.ok(!result.stdout.includes("#provision="));
  assert.ok(!result.stdout.includes("P".repeat(43)));
  const provision = transport.calls.find((call) => call.path === "/api/v1/screens/provision");
  assert.equal(provision?.headers?.["idempotency-key"]?.length !== 0, true);
  assert.deepEqual(provision?.body, { label: "Demo" });
  const configPath = path.join(result.configDir, "screenrig", "config.json");
  assert.equal((await readConfigFile(configPath, { mkdir, open, rename, rm, chmod, stat, homedir: () => result.configDir, env: { XDG_CONFIG_HOME: result.configDir } }))?.screen_provision, undefined);
  await rm(result.configDir, { recursive: true, force: true });
});

test("screen provision --print-url explicitly returns the one-time URL without opening it", async () => {
  const transport = memoryBackend();
  let opens = 0;
  const result = await withRuntime(
    ["--json", "screen", "provision", "--print-url"],
    transport,
    { openUrl: async () => { opens += 1; return true; } },
  );
  assert.equal(result.code, 0, result.stdout);
  const envelope = JSON.parse(result.stdout) as { data: { provisioning_url: string; public_url: string } };
  assert.match(envelope.data.provisioning_url, /#provision=[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(envelope.data.public_url).hash, "");
  assert.equal(opens, 0);
  await rm(result.configDir, { recursive: true, force: true });
});

test("failed browser launch retains only the exact retry key and label", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("provision-retry-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const argv = ["--json", "screen", "provision", "--open", "--label", "Retry demo"];
  const first = await withRuntime(argv, transport, { fs: fsLike, openUrl: async () => false });
  const second = await withRuntime(argv, transport, { fs: fsLike, openUrl: async () => false });
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  const calls = transport.calls.filter((call) => call.path === "/api/v1/screens/provision");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.headers?.["idempotency-key"], calls[1]?.headers?.["idempotency-key"]);
  assert.deepEqual((await readConfigFile(path.join(configDir, "screenrig", "config.json"), fsLike))?.screen_provision, {
    idempotency_key: calls[0]?.headers?.["idempotency-key"],
    label: "Retry demo",
  });
  const persisted = JSON.stringify(await readConfigFile(path.join(configDir, "screenrig", "config.json"), fsLike));
  assert.ok(!persisted.includes("#provision="));
  assert.ok(!persisted.includes("P".repeat(43)));
  await rm(configDir, { recursive: true, force: true });
});

test("first use resumes into browser setup claim with safe fragment-free output", async () => {
  const transport = memoryBackend();
  const result = await withRuntime(["--json", "browser", "setup", "--code", "abc-234"], transport);
  assert.equal(result.code, 0, result.stdout);
  const envelope = JSON.parse(result.stdout) as { data: Record<string, unknown> };
  assert.deepEqual(envelope.data, {
    code: "ABC-234",
    status: "claimed",
    player_public_url: "https://play.screenrig.ai/s/browser-link-screen",
  });
  assert.deepEqual(transport.calls.slice(0, 3).map((call) => `${call.method} ${call.path}`), [
    "POST /api/v1/enrollments",
    "GET /api/v1/account",
    "POST /api/v1/account/browser-links/claim",
  ]);
  const claim = transport.calls.at(-1);
  assert.deepEqual(claim?.body, { code: "ABC234" });
  assert.ok(claim?.headers?.["idempotency-key"]);
  assert.doesNotMatch(result.stdout, /#provision=|provisioning_url|token|cookie|proof/i);
  const config = await readConfigFile(path.join(result.configDir, "screenrig", "config.json"), {
    mkdir, open, rename, rm, chmod, stat,
    homedir: () => result.configDir,
    env: { XDG_CONFIG_HOME: result.configDir },
  });
  assert.equal(config?.browser_setup, undefined);
  await rm(result.configDir, { recursive: true, force: true });
});

test("browser setup --open opens only the public handoff URL by argv", async () => {
  const transport = memoryBackend();
  const opened: string[] = [];
  const result = await withRuntime(
    ["--json", "browser", "setup", "--code", "ABC234", "--open"],
    transport,
    { openUrl: async (url) => { opened.push(url); return true; } },
  );
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(opened, ["https://screenrig.ai/ABC-234"]);
  const envelope = JSON.parse(result.stdout) as { data: Record<string, unknown> };
  assert.equal(envelope.data.opened, true);
  assert.equal(envelope.data.code, "ABC-234");
  assert.equal(envelope.data.player_public_url, "https://play.screenrig.ai/s/browser-link-screen");
  assert.doesNotMatch(JSON.stringify({ opened, envelope }), /#provision=|provisioning_url|token|cookie|proof/i);
  await rm(result.configDir, { recursive: true, force: true });
});

test("browser setup fails closed on extra delivery fields without echoing them", async () => {
  const transport = new FakeTransport();
  const secret = `https://play.screenrig.ai/s/browser-link-screen#provision=${"S".repeat(43)}`;
  transport.on("POST", "/api/v1/enrollments", () => ({
    status: 201,
    headers: { "cache-control": "private, no-store" },
    body: {
      account: { id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA" },
      token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      issuance_id: "iss_AAAAAAAAAAAAAAAAAAAAAAAA",
      issuance_expires_at: "2026-08-14T17:10:00.000Z",
    },
  }));
  transport.on("GET", "/api/v1/account", () => ({ status: 200, headers: {}, body: { id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA" } }));
  transport.on("POST", "/api/v1/account/browser-links/claim", () => ({
    status: 201,
    headers: { "cache-control": "private, no-store" },
    body: {
      session_id: "bls_fixture",
      status: "claimed",
      screen: {
        id: "scr_browser_link",
        public_id: "browser-link-screen",
        state: "pairing_pending",
        public_url: "https://play.screenrig.ai/s/browser-link-screen",
      },
      provisioning_url: secret,
    },
  }));
  const result = await withRuntime(["--json", "browser", "setup", "--code", "ABC234"], transport);
  assert.equal(result.code, ExitCode.Usage);
  assert.doesNotMatch(result.stdout, /#provision=|provisioning_url|SSSSSS/i);
  await rm(result.configDir, { recursive: true, force: true });
});

test("browser setup rejects malformed codes before claim and keeps exact ambiguous retry state", async () => {
  const invalid = await withRuntime(["--json", "browser", "setup", "--code", "ABC10I"], memoryBackend());
  assert.equal(invalid.code, ExitCode.Usage);
  await rm(invalid.configDir, { recursive: true, force: true });

  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/enrollments", () => ({
    status: 201,
    headers: { "cache-control": "private, no-store" },
    body: {
      account: { id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA" },
      token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      issuance_id: "iss_AAAAAAAAAAAAAAAAAAAAAAAA",
      issuance_expires_at: "2026-08-14T17:10:00.000Z",
    },
  }));
  transport.on("GET", "/api/v1/account", () => ({ status: 200, headers: {}, body: { id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA" } }));
  transport.on("POST", "/api/v1/account/browser-links/claim", () => ({
    status: 503,
    headers: { "content-type": "application/problem+json" },
    body: { status: 503, code: "dependency_unavailable", title: "Unavailable", detail: "Retry." },
  }));
  const configDir = await testTemp("browser-claim-retry-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await withRuntime(["--json", "browser", "setup", "--code", "ABC234"], transport, { fs: fsLike });
  await withRuntime(["--json", "browser", "setup", "--code", "ABC-234"], transport, { fs: fsLike });
  const claims = transport.calls.filter((call) => call.path === "/api/v1/account/browser-links/claim");
  assert.equal(claims.length, 2);
  assert.equal(claims[0]?.headers?.["idempotency-key"], claims[1]?.headers?.["idempotency-key"]);
  assert.deepEqual((await readConfigFile(path.join(configDir, "screenrig", "config.json"), fsLike))?.browser_setup, {
    idempotency_key: claims[0]?.headers?.["idempotency-key"],
    code: "ABC234",
  });
  await rm(configDir, { recursive: true, force: true });
});

test("expired enrollment replay surfaces 410 and reuses the persisted identity without pairing", async () => {
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/enrollments", () => ({
    status: 410,
    headers: { "content-type": "application/problem+json" },
    body: {
      status: 410,
      code: "credential_issuance_expired",
      title: "Credential issuance expired",
      detail: "The exact enrollment delivery window expired.",
    },
  }));
  const configDir = await testTemp("expired-enrollment-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  const retryState = {
    client_id: `cli_${"E".repeat(43)}`,
    idempotency_key: "enroll-expired-exact-retry",
  };
  await writeConfigAtomic(configPath, {
    api_url: "https://api.screenrig.ai",
    enrollment: retryState,
  }, fsLike);
  const result = await withRuntime(["--json", "screen", "pair", "ABC234"], transport, { fs: fsLike });
  assert.notEqual(result.code, 0);
  assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "credential_issuance_expired");
  assert.deepEqual(transport.calls.map((call) => call.path), ["/api/v1/enrollments"]);
  assert.equal(transport.calls[0]?.headers?.["idempotency-key"], retryState.idempotency_key);
  assert.deepEqual(transport.calls[0]?.body, { client_id: retryState.client_id });
  assert.deepEqual((await readConfigFile(configPath, fsLike))?.enrollment, retryState);
  await rm(configDir, { recursive: true, force: true });
});

test("refuses group-readable config unless repairing", async () => {
  const configDir = await testTemp("insecure-");
  const cfgPath = path.join(configDir, "screenrig", "config.json");
  await mkdir(path.dirname(cfgPath), { recursive: true });
  await writeFile(cfgPath, JSON.stringify({ api_url: "https://api.screenrig.ai", token: "sr_live_abc_def" }), { mode: 0o644 });
  await chmod(cfgPath, 0o644);
  const transport = memoryBackend();
  const { code, stdout } = await withRuntime(["--json", "account", "show"], transport, {
    fs: {
      mkdir,
      open,
      rename,
      rm,
      chmod,
      stat,
      homedir: () => configDir,
      env: { XDG_CONFIG_HOME: configDir },
    },
  });
  assert.equal(code, ExitCode.Config);
  const envelope = JSON.parse(stdout) as { ok: boolean; error: { code: string } };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "config_error");
  await rm(configDir, { recursive: true, force: true });
});

test("normalizes RFC 9457 problems and maps exit codes", async () => {
  const transport = new FakeTransport();
  transport.on("GET", "/api/v1/account", () => ({
    status: 412,
    headers: { "x-request-id": "req_AAAAAAAAAAAAAAAAAAAAAAAA" },
    body: {
      type: "https://screenrig.ai/problems/revision-conflict",
      title: "Resource revision does not match",
      status: 412,
      detail: "Playlist changed after revision 7 was read.",
      code: "revision_conflict",
      request_id: "req_AAAAAAAAAAAAAAAAAAAAAAAA",
      current_revision: 8,
      next: {
        command: "screenrig playlist get pl_01 --json",
        reason: "Fetch revision 8, reapply the intended edit, and retry.",
      },
    },
  }));
  const configDir = await testTemp("prob-");
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } },
  );
  const { code, stdout } = await withRuntime(["--json", "account", "show"], transport, {
    fs: { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } },
  });
  assert.equal(code, ExitCode.Precondition);
  const envelope = JSON.parse(stdout) as { ok: false; error: { code: string; next: { command: string } } };
  assert.equal(envelope.error.code, "revision_conflict");
  assert.equal(envelope.error.next.command, "screenrig playlist get pl_01 --json");
  await rm(configDir, { recursive: true, force: true });
});

test("operations wait polls until a terminal success", async () => {
  const transport = new FakeTransport();
  let calls = 0;
  transport.on("GET", "/api/v1/operations/op_wait", () => {
    calls += 1;
    const state = calls === 1 ? "running" : "succeeded";
    const operation: Operation = {
      id: "op_wait",
      kind: "application.upload",
      state,
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:01.000Z",
    };
    return { status: 200, headers: {}, body: operation };
  });
  const configDir = await testTemp("op-");
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } },
  );
  const { code, stdout } = await withRuntime(["--json", "operations", "wait", "op_wait", "--poll-ms", "1"], transport, {
    fs: { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } },
  });
  assert.equal(code, 0);
  assert.ok(calls >= 2);
  const envelope = JSON.parse(stdout) as { ok: true; data: { state: string }; operation_id: string };
  assert.equal(envelope.data.state, "succeeded");
  await rm(configDir, { recursive: true, force: true });
});

test("events list sends after and limit when the user supplies them", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("ev-list-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );

  const limited = await withRuntime(
    ["--json", "events", "list", "--after", "ev1_0", "--limit", "25"],
    transport,
    { fs: fsLike },
  );
  assert.equal(limited.code, 0, limited.stdout);
  const limitedCall = transport.calls.find((call) => call.path === "/api/v1/events");
  assert.equal(limitedCall?.query?.after, "ev1_0");
  assert.equal(limitedCall?.query?.limit, "25");

  const unscoped = await withRuntime(["--json", "events", "list"], transport, { fs: fsLike });
  assert.equal(unscoped.code, 0, unscoped.stdout);
  const emptyPage = JSON.parse(unscoped.stdout) as { ok: true; data: { items: unknown[] } };
  assert.deepEqual(emptyPage.data.items, []);
  const defaultCall = transport.calls.filter((call) => call.path === "/api/v1/events").at(-1);
  assert.equal(defaultCall?.query?.after, undefined);
  assert.equal(defaultCall?.query?.limit, undefined);
  await rm(configDir, { recursive: true, force: true });
});

test("formatEventLine prints logfmt, never canned messages", () => {
  assert.equal(
    formatEventLine({
      cursor: "ev1_1",
      sequence: 1,
      type: "application.event",
      severity: "info",
      message: "Application emitted an event",
      details: { extra: { nested: true }, count: 2, placement_id: "weather", code: "cta.pressed" },
      at: "2026-08-14T17:00:00.000Z",
    }),
    "at=2026-08-14T17:00:00.000Z type=application.event severity=info code=cta.pressed placement_id=weather count=2",
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_2",
      sequence: 2,
      type: "runtime.reported",
      severity: "warning",
      message: "Runtime reported a bounded condition",
      details: { code: "decoder.stalled" },
      at: "2026-08-14T17:00:01.000Z",
    }),
    "at=2026-08-14T17:00:01.000Z type=runtime.reported severity=warning code=decoder.stalled",
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_3",
      sequence: 3,
      type: "account.created",
      severity: "info",
      message: "created",
      at: "2026-08-14T17:00:02.000Z",
    }),
    "at=2026-08-14T17:00:02.000Z type=account.created severity=info message=created",
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_4",
      sequence: 4,
      type: "",
      severity: "info",
      message: "Application emitted an event",
      at: "",
    }),
    undefined,
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_5",
      sequence: 5,
      type: "application.event",
      severity: "info",
      message: "Application emitted an event",
      at: "2026-08-14T17:00:03.000Z",
    }),
    undefined,
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_6",
      sequence: 6,
      type: "runtime.reported",
      severity: "warning",
      message: "Runtime reported a bounded condition",
      at: "2026-08-14T17:00:04.000Z",
    }),
    undefined,
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_7",
      sequence: 7,
      type: "account.enrolled",
      severity: "info",
      message: "account.enrolled",
      at: "2026-08-14T17:00:05.000Z",
    }),
    "at=2026-08-14T17:00:05.000Z type=account.enrolled severity=info",
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_8",
      sequence: 8,
      type: "application.event",
      severity: "info",
      message: "Doors open",
      resource: { type: "screen", id: "scr_1", revision: 3 },
      details: { code: "cta.pressed", placement_id: "weather", note: 'said "hi"' },
      at: "2026-08-18T19:30:48.471Z",
    }),
    'at=2026-08-18T19:30:48.471Z type=application.event severity=info resource_type=screen resource_id=scr_1 code=cta.pressed placement_id=weather note="said \\"hi\\"" message="Doors open"',
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_9",
      sequence: 9,
      type: "screen.screenshot_ready",
      severity: "info",
      message: "Screen screenshot ready",
      resource: { type: "screen", id: "scr_1" },
      details: {
        capture_id: "shot_1",
        token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr",
        authorization: "Bearer secret",
        pixels: "data:image/webp;base64,AAAA",
      },
      at: "2026-08-14T17:00:06.000Z",
    }),
    "at=2026-08-14T17:00:06.000Z type=screen.screenshot_ready severity=info resource_type=screen resource_id=scr_1 capture_id=shot_1",
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_10",
      sequence: 10,
      type: "application.event",
      severity: "info",
      message: "cta.pressed",
      details: { code: "cta.pressed", placement_id: "weather" },
      at: "2026-08-14T17:00:07.000Z",
    }),
    "at=2026-08-14T17:00:07.000Z type=application.event severity=info code=cta.pressed placement_id=weather",
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_11",
      sequence: 11,
      type: "screen.screenshot_ready",
      severity: "info",
      message: "shot_1",
      resource: { type: "screen", id: "scr_1" },
      details: { capture_id: "shot_1" },
      at: "2026-08-14T17:00:08.000Z",
    }),
    "at=2026-08-14T17:00:08.000Z type=screen.screenshot_ready severity=info resource_type=screen resource_id=scr_1 capture_id=shot_1 message=shot_1",
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_12",
      sequence: 12,
      type: "stream.cursor",
      severity: "info",
      message: "Stream cursor advanced",
      at: "2026-08-14T17:00:09.000Z",
    }),
    "at=2026-08-14T17:00:09.000Z type=stream.cursor severity=info",
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_13",
      sequence: 13,
      type: "stream.resync_required",
      severity: "info",
      message: "Stream replay state is no longer retained",
      at: "2026-08-14T17:00:10.000Z",
    }),
    "at=2026-08-14T17:00:10.000Z type=stream.resync_required severity=info",
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_14",
      sequence: 14,
      type: "runtime.reported",
      severity: "warning",
      message: "Player reported runtime status",
      details: { code: "decoder.stalled" },
      at: "2026-08-14T17:00:11.000Z",
    }),
    "at=2026-08-14T17:00:11.000Z type=runtime.reported severity=warning code=decoder.stalled",
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_15",
      sequence: 15,
      type: "screen.screenshot_requested",
      severity: "info",
      message: "Screenshot requested",
      details: { capture_id: "shot_1" },
      at: "2026-08-14T17:00:12.000Z",
    }),
    "at=2026-08-14T17:00:12.000Z type=screen.screenshot_requested severity=info capture_id=shot_1",
  );
  assert.equal(
    formatEventLine({
      cursor: "ev1_16",
      sequence: 16,
      type: "application.event",
      severity: "info",
      message: "Doors open",
      details: {
        extra_token: "sr_live_identifier_secret",
        object_key: "accounts/acc/objects/obj",
        upload_url: "https://example.invalid/put?X-Amz-Signature=abc",
        completion_nonce: "nonce-value",
        signed_url: "https://example.invalid/get?signature=abc",
        access_token: "secret-material",
        cookie: "session=abc",
        password: "secret-material",
        secret: "secret-material",
        note: "use sr_live_identifier_secret now",
        header: "Bearer secret-material",
        preview: "data:image/webp;base64,AAAA",
        code: "cta.pressed",
      },
      at: "2026-08-14T17:00:13.000Z",
    }),
    "at=2026-08-14T17:00:13.000Z type=application.event severity=info code=cta.pressed message=\"Doors open\"",
  );
});

test("events list prints data or silence", async () => {
  const transport = new FakeTransport();
  transport.on("GET", "/api/v1/events", () => ({
    status: 200,
    headers: { "x-request-id": "req_events" },
    body: {
      items: [
        {
          cursor: "ev1_1",
          sequence: 1,
          type: "application.event",
          severity: "info",
          message: "Application emitted an event",
          details: { code: "cta.pressed", placement_id: "weather" },
          at: "2026-08-14T17:00:00.000Z",
        },
        {
          cursor: "ev1_2",
          sequence: 2,
          type: "runtime.reported",
          severity: "warning",
          message: "Runtime reported a bounded condition",
          details: { code: "decoder.stalled" },
          at: "2026-08-14T17:00:01.000Z",
        },
        {
          cursor: "ev1_3",
          sequence: 3,
          type: "",
          severity: "info",
          message: "Application emitted an event",
          at: "",
        },
      ],
      next_cursor: "ev1_3",
    },
  }));
  const configDir = await testTemp("ev-list-human-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const printed = await withRuntime(["events", "list"], transport, { fs: fsLike });
  assert.equal(printed.code, 0, printed.stdout);
  assert.equal(
    printed.stdout,
    "at=2026-08-14T17:00:00.000Z type=application.event severity=info code=cta.pressed placement_id=weather\nat=2026-08-14T17:00:01.000Z type=runtime.reported severity=warning code=decoder.stalled\n",
  );
  assert.ok(!printed.stdout.includes("Application emitted an event"));
  assert.ok(!printed.stdout.includes("Runtime reported a bounded condition"));

  const emptyTransport = new FakeTransport();
  emptyTransport.on("GET", "/api/v1/events", () => ({
    status: 200,
    headers: { "x-request-id": "req_events_empty" },
    body: { items: [], next_cursor: "" },
  }));
  const silent = await withRuntime(["events", "list"], emptyTransport, { fs: fsLike });
  assert.equal(silent.code, 0, silent.stdout);
  assert.equal(silent.stdout, "");
  await rm(configDir, { recursive: true, force: true });
});

test("events follow parses SSE frames from the transport stream", async () => {
  const transport = memoryBackend();
  transport.pushStream(
    "id: ev1_1\nevent: message\ndata: {\"cursor\":\"ev1_1\",\"type\":\"account.created\",\"severity\":\"info\",\"message\":\"created\",\"at\":\"2026-08-14T17:00:00.000Z\"}\n\n",
  );
  transport.pushStream(
    "id: ev1_2\nevent: message\ndata: {\"cursor\":\"ev1_2\",\"type\":\"screen.paired\",\"severity\":\"info\",\"message\":\"paired\",\"at\":\"2026-08-14T17:00:01.000Z\"}\n\n",
  );
  const configDir = await testTemp("ev-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const { code, stdout } = await withRuntime(
    ["--json", "events", "follow", "--cursor", "ev1_0", "--timeout", "50"],
    transport,
    { fs: fsLike },
  );
  assert.equal(code, 0);
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2, stdout);
  const first = JSON.parse(lines[0] ?? "") as { ok: true; data: { type: string } };
  const second = JSON.parse(lines[1] ?? "") as { ok: true; data: { type: string } };
  assert.equal(first.data.type, "account.created");
  assert.equal(second.data.type, "screen.paired");
  assert.equal(transport.calls.at(-1)?.query?.after, "ev1_0");
  assert.equal(transport.calls.at(-1)?.query?.cursor, undefined);

  const human = await withRuntime(["events", "follow", "--timeout", "50"], transport, { fs: fsLike });
  assert.equal(human.code, 0, human.stdout);
  assert.equal(
    human.stdout,
    "at=2026-08-14T17:00:00.000Z type=account.created severity=info message=created\nat=2026-08-14T17:00:01.000Z type=screen.paired severity=info message=paired\n",
  );
  await rm(configDir, { recursive: true, force: true });
});

test("events follow writes a human line before the stream closes", async () => {
  const transport = memoryBackend();
  transport.pushStream(
    "id: ev1_1\nevent: message\ndata: {\"cursor\":\"ev1_1\",\"type\":\"account.created\",\"severity\":\"info\",\"message\":\"created\",\"at\":\"2026-08-14T17:00:00.000Z\"}\n\n",
  );
  const writes: string[] = [];
  let wroteBeforeClose = false;
  transport.afterStreamChunks = async (req) => {
    wroteBeforeClose = writes.some((chunk) => chunk.includes("account.created"));
    await new Promise<void>((resolve) => {
      if (req.signal?.aborted) {
        resolve();
        return;
      }
      req.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };
  const configDir = await testTemp("ev-live-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const stdout = new PassThrough();
  const origWrite = stdout.write.bind(stdout);
  stdout.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), cb?: (error?: Error | null) => void) => {
    writes.push(String(chunk));
    return origWrite(chunk as string | Buffer, encoding as BufferEncoding, cb);
  }) as typeof stdout.write;
  const code = await run({
    argv: ["events", "follow", "--timeout", "50"],
    env: fsLike.env,
    stdout,
    stderr: new PassThrough(),
    now: () => new Date("2026-08-14T17:00:00.000Z"),
    sleep: async () => undefined,
    homedir: fsLike.homedir,
    cwd: () => process.cwd(),
    fs: fsLike,
    transport,
  });
  assert.equal(code, 0);
  assert.equal(wroteBeforeClose, true, `stdout before abort: ${JSON.stringify(writes)}`);
  assert.equal(writes.join(""), "at=2026-08-14T17:00:00.000Z type=account.created severity=info message=created\n");
  await rm(configDir, { recursive: true, force: true });
});

test("events follow is silent when no events arrive", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("ev-empty-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const human = await withRuntime(["events", "follow", "--timeout", "50"], transport, { fs: fsLike });
  assert.equal(human.code, 0, human.stdout);
  assert.equal(human.stdout, "");
  const json = await withRuntime(["--json", "events", "follow", "--timeout", "50"], transport, { fs: fsLike });
  assert.equal(json.code, 0, json.stdout);
  const lines = json.stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, json.stdout);
  const envelope = JSON.parse(lines[0] ?? "") as { ok: true; data: { items: unknown[] } };
  assert.deepEqual(envelope.data.items, []);
  await rm(configDir, { recursive: true, force: true });
});

test("events --json omits tokens, pixels, authorization, and object keys", async () => {
  const leakedToken = "sr_live_evtAAAAAAAAAAAAAAAA_eventsecreeventsecreeventsecreeve";
  const leakedPixels = "data:image/webp;base64,QUFBQQ";
  const leakedAuth = "Bearer event-secret-material";
  const leakedObjectKey = "accounts/acc/objects/obj_eventsecret";
  const event = {
    cursor: "ev1_9",
    sequence: 9,
    type: "screen.screenshot_ready",
    severity: "info",
    message: "shot_1",
    resource: { type: "screen", id: "scr_1" },
    details: {
      capture_id: "shot_1",
      token: leakedToken,
      authorization: leakedAuth,
      pixels: leakedPixels,
      object_key: leakedObjectKey,
      upload_url: "https://example.invalid/put?X-Amz-Signature=abc",
      completion_nonce: "nonce-event-secret",
    },
    at: "2026-08-14T17:00:06.000Z",
  };
  const transport = new FakeTransport();
  transport.on("GET", "/api/v1/events", () => ({
    status: 200,
    headers: { "x-request-id": "req_events_json" },
    body: { items: [event], next_cursor: "ev1_9" },
  }));
  const configDir = await testTemp("ev-json-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const listed = await withRuntime(["--json", "events", "list"], transport, { fs: fsLike });
  assert.equal(listed.code, 0, listed.stdout);
  const listedEnvelope = JSON.parse(listed.stdout) as {
    ok: true;
    data: { items: Array<{ message: string; details: Record<string, unknown> }> };
  };
  assert.equal(listedEnvelope.data.items[0]?.message, "shot_1");
  assert.deepEqual(listedEnvelope.data.items[0]?.details, { capture_id: "shot_1" });
  assert.ok(!listed.stdout.includes(leakedToken));
  assert.ok(!listed.stdout.includes(leakedPixels));
  assert.ok(!listed.stdout.includes(leakedAuth));
  assert.ok(!listed.stdout.includes(leakedObjectKey));
  assert.ok(!listed.stdout.includes("X-Amz-Signature"));
  assert.ok(!listed.stdout.includes("nonce-event-secret"));

  const followTransport = memoryBackend();
  followTransport.pushStream(`id: ev1_9\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
  const followed = await withRuntime(["--json", "events", "follow", "--timeout", "50"], followTransport, { fs: fsLike });
  assert.equal(followed.code, 0, followed.stdout);
  const followLine = followed.stdout.split("\n").find((line) => line.length > 0) ?? "";
  const followEnvelope = JSON.parse(followLine) as { ok: true; data: { message: string; details: Record<string, unknown> } };
  assert.equal(followEnvelope.data.message, "shot_1");
  assert.deepEqual(followEnvelope.data.details, { capture_id: "shot_1" });
  assert.ok(!followed.stdout.includes(leakedToken));
  assert.ok(!followed.stdout.includes(leakedPixels));
  assert.ok(!followed.stdout.includes(leakedAuth));
  assert.ok(!followed.stdout.includes(leakedObjectKey));
  await rm(configDir, { recursive: true, force: true });
});

test("events follow prints scalar details and skips empty frames", async () => {
  const transport = memoryBackend();
  transport.pushStream(
    "id: ev1_1\nevent: message\ndata: {\"cursor\":\"ev1_1\",\"type\":\"application.event\",\"severity\":\"info\",\"message\":\"Application emitted an event\",\"details\":{\"code\":\"cta.pressed\",\"placement_id\":\"weather\"},\"at\":\"2026-08-14T17:00:00.000Z\"}\n\n",
  );
  transport.pushStream(
    "id: ev1_2\nevent: message\ndata: {\"cursor\":\"ev1_2\",\"type\":\"runtime.reported\",\"severity\":\"warning\",\"message\":\"Runtime reported a bounded condition\",\"details\":{\"code\":\"decoder.stalled\"},\"at\":\"2026-08-14T17:00:01.000Z\"}\n\n",
  );
  transport.pushStream("id: ev1_3\nevent: message\ndata: not-json\n\n");
  transport.pushStream(
    "id: ev1_4\nevent: message\ndata: {\"cursor\":\"ev1_4\",\"type\":\"\",\"severity\":\"info\",\"message\":\"Application emitted an event\",\"at\":\"\"}\n\n",
  );
  const configDir = await testTemp("ev-details-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const { code, stdout } = await withRuntime(["events", "follow", "--timeout", "50"], transport, { fs: fsLike });
  assert.equal(code, 0, stdout);
  assert.equal(
    stdout,
    "at=2026-08-14T17:00:00.000Z type=application.event severity=info code=cta.pressed placement_id=weather\nat=2026-08-14T17:00:01.000Z type=runtime.reported severity=warning code=decoder.stalled\n",
  );
  assert.ok(!stdout.includes("Application emitted an event"));
  assert.ok(!stdout.includes("Runtime reported a bounded condition"));
  await rm(configDir, { recursive: true, force: true });
});

function followEventFrame(id: string, type: string, at: string): string {
  return `id: ${id}\nevent: message\ndata: ${JSON.stringify({ cursor: id, type, severity: "info", message: type, at })}\n\n`;
}

test("events follow reconnects after the stream ends and prints both connections", async () => {
  const transport = memoryBackend();
  transport.queueStream({
    chunks: [followEventFrame("ev1_1", "account.created", "2026-08-14T17:00:00.000Z")],
  });
  transport.queueStream({
    chunks: [followEventFrame("ev1_2", "screen.paired", "2026-08-14T17:00:01.000Z")],
  });
  const configDir = await testTemp("ev-reconnect-done-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const { code, stdout, stderr } = await withRuntime(
    ["--json", "events", "follow", "--timeout", "50"],
    transport,
    { fs: fsLike },
  );
  assert.equal(code, 0, stdout);
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2, stdout);
  const first = JSON.parse(lines[0] ?? "") as { ok: true; data: { type: string } };
  const second = JSON.parse(lines[1] ?? "") as { ok: true; data: { type: string } };
  assert.equal(first.data.type, "account.created");
  assert.equal(second.data.type, "screen.paired");
  assert.ok(transport.calls.length >= 2, `expected reconnect, calls=${transport.calls.length}`);
  assert.equal(stderr, "");
  assert.ok(!stdout.includes("reconnect"));
  await rm(configDir, { recursive: true, force: true });
});

test("events follow reconnects after a mid-stream network error", async () => {
  const transport = memoryBackend();
  transport.queueStream({
    chunks: [followEventFrame("ev1_1", "account.created", "2026-08-14T17:00:00.000Z")],
    error: networkError("socket hang up"),
  });
  transport.queueStream({
    chunks: [followEventFrame("ev1_2", "screen.paired", "2026-08-14T17:00:01.000Z")],
  });
  const configDir = await testTemp("ev-reconnect-net-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const { code, stdout, stderr } = await withRuntime(
    ["--json", "events", "follow", "--timeout", "50"],
    transport,
    { fs: fsLike },
  );
  assert.equal(code, 0, stdout);
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2, stdout);
  const first = JSON.parse(lines[0] ?? "") as { ok: true; data: { type: string } };
  const second = JSON.parse(lines[1] ?? "") as { ok: true; data: { type: string } };
  assert.equal(first.data.type, "account.created");
  assert.equal(second.data.type, "screen.paired");
  assert.ok(!stderr.includes("secretsecret"));
  assert.ok(!stderr.includes("Bearer"));
  await rm(configDir, { recursive: true, force: true });
});

test("events follow resumes with after equal to the last SSE id", async () => {
  const transport = memoryBackend();
  transport.queueStream({
    chunks: [followEventFrame("ev1_1", "account.created", "2026-08-14T17:00:00.000Z")],
  });
  transport.queueStream({
    chunks: [followEventFrame("ev1_2", "screen.paired", "2026-08-14T17:00:01.000Z")],
  });
  const configDir = await testTemp("ev-reconnect-after-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const { code, stdout } = await withRuntime(
    ["--json", "events", "follow", "--after", "ev1_0", "--timeout", "50"],
    transport,
    { fs: fsLike },
  );
  assert.equal(code, 0, stdout);
  const streamCalls = transport.calls.filter((call) => call.path === "/api/v1/events/stream");
  assert.ok(streamCalls.length >= 2, `expected reconnect, calls=${streamCalls.length}`);
  assert.equal(streamCalls[0]?.query?.after, "ev1_0");
  assert.equal(streamCalls[1]?.query?.after, "ev1_1");
  await rm(configDir, { recursive: true, force: true });
});

test("events follow does not retry a persistent 401", async () => {
  const transport = memoryBackend();
  transport.streamHandler = async () => {
    throw new CliError(makeProblem("unauthorized", "Unauthorized", 401, "Bearer is not valid."));
  };
  const configDir = await testTemp("ev-reconnect-401-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const { code, stdout, stderr } = await withRuntime(
    ["--json", "events", "follow", "--timeout", "50"],
    transport,
    { fs: fsLike },
  );
  assert.equal(code, ExitCode.Auth, stdout);
  const envelope = JSON.parse(stdout) as { ok: false; error: { code: string; status: number } };
  assert.equal(envelope.error.code, "unauthorized");
  assert.equal(envelope.error.status, 401);
  assert.equal(transport.calls.length, 1);
  assert.ok(!stdout.includes("secretsecret"));
  assert.ok(!stderr.includes("secretsecret"));
  await rm(configDir, { recursive: true, force: true });
});

test("events follow --timeout exits during backoff without hanging", async () => {
  const transport = memoryBackend();
  transport.streamHandler = async () => {
    throw networkError("ECONNRESET");
  };
  const configDir = await testTemp("ev-reconnect-timeout-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const started = Date.now();
  const { code, stdout } = await withRuntime(
    ["--json", "events", "follow", "--timeout", "40"],
    transport,
    {
      fs: fsLike,
      sleep: () => new Promise(() => {
        /* Never resolves; abort ends the wait. */
      }),
    },
  );
  const elapsed = Date.now() - started;
  assert.equal(code, 0, stdout);
  assert.ok(elapsed < 2000, `timed out in backoff too slowly: ${elapsed}ms`);
  const envelope = JSON.parse(stdout) as { ok: true; data: { items: unknown[] } };
  assert.deepEqual(envelope.data.items, []);

  const sequenced: number[] = [];
  transport.calls.length = 0;
  const sequencedRun = await withRuntime(
    ["--json", "events", "follow", "--timeout", "40"],
    transport,
    {
      fs: fsLike,
      sleep: async (ms) => {
        sequenced.push(ms);
        if (sequenced.length >= 4) {
          await new Promise<void>(() => {
            /* Stop spinning; abort ends the wait. */
          });
        }
      },
    },
  );
  assert.equal(sequencedRun.code, 0, sequencedRun.stdout);
  assert.ok(sequenced.length >= 3, `backoff samples=${JSON.stringify(sequenced)}`);
  assert.equal(sequenced[0], EVENT_STREAM_BACKOFF_MS);
  assert.equal(sequenced[1], EVENT_STREAM_BACKOFF_MS * 2);
  assert.equal(sequenced[2], EVENT_STREAM_BACKOFF_MS * 4);
  assert.ok(sequenced.every((ms) => ms <= EVENT_STREAM_BACKOFF_CAP_MS));
  await rm(configDir, { recursive: true, force: true });
});

test("doctor reports checks over the published foundation routes", async () => {
  const transport = memoryBackend();
  const { code, stdout, configDir } = await withRuntime(["--json", "doctor"], transport);
  assert.equal(code, ExitCode.Unexpected);
  const envelope = JSON.parse(stdout) as { ok: true; data: { checks: Array<{ name: string; status: string }> } };
  const names = envelope.data.checks.map((check) => check.name);
  assert.ok(names.includes("node"));
  assert.ok(names.includes("health"));
  assert.ok(names.includes("ready"));
  assert.ok(names.includes("version"));
  assert.ok(names.includes("capabilities"));
  await rm(configDir, { recursive: true, force: true });
});

test("control-plane payloads and mutation idempotency match the v0.2 architecture", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("contract-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const appDir = path.join(configDir, "app");
  await mkdir(appDir, { recursive: true });
  await writeFile(path.join(appDir, "index.html"), "<!doctype html><html><head></head><body>ok</body></html>");

  let result = await withRuntime(["--json", "app", "upload", appDir, "--no-wait"], transport, { fs: fsLike });
  assert.equal(result.code, 0, result.stdout);
  const capIdx = transport.calls.findIndex((call) => call.method === "GET" && call.path === "/api/v1/capabilities");
  const packPostIdx = transport.calls.findIndex((call) => call.method === "POST" && call.path === "/api/v1/applications");
  assert.ok(capIdx >= 0, "app upload must GET /api/v1/capabilities before packing");
  assert.ok(packPostIdx > capIdx, "capabilities preflight must precede application POST");
  assert.ok(transport.calls[packPostIdx]?.headers?.["idempotency-key"]);
  const uploadCall = transport.calls[packPostIdx];
  assert.ok(uploadCall?.body instanceof Uint8Array, "application upload must send raw tar.gz bytes");
  assert.equal(uploadCall.headers?.["content-type"], "application/gzip");
  assert.match(uploadCall.headers?.["screenrig-archive-sha256"] ?? "", /^[0-9a-f]{64}$/);
  assert.equal(uploadCall.headers?.["screenrig-sdk-version"], SDK_PROTOCOL_VERSION);
  assert.ok(Number(uploadCall.headers?.["screenrig-expanded-bytes"]) > 0);
  assert.ok(Number(uploadCall.headers?.["screenrig-file-count"]) > 0);
  const uploadEnvelope = JSON.parse(result.stdout) as { ok: true; data: { id: string; operation_id: string } };
  assert.equal(uploadEnvelope.data.id, "app_AAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(uploadEnvelope.data.operation_id, "op_AAAAAAAAAAAAAAAAAAAAAAAA");

  result = await withRuntime(["--json", "screen", "pair", "ABC234", "--label", "Lobby"], transport, { fs: fsLike });
  assert.equal(result.code, 0, result.stdout);
  const pairingCall = transport.calls.at(-1);
  assert.equal(pairingCall?.path, "/api/v1/screens/pair");
  assert.deepEqual(pairingCall?.body, { code: "ABC234", label: "Lobby" });
  assert.ok(pairingCall?.headers?.["idempotency-key"]);
  const pairingEnvelope = JSON.parse(result.stdout) as {
    ok: true;
    data: { public_url: string; screen: { id: string; label: string } };
  };
  assert.equal(pairingEnvelope.data.public_url, "https://play.screenrig.ai/s/scr_public_pairing");
  assert.equal(pairingEnvelope.data.screen.id, "scr_PAIRINGAAAAAAAAAAAAAAAA");
  assert.equal(pairingEnvelope.data.screen.label, "Lobby");
  await rm(configDir, { recursive: true, force: true });
});

test("media upload returns usage error and makes no /media/uploads call", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("media-upload-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const result = await withRuntime(["--json", "media", "upload", "hello.txt"], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Usage);
  const envelope = JSON.parse(result.stdout) as { ok: false; error: { code: string } };
  assert.equal(envelope.error.code, "usage_error");
  assert.equal(transport.calls.filter((call) => call.path === "/api/v1/media/uploads").length, 0);
  await rm(configDir, { recursive: true, force: true });
});

test("media upload transcodes before declaring, and uploads only the transcoded bytes", async () => {
  resetFfmpegToolchainCache();
  const transport = memoryBackend();
  const configDir = await testTemp("media-transcode-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const source = path.join(configDir, "poster.png");
  const sourceBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
  await writeFile(source, sourceBytes);

  const encoded = Buffer.from("RIFF----WEBPtranscoded", "utf8");
  let encodeArgs: string[] = [];
  let temporaryOutput = "";
  const runProcess = async (request: { command: string; args: string[]; onStdoutLine?: (line: string) => void }) => {
    if (request.args.includes("-version")) {
      return { code: 0, signal: null, stdout: `${path.basename(request.command)} version n8.1.2\n`, stderrTail: "" };
    }
    if (request.args.includes("-encoders")) {
      return { code: 0, signal: null, stdout: " V....D libwebp              libwebp WebP image\n", stderrTail: "" };
    }
    if (request.args.includes("-filters")) {
      return { code: 0, signal: null, stdout: " .S scale            V->V       Scale.\n", stderrTail: "" };
    }
    if (request.command.endsWith("ffprobe")) {
      // The CLI measures the produced file after the encode, so the probe of the
      // temporary output must report what ffmpeg actually wrote.
      const measuring = temporaryOutput !== "" && request.args.at(-1) === temporaryOutput;
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify(
          measuring
            ? {
                streams: [{ codec_type: "video", codec_name: "webp", width: 3840, height: 1920, pix_fmt: "yuv420p", nb_frames: "1", avg_frame_rate: "0/0" }],
                format: { duration: "0", format_name: "webp_pipe" },
              }
            : {
                streams: [{ codec_type: "video", codec_name: "png", width: 8000, height: 4000, pix_fmt: "rgb24", nb_frames: "1", avg_frame_rate: "0/0" }],
                format: { duration: "0", format_name: "png_pipe" },
              },
        ),
        stderrTail: "",
      };
    }
    encodeArgs = request.args;
    temporaryOutput = request.args[request.args.length - 1] as string;
    request.onStdoutLine?.("progress=end");
    await writeFile(temporaryOutput, encoded);
    return { code: 0, signal: null, stdout: "", stderrTail: "" };
  };

  let signedRequest: Record<string, unknown> | undefined;
  const result = await withRuntime(["--json", "media", "upload", source], transport, {
    fs: fsLike,
    runProcess: runProcess as unknown as NonNullable<CliRuntime["runProcess"]>,
    signedRawPut: async (request) => {
      signedRequest = request as unknown as Record<string, unknown>;
      return { status: 200 };
    },
  });

  try {
    assert.equal(result.code, 0, result.stdout);
    assert.match(String(encodeArgs[encodeArgs.indexOf("-vf") + 1]), /min\(3840,iw\)/);
    assert.equal(encodeArgs[encodeArgs.indexOf("-c:v") + 1], "libwebp");

    const declare = transport.calls.find((call) => call.path === "/api/v1/media/uploads");
    assert.deepEqual((declare?.body as { filename: string; content_type: string; bytes: number }).content_type, "image/webp");
    assert.equal((declare?.body as { filename: string }).filename, "poster.webp");
    assert.equal((declare?.body as { bytes: number }).bytes, encoded.length);
    assert.deepEqual(signedRequest?.body, encoded, "the source bytes must never reach the signed PUT");

    const envelope = JSON.parse(result.stdout) as {
      data: {
        upload: { content_type: string };
        transcode: { applied: boolean; width: number; height: number; dimensions_measured: boolean };
      };
    };
    assert.equal(envelope.data.upload.content_type, "image/webp");
    assert.equal(envelope.data.transcode.applied, true);
    assert.equal(envelope.data.transcode.width, 3840);
    assert.equal(envelope.data.transcode.height, 1920);
    assert.equal(
      envelope.data.transcode.dimensions_measured,
      true,
      "reported dimensions must be read back from the produced file",
    );

    await assert.rejects(() => stat(temporaryOutput), "the temporary transcode directory must be removed");
    assert.deepEqual(await readFile(source), sourceBytes, "the source file must be left untouched");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("feedback takes its kind from the route, carries no argv, and stays idempotent", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("feedback-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );

  try {
    const bug = await withRuntime(
      ["--json", "feedback", "bug", "Playlist stalls after pairing", "--body", "The screen shows the first page then freezes.", "--command", "screen pair"],
      transport,
      { fs: fsLike },
    );
    assert.equal(bug.code, 0, bug.stdout);

    const post = transport.calls.find((call) => call.path === "/api/v1/feedback/bugs" && call.method === "POST");
    assert.ok(post, "the bug route must be selected by the command action");
    const body = post.body as { title: string; body: string; kind?: string; context?: Record<string, string> };
    assert.equal(body.kind, undefined, "the kind comes from the route, never the body");
    assert.equal(body.title, "Playlist stalls after pairing");
    assert.equal(body.context?.command, "screen pair");
    assert.equal(body.context?.cli_version, "0.1.0");
    assert.match(String(body.context?.platform), /^[a-z0-9]{1,16}\/[a-z0-9_]{1,16}$/);
    assert.deepEqual(Object.keys(body.context ?? {}).sort(), ["cli_version", "command", "platform"]);
    assert.ok(post.headers?.["idempotency-key"], "a write must carry an idempotency key");

    const envelope = JSON.parse(bug.stdout) as { ok: boolean; data: { id: string; kind: string } };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.kind, "bug");

    // The feature action must select the other route with the same body shape.
    const feature = await withRuntime(
      ["--json", "feedback", "feature", "Add a dry-run flag", "--body", "It would help to preview a playlist change."],
      transport,
      { fs: fsLike },
    );
    assert.equal(feature.code, 0, feature.stdout);
    const featurePost = transport.calls.find((call) => call.path === "/api/v1/feedback/features" && call.method === "POST");
    assert.ok(featurePost);
    assert.equal((featurePost.body as { context?: Record<string, string> }).context?.command, undefined);

    // Listing merges both routes newest-first and keeps each item's kind.
    const list = await withRuntime(["--json", "feedback", "list"], transport, { fs: fsLike });
    assert.equal(list.code, 0, list.stdout);
    const listed = JSON.parse(list.stdout) as { data: { items: Array<{ kind: string; id: string }> } };
    assert.deepEqual(listed.data.items.map((item) => item.kind).sort(), ["bug", "feature"]);

    const narrowed = await withRuntime(["--json", "feedback", "list", "--kind", "bug"], transport, { fs: fsLike });
    const narrowedItems = (JSON.parse(narrowed.stdout) as { data: { items: Array<{ kind: string }> } }).data.items;
    assert.deepEqual(narrowedItems.map((item) => item.kind), ["bug"]);

    // No update or delete surface exists for an immutable submission.
    for (const argv of [["feedback", "update", "fb_x"], ["feedback", "delete", "fb_x"]]) {
      const rejected = await withRuntime(["--json", ...argv], transport, { fs: fsLike });
      assert.equal(rejected.code, 2, rejected.stdout);
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("feedback refuses a --command that could carry an argument value", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("feedback-command-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  try {
    for (const value of [
      "media upload ./poster.png",
      "screen pair ABC234",
      "media show med_AAAAAAAAAAAAAAAAAAAAAAAA",
      "auth revoke --token=sr_live_a_b",
    ]) {
      const result = await withRuntime(
        ["--json", "feedback", "bug", "Title", "--body", "Body", `--command=${value}`],
        transport,
        { fs: fsLike },
      );
      assert.equal(result.code, 2, `${value} must be rejected: ${result.stdout}`);
      assert.equal(transport.calls.filter((call) => call.path.startsWith("/api/v1/feedback")).length, 0);
      const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string } };
      assert.equal(envelope.error.code, "usage_error");
      assert.match(envelope.error.detail, /command path only/);
      assert.ok(!envelope.error.detail.includes("sr_live"), "the rejected value must not be echoed back");
    }

    // A valueless --command must fail rather than quietly dropping the context.
    const valueless = await withRuntime(
      ["--json", "feedback", "bug", "Title", "--body", "Body", "--command", "--json"],
      transport,
      { fs: fsLike },
    );
    assert.equal(valueless.code, 2, valueless.stdout);
    assert.match(JSON.parse(valueless.stdout).error.detail as string, /--command requires a value/);

    // --no-context suppresses the diagnostic envelope entirely.
    const quiet = await withRuntime(
      ["--json", "feedback", "bug", "Title", "--body", "Body", "--no-context"],
      transport,
      { fs: fsLike },
    );
    assert.equal(quiet.code, 0, quiet.stdout);
    const post = transport.calls.find((call) => call.path === "/api/v1/feedback/bugs" && call.method === "POST");
    assert.equal((post?.body as { context?: unknown }).context, undefined);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a rate-limited submission surfaces Retry-After instead of a bare 429", async () => {
  // A bare transport, because the first registered route wins in the fake and
  // memoryBackend() already binds a successful feedback route.
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/feedback/bugs", () => ({
    status: 429,
    headers: { "retry-after": "180", "content-type": "application/problem+json" },
    body: {
      type: "https://screenrig.ai/problems/rate-limited",
      title: "Rate limited",
      status: 429,
      detail: "This account reached the feedback submission limit.",
      code: "rate_limited",
    },
  }));
  const configDir = await testTemp("feedback-429-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  try {
    const result = await withRuntime(
      ["--json", "feedback", "bug", "Title", "--body", "Body"],
      transport,
      { fs: fsLike },
    );
    assert.equal(result.code, 7, `rate limiting must use the RateLimited exit code: ${result.stdout}`);
    const envelope = JSON.parse(result.stdout) as {
      error: { code: string; detail: string; retry_after_seconds: number; next?: { reason: string } };
    };
    assert.equal(envelope.error.code, "rate_limited");
    assert.equal(envelope.error.retry_after_seconds, 180);
    assert.match(envelope.error.detail, /Retry-After is 180 seconds/);
    assert.match(String(envelope.error.next?.reason), /Wait 3 minutes/);

    const human = await withRuntime(["feedback", "bug", "Title", "--body", "Body"], transport, { fs: fsLike });
    assert.match(human.stderr, /retry_after_seconds: 180/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("account show reports remaining prepaid credit in mcr", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("account-show-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  try {
    const json = await withRuntime(["--json", "account", "show"], transport, { fs: fsLike });
    assert.equal(json.code, 0, json.stdout);
    const envelope = JSON.parse(json.stdout) as { ok: boolean; data: { credit_remaining_mcr: number } };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.credit_remaining_mcr, 0);
    assert.doesNotMatch(json.stdout, /kCr|stripe|x402|\$/i);

    const human = await withRuntime(["account", "show"], transport, { fs: fsLike });
    assert.equal(human.code, 0, human.stdout);
    assert.match(human.stdout, /credit_remaining_mcr: 0/);
    assert.doesNotMatch(human.stdout, /kCr|stripe|x402|\$/i);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("an account quota rejection explains itself and points at the remaining allowance", async () => {
  // A custom storage ceiling is checked before the 1 GiB transport bound.
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/media/uploads", () => ({
    status: 413,
    headers: { "content-type": "application/problem+json" },
    body: {
      type: "https://screenrig.ai/problems/quota-exceeded",
      title: "Account content quota is exceeded",
      status: 413,
      detail: "This upload would exceed the account storage quota.",
      code: "quota_exceeded",
    },
  }));
  const configDir = await testTemp("media-quota-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const file = path.join(configDir, "pixel.png");
  await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]));
  try {
    const result = await withRuntime(
      ["--json", "media", "upload", file, "--no-transcode"],
      transport,
      { fs: fsLike },
    );
    assert.equal(result.code, 8, `413 maps to the Client exit code: ${result.stdout}`);
    const envelope = JSON.parse(result.stdout) as {
      error: { code: string; status: number; next?: { command: string; reason: string } };
    };
    assert.equal(envelope.error.code, "quota_exceeded");
    assert.equal(envelope.error.status, 413);
    assert.match(String(envelope.error.next?.command), /account show/);
    assert.match(String(envelope.error.next?.reason), /content_limit_bytes/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a payment_required rejection points at remaining prepaid credit", async () => {
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/media/uploads", () => ({
    status: 402,
    headers: { "content-type": "application/problem+json" },
    body: {
      type: "https://screenrig.ai/problems/payment-required",
      title: "Prepaid credit is required",
      status: 402,
      detail: "Prepaid credit remaining is zero.",
      code: "payment_required",
    },
  }));
  const configDir = await testTemp("media-payment-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const file = path.join(configDir, "pixel.png");
  await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]));
  try {
    const result = await withRuntime(
      ["--json", "media", "upload", file, "--no-transcode"],
      transport,
      { fs: fsLike },
    );
    assert.equal(result.code, 8, `402 maps to the Client exit code: ${result.stdout}`);
    const envelope = JSON.parse(result.stdout) as {
      error: { code: string; status: number; next?: { command: string; reason: string } };
    };
    assert.equal(envelope.error.code, "payment_required");
    assert.equal(envelope.error.status, 402);
    assert.match(String(envelope.error.next?.command), /account show/);
    assert.match(String(envelope.error.next?.reason), /credit_remaining_mcr/);
    assert.doesNotMatch(result.stdout, /stripe|x402|pay |kCr|\$/i);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media upload validates transcode flags even when transcoding is off", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("media-flags-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const file = path.join(configDir, "pixel.png");
  await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]));
  try {
    for (const bad of [["--webp-quality", "500"], ["--codec", "vp9"], ["--max-edge", "99999"], ["--max-fps", "0"]]) {
      const result = await withRuntime(
        ["--json", "media", "upload", file, "--no-transcode", ...bad],
        transport,
        { fs: fsLike },
      );
      assert.equal(result.code, 2, `${bad.join(" ")} must be rejected under --no-transcode: ${result.stdout}`);
      assert.equal(transport.calls.filter((call) => call.path === "/api/v1/media/uploads").length, 0);
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media upload warns on a low-information filename without blocking the upload", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("media-filename-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const file = path.join(configDir, "video.mp4");
  await writeFile(file, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
  try {
    const result = await withRuntime(
      ["--json", "media", "upload", file, "--no-transcode"],
      transport,
      {
        fs: fsLike,
        signedRawPut: async () => ({ status: 200 }),
      },
    );
    assert.equal(result.code, 0, result.stdout);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      warnings: Array<{ code: string; message: string }>;
    };
    assert.equal(envelope.ok, true);
    const warning = envelope.warnings.find((item) => item.code === "generic_filename");
    assert.ok(warning, result.stdout);
    assert.match(warning.message, /video\.mp4/);
    assert.equal(transport.calls.filter((call) => call.path === "/api/v1/media/uploads").length, 1);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("control-plane KV writes use binary-safe OpenAPI payloads and idempotency", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("kv-contract-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const file = path.join(configDir, "kv.bin");
  await writeFile(file, Buffer.from([0, 255, 1]));
  try {
    let result = await withRuntime(
      ["--json", "kv", "set", "settings", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--json-value", '{"z":1,"a":{"z":2,"a":3}}'],
      transport,
      { fs: fsLike },
    );
    assert.equal(result.code, 0, result.stdout);
    let call = transport.calls.at(-1);
    assert.deepEqual(call?.body, {
      value_base64: Buffer.from('{"a":{"a":3,"z":2},"z":1}').toString("base64"),
      content_type: "application/json",
    });
    assert.ok(call?.headers?.["idempotency-key"]);
    let envelope = JSON.parse(result.stdout) as { ok: true; data: { content_type: string; bytes: number; sha256: string; revision: number } };
    assert.equal(envelope.data.content_type, "application/json");
    assert.equal(envelope.data.revision, 1);
    assert.match(envelope.data.sha256, /^[a-f0-9]{64}$/);

    result = await withRuntime(
      ["--json", "kv", "set", "binary", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--file", file, "--content-type", "application/x.custom; Version=1"],
      transport,
      { fs: fsLike },
    );
    assert.equal(result.code, 0, result.stdout);
    call = transport.calls.at(-1);
    assert.deepEqual(call?.body, { value_base64: "AP8B", content_type: "application/x.custom; Version=1" });

    result = await withRuntime(
      ["--json", "kv", "set", "encoded", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--value-base64", "AP8B", "--content-type", "application/octet-stream"],
      transport,
      { fs: fsLike },
    );
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { value_base64: "AP8B", content_type: "application/octet-stream" });

    result = await withRuntime(["--json", "kv", "list", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA"], transport, { fs: fsLike });
    envelope = JSON.parse(result.stdout) as typeof envelope;
    const listData = (envelope as unknown as { data: { items: Array<Record<string, unknown>> } }).data.items;
    assert.equal(Object.hasOwn(listData[0] ?? {}, "value_base64"), false);

    result = await withRuntime(
      ["--json", "kv", "set", "bad", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--value", "stale"],
      transport,
      { fs: fsLike },
    );
    assert.equal(result.code, ExitCode.Usage);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "usage_error");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen toast posts the closed write body and does not echo the text", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("toast-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  try {
    const result = await withRuntime(
      ["--json", "screen", "toast", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--level", "info", "--text", "Lobby closed"],
      transport,
      { fs: fsLike },
    );
    assert.equal(result.code, 0, result.stdout);
    const post = transport.calls.find((call) => call.path === "/api/v1/screens/scr_PAIRINGAAAAAAAAAAAAAAAA/toast");
    assert.ok(post, "must bind POST /api/v1/screens/{id}/toast");
    assert.equal(post.method, "POST");
    assert.ok(post.headers?.["idempotency-key"], "a toast write must carry an idempotency key");
    assert.deepEqual(post.body, { level: "info", text: "Lobby closed" });
    const envelope = JSON.parse(result.stdout) as { ok: boolean; data: { expires_at?: string; text?: string; level?: string } };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.expires_at, "2026-08-14T17:00:10.000Z");
    assert.equal(envelope.data.text, undefined, "the accepted body is expiry only");
    assert.equal(envelope.data.level, undefined);

    const withDuration = await withRuntime(
      [
        "--json",
        "screen",
        "toast",
        "scr_PAIRINGAAAAAAAAAAAAAAAA",
        "--level",
        "alert",
        "--text",
        "Doors locked",
        "--duration-ms",
        "5000",
      ],
      transport,
      { fs: fsLike },
    );
    assert.equal(withDuration.code, 0, withDuration.stdout);
    const durationPost = transport.calls.at(-1);
    assert.deepEqual(durationPost?.body, { level: "alert", text: "Doors locked", duration_ms: 5000 });
    assert.equal(
      (JSON.parse(withDuration.stdout) as { data: { expires_at: string } }).data.expires_at,
      "2026-08-14T17:00:05.000Z",
    );

    const human = await withRuntime(
      ["screen", "toast", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--level", "error", "--text", "Offline"],
      transport,
      { fs: fsLike },
    );
    assert.equal(human.code, 0, human.stdout);
    assert.match(human.stdout, /Toast accepted/);
    assert.match(human.stdout, /expires_at:/);
    assert.doesNotMatch(human.stdout, /Offline/);

    // The CLI does not scrub toast text. Credential-shaped content is sent
    // verbatim so the server can reject it; the accepted envelope still
    // returns only expires_at.
    const credentialText = "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
    const forwarded = await withRuntime(
      ["--json", "screen", "toast", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--level", "info", "--text", credentialText],
      transport,
      { fs: fsLike },
    );
    assert.equal(forwarded.code, 0, forwarded.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { level: "info", text: credentialText });
    assert.ok(!forwarded.stdout.includes(credentialText));
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen toast rejects invalid level, text, and duration before calling the server", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("toast-usage-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const toastCalls = () => transport.calls.filter((call) => String(call.path).endsWith("/toast"));
  try {
    for (const [argv, detail] of [
      [["screen", "toast"], /requires <id>/],
      [["screen", "toast", "scr_1", "--text", "Lobby closed"], /requires <id>/],
      [["screen", "toast", "scr_1", "--level", "info"], /requires <id>/],
      [["screen", "toast", "scr_1", "--level", "INFO", "--text", "Lobby closed"], /error, alert, or info/],
      [["screen", "toast", "scr_1", "--level", "warn", "--text", "Lobby closed"], /error, alert, or info/],
      [["screen", "toast", "scr_1", "--level", "info", "--text", "a\n\n\nb"], /1 to 120 characters/],
      [["screen", "toast", "scr_1", "--level", "info", "--text", "bad\tline"], /1 to 120 characters/],
      [["screen", "toast", "scr_1", "--level", "info", "--text", "x".repeat(121)], /1 to 120 characters/],
      [["screen", "toast", "scr_1", "--level", "info", "--text", "Lobby closed", "--duration-ms", "1999"], /2000 and 60000/],
      [["screen", "toast", "scr_1", "--level", "info", "--text", "Lobby closed", "--duration-ms", "60001"], /2000 and 60000/],
      [["screen", "toast", "scr_1", "--level", "info", "--text", "Lobby closed", "--duration-ms", "2500.5"], /2000 and 60000/],
    ] as Array<[string[], RegExp]>) {
      const result = await withRuntime(["--json", ...argv], transport, { fs: fsLike });
      assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
      const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string } };
      assert.equal(envelope.error.code, "usage_error");
      assert.match(envelope.error.detail, detail);
    }
    assert.equal(toastCalls().length, 0, "invalid toasts must not reach the server");

    const valuelessLevel = await withRuntime(
      ["--json", "screen", "toast", "scr_1", "--level", "--text", "Lobby closed"],
      transport,
      { fs: fsLike },
    );
    assert.equal(valuelessLevel.code, ExitCode.Usage);
    assert.match(JSON.parse(valuelessLevel.stdout).error.detail as string, /--level requires a value/);

    const valuelessText = await withRuntime(
      ["--json", "screen", "toast", "scr_1", "--level", "info", "--text", "--json"],
      transport,
      { fs: fsLike },
    );
    assert.equal(valuelessText.code, ExitCode.Usage);
    assert.match(JSON.parse(valuelessText.stdout).error.detail as string, /--text requires a value/);

    const cancel = await withRuntime(["--json", "screen", "toast-cancel", "scr_1"], transport, { fs: fsLike });
    assert.equal(cancel.code, ExitCode.Usage);
    assert.equal(toastCalls().length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media, operation, screen credential, and K/V revision commands bind the frozen routes", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("parity-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const file = path.join(configDir, "pixel.png");
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
  await writeFile(file, bytes);
  let signedRequest: Record<string, unknown> | undefined;
  const runtimeExtra = {
    fs: fsLike,
    signedRawPut: async (request: Parameters<NonNullable<CliRuntime["signedRawPut"]>>[0]) => {
      signedRequest = request as unknown as Record<string, unknown>;
      return { status: 200 };
    },
  };
  try {
    // --no-transcode keeps this a pure route/idempotency/signed-PUT assertion.
    let result = await withRuntime(["--json", "media", "upload", file, "--no-transcode"], transport, runtimeExtra);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(signedRequest?.method, "PUT");
    assert.equal(signedRequest?.credentials, "omit");
    assert.deepEqual(signedRequest?.body, bytes);
    assert.doesNotMatch(JSON.stringify(signedRequest?.headers), /authorization|cookie|idempotency|request-id/i);
    const declare = transport.calls.find((call) => call.path === "/api/v1/media/uploads");
    const commit = transport.calls.find((call) => call.path.endsWith("/commit"));
    assert.ok(declare?.headers?.["idempotency-key"]);
    assert.ok(commit?.headers?.["idempotency-key"]);
    assert.notEqual(declare?.headers?.["idempotency-key"], commit?.headers?.["idempotency-key"]);
    assert.deepEqual(commit?.body, {
      content_type: "image/png",
      bytes: bytes.length,
      sha256: (declare?.body as { sha256: string }).sha256,
    });
    assert.ok(!result.stdout.includes("storage.example.invalid"));

    result = await withRuntime(["--json", "media", "show", "med_AAAAAAAAAAAAAAAAAAAAAAAA"], transport, runtimeExtra);
    assert.equal(result.code, 0, result.stdout);
    result = await withRuntime(["--json", "media", "delete", "med_AAAAAAAAAAAAAAAAAAAAAAAA", "--if-match", "1"], transport, runtimeExtra);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(transport.calls.at(-1)?.headers?.["if-match"], '"1"');

    result = await withRuntime(["--json", "operations", "cancel", "op_MEDIAAAAAAAAAAAAAAAAAAAAA"], transport, runtimeExtra);
    assert.equal(result.code, 0, result.stdout);
    assert.equal((JSON.parse(result.stdout) as { data: { state: string } }).data.state, "cancelled");

    result = await withRuntime(["--json", "screen", "pair", "ABC234"], transport, runtimeExtra);
    const paired = (JSON.parse(result.stdout) as { data: { screen: { id: string; revision: number } } }).data.screen;
    result = await withRuntime(["--json", "screen", "rotate-public-id", paired.id, "--if-match", String(paired.revision)], transport, runtimeExtra);
    assert.equal(result.code, 0, result.stdout);
    const rotated = (JSON.parse(result.stdout) as { data: { revision: number } }).data;
    result = await withRuntime(["--json", "screen", "revoke-credential", paired.id, "--if-match", String(rotated.revision)], transport, runtimeExtra);
    assert.equal(result.code, 0, result.stdout);

    result = await withRuntime(
      ["--json", "screen", "toast", paired.id, "--level", "info", "--text", "Lobby closed"],
      transport,
      runtimeExtra,
    );
    assert.equal(result.code, 0, result.stdout);
    assert.equal(transport.calls.at(-1)?.path, `/api/v1/screens/${paired.id}/toast`);
    assert.ok(transport.calls.at(-1)?.headers?.["idempotency-key"]);

    result = await withRuntime(["--json", "kv", "set", "settings", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--json-value", '{"v":1}'], transport, runtimeExtra);
    assert.equal(result.code, 0, result.stdout);
    result = await withRuntime(["--json", "kv", "set", "settings", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--json-value", '{"v":2}', "--if-match", "1"], transport, runtimeExtra);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(transport.calls.at(-1)?.headers?.["if-match"], '"1"');
    result = await withRuntime(["--json", "kv", "set", "settings", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--json-value", '{"v":3}', "--if-match", "1"], transport, runtimeExtra);
    assert.equal(result.code, ExitCode.Precondition);
    assert.equal((JSON.parse(result.stdout) as { error: { current_revision: number } }).error.current_revision, 2);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("usage errors use exit code 2", async () => {
  const { code, stdout, configDir } = await withRuntime(["--json", "nope"], memoryBackend());
  assert.equal(code, ExitCode.Usage);
  const envelope = JSON.parse(stdout) as { ok: false; error: { code: string } };
  assert.equal(envelope.error.code, "usage_error");
  await rm(configDir, { recursive: true, force: true });
});

test("config helpers detect insecure modes", () => {
  assert.equal(isWorldOrGroupReadable(0o600), false);
  assert.equal(isWorldOrGroupReadable(0o644), true);
  assert.equal(isWorldOrGroupReadable(0o640), true);
});

test("readConfigFile can repair permissions", async () => {
  const configDir = await testTemp("repair-");
  const cfgPath = path.join(configDir, "config.json");
  await writeFile(cfgPath, JSON.stringify({ api_url: "https://api.screenrig.ai" }), { mode: 0o644 });
  await chmod(cfgPath, 0o644);
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: {} };
  const cfg = await readConfigFile(cfgPath, fsLike, { repair: true });
  assert.equal(cfg?.api_url, "https://api.screenrig.ai");
  const st = await stat(cfgPath);
  assert.equal(st.mode & 0o777, 0o600);
  await rm(configDir, { recursive: true, force: true });
});

/**
 * Page visibility is a civil rule, so it is meaningless without a zone. The
 * server refuses assignment, playlist update, and manifest resolution while a
 * scheduled playlist points at a screen with no timezone. These tests cover the
 * local refusal that turns that rejection into an actionable message.
 */
async function scheduledPlaylistFixture(scheduled: boolean, dir: string) {
  const configDir = await testTemp(dir);
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );
  const page = (id: string, visibility?: unknown) => ({
    id,
    canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
    transition: { type: "crossfade", duration_ms: 200 },
    advance: { mode: "duration", duration_ms: 8000 },
    ...(visibility ? { visibility } : {}),
    placements: [
      {
        id: "poster",
        content: { type: "image", selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" } },
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "contain",
      },
    ],
  });
  // Every playlist keeps one page with no visibility field at all, so eligible
  // content always exists. The scheduled variant adds a second, bounded page.
  const pages = scheduled
    ? [page("always"), page("evenings", { enabled: true, windows: [{ days: ["fri", "sat"], start: "18:00", end: "02:00" }] })]
    : [page("always")];
  const file = path.join(configDir, "playlist.json");
  await writeFile(file, JSON.stringify({ name: "Lobby", pages }));
  return { configDir, fsLike, file };
}

test("screen set-timezone patches only the timezone and carries the revision", async () => {
  const transport = memoryBackend();
  const { configDir, fsLike } = await scheduledPlaylistFixture(false, "tz-set-");
  const result = await withRuntime(
    ["--json", "screen", "set-timezone", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--timezone", "America/Los_Angeles", "--if-match", "1"],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const patch = transport.calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch?.body, { timezone: "America/Los_Angeles" });
  assert.equal(patch?.headers?.["if-match"], '"1"');
  const envelope = JSON.parse(result.stdout) as { ok: true; data: { timezone?: string } };
  assert.equal(envelope.data.timezone, "America/Los_Angeles");
  await rm(configDir, { recursive: true, force: true });
});

test("screen set-timezone forwards the identifier unchanged and never carries a zone list", async () => {
  const transport = memoryBackend();
  const { configDir, fsLike } = await scheduledPlaylistFixture(false, "tz-opaque-");
  // The embedded zone database belongs to the server. A CLI-side allowlist
  // would go stale, so an unknown name must still reach the server to be
  // rejected there.
  await withRuntime(
    ["--json", "screen", "set-timezone", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--timezone", "Mars/Olympus_Mons", "--if-match", "1"],
    transport,
    { fs: fsLike },
  );
  const patch = transport.calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch?.body, { timezone: "Mars/Olympus_Mons" });
  await rm(configDir, { recursive: true, force: true });
});

test("screen set-timezone rejects a missing id, zone, or revision", async () => {
  const transport = memoryBackend();
  const { configDir, fsLike } = await scheduledPlaylistFixture(false, "tz-usage-");
  for (const argv of [
    ["screen", "set-timezone", "--timezone", "America/Los_Angeles", "--if-match", "1"],
    ["screen", "set-timezone", "scr_1", "--if-match", "1"],
    ["screen", "set-timezone", "scr_1", "--timezone", "America/Los_Angeles"],
  ]) {
    const result = await withRuntime(["--json", ...argv], transport, { fs: fsLike });
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string } };
    assert.equal(envelope.error.code, "usage_error");
    assert.match(envelope.error.detail, /requires <id> --timezone --if-match/);
  }
  // A rejected invocation never reaches the server.
  assert.equal(transport.calls.some((call) => call.method === "PATCH"), false);
  await rm(configDir, { recursive: true, force: true });
});

test("assigning a scheduled playlist to a screen with no timezone is refused before the patch", async () => {
  const transport = memoryBackend();
  const { configDir, fsLike, file } = await scheduledPlaylistFixture(true, "tz-assign-refuse-");
  await withRuntime(["--json", "screen", "pair", "ABC234"], transport, { fs: fsLike });
  await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });
  transport.calls.length = 0;

  const result = await withRuntime(
    ["--json", "screen", "assign", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--if-match", "1"],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Usage, result.stdout);
  const envelope = JSON.parse(result.stdout) as {
    ok: false;
    error: { code: string; detail: string; next?: { command: string } };
  };
  assert.equal(envelope.error.code, "usage_error");
  assert.match(envelope.error.detail, /scr_PAIRINGAAAAAAAAAAAAAAAA has no timezone/);
  assert.match(envelope.error.next?.command ?? "", /screen set-timezone scr_PAIRINGAAAAAAAAAAAAAAAA --timezone/);
  // The refusal happens locally, so no write reaches the server.
  assert.equal(transport.calls.some((call) => call.method === "PATCH"), false);
  await rm(configDir, { recursive: true, force: true });
});

test("a page disabled outright still counts as scheduled", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("tz-disabled-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );
  const basePage = {
    id: "always",
    canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
    transition: { type: "crossfade", duration_ms: 200 },
    advance: { mode: "duration", duration_ms: 8000 },
    placements: [
      {
        id: "poster",
        content: { type: "image", selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" } },
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "contain",
      },
    ],
  };
  const file = path.join(configDir, "playlist.json");
  await writeFile(
    file,
    JSON.stringify({ name: "Lobby", pages: [basePage, { ...basePage, id: "off", visibility: { enabled: false } }] }),
  );
  await withRuntime(["--json", "screen", "pair", "ABC234"], transport, { fs: fsLike });
  await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });

  const result = await withRuntime(
    ["--json", "screen", "assign", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--if-match", "1"],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Usage, result.stdout);
  await rm(configDir, { recursive: true, force: true });
});

test("an unscheduled playlist assigns to a screen with no timezone", async () => {
  const transport = memoryBackend();
  const { configDir, fsLike, file } = await scheduledPlaylistFixture(false, "tz-assign-plain-");
  await withRuntime(["--json", "screen", "pair", "ABC234"], transport, { fs: fsLike });
  await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });

  const result = await withRuntime(
    ["--json", "screen", "assign", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--if-match", "1"],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Success, result.stdout);
  await rm(configDir, { recursive: true, force: true });
});

test("a scheduled playlist assigns once the screen carries a timezone", async () => {
  const transport = memoryBackend();
  const { configDir, fsLike, file } = await scheduledPlaylistFixture(true, "tz-assign-ok-");
  await withRuntime(["--json", "screen", "pair", "ABC234"], transport, { fs: fsLike });
  await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });
  await withRuntime(
    ["--json", "screen", "set-timezone", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--timezone", "America/Los_Angeles", "--if-match", "1"],
    transport,
    { fs: fsLike },
  );

  const result = await withRuntime(
    ["--json", "screen", "assign", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--if-match", "2"],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Success, result.stdout);
  await rm(configDir, { recursive: true, force: true });
});

test("one screen update that sets both a playlist and a timezone needs no preflight", async () => {
  const transport = memoryBackend();
  const { configDir, fsLike, file } = await scheduledPlaylistFixture(true, "tz-update-both-");
  await withRuntime(["--json", "screen", "pair", "ABC234"], transport, { fs: fsLike });
  await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });
  transport.calls.length = 0;

  const result = await withRuntime(
    [
      "--json", "screen", "update", "scr_PAIRINGAAAAAAAAAAAAAAAA",
      "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA",
      "--timezone", "America/Los_Angeles",
      "--if-match", "1",
    ],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const patch = transport.calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch?.body, { playlist_id: "pl_AAAAAAAAAAAAAAAAAAAAAAAA", timezone: "America/Los_Angeles" });
  // The patch supplies the zone itself, so the playlist is never fetched.
  assert.equal(transport.calls.some((call) => call.path.startsWith("/api/v1/playlists/")), false);
  await rm(configDir, { recursive: true, force: true });
});

test("adding a schedule to a playlist an unzoned screen already runs is refused", async () => {
  const transport = memoryBackend();
  const { configDir, fsLike, file } = await scheduledPlaylistFixture(false, "tz-playlist-update-");
  await withRuntime(["--json", "screen", "pair", "ABC234"], transport, { fs: fsLike });
  await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });
  await withRuntime(
    ["--json", "screen", "assign", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--if-match", "1"],
    transport,
    { fs: fsLike },
  );

  const scheduled = await scheduledPlaylistFixture(true, "tz-playlist-update-src-");
  transport.calls.length = 0;
  const result = await withRuntime(
    ["--json", "playlist", "update", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", scheduled.file, "--if-match", "1"],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Usage, result.stdout);
  assert.match(result.stdout, /has no timezone/);
  assert.equal(transport.calls.some((call) => call.method === "PUT"), false);
  await rm(configDir, { recursive: true, force: true });
  await rm(scheduled.configDir, { recursive: true, force: true });
});

test("app upload reports the release id a playlist placement needs", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("release-id-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );
  const appDir = path.join(configDir, "app");
  await mkdir(appDir, { recursive: true });
  await writeFile(path.join(appDir, "index.html"), "<!doctype html><html><head></head><body>ok</body></html>");

  const result = await withRuntime(["--json", "app", "upload", appDir, "--poll-ms", "1"], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const envelope = JSON.parse(result.stdout) as {
    data: { application: { id: string; release_id: string }; operation: { state: string } };
  };
  // release_id is required on the accepted response, so it is available without
  // reading the operation result.
  assert.equal(envelope.data.application.release_id, "rel_AAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(envelope.data.operation.state, "succeeded");
  await rm(configDir, { recursive: true, force: true });
});

test("playlist templates --json lists the fifteen closed ids without enrolling", async () => {
  const transport = memoryBackend();
  const { code, stdout, configDir } = await withRuntime(["--json", "playlist", "templates"], transport);
  assert.equal(code, ExitCode.Success, stdout);
  const envelope = JSON.parse(stdout) as { ok: true; data: { templates: Array<{ id: string }> } };
  assert.deepEqual(envelope.data.templates.map((template) => template.id), [
    "slide-intro",
    "slide-text-only-1",
    "slide-text-only-2",
    "slide-text-photo-1",
    "slide-text-photo-2",
    "slide-text-photo-3",
    "slide-half-bleed-1",
    "slide-half-bleed-2",
    "slide-quote",
    "slide-callout",
    "slide-bullets",
    "slide-stat-grid",
    "slide-three-up",
    "slide-photo",
    "slide-full-bleed",
  ]);
  assert.equal(transport.calls.length, 0);
  await rm(configDir, { recursive: true, force: true });
});

test("playlist create expands a templated page and forwards a full page unchanged", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("playlist-templates-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );
  const fullPage = {
    id: "poster",
    canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
    transition: { type: "crossfade", duration_ms: 200 },
    advance: { mode: "duration", after_ms: 8000 },
    placements: [
      {
        id: "hero",
        content: { type: "image", selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" } },
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "contain",
      },
    ],
  };
  const file = path.join(configDir, "playlist.json");
  await writeFile(
    file,
    JSON.stringify({
      name: "Lobby",
      pages: [
        { id: "intro", template: "slide-intro", slots: { title: { text: "Welcome" } } },
        fullPage,
      ],
    }),
  );
  const result = await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const posted = transport.calls.find((call) => call.method === "POST" && call.path === "/api/v1/playlists");
  const body = posted?.body as { pages: Array<Record<string, unknown>> };
  assert.equal(body.pages.length, 2);
  assert.equal("template" in body.pages[0]!, false);
  assert.equal("slots" in body.pages[0]!, false);
  const introPlacements = body.pages[0]!.placements as Array<{ id: string; content: { type: string; text?: string } }>;
  assert.deepEqual(introPlacements.map((placement) => placement.id), ["bar", "title"]);
  const title = introPlacements.find((placement) => placement.id === "title");
  assert.equal(title?.content.type, "text");
  assert.equal(title?.content.text, "Welcome");
  assert.equal(introPlacements.find((placement) => placement.id === "bar")?.content.type, "line");
  assert.deepEqual(body.pages[1], fullPage);
  await rm(configDir, { recursive: true, force: true });
});

test("playlist create accepts a linear canvas.background on a templated page and a full page", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("playlist-gradient-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );
  const wash = {
    type: "linear",
    stops: [
      { at: 0, color: "#1b2632ff" },
      { at: 1, color: "#eee9dfff" },
    ],
  };
  const fullPage = {
    id: "poster",
    canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: wash },
    transition: { type: "crossfade", duration_ms: 200 },
    advance: { mode: "duration", after_ms: 8000 },
    placements: [
      {
        id: "hero",
        content: { type: "image", selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" } },
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "contain",
      },
    ],
  };
  const file = path.join(configDir, "playlist.json");
  await writeFile(
    file,
    JSON.stringify({
      name: "Lobby",
      pages: [
        {
          id: "intro",
          template: "slide-intro",
          canvas: { background: wash },
          slots: { title: { text: "Welcome" } },
        },
        fullPage,
      ],
    }),
  );
  const result = await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const posted = transport.calls.find((call) => call.method === "POST" && call.path === "/api/v1/playlists");
  const body = posted?.body as { pages: Array<{ canvas: { background: unknown } }> };
  assert.deepEqual(body.pages[0]!.canvas.background, {
    type: "linear",
    stops: [
      { at: 0, color: "#1B2632FF" },
      { at: 1, color: "#EEE9DFFF" },
    ],
  });
  assert.deepEqual(body.pages[1], fullPage);
  await rm(configDir, { recursive: true, force: true });
});

test("playback list, media filters, media update, and app --name bind the consumer routes", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("consumer-surface-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );
  const appDir = path.join(configDir, "app");
  await mkdir(appDir, { recursive: true });
  await writeFile(path.join(appDir, "index.html"), "<!doctype html><html><head></head><body>ok</body></html>");
  const mediaFile = path.join(configDir, "lobby-poster.png");
  await writeFile(mediaFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]));

  try {
    const playback = await withRuntime(
      ["--json", "playback", "list", "--screen-id", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--media-id", "med_AAAAAAAAAAAAAAAAAAAAAAAA", "--day", "2026-08-14"],
      transport,
      { fs: fsLike },
    );
    assert.equal(playback.code, ExitCode.Success, playback.stdout);
    const playbackCall = transport.calls.find((call) => call.path === "/api/v1/playback");
    assert.deepEqual(playbackCall?.query, {
      screen_id: "scr_PAIRINGAAAAAAAAAAAAAAAA",
      media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA",
      day: "2026-08-14",
    });

    const badDay = await withRuntime(["--json", "playback", "list", "--day", "14-08-2026"], transport, { fs: fsLike });
    assert.equal(badDay.code, ExitCode.Usage, badDay.stdout);

    const namedUpload = await withRuntime(
      ["--json", "app", "upload", appDir, "--name", "Lobby board", "--no-wait"],
      transport,
      { fs: fsLike },
    );
    assert.equal(namedUpload.code, ExitCode.Success, namedUpload.stdout);
    const appCall = transport.calls.find((call) => call.method === "POST" && call.path === "/api/v1/applications");
    assert.equal(appCall?.headers?.["screenrig-application-name"], "Lobby board");

    const mediaUpload = await withRuntime(
      ["--json", "media", "upload", mediaFile, "--no-transcode", "--tag", "lobby"],
      transport,
      { fs: fsLike, signedRawPut: async () => ({ status: 200 }) },
    );
    assert.equal(mediaUpload.code, ExitCode.Success, mediaUpload.stdout);
    const declare = transport.calls.find((call) => call.path === "/api/v1/media/uploads");
    assert.equal((declare?.body as { tag?: string }).tag, "lobby");
    const mediaEnvelope = JSON.parse(mediaUpload.stdout) as { data: { upload: { tag?: string } } };
    assert.equal(mediaEnvelope.data.upload.tag, "lobby");

    transport.calls.length = 0;
    const listed = await withRuntime(
      ["--json", "media", "list", "--tag", "lobby", "--kind", "image"],
      transport,
      { fs: fsLike },
    );
    assert.equal(listed.code, ExitCode.Success, listed.stdout);
    const listCall = transport.calls.find((call) => call.method === "GET" && call.path === "/api/v1/media");
    assert.deepEqual(listCall?.query, { tag: "lobby", kind: "image" });
    const listedEnvelope = JSON.parse(listed.stdout) as { data: { items: Array<{ tag?: string }> } };
    assert.equal(listedEnvelope.data.items[0]?.tag, "lobby");

    const updated = await withRuntime(
      ["--json", "media", "update", "med_AAAAAAAAAAAAAAAAAAAAAAAA", "--tag", "lobby2", "--if-match", "1"],
      transport,
      { fs: fsLike },
    );
    assert.equal(updated.code, ExitCode.Success, updated.stdout);
    const patch = transport.calls.find((call) => call.method === "PATCH" && call.path === "/api/v1/media/med_AAAAAAAAAAAAAAAAAAAAAAAA");
    assert.deepEqual(patch?.body, { tag: "lobby2" });
    assert.equal(patch?.headers?.["if-match"], '"1"');

    const cleared = await withRuntime(
      ["--json", "media", "update", "med_AAAAAAAAAAAAAAAAAAAAAAAA", "--clear-tag", "--if-match", "2"],
      transport,
      { fs: fsLike },
    );
    assert.equal(cleared.code, ExitCode.Success, cleared.stdout);
    const clearPatch = transport.calls.find((call) => call.method === "PATCH" && call.path === "/api/v1/media/med_AAAAAAAAAAAAAAAAAAAAAAAA" && (call.body as { tag: unknown }).tag === null);
    assert.deepEqual(clearPatch?.body, { tag: null });

    const both = await withRuntime(
      ["--json", "media", "update", "med_AAAAAAAAAAAAAAAAAAAAAAAA", "--tag", "lobby", "--clear-tag", "--if-match", "3"],
      transport,
      { fs: fsLike },
    );
    assert.equal(both.code, ExitCode.Usage, both.stdout);

    const badTag = await withRuntime(
      ["--json", "media", "list", "--tag", "not_a_tag"],
      transport,
      { fs: fsLike },
    );
    assert.equal(badTag.code, ExitCode.Usage, badTag.stdout);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("playlist create refuses a mixed template-and-placements page before the write", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("playlist-mixed-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );
  const file = path.join(configDir, "playlist.json");
  await writeFile(
    file,
    JSON.stringify({
      name: "Lobby",
      pages: [{ id: "intro", template: "slide-intro", slots: { title: { text: "Welcome" } }, placements: [] }],
    }),
  );
  const result = await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Usage, result.stdout);
  const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string } };
  assert.equal(envelope.error.code, "usage_error");
  assert.match(envelope.error.detail, /mixes template and placements/);
  assert.equal(transport.calls.some((call) => call.method === "POST" && call.path === "/api/v1/playlists"), false);
  await rm(configDir, { recursive: true, force: true });
});
