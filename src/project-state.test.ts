import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { projectConfigFor, withProjectConfig, assertProjectCredential } from "./project-state.js";
import { readConfigFile, writeConfigAtomic, type ConfigFs, type ResolvedConfig, type ScreenRigConfig } from "./config.js";
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
    api_url: API, identity_token: "private-identity", project_id: B, token: "private-current", project_name: "B",
    organization_id: "org_B", organization_name: "Organization B",
    projects: {
      [A]: { project_name: "A", organization_id: "org_A", organization_name: "Organization A" },
      [B]: { project_name: "B", organization_id: "org_B", organization_name: "Organization B" },
    },
  };
}

test("fixed command target survives another project's selection and state update", () => {
  const stored = twoProjects();
  const resolved = target(A, "private-current");
  const view = projectConfigFor(stored, resolved);
  assert.equal(view.token, "private-current");
  assert.equal(view.project_id, A);
  assert.equal(view.organization_name, "Organization A");
  const updated = withProjectConfig(stored, resolved, { ...view, screen_provision: { idempotency_key: "provision-key-a", label: "A screen" } });
  assert.equal(updated.project_id, B);
  assert.equal(updated.token, "private-current");
  assert.deepEqual(updated.projects?.[B], stored.projects?.[B]);
  assert.equal(updated.identity_token, stored.identity_token);
  assert.equal(updated.projects?.[A]?.screen_provision?.idempotency_key, "provision-key-a");
});

test("migration captures legacy pending keys unchanged and never accepts a vanished target", () => {
  const key = { idempotency_key: "legacy-provision-key", label: "Lobby" };
  const stored: ScreenRigConfig = { api_url: API, project_id: A, token: "private-a", screen_provision: key };
  const resolved = target(A, "private-current");
  const migrated = withProjectConfig(stored, resolved, stored);
  assert.deepEqual(migrated.screen_provision, key);
  assert.deepEqual(migrated.projects?.[A]?.screen_provision, key);
  assert.equal(projectConfigFor({ api_url: API, project_id: B, token: "private-current" }, resolved).project_id, A);
  assert.throws(() => assertProjectCredential({ ...stored, token: "replacement" }, resolved), /credential changed/);
});

test("stored project records cannot overwrite global authority or API origin", () => {
  const stored = twoProjects();
  stored.projects![A] = { token: "private-a", api_url: "https://example.invalid", identity_token: "other", project_id: B } as never;
  const view = projectConfigFor(stored, target(A, "private-current"));
  assert.equal(view.api_url, API);
  assert.equal(view.identity_token, "private-identity");
  assert.equal(view.project_id, A);
});

test("provisioning, browser claims and ordinary writes stay in their captured project", async t => {
  const home = await testTemp("project-retry-isolation-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => home, settings: {} };
  const configPath = path.join(home, "config.json");
  const stored = twoProjects();
  await writeConfigAtomic(configPath, stored, fs);
  const resolvedA = target(A, "private-current", configPath);
  const resolvedB = target(B, "private-current", configPath);
  const runtime = { ...processRuntime(), fs, settings: fs.settings, homedir: fs.homedir, now: () => new Date(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
  const options = { resolved: resolvedA, runtime };
  const provision = await provisionRetryState({ ...options, label: "A screen", generateIdempotencyKey: () => "provision-key-a" });
  const browser = await browserSetupRetryState({ ...options, code: "ABC234", generateIdempotencyKey: () => "browser-key-a" });
  const recovery = new WriteRecovery(resolvedA, runtime, "screen update");
  const pending = await recovery.prepare({ method: "PATCH", path: "/api/screens/scr_A", body: { name: "A screen" } }, "write-key-a");
  assert.equal(pending.key, "write-key-a");
  await clearProvisionRetryState(resolvedA, runtime, provision.idempotency_key);
  await clearBrowserSetupRetryState(resolvedA, runtime, browser.idempotency_key);
  await recovery.finish();
  const final = (await readConfigFile(configPath, fs))!;
  assert.equal(final.project_id, B);
  assert.equal(final.token, "private-current");
  assert.deepEqual(final.projects?.[B], stored.projects?.[B]);
  assert.deepEqual(final.projects?.[A], stored.projects?.[A]);
  assert.equal(final.identity_token, stored.identity_token);
});
