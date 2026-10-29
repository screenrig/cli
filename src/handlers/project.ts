// Command handlers for the project commands, loaded on demand.
import { validateProjectCapabilities } from "../project-capabilities.js";
import { isResourceID } from "../generated/resource-ids.js";
import { cacheProjectContexts, contextFromProject, projectName as validateDisplayName, validateProjectContext } from "../project-context.js";
import { open } from "node:fs/promises";
import path from "node:path";
import { type Project, type ProjectCreate, type CreatedProject } from "../adapters/protocol.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../command-input.js";
import { requireToken } from "../client.js";
import { HEALTH_DEFAULT_WINDOW_MS, HEALTH_HOURLY_MAX_DAYS, SERIES_PAGE_SIZE, seriesWindow } from "../series.js";
import { resolveConfig, describeTokenPresence, hasToken, readConfigFile } from "../config.js";
import { accessClaims } from "../oauth.js";
import { headerValue, CREDITS_REMAINING_HEADER, observeCreditsRemaining, parseCreditsInteger } from "../credits.js";
import { successEnvelope, type Warning } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, configError, makeProblem, usageError } from "../problems.js";
import type { HttpMethod } from "../transport/types.js";
import type { CliRuntime } from "../runtime.js";
import { formatBytes } from "../media/progress.js";
import { runProjectExport, type ExportApi } from "../project-export.js";
import { downloadToFile } from "../report-export.js";
import { accessibleProjects, clientFor, commandHandler, humanLines, identityForCommand, jsonBody, missingCredentialError, oauthSessionFor, requireFlagValue, requirePrivateNoStore, simpleGet, simpleList, uptimeDays, type CommandResult, type ResolvedCommandConfig } from "../commands.js";


export const handleProjectShow = commandHandler(projectShow);
export const handleProjectList = commandHandler(projectList, false);
export const handleProjectCreate = commandHandler(projectCreate);
export const handleProjectUse = commandHandler(projectUse, false);
export const handleProjectMoves = commandHandler(projectMoves);
export const handleProjectMove = commandHandler(projectMove);
export const handleProjectOwnerTransfer = commandHandler(projectOwnerTransfer);
export const handleProjectDeletionPreview = commandHandler(projectDeletionPreview);
export const handleProjectDelete = commandHandler(projectDelete);

export const handleProjectCapabilities = commandHandler(projectCapabilities);

export const handleProjectRename = commandHandler(projectRename);

export async function projectShow(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/project" });
  // Presence only. The lookup segment of a credential identifies the live
  // token, so no part of the stored value is reported on stdout.
  const envelope = jsonBody(response, client.requestId, { token_present: hasToken(token) });
  const project = response.body as Project;
  const context = contextFromProject(project);
  if (resolved.projectId && context.project.id !== resolved.projectId) throw configError("Project response changed the command's target.");
  await cacheProjectContexts(runtime, resolved, [context], { credential: resolved.token });
  if (headerValue(response.headers, CREDITS_REMAINING_HEADER) === undefined) {
    observeCreditsRemaining(runtime, parseCreditsInteger(project.credit_remaining));
  }
  return {
    envelope,
    exitCode: ExitCode.Success,
    human: humanLines("Project", [
      ["id", project.id],
      ["name", project.name],
      ["revision", project.revision !== undefined ? String(project.revision) : undefined],
      ["credit_remaining", project.credit_remaining !== undefined ? String(project.credit_remaining) : undefined],
      ["token", describeTokenPresence(token)],
      ["request_id", client.requestId],
    ]),
  };
}

export const handleProjectToken = commandHandler(async (args, runtime, resolved) => {
  const stored = await readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir });
  if (!stored?.oauth) throw missingCredentialError(resolved);
  const raw = flagString(args.flags, "projects") ?? "";
  const projects = raw.split(/[\s,]+/).filter(Boolean);
  if (projects.some(id => !isResourceID(id, "project"))) throw usageError("--projects requires project IDs separated by commas or spaces.");
  const token = await oauthSessionFor(runtime, resolved).selectProjects(projects);
  return { envelope: successEnvelope({ projects: token ? Object.keys(accessClaims(token)?.projects ?? {}) : [] }),
    exitCode: ExitCode.Success, human: "Current token project subset updated." };
}, false);

export async function projectList(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const listed = await accessibleProjects(args, runtime, resolved);
  await cacheProjectContexts(runtime, listed.resolved, listed.projects, { identityToken: listed.resolved.identityToken });
  return { envelope: successEnvelope({ projects: listed.projects }, { request_id: listed.requestId }), exitCode: ExitCode.Success,
    human: listed.projects.map(item => `${item.organization.name} / ${item.project.name}: ${item.project.id}${typeof item.in_token === "boolean" ? ` (in token: ${item.in_token})` : ""}`).join("\n") || "No accessible projects." };
}

export async function projectUse(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!isResourceID(id, "project")) throw usageError("project use requires a project ID from project list.");
  const listed = await accessibleProjects(args, runtime, resolved);
  const selected = listed.projects.find(item => item.project.id === id);
  if (!selected) {
    throw new CliError(makeProblem("not_found", "Project not available", 404, `${id} is not a project this identity belongs to.`, {
      hint: "Pick an ID from project list; to join another project, sign in to it with screenrig login --project ID.",
      next: { command: "screenrig project list", reason: "Lists the projects this identity can select." },
    }));
  }
  if (selected.in_token === false) throw new CliError(makeProblem("project_not_in_token", "Project outside token", 403, "This project is outside the current token subset.", { next: { command: `screenrig project token --projects ${id}`, reason: "Request a token for consented projects. Membership discovery does not grant access." } }));
  await cacheProjectContexts(runtime, listed.resolved, [selected], { identityToken: listed.resolved.identityToken, select: id });
  return { envelope: successEnvelope(selected, { request_id: listed.requestId }), exitCode: ExitCode.Success,
    human: `Selected ${selected.organization.name} / ${selected.project.name} (${id})` };
}

export async function projectCreate(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const name = validateDisplayName(args.positionals[2]);
  const organizationId = flagString(args.flags, "organization-id");
  const organizationName = flagString(args.flags, "organization");
  if (organizationId && organizationName) throw usageError("Use one of --organization-id or --organization.");
  const identity = await identityForCommand(runtime, resolved);
  const client = clientFor(runtime, args, identity.apiUrl, identity.identityToken);
  const body: ProjectCreate = { name, ...(organizationId ? { organization_id: organizationId } : {}),
    ...(organizationName !== undefined ? { organization_name: validateDisplayName(organizationName, "Organization name") } : {}) };
  const response = await client.call({ method: "POST", path: "/api/projects", body, idempotent: true });
  if (!(headerValue(response.headers, "cache-control") ?? "").split(",").map(value => value.trim().toLowerCase()).includes("no-store")) {
    throw configError("The project create response did not prohibit storage.");
  }
  const context = validateProjectContext(response.body as CreatedProject);
  // Creating a project does not expand the current token subset.
  await cacheProjectContexts(runtime, identity, [context], { identityToken: identity.identityToken, select: context.project.id });
  return { envelope: successEnvelope({ project: context.project, organization: context.organization, ...(context.owner_user_id ? { owner_user_id: context.owner_user_id } : {}) }, { request_id: client.requestId }),
    exitCode: ExitCode.Success, human: `Created ${context.organization.name} / ${context.project.name} (${context.project.id})` };
}

export async function projectMoves(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/project/moves" });
  const organizations = (response.body as { organizations?: { id: string; name: string }[] }).organizations;
  if (!Array.isArray(organizations)) throw configError("Project move destinations do not match the contract.");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: organizations.map(item => `${item.name}: ${item.id}`).join("\n") || "No allowed destinations." };
}

export async function projectLifecycleWrite(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, method: HttpMethod, path: string, body: object): Promise<CommandResult> {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method, path, body });
  const context = validateProjectContext(response.body);
  if (context.project.id !== resolved.projectId) throw configError("Project lifecycle response changed the command's target.");
  await cacheProjectContexts(runtime, resolved, [context], { credential: resolved.token });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: `${context.organization.name} / ${context.project.name} (${context.project.id})` };
}

export async function projectMove(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const id = flagString(args.flags, "organization-id");
  if (!id) throw usageError("project move requires --organization-id from project moves.");
  return projectLifecycleWrite(args, runtime, resolved, "POST", "/api/project/move", { organization_id: id });
}

export async function projectOwnerTransfer(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const id = flagString(args.flags, "user-id");
  if (!id) throw usageError("project transfer-owner requires --user-id for an existing verified project member.");
  return projectLifecycleWrite(args, runtime, resolved, "PUT", "/api/project/owner", { user_id: id });
}

export async function projectDeletionPreview(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/project/deletion-preview" });
  const context = validateProjectContext(response.body);
  const preview = response.body as { allowed?: boolean; reason?: string; devices?: unknown[] };
  if (typeof preview.allowed !== "boolean" || !Array.isArray(preview.devices)) throw configError("Project deletion preview does not match the contract.");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: humanLines("Project deletion preview", [["name", context.project.name], ["revision", String(context.project.revision)], ["allowed", String(preview.allowed)], ["reason", preview.reason]]) };
}

export async function projectDelete(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const name = validateDisplayName(flagString(args.flags, "name"));
  const revision = flagNumber(args.flags, "revision");
  if (!flagBool(args.flags, "yes") || !Number.isInteger(revision) || !revision || revision < 1) {
    throw usageError("project delete requires --yes --name NAME --revision N matching project deletion-preview.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "DELETE", path: "/api/project", body: { name, revision } });
  if ((response.body as { id?: string })?.id !== resolved.projectId) throw configError("Project deletion response changed the command's target.");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: "Deleted project " + resolved.projectName + " (" + resolved.projectId + ")" };
}

/**
 * Read the authenticated project's plan, feature flags and effective server
 * capabilities. The set is the server's current decision for this project and
 * actor: a plan label or a numeric quota never implies permission here, and a
 * route denial still wins over a cached capability.
 */
export async function projectCapabilities(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/project/capabilities" });
  requirePrivateNoStore(response.headers, "Project capabilities response");
  const capabilities = validateProjectCapabilities(response.body);
  return {
    envelope: jsonBody(response, client.requestId, { token_present: hasToken(token) }),
    exitCode: ExitCode.Success,
    human: humanLines("Project capabilities", [
      ["project_id", capabilities.project_id],
      ["plan_id", capabilities.plan_id],
      ["features", `advertiser=${capabilities.features.advertiser} screens=${capabilities.features.screens}`],
      ["feature_revision", String(capabilities.feature_revision)],
      ["capabilities", [...capabilities.capabilities].sort().join(", ") || "(none)"],
      ["media_video_bytes", capabilities.media_video_bytes === undefined ? "(not stated)" : String(capabilities.media_video_bytes)],
      ["request_id", client.requestId],
    ]),
  };
}

export async function projectRename(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const name = args.positionals[2]?.trim();
  if (!name || [...name].length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) throw usageError("project rename requires NAME containing 1–60 characters without controls.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "PATCH", path: "/api/project", body: { name }, idempotent: true });
  const project = response.body as Project;
  let context: ReturnType<typeof contextFromProject>;
  try {
    context = contextFromProject(project);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    // The rename succeeded; reconcile the cached context from a fresh read instead of failing on the response's shape.
    context = contextFromProject((await client.call({ method: "GET", path: "/api/project" })).body as Project);
  }
  if (context.project.id !== resolved.projectId) throw configError("Rename response changed the command's target.");
  await cacheProjectContexts(runtime, resolved, [context], { credential: resolved.token });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: humanLines("Project renamed", [["id", project.id], ["name", project.name]]) };
}

export const handleProjectUptime = commandHandler(async (args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/uptime/daily", "Project uptime", uptimeDays(args)), true);

export const handleProjectHealthTrend = commandHandler(async (args, runtime, resolved) => {
  requireFlagValue(args, "from", "7d");
  requireFlagValue(args, "to", "now");
  const range = seriesWindow({
    from: flagString(args.flags, "from"), to: flagString(args.flags, "to"), fromFlag: "--from", toFlag: "--to",
    now: runtime.now(), defaultMs: HEALTH_DEFAULT_WINDOW_MS, maxDays: HEALTH_HOURLY_MAX_DAYS,
  });
  return simpleList(args, runtime, resolved, "/api/health/trend", "Project health trend",
    { from: range.from, to: range.to, limit: SERIES_PAGE_SIZE }, { cursorParam: "cursor", uncapped: true });
}, true);

/**
 * `project export DIR`: every read route a project has, written to a directory
 * in open formats (src/project-export.ts). Progress goes to stderr; the envelope
 * lists the sections, every file with its SHA-256 and the media counts.
 */
export const handleProjectExport = commandHandler(async (args, runtime, resolved) => {
  const directory = args.positionals[2];
  if (!directory) throw usageError("project export requires a directory: screenrig project export ./export.");
  const since = flagString(args.flags, "since");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const api: ExportApi = {
    get: async (pathName, query) => (await client.call({ method: "GET", path: pathName, query })).body,
    list: async (pathName, query) => {
      const response = await client.listAll(pathName, query, { uncapped: true });
      const items = (response.body as { items?: unknown[] } | undefined)?.items;
      return Array.isArray(items) ? items : [];
    },
    file: async (pathName, query, target, contentType) => {
      await downloadToFile(client, { path: pathName, query, target, contentType, what: pathName });
    },
    append: async (pathName, offset, target) => {
      const response = await client.download({ method: "GET", path: pathName, headers: offset > 0 ? { range: `bytes=${offset}-` } : undefined });
      if (!response.body) throw usageError(`${pathName} returned no body.`);
      // A server that ignored the range sent the whole object: start the file over.
      const handle = await open(target, offset > 0 && response.status === 206 ? "a" : "w", 0o600);
      try {
        for await (const chunk of response.body) {
          let written = 0;
          while (written < chunk.byteLength) written += (await handle.write(chunk, written, chunk.byteLength - written)).bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
  const result = await runProjectExport(api, {
    directory: path.resolve(runtime.cwd(), directory), media: !flagBool(args.flags, "no-media"), since, now: runtime.now(),
    progress: (line) => runtime.stderr.write(`${line}\n`),
  });
  const warnings: Warning[] = result.sections.filter((section) => section.status !== "ok").map((section) => ({
    code: section.status === "failed" ? "export_section_failed" : "export_section_skipped",
    message: `${section.name}: ${section.detail ?? section.status}`,
  }));
  const data = {
    directory: result.directory, complete: result.failed === 0, sections: result.sections, media: result.media,
    files: result.files.length, bytes: result.files.reduce((sum, file) => sum + file.bytes, 0),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings }),
    exitCode: ExitCode.Success,
    human: [
      `Project exported to ${result.directory}`,
      `  files: ${data.files} (${formatBytes(data.bytes)}), listed in export.json with their SHA-256`,
      `  media: ${result.media.listed} listed, ${result.media.downloaded} downloaded, ${result.media.kept} already complete, ${result.media.failed} failed`,
      ...result.sections.filter((section) => section.status !== "ok").map((section) => `  ${section.status}: ${section.name}: ${section.detail ?? ""}`),
      result.failed > 0 ? "  Run the same command again to continue: finished files are kept." : "  Run the same command again at any time to refresh the copy.",
    ].join("\n"),
  };
});
