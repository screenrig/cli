import type { ProjectCapabilities } from "./adapters/protocol.js";
import type { ApiClient } from "./client.js";
import { ExitCode } from "./exit-codes.js";
import type { ProblemNext } from "./envelope.js";
import { CliError, makeProblem, usageError } from "./problems.js";

/** Reject a body that does not match the generated project capabilities contract. */
export function validateProjectCapabilities(value: unknown): ProjectCapabilities {
  const body = value as Partial<ProjectCapabilities> | undefined;
  const features = body?.features as { advertiser?: unknown; screens?: unknown } | undefined;
  if (!body || typeof body.project_id !== "string" || body.project_id.length === 0
    || typeof body.plan_id !== "string" || body.plan_id.length === 0
    || !features || typeof features.advertiser !== "boolean" || typeof features.screens !== "boolean"
    || !Number.isSafeInteger(body.feature_revision) || (body.feature_revision ?? -1) < 0
    || !Array.isArray(body.capabilities) || body.capabilities.some((item) => typeof item !== "string")) {
    throw usageError("Capabilities response does not match the generated project capabilities contract.");
  }
  return body as ProjectCapabilities;
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
  let capabilities: ProjectCapabilities;
  try {
    const response = await client.call({ method: "GET", path: "/api/v1/project/capabilities" });
    capabilities = validateProjectCapabilities(response.body);
  } catch (error) {
    const detail = error instanceof CliError ? error.problem.detail : error instanceof Error ? error.message : "the request failed";
    throw new CliError(makeProblem("capability_unavailable", "Project capability discovery unavailable", 503,
      `${action} requires the ${capability} capability, and this project's capability set could not be read (${detail}). The write is refused rather than attempted without a capability check.`,
      { next }), ExitCode.Server);
  }
  if (!capabilities.capabilities.includes(capability)) {
    const advertiserOnly = capabilities.features.advertiser && !capabilities.features.screens;
    throw new CliError(makeProblem("capability_required", "Project capability required", 403,
      `${action} requires the ${capability} capability, and this project does not have it. An advertising project (advertiser=true, screens=false) cannot pair devices or author and publish playlists; change the project's purpose in the dashboard if signage is intended.`,
      { next }), ExitCode.Auth, advertiserOnly
      ? [{ code: "capability_scope", message: "This project is advertising only: creative and campaign work is permitted, but screen pairing, playlists, and publication are not." }]
      : []);
  }
}
