import { createHash } from "node:crypto";
import type { AgentIdentityCredential } from "./adapters/protocol.js";
import { readConfigFile, withConfigLock, writeConfigAtomic, type ResolvedConfig } from "./config.js";
import type { EnrollmentRuntime } from "./enrollment.js";
import { newIdempotencyKey, isValidIdempotencyKey } from "./ids.js";
import { RESOURCE_ID_PATTERNS } from "./generated/resource-ids.js";
import { configError } from "./problems.js";
import { projectConfigFor, assertProjectCredential } from "./project-state.js";

export function validateIdentityToken(value: unknown): string {
  if (typeof value !== "string" || !/^sr_live_idt_[A-Za-z0-9_-]+_[0-9a-fA-F]{64}$/.test(value)) {
    throw configError("The identity credential does not match the backend contract.");
  }
  return value;
}

function fingerprint(token: string): string {
  return createHash("sha256").update("screenrig/cli-identity-exchange/v1\0").update(token).digest("hex");
}

/** Exchanges lazily only for an explicit identity operation. The project
 * credential stays usable. Save the replay key before HTTP, release the file
 * lock during HTTP, then merge the delivery after rechecking original authority.
 * A project switch by another process cannot redirect or erase this exchange. */
export async function ensureIdentityCredential(options: {
  resolved: ResolvedConfig;
  runtime: EnrollmentRuntime;
  exchange: (key: string) => Promise<AgentIdentityCredential>;
  generateIdempotencyKey?: () => string;
}): Promise<ResolvedConfig> {
  const { resolved, runtime } = options;
  if (resolved.identityToken) return { ...resolved, identityToken: validateIdentityToken(resolved.identityToken) };
  const locked = <T>(action: () => Promise<T>): Promise<T> => withConfigLock(resolved.configPath, runtime.fs,
    { sleep: runtime.sleep, now: () => runtime.now().getTime() }, action);
  const pending = await locked(async () => {
    const current = await readConfigFile(resolved.configPath, runtime.fs);
    if (!current) throw configError("The saved credential disappeared before identity exchange.");
    if (!resolved.token) throw configError("Identity exchange requires an existing project credential.");
    assertProjectCredential(projectConfigFor(current, resolved), resolved);
    if (resolved.agentId && current.agent_id && current.agent_id !== resolved.agentId) throw configError("The saved agent changed before identity exchange.");
    if (current.identity_token) return { identity: validateIdentityToken(current.identity_token) };
    const hash = fingerprint(resolved.token);
    let exchange = current.identity_exchange;
    if (exchange && (exchange.credential_hash !== hash || exchange.project_id !== resolved.projectId
      || !isValidIdempotencyKey(exchange.idempotency_key) || !Number.isFinite(Date.parse(exchange.started_at)))) {
      throw configError("Pending identity exchange is not bound to this saved project credential.");
    }
    // This endpoint explicitly permits a new key after its ten-minute sealed
    // delivery expires. It creates an identity credential, never a new project.
    if (!exchange || runtime.now().getTime() - Date.parse(exchange.started_at) >= 10 * 60 * 1000) {
      exchange = { idempotency_key: (options.generateIdempotencyKey ?? newIdempotencyKey)(),
        project_id: resolved.projectId, credential_hash: hash, started_at: runtime.now().toISOString() };
      if (!isValidIdempotencyKey(exchange.idempotency_key)) throw configError("Identity exchange replay key is invalid.");
      await writeConfigAtomic(resolved.configPath, { ...current, identity_exchange: exchange }, runtime.fs);
    }
    return { key: exchange.idempotency_key };
  });
  if (pending.identity) return { ...resolved, identityToken: pending.identity };
  const credential = await options.exchange(pending.key!);
  const token = validateIdentityToken(credential.identity_token);
  if (!RESOURCE_ID_PATTERNS.agent.test(credential.agent_id)
    || (resolved.agentId && credential.agent_id !== resolved.agentId)
    || !Number.isFinite(Date.parse(credential.issuance_expires_at))) {
    throw configError("Identity delivery is not bound to the expected agent.");
  }
  const identityToken = await locked(async () => {
    const current = await readConfigFile(resolved.configPath, runtime.fs);
    if (!current) throw configError("The saved credential disappeared before identity delivery persistence.");
    assertProjectCredential(projectConfigFor(current, resolved), resolved);
    if (current.agent_id && current.agent_id !== credential.agent_id) throw configError("The saved agent changed during identity exchange.");
    if (current.identity_token) return validateIdentityToken(current.identity_token);
    if (current.identity_exchange?.idempotency_key !== pending.key) throw configError("Pending identity exchange changed before delivery persistence.");
    const { identity_exchange: _delivered, ...complete } = current;
    await writeConfigAtomic(resolved.configPath, { ...complete, identity_token: token, agent_id: credential.agent_id,
      updated_at: runtime.now().toISOString() }, runtime.fs);
    return token;
  });
  return { ...resolved, agentId: credential.agent_id, identityToken };
}
