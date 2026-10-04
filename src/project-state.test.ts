import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { projectConfigFor, withProjectConfig, assertProjectCredential } from "./project-state.js";
import { readConfigFile, writeConfigAtomic, type ConfigFs, type ResolvedConfig, type ScreenRigConfig } from "./config.js";
import { generateRetryState, clearGenerateRetryState } from "./media-generate-retry.js";
import { provisionRetryState, clearProvisionRetryState } from "./provisioning-state.js";
import { browserSetupRetryState, clearBrowserSetupRetryState } from "./browser-setup.js";
import { WriteRecovery } from "./write-recovery.js";
import { processRuntime } from "./runtime.js";
import { testTemp } from "./test-temp.js";

const A = "prj_AAAAAAAAAAAAAAAAAAAAAAAA";
const B = "prj_BBBBBBBBBBBBBBBBBBBBBBBB";
const API = "https://api.screenrig.ai";

function target(id: string, token: string, configPath = "unused"): ResolvedConfig {
  return { apiUrl: API, token, projectId: id, configPath, source: { apiUrl: "config", token: "config" } };
}

function twoProjects(): ScreenRigConfig {
  return {
    api_url: API, identity_token: "private-identity", project_id: B, token: "private-b", project_name: "B",
    organization_id: "org_B", organization_name: "Organization B",
    media_generate: { idempotency_key: "generation-key-b", request_hash: "hash-b" },
    projects: {
      [A]: { token: "private-a", project_name: "A", organization_id: "org_A", organization_name: "Organization A" },
      [B]: { token: "private-b", project_name: "B", organization_id: "org_B", organization_name: "Organization B", media_generate: { idempotency_key: "generation-key-b", request_hash: "hash-b" } },
    },
  };
}

test("fixed command target survives another project's selection and state update", () => {
  const stored = twoProjects();
  const resolved = target(A, "private-a");
  const view = projectConfigFor(stored, resolved);
  assert.equal(view.token, "private-a");
  assert.equal(view.project_id, A);
  assert.equal(view.organization_name, "Organization A");
  assert.equal(view.media_generate, undefined);
  const updated = withProjectConfig(stored, resolved, { ...view, screen_provision: { idempotency_key: "provision-key-a", label: "A screen" } });
  assert.equal(updated.project_id, B);
  assert.equal(updated.token, "private-b");
  assert.deepEqual(updated.media_generate, stored.media_generate);
  assert.deepEqual(updated.projects?.[B], stored.projects?.[B]);
  assert.equal(updated.identity_token, stored.identity_token);
  assert.equal(updated.projects?.[A]?.screen_provision?.idempotency_key, "provision-key-a");
});

test("migration captures legacy pending keys unchanged and never accepts a vanished target", () => {
  const key = { idempotency_key: "legacy-generation-key", request_hash: "original-request" };
  const stored: ScreenRigConfig = { api_url: API, project_id: A, token: "private-a", media_generate: key };
  const resolved = target(A, "private-a");
  const migrated = withProjectConfig(stored, resolved, stored);
  assert.deepEqual(migrated.media_generate, key);
  assert.deepEqual(migrated.projects?.[A]?.media_generate, key);
  assert.throws(() => projectConfigFor({ api_url: API, project_id: B, token: "private-b" }, resolved), /no longer stored/);
  assert.throws(() => assertProjectCredential({ ...stored, token: "replacement" }, resolved), /credential changed/);
});

test("stored project records cannot overwrite global authority or API origin", () => {
  const stored = twoProjects();
  stored.projects![A] = { token: "private-a", api_url: "https://example.invalid", identity_token: "other", project_id: B } as never;
  const view = projectConfigFor(stored, target(A, "private-a"));
  assert.equal(view.api_url, API);
  assert.equal(view.identity_token, "private-identity");
  assert.equal(view.project_id, A);
});

test("generation, provisioning, browser claims and ordinary writes stay in their captured project", async t => {
  const home = await testTemp("project-retry-isolation-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => home, env: {} };
  const configPath = path.join(home, "config.json");
  const stored = twoProjects();
  await writeConfigAtomic(configPath, stored, fs);
  const resolvedA = target(A, "private-a", configPath);
  const resolvedB = target(B, "private-b", configPath);
  const runtime = { ...processRuntime(), fs, env: fs.env, homedir: fs.homedir, now: () => new Date(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
  const options = { resolved: resolvedA, runtime };
  const generation = await generateRetryState({ ...options, requestHash: "hash-a", generateIdempotencyKey: () => "generation-key-a" });
  assert.equal(generation.reused, false);
  const provision = await provisionRetryState({ ...options, label: "A screen", generateIdempotencyKey: () => "provision-key-a" });
  const browser = await browserSetupRetryState({ ...options, code: "ABC234", generateIdempotencyKey: () => "browser-key-a" });
  const recovery = new WriteRecovery(resolvedA, runtime, "screen update");
  const pending = await recovery.prepare({ method: "PATCH", path: "/api/v1/screens/scr_A", body: { name: "A screen" } }, "write-key-a");
  assert.equal(pending.key, "write-key-a");
  const rerun = await generateRetryState({ ...options, requestHash: "hash-a" });
  assert.equal(rerun.state.idempotency_key, "generation-key-a");
  const generationB = await generateRetryState({ resolved: resolvedB, runtime, requestHash: "hash-b" });
  assert.equal(generationB.state.idempotency_key, "generation-key-b");
  await clearGenerateRetryState(resolvedA, runtime, generation.state.idempotency_key);
  await clearProvisionRetryState(resolvedA, runtime, provision.idempotency_key);
  await clearBrowserSetupRetryState(resolvedA, runtime, browser.idempotency_key);
  await recovery.finish();
  const final = (await readConfigFile(configPath, fs))!;
  assert.equal(final.project_id, B);
  assert.equal(final.token, "private-b");
  assert.deepEqual(final.projects?.[B], stored.projects?.[B]);
  assert.deepEqual(final.media_generate, stored.media_generate);
  assert.deepEqual(final.projects?.[A], stored.projects?.[A]);
  assert.equal(final.identity_token, stored.identity_token);
});
