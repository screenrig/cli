import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ensureIdentityCredential, validateIdentityToken } from "./identity-credential.js";
import { readConfigFile, writeConfigAtomic, type ConfigFs, type ResolvedConfig } from "./config.js";
import { testTemp } from "./test-temp.js";

const A = "prj_AAAAAAAAAAAAAAAAAAAAAAAA";
const B = "prj_BBBBBBBBBBBBBBBBBBBBBBBB";
const AGENT = "agt_AAAAAAAAAAAAAAAAAAAAAAAA";
const IDENTITY = `sr_live_idt_${"A".repeat(24)}_${"S".repeat(43)}`;

async function fixture(t: { after(action: () => Promise<void>): void }) {
  const home = await testTemp("identity-exchange-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => home, env: {} };
  const configPath = path.join(home, "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: A, project_name: "Screens", token: "private-project-a", agent_id: AGENT }, fs);
  const resolved: ResolvedConfig = { apiUrl: "https://api.screenrig.ai", projectId: A, token: "private-project-a", agentId: AGENT, configPath, source: { apiUrl: "config", token: "config" } };
  const runtime = { fs, now: () => new Date(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
  const read = async () => (await readConfigFile(configPath, fs))!;
  return { fs, configPath, resolved, runtime, read };
}

function delivery() { return { agent_id: AGENT, identity_token: IDENTITY, issuance_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }; }

test("ambiguous identity exchange reuses its saved key and preserves the project credential", async t => {
  const f = await fixture(t);
  const keys: string[] = [];
  await assert.rejects(ensureIdentityCredential({ ...f, exchange: async key => { keys.push(key); throw new Error("response lost"); }, generateIdempotencyKey: () => "identity-replay-key" }), /response lost/);
  const pending = await f.read();
  assert.equal(pending.identity_exchange?.idempotency_key, "identity-replay-key");
  assert.equal(pending.identity_token, undefined);
  assert.equal(pending.token, "private-project-a");
  const result = await ensureIdentityCredential({ ...f, exchange: async key => { keys.push(key); return delivery(); } });
  assert.deepEqual(keys, ["identity-replay-key", "identity-replay-key"]);
  assert.equal(result.identityToken, IDENTITY);
  const completed = await f.read();
  assert.equal(completed.token, pending.token);
  assert.equal(completed.project_id, A);
  assert.equal(completed.identity_exchange, undefined);
  assert.equal(completed.identity_token, IDENTITY);
});

test("a project switch during identity delivery keeps the original target and newer selection", async t => {
  const f = await fixture(t);
  const result = await ensureIdentityCredential({ ...f, exchange: async () => {
    const current = await f.read();
    await writeConfigAtomic(f.configPath, { ...current, project_id: B, token: "private-project-b", project_name: "B",
      projects: { [A]: { token: "private-project-a", project_name: "Screens" }, [B]: { token: "private-project-b", project_name: "B" } } }, f.fs);
    return delivery();
  } });
  const current = await f.read();
  assert.equal(current.project_id, B);
  assert.equal(current.token, "private-project-b");
  assert.equal(current.projects?.[A]?.token, "private-project-a");
  assert.equal(result.projectId, A);
  assert.equal(result.token, "private-project-a");
  assert.equal(result.identityToken, IDENTITY);
});

test("concurrent lazy exchanges use one persisted replay key without holding the lock across HTTP", async t => {
  const f = await fixture(t);
  const keys: string[] = [];
  const exchange = async (key: string) => { keys.push(key); await new Promise(resolve => setTimeout(resolve, 30)); return delivery(); };
  const results = await Promise.all([ensureIdentityCredential({ ...f, exchange }), ensureIdentityCredential({ ...f, exchange })]);
  assert.equal(new Set(keys).size, 1);
  assert.ok(results.every(result => result.identityToken === IDENTITY));
  assert.equal((await f.read()).identity_exchange, undefined);
});

test("a changed source credential or wrong agent refuses delivery persistence", async t => {
  const f = await fixture(t);
  await assert.rejects(ensureIdentityCredential({ ...f, exchange: async () => ({ ...delivery(), agent_id: "agt_BBBBBBBBBBBBBBBBBBBBBBBB" }) }), /expected agent/);
  assert.equal((await f.read()).identity_token, undefined);
  await assert.rejects(ensureIdentityCredential({ ...f, exchange: async () => {
    await writeConfigAtomic(f.configPath, { ...(await f.read()), token: "replacement-project-credential" }, f.fs);
    return delivery();
  } }), /credential changed/);
  assert.equal((await f.read()).identity_token, undefined);
});

test("identity validation refuses project tokens without repeating secret input", () => {
  const secret = `sr_live_tok_${"A".repeat(24)}_${"S".repeat(43)}`;
  assert.throws(() => validateIdentityToken(secret), error => error instanceof Error && !error.message.includes(secret));
  assert.equal(validateIdentityToken(IDENTITY), IDENTITY);
});
