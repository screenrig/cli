import assert from "node:assert/strict";
import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, chmod, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EVENT_STREAM_BACKOFF_CAP_MS, EVENT_STREAM_BACKOFF_MS, USAGE, formatEventLine } from "./commands.js";
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
import { generateAgentConnectionKey } from "./agent-identity.js";

const TEST_AGENT = {
  id: "agt_AAAAAAAAAAAAAAAAAAAAAAAA",
  name: "ScreenRig CLI",
  agent_type: "cli",
  state: "active",
  authenticated_requests: 1,
  metered_credits: 0,
  created_at: "2026-08-14T17:00:00.000Z",
  connected_at: "2026-08-14T17:00:00.000Z",
} as const;

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

async function withAuthenticatedRuntime(
  argv: string[],
  transport: FakeTransport,
  extra?: Partial<CliRuntime>,
): Promise<{ code: number; stdout: string; stderr: string; configDir: string }> {
  const configDir = extra?.fs ? "" : await testTemp("cfg-authenticated-");
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
  const configPath = fsLike.env.SCREENRIG_CONFIG
    ?? path.join(fsLike.env.XDG_CONFIG_HOME ?? fsLike.homedir(), "screenrig", "config.json");
  const existing = await readConfigFile(configPath, fsLike);
  if (!existing?.token) {
    await writeConfigAtomic(configPath, {
      ...(existing ?? {}),
      api_url: existing?.api_url ?? "https://api.screenrig.ai",
      token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      account_id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA",
      agent_id: TEST_AGENT.id,
    }, fsLike);
  }
  const result = await withRuntime(argv, transport, { ...extra, fs: fsLike });
  return { ...result, configDir };
}

test("pairing requires explicit enrollment and then preserves the original pairing behavior", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("explicit-enrollment-pair-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const missing = await withRuntime(["--json", "screen", "pair", "abc234", "--label", "Lobby"], transport, { fs: fsLike });
  assert.equal(missing.code, ExitCode.Auth);
  const blocked = JSON.parse(missing.stdout) as { error: { code: string; next: { command: string } } };
  assert.equal(blocked.error.code, "not_enrolled");
  assert.equal(blocked.error.next.command, "screenrig agent enroll --email ADDRESS");
  assert.equal(transport.calls.length, 0);

  const enrolled = await withRuntime(
    ["--json", "agent", "enroll", "--email", "Owner@example.com"],
    transport,
    { fs: fsLike },
  );
  assert.equal(enrolled.code, 0, enrolled.stdout);
  const paired = await withRuntime(["--json", "screen", "pair", "abc234", "--label", "Lobby"], transport, { fs: fsLike });
  assert.equal(paired.code, 0, paired.stdout);
  const envelope = JSON.parse(paired.stdout) as {
    ok: boolean;
    data: { public_url: string; screen: { id: string; label: string } };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.screen.label, "Lobby");
  assert.equal(envelope.data.public_url, "https://play.screenrig.ai/s/scr_public_pairing");
  assert.ok(!paired.stdout.includes("sr_live_tokidAAAAAAAAAAAAAAAA_AAAA"));
  const methods = transport.calls.map((call) => `${call.method} ${call.path}`);
  assert.deepEqual(methods, [
    "POST /api/v1/enrollments",
    "GET /api/v1/account",
    "GET /api/v1/agents/self",
    "POST /api/v1/screens/pair",
  ]);
  assert.ok(transport.calls[0]?.headers?.["idempotency-key"]);
  assert.ok(transport.calls[0]?.headers?.["x-request-id"]);
  const enrollBody = transport.calls[0]?.body as { client_id?: string; email?: string };
  assert.match(enrollBody.client_id ?? "", /^cli_[A-Za-z0-9_-]{43}$/);
  assert.equal(enrollBody.email, "Owner@example.com");
  assert.deepEqual(Object.keys(enrollBody).sort(), ["agent_type", "client_id", "email", "platform", "version"]);
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

test("explicit enrollment includes beta_key when --beta-key is set", async () => {
  const transport = memoryBackend();
  const { code, stdout, configDir } = await withRuntime(
    ["--json", "--beta-key", "screenrig-beta-program", "agent", "enroll", "--email", "owner@example.com"],
    transport,
  );
  assert.equal(code, 0, stdout);
  const enroll = transport.calls.find((call) => call.path === "/api/v1/enrollments");
  const body = enroll?.body as { client_id?: string; beta_key?: string; email?: string };
  assert.match(body.client_id ?? "", /^cli_[A-Za-z0-9_-]{43}$/);
  assert.equal(body.beta_key, "screenrig-beta-program");
  assert.equal(body.email, "owner@example.com");
  assert.deepEqual(Object.keys(body).sort(), ["agent_type", "beta_key", "client_id", "email", "platform", "version"]);
  await rm(configDir, { recursive: true, force: true });
});

test("explicit enrollment includes beta_key from SCREENRIG_BETA_KEY when the flag is unset", async () => {
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
  const result = await withRuntime(["--json", "agent", "enroll", "--email", "owner@example.com"], transport, { fs: fsLike });
  assert.equal(result.code, 0, result.stdout);
  const enroll = transport.calls.find((call) => call.path === "/api/v1/enrollments");
  assert.deepEqual(enroll?.body, {
    client_id: (enroll?.body as { client_id: string }).client_id,
    email: "owner@example.com",
    beta_key: "screenrig-beta-program",
    agent_type: "cli",
    platform: `${process.platform}/${process.arch}`,
    version: "0.1.0",
  });
  await rm(configDir, { recursive: true, force: true });
});

test("explicit enrollment prefers --beta-key over SCREENRIG_BETA_KEY", async () => {
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
    ["--json", "--beta-key", "from-flag", "agent", "enroll", "--email", "owner@example.com"],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, 0, result.stdout);
  const enroll = transport.calls.find((call) => call.path === "/api/v1/enrollments");
  assert.equal((enroll?.body as { beta_key?: string }).beta_key, "from-flag");
  await rm(configDir, { recursive: true, force: true });
});

test("agent enroll requires contact email, trims it, and creates the first named agent without echoing it", async () => {
  const transport = memoryBackend();
  const result = await withRuntime(["--json", "agent", "enroll", "--email", " Owner@example.com ", "--name", "Office Codex"], transport);
  assert.equal(result.code, 0, result.stdout);
  const envelope = JSON.parse(result.stdout) as { data: { status: string; connection_ready: boolean; agent: { id: string; name: string } } };
  assert.equal(envelope.data.status, "active");
  assert.equal(envelope.data.connection_ready, false);
  assert.equal(envelope.data.agent.id, TEST_AGENT.id);
  const enrollment = transport.calls.find((call) => call.path === "/api/v1/enrollments");
  assert.deepEqual(enrollment?.body, {
    client_id: (enrollment?.body as { client_id: string }).client_id,
    email: "Owner@example.com",
    name: "Office Codex",
    agent_type: "cli",
    platform: `${process.platform}/${process.arch}`,
    version: "0.1.0",
  });
  assert.deepEqual(transport.calls.map((call) => call.path), [
    "/api/v1/enrollments",
    "/api/v1/account",
    "/api/v1/agents/self",
  ]);
  assert.doesNotMatch(result.stdout, /sr_live_|issuance|client_id|Owner@example\.com/);
  await rm(result.configDir, { recursive: true, force: true });
});

test("agent enroll rejects missing or malformed contact email before the network without echoing input", async () => {
  const missingTransport = new FakeTransport();
  const missing = await withRuntime(["--json", "agent", "enroll"], missingTransport);
  assert.equal(missing.code, ExitCode.Usage);
  assert.match(JSON.parse(missing.stdout).error.detail, /requires --email ADDRESS/i);
  assert.equal(missingTransport.calls.length, 0);

  const malformedAddress = "Private Person <private@example.com>";
  const malformedTransport = new FakeTransport();
  const malformed = await withRuntime(
    ["--json", "agent", "enroll", "--email", malformedAddress],
    malformedTransport,
  );
  assert.equal(malformed.code, ExitCode.Usage);
  assert.doesNotMatch(malformed.stdout, /Private Person|private@example\.com/);
  assert.equal(malformedTransport.calls.length, 0);

  await rm(missing.configDir, { recursive: true, force: true });
  await rm(malformed.configDir, { recursive: true, force: true });
});

test("email_conflict is terminal and generic, clears only pending enrollment, and requires a new explicit enrollment", async () => {
  const configDir = await testTemp("email-conflict-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const rejectedAddress = "Victim@example.com";
  const conflict = new FakeTransport().on("POST", "/api/v1/enrollments", () => ({
    status: 409,
    headers: { "content-type": "application/problem+json" },
    body: {
      type: "https://screenrig.ai/problems/email-conflict",
      title: `Conflict for ${rejectedAddress}`,
      status: 409,
      detail: `${rejectedAddress} is already present`,
      code: "email_conflict",
      errors: [{ field: "email", detail: rejectedAddress }],
    },
  }));
  const rejected = await withRuntime(
    ["--json", "agent", "enroll", "--email", rejectedAddress],
    conflict,
    { fs: fsLike },
  );
  assert.equal(rejected.code, ExitCode.Conflict, rejected.stdout);
  assert.doesNotMatch(rejected.stdout, /Victim@example\.com/i);
  assert.doesNotMatch(rejected.stdout, /\[redacted-email\]/i);
  const envelope = JSON.parse(rejected.stdout) as { error: { code: string; errors: unknown[]; next: { command: string } } };
  assert.equal(envelope.error.code, "email_conflict");
  assert.deepEqual(envelope.error.errors, []);
  assert.equal(envelope.error.next.command, "screenrig agent connect");
  const configPath = path.join(configDir, "screenrig", "config.json");
  assert.equal((await readConfigFile(configPath, fsLike))?.enrollment, undefined);

  const retried = await withRuntime(
    ["--json", "agent", "enroll", "--email", "different@example.com"],
    memoryBackend(),
    { fs: fsLike },
  );
  assert.equal(retried.code, 0, retried.stdout);
  await rm(configDir, { recursive: true, force: true });
});

test("every authenticated command reports not_enrolled instead of enrolling", async () => {
  for (const argv of [
    ["--json", "account", "show"],
    ["--json", "dashboard"],
    ["--json", "screen", "list"],
    ["--json", "media", "list"],
    ["--json", "playlist", "list"],
    ["--json", "events", "list"],
    ["--json", "feedback", "list"],
  ]) {
    const transport = memoryBackend();
    const result = await withRuntime(argv, transport);
    assert.equal(result.code, ExitCode.Auth, argv.join(" "));
    const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; next: { command: string } } };
    assert.equal(envelope.ok, false, argv.join(" "));
    assert.equal(envelope.error.code, "not_enrolled", argv.join(" "));
    assert.equal(envelope.error.next.command, "screenrig agent enroll --email ADDRESS", argv.join(" "));
    assert.equal(transport.calls.length, 0, argv.join(" "));
    await rm(result.configDir, { recursive: true, force: true });
  }
});

test("agent status and deprecated auth status never enroll a missing installation", async () => {
  const transport = new FakeTransport();
  const status = await withRuntime(["--json", "agent", "status"], transport);
  assert.equal(status.code, 0, status.stdout);
  assert.equal(JSON.parse(status.stdout).data.status, "not_enrolled");
  assert.equal(transport.calls.length, 0);
  const legacy = await withRuntime(["--json", "auth", "status"], transport);
  assert.equal(legacy.code, 0, legacy.stdout);
  assert.equal(JSON.parse(legacy.stdout).data.status, "not_enrolled");
  assert.deepEqual(JSON.parse(legacy.stdout).warnings.map((item: { code: string }) => item.code), ["deprecated_command"]);
  assert.equal(transport.calls.length, 0);
  await rm(status.configDir, { recursive: true, force: true });
  await rm(legacy.configDir, { recursive: true, force: true });
});

test("agent status reports whether a persisted passkey can authorize another agent", async () => {
  const transport = new FakeTransport();
  const configDir = await testTemp("agent-status-ready-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai",
    token: `sr_live_status_${"S".repeat(43)}`,
    account_id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA",
    agent_id: TEST_AGENT.id,
  }, fsLike);
  transport.on("GET", "/api/v1/agents/self", () => ({
    status: 200,
    headers: { "cache-control": "private, no-store" },
    body: { agent: TEST_AGENT, connection_ready: true },
  }));
  const result = await withRuntime(["--json", "agent", "status"], transport, { fs: fsLike });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).data.connection_ready, true);
  assert.deepEqual(transport.calls.map((call) => call.path), ["/api/v1/agents/self"]);
  await rm(configDir, { recursive: true, force: true });
});

function agentConnectionEnvelope(recipient: { kty: "OKP"; crv: "X25519"; x: string }) {
  const connectionId = "acn_AAAAAAAAAAAAAAAAAAAAAAAA";
  const agentId = "agt_CONNECTEDAAAAAAAAAAAAAAAA";
  const pendingToken = `sr_live_connected_${"P".repeat(43)}`;
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralJwk = ephemeral.publicKey.export({ format: "jwk" });
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({ key: recipient as unknown as import("node:crypto").JsonWebKey, format: "jwk" }),
  });
  const salt = createHash("sha256").update(`screenrig/agent-credential-envelope/salt/v1\0${connectionId}`).digest();
  const key = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from("screenrig/agent-credential-envelope/key/v1"), 32));
  const nonce = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`screenrig/agent-credential-envelope/aad/v1\0${connectionId}\0${agentId}`));
  const plaintext = Buffer.from(JSON.stringify({ token: pendingToken, agent_id: agentId, connection_id: connectionId }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const pendingAgent = {
    id: agentId,
    name: "Office Codex",
    agent_type: "cli",
    platform: `${process.platform}/${process.arch}`,
    version: "0.1.0",
    state: "pending" as const,
    authenticated_requests: 0,
    metered_credits: 0,
    created_at: "2026-08-14T17:00:00.000Z",
  };
  return {
    connectionId,
    agentId,
    pendingToken,
    pendingAgent,
    collection: {
      agent: pendingAgent,
      credential_envelope: {
        algorithm: "X25519-HKDF-SHA256-A256GCM",
        ephemeral_public_key: { kty: "OKP", crv: "X25519", x: ephemeralJwk.x },
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      },
      issuance_expires_at: "2026-08-14T17:10:00.000Z",
    },
  };
}

test("agent connect opens the safe approval URL, consumes status-only SSE, and activates a distinct credential", async () => {
  const transport = new FakeTransport();
  let sealed: ReturnType<typeof agentConnectionEnvelope> | undefined;
  const connectionToken = `sac_${"C".repeat(43)}`;
  transport.on("POST", "/api/v1/agent-connections", (req) => {
    const input = req.body as { recipient_public_key: { kty: "OKP"; crv: "X25519"; x: string } };
    sealed = agentConnectionEnvelope(input.recipient_public_key);
    return {
      status: 201,
      headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
      body: {
        connection_id: sealed.connectionId,
        connection_token: connectionToken,
        approval_url: `https://dashboard.screenrig.ai/agents/connect/${sealed.connectionId}`,
        expires_at: "2026-08-14T17:10:00.000Z",
      },
    };
  });
  transport.pushStream(`event: agent.connection\ndata: ${JSON.stringify({
    connection_id: "acn_AAAAAAAAAAAAAAAAAAAAAAAA",
    name: "Office Codex",
    agent_type: "cli",
    status: "approved",
    expires_at: "2026-08-14T17:10:00.000Z",
    created_at: "2026-08-14T17:00:00.000Z",
  })}\n\n`);
  transport.on("POST", /\/api\/v1\/agent-connections\/acn_.*\/credential/, (req) => {
    assert.equal(req.headers?.authorization, `ScreenRig-Agent-Connect ${connectionToken}`);
    return { status: 200, headers: { "cache-control": "private, no-store" }, body: sealed!.collection };
  });
  transport.on("POST", "/api/v1/agents/self/activate", (req) => {
    assert.equal(req.headers?.authorization, `Bearer ${sealed!.pendingToken}`);
    return { status: 200, headers: { "cache-control": "private, no-store" }, body: { ...sealed!.pendingAgent, state: "active", connected_at: "2026-08-14T17:00:01.000Z" } };
  });
  transport.on("GET", "/api/v1/agents/self", () => ({
    status: 200,
    headers: { "cache-control": "private, no-store" },
    body: { agent: { ...sealed!.pendingAgent, state: "active", connected_at: "2026-08-14T17:00:01.000Z" }, connection_ready: true },
  }));
  const opened: string[] = [];
  const result = await withRuntime(["--json", "agent", "connect", "--name", "Office Codex"], transport, {
    openUrl: async (url) => { opened.push(url); return true; },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(opened, ["https://dashboard.screenrig.ai/agents/connect/acn_AAAAAAAAAAAAAAAAAAAAAAAA"]);
  assert.equal(JSON.parse(result.stdout).data.status, "active");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /sr_live_|sac_|ciphertext|nonce|private|authorization/i);
  const configPath = path.join(result.configDir, "screenrig", "config.json");
  const config = await readConfigFile(configPath, {
    mkdir, open, rename, rm, chmod, stat, homedir: () => result.configDir, env: { XDG_CONFIG_HOME: result.configDir },
  });
  assert.equal(config?.token, sealed?.pendingToken);
  assert.equal(config?.agent_id, sealed?.agentId);
  assert.equal(config?.agent_connection, undefined);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  await rm(result.configDir, { recursive: true, force: true });
});

test("agent disconnect revokes only this installation and preserves safe disconnected status", async () => {
  const transport = new FakeTransport();
  const active = { ...TEST_AGENT, name: "Office Codex" };
  transport.on("GET", "/api/v1/agents/self", () => ({
    status: 200,
    headers: { "cache-control": "private, no-store" },
    body: { agent: active, connection_ready: true },
  }));
  transport.on("POST", "/api/v1/agents/self/disconnect", (req) => {
    assert.equal(req.body, undefined);
    return { status: 204, headers: { "cache-control": "private, no-store" }, body: undefined };
  });
  const configDir = await testTemp("agent-disconnect-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai",
    token: `sr_live_disconnect_${"D".repeat(43)}`,
    account_id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA",
    agent_id: active.id,
  }, fsLike);
  const result = await withRuntime(["--json", "agent", "disconnect", "--yes"], transport, { fs: fsLike });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).data, {
    status: "disconnected",
    local_credential_removed: true,
    account_preserved: true,
    screens_preserved: true,
    other_agents_preserved: true,
  });
  assert.doesNotMatch(result.stdout, /sr_live_|account_id|token/i);
  const local = await readConfigFile(path.join(configDir, "screenrig", "config.json"), fsLike);
  assert.equal(local?.token, undefined);
  assert.equal(local?.account_id, undefined);
  assert.equal(local?.last_agent?.id, active.id);
  const status = await withRuntime(["--json", "agent", "status"], new FakeTransport(), { fs: fsLike });
  assert.equal(JSON.parse(status.stdout).data.status, "disconnected");
  await rm(configDir, { recursive: true, force: true });
});

test("agent connect resumes activation after the pending bearer was durably stored", async () => {
  const transport = new FakeTransport();
  const token = `sr_live_resume_${"R".repeat(43)}`;
  const active = { ...TEST_AGENT, id: "agt_RESUMEAAAAAAAAAAAAAAAAA", name: "Resume agent" };
  transport.on("POST", "/api/v1/agents/self/activate", (req) => {
    assert.equal(req.headers?.authorization, `Bearer ${token}`);
    return { status: 200, headers: { "cache-control": "private, no-store" }, body: active };
  });
  transport.on("GET", "/api/v1/agents/self", () => ({
    status: 200,
    headers: { "cache-control": "private, no-store" },
    body: { agent: active, connection_ready: true },
  }));
  const configDir = await testTemp("agent-connect-resume-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, {
    api_url: "https://api.screenrig.ai",
    token,
    agent_id: active.id,
    agent_connection: {
      private_jwk: generateAgentConnectionKey(),
      connection_id: "acn_RESUMEAAAAAAAAAAAAAAAA",
      connection_token: `sac_${"S".repeat(43)}`,
      approval_url: "https://dashboard.screenrig.ai/agents/connect/acn_RESUMEAAAAAAAAAAAAAAAA",
      expires_at: "2026-08-14T16:10:00.000Z",
      pending_agent_id: active.id,
    },
  }, fsLike);
  let opened = false;
  const result = await withRuntime(["--json", "agent", "connect"], transport, {
    fs: fsLike,
    openUrl: async () => { opened = true; return true; },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(opened, false);
  assert.deepEqual(transport.calls.map((call) => call.path), [
    "/api/v1/agents/self/activate",
    "/api/v1/agents/self",
  ]);
  assert.equal((await readConfigFile(configPath, fsLike))?.agent_connection, undefined);
  assert.doesNotMatch(result.stdout, /sr_live_|sac_|private|authorization/i);
  await rm(configDir, { recursive: true, force: true });
});

test("agent connect clears private and pending bearer state when the dashboard cancels", async () => {
  const transport = new FakeTransport();
  const connectionId = "acn_CANCELAAAAAAAAAAAAAAAA";
  transport.on("POST", "/api/v1/agent-connections", () => ({
    status: 201,
    headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
    body: {
      connection_id: connectionId,
      connection_token: `sac_${"C".repeat(43)}`,
      approval_url: `https://dashboard.screenrig.ai/agents/connect/${connectionId}`,
      expires_at: "2026-08-14T17:10:00.000Z",
    },
  }));
  transport.pushStream(`event: agent.connection\ndata: ${JSON.stringify({
    connection_id: connectionId,
    name: "Cancelled agent",
    agent_type: "cli",
    status: "cancelled",
    expires_at: "2026-08-14T17:10:00.000Z",
    created_at: "2026-08-14T17:00:00.000Z",
  })}\n\n`);
  const result = await withRuntime(["--json", "agent", "connect"], transport, { openUrl: async () => true });
  assert.equal(result.code, ExitCode.Client);
  const envelope = JSON.parse(result.stdout) as { error: { code: string; next: { command: string } } };
  assert.equal(envelope.error.code, "agent_connection_cancelled");
  assert.equal(envelope.error.next.command, "screenrig agent connect");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => result.configDir, env: { XDG_CONFIG_HOME: result.configDir } };
  const local = await readConfigFile(path.join(result.configDir, "screenrig", "config.json"), fsLike);
  assert.equal(local?.agent_connection, undefined);
  assert.equal(local?.token, undefined);
  assert.doesNotMatch(result.stdout, /sac_|private_jwk|connection_token/);
  await rm(result.configDir, { recursive: true, force: true });
});

test("agent connect clears private state when credential collection reports cancellation", async () => {
  const transport = new FakeTransport();
  const connectionId = "acn_CANCELPROBLEMAAAAAAAAA";
  transport.on("POST", "/api/v1/agent-connections", () => ({
    status: 201,
    headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
    body: {
      connection_id: connectionId,
      connection_token: `sac_${"P".repeat(43)}`,
      approval_url: `https://dashboard.screenrig.ai/agents/connect/${connectionId}`,
      expires_at: "2026-08-14T17:10:00.000Z",
    },
  }));
  transport.pushStream(`event: agent.connection\ndata: ${JSON.stringify({
    connection_id: connectionId,
    name: "Cancelled after approval",
    agent_type: "cli",
    status: "approved",
    expires_at: "2026-08-14T17:10:00.000Z",
    created_at: "2026-08-14T17:00:00.000Z",
  })}\n\n`);
  transport.on("POST", `/api/v1/agent-connections/${connectionId}/credential`, () => ({
    status: 410,
    headers: { "content-type": "application/problem+json" },
    body: { status: 410, code: "agent_connection_cancelled", title: "Cancelled", detail: "Pending agent was disconnected." },
  }));
  const result = await withRuntime(["--json", "agent", "connect"], transport, { openUrl: async () => true });
  assert.equal(result.code, ExitCode.Client);
  assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "agent_connection_cancelled");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => result.configDir, env: { XDG_CONFIG_HOME: result.configDir } };
  const local = await readConfigFile(path.join(result.configDir, "screenrig", "config.json"), fsLike);
  assert.equal(local?.agent_connection, undefined);
  assert.equal(local?.token, undefined);
  await rm(result.configDir, { recursive: true, force: true });
});

test("agent connect clears private state when the SSE endpoint reports cancellation", async () => {
  const transport = new FakeTransport();
  const connectionId = "acn_CANCELSSEPROBLEMAAAAAA";
  transport.on("POST", "/api/v1/agent-connections", () => ({
    status: 201,
    headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
    body: {
      connection_id: connectionId,
      connection_token: `sac_${"Q".repeat(43)}`,
      approval_url: `https://dashboard.screenrig.ai/agents/connect/${connectionId}`,
      expires_at: "2026-08-14T17:10:00.000Z",
    },
  }));
  transport.streamHandler = async () => {
    throw new CliError(makeProblem(
      "agent_connection_cancelled",
      "Cancelled",
      410,
      "Pending agent was disconnected.",
    ));
  };
  const result = await withRuntime(["--json", "agent", "connect"], transport, { openUrl: async () => true });
  assert.equal(result.code, ExitCode.Client);
  assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "agent_connection_cancelled");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => result.configDir, env: { XDG_CONFIG_HOME: result.configDir } };
  const local = await readConfigFile(path.join(result.configDir, "screenrig", "config.json"), fsLike);
  assert.equal(local?.agent_connection, undefined);
  assert.equal(local?.token, undefined);
  assert.doesNotMatch(result.stdout, /sac_|private_jwk|connection_token/);
  await rm(result.configDir, { recursive: true, force: true });
});

async function writePendingActivationConfig(
  configDir: string,
  token: string,
  active: typeof TEST_AGENT,
) {
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, {
    api_url: "https://api.screenrig.ai",
    token,
    agent_id: active.id,
    agent_connection: {
      private_jwk: generateAgentConnectionKey(),
      connection_id: "acn_HARDENAAAAAAAAAAAAAAAA",
      connection_token: `sac_${"H".repeat(43)}`,
      approval_url: "https://dashboard.screenrig.ai/agents/connect/acn_HARDENAAAAAAAAAAAAAAAA",
      expires_at: "2026-08-14T17:10:00.000Z",
      pending_agent_id: active.id,
    },
  }, fsLike);
  return { fsLike, configPath };
}

test("agent connect removes a cryptographically rejected pending credential", async () => {
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/agents/self/activate", () => ({
    status: 401,
    headers: { "content-type": "application/problem+json" },
    body: { status: 401, code: "unauthorized", title: "Unauthorized", detail: "Pending bearer revoked." },
  }));
  const configDir = await testTemp("agent-connect-revoked-");
  const token = `sr_live_revoked_${"R".repeat(43)}`;
  const { fsLike, configPath } = await writePendingActivationConfig(configDir, token, TEST_AGENT);
  const result = await withRuntime(["--json", "agent", "connect"], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Auth);
  const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string; next: { command: string } } };
  assert.equal(envelope.error.code, "unauthorized");
  assert.match(envelope.error.detail, /rejected or revoked/);
  assert.equal(envelope.error.next.command, "screenrig agent connect");
  const local = await readConfigFile(configPath, fsLike);
  assert.equal(local?.token, undefined);
  assert.equal(local?.agent_id, undefined);
  assert.equal(local?.agent_connection, undefined);
  assert.doesNotMatch(result.stdout, /sr_live_|sac_|private_jwk/);
  await rm(configDir, { recursive: true, force: true });
});

test("agent connect recovers an activation committed before connection cleanup", async () => {
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/agents/self/activate", () => ({
    status: 404,
    headers: { "content-type": "application/problem+json" },
    body: { status: 404, code: "agent_connection_invalid", title: "Invalid", detail: "Connection cleanup completed." },
  }));
  transport.on("GET", "/api/v1/agents/self", () => ({
    status: 200,
    headers: { "cache-control": "private, no-store" },
    body: { agent: TEST_AGENT, connection_ready: true },
  }));
  const configDir = await testTemp("agent-connect-committed-");
  const token = `sr_live_committed_${"K".repeat(43)}`;
  const { fsLike, configPath } = await writePendingActivationConfig(configDir, token, TEST_AGENT);
  const result = await withRuntime(["--json", "agent", "connect"], transport, { fs: fsLike });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(transport.calls.map((call) => call.path), ["/api/v1/agents/self/activate", "/api/v1/agents/self"]);
  const local = await readConfigFile(configPath, fsLike);
  assert.equal(local?.token, token);
  assert.equal(local?.agent_id, TEST_AGENT.id);
  assert.equal(local?.agent_connection, undefined);
  await rm(configDir, { recursive: true, force: true });
});

test("agent connect retains pending activation state after an ambiguous transport failure", async () => {
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/agents/self/activate", () => { throw networkError("ambiguous activation response"); });
  const configDir = await testTemp("agent-connect-ambiguous-");
  const token = `sr_live_ambiguous_${"A".repeat(43)}`;
  const { fsLike, configPath } = await writePendingActivationConfig(configDir, token, TEST_AGENT);
  const before = await readConfigFile(configPath, fsLike);
  const result = await withRuntime(["--json", "agent", "connect"], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Network);
  assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "transport_error");
  assert.deepEqual(await readConfigFile(configPath, fsLike), before);
  assert.doesNotMatch(result.stdout, /sr_live_|sac_|private_jwk/);
  await rm(configDir, { recursive: true, force: true });
});

test("agent disconnect keeps the credential on lockout risk and names the explicit override", async () => {
  const transport = new FakeTransport();
  transport.on("GET", "/api/v1/agents/self", () => ({
    status: 200,
    headers: { "cache-control": "private, no-store" },
    body: { agent: TEST_AGENT, connection_ready: false },
  }));
  transport.on("POST", "/api/v1/agents/self/disconnect", () => ({
    status: 409,
    headers: { "content-type": "application/problem+json" },
    body: {
      status: 409,
      code: "agent_lockout_risk",
      title: "Agent lockout risk",
      detail: "Disconnecting the last active agent requires explicit override.",
    },
  }));
  const configDir = await testTemp("agent-lockout-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const token = `sr_live_lockout_${"L".repeat(43)}`;
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai",
    token,
    agent_id: TEST_AGENT.id,
  }, fsLike);
  const result = await withRuntime(["--json", "agent", "disconnect", "--yes"], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Conflict);
  assert.equal(JSON.parse(result.stdout).error.next.command, "screenrig agent disconnect --yes --allow-lockout");
  assert.equal((await readConfigFile(path.join(configDir, "screenrig", "config.json"), fsLike))?.token, token);
  assert.doesNotMatch(result.stdout, /sr_live_/);
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
  assert.match((JSON.parse(result.stdout) as { error: { detail: string } }).error.detail, /No stored ScreenRig agent credential/);
  assert.equal(transport.calls.length, 0);
  await rm(configDir, { recursive: true, force: true });
});

test("auth revoke confirms server success before atomically removing all local credential state", async () => {
  const transport = new FakeTransport();
  transport.on("GET", "/api/v1/agents/self", () => ({
    status: 200,
    headers: { "cache-control": "private, no-store" },
    body: { agent: TEST_AGENT, connection_ready: true },
  }));
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
  const envelope = JSON.parse(result.stdout) as { ok: true; data: Record<string, unknown>; warnings: Array<{ code: string }> };
  assert.deepEqual(envelope.data, {
    status: "disconnected",
    local_credential_removed: true,
    account_preserved: true,
    screens_preserved: true,
    other_agents_preserved: true,
  });
  assert.deepEqual(envelope.warnings.map((warning) => warning.code), ["deprecated_command"]);
  assert.doesNotMatch(result.stdout, /current_private_secret|acc_current|enrollment-retry-key|browser-setup-key/);
  assert.deepEqual(transport.calls.map((call) => call.path), ["/api/v1/agents/self", "/api/v1/account/credential/revoke"]);
  assert.equal(transport.calls[1]?.headers?.authorization, `Bearer ${token}`);
  assert.equal(transport.calls[1]?.headers?.["idempotency-key"], undefined);
  const cleaned = await readConfigFile(configPath, fsLike);
  assert.equal(cleaned?.api_url, "https://api.screenrig.ai");
  assert.equal(cleaned?.token, undefined);
  assert.equal(cleaned?.last_agent?.id, TEST_AGENT.id);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  await rm(configDir, { recursive: true, force: true });
});

test("auth revoke retains local state on a server failure and gives a safe retry", async () => {
  const transport = new FakeTransport();
  transport.on("GET", "/api/v1/agents/self", () => ({
    status: 200,
    headers: { "cache-control": "private, no-store" },
    body: { agent: TEST_AGENT, connection_ready: true },
  }));
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
  assert.equal(envelope.error.next.command, "screenrig agent disconnect --yes");
  assert.match(envelope.error.next.reason, /Local credential state was retained/);
  assert.deepEqual(await readConfigFile(configPath, fsLike), original);
  assert.doesNotMatch(result.stdout, /current_private_secret|browser-setup-key/);
  await rm(configDir, { recursive: true, force: true });
});

test("auth revoke retries the exact revoked bearer after cleanup failure and completes local cleanup", async () => {
  const transport = new FakeTransport();
  transport.on("GET", "/api/v1/agents/self", () => ({
    status: 200,
    headers: { "cache-control": "private, no-store" },
    body: { agent: TEST_AGENT, connection_ready: true },
  }));
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
  assert.match(envelope.error.detail, /server disconnected.*atomic local cleanup failed/i);
  assert.equal(envelope.error.next.command, "screenrig agent disconnect --yes");
  assert.doesNotMatch(result.stdout, /current_private_secret/);
  assert.deepEqual(await readConfigFile(configPath, realFs), original);

  const retry = await withRuntime(["--json", "auth", "revoke", "--yes"], transport, { fs: realFs });
  assert.equal(retry.code, 0, retry.stdout);
  assert.equal(transport.calls.length, 4);
  assert.equal(transport.calls[3]?.headers?.authorization, `Bearer ${original.token}`);
  const cleaned = await readConfigFile(configPath, realFs);
  assert.equal(cleaned?.token, undefined);
  assert.equal(cleaned?.last_agent?.id, TEST_AGENT.id);
  await rm(configDir, { recursive: true, force: true });
});

test("auth revoke shares the last-agent guard and explicit allow-lockout override", async () => {
  const transport = new FakeTransport();
  transport.on("GET", "/api/v1/agents/self", () => ({
    status: 200,
    headers: { "cache-control": "private, no-store" },
    body: { agent: TEST_AGENT, connection_ready: true },
  }));
  transport.on("POST", "/api/v1/account/credential/revoke", (req) => {
    if (req.body) {
      return { status: 204, headers: { "cache-control": "private, no-store" } as Record<string, string>, body: undefined };
    }
    return {
      status: 409,
      headers: { "content-type": "application/problem+json" } as Record<string, string>,
      body: { status: 409, code: "agent_lockout_risk", title: "Lockout risk", detail: "Last active agent." },
    };
  });
  const configDir = await testTemp("auth-revoke-lockout-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  const token = `sr_live_auth_lockout_${"L".repeat(43)}`;
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", token, agent_id: TEST_AGENT.id }, fsLike);
  const guarded = await withRuntime(["--json", "auth", "revoke", "--yes"], transport, { fs: fsLike });
  assert.equal(guarded.code, ExitCode.Conflict);
  assert.equal((JSON.parse(guarded.stdout) as { error: { next: { command: string } } }).error.next.command,
    "screenrig agent disconnect --yes --allow-lockout");
  assert.equal((await readConfigFile(configPath, fsLike))?.token, token);
  const override = await withRuntime(["--json", "auth", "revoke", "--yes", "--allow-lockout"], transport, { fs: fsLike });
  assert.equal(override.code, 0, override.stdout);
  assert.deepEqual(transport.calls[3]?.body, { allow_last_agent: true });
  assert.equal((await readConfigFile(configPath, fsLike))?.token, undefined);
  await rm(configDir, { recursive: true, force: true });
});

test("screen pair normalizes safe lowercase input and reports canonical uppercase", async () => {
  const transport = memoryBackend();
  const result = await withAuthenticatedRuntime(["screen", "pair", "abc234", "--label", "Lobby"], transport);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /Screen paired/);
  assert.match(result.stdout, /code: ABC234/);
  assert.deepEqual(transport.calls.at(-1)?.body, { code: "ABC234", label: "Lobby" });
});

test("screen pair rejects ambiguous or malformed codes before claiming", async () => {
  const transport = memoryBackend();
  const result = await withAuthenticatedRuntime(["--json", "screen", "pair", "ABCI01"], transport);
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
    const result = await withAuthenticatedRuntime(argv, transport);
    assert.equal(result.code, ExitCode.Usage);
    assert.equal(transport.calls.some((call) => call.path === "/api/v1/screens/provision"), false);
    await rm(result.configDir, { recursive: true, force: true });
  }
});

test("screen provision --open launches by argv and returns only safe fields", async () => {
  const transport = memoryBackend();
  const opened: string[] = [];
  const result = await withAuthenticatedRuntime(
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
  const result = await withAuthenticatedRuntime(
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
  const first = await withAuthenticatedRuntime(argv, transport, { fs: fsLike, openUrl: async () => false });
  const second = await withAuthenticatedRuntime(argv, transport, { fs: fsLike, openUrl: async () => false });
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

test("an enrolled agent completes browser setup with safe fragment-free output", async () => {
  const transport = memoryBackend();
  const result = await withAuthenticatedRuntime(["--json", "browser", "setup", "--code", "abc-234"], transport);
  assert.equal(result.code, 0, result.stdout);
  const envelope = JSON.parse(result.stdout) as { data: Record<string, unknown> };
  assert.deepEqual(envelope.data, {
    code: "ABC-234",
    status: "claimed",
    player_public_url: "https://play.screenrig.ai/s/browser-link-screen",
  });
  assert.deepEqual(transport.calls.map((call) => `${call.method} ${call.path}`), [
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
  const result = await withAuthenticatedRuntime(
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

const DASHBOARD_TOKEN = "D".repeat(43);
const DASHBOARD_URL = `https://dashboard.screenrig.ai/#link=${DASHBOARD_TOKEN}`;

function dashboardLinkTransport(status: number, body: unknown, headers?: Record<string, string>): FakeTransport {
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/enrollments", () => ({
    status: 201,
    headers: { "cache-control": "private, no-store" },
    body: {
      account: { id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA" },
      agent: TEST_AGENT,
      connection_ready: false,
      token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      issuance_id: "iss_AAAAAAAAAAAAAAAAAAAAAAAA",
      issuance_expires_at: "2026-08-14T17:10:00.000Z",
    },
  }));
  transport.on("GET", "/api/v1/account", () => ({ status: 200, headers: {}, body: { id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA" } }));
  transport.on("POST", "/api/v1/account/dashboard-links", () => ({
    status,
    headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", ...headers },
    body,
  }));
  return transport;
}

test("dashboard mints one single-use link, opens it, and keeps the URL out of every output", async () => {
  const transport = memoryBackend();
  const opened: string[] = [];
  const result = await withAuthenticatedRuntime(
    ["--json", "dashboard"],
    transport,
    { openUrl: async (url) => { opened.push(url); return true; } },
  );
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(opened, [DASHBOARD_URL]);
  const envelope = JSON.parse(result.stdout) as { data: Record<string, unknown> };
  assert.deepEqual(envelope.data, {
    expires_at: "2026-08-14T17:10:00.000Z",
    single_use: true,
    opened: true,
  });
  // The token was handed to the browser and to nothing else.
  assert.doesNotMatch(result.stdout, /#link=|dashboard\.screenrig\.ai|DDDDD/);
  assert.doesNotMatch(result.stderr, /#link=|DDDDD/);
  assert.deepEqual(transport.calls.map((call) => `${call.method} ${call.path}`), [
    "POST /api/v1/account/dashboard-links",
  ]);
  const mint = transport.calls.at(-1);
  assert.ok(mint?.headers?.["idempotency-key"], "the mint route requires an Idempotency-Key");
  assert.equal(mint?.body, undefined);
  // Nothing about the link is persisted; only a fresh mint can produce another.
  const config = await readConfigFile(path.join(result.configDir, "screenrig", "config.json"), {
    mkdir, open, rename, rm, chmod, stat,
    homedir: () => result.configDir,
    env: { XDG_CONFIG_HOME: result.configDir },
  });
  assert.doesNotMatch(JSON.stringify(config), /#link=|dashboard|DDDDD/);
  await rm(result.configDir, { recursive: true, force: true });
});

test("dashboard prints the link exactly once when no browser could be opened", async () => {
  const result = await withAuthenticatedRuntime(
    ["dashboard"],
    memoryBackend(),
    { openUrl: async () => false },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.match(/#link=/g)?.length, 1);
  assert.match(result.stdout, /no browser could be opened/);
  assert.match(result.stdout, /single use, ten minutes from mint/);
  assert.match(result.stdout, /reissue: run screenrig dashboard again for a fresh link/);
  assert.match(result.stdout, new RegExp(`url: ${DASHBOARD_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await rm(result.configDir, { recursive: true, force: true });
});

test("dashboard --print-url never starts a browser and reports the same expiry", async () => {
  const opened: string[] = [];
  const result = await withAuthenticatedRuntime(
    ["--json", "dashboard", "--print-url"],
    memoryBackend(),
    { openUrl: async (url) => { opened.push(url); return true; } },
  );
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(opened, []);
  const envelope = JSON.parse(result.stdout) as { data: Record<string, unknown> };
  assert.deepEqual(envelope.data, {
    expires_at: "2026-08-14T17:10:00.000Z",
    single_use: true,
    url: DASHBOARD_URL,
  });
  await rm(result.configDir, { recursive: true, force: true });
});

test("dashboard refuses an unsafe or off-origin minted URL and opens nothing", async () => {
  for (const url of [
    `https://dashboard.screenrig.ai/?link=${DASHBOARD_TOKEN}`,
    `https://evil.invalid/#link=${DASHBOARD_TOKEN}`,
    `http://dashboard.screenrig.localhost/#link=${DASHBOARD_TOKEN}`,
  ]) {
    const opened: string[] = [];
    const result = await withAuthenticatedRuntime(
      ["--json", "dashboard"],
      dashboardLinkTransport(201, { url, expires_at: "2026-08-14T17:10:00.000Z" }),
      { openUrl: async (target) => { opened.push(target); return true; } },
    );
    assert.equal(result.code, ExitCode.Usage, result.stdout);
    assert.deepEqual(opened, []);
    assert.match(result.stdout, /unsafe URL/);
    assert.doesNotMatch(result.stdout, /DDDDD/);
    await rm(result.configDir, { recursive: true, force: true });
  }
});

test("dashboard surfaces the mint problem verbatim and prints no link", async () => {
  const cases: Array<{ status: number; code: string; exit: number }> = [
    { status: 401, code: "unauthorized", exit: ExitCode.Auth },
    { status: 402, code: "payment_required", exit: ExitCode.Client },
    { status: 503, code: "not_ready", exit: ExitCode.Server },
  ];
  for (const item of cases) {
    const result = await withAuthenticatedRuntime(
      ["--json", "dashboard"],
      dashboardLinkTransport(item.status, {
        type: `https://screenrig.ai/problems/${item.code.replaceAll("_", "-")}`,
        title: "Mint refused",
        status: item.status,
        code: item.code,
        detail: "The dashboard link was not minted.",
      }),
      { openUrl: async () => true },
    );
    const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; status: number } };
    assert.equal(envelope.ok, false, result.stdout);
    assert.equal(envelope.error.code, item.code);
    assert.equal(envelope.error.status, item.status);
    assert.equal(result.code, item.exit, `${item.code} exit code`);
    assert.doesNotMatch(result.stdout, /#link=|DDDDD/);
    await rm(result.configDir, { recursive: true, force: true });
  }
});

test("dashboard rejects positional arguments and a mint response without private no-store", async () => {
  const positional = await withRuntime(["--json", "dashboard", "open"], memoryBackend());
  assert.equal(positional.code, ExitCode.Usage, positional.stdout);
  assert.match(positional.stdout, /does not accept positional arguments/);
  await rm(positional.configDir, { recursive: true, force: true });

  const cached = await withAuthenticatedRuntime(
    ["--json", "dashboard"],
    dashboardLinkTransport(
      201,
      { url: DASHBOARD_URL, expires_at: "2026-08-14T17:10:00.000Z" },
      { "cache-control": "public, max-age=60" },
    ),
    { openUrl: async () => true },
  );
  assert.equal(cached.code, ExitCode.Usage, cached.stdout);
  assert.match(cached.stdout, /private, no-store/);
  assert.doesNotMatch(cached.stdout, /DDDDD/);
  await rm(cached.configDir, { recursive: true, force: true });
});

const BROWSER_CLAIM_SCREEN = {
  id: "scr_browser_link",
  public_id: "browser-link-screen",
  state: "pairing_pending" as const,
  public_url: "https://play.screenrig.ai/s/browser-link-screen",
};

function browserSetupClaimTransport(body: unknown): FakeTransport {
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/enrollments", () => ({
    status: 201,
    headers: { "cache-control": "private, no-store" },
    body: {
      account: { id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA" },
      agent: TEST_AGENT,
      connection_ready: false,
      token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      issuance_id: "iss_AAAAAAAAAAAAAAAAAAAAAAAA",
      issuance_expires_at: "2026-08-14T17:10:00.000Z",
    },
  }));
  transport.on("GET", "/api/v1/account", () => ({ status: 200, headers: {}, body: { id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA" } }));
  transport.on("POST", "/api/v1/account/browser-links/claim", () => ({
    status: 201,
    headers: { "cache-control": "private, no-store" },
    body,
  }));
  return transport;
}

test("browser setup ignores extra claim and screen keys without echoing them", async () => {
  const secret = `https://play.screenrig.ai/s/browser-link-screen#provision=${"S".repeat(43)}`;
  const transport = browserSetupClaimTransport({
    session_id: "bls_fixture",
    status: "claimed",
    screen: {
      ...BROWSER_CLAIM_SCREEN,
      timezone: "America/Los_Angeles",
      observation: {
        observed_at: "2026-08-14T17:00:00.000Z",
        surfaces: [{ id: "primary", width: 1920, height: 1080, pixel_ratio: 1, presentation: "output" }],
      },
    },
    provisioning_url: secret,
  });
  const result = await withAuthenticatedRuntime(["--json", "browser", "setup", "--code", "ABC234"], transport);
  assert.equal(result.code, 0, result.stdout);
  const envelope = JSON.parse(result.stdout) as { data: Record<string, unknown> };
  assert.deepEqual(envelope.data, {
    code: "ABC-234",
    status: "claimed",
    player_public_url: "https://play.screenrig.ai/s/browser-link-screen",
  });
  assert.doesNotMatch(result.stdout, /#provision=|provisioning_url|SSSSSS|timezone|observation|America\/Los_Angeles/i);
  await rm(result.configDir, { recursive: true, force: true });
});

test("browser setup rejects missing required claim fields, bad status, and unsafe public URLs", async () => {
  const cases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: "missing session_id", body: { status: "claimed", screen: BROWSER_CLAIM_SCREEN } },
    { name: "bad status", body: { session_id: "bls_fixture", status: "waiting", screen: BROWSER_CLAIM_SCREEN } },
    { name: "missing screen", body: { session_id: "bls_fixture", status: "claimed" } },
    { name: "missing screen id", body: { session_id: "bls_fixture", status: "claimed", screen: { ...BROWSER_CLAIM_SCREEN, id: "" } } },
    { name: "missing public_id", body: { session_id: "bls_fixture", status: "claimed", screen: { ...BROWSER_CLAIM_SCREEN, public_id: "" } } },
    { name: "bad screen state", body: { session_id: "bls_fixture", status: "claimed", screen: { ...BROWSER_CLAIM_SCREEN, state: "active" } } },
    { name: "missing public_url", body: { session_id: "bls_fixture", status: "claimed", screen: { ...BROWSER_CLAIM_SCREEN, public_url: "" } } },
    { name: "hash in public_url", body: { session_id: "bls_fixture", status: "claimed", screen: { ...BROWSER_CLAIM_SCREEN, public_url: "https://play.screenrig.ai/s/browser-link-screen#provision=SSS" } } },
    { name: "search in public_url", body: { session_id: "bls_fixture", status: "claimed", screen: { ...BROWSER_CLAIM_SCREEN, public_url: "https://play.screenrig.ai/s/browser-link-screen?q=1" } } },
    { name: "userinfo in public_url", body: { session_id: "bls_fixture", status: "claimed", screen: { ...BROWSER_CLAIM_SCREEN, public_url: "https://user:pass@play.screenrig.ai/s/browser-link-screen" } } },
    { name: "wrong origin", body: { session_id: "bls_fixture", status: "claimed", screen: { ...BROWSER_CLAIM_SCREEN, public_url: "https://example.invalid/s/browser-link-screen" } } },
    { name: "pathname mismatch", body: { session_id: "bls_fixture", status: "claimed", screen: { ...BROWSER_CLAIM_SCREEN, public_url: "https://play.screenrig.ai/s/other-id" } } },
  ];
  for (const item of cases) {
    const result = await withAuthenticatedRuntime(["--json", "browser", "setup", "--code", "ABC234"], browserSetupClaimTransport(item.body));
    assert.equal(result.code, ExitCode.Usage, item.name);
    assert.doesNotMatch(result.stdout, /#provision=|user:pass|token|cookie|proof/i, item.name);
    await rm(result.configDir, { recursive: true, force: true });
  }
});

test("browser setup rejects malformed codes before claim and keeps exact ambiguous retry state", async () => {
  const invalid = await withAuthenticatedRuntime(["--json", "browser", "setup", "--code", "ABC10I"], memoryBackend());
  assert.equal(invalid.code, ExitCode.Usage);
  await rm(invalid.configDir, { recursive: true, force: true });

  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/enrollments", () => ({
    status: 201,
    headers: { "cache-control": "private, no-store" },
    body: {
      account: { id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA" },
      agent: TEST_AGENT,
      connection_ready: false,
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
  await withAuthenticatedRuntime(["--json", "browser", "setup", "--code", "ABC234"], transport, { fs: fsLike });
  await withAuthenticatedRuntime(["--json", "browser", "setup", "--code", "ABC-234"], transport, { fs: fsLike });
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
    email: "owner@example.com",
  };
  await writeConfigAtomic(configPath, {
    api_url: "https://api.screenrig.ai",
    enrollment: retryState,
  }, fsLike);
  const result = await withRuntime(["--json", "agent", "enroll"], transport, { fs: fsLike });
  assert.notEqual(result.code, 0);
  assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "credential_issuance_expired");
  assert.deepEqual(transport.calls.map((call) => call.path), ["/api/v1/enrollments"]);
  assert.equal(transport.calls[0]?.headers?.["idempotency-key"], retryState.idempotency_key);
  assert.deepEqual(transport.calls[0]?.body, {
    client_id: retryState.client_id,
    email: retryState.email,
    agent_type: "cli",
    platform: `${process.platform}/${process.arch}`,
    version: "0.1.0",
  });
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
      details: { extra: { nested: true }, count: 2, primitive_id: "weather", code: "cta.pressed" },
      at: "2026-08-14T17:00:00.000Z",
    }),
    "at=2026-08-14T17:00:00.000Z type=application.event severity=info code=cta.pressed primitive_id=weather count=2",
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
      details: { code: "cta.pressed", primitive_id: "weather", note: 'said "hi"' },
      at: "2026-08-18T19:30:48.471Z",
    }),
    'at=2026-08-18T19:30:48.471Z type=application.event severity=info resource_type=screen resource_id=scr_1 code=cta.pressed primitive_id=weather note="said \\"hi\\"" message="Doors open"',
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
      details: { code: "cta.pressed", primitive_id: "weather" },
      at: "2026-08-14T17:00:07.000Z",
    }),
    "at=2026-08-14T17:00:07.000Z type=application.event severity=info code=cta.pressed primitive_id=weather",
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
          details: { code: "cta.pressed", primitive_id: "weather" },
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
    "at=2026-08-14T17:00:00.000Z type=application.event severity=info code=cta.pressed primitive_id=weather\nat=2026-08-14T17:00:01.000Z type=runtime.reported severity=warning code=decoder.stalled\n",
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
    "id: ev1_1\nevent: message\ndata: {\"cursor\":\"ev1_1\",\"type\":\"application.event\",\"severity\":\"info\",\"message\":\"Application emitted an event\",\"details\":{\"code\":\"cta.pressed\",\"primitive_id\":\"weather\"},\"at\":\"2026-08-14T17:00:00.000Z\"}\n\n",
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
    "at=2026-08-14T17:00:00.000Z type=application.event severity=info code=cta.pressed primitive_id=weather\nat=2026-08-14T17:00:01.000Z type=runtime.reported severity=warning code=decoder.stalled\n",
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
  assert.ok(names.includes("cwebp"));
  await rm(configDir, { recursive: true, force: true });
});

/**
 * Fake toolchain probe. `encoders` and `filters` are the ffmpeg capability
 * listings, and `cwebp` decides whether the standalone binary answers
 * `-version` at all.
 */
function fakeToolchainProbe(options: { encoders: string[]; filters: string[]; cwebp: boolean }) {
  return async (request: { command: string; args: string[] }) => {
    if (request.args.includes("-version") && !request.args.includes("-hide_banner")) {
      return options.cwebp
        ? { code: 0, signal: null, stdout: "1.6.0\nlibsharpyuv: 0.4.2\n", stderrTail: "" }
        : { code: null, signal: null, stdout: "", stderrTail: "", spawnError: "spawn cwebp ENOENT" };
    }
    if (request.args.includes("-version")) {
      return { code: 0, signal: null, stdout: `${path.basename(request.command)} version n8.1.2\n`, stderrTail: "" };
    }
    if (request.args.includes("-encoders")) {
      const rows = options.encoders.map((encoder) => ` V....D ${encoder}              ${encoder}\n`).join("");
      return { code: 0, signal: null, stdout: rows, stderrTail: "" };
    }
    if (request.args.includes("-filters")) {
      const rows = options.filters.map((filter) => ` .S ${filter}            V->V       Filter.\n`).join("");
      return { code: 0, signal: null, stdout: rows, stderrTail: "" };
    }
    return { code: 1, signal: null, stdout: "", stderrTail: "" };
  };
}

async function doctorWithToolchain(
  prefix: string,
  options: { encoders: string[]; filters: string[]; cwebp: boolean },
  readiness?: { status: number; body: unknown },
): Promise<{
  code: number;
  status: string;
  byName: Record<string, { name: string; status: string; detail: string } | undefined>;
  cleanup: () => Promise<void>;
}> {
  resetFfmpegToolchainCache();
  const transport = memoryBackend();
  if (readiness) {
    const request = transport.request.bind(transport);
    transport.request = async (req) => req.path === "/.ready"
      ? { ...readiness, headers: {} }
      : request(req);
  }
  const configDir = await testTemp(prefix);
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const { code, stdout } = await withRuntime(["--json", "doctor"], transport, {
    fs: fsLike,
    runProcess: fakeToolchainProbe(options) as unknown as NonNullable<CliRuntime["runProcess"]>,
  });
  const envelope = JSON.parse(stdout) as {
    ok: boolean;
    data: { status: string; checks: Array<{ name: string; status: string; detail: string }> };
  };
  return {
    code,
    status: envelope.data.status,
    byName: Object.fromEntries(envelope.data.checks.map((check) => [check.name, check])),
    cleanup: () => rm(configDir, { recursive: true, force: true }),
  };
}

test("doctor warns about degraded application workers without failing HTTP readiness", async () => {
  const { code, status, byName, cleanup } = await doctorWithToolchain("doctor-degraded-", {
    encoders: ["libx264", "libx265", "libwebp"], filters: ["zscale", "tonemap"], cwebp: true,
  }, { status: 200, body: { status: "ready", degraded: ["application_processing", "valkey", "private-probe-value"] } });
  try {
    assert.equal(code, ExitCode.Success);
    assert.equal(status, "warn");
    assert.equal(byName.ready?.status, "warn");
    assert.match(byName.ready?.detail ?? "", /service ready with degraded dependencies/);
    assert.match(byName.ready?.detail ?? "", /application_processing:.*restore application workers.*rerun doctor/);
    assert.match(byName.ready?.detail ?? "", /valkey:.*restore Valkey connectivity/);
    assert.match(byName.ready?.detail ?? "", /another optional dependency/);
    assert.doesNotMatch(byName.ready?.detail ?? "", /private-probe-value/);
    assert.equal(byName.health?.status, "pass");
  } finally {
    await cleanup();
  }
});

test("doctor passes healthy readiness and still fails HTTP 503 readiness", async () => {
  for (const response of [
    { status: 200, body: { status: "ready", degraded: [] } },
    { status: 503, body: { code: "not_ready", status: 503, detail: "The service is not ready to accept traffic." } },
  ]) {
    const { code, status, byName, cleanup } = await doctorWithToolchain("doctor-ready-status-", {
      encoders: ["libx264", "libx265", "libwebp"], filters: ["zscale", "tonemap"], cwebp: true,
    }, response);
    try {
      assert.equal(code, response.status === 200 ? ExitCode.Success : ExitCode.Unexpected);
      assert.equal(status, response.status === 200 ? "pass" : "fail");
      assert.equal(byName.ready?.status, response.status === 200 ? "pass" : "fail");
    } finally {
      await cleanup();
    }
  }
});

test("doctor exits 0 on a clean host whose ffmpeg has libwebp and which has no cwebp", async () => {
  const { code, status, byName, cleanup } = await doctorWithToolchain("doctor-no-cwebp-", {
    encoders: ["libx264", "libx265", "libwebp", "libwebp_anim"],
    filters: ["scale", "zscale", "tonemap"],
    cwebp: false,
  });
  try {
    assert.equal(byName.encoder_libwebp?.status, "pass");
    assert.equal(byName.cwebp?.status, "warn", "cwebp is only the fallback for a build without libwebp");
    assert.match(byName.cwebp?.detail ?? "", /not required because this ffmpeg build has the libwebp encoder/);
    assert.equal(status, "warn");
    assert.equal(code, ExitCode.Success, "a host missing nothing required must exit 0");
  } finally {
    await cleanup();
  }
});

test("doctor warns rather than fails for the encoders and filters that only optional paths need", async () => {
  const { code, byName, cleanup } = await doctorWithToolchain("doctor-optional-", {
    encoders: ["libx264", "libwebp", "libwebp_anim"],
    filters: ["scale"],
    cwebp: true,
  });
  try {
    assert.equal(byName.encoder_libx264?.status, "pass");
    assert.equal(byName.encoder_libx265?.status, "warn");
    assert.match(byName.encoder_libx265?.detail ?? "", /--codec hevc is unavailable/);
    assert.equal(byName.filter_hdr_tonemap?.status, "warn");
    assert.equal(byName.cwebp?.status, "pass");
    assert.equal(code, ExitCode.Success);
  } finally {
    await cleanup();
  }
});

test("doctor reports encoder_libwebp independently of the cwebp fallback", async () => {
  const { code, byName, cleanup } = await doctorWithToolchain("doctor-cwebp-", {
    encoders: ["libx264"],
    filters: ["scale"],
    cwebp: true,
  });
  try {
    assert.equal(byName.encoder_libwebp?.status, "warn", "the cwebp fallback still encodes stills");
    assert.match(byName.encoder_libwebp?.detail ?? "", /libwebp missing/);
    assert.doesNotMatch(byName.encoder_libwebp?.detail ?? "", /cwebp/);
    assert.equal(byName.cwebp?.status, "pass");
    assert.match(byName.cwebp?.detail ?? "", /1\.6\.0/);
    assert.equal(code, ExitCode.Success);
  } finally {
    await cleanup();
  }
});

test("doctor fails when neither libwebp nor cwebp can produce WebP", async () => {
  const { code, status, byName, cleanup } = await doctorWithToolchain("doctor-no-webp-", {
    encoders: ["libx264"],
    filters: ["scale"],
    cwebp: false,
  });
  try {
    assert.equal(byName.encoder_libwebp?.status, "fail");
    assert.equal(byName.cwebp?.status, "fail");
    assert.match(byName.cwebp?.detail ?? "", /no libwebp encoder either/);
    assert.match(byName.cwebp?.detail ?? "", /SCREENRIG_CWEBP/);
    assert.equal(status, "fail");
    assert.equal(code, ExitCode.Unexpected, "no WebP encoder at all is a real defect");
  } finally {
    await cleanup();
  }
});

test("doctor fails a missing libx264 because it is the default video profile", async () => {
  const { code, byName, cleanup } = await doctorWithToolchain("doctor-no-x264-", {
    encoders: ["libwebp"],
    filters: ["zscale", "tonemap"],
    cwebp: false,
  });
  try {
    assert.equal(byName.encoder_libx264?.status, "fail");
    assert.equal(code, ExitCode.Unexpected);
  } finally {
    await cleanup();
  }
});

/**
 * ENG-5821. Every segment of a live credential is secret, including the lookup
 * id ahead of the final underscore, so doctor reports presence and no part of
 * the stored value reaches stdout in either output mode.
 */
test("doctor reports a configured credential as presence only", async () => {
  resetFfmpegToolchainCache();
  const configDir = await testTemp("doctor-token-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const probe = fakeToolchainProbe({
    encoders: ["libx264", "libx265", "libwebp", "libwebp_anim"],
    filters: ["scale", "zscale", "tonemap"],
    cwebp: true,
  }) as unknown as NonNullable<CliRuntime["runProcess"]>;
  try {
    const json = await withRuntime(["--json", "doctor"], memoryBackend(), { fs: fsLike, runProcess: probe });
    const envelope = JSON.parse(json.stdout) as {
      data: { checks: Array<{ name: string; status: string; detail: string }> };
    };
    const token = envelope.data.checks.find((check) => check.name === "token");
    assert.ok(token, json.stdout);
    assert.equal(token.status, "pass");
    assert.equal(token.detail, "present");
    for (const pattern of [/sr_live_/, /tokidAAAA/, /secretsecret/]) {
      assert.doesNotMatch(json.stdout, pattern);
    }

    const human = await withRuntime(["doctor"], memoryBackend(), { fs: fsLike, runProcess: probe });
    assert.match(human.stdout, /^PASS token: present$/m);
    for (const pattern of [/sr_live_/, /tokidAAAA/, /secretsecret/]) {
      assert.doesNotMatch(human.stdout, pattern);
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("doctor fails the token check without a credential", async () => {
  resetFfmpegToolchainCache();
  const { code, stdout, configDir } = await withRuntime(["--json", "doctor"], memoryBackend());
  assert.equal(code, ExitCode.Unexpected);
  const envelope = JSON.parse(stdout) as {
    data: { status: string; checks: Array<{ name: string; status: string; detail: string }> };
  };
  const token = envelope.data.checks.find((check) => check.name === "token");
  assert.ok(token, stdout);
  assert.equal(token.status, "fail");
  assert.equal(token.detail, "(none)");
  assert.doesNotMatch(stdout, /sr_live_/);
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

function losslessWebpFixture(width = 8, height = 8): Buffer {
  const bits = Buffer.alloc(5);
  bits.writeUInt8(0x2f, 0);
  bits.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(bits.length);
  const pad = Buffer.from([0]);
  const body = Buffer.concat([Buffer.from("WEBP"), Buffer.from("VP8L"), chunkSize, bits, pad]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), size, body]);
}

function lossyWebpFixture(width = 8, height = 8): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(data.length);
  const body = Buffer.concat([Buffer.from("WEBP"), Buffer.from("VP8X"), chunkSize, data]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), size, body]);
}

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

test("media upload refuses lossless WebP before declare", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("media-lossless-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const file = path.join(configDir, "mark.webp");
  await writeFile(file, losslessWebpFixture());
  const result = await withRuntime(
    ["--json", "media", "upload", file, "--no-transcode"],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Usage, result.stdout);
  const envelope = JSON.parse(result.stdout) as { ok: false; error: { code: string; detail: string } };
  assert.equal(envelope.error.code, "usage_error");
  assert.match(envelope.error.detail, /Lossless WebP \(VP8L\) is not accepted/);
  assert.match(envelope.error.detail, /--no-transcode/);
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

  const encoded = lossyWebpFixture(3840, 1920);
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
        id?: string;
        media_id?: string;
        operation: { result?: { media_id?: string } };
        upload: { content_type: string };
        transcode: { applied: boolean; width: number; height: number; dimensions_measured: boolean };
      };
    };
    assert.equal(envelope.data.upload.content_type, "image/webp");
    assert.equal(envelope.data.media_id, "med_AAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(envelope.data.id, envelope.data.media_id);
    assert.equal(envelope.data.operation.result?.media_id, envelope.data.media_id);
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

async function withTokenConfig(
  transport: FakeTransport,
  argv: string[],
  extra?: Partial<CliRuntime>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const configDir = await testTemp("credits-cfg-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  try {
    return await withRuntime(argv, transport, { fs: fsLike, ...extra });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

function accountRecord(credit_remaining: number): Record<string, unknown> {
  return {
    content_limit_bytes: 0,
    created_at: "2026-08-14T17:00:00.000Z",
    credit_remaining,
    id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA",
    reserved_bytes: 0,
    revision: 1,
    screen_count: 0,
    screen_limit: 100,
    status: "active",
    updated_at: "2026-08-14T17:00:00.000Z",
    used_bytes: 0,
  };
}

function accountShowTransport(opts?: { header?: string; remaining?: number }): FakeTransport {
  const transport = new FakeTransport();
  const headers: Record<string, string> = { "x-request-id": "req_account" };
  if (opts?.header !== undefined) {
    headers["ScreenRig-Credits-Remaining"] = opts.header;
  }
  transport.on("GET", "/api/v1/account", () => ({
    status: 200,
    headers,
    body: accountRecord(opts?.remaining ?? 5000),
  }));
  return transport;
}

test("account show reports integer credit_remaining and warns when remaining is zero", async () => {
  const transport = memoryBackend();
  const json = await withTokenConfig(transport, ["--json", "account", "show"]);
  assert.equal(json.code, 0, json.stdout);
  const envelope = JSON.parse(json.stdout) as {
    ok: boolean;
    data: { credit_remaining: number; token_present: boolean };
    warnings: Array<{ code: string; message: string }>;
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.credit_remaining, 0);
  // ENG-5821: the credential is reported as presence, never as a token shape.
  assert.equal(envelope.data.token_present, true);
  assert.doesNotMatch(json.stdout, /sr_live_|tokidAAAA/);
  const warning = envelope.warnings.find((item) => item.code === "credits_low");
  assert.ok(warning, json.stdout);
  assert.match(warning.message, /\b0\b/);
  assert.match(warning.message, /below 1000 credits/);
  assert.doesNotMatch(json.stdout, /kCr|stripe|x402|mcr|millicredit|\$/i);

  const human = await withTokenConfig(transport, ["account", "show"]);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /credit_remaining: 0/);
  assert.match(human.stdout, /^token: present$/m);
  assert.doesNotMatch(human.stdout, /sr_live_|tokidAAAA/);
  assert.match(human.stdout, /warning: Remaining prepaid credit is 0, below 1000 credits\./);
  assert.doesNotMatch(human.stdout, /kCr|stripe|x402|mcr|millicredit|\$/i);
});

test("remaining header 1000 does not add credits_low", async () => {
  const transport = accountShowTransport({ header: "1000", remaining: 0 });
  const json = await withTokenConfig(transport, ["--json", "account", "show"]);
  assert.equal(json.code, 0, json.stdout);
  const envelope = JSON.parse(json.stdout) as { ok: boolean; warnings: Array<{ code: string }> };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.warnings.some((item) => item.code === "credits_low"), false, json.stdout);
});

test("remaining header 999 adds credits_low on JSON and human output", async () => {
  const transport = accountShowTransport({ header: "999", remaining: 5000 });
  const json = await withTokenConfig(transport, ["--json", "account", "show"]);
  assert.equal(json.code, 0, json.stdout);
  const envelope = JSON.parse(json.stdout) as { ok: boolean; warnings: Array<{ code: string; message: string }> };
  assert.equal(envelope.ok, true);
  const warning = envelope.warnings.find((item) => item.code === "credits_low");
  assert.ok(warning, json.stdout);
  assert.match(warning.message, /\b999\b/);
  assert.doesNotMatch(json.stdout, /kCr|stripe|x402|mcr|millicredit|\$/i);

  const human = await withTokenConfig(transport, ["account", "show"]);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /warning: Remaining prepaid credit is 999, below 1000 credits\./);
});

test("remaining header 0 on a successful command adds credits_low", async () => {
  const transport = accountShowTransport({ header: "0", remaining: 5000 });
  const json = await withTokenConfig(transport, ["--json", "account", "show"]);
  assert.equal(json.code, 0, json.stdout);
  const envelope = JSON.parse(json.stdout) as { ok: boolean; warnings: Array<{ code: string; message: string }> };
  const warning = envelope.warnings.find((item) => item.code === "credits_low");
  assert.ok(warning, json.stdout);
  assert.match(warning.message, /\b0\b/);
});

test("no remaining header and remaining at or above 1000 does not add credits_low", async () => {
  const transport = accountShowTransport({ remaining: 1000 });
  const json = await withTokenConfig(transport, ["--json", "account", "show"]);
  assert.equal(json.code, 0, json.stdout);
  const envelope = JSON.parse(json.stdout) as { ok: boolean; warnings: Array<{ code: string }> };
  assert.equal(envelope.warnings.some((item) => item.code === "credits_low"), false, json.stdout);
});

test("unauthenticated version does not add credits_low", async () => {
  const transport = memoryBackend();
  transport.extraResponseHeaders = { "ScreenRig-Credits-Remaining": "0" };
  const json = await withRuntime(["--json", "version"], transport);
  try {
    assert.equal(json.code, 0, json.stdout);
    const envelope = JSON.parse(json.stdout) as { ok: boolean; warnings: Array<{ code: string }> };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.warnings.some((item) => item.code === "credits_low"), false, json.stdout);
  } finally {
    await rm(json.configDir, { recursive: true, force: true });
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
      warnings?: Array<{ code: string }>;
    };
    assert.equal(envelope.error.code, "payment_required");
    assert.equal(envelope.error.status, 402);
    assert.match(String(envelope.error.next?.command), /account show/);
    assert.match(String(envelope.error.next?.reason), /credit_remaining/);
    assert.doesNotMatch(String(envelope.error.next?.reason), /mcr|millicredit/);
    assert.equal(envelope.warnings?.some((item) => item.code === "credits_low") ?? false, false, result.stdout);
    assert.doesNotMatch(result.stdout, /stripe|x402|pay |kCr|mcr|millicredit|\$/i);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a 402 with remaining header 0 includes payment_required and credits_low", async () => {
  const transport = new FakeTransport();
  transport.on("POST", "/api/v1/media/uploads", () => ({
    status: 402,
    headers: {
      "content-type": "application/problem+json",
      "ScreenRig-Credits-Remaining": "0",
    },
    body: {
      type: "https://screenrig.ai/problems/payment-required",
      title: "Prepaid credit is required",
      status: 402,
      detail: "Prepaid credit remaining is zero.",
      code: "payment_required",
    },
  }));
  const configDir = await testTemp("media-payment-header-");
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
    assert.equal(result.code, 8, result.stdout);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string; status: number; next?: { command: string } };
      warnings?: Array<{ code: string; message: string }>;
    };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "payment_required");
    assert.equal(envelope.error.status, 402);
    assert.match(String(envelope.error.next?.command), /account show/);
    const warning = envelope.warnings?.find((item) => item.code === "credits_low");
    assert.ok(warning, result.stdout);
    assert.match(warning.message, /\b0\b/);
    assert.doesNotMatch(result.stdout, /stripe|x402|pay |kCr|mcr|millicredit|\$/i);

    const human = await withRuntime(["media", "upload", file, "--no-transcode"], transport, { fs: fsLike });
    assert.equal(human.code, 8, human.stderr);
    assert.match(human.stderr, /payment_required/);
    assert.match(human.stderr, /warning: Remaining prepaid credit is 0, below 1000 credits\./);
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
    for (const bad of [["--webp-quality", "500"], ["--codec", "vp9"], ["--max-edge", "99999"], ["--max-fps", "0"], ["--max-fps", "oops"], ["--max-edge"], ["--preset"], ["--preset", "unknown"], ["--preset", "signage-1080p30"], ["--no-audio"], ["--no-audio=false"]]) {
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
      data: { id?: string; media_id?: string; operation: { result?: { media_id?: string } } };
      warnings: Array<{ code: string; message: string }>;
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.media_id, "med_AAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(envelope.data.id, envelope.data.media_id);
    assert.equal(envelope.data.operation.result?.media_id, envelope.data.media_id);
    const warning = envelope.warnings.find((item) => item.code === "generic_filename");
    assert.ok(warning, result.stdout);
    assert.match(warning.message, /video\.mp4/);
    assert.equal(transport.calls.filter((call) => call.path === "/api/v1/media/uploads").length, 1);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("customer-facing credit copy is fail-open until 1 Jan 2027", () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const documents: Array<[string, string]> = [
    ["USAGE", USAGE],
    ["README.md", readFileSync(path.join(repoRoot, "README.md"), "utf8")],
    ["AGENTS.md", readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")],
  ];
  for (const [name, text] of documents) {
    assert.match(text, /nonnegative/, `${name} must say remaining is nonnegative`);
    assert.match(text, /credits_low/, `${name} must name the live credits_low warning`);
    assert.match(text, /1000 credits/, `${name} must name the live 1000-credit warning threshold`);
    assert.match(text, /1 Jan(?:uary)? 2027|2027-01-01/, `${name} must name the 1 Jan 2027 cutoff`);
    assert.match(text, /fails open/, `${name} must say production fails open until the cutoff`);
    assert.match(text, /not rejected for empty\s+remaining/, `${name} must say billed work is not rejected yet`);
    assert.match(text, /payment_required/, `${name} must keep payment_required as the after-cutoff code`);
    assert.match(text, /402/, `${name} must name HTTP 402 as after-cutoff, not current`);
    assert.match(text, /does not stop or\s+shut off screens/, `${name} must not claim screens stop for empty remaining`);
  }
  assert.match(USAGE, /feedback list \[--kind bug\|feature\]/);
});

test("credits_low appends beside generic_filename instead of replacing it", async () => {
  const transport = memoryBackend();
  transport.extraResponseHeaders = { "ScreenRig-Credits-Remaining": "999" };
  const configDir = await testTemp("media-filename-credits-");
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
    const envelope = JSON.parse(result.stdout) as { ok: boolean; warnings: Array<{ code: string }> };
    assert.equal(envelope.ok, true);
    assert.ok(envelope.warnings.some((item) => item.code === "generic_filename"), result.stdout);
    assert.ok(envelope.warnings.some((item) => item.code === "credits_low"), result.stdout);
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

test("comment show, set, and delete bind word commands to /api/v1/comment routes", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("comment-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const commentsFile = path.join(configDir, "comments.json");
  await writeFile(commentsFile, '{"slot":"hero"}');
  const playlistFile = path.join(configDir, "playlist.json");
  await writeFile(playlistFile, JSON.stringify({
    name: "Lobby",
    pages: [{
      id: "poster",
      canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
      transition: { type: "crossfade", duration_ms: 200 },
      advance: { mode: "duration", after_ms: 8000 },
      primitives: [{
        id: "hero",
        primitive: "iframe",
        src: "https://example.com/",
        title: "Lobby",
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "fill",
      }],
    }],
  }));
  try {
    const paired = await withRuntime(["--json", "screen", "pair", "ABC234"], transport, { fs: fsLike });
    assert.equal(paired.code, ExitCode.Success, paired.stdout);
    const screenId = "scr_PAIRINGAAAAAAAAAAAAAAAA";
    const created = await withRuntime(["--json", "playlist", "create", playlistFile], transport, { fs: fsLike, cwd: () => configDir });
    assert.equal(created.code, ExitCode.Success, created.stdout);
    const playlistId = "pl_AAAAAAAAAAAAAAAAAAAAAAAA";

    const unset = await withRuntime(["--json", "comment", "show", "screen", screenId], transport, { fs: fsLike });
    assert.equal(unset.code, ExitCode.Success, unset.stdout);
    assert.deepEqual(JSON.parse(unset.stdout).data, { comments: null });
    assert.equal(transport.calls.at(-1)?.path, `/api/v1/comment/screen/${screenId}`);
    assert.equal(transport.calls.at(-1)?.method, "GET");

    const setScreen = await withRuntime(
      ["--json", "comment", "set", "screen", screenId, "--json-value", '{"note":"lobby"}'],
      transport,
      { fs: fsLike },
    );
    assert.equal(setScreen.code, ExitCode.Success, setScreen.stdout);
    const setCall = transport.calls.at(-1);
    assert.equal(setCall?.method, "PUT");
    assert.equal(setCall?.path, `/api/v1/comment/screen/${screenId}`);
    assert.ok(setCall?.headers?.["idempotency-key"], "comment set must carry Idempotency-Key");
    assert.equal(setCall?.headers?.["if-match"], undefined);
    assert.deepEqual(setCall?.body, { comments: { note: "lobby" } });
    assert.deepEqual(JSON.parse(setScreen.stdout).data, { comments: { note: "lobby" } });

    const shownScreen = await withRuntime(["--json", "screen", "show", screenId], transport, { fs: fsLike });
    assert.equal(shownScreen.code, ExitCode.Success, shownScreen.stdout);
    assert.deepEqual(JSON.parse(shownScreen.stdout).data.comments, { note: "lobby" });
    const revisionAfterComments = JSON.parse(shownScreen.stdout).data.revision;

    const shownComments = await withRuntime(["--json", "comment", "show", "screen", screenId], transport, { fs: fsLike });
    assert.deepEqual(JSON.parse(shownComments.stdout).data, { comments: { note: "lobby" } });

    const setPlaylist = await withRuntime(
      ["--json", "comment", "set", "playlist", playlistId, "--file", "comments.json"],
      transport,
      { fs: fsLike, cwd: () => configDir },
    );
    assert.equal(setPlaylist.code, ExitCode.Success, setPlaylist.stdout);
    assert.equal(transport.calls.at(-1)?.path, `/api/v1/comment/playlist/${playlistId}`);
    assert.deepEqual(transport.calls.at(-1)?.body, { comments: { slot: "hero" } });

    const setPage = await withRuntime(
      ["--json", "comment", "set", "playlist", playlistId, "--page", "poster", "--json-value", '{"why":"hero"}'],
      transport,
      { fs: fsLike },
    );
    assert.equal(setPage.code, ExitCode.Success, setPage.stdout);
    assert.equal(transport.calls.at(-1)?.path, `/api/v1/comment/playlist/${playlistId}/page/poster`);
    assert.deepEqual(JSON.parse(setPage.stdout).data, { comments: { why: "hero" } });

    const shownPlaylist = await withRuntime(["--json", "playlist", "show", playlistId], transport, { fs: fsLike });
    assert.equal(shownPlaylist.code, ExitCode.Success, shownPlaylist.stdout);
    const playlistBody = JSON.parse(shownPlaylist.stdout).data as {
      comments?: unknown;
      pages?: Array<{ comments?: unknown }>;
      revision?: number;
    };
    assert.deepEqual(playlistBody.comments, { slot: "hero" });
    assert.deepEqual(playlistBody.pages?.[0]?.comments, { why: "hero" });
    assert.equal(playlistBody.revision, 1);

    const deleted = await withRuntime(["--json", "comment", "delete", "screen", screenId], transport, { fs: fsLike });
    assert.equal(deleted.code, ExitCode.Success, deleted.stdout);
    assert.equal(transport.calls.at(-1)?.method, "DELETE");
    assert.ok(transport.calls.at(-1)?.headers?.["idempotency-key"], "comment delete must carry Idempotency-Key");
    const afterDelete = await withRuntime(["--json", "comment", "show", "screen", screenId], transport, { fs: fsLike });
    assert.deepEqual(JSON.parse(afterDelete.stdout).data, { comments: null });
    const screenAfterDelete = await withRuntime(["--json", "screen", "show", screenId], transport, { fs: fsLike });
    assert.equal(JSON.parse(screenAfterDelete.stdout).data.comments, undefined);
    assert.equal(JSON.parse(screenAfterDelete.stdout).data.revision, revisionAfterComments);

    const pageDelete = await withRuntime(
      ["--json", "comment", "delete", "playlist", playlistId, "--page", "poster"],
      transport,
      { fs: fsLike },
    );
    assert.equal(pageDelete.code, ExitCode.Success, pageDelete.stdout);
    assert.equal(transport.calls.at(-1)?.path, `/api/v1/comment/playlist/${playlistId}/page/poster`);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("comment set rejects non-objects, oversize payloads, and last-write-wins flags before calling the server", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("comment-usage-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  const commentCalls = () => transport.calls.filter((call) => String(call.path).startsWith("/api/v1/comment/"));
  try {
    await withRuntime(["--json", "screen", "pair", "ABC234"], transport, { fs: fsLike });
    const cases: Array<[string[], RegExp]> = [
      [["comment", "set", "screen"], /requires <id>/],
      [["comment", "show", "device", "scr_PAIRINGAAAAAAAAAAAAAAAA"], /screen <id> or playlist <id>/],
      [["comment", "set", "screen", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--json-value", "[]"], /JSON object/],
      [["comment", "set", "screen", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--json-value", '{"note":"x"}', "--file", "x.json"], /exactly one of --json-value or --file/],
      [["comment", "set", "screen", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--value-base64", "e30="], /--json-value or --file/],
      [["comment", "set", "screen", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--json-value", '{"note":"x"}', "--if-match", "1"], /do not take --if-match/],
      [["comment", "set", "screen", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--page", "poster", "--json-value", '{"note":"x"}'], /do not take --page/],
      [["comment", "show", "playlist", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--page", "1poster"], /playlist page id/],
      [["comment", "set", "screen", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--json-value", `{"x":"${"a".repeat(1017)}"}`], /1024 bytes/],
    ];
    for (const [argv, detail] of cases) {
      const result = await withRuntime(["--json", ...argv], transport, { fs: fsLike });
      assert.equal(result.code, ExitCode.Usage, result.stdout);
      assert.match(JSON.parse(result.stdout).error.detail as string, detail);
    }
    assert.equal(commentCalls().length, 0, "invalid comment commands must not reach the server");
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

test("screen toast defaults omitted --level to info", async () => {
  assert.match(USAGE, /screen toast <id> --text TEXT \[--level info\] \[--duration-ms MS\]/);
  const transport = memoryBackend();
  const configDir = await testTemp("toast-default-level-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  try {
    const result = await withRuntime(
      ["--json", "screen", "toast", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--text", "Lobby closed"],
      transport,
      { fs: fsLike },
    );
    assert.equal(result.code, 0, result.stdout);
    const post = transport.calls.find((call) => call.path === "/api/v1/screens/scr_PAIRINGAAAAAAAAAAAAAAAA/toast");
    assert.ok(post, "must bind POST /api/v1/screens/{id}/toast");
    assert.deepEqual(post.body, { level: "info", text: "Lobby closed" });
    const envelope = JSON.parse(result.stdout) as { ok: boolean; data: { expires_at?: string; level?: string } };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.expires_at, "2026-08-14T17:00:10.000Z");
    assert.equal(envelope.data.level, undefined);

    const explicit = await withRuntime(
      ["--json", "screen", "toast", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--level", "error", "--text", "Offline"],
      transport,
      { fs: fsLike },
    );
    assert.equal(explicit.code, 0, explicit.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { level: "error", text: "Offline" });
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
    result = await withRuntime(["--json", "screen", "archive", paired.id, "--if-match", String(rotated.revision)], transport, runtimeExtra);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(transport.calls.at(-1)?.path, `/api/v1/screens/${paired.id}/archive`);

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

test("screen archive, unarchive, archived list, and retired unbind drive the real handlers", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("screen-archive-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fsLike,
  );
  try {
    const paired = await withRuntime(["--json", "screen", "pair", "ABC234"], transport, { fs: fsLike });
    assert.equal(paired.code, 0, paired.stdout);
    const screen = (JSON.parse(paired.stdout) as { data: { screen: { id: string; revision: number } } }).data.screen;

    const listed = await withRuntime(["--json", "screen", "list"], transport, { fs: fsLike });
    assert.equal(listed.code, 0, listed.stdout);
    const listCall = transport.calls.find((call) => call.method === "GET" && call.path === "/api/v1/screens");
    assert.equal(listCall?.query?.state, undefined);
    assert.deepEqual(
      ((JSON.parse(listed.stdout) as { data: { items: Array<{ id: string; state: string }> } }).data.items).map((item) => item.id),
      [screen.id],
    );

    const archived = await withRuntime(
      ["--json", "screen", "archive", screen.id, "--if-match", String(screen.revision)],
      transport,
      { fs: fsLike },
    );
    assert.equal(archived.code, 0, archived.stdout);
    const archiveCall = transport.calls.at(-1);
    assert.equal(archiveCall?.method, "POST");
    assert.equal(archiveCall?.path, `/api/v1/screens/${screen.id}/archive`);
    assert.equal(archiveCall?.headers?.["if-match"], `"${screen.revision}"`);
    assert.ok(archiveCall?.headers?.["idempotency-key"]);
    const archivedScreen = (JSON.parse(archived.stdout) as { data: { state: string; revision: number } }).data;
    assert.equal(archivedScreen.state, "archived");

    const omitted = await withRuntime(["--json", "screen", "list"], transport, { fs: fsLike });
    assert.equal(omitted.code, 0, omitted.stdout);
    assert.deepEqual((JSON.parse(omitted.stdout) as { data: { items: unknown[] } }).data.items, []);

    const archivedOnly = await withRuntime(["--json", "screen", "list", "--state", "archived"], transport, { fs: fsLike });
    assert.equal(archivedOnly.code, 0, archivedOnly.stdout);
    const archivedListCall = [...transport.calls].reverse().find((call) => call.method === "GET" && call.path === "/api/v1/screens");
    assert.deepEqual(archivedListCall?.query, { state: "archived" });
    const archivedItems = (JSON.parse(archivedOnly.stdout) as { data: { items: Array<{ id: string; state: string }> } }).data.items;
    assert.equal(archivedItems.length, 1);
    assert.equal(archivedItems[0]?.id, screen.id);
    assert.equal(archivedItems[0]?.state, "archived");

    const shown = await withRuntime(["--json", "screen", "show", screen.id], transport, { fs: fsLike });
    assert.equal(shown.code, 0, shown.stdout);
    assert.equal((JSON.parse(shown.stdout) as { data: { state: string } }).data.state, "archived");

    const unarchived = await withRuntime(
      ["--json", "screen", "unarchive", screen.id, "--if-match", String(archivedScreen.revision)],
      transport,
      { fs: fsLike },
    );
    assert.equal(unarchived.code, 0, unarchived.stdout);
    const unarchiveCall = transport.calls.at(-1);
    assert.equal(unarchiveCall?.method, "POST");
    assert.equal(unarchiveCall?.path, `/api/v1/screens/${screen.id}/unarchive`);
    assert.equal(unarchiveCall?.headers?.["if-match"], `"${archivedScreen.revision}"`);
    const restored = (JSON.parse(unarchived.stdout) as { data: { state: string; revision: number } }).data;
    assert.equal(restored.state, "active");

    const restoredList = await withRuntime(["--json", "screen", "list"], transport, { fs: fsLike });
    assert.equal(restoredList.code, 0, restoredList.stdout);
    assert.deepEqual(
      ((JSON.parse(restoredList.stdout) as { data: { items: Array<{ id: string }> } }).data.items).map((item) => item.id),
      [screen.id],
    );

    const callsBeforeDelete = transport.calls.length;
    const deleted = await withRuntime(
      ["--json", "screen", "delete", screen.id, "--if-match", String(restored.revision)],
      transport,
      { fs: fsLike },
    );
    assert.equal(deleted.code, ExitCode.Conflict, deleted.stdout);
    const deleteCall = transport.calls.at(-1);
    assert.equal(deleteCall?.method, "DELETE");
    assert.equal(deleteCall?.path, `/api/v1/screens/${screen.id}`);
    assert.equal(deleteCall?.headers?.["if-match"], `"${restored.revision}"`);
    const deleteEnvelope = JSON.parse(deleted.stdout) as { ok: false; error: { code: string; status: number } };
    assert.equal(deleteEnvelope.error.code, "screen_archive_required");
    assert.equal(deleteEnvelope.error.status, 409);

    const stillThere = await withRuntime(["--json", "screen", "show", screen.id], transport, { fs: fsLike });
    assert.equal(stillThere.code, 0, stillThere.stdout);
    assert.equal((JSON.parse(stillThere.stdout) as { data: { id: string; state: string } }).data.id, screen.id);

    const callsBeforeRevoke = transport.calls.length;
    const revoked = await withRuntime(
      ["--json", "screen", "revoke-credential", screen.id, "--if-match", String(restored.revision)],
      transport,
      { fs: fsLike },
    );
    assert.equal(revoked.code, ExitCode.Usage, revoked.stdout);
    assert.equal(transport.calls.length, callsBeforeRevoke);
    assert.equal(transport.calls.length, callsBeforeDelete + 2, "delete and show reach the server; revoke-credential does not");
    const revokeEnvelope = JSON.parse(revoked.stdout) as {
      error: { code: string; detail: string; next?: { command: string; reason: string } };
    };
    assert.equal(revokeEnvelope.error.code, "usage_error");
    assert.match(revokeEnvelope.error.detail, /retired/);
    assert.match(revokeEnvelope.error.next?.command ?? "", /screen archive/);
    assert.equal(
      transport.calls.some((call) => String(call.path).includes("/credential/revoke")),
      false,
    );

    const badState = await withRuntime(["--json", "screen", "list", "--state", "active"], transport, { fs: fsLike });
    assert.equal(badState.code, ExitCode.Usage, badState.stdout);
    assert.equal((JSON.parse(badState.stdout) as { error: { code: string } }).error.code, "usage_error");
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
    advance: { mode: "duration", after_ms: 8000 },
    ...(visibility ? { visibility } : {}),
    primitives: [
      {
        id: "poster",
        primitive: "image",
        selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" },
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
    advance: { mode: "duration", after_ms: 8000 },
    primitives: [
      {
        id: "poster",
        primitive: "image",
        selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" },
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

const SAMPLE_OBSERVATION = {
  observed_at: "2026-08-19T12:00:00Z",
  surfaces: [
    {
      id: "primary",
      width: 1920,
      height: 1080,
      pixel_ratio: 2,
      presentation: "output" as const,
    },
  ],
};

test("screen show prints optional player-reported observation", async () => {
  const transport = new FakeTransport();
  const screen = {
    content_access_generation: 1,
    created_at: "2026-08-14T17:00:00.000Z",
    id: "scr_PAIRINGAAAAAAAAAAAAAAAA",
    label: "Lobby",
    manifest_revision: 1,
    observation: SAMPLE_OBSERVATION,
    public_id: "scr_public_pairing",
    revision: 1,
    state: "active" as const,
    updated_at: "2026-08-14T17:00:00.000Z",
  };
  transport.on("GET", "/api/v1/screens/scr_PAIRINGAAAAAAAAAAAAAAAA", () => ({
    status: 200,
    headers: { "x-request-id": "req_show_observation" },
    body: screen,
  }));
  const configDir = await testTemp("screen-show-observation-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );

  const jsonResult = await withRuntime(
    ["--json", "screen", "show", "scr_PAIRINGAAAAAAAAAAAAAAAA"],
    transport,
    { fs: fsLike },
  );
  assert.equal(jsonResult.code, ExitCode.Success, jsonResult.stdout);
  const envelope = JSON.parse(jsonResult.stdout) as { ok: boolean; data: { observation?: unknown } };
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.observation, SAMPLE_OBSERVATION);

  const humanResult = await withRuntime(
    ["screen", "show", "scr_PAIRINGAAAAAAAAAAAAAAAA"],
    transport,
    { fs: fsLike },
  );
  assert.equal(humanResult.code, ExitCode.Success, humanResult.stdout);
  assert.match(humanResult.stdout, /^Screen\n/);
  assert.match(humanResult.stdout, /"observed_at": "2026-08-19T12:00:00Z"/);
  assert.match(humanResult.stdout, /"presentation": "output"/);
  assert.equal(transport.calls.some((call) => call.path === "/runtime/v1/observation"), false);
  await rm(configDir, { recursive: true, force: true });
});

test("screen show still works when observation is absent", async () => {
  const transport = memoryBackend();
  const { code, configDir } = await withAuthenticatedRuntime(["--json", "screen", "pair", "ABC234"], transport);
  assert.equal(code, ExitCode.Success);
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };

  const result = await withRuntime(
    ["--json", "screen", "show", "scr_PAIRINGAAAAAAAAAAAAAAAA"],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const envelope = JSON.parse(result.stdout) as { ok: boolean; data: { id: string; observation?: unknown } };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.id, "scr_PAIRINGAAAAAAAAAAAAAAAA");
  assert.equal(envelope.data.observation, undefined);
  await rm(configDir, { recursive: true, force: true });
});

test("screen update cannot send observation", async () => {
  const transport = memoryBackend();
  const { code, configDir } = await withAuthenticatedRuntime(["--json", "screen", "pair", "ABC234"], transport);
  assert.equal(code, ExitCode.Success);
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  transport.calls.length = 0;

  const result = await withRuntime(
    [
      "--json", "screen", "update", "scr_PAIRINGAAAAAAAAAAAAAAAA",
      "--name", "Lobby",
      "--if-match", "1",
      "--observation", JSON.stringify(SAMPLE_OBSERVATION),
    ],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const patch = transport.calls.find((call) => call.method === "PATCH");
  assert.equal(patch?.path, "/api/v1/screens/scr_PAIRINGAAAAAAAAAAAAAAAA");
  assert.deepEqual(patch?.body, { name: "Lobby" });
  assert.equal(JSON.stringify(patch?.body).includes("observation"), false);
  assert.equal(transport.calls.some((call) => call.path === "/runtime/v1/observation"), false);
  await rm(configDir, { recursive: true, force: true });
});

const DOCUMENTATION_IPV4 = "192.0.2.10";
const DOCUMENTATION_IPV6 = "2001:db8::1";

test("screen show includes online and optional last_online_at and last_ip", async () => {
  const transport = new FakeTransport();
  const screen = {
    content_access_generation: 1,
    created_at: "2026-08-14T17:00:00.000Z",
    id: "scr_PAIRINGAAAAAAAAAAAAAAAA",
    label: "Lobby",
    last_ip: DOCUMENTATION_IPV4,
    last_online_at: "2026-08-19T12:00:00Z",
    manifest_revision: 1,
    online: true,
    public_id: "scr_public_pairing",
    revision: 1,
    state: "active" as const,
    updated_at: "2026-08-14T17:00:00.000Z",
  };
  transport.on("GET", "/api/v1/screens/scr_PAIRINGAAAAAAAAAAAAAAAA", () => ({
    status: 200,
    headers: { "x-request-id": "req_show_online" },
    body: screen,
  }));
  const configDir = await testTemp("screen-show-online-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );

  const jsonResult = await withRuntime(
    ["--json", "screen", "show", "scr_PAIRINGAAAAAAAAAAAAAAAA"],
    transport,
    { fs: fsLike },
  );
  assert.equal(jsonResult.code, ExitCode.Success, jsonResult.stdout);
  const envelope = JSON.parse(jsonResult.stdout) as {
    ok: boolean;
    data: { online?: boolean; last_online_at?: string; last_ip?: string };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.online, true);
  assert.equal(envelope.data.last_online_at, "2026-08-19T12:00:00Z");
  assert.equal(envelope.data.last_ip, DOCUMENTATION_IPV4);

  const humanResult = await withRuntime(
    ["screen", "show", "scr_PAIRINGAAAAAAAAAAAAAAAA"],
    transport,
    { fs: fsLike },
  );
  assert.equal(humanResult.code, ExitCode.Success, humanResult.stdout);
  assert.match(humanResult.stdout, /^Screen\n/);
  assert.match(humanResult.stdout, /"online": true/);
  assert.match(humanResult.stdout, /"last_online_at": "2026-08-19T12:00:00Z"/);
  assert.match(humanResult.stdout, /"last_ip": "192.0.2.10"/);

  screen.last_ip = DOCUMENTATION_IPV6;
  const v6Result = await withRuntime(
    ["--json", "screen", "show", "scr_PAIRINGAAAAAAAAAAAAAAAA"],
    transport,
    { fs: fsLike },
  );
  assert.equal(v6Result.code, ExitCode.Success, v6Result.stdout);
  const v6Envelope = JSON.parse(v6Result.stdout) as { ok: boolean; data: { last_ip?: string } };
  assert.equal(v6Envelope.data.last_ip, DOCUMENTATION_IPV6);
  await rm(configDir, { recursive: true, force: true });
});

test("screen show still works when last_online_at and last_ip are absent", async () => {
  const transport = new FakeTransport();
  const screen = {
    content_access_generation: 1,
    created_at: "2026-08-14T17:00:00.000Z",
    id: "scr_PAIRINGAAAAAAAAAAAAAAAA",
    label: "Lobby",
    manifest_revision: 1,
    online: false,
    public_id: "scr_public_pairing",
    revision: 1,
    state: "pairing_pending" as const,
    updated_at: "2026-08-14T17:00:00.000Z",
  };
  transport.on("GET", "/api/v1/screens/scr_PAIRINGAAAAAAAAAAAAAAAA", () => ({
    status: 200,
    headers: { "x-request-id": "req_show_offline" },
    body: screen,
  }));
  const configDir = await testTemp("screen-show-offline-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );

  const result = await withRuntime(
    ["--json", "screen", "show", "scr_PAIRINGAAAAAAAAAAAAAAAA"],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const envelope = JSON.parse(result.stdout) as {
    ok: boolean;
    data: { id: string; online?: boolean; last_online_at?: string; last_ip?: string };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.id, "scr_PAIRINGAAAAAAAAAAAAAAAA");
  assert.equal(envelope.data.online, false);
  assert.equal(envelope.data.last_online_at, undefined);
  assert.equal(envelope.data.last_ip, undefined);
  assert.equal(JSON.stringify(envelope.data).includes("last_online_at"), false);
  assert.equal(JSON.stringify(envelope.data).includes("last_ip"), false);
  await rm(configDir, { recursive: true, force: true });
});

test("screen update cannot send online, last_online_at, or last_ip", async () => {
  const transport = memoryBackend();
  const { code, configDir } = await withAuthenticatedRuntime(["--json", "screen", "pair", "ABC234"], transport);
  assert.equal(code, ExitCode.Success);
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  transport.calls.length = 0;

  const result = await withRuntime(
    [
      "--json", "screen", "update", "scr_PAIRINGAAAAAAAAAAAAAAAA",
      "--name", "Lobby",
      "--if-match", "1",
      "--online", "true",
      "--last-online-at", "2026-08-19T12:00:00Z",
      "--last-ip", DOCUMENTATION_IPV4,
    ],
    transport,
    { fs: fsLike },
  );
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const patch = transport.calls.find((call) => call.method === "PATCH");
  assert.equal(patch?.path, "/api/v1/screens/scr_PAIRINGAAAAAAAAAAAAAAAA");
  assert.deepEqual(patch?.body, { name: "Lobby" });
  const patchJson = JSON.stringify(patch?.body);
  assert.equal(patchJson.includes("online"), false);
  assert.equal(patchJson.includes("last_online_at"), false);
  assert.equal(patchJson.includes("last_ip"), false);
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

test("app upload reports the release id an application primitive needs", async () => {
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

test("app update publishes to the existing application with revision and release output", async () => {
  const transport = memoryBackend();
  transport.on("POST", "/api/v1/applications/app_EXISTING/releases", (request) => {
    assert.equal(request.headers?.["if-match"], '\"7\"');
    assert.ok(request.headers?.["idempotency-key"]);
    assert.equal(request.headers?.["screenrig-application-name"], undefined);
    assert.ok(request.body instanceof Uint8Array);
    return { status: 202, headers: {}, body: { id: "app_EXISTING", release_id: "rel_NEW", operation_id: "op_NEW" } };
  });
  const configDir = await testTemp("app-update-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" }, fsLike);
  const appDir = path.join(configDir, "app");
  await mkdir(appDir);
  await writeFile(path.join(appDir, "index.html"), "<!doctype html><html><head></head><body>updated</body></html>");
  const result = await withRuntime(["--json", "app", "update", "app_EXISTING", appDir, "--if-match", "7", "--no-wait"], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(JSON.parse(result.stdout).data.id, "app_EXISTING");
  assert.equal(JSON.parse(result.stdout).data.release_id, "rel_NEW");
  const count = transport.calls.length;
  for (const flags of [[], ["--if-match", "0"], ["--if-match", "7", "--name", "changed"]]) {
    const invalid = await withRuntime(["--json", "app", "update", "app_EXISTING", appDir, ...flags], transport, { fs: fsLike });
    assert.equal(invalid.code, ExitCode.Usage, invalid.stdout);
    assert.equal(transport.calls.length, count, "invalid update does not upload or request capabilities");
  }
  await rm(configDir, { recursive: true, force: true });
});

test("playlist templates --json lists the fifteen closed ids without enrolling", async () => {
  const transport = memoryBackend();
  const { code, stdout, configDir } = await withRuntime(["--json", "playlist", "templates"], transport);
  assert.equal(code, ExitCode.Success, stdout);
  const envelope = JSON.parse(stdout) as { ok: true; data: { templates: Array<{ id: string }>; compose: { wire_primitives: string[] } } };
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
  assert.deepEqual(envelope.data.compose.wire_primitives, ["image", "video", "iframe", "application"]);
  const catalog = envelope.data as {
    templates: Array<{ id: string }>;
    compose: { wire_primitives: string[] };
    transition: { type: string; duration_ms: number };
    transition_types: string[];
    swipe_duration_ms: number;
    enter_types: string[];
  };
  assert.deepEqual(catalog.transition, { type: "crossfade", duration_ms: 200 });
  assert.deepEqual(catalog.transition_types, [
    "crossfade",
    "swipe-left",
    "swipe-right",
    "swipe-up",
    "swipe-down",
  ]);
  assert.equal(catalog.swipe_duration_ms, 600);
  assert.deepEqual(catalog.enter_types, [
    "fade-up",
    "fade-down",
    "fade-left",
    "fade-right",
    "fade-in",
    "zoom-in",
    "zoom-out",
  ]);
  assert.equal(transport.calls.length, 0);
  await rm(configDir, { recursive: true, force: true });
});

test("playlist create expands a picture template and forwards a full page unchanged", async () => {
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
    primitives: [
      {
        id: "hero",
        primitive: "image",
        selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" },
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
          id: "hero",
          template: "slide-full-bleed",
          slots: {
            picture: { primitive: "image", selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" } },
          },
        },
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
  const introPrimitives = body.pages[0]!.primitives as Array<{ id: string; primitive: string }>;
  assert.deepEqual(introPrimitives.map((primitive) => primitive.id), ["picture"]);
  assert.ok(introPrimitives.every((primitive) => primitive.primitive === "image"));
  assert.deepEqual(body.pages[1], fullPage);
  assert.deepEqual(body.pages[0]!.transition, { type: "crossfade", duration_ms: 200 });
  const heroPrimitives = body.pages[0]!.primitives as Array<Record<string, unknown>>;
  assert.ok(heroPrimitives.every((primitive) => !("enter" in primitive)));
  await rm(configDir, { recursive: true, force: true });
});

test("playlist create forwards swipe transition and object enter on a full page", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("playlist-motion-");
  const fsLike = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );
  const fullPage = {
    id: "poster",
    canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
    transition: { type: "swipe-left", duration_ms: 600 },
    advance: { mode: "duration", after_ms: 8000 },
    primitives: [
      {
        id: "hero",
        primitive: "image",
        selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" },
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "contain",
      },
      {
        id: "caption",
        primitive: "image",
        selector: { by: "id", media_id: "med_BBBBBBBBBBBBBBBBBBBBBBBB" },
        rect: { x: 80, y: 860, width: 1760, height: 160 },
        layer: 2,
        content_fit: "contain",
        enter: { type: "fade-up" },
      },
    ],
  };
  const file = path.join(configDir, "playlist.json");
  await writeFile(file, JSON.stringify({ name: "Lobby", pages: [fullPage] }));
  const result = await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const posted = transport.calls.find((call) => call.method === "POST" && call.path === "/api/v1/playlists");
  const body = posted?.body as { pages: Array<Record<string, unknown>> };
  assert.deepEqual(body.pages[0], fullPage);
  await rm(configDir, { recursive: true, force: true });
});

test("playlist create refuses a templated page that would emit text", async () => {
  const transport = memoryBackend();
  const configDir = await testTemp("playlist-text-");
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
      pages: [{ id: "intro", template: "slide-intro", slots: { title: { text: "Welcome" } } }],
    }),
  );
  const result = await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Usage, result.stdout);
  const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string; next?: { command: string } } };
  assert.equal(envelope.error.code, "usage_error");
  assert.match(envelope.error.detail, /compose render/);
  assert.equal(envelope.error.next?.command, "screenrig --json compose catalog");
  assert.equal(transport.calls.some((call) => call.method === "POST" && call.path === "/api/v1/playlists"), false);
  await rm(configDir, { recursive: true, force: true });
});

test("playlist create accepts a linear canvas.background on a picture template and a full page", async () => {
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
    canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: { ...wash, stops: wash.stops.map((stop) => ({ ...stop, color: stop.color.toUpperCase() })) } },
    transition: { type: "crossfade", duration_ms: 200 },
    advance: { mode: "duration", after_ms: 8000 },
    primitives: [
      {
        id: "hero",
        primitive: "image",
        selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" },
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
          id: "hero",
          template: "slide-full-bleed",
          canvas: { background: wash },
          slots: {
            picture: { primitive: "image", selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" } },
          },
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
    const unicodeName = "Engineering — Fleet and usage lab";
    const unicodeUpload = await withRuntime(["--json", "app", "upload", appDir, "--name", unicodeName, "--no-wait"], transport, { fs: fsLike });
    assert.equal(unicodeUpload.code, ExitCode.Success, unicodeUpload.stdout);
    const unicodeCall = transport.calls.filter((call) => call.method === "POST" && call.path === "/api/v1/applications").at(-1)!;
    assert.equal(unicodeCall.headers?.["screenrig-application-name"], undefined);
    assert.equal(decodeURIComponent(unicodeCall.headers!["screenrig-application-name*"]!.slice(7)), unicodeName);
    assert.doesNotThrow(() => new Headers(unicodeCall.headers));


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
      ["--json", "media", "list", "--tag", "lobby", "--primitive", "image"],
      transport,
      { fs: fsLike },
    );
    assert.equal(listed.code, ExitCode.Success, listed.stdout);
    const listCall = transport.calls.find((call) => call.method === "GET" && call.path === "/api/v1/media");
    assert.deepEqual(listCall?.query, { tag: "lobby", primitive: "image" });
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

    const badPrimitive = await withRuntime(
      ["--json", "media", "list", "--primitive", "iframe"],
      transport,
      { fs: fsLike },
    );
    assert.equal(badPrimitive.code, ExitCode.Usage, badPrimitive.stdout);
    assert.match(JSON.parse(badPrimitive.stdout).error.detail, /--primitive must be image or video/);

    const retiredKind = await withRuntime(
      ["--json", "media", "list", "--kind", "image"],
      transport,
      { fs: fsLike },
    );
    assert.equal(retiredKind.code, ExitCode.Usage, retiredKind.stdout);
    assert.match(JSON.parse(retiredKind.stdout).error.detail, /uses --primitive image\|video, not --kind/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("playlist create refuses a mixed template-and-primitives page before the write", async () => {
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
      pages: [{ id: "intro", template: "slide-intro", slots: { title: { text: "Welcome" } }, primitives: [] }],
    }),
  );
  const result = await withRuntime(["--json", "playlist", "create", file], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Usage, result.stdout);
  const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string } };
  assert.equal(envelope.error.code, "usage_error");
  assert.match(envelope.error.detail, /mixes template and primitives/);
  assert.equal(transport.calls.some((call) => call.method === "POST" && call.path === "/api/v1/playlists"), false);
  await rm(configDir, { recursive: true, force: true });
});
