// Command handlers for the dashboard commands, loaded on demand.
import { apexHost } from "../apex-origin.js";
import { flagString, type ParsedArgs } from "../command-input.js";
import { resolveConfig, readConfigFile, withConfigLock, writeConfigAtomic } from "../config.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { clientFor, commandHandler, humanLines, isPlainContactEmail, jsonBody, requirePrivateNoStore, writeRecoveries, type CommandResult } from "../commands.js";

/** dashboard reset-sign-in is unauthenticated and targets the project's owner contact address. */
export function signInResetEmail(value: string | undefined): string {
  const email = value?.trim();
  if (!email) {
    throw usageError("dashboard reset-sign-in requires --email ADDRESS.");
  }
  if (!isPlainContactEmail(email)) {
    throw usageError("dashboard reset-sign-in --email must be one plain ASCII address with an unquoted local part and dotted DNS domain.");
  }
  return email;
}
export const handleSignInReset = commandHandler(signInReset, false);

export const handleDashboard = commandHandler(dashboardCommand, false);

/** Opens the ordinary dashboard origin; no credential is minted or transferred. */
export async function dashboardCommand(
  _args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const api = new URL(resolved.apiUrl);
  const hostname = apexHost(api.hostname);
  if (!hostname || (api.protocol !== "https:" && !(api.protocol === "http:" && api.hostname.endsWith(".localhost")))) {
    throw usageError("dashboard requires a supported ScreenRig API origin.");
  }
  const origin = `${api.protocol}//${hostname}${api.port ? `:${api.port}` : ""}/dashboard/`;
  let opened = false;
  try { opened = await (runtime.openUrl?.(origin) ?? Promise.resolve(false)); } catch { /* Fall back to the ordinary origin. */ }
  return {
    envelope: successEnvelope({ opened, ...(!opened ? { url: origin } : {}) }),
    exitCode: ExitCode.Success,
    human: humanLines(opened ? "Dashboard opened" : "No browser could be opened", [
      ...(!opened ? [["url", origin] as [string, string]] : []),
    ]),
  };
}

/** The contract is closed: only {status:"accepted"}, identically for enrolled and unknown addresses. */
export function validateSignInResetAccepted(value: unknown): void {
  const body = value as { status?: unknown } | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1 || body.status !== "accepted") {
    throw usageError("Sign-in reset response does not match the accepted contract.");
  }
}

/** Unauthenticated, durable and neutral for known and unknown email addresses. */
export async function signInReset(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const email = signInResetEmail(flagString(args.flags, "email"));
  const configFs = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  // The durable retry ledger lives in the user config, which an unenrolled
  // installation does not have yet. Seed a credential-free config; recovery
  // never writes a token, project, agent, or enrollment state into it.
  if (!(await readConfigFile(resolved.configPath, configFs))) {
    await withConfigLock(
      resolved.configPath,
      configFs,
      { sleep: runtime.sleep, now: () => runtime.now().getTime() },
      async () => {
        if (await readConfigFile(resolved.configPath, configFs)) return;
        await writeConfigAtomic(resolved.configPath, {
          api_url: resolved.apiUrl,
          updated_at: runtime.now().toISOString(),
        }, configFs);
      },
    );
  }
  const client = clientFor(runtime, args, resolved.apiUrl, undefined, writeRecoveries.get(runtime));
  const response = await client.call({
    method: "POST",
    path: "/api/sign-in-resets",
    idempotent: true,
    body: { email },
  });
  requirePrivateNoStore(response.headers, "Sign-in reset response");
  validateSignInResetAccepted(response.body);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Sign-in reset request accepted", [
      ["status", "accepted"],
      ["delivery", "If this address can receive sign-in instructions, check its inbox. Delivery is not confirmed."],
      ["request_id", client.requestId],
    ]),
  };
}
