import type { AccountCapabilities } from "./adapters/protocol.js";
import type { ApiClient } from "./client.js";
import { ExitCode } from "./exit-codes.js";
import type { ProblemNext } from "./envelope.js";
import { CliError, makeProblem, usageError } from "./problems.js";

/** Reject a body that does not match the generated account capabilities contract. */
export function validateAccountCapabilities(value: unknown): AccountCapabilities {
  const body = value as Partial<AccountCapabilities> | undefined;
  const features = body?.features as { advertiser?: unknown; screens?: unknown } | undefined;
  if (!body || typeof body.account_id !== "string" || body.account_id.length === 0
    || typeof body.plan_id !== "string" || body.plan_id.length === 0
    || !features || typeof features.advertiser !== "boolean" || typeof features.screens !== "boolean"
    || !Number.isSafeInteger(body.feature_revision) || (body.feature_revision ?? -1) < 0
    || !Array.isArray(body.capabilities) || body.capabilities.some((item) => typeof item !== "string")) {
    throw usageError("Capabilities response does not match the generated account capabilities contract.");
  }
  return body as AccountCapabilities;
}

/**
 * Refuse a capability-gated write when the server's own capability set does not
 * grant it.
 *
 * Discovery is a required part of the current contract, so an unreadable or
 * malformed capability response fails closed: the write is refused rather than
 * attempted without a preflight. No plan label, numeric quota, or previously
 * read capability is accepted as authority, and a server denial still wins.
 */
export async function requireCapability(
  client: ApiClient,
  capability: string,
  action: string,
  next: ProblemNext,
): Promise<void> {
  let capabilities: AccountCapabilities;
  try {
    const response = await client.call({ method: "GET", path: "/api/v1/account/capabilities" });
    capabilities = validateAccountCapabilities(response.body);
  } catch (error) {
    const detail = error instanceof CliError ? error.problem.detail : error instanceof Error ? error.message : "the request failed";
    throw new CliError(makeProblem("capability_unavailable", "Account capability discovery unavailable", 503,
      `${action} requires the ${capability} capability, and this account's capability set could not be read (${detail}). The write is refused rather than attempted without a capability check.`,
      { next }), ExitCode.Server);
  }
  if (!capabilities.capabilities.includes(capability)) {
    const advertiserOnly = capabilities.features.advertiser && !capabilities.features.screens;
    throw new CliError(makeProblem("capability_required", "Account capability required", 403,
      `${action} requires the ${capability} capability, and this account does not have it. An advertising account (advertiser=true, screens=false) cannot pair devices or author and publish playlists; change the account's purpose in the dashboard if signage is intended.`,
      { next }), ExitCode.Auth, advertiserOnly
      ? [{ code: "capability_scope", message: "This account is advertising only: creative and campaign work is permitted, but screen pairing, playlists, and publication are not." }]
      : []);
  }
}
