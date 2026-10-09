import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { run } from "./main.js";
import { readConfigFile, writeConfigAtomic, type ScreenRigConfig } from "./config.js";
import { FakeTransport, fakeSessionJwt } from "./transport/fake.js";
import { testTemp } from "./test-temp.js";
import { networkError } from "./problems.js";
import { AGENT_CAPABILITIES, type ProjectContext } from "./adapters/protocol.js";
import { selectProject } from "./project-state.js";
const A = "prj_AAAAAAAAAAAAAAAAAAAAAAAA", B = "prj_BBBBBBBBBBBBBBBBBBBBBBBB", C = "prj_CCCCCCCCCCCCCCCCCCCCCCCC";
const AGENT = { id: "agt_AAAAAAAAAAAAAAAAAAAAAAAA", name: "Agent", agent_type: "cli", capabilities: [...AGENT_CAPABILITIES], state: "active" as const, authenticated_requests: 0, metered_credits: 0, created_at: "2026-10-04T12:00:00Z" };
const API = "https://api.screenrig.ai";
const SCOPE = "access:manage screens content playlists advertising reports project identity";
/** Access tokens of one sign-in: identity scope with no project, and one per project. */
function access(project?: string): string {
  return fakeSessionJwt({ sub: `agent:${AGENT.id}`, sid: "grt_PRINCIPALS", exp: 4102444800, scope: SCOPE, ...(project ? { prj: project } : {}) });
}
const IDENTITY = access(), TOKEN_A = access(A), TOKEN_B = access(B);
const REFRESH = fakeSessionJwt({ sub: `agent:${AGENT.id}`, sid: "grt_PRINCIPALS", gen: 1, exp: 4102444800 });
const GRANT = { issuer: API, client_id: "screenrig-cli", refresh_token: REFRESH, identity: true };
function context(id: string, name: string, organizationName = "Acme"): ProjectContext {
  return { project: { id, name, organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: organizationName, revision: 1, status: "active", email: "contact@example.com", email_verified: false, used_bytes: 0, reserved_bytes: 0, screen_count: 0, screen_limit: 100, content_limit_bytes: 0, credit_remaining: 0, created_at: "2026-10-04T12:00:00Z", updated_at: "2026-10-04T12:00:00Z" }, organization: { id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", name: organizationName } };
}
async function fixture(t: TestContext, config?: ScreenRigConfig) {
  const home = await testTemp("principals-cli-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const fs = { chmod, mkdir, open, rename, rm, stat, homedir: () => home, env: { XDG_CONFIG_HOME: home } };
  const configPath = path.join(home, "screenrig", "config.json");
  if (config) await writeConfigAtomic(configPath, config, fs);
  const transport = new FakeTransport();
  const invoke = async (...argv: string[]) => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    let out = "", err = "";
    stdout.on("data", chunk => { out += String(chunk); });
    stderr.on("data", chunk => { err += String(chunk); });
    const code = await run({ argv, env: fs.env, fs, homedir: fs.homedir, cwd: () => process.cwd(), stdout, stderr, transport, now: () => new Date("2026-10-04T12:00:00Z"), sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))) });
    return { code, out, err, result: JSON.parse(out) };
  };
  /** The authorization server renews a project's access token the first time a command targets it. */
  const renews = (tokens: Record<string, string>) => {
    transport.on("GET", "/.well-known/oauth-authorization-server", () => ({ status: 200, headers: { "content-type": "application/json" },
      body: { issuer: API, token_endpoint: `${API}/oauth/token`, revocation_endpoint: `${API}/oauth/revoke`, device_authorization_endpoint: `${API}/oauth/device_authorization` } }));
    transport.on("POST", "/oauth/token", req => {
      const token = tokens[new URLSearchParams(String(req.body)).get("project_id") ?? ""];
      assert.ok(token, "a renewal names a project this test expects");
      return { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: { access_token: token, token_type: "Bearer", expires_in: 900, scope: SCOPE } };
    });
  };
  return { fs, configPath, transport, invoke, renews, saved: () => readConfigFile(configPath, fs) };
}
function initial(): ScreenRigConfig {
  return { api_url: API, token: TOKEN_A, identity_token: IDENTITY, agent_id: AGENT.id, project_id: A, project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Acme", oauth: GRANT };
}

test("remote playlist preparation resolves token-only project context before screen access", async t => {
  const f = await fixture(t, { api_url: "https://api.screenrig.ai", token: TOKEN_A });
  const screenId = "scr_AAAAAAAAAAAAAAAAAAAAAAAA";
  let projectReads = 0;
  f.transport.on("GET", "/api/project", req => {
    assert.equal(req.headers?.authorization, "Bearer " + TOKEN_A);
    projectReads++;
    return { status: 200, headers: {}, body: context(A, "Screens").project };
  });
  f.transport.on("GET", `/api/screens/${screenId}`, () => {
    assert.equal(projectReads, 1);
    return { status: 200, headers: {}, body: { id: screenId, revision: 1, surface: { width: 1920, height: 1080 } } };
  });
  const output = path.join(path.dirname(f.configPath), "prepared.json");
  const result = await f.invoke("playlist", "init", "https://example.com", "--screen-id", screenId, "--name", "Lobby", "--output", output, "--target-width", "1920", "--target-height", "1080");
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(result.result.context, { project: { id: A, name: "Screens" }, organization: context(A, "Screens").organization });
  assert.equal((await f.saved())?.project_id, A);
  assert.doesNotMatch(result.out + result.err, /eyJ/);
});

test("organization administration uses explicit IDs and preserves concurrent project selection", async t => {
  const f = await fixture(t, initial());
  const id = context(A, "Screens").organization.id;
  f.transport.on("GET", "/api/organizations", req => {
    assert.equal(req.headers?.authorization, "Bearer " + IDENTITY);
    return { status: 200, headers: {}, body: { organizations: [{ id, name: "Acme", admin: true, revision: 1 }, { id: "org_BBBBBBBBBBBBBBBBBBBBBBBB", name: "Acme", admin: false, revision: 1 }] } };
  });
  assert.equal((await f.invoke("organization", "list")).result.data.organizations.length, 2);
  assert.equal((await f.saved())?.project_id, A);
  f.transport.on("PATCH", `/api/organizations/${id}`, async req => {
    assert.deepEqual(req.body, { name: "North" });
    assert.equal(req.headers?.authorization, "Bearer " + IDENTITY);
    const current = (await f.saved())!;
    current.projects = { ...(current.projects ?? {}), [B]: { project_name: "Lobby", organization_id: id, organization_name: "Acme" } };
    await writeConfigAtomic(f.configPath, selectProject(current, B), f.fs);
    return { status: 200, headers: {}, body: { id, name: "North", admin: true, revision: 2 } };
  });
  f.transport.on("GET", "/api/projects", () => ({ status: 200, headers: {}, body: { projects: [context(A, "Screens", "North"), context(B, "Lobby", "North")] } }));
  const renamed = await f.invoke("organization", "rename", id, "North");
  assert.equal(renamed.code, 0, renamed.out);
  assert.equal(renamed.result.context.organization.name, "North");
  assert.equal((await f.saved())?.project_id, B);
  assert.equal((await f.saved())?.organization_name, "North");
  assert.equal((await f.saved())?.projects?.[A]?.organization_name, "North");
  assert.doesNotMatch(renamed.out + renamed.err, /eyJ/);
});

test("enrollment binds organization and stores the sign-in without returning it", async t => {
  const f = await fixture(t);
  f.transport.on("POST", "/api/enrollments", req => {
    assert.equal((req.body as { organization: string }).organization, "Acme");
    assert.equal((req.body as { project_name?: string }).project_name, undefined);
    return { status: 201, headers: { "cache-control": "private, no-store" }, body: { project: context(A, "Screens").project, agent: AGENT, access_token: TOKEN_A, token_type: "Bearer", expires_in: 900, refresh_token: REFRESH, refresh_expires_at: 4102444800, scope: SCOPE, connection_ready: false, invitation: { id: "inv_first" }, issuance_id: "iss_first", issuance_expires_at: "2026-10-04T12:10:00Z" } };
  });
  f.transport.on("GET", "/api/project", () => ({ status: 200, headers: {}, body: context(A, "Screens").project }));
  f.transport.on("GET", "/api/agents/self", () => ({ status: 200, headers: { "cache-control": "private, no-store" }, body: { agent: AGENT, connection_ready: false } }));
  const result = await f.invoke("agent", "enroll", "--email", "contact@example.com", "--organization", "Acme");
  assert.equal(result.code, 0, result.out);
  assert.equal((await f.saved())?.identity_token, TOKEN_A);
  assert.deepEqual((await f.saved())?.oauth, { ...GRANT, refresh_expires_at: 4102444800 });
  assert.deepEqual(result.result.context, { organization: { id: context(A, "Screens").organization.id, name: "Acme" }, project: { id: A, name: "Screens" } });
  assert.doesNotMatch(result.out + result.err, /eyJ|issuance_id|contact@example.com/);
});

test("new enrollment requires organization, preserves Screens, and never infers from email", async t => {
  const f = await fixture(t);
  for (const extra of [[], ["--organization", "Acme", "--project-name", "Another project"]]) {
    const result = await f.invoke("agent", "enroll", "--email", "contact@example.com", ...extra);
    assert.equal(result.result.error.code, "usage_error");
    assert.equal(f.transport.calls.length, 0);
  }
});

test("ambiguous enrollment keeps the exact organization and rejects a changed retry", async t => {
  const f = await fixture(t);
  f.transport.on("POST", "/api/enrollments", () => { throw networkError("Interrupted response"); });
  await f.invoke("agent", "enroll", "--email", "contact@example.com", "--organization", "Acme");
  const pending = (await f.saved())!.enrollment!;
  const changed = await f.invoke("agent", "enroll", "--organization", "Other");
  assert.equal(changed.result.error.code, "config_error");
  assert.equal(f.transport.calls.length, 1);
  await f.invoke("agent", "enroll");
  assert.equal(f.transport.calls[1]?.headers?.["idempotency-key"], pending.idempotency_key);
  assert.equal((f.transport.calls[1]?.body as { organization?: string }).organization, "Acme");
});

test("project list and project use under a sign-in preserve both project retries", async t => {
  const config = initial();
  config.media_generate = { idempotency_key: "first-generation-key", request_hash: "hash" };
  const f = await fixture(t, config);
  f.renews({ [B]: TOKEN_B });
  f.transport.on("GET", "/api/projects", req => {
    assert.equal(req.headers?.authorization, "Bearer " + IDENTITY);
    return { status: 200, headers: {}, body: { projects: [context(A, "Screens"), context(B, "Lobby")] } };
  });
  const listed = await f.invoke("project", "list");
  assert.equal(listed.code, 0, listed.out);
  assert.equal((await f.saved())?.project_id, A);
  const unknown = await f.invoke("project", "use", C);
  assert.equal(unknown.code, 4, unknown.out);
  assert.equal(unknown.result.error.code, "not_found");
  assert.equal(unknown.result.error.next.command, "screenrig project list");
  const used = await f.invoke("project", "use", B);
  assert.equal(used.code, 0, used.out);
  const saved = (await f.saved())!;
  assert.equal(saved.project_id, B); assert.equal(saved.token, undefined);
  assert.deepEqual(saved.projects?.[A]?.media_generate, config.media_generate);
  assert.equal(saved.projects?.[B]?.media_generate, undefined);
  f.transport.on("GET", "/api/project", req => {
    assert.equal(req.headers?.authorization, "Bearer " + TOKEN_B);
    return { status: 200, headers: {}, body: context(B, "Lobby").project };
  });
  const shown = await f.invoke("project", "show");
  assert.equal(shown.code, 0, shown.out);
  assert.equal(shown.result.context.project.id, B);
  assert.equal((await f.saved())?.token, TOKEN_B);
  assert.doesNotMatch(listed.out + used.out + shown.out, /eyJ|identity_token/);
});

test("a captured create retry stays in A while another process selects B", async t => {
  const config = initial();
  config.projects = { [B]: { project_name: "Lobby", organization_id: config.organization_id, organization_name: "Acme" } };
  const f = await fixture(t, config);
  let count = 0, key: string | undefined;
  f.transport.on("POST", "/api/projects", async req => {
    assert.equal(req.headers?.["screenrig-project"], A);
    assert.equal(req.headers?.authorization, "Bearer " + IDENTITY);
    if (++count === 1) {
      key = req.headers?.["idempotency-key"];
      const saved = (await f.saved())!;
      await writeConfigAtomic(f.configPath, selectProject(saved, B), f.fs);
      throw networkError("Response lost after acceptance");
    }
    assert.equal(req.headers?.["idempotency-key"], key);
    return { status: 201, headers: { "cache-control": "no-store" }, body: context(C, "Menu") };
  });
  const failed = await f.invoke("project", "create", "Menu");
  assert.notEqual(failed.code, 0);
  assert.equal((await f.saved())?.project_id, B);
  assert.equal(Object.keys((await f.saved())?.projects?.[A]?.pending_writes ?? {}).length, 1);
  const retried = await f.invoke("--project-id", A, "project", "create", "Menu");
  assert.equal(retried.code, 0, retried.out);
  const saved = (await f.saved())!;
  // The new project delivers no token: the next command renews one for it.
  assert.equal(saved.project_id, C); assert.equal(saved.token, undefined);
  assert.equal(saved.projects?.[A]?.token, TOKEN_A);
  assert.equal(saved.projects?.[A]?.pending_writes, undefined);
  assert.equal(saved.projects?.[B]?.token, undefined);
  assert.equal(retried.result.context.project.id, C);
  assert.doesNotMatch(retried.out, /eyJ/);
});

test("project deletion sends only exact confirmation and never archives screens on refusal", async t => {
  const f = await fixture(t, initial());
  f.transport.on("DELETE", "/api/project", req => {
    assert.deepEqual(req.body, { name: "Screens", revision: 2 });
    return { status: 409, headers: { "content-type": "application/problem+json" }, body: { status: 409, code: "project_delete_blocked", detail: "Screens still exist" } };
  });
  const missing = await f.invoke("project", "delete", "--name", "Screens", "--revision", "2");
  assert.equal(missing.result.error.code, "usage_error"); assert.equal(f.transport.calls.length, 0);
  const refused = await f.invoke("project", "delete", "--yes", "--name", "Screens", "--revision", "2");
  assert.equal(refused.result.error.code, "project_delete_blocked");
  assert.deepEqual(f.transport.calls.map(call => [call.method, call.path]), [["DELETE", "/api/project"]]);
  assert.equal((await f.saved())?.token, TOKEN_A);
});

test("membership disconnect cleans only its captured project after another process selects B", async t => {
  const config = initial();
  config.projects = { [B]: { token: TOKEN_B, project_name: "Lobby", organization_id: config.organization_id, organization_name: "Acme", media_generate: { idempotency_key: "b-generation", request_hash: "b-hash" } } };
  const f = await fixture(t, config);
  f.transport.on("GET", "/api/agents/self", () => ({ status: 200, headers: { "cache-control": "private, no-store" }, body: { agent: AGENT, connection_ready: true } }));
  f.transport.on("POST", "/api/agents/self/disconnect", async req => {
    assert.equal(req.headers?.["screenrig-project"], A);
    await writeConfigAtomic(f.configPath, selectProject((await f.saved())!, B), f.fs);
    return { status: 204, headers: { "cache-control": "private, no-store" }, body: undefined };
  });
  const result = await f.invoke("agent", "disconnect", "--yes");
  assert.equal(result.code, 0, result.out);
  const saved = (await f.saved())!;
  assert.equal(saved.identity_token, IDENTITY); assert.equal(saved.project_id, B);
  assert.equal(saved.token, config.projects[B]?.token);
  assert.equal(saved.projects?.[A]?.token, undefined);
  assert.deepEqual(saved.projects?.[B]?.media_generate, config.projects[B]?.media_generate);
  assert.equal(result.result.context.project.id, A);
});

test("global identity revocation retains all credentials after response loss, then clears all memberships", async t => {
  const config = initial(); config.projects = { [B]: { token: TOKEN_B, project_name: "Lobby" } };
  const f = await fixture(t, config);
  let attempts = 0;
  f.transport.on("POST", "/api/agent-identity/revoke", req => {
    assert.equal(req.headers?.authorization, "Bearer " + IDENTITY);
    if (++attempts === 1) throw networkError("Response lost");
    return { status: 204, headers: { "cache-control": "private, no-store" }, body: undefined };
  });
  const refused = await f.invoke("agent", "revoke-identity");
  assert.equal(refused.result.error.code, "usage_error"); assert.equal(f.transport.calls.length, 0);
  await f.invoke("agent", "revoke-identity", "--yes");
  assert.equal((await f.saved())?.token, TOKEN_A); assert.equal((await f.saved())?.projects?.[B]?.token, TOKEN_B);
  const result = await f.invoke("agent", "revoke-identity", "--yes");
  assert.equal(result.code, 0, result.out);
  const saved = (await f.saved())!;
  assert.equal(saved.token, undefined); assert.equal(saved.identity_token, undefined); assert.equal(saved.projects?.[B]?.token, undefined);
  assert.equal(saved.oauth, undefined);
  assert.doesNotMatch(result.out, /eyJ|identity_token/);
});


test("project mutations without a stored project token renew one, reuse saved keys and refresh project names", async t => {
  const config = initial(); delete config.token;
  const f = await fixture(t, config);
  f.renews({ [A]: TOKEN_A });
  let attempts = 0, key: string | undefined;
  f.transport.on("PATCH", "/api/project", req => {
    assert.equal(req.headers?.authorization, "Bearer " + TOKEN_A);
    if (++attempts === 1) { key = req.headers?.["idempotency-key"]; throw networkError("Rename response lost"); }
    assert.equal(req.headers?.["idempotency-key"], key);
    return { status: 200, headers: {}, body: context(A, "Renamed").project };
  });
  const failed = await f.invoke("project", "rename", "Renamed");
  assert.notEqual(failed.code, 0);
  const renamed = await f.invoke("project", "rename", "Renamed");
  assert.equal(renamed.code, 0, renamed.out);
  assert.equal(renamed.result.context.project.name, "Renamed");
  assert.equal((await f.saved())?.project_name, "Renamed");
  assert.equal((await f.saved())?.pending_writes, undefined);
  f.transport.on("GET", "/api/project", () => ({ status: 200, headers: {}, body: context(A, "Renamed elsewhere").project }));
  const shown = await f.invoke("project", "show");
  assert.equal(shown.code, 0, shown.out);
  assert.equal(shown.result.context.project.name, "Renamed elsewhere");
  assert.equal((await f.saved())?.project_name, "Renamed elsewhere");
});

test("a successful rename whose response lacks the organization name reconciles context from a fresh project read", async t => {
  const f = await fixture(t, initial());
  f.transport.on("PATCH", "/api/project", () => {
    const { organization_name: _omitted, ...project } = context(A, "Renamed").project;
    return { status: 200, headers: {}, body: { ...project, revision: 3 } };
  });
  f.transport.on("GET", "/api/project", () => ({ status: 200, headers: {}, body: { ...context(A, "Renamed").project, revision: 3 } }));
  const renamed = await f.invoke("project", "rename", "Renamed");
  assert.equal(renamed.code, 0, renamed.out);
  assert.equal(renamed.result.context.project.name, "Renamed");
  assert.equal(renamed.result.context.organization.name, "Acme");
  assert.deepEqual(f.transport.calls.map(call => call.method + " " + call.path), ["PATCH /api/project", "GET /api/project"]);
  assert.equal((await f.saved())?.project_name, "Renamed");
  assert.equal((await f.saved())?.pending_writes, undefined);
});

test("a rename whose response and re-read both fail validation leaves no replayable recovery entry", async t => {
  const f = await fixture(t, initial());
  const { organization_name: _omitted, ...project } = context(A, "Renamed").project;
  f.transport.on("PATCH", "/api/project", () => ({ status: 200, headers: {}, body: project }));
  f.transport.on("GET", "/api/project", () => ({ status: 200, headers: {}, body: project }));
  const failed = await f.invoke("project", "rename", "Renamed");
  assert.equal(failed.result.error.code, "config_error");
  assert.equal(failed.result.warnings?.some((warning: { code: string }) => warning.code === "write_recovery_saved") ?? false, false);
  assert.equal((await f.saved())?.pending_writes, undefined);
});

test("identity without a current project creates in an explicit organization and survives a concurrent selection", async t => {
  const config: ScreenRigConfig = { api_url: API, identity_token: IDENTITY, agent_id: AGENT.id, oauth: GRANT,
    projects: { [B]: { project_name: "Lobby", organization_id: initial().organization_id, organization_name: "Acme" } } };
  const f = await fixture(t, config);
  const missing = await f.invoke("project", "create", "Menu");
  assert.equal(missing.result.error.code, "usage_error");
  assert.equal(f.transport.calls.length, 0);
  let attempts = 0, key: string | undefined;
  f.transport.on("POST", "/api/projects", async req => {
    assert.equal(req.headers?.authorization, "Bearer " + IDENTITY);
    assert.equal(req.headers?.["screenrig-project"], undefined);
    assert.deepEqual(req.body, { name: "Menu", organization_name: "Acme" });
    if (++attempts === 1) {
      key = req.headers?.["idempotency-key"];
      await writeConfigAtomic(f.configPath, selectProject((await f.saved())!, B), f.fs);
      throw networkError("Create response lost");
    }
    assert.equal(req.headers?.["idempotency-key"], key);
    return { status: 201, headers: { "cache-control": "no-store" }, body: context(C, "Menu") };
  });
  assert.notEqual((await f.invoke("project", "create", "Menu", "--organization", "Acme")).code, 0);
  assert.equal((await f.saved())?.project_id, B);
  const recovery = await f.invoke("recovery", "list");
  assert.equal(recovery.code, 0, recovery.out);
  assert.equal(recovery.result.data.entries[0]?.scope, "identity");
  const created = await f.invoke("project", "create", "Menu", "--organization", "Acme");
  assert.equal(created.code, 0, created.out);
  assert.equal((await f.saved())?.project_id, C);
  assert.equal((await f.saved())?.identity_writes, undefined);
  assert.equal((await f.saved())?.projects?.[B]?.project_name, "Lobby");
  assert.doesNotMatch(created.out + recovery.out, /eyJ|idempotency_key/);
});
