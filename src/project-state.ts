import type { ResolvedConfig, ScreenRigConfig, StoredProjectState } from "./config.js";
import { configError } from "./problems.js";

const PROJECT_FIELDS = [
  "token", "project_name", "organization_id", "organization_name",
  "screen_provision", "browser_setup", "media_generate", "pending_writes",
] as const;

function storedProjects(config: ScreenRigConfig): Record<string, StoredProjectState> {
  const projects = config.projects ?? {};
  if (!projects || typeof projects !== "object" || Array.isArray(projects)
    || Object.values(projects).some(entry => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw configError("Stored project state is invalid; no request was sent.");
  }
  return projects;
}

/** A command holds its resolved target even when another process switches. */
export function projectConfigFor(config: ScreenRigConfig, resolved: ResolvedConfig): ScreenRigConfig {
  const projects = storedProjects(config);
  const id = resolved.projectId;
  // Retained clients still write the selected project's root aliases.
  if (id && config.project_id === id) return config;
  if (id && Object.hasOwn(projects, id)) {
    const entry = projects[id]!;
    const view = { ...config, project_id: id };
    for (const field of PROJECT_FIELDS) delete view[field];
    return { ...view, ...pickProjectState(entry) };
  }
  if (id && config.project_id !== id) {
    throw configError("The command's project credential is no longer stored. Select the project again before retrying.");
  }
  return config;
}

function pickProjectState(config: StoredProjectState): StoredProjectState {
  return Object.fromEntries(PROJECT_FIELDS.filter(field => config[field] !== undefined).map(field => [field, config[field]]));
}

/** Merge only this command's project slot. Other projects and global identity
 * state survive, and the last-used selection changes only through project use.
 * The current project's legacy fields remain mirrors for retained clients. */
export function withProjectConfig(config: ScreenRigConfig, resolved: ResolvedConfig, updated: ScreenRigConfig): ScreenRigConfig {
  const id = resolved.projectId;
  if (!id) return updated;
  const projects = { ...storedProjects(config) };
  // Capture a legacy selection before adding another slot; never strand its
  // pending generation or provisioning request during the first switch.
  if (config.project_id) {
    projects[config.project_id] = pickProjectState(config);
  }
  projects[id] = pickProjectState(updated);
  const result = { ...config, projects, updated_at: updated.updated_at ?? config.updated_at };
  if (config.project_id === id) {
    for (const field of PROJECT_FIELDS) delete result[field];
    return { ...result, ...projects[id] };
  }
  return result;
}

export function assertProjectCredential(config: ScreenRigConfig, resolved: ResolvedConfig): void {
  if ((config.token ?? (resolved.projectId ? config.identity_token : undefined)) !== resolved.token) {
    throw configError("The command's project credential changed. Retry with the current membership credential.");
  }
}

/** Select an already authenticated context without dropping another slot's retries. */
export function selectProject(config: ScreenRigConfig, id: string): ScreenRigConfig {
  const captured = config.project_id
    ? withProjectConfig(config, { projectId: config.project_id } as ResolvedConfig, config)
    : config;
  const slot = storedProjects(captured)[id];
  if (!slot || (!slot.token && !config.identity_token)) {
    throw configError("The selected project has no stored credential. Run project list and project use again.");
  }
  const selected = { ...captured, project_id: id };
  for (const field of PROJECT_FIELDS) delete selected[field];
  return { ...selected, ...pickProjectState(slot) };
}
