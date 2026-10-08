import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ensureCredential } from "./enrollment.js";
import { readConfigFile, resolveConfig, writeConfigAtomic, type ConfigFs, type ResolvedConfig } from "./config.js";
import { testTemp } from "./test-temp.js";
import { CliError } from "./problems.js";

function fixture(home: string): { fs: ConfigFs; resolved: ResolvedConfig } {
  const fs = {
    mkdir,
    open,
    rename,
    rm,
    chmod,
    stat,
    homedir: () => home,
    env: { XDG_CONFIG_HOME: home },
  };
  return {
    fs,
    resolved: {
      apiUrl: "https://api.screenrig.ai",
      configPath: path.join(home, "screenrig", "config.json"),
      source: { apiUrl: "default", token: "none" },
    },
  };
}

test("explicit enrollment atomically persists email, verifies, and completes outside the plugin", async () => {
  const home = await testTemp("enrollment-first-");
  const { fs, resolved } = fixture(home);
  let enrollments = 0;
  const result = await ensureCredential({
    resolved,
    runtime: { fs, now: () => new Date("2026-08-14T20:00:00.000Z"), sleep: async () => undefined },
    generateClientId: () => `cli_${"A".repeat(43)}`,
    generateIdempotencyKey: () => "enroll-first-idempotency",
    enrollmentEmail: "Owner@example.com",
    enrollmentProjectName: "Lobby displays",
    verify: async (token, projectId) => {
      assert.equal(token, "sr_live_enrollment_secret");
      assert.equal(projectId, "prj_enrollment");
      assert.deepEqual(await readConfigFile(resolved.configPath, fs), {
        api_url: "https://api.screenrig.ai",
        token: "sr_live_enrollment_secret",
        project_id: "prj_enrollment",
        project_name: "Lobby displays",
        enrollment: {
          client_id: `cli_${"A".repeat(43)}`,
          idempotency_key: "enroll-first-idempotency",
          credential_format: "oauth",
          email: "Owner@example.com",
          project_name: "Lobby displays",
        },
        updated_at: "2026-08-14T20:00:00.000Z",
      });
    },
    enroll: async (state) => {
      enrollments += 1;
      assert.deepEqual(state, {
        clientId: `cli_${"A".repeat(43)}`,
        idempotencyKey: "enroll-first-idempotency",
        credentialFormat: "oauth",
        email: "Owner@example.com",
        projectName: "Lobby displays",
      });
      assert.deepEqual(await readConfigFile(resolved.configPath, fs), {
        api_url: "https://api.screenrig.ai",
        enrollment: {
          client_id: `cli_${"A".repeat(43)}`,
          idempotency_key: "enroll-first-idempotency",
          credential_format: "oauth",
          email: "Owner@example.com",
          project_name: "Lobby displays",
        },
        updated_at: "2026-08-14T20:00:00.000Z",
      });
      return { token: "sr_live_enrollment_secret", projectId: "prj_enrollment", projectName: "Lobby displays" };
    },
  });
  assert.equal(enrollments, 1);
  assert.equal(result.token, "sr_live_enrollment_secret");
  assert.equal(result.source.token, "config");
  assert.equal(result.projectName, "Lobby displays");
  assert.deepEqual(await readConfigFile(resolved.configPath, fs), {
    api_url: "https://api.screenrig.ai",
    token: "sr_live_enrollment_secret",
    project_id: "prj_enrollment",
    project_name: "Lobby displays",
    updated_at: "2026-08-14T20:00:00.000Z",
  });
  await rm(home, { recursive: true, force: true });
});

test("existing credential bypasses enrollment and remains unchanged", async () => {
  const home = await testTemp("enrollment-existing-");
  const { fs, resolved } = fixture(home);
  const existing = { ...resolved, token: "sr_live_existing_secret", source: { ...resolved.source, token: "config" as const } };
  const result = await ensureCredential({
    resolved: existing,
    runtime: { fs, now: () => new Date(), sleep: async () => undefined },
    enroll: async () => { throw new Error("enrollment must not run"); },
    verify: async () => { throw new Error("verification must not run"); },
  });
  assert.equal(result, existing);
  await rm(home, { recursive: true, force: true });
});

test("concurrent explicit enrollment calls perform one enrollment and share the credential", async () => {
  const home = await testTemp("enrollment-concurrent-");
  const { fs, resolved } = fixture(home);
  let enrollments = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = {
    fs,
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const enroll = async () => {
    enrollments += 1;
    await gate;
    return { token: "sr_live_shared_secret", projectId: "prj_shared" };
  };
  const generators = {
    generateClientId: () => `cli_${"B".repeat(43)}`,
    generateIdempotencyKey: () => "enroll-shared-idempotency",
    enrollmentEmail: "owner@example.com",
  };
  const verify = async () => undefined;
  const first = ensureCredential({ resolved, runtime, enroll, verify, ...generators });
  while (enrollments === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  const second = ensureCredential({ resolved, runtime, enroll, verify, ...generators });
  release?.();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(enrollments, 1);
  assert.equal(one.token, "sr_live_shared_secret");
  assert.equal(two.token, "sr_live_shared_secret");
  await rm(home, { recursive: true, force: true });
});

test("ambiguous enrollment retries reuse the persisted client, contact email, and idempotency state", async () => {
  const home = await testTemp("enrollment-retry-");
  const { fs, resolved } = fixture(home);
  const seen: Array<{ clientId: string; idempotencyKey: string; email?: string; projectName?: string }> = [];
  const runtime = { fs, now: () => new Date(), sleep: async () => undefined };
  const generators = {
    generateClientId: () => `cli_${"C".repeat(43)}`,
    generateIdempotencyKey: () => "enroll-retry-idempotency",
  };
  await assert.rejects(
    ensureCredential({
      resolved,
      runtime,
      ...generators,
      enrollmentEmail: "owner@example.com",
      enrollmentProjectName: "Lobby displays",
      verify: async () => undefined,
      enroll: async (state) => {
        seen.push(state);
        throw new Error("ambiguous transport failure");
      },
    }),
    /ambiguous transport failure/,
  );
  const pending = await readConfigFile(resolved.configPath, fs);
  assert.deepEqual(pending?.enrollment, {
    client_id: `cli_${"C".repeat(43)}`,
    idempotency_key: "enroll-retry-idempotency",
    credential_format: "oauth",
    email: "owner@example.com",
    project_name: "Lobby displays",
  });
  await assert.rejects(ensureCredential({
    resolved,
    runtime,
    enrollmentProjectName: "Different project",
    enroll: async () => { throw new Error("must reject before sending another enrollment"); },
    verify: async () => undefined,
  }), (error: unknown) => error instanceof CliError && error.problem.code === "config_error");
  assert.deepEqual((await readConfigFile(resolved.configPath, fs))?.enrollment, pending?.enrollment);
  const result = await ensureCredential({
    resolved,
    runtime,
    generateClientId: () => { throw new Error("must reuse client id"); },
    generateIdempotencyKey: () => { throw new Error("must reuse idempotency key"); },
    enroll: async (state) => {
      seen.push(state);
      return { token: "sr_live_replayed_secret", projectId: "prj_replayed" };
    },
    verify: async () => undefined,
  });
  assert.equal(result.token, "sr_live_replayed_secret");
  assert.deepEqual(seen[0], seen[1]);
  assert.equal((await readConfigFile(resolved.configPath, fs))?.enrollment, undefined);
  await rm(home, { recursive: true, force: true });
});

test("verification failure preserves the permanent token and exact enrollment retry state", async () => {
  const home = await testTemp("enrollment-verify-retry-");
  const { fs, resolved } = fixture(home);
  const runtime = { fs, now: () => new Date("2026-08-14T20:00:00.000Z"), sleep: async () => undefined };
  await assert.rejects(ensureCredential({
    resolved,
    runtime,
    generateClientId: () => `cli_${"D".repeat(43)}`,
    generateIdempotencyKey: () => "enroll-verify-retry",
    enrollmentEmail: "owner@example.com",
    enroll: async () => ({ token: "sr_live_verify_secret", projectId: "prj_verify" }),
    verify: async () => { throw new Error("verification temporarily unavailable"); },
  }), /verification temporarily unavailable/);
  assert.deepEqual(await readConfigFile(resolved.configPath, fs), {
    api_url: "https://api.screenrig.ai",
    token: "sr_live_verify_secret",
    project_id: "prj_verify",
    enrollment: {
      client_id: `cli_${"D".repeat(43)}`,
      idempotency_key: "enroll-verify-retry",
      credential_format: "oauth",
      email: "owner@example.com",
    },
    updated_at: "2026-08-14T20:00:00.000Z",
  });

  let verifications = 0;
  const persisted = await resolveConfig({ flags: {}, fs });
  const second = await ensureCredential({
    resolved: persisted,
    runtime,
    enroll: async () => { throw new Error("must not enroll twice"); },
    verify: async (token, projectId) => {
      verifications += 1;
      assert.equal(token, "sr_live_verify_secret");
      assert.equal(projectId, "prj_verify");
    },
  });
  assert.equal(second.token, "sr_live_verify_secret");
  assert.equal(verifications, 1);
  assert.equal((await readConfigFile(resolved.configPath, fs))?.enrollment, undefined);
  await rm(home, { recursive: true, force: true });
});

test("AgentID claim enrollment persists the claim, verifies, and completes", async () => {
  const home = await testTemp("enrollment-agentid-");
  const { fs, resolved } = fixture(home);
  const claim = `agid_${"K".repeat(43)}`;
  const seen: Array<{ clientId: string; idempotencyKey: string; email?: string; agentidClaim?: string }> = [];
  const result = await ensureCredential({
    resolved,
    runtime: { fs, now: () => new Date("2026-08-14T20:00:00.000Z"), sleep: async () => undefined },
    generateClientId: () => `cli_${"K".repeat(43)}`,
    generateIdempotencyKey: () => "enroll-agentid-idempotency",
    enrollmentAgentIdClaim: claim,
    verify: async (token, projectId) => {
      assert.equal(token, "sr_live_agentid_secret");
      assert.equal(projectId, "prj_agentid");
      assert.deepEqual((await readConfigFile(resolved.configPath, fs))?.enrollment, {
        client_id: `cli_${"K".repeat(43)}`,
        idempotency_key: "enroll-agentid-idempotency",
        credential_format: "oauth",
        agentid_claim: claim,
      });
    },
    enroll: async (state) => {
      seen.push(state);
      return { token: "sr_live_agentid_secret", projectId: "prj_agentid" };
    },
  });
  assert.deepEqual(seen, [{
    clientId: `cli_${"K".repeat(43)}`,
    idempotencyKey: "enroll-agentid-idempotency",
    credentialFormat: "oauth",
    agentidClaim: claim,
  }]);
  assert.equal(result.token, "sr_live_agentid_secret");
  assert.equal(result.source.token, "config");
  assert.equal((await readConfigFile(resolved.configPath, fs))?.enrollment, undefined);
  await rm(home, { recursive: true, force: true });
});

test("a pending AgentID claim enrollment rejects a different claim or an email switch, then resumes the bound claim", async () => {
  const home = await testTemp("enrollment-agentid-bound-");
  const { fs, resolved } = fixture(home);
  const claim = `agid_${"L".repeat(43)}`;
  await writeConfigAtomic(resolved.configPath, {
    api_url: resolved.apiUrl,
    enrollment: {
      client_id: `cli_${"L".repeat(43)}`,
      idempotency_key: "enroll-agentid-bound",
      agentid_claim: claim,
    },
  }, fs);
  const runtime = { fs, now: () => new Date(), sleep: async () => undefined };
  await assert.rejects(ensureCredential({
    resolved,
    runtime,
    enrollmentAgentIdClaim: `agid_${"M".repeat(43)}`,
    enroll: async () => { throw new Error("must reject before sending another enrollment"); },
    verify: async () => undefined,
  }), (error: unknown) => error instanceof CliError && error.problem.code === "config_error");
  await assert.rejects(ensureCredential({
    resolved,
    runtime,
    enrollmentEmail: "owner@example.com",
    enroll: async () => { throw new Error("must reject before switching credential source"); },
    verify: async () => undefined,
  }), (error: unknown) => error instanceof CliError && error.problem.code === "config_error");
  assert.deepEqual((await readConfigFile(resolved.configPath, fs))?.enrollment,
    { client_id: `cli_${"L".repeat(43)}`, idempotency_key: "enroll-agentid-bound", agentid_claim: claim });

  const seen: Array<{ agentidClaim?: string; email?: string }> = [];
  const resumed = await ensureCredential({
    resolved,
    runtime,
    enroll: async (state) => {
      seen.push(state);
      return { token: "sr_live_agentid_resume", projectId: "prj_agentid_resume" };
    },
    verify: async () => undefined,
  });
  assert.equal(resumed.token, "sr_live_agentid_resume");
  assert.deepEqual(seen, [{ clientId: `cli_${"L".repeat(43)}`, idempotencyKey: "enroll-agentid-bound", agentidClaim: claim }]);
  await rm(home, { recursive: true, force: true });
});

test("enrollment without a contact email or an AgentID claim is refused", async () => {
  const home = await testTemp("enrollment-no-source-");
  const { fs, resolved } = fixture(home);
  await assert.rejects(ensureCredential({
    resolved,
    runtime: { fs, now: () => new Date(), sleep: async () => undefined },
    enroll: async () => { throw new Error("enrollment must not run"); },
    verify: async () => undefined,
  }), (error: unknown) => error instanceof CliError && error.problem.code === "config_error");
  await rm(home, { recursive: true, force: true });
});
