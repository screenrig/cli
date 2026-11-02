import { readFile } from "node:fs/promises";
import path from "node:path";
import { flagBool, flagString, type ParsedArgs } from "./command-input.js";
import type { CommandResult, ResolvedCommandConfig } from "./commands.js";
import { preserveLogSocket, readConfigFile, withConfigLock, writeConfigAtomic, type ScreenRigConfig } from "./config.js";
import { successEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { isServiceClientId, serviceCredentialsFromConfig, type StoredServiceClient } from "./oauth.js";
import { usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";

/** Device-login flags that do not apply to a service client. */
const DEVICE_LOGIN_FLAGS = ["project", "access", "name", "resume"] as const;

/** Whether this config holds an agent installation's sign-in or a sign-in in progress. */
function holdsAgentSignIn(file: ScreenRigConfig | undefined): boolean {
  return Boolean(file && (file.token || file.identity_token || file.oauth || file.enrollment || file.login || file.agent_id || Object.keys(file.projects ?? {}).length));
}

/**
 * `screenrig login --client-id scl_… --client-key-file PATH | --client-secret-file PATH`:
 * save a service client in this config. Every later command in this config
 * signs in as that client and reads the key or secret from the named file.
 */
export async function serviceLogin(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const clientId = flagString(args.flags, "client-id");
  if (!isServiceClientId(clientId)) throw usageError("login --client-id must be a service client id (scl_...) from screenrig service-client list.");
  for (const flag of DEVICE_LOGIN_FLAGS) {
    if (flagString(args.flags, flag) !== undefined) throw usageError(`login --${flag} is for a person's sign-in; a service client signs in with --client-id alone.`);
  }
  if (flagBool(args.flags, "no-wait")) throw usageError("login --no-wait is for a person's sign-in; a service client signs in at once.");
  const keyFile = flagString(args.flags, "client-key-file");
  const secretFile = flagString(args.flags, "client-secret-file");
  if (Boolean(keyFile) === Boolean(secretFile)) throw usageError("login --client-id takes exactly one of --client-key-file PATH (the private key) or --client-secret-file PATH (a file holding the secret).");
  const saved: StoredServiceClient = {
    client_id: clientId,
    ...(keyFile ? { key_file: path.resolve(runtime.cwd(), keyFile) } : { secret_file: path.resolve(runtime.cwd(), secretFile!) }),
  };
  const service = await serviceCredentialsFromConfig(saved, (file) => readFile(file, "utf8"));
  const fs = runtime.fs;
  await withConfigLock(resolved.configPath, fs, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    const current = await readConfigFile(resolved.configPath, fs);
    if (holdsAgentSignIn(current)) {
      throw usageError(`${resolved.configPath} holds this installation's agent sign-in. Save the service client in a config of its own: screenrig --config PATH login --client-id ${clientId} ...`);
    }
    await writeConfigAtomic(resolved.configPath, {
      ...preserveLogSocket(current, { api_url: resolved.apiUrl }),
      service_client: saved,
      updated_at: runtime.now().toISOString(),
    }, fs);
  });
  const next = ["project", "show"];
  return {
    envelope: successEnvelope({
      status: "signed_in",
      service_client_id: clientId,
      method: service.method,
      config: resolved.configPath,
      next: { command: `screenrig ${next.join(" ")}`, argv: next, reason: "The first project command signs in as the service client." },
    }),
    exitCode: ExitCode.Success,
    human: `Saved service client ${clientId} in ${resolved.configPath}. Every command with this config signs in as it, reading the ${keyFile ? "key" : "secret"} file each time.`,
  };
}

/** `screenrig logout` in a service client's config: forget the saved client. Its key or secret file stays. */
export async function serviceLogout(runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult | undefined> {
  const fs = runtime.fs;
  return withConfigLock(resolved.configPath, fs, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    const current = await readConfigFile(resolved.configPath, fs);
    const saved = current?.service_client;
    if (!current || !saved) return undefined;
    const { service_client: _removed, ...rest } = current;
    await writeConfigAtomic(resolved.configPath, { ...rest, updated_at: runtime.now().toISOString() }, fs);
    return {
      envelope: successEnvelope({ status: "signed_out", service_client_id: saved.client_id, revoked: false }),
      exitCode: ExitCode.Success,
      human: `Removed service client ${saved.client_id} from ${resolved.configPath}. Its key or secret file is unchanged; revoke the client with screenrig service-client revoke ${saved.client_id}.`,
    };
  });
}
