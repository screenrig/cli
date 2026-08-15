import { readConfigFile, withConfigLock, writeConfigAtomic, type ResolvedConfig } from "./config.js";
import type { EnrollmentRuntime } from "./enrollment.js";
import { isValidIdempotencyKey, newIdempotencyKey } from "./ids.js";
import { usageError } from "./problems.js";

const CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

export interface BrowserSetupCode {
  canonical: string;
  display: string;
}

export function normalizeBrowserSetupCode(input: string): BrowserSetupCode {
  const upper = input.toUpperCase();
  const canonical = upper.length === 7 && upper[3] === "-" ? `${upper.slice(0, 3)}${upper.slice(4)}` : upper;
  if (!CODE_PATTERN.test(canonical)) {
    throw usageError("browser setup --code must be six characters from 23456789ABCDEFGHJKMNPQRSTUVWXYZ, with an optional middle dash.");
  }
  return { canonical, display: `${canonical.slice(0, 3)}-${canonical.slice(3)}` };
}

export function browserHandoffUrl(apiUrl: string, displayCode: string): string {
  const api = new URL(apiUrl);
  if (api.protocol !== "https:") {
    throw usageError("browser setup --open requires the configured HTTPS ScreenRig origin.");
  }
  const host = api.hostname === "api.screenrig.ai"
    ? "screenrig.ai"
    : api.hostname === "api.screenrig.localhost"
      ? "screenrig.localhost"
      : undefined;
  if (!host) throw usageError("browser setup --open requires api.screenrig.ai or the configured HTTPS ScreenRig localhost origin.");
  const origin = `${api.protocol}//${host}${api.port ? `:${api.port}` : ""}`;
  return `${origin}/${displayCode}`;
}

export async function browserSetupRetryState(options: {
  resolved: ResolvedConfig;
  runtime: EnrollmentRuntime;
  code: string;
  requestedKey?: string;
  generateIdempotencyKey?: () => string;
}): Promise<{ idempotency_key: string; code: string }> {
  return withConfigLock(
    options.resolved.configPath,
    options.runtime.fs,
    { sleep: options.runtime.sleep, now: () => options.runtime.now().getTime() },
    async () => {
      const current = await readConfigFile(options.resolved.configPath, options.runtime.fs);
      if (current?.browser_setup) {
        if (current.browser_setup.code !== options.code) {
          throw usageError("A browser setup claim retry is pending. Retry the same code before claiming another browser.");
        }
        if (options.requestedKey && current.browser_setup.idempotency_key !== options.requestedKey) {
          throw usageError("The supplied idempotency key does not match the pending browser setup claim.");
        }
        return current.browser_setup;
      }
      const idempotencyKey = options.requestedKey ?? (options.generateIdempotencyKey ?? newIdempotencyKey)();
      if (!isValidIdempotencyKey(idempotencyKey)) throw usageError("Browser setup idempotency key is invalid.");
      const state = { idempotency_key: idempotencyKey, code: options.code };
      await writeConfigAtomic(options.resolved.configPath, {
        ...(current ?? { api_url: options.resolved.apiUrl }),
        browser_setup: state,
        updated_at: options.runtime.now().toISOString(),
      }, options.runtime.fs);
      return state;
    },
  );
}

export async function clearBrowserSetupRetryState(
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
      if (!current || current.browser_setup?.idempotency_key !== idempotencyKey) return;
      const { browser_setup: _complete, ...complete } = current;
      await writeConfigAtomic(resolved.configPath, complete, runtime.fs);
    },
  );
}
