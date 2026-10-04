import type { Project } from "./adapters/protocol.js";
import type { ApiClient } from "./client.js";
import { readConfigFile, withConfigLock, writeConfigAtomic, type ResolvedConfig } from "./config.js";
import { isResourceID } from "./generated/resource-ids.js";
import { CliError, configError } from "./problems.js";
import { contextFromProject } from "./project-context.js";
import { projectConfigFor, withProjectConfig } from "./project-state.js";
import type { CliRuntime } from "./runtime.js";

export interface EnrollmentCleanupResult {
  project_id: string;
  destination_project_id: string;
  connection_id: string;
  status: "deleted" | "retained" | "pending";
}

/** This step never changes the newly approved membership or current selection.
 * The server rechecks emptiness and coverage inside its deletion transaction. */
export async function cleanupEnrollmentProject(runtime: CliRuntime, resolved: ResolvedConfig,
  clientFor: (token: string, projectId: string) => ApiClient): Promise<EnrollmentCleanupResult | undefined> {
  const fs = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  const saved = await readConfigFile(resolved.configPath, fs);
  const cleanup = saved?.enrollment_cleanup;
  if (!cleanup) return;
  if (!isResourceID(cleanup.project_id, "project") || !isResourceID(cleanup.destination_project_id, "project")
    || cleanup.project_id === cleanup.destination_project_id || cleanup.agent_id !== saved.agent_id
    || saved.enrollment_project?.project_id !== cleanup.project_id || saved.enrollment_project.agent_id !== cleanup.agent_id
    || saved.api_url.replace(/\/+$/, "") !== resolved.apiUrl) throw configError("Enrollment cleanup provenance changed; no deletion was sent.");
  const source = { ...resolved, projectId: cleanup.project_id };
  const scoped = projectConfigFor(saved, source);
  const token = scoped.token ?? saved.identity_token;
  const result = (status: EnrollmentCleanupResult["status"]): EnrollmentCleanupResult => ({ ...cleanup, status });
  const finish = async (deleted: boolean): Promise<void> => {
    await withConfigLock(resolved.configPath, fs, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
      const current = await readConfigFile(resolved.configPath, fs);
      if (!current || current.agent_id !== cleanup.agent_id || current.api_url.replace(/\/+$/, "") !== resolved.apiUrl
        || JSON.stringify(current.enrollment_cleanup) !== JSON.stringify(cleanup)) throw configError("Cleanup state changed before its result was stored.");
      let updated = current;
      if (deleted) {
        const view = projectConfigFor(current, source);
        if ((view.token ?? current.identity_token) !== token) throw configError("Cleanup credential changed before its result was stored.");
        const { token: _token, screen_provision: _provision, browser_setup: _browser, media_generate: _generation, pending_writes: _writes, ...rest } = view;
        updated = withProjectConfig(current, source, rest);
        delete updated.enrollment_project;
      }
      delete updated.enrollment_cleanup;
      await writeConfigAtomic(resolved.configPath, { ...updated, updated_at: runtime.now().toISOString() }, fs);
    });
  };
  if (!token) { await finish(false); return result("retained"); }
  const client = clientFor(token, cleanup.project_id);
  try {
    const response = await client.call({ method: "GET", path: "/api/v1/project/deletion-preview" });
    const preview = response.body as { project: Project; allowed: boolean; devices: unknown[] };
    const context = contextFromProject(preview.project);
    if (context.project.id !== cleanup.project_id || typeof preview.allowed !== "boolean" || !Array.isArray(preview.devices)) throw configError("Cleanup preview changed the saved project target.");
    if (!preview.allowed || context.project.name !== "Screens" || preview.devices.length
      || context.project.used_bytes !== 0 || context.project.reserved_bytes !== 0 || context.project.screen_count !== 0) {
      await finish(false); return result("retained");
    }
    const deletion = await client.call({ method: "DELETE", path: "/api/v1/project", body: { name: "Screens", revision: context.project.revision, empty_only: true } });
    if ((deletion.body as { id?: string })?.id !== cleanup.project_id) throw configError("Cleanup deletion changed the saved project target.");
    await finish(true);
    return result("deleted");
  } catch (error) {
    if (error instanceof CliError && ["project_delete_blocked", "project_delete_confirmation", "unauthorized", "forbidden", "not_found"].includes(error.problem.code)) {
      await finish(false); return result("retained");
    }
    // Even a successful deletion can lose its response. Keep its marker, and
    // inspect again on the next connect invocation instead of requesting approval.
    return result("pending");
  }
}
