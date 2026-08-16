import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdir, open, readFile, rename, chmod, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { run, type CliRuntime } from "./main.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import { ExitCode } from "./exit-codes.js";
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
  assert.match((transport.calls[0]?.body as { client_id: string }).client_id, /^cli_[A-Za-z0-9_-]{43}$/);
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

test("events follow parses SSE frames from the transport stream", async () => {
  const transport = memoryBackend();
  transport.pushStream(
    "id: ev1_1\nevent: message\ndata: {\"cursor\":\"ev1_1\",\"type\":\"account.created\",\"severity\":\"info\",\"message\":\"created\",\"at\":\"2026-08-14T17:00:00.000Z\"}\n\n",
  );
  const configDir = await testTemp("ev-");
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } },
  );
  const { code, stdout } = await withRuntime(["--json", "events", "follow", "--cursor", "ev1_0"], transport, {
    fs: { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } },
  });
  assert.equal(code, 0);
  const envelope = JSON.parse(stdout) as { ok: true; data: { items: Array<{ type: string }> } };
  assert.equal(envelope.data.items[0]?.type, "account.created");
  assert.equal(transport.calls.at(-1)?.query?.after, "ev1_0");
  assert.equal(transport.calls.at(-1)?.query?.cursor, undefined);
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

test("an account quota rejection explains itself and points at the remaining allowance", async () => {
  // The plan quota is smaller than the 1 GiB transport ceiling and is checked
  // first, so this is the limit a user actually meets.
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
