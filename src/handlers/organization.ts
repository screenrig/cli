// Command handlers for the organization commands, loaded on demand.
import { cacheProjectContexts, projectName as validateDisplayName } from "../project-context.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { configError, usageError } from "../problems.js";
import { accessibleProjects, clientFor, commandHandler, identityForCommand } from "../commands.js";

export const handleOrganizationList = commandHandler(async (args, runtime, resolved) => {
  const identity = await identityForCommand(runtime, resolved);
  const client = clientFor(runtime, args, identity.apiUrl, identity.identityToken);
  const response = await client.call({ method: "GET", path: "/api/organizations" });
  const body = response.body as { organizations?: Array<{ id: string; name: string; admin: boolean; free?: boolean; plan_required?: boolean }>; new_organization_allowed?: boolean };
  if (!Array.isArray(body?.organizations) || body.organizations.some(org => !org || !/^(?:(?:stage|qa|development)_)?org_[A-Za-z0-9_-]+$/.test(org.id) || typeof org.name !== "string" || typeof org.admin !== "boolean")) throw configError("Organization list does not match the contract.");
  const tags = (org: { admin: boolean; free?: boolean; plan_required?: boolean }) => [org.admin && "admin", org.free === true && "free", org.plan_required === true && "plan required"].filter(Boolean).join(", ");
  const lines = body.organizations.map(org => `${validateDisplayName(org.name, "Organization name")}: ${org.id}${tags(org) ? ` (${tags(org)})` : ""}`);
  if (body.new_organization_allowed === false) lines.push("New organization: add projects to an existing organization; another needs Premium or Enterprise.");
  return { envelope: successEnvelope(body, { request_id: client.requestId }), exitCode: ExitCode.Success,
    human: lines.join("\n") || "No visible organizations." };
}, false);
export const handleOrganizationRename = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id || !/^(?:(?:stage|qa|development)_)?org_[A-Za-z0-9_-]+$/.test(id)) throw usageError("organization rename requires an organization ID.");
  const name = validateDisplayName(args.positionals[3], "Organization name");
  const identity = await identityForCommand(runtime, resolved);
  const client = clientFor(runtime, args, identity.apiUrl, identity.identityToken);
  const response = await client.call({ method: "PATCH", path: `/api/organizations/${encodeURIComponent(id)}`, body: { name } });
  const organization = response.body as { id: string; name: string };
  if (organization?.id !== id || validateDisplayName(organization.name, "Organization name") !== name) throw configError("Organization rename response does not match this request.");
  const listed = await accessibleProjects(args, runtime, identity);
  await cacheProjectContexts(runtime, identity, listed.projects, { identityToken: identity.identityToken });
  return { envelope: successEnvelope({ organization }, { request_id: client.requestId }), exitCode: ExitCode.Success, human: `Organization renamed: ${name} (${id})` };
}, false);
