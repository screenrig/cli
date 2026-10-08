import type { Project, ProjectContext } from "./adapters/protocol.js";
import type { ResolvedConfig, ScreenRigConfig } from "./config.js";
import { readConfigFile, sameCredential, withConfigLock, writeConfigAtomic } from "./config.js";
import { isResourceID } from "./generated/resource-ids.js";
import { configError, usageError } from "./problems.js";
import { projectConfigFor, selectProject, withProjectConfig } from "./project-state.js";
import type { CliRuntime } from "./runtime.js";

export interface ResultContext {
  project: { id: string; name: string };
  organization?: { id: string; name: string };
}

const contexts = new WeakMap<object, ResultContext>();
export function resultContext(runtime: object): ResultContext | undefined { return contexts.get(runtime); }
export function clearResultContext(runtime: object): void { contexts.delete(runtime); }
export function formatResultContext(runtime: object): string {
  const context = resultContext(runtime);
  if (!context) return "";
  const safe = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, character => JSON.stringify(character).slice(1, -1));
  return `organization: ${safe(context.organization?.name ?? "(unknown)")}\nproject: ${safe(context.project.name)} (${safe(context.project.id)})`;
}
export function setResultContext(runtime: object, resolved: ResolvedConfig): void {
  if (!resolved.projectId || !resolved.projectName) return;
  contexts.set(runtime, {
    project: { id: resolved.projectId, name: resolved.projectName },
    ...(resolved.organizationId && resolved.organizationName ? { organization: { id: resolved.organizationId, name: resolved.organizationName } } : {}),
  });
}

export function projectName(value: unknown, label = "Project name"): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > 60 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw usageError(`${label} must contain 1–60 characters without controls.`);
  }
  return value.trim();
}

export function validateProjectContext(value: unknown): ProjectContext {
  const context = value as Partial<ProjectContext> | undefined;
  if (!context?.project || !isResourceID(context.project.id, "project") || typeof context.project.name !== "string"
    || !context.project.name || !context.organization || typeof context.organization.id !== "string"
    || !/^(?:(?:stage|qa|development)_)?org_[A-Za-z0-9_-]+$/.test(context.organization.id)
    || typeof context.organization.name !== "string" || !context.organization.name
    || (context.project.organization_id && context.project.organization_id !== context.organization.id)) {
    throw configError("Project response does not match its organization and project context.");
  }
  return { project: context.project, organization: { id: context.organization.id, name: context.organization.name },
    ...(typeof context.owner_user_id === "string" ? { owner_user_id: context.owner_user_id } : {}) };
}

export function contextFromProject(project: Project): ProjectContext {
  return validateProjectContext({ project, organization: { id: project.organization_id, name: project.organization_name } });
}

/** Cache server-verified names; select only when that is this command's purpose. */
export async function cacheProjectContexts(
  runtime: CliRuntime, resolved: ResolvedConfig, values: ProjectContext[],
  options: { select?: string; token?: string; credential?: string; identityToken?: string; agentId?: string; connectionId?: string } = {},
): Promise<ResolvedConfig> {
  const verified = values.map(validateProjectContext);
  const fs = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  await withConfigLock(resolved.configPath, fs, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    let current = await readConfigFile(resolved.configPath, fs);
    if (!current || current.api_url.replace(/\/+$/, "") !== resolved.apiUrl) throw configError("Stored API configuration changed before project context persistence.");
    if (options.identityToken && !sameCredential(current.identity_token, options.identityToken, "identity")) throw configError("Identity credential changed before project selection.");
    if (options.agentId && current.agent_id && current.agent_id !== options.agentId) throw configError("Stored identity changed before credential persistence.");
    if (options.connectionId && current.agent_connection?.connection_id !== options.connectionId) throw configError("Pending agent connection changed before activation persistence.");
    if (options.credential && !sameCredential(projectConfigFor(current, resolved).token ?? current.identity_token, options.credential)) {
      throw configError("Project credential changed before its context was stored.");
    }
    for (const context of verified) {
      const id = context.project.id;
      const view = current.projects?.[id] ? projectConfigFor(current, { ...resolved, projectId: id })
        : current.project_id === id || (!current.project_id && options.credential && current.token === options.credential) ? current : { ...current, project_id: id, token: undefined, screen_provision: undefined, browser_setup: undefined, media_generate: undefined, pending_writes: undefined };
      current = withProjectConfig(current, { ...resolved, projectId: id }, {
        ...view,
        project_name: context.project.name,
        organization_id: context.organization.id,
        organization_name: context.organization.name,
        ...(options.select === id && options.token ? { token: options.token } : {}),
        updated_at: runtime.now().toISOString(),
      });
    }
    if (options.select) current = selectProject(current, options.select);
    else if (!current.project_id && options.credential && verified.length === 1) current = selectProject(current, verified[0]!.project.id);
    if (options.agentId) current.agent_id = options.agentId;
    if (options.connectionId && options.select && options.token) {
      if (current.agent_connection?.pending_token && current.agent_connection.pending_token !== options.token) throw configError("Pending credential changed before activation persistence.");
      const enrollment = current.enrollment_project;
      if (enrollment && enrollment.agent_id === options.agentId && enrollment.project_id !== options.select) {
        current.enrollment_cleanup = { ...enrollment, destination_project_id: options.select, connection_id: options.connectionId };
      }
      delete current.agent_connection;
    }
    await writeConfigAtomic(resolved.configPath, current as ScreenRigConfig, fs);
  });
  const selected = verified.find(context => context.project.id === (options.select ?? resolved.projectId))
    ?? (!resolved.projectId && options.credential && verified.length === 1 ? verified[0] : undefined);
  if (!selected) return resolved;
  const updated = { ...resolved, projectId: selected.project.id, projectName: selected.project.name,
    organizationId: selected.organization.id, organizationName: selected.organization.name,
    ...(options.token ? { token: options.token } : {}), ...(options.agentId ? { agentId: options.agentId } : {}) };
  setResultContext(runtime, updated);
  return updated;
}
