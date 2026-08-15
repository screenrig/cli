import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdir, open, rename, chmod, stat, writeFile, rm } from "node:fs/promises";
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
    let result = await withRuntime(["--json", "media", "upload", file], transport, runtimeExtra);
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
