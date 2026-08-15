import { readConfigFile, withConfigLock, writeConfigAtomic, type ResolvedConfig } from "./config.js";
import { isValidIdempotencyKey, newIdempotencyKey } from "./ids.js";
import { usageError } from "./problems.js";
import type { EnrollmentRuntime } from "./enrollment.js";

export interface ProvisioningRetryState {
  idempotency_key: string;
  label?: string;
}

function sameRequest(state: ProvisioningRetryState, label: string | undefined): boolean {
  return state.label === label;
}

export async function provisionRetryState(options: {
  resolved: ResolvedConfig;
  runtime: EnrollmentRuntime;
  label?: string;
  requestedKey?: string;
  generateIdempotencyKey?: () => string;
}): Promise<ProvisioningRetryState> {
  return withConfigLock(
    options.resolved.configPath,
    options.runtime.fs,
    { sleep: options.runtime.sleep, now: () => options.runtime.now().getTime() },
    async () => {
      const current = await readConfigFile(options.resolved.configPath, options.runtime.fs);
      if (current?.screen_provision) {
        if (!sameRequest(current.screen_provision, options.label)) {
          throw usageError("A browser provisioning retry is pending. Retry the same label before creating another screen.");
        }
        if (options.requestedKey && current.screen_provision.idempotency_key !== options.requestedKey) {
          throw usageError("The supplied idempotency key does not match the pending browser provisioning retry.");
        }
        return current.screen_provision;
      }
      const idempotencyKey = options.requestedKey ?? (options.generateIdempotencyKey ?? newIdempotencyKey)();
      if (!isValidIdempotencyKey(idempotencyKey)) throw usageError("Browser provisioning idempotency key is invalid.");
      const state: ProvisioningRetryState = {
        idempotency_key: idempotencyKey,
        ...(options.label ? { label: options.label } : {}),
      };
      await writeConfigAtomic(options.resolved.configPath, {
        ...(current ?? { api_url: options.resolved.apiUrl }),
        screen_provision: state,
        updated_at: options.runtime.now().toISOString(),
      }, options.runtime.fs);
      return state;
    },
  );
}

export async function clearProvisionRetryState(
  resolved: ResolvedConfig,
  runtime: EnrollmentRuntime,
  idempotencyKey: string,
): Promise<void> {
  await withConfigLock(
    resolved.configPath,
    runtime.fs,
    { sleep: runtime.sleep, now: () => runtime.now().getTime() },
    async () => {
      const current = await readConfigFile(resolved.configPath, runtime.fs);
      if (!current || current.screen_provision?.idempotency_key !== idempotencyKey) return;
      const { screen_provision: _complete, ...complete } = current;
      await writeConfigAtomic(resolved.configPath, complete, runtime.fs);
    },
  );
}
