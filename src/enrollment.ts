import {
  readConfigFile,
  withConfigLock,
  writeConfigAtomic,
  type ConfigFs,
  type ResolvedConfig,
  type ScreenRigConfig,
} from "./config.js";
import { isValidIdempotencyKey, newIdempotencyKey, randomPrefixedId } from "./ids.js";
import { configError } from "./problems.js";

export interface EnrollmentCredential {
  token: string;
  accountId?: string;
}

export interface EnrollmentState {
  clientId: string;
  idempotencyKey: string;
}

export interface EnrollmentRuntime {
  fs: ConfigFs;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Resolve a durable credential exactly once across concurrent CLI processes.
 * The callback owns the wire contract and is supplied by the command layer.
 */
export async function ensureCredential(options: {
  resolved: ResolvedConfig;
  runtime: EnrollmentRuntime;
  enroll: (state: EnrollmentState) => Promise<EnrollmentCredential>;
  verify: (token: string, accountId?: string) => Promise<void>;
  generateClientId?: () => string;
  generateIdempotencyKey?: () => string;
}): Promise<ResolvedConfig> {
  const { runtime, resolved } = options;
  if (resolved.token && !resolved.enrollment) {
    return resolved;
  }
  const enrolled = await withConfigLock(
    resolved.configPath,
    runtime.fs,
    { sleep: runtime.sleep, now: () => runtime.now().getTime() },
    async () => {
      const current = await readConfigFile(resolved.configPath, runtime.fs);
      if (current?.token) {
        return {
          ...resolved,
          token: current.token,
          accountId: current.account_id,
          enrollment: current.enrollment,
          source: { ...resolved.source, token: "config" as const },
        };
      }
      if (current?.enrollment && current.api_url.replace(/\/+$/, "") !== resolved.apiUrl) {
        throw configError("Pending enrollment is bound to a different API URL.");
      }
      const enrollment = current?.enrollment ?? {
        client_id: (options.generateClientId ?? (() => randomPrefixedId("cli", 32)))(),
        idempotency_key: (options.generateIdempotencyKey ?? newIdempotencyKey)(),
      };
      if (!/^cli_[A-Za-z0-9_-]{43}$/.test(enrollment.client_id)) {
        throw configError("Enrollment client state is invalid.");
      }
      if (!isValidIdempotencyKey(enrollment.idempotency_key)) {
        throw configError("Enrollment idempotency state is invalid.");
      }
      const pending: ScreenRigConfig = {
        api_url: resolved.apiUrl,
        enrollment,
        updated_at: runtime.now().toISOString(),
      };
      await writeConfigAtomic(resolved.configPath, pending, runtime.fs);
      const credential = await options.enroll({
        clientId: enrollment.client_id,
        idempotencyKey: enrollment.idempotency_key,
      });
      if (!credential.token || credential.token.trim() !== credential.token) {
        throw configError("Enrollment returned an invalid credential.");
      }
      const config: ScreenRigConfig = {
        api_url: resolved.apiUrl,
        token: credential.token,
        ...(credential.accountId ? { account_id: credential.accountId } : {}),
        enrollment,
        updated_at: runtime.now().toISOString(),
      };
      await writeConfigAtomic(resolved.configPath, config, runtime.fs);
      return {
        ...resolved,
        token: credential.token,
        accountId: credential.accountId,
        enrollment,
        source: { ...resolved.source, token: "config" as const },
      };
    },
  );

  if (!enrolled.token || !enrolled.enrollment) {
    return enrolled;
  }
  await options.verify(enrolled.token, enrolled.accountId);
  return withConfigLock(
    enrolled.configPath,
    runtime.fs,
    { sleep: runtime.sleep, now: () => runtime.now().getTime() },
    async () => {
      const current = await readConfigFile(enrolled.configPath, runtime.fs);
      if (!current?.token || !current.enrollment) {
        return enrolled;
      }
      const { enrollment: _verified, ...verified } = current;
      await writeConfigAtomic(enrolled.configPath, verified, runtime.fs);
      const { enrollment: _cleared, ...complete } = enrolled;
      return complete;
    },
  );
}
