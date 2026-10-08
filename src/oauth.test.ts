import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { readConfigFile, writeConfigAtomic, type ConfigFs, type ScreenRigConfig } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { DeviceLogin } from "./login.js";
import { run, type CliRuntime } from "./main.js";
import { OAuthClient } from "./oauth.js";
import { OAuthSession } from "./oauth-session.js";
import { CliError, networkError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import { FetchTransport } from "./transport/http.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const API = "https://api.screenrig.ai";
const NOW = new Date("2026-08-14T17:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const PROJECT = "prj_AAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_PROJECT = "prj_BBBBBBBBBBBBBBBBBBBBBBBB";
const AGENT = "agt_AAAAAAAAAAAAAAAAAAAAAAAA";
const LEGACY_IDENTITY = `sr_live_idt_lookup_${"a".repeat(64)}`;
const LEGACY_PROJECT = "sr_live_project_private_secret";

let serial = 0;
/** A token shaped like the server's JWTs. The CLI reads its claims and never verifies it. */
function jwt(claims: Record<string, unknown>): string {
  serial += 1;
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "EdDSA", typ: "at+jwt", kid: "k1" })}.${part({ jti: `jti${serial}`, ...claims })}.${"c2lnbmF0dXJl".repeat(4)}`;
}

function access(options: { project?: string; exp?: number; scope?: string; sid?: string } = {}): string {
  return jwt({
    sub: `agent:${AGENT}`, sid: options.sid ?? "grt_AAAA", exp: options.exp ?? NOW_S + 900,
    scope: options.scope ?? "access:manage screens content playlists advertising reports project identity",
    ...(options.project === undefined ? { prj: PROJECT } : options.project ? { prj: options.project } : {}),
  });
}

function refresh(gen = 1): string {
  return jwt({ sub: `agent:${AGENT}`, sid: "grt_AAAA", gen, exp: NOW_S + 90 * 86400 });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers }, body };
}

function form(req: TransportRequest): URLSearchParams {
  return new URLSearchParams(String(req.body));
}

function oauthError(error: string, status = 400, headers: Record<string, string> = {}): TransportResponse {
  return json(status, { error, error_description: `the server said ${error}` }, headers);
}

function tokenResponse(accessToken: string, refreshToken?: string, scope = "access:manage screens content playlists advertising reports project identity"): TransportResponse {
  return json(200, {
    access_token: accessToken, token_type: "Bearer", expires_in: 900, scope,
    ...(refreshToken ? { refresh_token: refreshToken, refresh_expires_at: NOW_S + 90 * 86400 } : {}),
  });
}

function withDiscovery(transport: FakeTransport, metadata: Record<string, unknown> = {}): FakeTransport {
  return transport.on("GET", "/.well-known/oauth-authorization-server", () => json(200, {
    issuer: API,
    token_endpoint: `${API}/oauth/token`,
    revocation_endpoint: `${API}/oauth/revoke`,
    device_authorization_endpoint: `${API}/oauth/device_authorization`,
    grant_types_supported: ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code", "urn:ietf:params:oauth:grant-type:token-exchange"],
    ...metadata,
  }, { "cache-control": "public, max-age=300" }));
}

function projectBody(id = PROJECT, name = "Screens"): TransportResponse {
  return json(200, {
    id, name, organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization",
    revision: 1, status: "active", screen_count: 0, used_bytes: 0, reserved_bytes: 0,
  });
}

interface Harness {
  dir: string;
  fs: ConfigFs;
  configPath: string;
  read(): Promise<ScreenRigConfig | undefined>;
  cli(argv: string[], transport: FakeTransport, extra?: Partial<CliRuntime>): Promise<{ code: number; stdout: string; stderr: string }>;
  session(transport: FakeTransport, sleep?: (ms: number) => Promise<void>): OAuthSession;
  done(): Promise<void>;
}

async function harness(config?: ScreenRigConfig): Promise<Harness> {
  const dir = await testTemp("oauth-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, env: { XDG_CONFIG_HOME: dir } };
  const configPath = path.join(dir, "screenrig", "config.json");
  if (config) await writeConfigAtomic(configPath, config, fs);
  const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 20)));
  return {
    dir, fs, configPath,
    read: () => readConfigFile(configPath, fs),
    async cli(argv, transport, extra) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
      stdout.on("data", (chunk) => chunks.out.push(Buffer.from(chunk)));
      stderr.on("data", (chunk) => chunks.err.push(Buffer.from(chunk)));
      const code = await run({
        argv, env: fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined, homedir: () => dir,
        cwd: () => process.cwd(), fs, transport, ...extra,
      });
      return { code, stdout: Buffer.concat(chunks.out).toString("utf8"), stderr: Buffer.concat(chunks.err).toString("utf8") };
    },
    session: (transport, sleep = realSleep) => new OAuthSession(configPath, API, transport, { fs, now: () => NOW, sleep }),
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

function grantConfig(overrides: Partial<ScreenRigConfig> = {}, token = access({ exp: NOW_S - 10 })): ScreenRigConfig {
  return {
    api_url: API, project_id: PROJECT, project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization",
    token, identity_token: token, agent_id: AGENT,
    oauth: { issuer: API, client_id: "screenrig-cli", refresh_token: refresh(1), refresh_expires_at: NOW_S + 90 * 86400, identity: true },
    ...overrides,
  };
}

test("two CLI processes renewing one expired token rotate the family once", async () => {
  const h = await harness(grantConfig());
  const renewed = access();
  const next = refresh(2);
  let rotations = 0;
  const transport = withDiscovery(new FakeTransport()).on("POST", "/oauth/token", async (req) => {
    rotations += 1;
    assert.equal(form(req).get("grant_type"), "refresh_token");
    assert.equal(form(req).get("project_id"), PROJECT);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return tokenResponse(renewed, next);
  });
  try {
    const [first, second] = await Promise.all([h.session(transport).accessFor(PROJECT), h.session(transport).accessFor(PROJECT)]);
    assert.equal(rotations, 1);
    assert.equal(first, renewed);
    assert.equal(second, renewed);
    const stored = await h.read();
    assert.equal(stored?.oauth?.refresh_token, next);
    assert.equal(stored?.oauth?.refresh_request, undefined);
    assert.equal(stored?.token, renewed);
    assert.equal(stored?.identity_token, renewed);
  } finally {
    await h.done();
  }
});

test("credentials and the pending request_id are kept on 5xx, 429 and network errors, and a retry replays the request_id", async () => {
  const original = grantConfig();
  const h = await harness(original);
  const answers: Array<() => TransportResponse> = [
    () => oauthError("temporarily_unavailable", 503),
    () => oauthError("rate_limited", 429, { "retry-after": "30" }),
    () => { throw networkError("fetch failed (ECONNRESET)"); },
    () => tokenResponse(access(), refresh(2)),
  ];
  const ids: string[] = [];
  const transport = withDiscovery(new FakeTransport()).on("POST", "/oauth/token", (req) => {
    ids.push(form(req).get("request_id") ?? "");
    return answers.shift()!();
  });
  try {
    for (const [code, exit] of [["service_unavailable", ExitCode.Server], ["rate_limited", ExitCode.RateLimited], ["transport_error", ExitCode.Network]] as const) {
      await assert.rejects(h.session(transport).accessFor(PROJECT), (err: CliError) => err.problem.code === code && err.exitCode === exit);
      const kept = await h.read();
      assert.equal(kept?.oauth?.refresh_token, original.oauth?.refresh_token);
      assert.equal(kept?.token, original.token);
      assert.ok(kept?.oauth?.refresh_request?.request_id);
    }
    assert.ok(await h.session(transport).accessFor(PROJECT));
    assert.equal(ids.length, 4);
    assert.ok(ids[0]!.length >= 43);
    assert.deepEqual(new Set(ids).size, 1, "every retry within 60 s reuses the request_id");
  } finally {
    await h.done();
  }
});

test("invalid_grant ends the session, removes its credentials and names screenrig login", async () => {
  const h = await harness(grantConfig());
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/token", () => oauthError("invalid_grant"))
    .on("GET", "/api/project", () => projectBody());
  try {
    const result = await h.cli(["--json", "project", "show"], transport);
    assert.equal(result.code, ExitCode.Auth);
    const error = (JSON.parse(result.stdout) as { error: { code: string; next?: { command: string } } }).error;
    assert.equal(error.code, "session_ended");
    assert.equal(error.next?.command, "screenrig login");
    const stored = await h.read();
    assert.equal(stored?.oauth, undefined);
    assert.equal(stored?.token, undefined);
    assert.equal(stored?.identity_token, undefined);
    assert.ok(stored?.signed_out_at);
    assert.equal(transport.calls.length, 0, "nothing reached /api");
    const after = await h.cli(["--json", "project", "show"], transport);
    assert.equal(after.code, ExitCode.Auth);
    assert.equal((JSON.parse(after.stdout) as { error: { next?: { command: string } } }).error.next?.command, "screenrig login");
  } finally {
    await h.done();
  }
});

test("discovery issuer and endpoint mismatches send nothing", async () => {
  for (const metadata of [
    { issuer: "https://api.elsewhere.example" },
    { token_endpoint: "https://api.elsewhere.example/oauth/token" },
    { token_endpoint: "http://api.screenrig.ai/oauth/token" },
    { revocation_endpoint: "https://evil.example/oauth/revoke" },
  ]) {
    const transport = withDiscovery(new FakeTransport(), metadata).on("POST", "/oauth/token", () => tokenResponse(access(), refresh(2)));
    await assert.rejects(new OAuthClient(API, transport).refresh(refresh(1), { requestId: "r".repeat(43) }),
      (err: CliError) => err.problem.code === "oauth_unavailable");
    assert.deepEqual(transport.oauthCalls.map((call) => call.method), ["GET"], JSON.stringify(metadata));
  }
});

test("a redirect from the token endpoint is refused and nothing is sent onward", async () => {
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/token", () => ({ status: 307, headers: { location: "https://evil.example/oauth/token" }, body: "" }));
  await assert.rejects(new OAuthClient(API, transport).refresh(refresh(1), { requestId: "r".repeat(43) }),
    (err: CliError) => err.problem.code === "credential_redirect_refused");
  assert.equal(transport.oauthCalls.filter((call) => call.path === "/oauth/token").length, 1);

  const seen: Array<{ url: string; redirect?: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, redirect: init?.redirect });
    return new Response(null, { status: 307, headers: { location: "https://evil.example/oauth/token" } });
  }) as typeof fetch;
  await assert.rejects(new FetchTransport(API, undefined, fetchImpl).request({
    method: "POST", path: "/oauth/token", body: "grant_type=refresh_token", credential: true,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }), (err: CliError) => err.problem.code === "credential_redirect_refused");
  await assert.rejects(new FetchTransport(API, "bearer-token", fetchImpl).request({ method: "GET", path: "/api/project" }),
    (err: CliError) => err.problem.code === "credential_redirect_refused");
  assert.deepEqual(seen, [
    { url: `${API}/oauth/token`, redirect: "manual" },
    { url: `${API}/api/project`, redirect: "manual" },
  ]);
});

test("every OAuth error code maps to its CLI problem and exit code", async () => {
  const rows: Array<[string, number, string, number]> = [
    ["invalid_grant", 400, "session_ended", ExitCode.Auth],
    ["invalid_client", 401, "client_auth_failed", ExitCode.Auth],
    ["invalid_request", 400, "invalid_request", ExitCode.Client],
    ["invalid_scope", 400, "insufficient_access", ExitCode.Auth],
    ["invalid_target", 400, "invalid_request", ExitCode.Client],
    ["unauthorized_client", 400, "client_not_allowed", ExitCode.Auth],
    ["access_denied", 400, "login_denied", ExitCode.Auth],
    ["expired_token", 400, "login_expired", ExitCode.Timeout],
    ["unsupported_token_type", 400, "credential_retired", ExitCode.Auth],
    ["temporarily_unavailable", 503, "service_unavailable", ExitCode.Server],
    ["rate_limited", 429, "rate_limited", ExitCode.RateLimited],
  ];
  for (const [error, status, code, exit] of rows) {
    const transport = withDiscovery(new FakeTransport()).on("POST", "/oauth/token", () => oauthError(error, status));
    await assert.rejects(new OAuthClient(API, transport).refresh(refresh(1), { requestId: "r".repeat(43) }), (err: CliError) => {
      assert.equal(err.problem.code, code, error);
      assert.equal(err.exitCode, exit, error);
      assert.equal(err.problem.status, status, error);
      return true;
    });
  }
  const pending = withDiscovery(new FakeTransport()).on("POST", "/oauth/token", () => oauthError("authorization_pending"));
  assert.deepEqual(await new OAuthClient(API, pending).pollDevice("d".repeat(43)), { status: "pending" });
  const slow = withDiscovery(new FakeTransport()).on("POST", "/oauth/token", () => oauthError("slow_down"));
  assert.deepEqual(await new OAuthClient(API, slow).pollDevice("d".repeat(43)), { status: "slow_down" });
});

test("a legacy identity credential is exchanged transparently and its secret dropped after the first JWT request", async () => {
  const h = await harness({
    api_url: API, project_id: PROJECT, project_name: "Screens", token: LEGACY_PROJECT, identity_token: LEGACY_IDENTITY, agent_id: AGENT,
  });
  const exchanged = access();
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/token", (req) => {
      const body = form(req);
      assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
      assert.equal(body.get("subject_token"), LEGACY_IDENTITY);
      assert.equal(body.get("subject_token_type"), "urn:screenrig:token-type:identity-credential");
      assert.equal(body.get("client_id"), "screenrig-cli");
      assert.ok((body.get("request_id") ?? "").length >= 16);
      assert.ok(body.get("client_version"));
      assert.equal(body.get("scope"), null);
      return { ...tokenResponse(exchanged, refresh(1)), body: { ...(tokenResponse(exchanged, refresh(1)).body as object), issued_token_type: "urn:ietf:params:oauth:token-type:access_token" } };
    })
    .on("GET", "/api/project", (req) => {
      assert.equal(req.headers?.authorization, `Bearer ${exchanged}`);
      return projectBody();
    });
  try {
    const result = await h.cli(["--json", "project", "show"], transport);
    assert.equal(result.code, 0, result.stdout);
    assert.ok(!result.stdout.includes(exchanged) && !result.stdout.includes(LEGACY_IDENTITY) && !result.stdout.includes("eyJ"));
    const stored = await h.read();
    assert.equal(stored?.token, exchanged);
    assert.equal(stored?.identity_token, exchanged);
    assert.ok(stored?.oauth?.refresh_token);
    assert.equal(stored?.oauth?.identity, true);
    assert.equal(stored?.oauth?.legacy, undefined, "the legacy secret is gone after a JWT request succeeded");
    assert.equal(stored?.oauth_exchange, undefined);
    assert.equal(JSON.stringify(stored).includes("sr_live_"), false);
  } finally {
    await h.done();
  }
});

test("an exchange retry reuses its request_id, and the legacy credential keeps working meanwhile", async () => {
  const h = await harness({ api_url: API, project_id: PROJECT, project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: LEGACY_PROJECT });
  const ids: string[] = [];
  const scopes: Array<string | null> = [];
  let attempt = 0;
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/token", (req) => {
      ids.push(form(req).get("request_id") ?? "");
      scopes.push(form(req).get("scope"));
      attempt += 1;
      if (attempt === 1) throw networkError("fetch failed (ECONNRESET)");
      if (attempt === 2) return oauthError("invalid_scope");
      return tokenResponse(access({ scope: "access:manage screens" }), refresh(1), "access:manage screens");
    })
    .on("GET", "/api/project", () => projectBody());
  try {
    const first = await h.cli(["--json", "project", "show"], transport);
    assert.equal(first.code, 0, first.stdout);
    assert.equal(transport.calls[0]?.headers?.authorization, `Bearer ${LEGACY_PROJECT}`);
    assert.ok((await h.read())?.oauth_exchange?.request_id);
    const second = await h.cli(["--json", "project", "show"], transport);
    assert.equal(second.code, 0, second.stdout);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 1);
    // A project token asks for identity, and without the project capability stays confined to its project.
    assert.deepEqual(scopes, ["identity", "identity", null]);
    const stored = await h.read();
    assert.equal(stored?.oauth?.identity, false);
    assert.equal(stored?.identity_token, undefined);
    assert.ok(stored?.token?.startsWith("eyJ"));
  } finally {
    await h.done();
  }
});

test("a server that issues no tokens leaves the legacy credential in use and is not asked again for an hour", async () => {
  const h = await harness({ api_url: API, project_id: PROJECT, project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: LEGACY_PROJECT, identity_token: LEGACY_IDENTITY });
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/token", () => oauthError("temporarily_unavailable", 503))
    .on("GET", "/api/project", (req) => {
      assert.equal(req.headers?.authorization, `Bearer ${LEGACY_PROJECT}`);
      return projectBody();
    });
  try {
    assert.equal((await h.cli(["--json", "project", "show"], transport)).code, 0);
    const stored = await h.read();
    assert.equal(stored?.token, LEGACY_PROJECT);
    assert.equal(stored?.oauth, undefined);
    assert.equal(stored?.oauth_unavailable_until, "2026-08-14T18:00:00.000Z");
    const before = transport.oauthCalls.length;
    assert.equal((await h.cli(["--json", "project", "show"], transport)).code, 0);
    assert.equal(transport.oauthCalls.length, before);
  } finally {
    await h.done();
  }
});

test("enroll stores the oauth response shape as a grant", async () => {
  const h = await harness();
  const pair = { access: access(), refresh: refresh(1) };
  const transport = new FakeTransport()
    .on("POST", "/api/enrollments", (req) => {
      assert.equal((req.body as { credential_format?: string }).credential_format, "oauth");
      return json(201, {
        project: { id: PROJECT, name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Lobby" },
        invitation: { id: "inv_AAAAAAAAAAAAAAAAAAAAAAAA", delivery: "queued" },
        agent: { id: AGENT, name: "ScreenRig CLI", agent_type: "cli", capabilities: ["screens", "content", "playlists", "advertising", "reports", "project"], state: "active", authenticated_requests: 0, metered_credits: 0, created_at: NOW.toISOString(), connected_at: NOW.toISOString() },
        connection_ready: false, issuance_id: "iss_AAAA", issuance_expires_at: "2026-08-14T17:10:00.000Z",
        access_token: pair.access, token_type: "Bearer", expires_in: 900, refresh_token: pair.refresh,
        refresh_expires_at: NOW_S + 90 * 86400, scope: "access:manage screens content playlists advertising reports project identity",
      }, { "cache-control": "private, no-store" });
    })
    .on("GET", "/api/project", (req) => {
      assert.equal(req.headers?.authorization, `Bearer ${pair.access}`);
      return { ...projectBody(), headers: { "content-type": "application/json", "cache-control": "private, no-store" } };
    })
    .on("GET", "/api/agents/self", () => json(200, {
      agent: { id: AGENT, name: "ScreenRig CLI", agent_type: "cli", capabilities: ["screens", "content", "playlists", "advertising", "reports", "project"], state: "active", authenticated_requests: 1, metered_credits: 0, created_at: NOW.toISOString(), connected_at: NOW.toISOString() },
      connection_ready: false,
    }, { "cache-control": "private, no-store" }));
  try {
    const result = await h.cli(["--json", "agent", "enroll", "--email", "owner@example.com", "--organization", "Lobby"], transport);
    assert.equal(result.code, 0, result.stdout);
    assert.ok(!result.stdout.includes("eyJ"));
    const stored = await h.read();
    assert.equal(stored?.token, pair.access);
    assert.equal(stored?.identity_token, pair.access);
    assert.equal(stored?.oauth?.refresh_token, pair.refresh);
    assert.equal(stored?.oauth?.issuer, API);
    assert.equal(stored?.enrollment, undefined);
  } finally {
    await h.done();
  }
});

test("a 401 invalid_token renews the access token once and retries once; a second refusal ends the session", async () => {
  const live = access();
  const h = await harness(grantConfig({}, live));
  let renewed = access();
  let rotations = 0;
  let refusals = 1;
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/token", () => {
      rotations += 1;
      if (rotations > 1) renewed = access();
      return tokenResponse(renewed, refresh(rotations + 1));
    })
    .on("GET", "/api/project", (req) => {
      if (refusals > 0) {
        refusals -= 1;
        return { status: 401, headers: { "content-type": "application/problem+json", "www-authenticate": 'Bearer error="invalid_token"' }, body: { status: 401, code: "unauthorized", title: "Unauthorized", detail: "The access token is expired, revoked or not valid here." } };
      }
      assert.equal(req.headers?.authorization, `Bearer ${renewed}`);
      return projectBody();
    });
  try {
    const ok = await h.cli(["--json", "project", "show"], transport);
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(rotations, 1);
    assert.deepEqual(transport.calls.map((call) => call.headers?.authorization), [`Bearer ${live}`, `Bearer ${renewed}`]);
    refusals = 2;
    const ended = await h.cli(["--json", "project", "show"], transport);
    assert.equal(ended.code, ExitCode.Auth);
    assert.equal((JSON.parse(ended.stdout) as { error: { code: string } }).error.code, "session_ended");
    assert.equal(rotations, 2);
  } finally {
    await h.done();
  }
});

test("logout revokes the refresh token, removes the session, and the next call exits 3", async () => {
  const config = grantConfig({}, access());
  const h = await harness(config);
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/revoke", (req) => {
      assert.equal(form(req).get("token"), config.oauth?.refresh_token);
      assert.equal(form(req).get("client_id"), "screenrig-cli");
      return { status: 200, headers: {}, body: undefined };
    })
    .on("GET", "/api/project", () => projectBody());
  try {
    const out = await h.cli(["--json", "logout"], transport);
    assert.equal(out.code, 0, out.stdout);
    assert.equal((JSON.parse(out.stdout) as { data: { revoked: boolean } }).data.revoked, true);
    const stored = await h.read();
    assert.equal(stored?.oauth, undefined);
    assert.equal(stored?.token, undefined);
    assert.equal(stored?.identity_token, undefined);
    const after = await h.cli(["--json", "project", "show"], transport);
    assert.equal(after.code, ExitCode.Auth);
    assert.equal(transport.calls.length, 0);
  } finally {
    await h.done();
  }
});

test("logout keeps the session when revocation may not have reached the server", async () => {
  const config = grantConfig({}, access());
  const h = await harness(config);
  const transport = withDiscovery(new FakeTransport()).on("POST", "/oauth/revoke", () => oauthError("temporarily_unavailable", 503));
  try {
    const out = await h.cli(["--json", "logout"], transport);
    assert.equal(out.code, ExitCode.Server);
    assert.equal((await h.read())?.oauth?.refresh_token, config.oauth?.refresh_token);
  } finally {
    await h.done();
  }
});

test("device login polls through pending, slow_down and network errors with backoff, outside the lock", async () => {
  const h = await harness({ api_url: API });
  const sleeps: number[] = [];
  const answers: Array<() => TransportResponse> = [
    () => oauthError("authorization_pending"),
    () => oauthError("slow_down"),
    () => { throw networkError("fetch failed (ETIMEDOUT)"); },
    () => tokenResponse(access(), refresh(1)),
  ];
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/device_authorization", (req) => {
      assert.equal(form(req).get("scope"), "access:manage");
      assert.equal(req.headers?.authorization, undefined);
      return json(200, { device_code: "D".repeat(43), user_code: "BCDF-GHJK", verification_uri: "https://screenrig.ai/dashboard/connect",
        verification_uri_complete: "https://screenrig.ai/dashboard/connect?code=BCDF-GHJK", expires_in: 600, interval: 5 });
    })
    .on("POST", "/oauth/token", async (req) => {
      assert.equal(form(req).get("device_code"), "D".repeat(43));
      await assert.rejects(stat(`${h.configPath}.lock`), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
      return answers.shift()!();
    });
  try {
    const session = h.session(transport);
    const device = new DeviceLogin(session, h.configPath, { fs: h.fs, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); } });
    const shown: string[] = [];
    const outcome = await device.run({ access: "manage", wait: true }, (login) => shown.push(login.user_code));
    assert.equal(outcome.status, "signed_in");
    assert.deepEqual(shown, ["BCDF-GHJK"]);
    assert.deepEqual(sleeps, [5000, 5000, 10000, 20000]);
    const stored = await h.read();
    assert.equal(stored?.login, undefined);
    assert.ok(stored?.oauth?.refresh_token);
    assert.equal(stored?.project_id, PROJECT);
    assert.equal(stored?.agent_id, AGENT);
  } finally {
    await h.done();
  }
});

test("login --no-wait prints a resume handle with no secret, and --resume finishes the sign-in", async () => {
  const h = await harness({ api_url: API });
  const deviceCode = "Zq9_".repeat(10) + "abc";
  let approved = false;
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/device_authorization", () => json(200, { device_code: deviceCode, user_code: "BCDF-GHJK",
      verification_uri: "https://screenrig.ai/dashboard/connect", verification_uri_complete: "https://screenrig.ai/dashboard/connect?code=BCDF-GHJK",
      expires_in: 600, interval: 5 }))
    .on("POST", "/oauth/token", () => approved ? tokenResponse(access(), refresh(1)) : oauthError("authorization_pending"))
    .on("GET", "/api/project", () => projectBody());
  try {
    const pending = await h.cli(["--json", "login", "--no-wait"], transport);
    assert.equal(pending.code, 0, pending.stdout);
    assert.ok(!pending.stdout.includes(deviceCode) && !pending.stderr.includes(deviceCode));
    const data = (JSON.parse(pending.stdout) as { data: { status: string; login_id: string; user_code: string; next: { argv: string[] } } }).data;
    assert.equal(data.status, "pending");
    assert.match(data.login_id, /^login_[A-Za-z0-9_-]{22}$/);
    assert.equal(data.user_code, "BCDF-GHJK");
    assert.deepEqual(data.next.argv, ["login", "--resume", data.login_id]);
    const info = await stat(h.configPath);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal((await h.read())?.login?.device_code, deviceCode);
    assert.equal(transport.oauthCalls.filter((call) => call.path === "/oauth/token").length, 0);

    await assert.rejects(Promise.resolve(h.cli(["--json", "login", "--resume", "login_AAAAAAAAAAAAAAAAAAAAAA"], transport)).then((r) => {
      if (r.code !== 0) throw new Error((JSON.parse(r.stdout) as { error: { code: string } }).error.code);
    }), /login_not_found/);

    approved = true;
    const done = await h.cli(["--json", "login", "--resume", data.login_id], transport);
    assert.equal(done.code, 0, done.stdout);
    const signedIn = (JSON.parse(done.stdout) as { data: { status: string; access: string; project: { id: string } } }).data;
    assert.equal(signedIn.status, "signed_in");
    assert.equal(signedIn.access, "manage");
    assert.equal(signedIn.project.id, PROJECT);
    const stored = await h.read();
    assert.equal(stored?.login, undefined);
    assert.equal(stored?.project_name, "Screens");
  } finally {
    await h.done();
  }
});

test("login from a signed-in installation extends its grant and selects the approved project", async () => {
  const live = access();
  const config = grantConfig({}, live);
  const h = await harness(config);
  const added = access({ project: OTHER_PROJECT, scope: "access:read screens identity" });
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/device_authorization", (req) => {
      assert.equal(req.headers?.authorization, `Bearer ${live}`);
      assert.equal(form(req).get("scope"), "access:read");
      assert.equal(form(req).get("project_id"), OTHER_PROJECT);
      return json(200, { device_code: "E".repeat(43), user_code: "BCDF-GHJK", verification_uri: "https://screenrig.ai/dashboard/connect",
        verification_uri_complete: "https://screenrig.ai/dashboard/connect?code=BCDF-GHJK", expires_in: 600, interval: 5 });
    })
    .on("POST", "/oauth/token", () => tokenResponse(added, undefined, "access:read screens identity"))
    .on("GET", "/api/project", () => projectBody(OTHER_PROJECT, "Lobby"));
  try {
    const result = await h.cli(["--json", "login", "--project", OTHER_PROJECT, "--access", "read"], transport);
    assert.equal(result.code, 0, result.stdout);
    assert.equal((JSON.parse(result.stdout) as { data: { access: string } }).data.access, "read");
    const stored = await h.read();
    assert.equal(stored?.project_id, OTHER_PROJECT);
    assert.equal(stored?.token, added);
    assert.equal(stored?.projects?.[PROJECT]?.token, live);
    assert.equal(stored?.oauth?.refresh_token, config.oauth?.refresh_token, "extending a grant does not rotate its family");
  } finally {
    await h.done();
  }
});

test("agent connect runs screenrig login with a warning naming it", async () => {
  const h = await harness({ api_url: API });
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/device_authorization", () => json(200, { device_code: "F".repeat(43), user_code: "BCDF-GHJK",
      verification_uri: "https://screenrig.ai/dashboard/connect", verification_uri_complete: "https://screenrig.ai/dashboard/connect?code=BCDF-GHJK",
      expires_in: 600, interval: 5 }));
  try {
    const result = await h.cli(["--json", "agent", "connect", "--capability", "screens"], transport);
    assert.equal(result.code, 0, result.stdout);
    const envelope = JSON.parse(result.stdout) as { data: { status: string }; warnings: Array<{ code: string; message: string }> };
    assert.equal(envelope.data.status, "pending");
    assert.ok(envelope.warnings.some((warning) => warning.code === "command_renamed" && warning.message.includes("screenrig login")));
    assert.ok(envelope.warnings.some((warning) => warning.code === "capability_chosen_at_approval"));
  } finally {
    await h.done();
  }
});

test("the sign-in issuer is bound apart from the API origin", async () => {
  const h = await harness(grantConfig({ oauth: { issuer: "https://api.elsewhere.example", client_id: "screenrig-cli", refresh_token: refresh(1) } }, access()));
  try {
    const result = await h.cli(["--json", "project", "show"], new FakeTransport());
    assert.equal(result.code, ExitCode.Config);
    assert.match(result.stdout, /sign-in issued by https:\/\/api\.elsewhere\.example/);
  } finally {
    await h.done();
  }
});

test("commands and doctor warn when the session ends within 30 days", async () => {
  const config = grantConfig({}, access());
  config.oauth = { ...config.oauth!, refresh_expires_at: NOW_S + 5 * 86400 };
  const h = await harness(config);
  const transport = new FakeTransport().on("GET", "/api/project", () => projectBody());
  try {
    const result = await h.cli(["--json", "project", "show"], transport);
    assert.equal(result.code, 0, result.stdout);
    const warnings = (JSON.parse(result.stdout) as { warnings: Array<{ code: string; message: string }> }).warnings;
    assert.ok(warnings.some((warning) => warning.code === "sign_in_expiring" && warning.message.includes("5 days")));
  } finally {
    await h.done();
  }
});

test("an exchanged session the API refuses before it ever worked gives way to the legacy credential", async () => {
  const h = await harness({
    api_url: API, project_id: PROJECT, project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization",
    token: LEGACY_PROJECT, identity_token: LEGACY_IDENTITY, agent_id: AGENT,
  });
  const exchanged = access();
  const granted = refresh(1);
  const revoked: string[] = [];
  const transport = withDiscovery(new FakeTransport())
    .on("POST", "/oauth/token", () => tokenResponse(exchanged, granted))
    .on("POST", "/oauth/revoke", (req) => { revoked.push(form(req).get("token") ?? ""); return { status: 200, headers: {}, body: undefined }; })
    .on("GET", "/api/project", (req) => req.headers?.authorization === `Bearer ${LEGACY_PROJECT}`
      ? projectBody()
      : { status: 401, headers: { "content-type": "application/problem+json" }, body: { status: 401, code: "unauthorized", title: "Authentication is required", detail: "Credential refused: malformed." } });
  try {
    const result = await h.cli(["--json", "project", "show"], transport);
    assert.equal(result.code, 0, result.stdout);
    const stored = await h.read();
    assert.equal(stored?.oauth, undefined);
    assert.equal(stored?.token, LEGACY_PROJECT);
    assert.equal(stored?.identity_token, LEGACY_IDENTITY);
    assert.equal(stored?.oauth_unavailable_until, "2026-08-14T18:00:00.000Z");
    assert.deepEqual(revoked, [granted], "the unused grant is revoked");
    assert.deepEqual(transport.calls.map((call) => call.headers?.authorization), [`Bearer ${exchanged}`, `Bearer ${LEGACY_PROJECT}`]);
  } finally {
    await h.done();
  }
});
