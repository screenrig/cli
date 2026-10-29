import { RESOURCE_ID_PATTERNS } from "./generated/resource-ids.js";
import { playlistAnswerWarnings, withoutAnswerWarnings } from "./playlist-warnings.js";
import { WriteRecovery } from "./write-recovery.js";
import { cacheProjectContexts, clearResultContext, contextFromProject, formatResultContext, resultContext, setResultContext, validateProjectContext } from "./project-context.js";
import { AGGREGATE_MAX_DAYS } from "./playback-export.js";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { memoryConfigFs } from "./memory-config.js";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { TEMPORARY_PROTOCOL_VERSION, type Project, type ProjectContextList, type Operation, type ReviewPending } from "./adapters/protocol.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "./command-input.js";
import { ApiClient, RequestIds, requireToken, type ListAllOptions } from "./client.js";
import { UPTIME_MAX_DAYS } from "./series.js";
import { resolveConfig, readConfigFile, type ScreenRigConfig } from "./config.js";
import { attachOperationLogger, loggerOf, loggingTransport } from "./log/index.js";
import { accessClaims, serviceCredentialsFromEnv, type ServiceClientCredentials } from "./oauth.js";
import { pendingReviewLines, pendingReviewWarning, reviewNext, reviewNoteHeaders } from "./reviews.js";
import { OAuthSession, refreshExpiryDays, type SessionRuntime } from "./oauth-session.js";
import { successEnvelope, type Warning } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { CliError, configError, makeProblem, notEnrolledError, usageError } from "./problems.js";
import type { Transport } from "./transport/types.js";
import type { CliRuntime } from "./runtime.js";
import { FetchTransport } from "./transport/http.js";
import { quotedRevision } from "./if-match.js";
import { downloadReportFile, reportFileResult, reportFormat, wantsReportFile, type ReportFormat } from "./report-export.js";
import { createProgressReporter, silentProgressReporter, type ProgressReporter } from "./media/progress.js";
import { DEFAULT_CODEC, DEFAULT_MAX_FPS, DEFAULT_WEBP_QUALITY, MAX_EDGE, type TranscodeCodec, type TranscodeOptions } from "./media/transcode.js";
import { NotesApi, resourceNoteLines, resourceNotesWarning, type NoteAboutType, type NoteList } from "./agent-notes.js";
import { CLI_VERSION, cliDistribution } from "./version.js";


export { CLI_VERSION };

export interface CommandResult {
  envelope: ReturnType<typeof successEnvelope<unknown>>;
  exitCode: ExitCode;
  human: string;
  /** Help defaults to text; streams have already emitted their output. */
  output?: "help" | "stream";
  /**
   * Set when the answer cannot be fetched again except by replay (a webhook
   * signing secret). The saved write key is kept until the output boundary has
   * flushed this result; it then calls afterOutput to clear it.
   */
  keepRecoveryUntilOutput?: boolean;
  afterOutput?: () => Promise<void>;
}


/** One plain ASCII addr-spec with an unquoted local part and dotted DNS domain. */
export function isPlainContactEmail(email: string): boolean {
  const parts = email.split("@");
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";
  const localValid = local.length > 0 && local.length <= 64
    && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")
    && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local);
  const labels = domain.split(".");
  const domainValid = labels.length >= 2 && labels.every((label) => label.length > 0 && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
  return email.length >= 3 && email.length <= 254 && parts.length === 2 && localValid && domainValid;
}

export function transportFor(runtime: CliRuntime, apiUrl: string, token?: string): Transport {
  const base = runtime.transport ?? new FetchTransport(apiUrl, token);
  return loggingTransport(base, loggerOf(runtime));
}

/** The invocation's OAuth session: access-token renewal and logout. */
export const oauthSessions = new WeakMap<CliRuntime, OAuthSession>();

export function sessionRuntime(runtime: CliRuntime): SessionRuntime {
  return { fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir }, now: runtime.now, sleep: runtime.sleep, logger: loggerOf(runtime) };
}

export function oauthSessionFor(runtime: CliRuntime, resolved: { configPath: string; apiUrl: string }): OAuthSession {
  let session = oauthSessions.get(runtime);
  if (!session) {
    session = new OAuthSession(resolved.configPath, resolved.apiUrl, transportFor(runtime, resolved.apiUrl), sessionRuntime(runtime), serviceCredentials.get(runtime));
    oauthSessions.set(runtime, session);
  }
  return session;
}

/** A stream's bearer, renewed before each (re)connect: an agent stream closes when its access token expires. */
export async function streamToken(runtime: CliRuntime, token: string): Promise<string> {
  const claims = accessClaims(token);
  const session = oauthSessions.get(runtime);
  if (!session || !claims?.sid) return token;
  return (await session.accessFor(undefined)) ?? token;
}

/**
 * Commands that read credentials without requiring a project credential up
 * front. They renew credentials like authenticated ones; local commands never
 * touch the network for it.
 */
const CREDENTIAL_COMMANDS = new Set(["project list", "project use", "agent status"]);

/** Commands that send a stored credential, besides authenticated and credential commands. */
const STORED_CREDENTIAL_COMMANDS = new Set(["logout", "agent enroll", "agent disconnect", "agent revoke-identity"]);

/** A config that holds only a token from before sign-in: no request accepts it, so nothing is sent. */
export function credentialRetiredError(): CliError {
  return new CliError(makeProblem("credential_retired", "Credential retired", 401,
    "This installation's stored credential is no longer accepted. Run screenrig login to sign it in; a person approves it in the dashboard. To create a new project instead, screenrig agent enroll --email ADDRESS --organization NAME replaces it. Nothing was sent.", {
      next: { command: "screenrig login", reason: "Signs this installation in; a person approves it in the dashboard." },
    }), ExitCode.Auth);
}

/** Commands that act on the identity rather than the selected project. */
const IDENTITY_COMMANDS = new Set(["project list", "project use", "project create", "project token"]);

export const writeRecoveries = new WeakMap<CliRuntime, WriteRecovery>();

const invocationRequestIds = new WeakMap<CliRuntime, RequestIds>();
const invocationTargets = new WeakMap<CliRuntime, ResolvedCommandConfig>();

/** One RequestIds per invocation, so `--request-id` reaches only the first HTTP request however many clients a command builds. */
function requestIdsFor(runtime: CliRuntime, args: ParsedArgs): RequestIds {
  let ids = invocationRequestIds.get(runtime);
  if (!ids) {
    ids = new RequestIds(flagString(args.flags, "request-id"));
    invocationRequestIds.set(runtime, ids);
  }
  return ids;
}

export function clientFor(runtime: CliRuntime, args: ParsedArgs, apiUrl: string, token?: string, recovery?: WriteRecovery): ApiClient {
  return new ApiClient({
    transport: transportFor(runtime, apiUrl, token),
    token,
    auth: oauthSessions.get(runtime),
    projectId: token && token === invocationTargets.get(runtime)?.token ? invocationTargets.get(runtime)?.projectId : undefined,
    requestIds: requestIdsFor(runtime, args),
    idempotencyKey: flagString(args.flags, "idempotency-key"),
    timeoutMs: flagNumber(args.flags, "timeout"),
    writeRecovery: recovery ?? (token ? writeRecoveries.get(runtime) : undefined),
    creditsOwner: runtime,
    logger: loggerOf(runtime),
  });
}

export function jsonBody(
  response: { body: unknown; headers: Record<string, string> },
  requestId: string,
  extra?: Record<string, unknown>,
  warnings: Warning[] = [],
) {
  const body = (response.body ?? {}) as Record<string, unknown>;
  return successEnvelope(
    extra ? { ...body, ...extra } : body,
    {
      request_id: (body.request_id as string | undefined) ?? response.headers["x-request-id"] ?? requestId,
      operation_id: body.operation_id as string | undefined,
      warnings: [...warnings, ...(response.headers.warning ? [{ code: "server_warning", message: response.headers.warning }] : [])],
    },
  );
}

/** The --note of a review-class write as its request header. */
export function reviewNoteFrom(args: ParsedArgs): Record<string, string> {
  return reviewNoteHeaders(flagString(args.flags, "note"));
}

/**
 * A review-class write that became a review under Propose access (HTTP 202
 * pending_review): a success, exit 0, data is the answer plus next.
 */
export function pendingReviewResult(response: { body: unknown; headers: Record<string, string> }, pending: ReviewPending, requestId: string, extra?: Record<string, unknown>): CommandResult {
  const lifted = playlistAnswerWarnings(response.body);
  return {
    envelope: jsonBody({ ...response, body: withoutAnswerWarnings(response.body) }, requestId, { ...extra, next: reviewNext(pending.review.id) }, [pendingReviewWarning(pending.review), ...lifted]),
    exitCode: ExitCode.Success,
    human: [...pendingReviewLines(pending.review), ...lifted.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}

/**
 * A playlist write that applied live. The answer's warnings (a page the
 * Player web app cannot frame) move from data into the envelope's warnings and
 * the human output, so an agent reads them like every other warning.
 */
export function playlistWriteResult(response: { body: unknown; headers: Record<string, string> }, requestId: string, title: string): CommandResult {
  const lifted = playlistAnswerWarnings(response.body);
  return {
    envelope: jsonBody({ ...response, body: withoutAnswerWarnings(response.body) }, requestId, undefined, lifted),
    exitCode: ExitCode.Success,
    human: [title, ...lifted.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}

export function humanLines(title: string, fields: Array<[string, string | undefined]>): string {
  const lines = [title];
  for (const [key, value] of fields) {
    if (value) {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

export function streamEnvelope(runtime: CliRuntime, data: unknown, requestId: string) {
  const context = resultContext(runtime);
  return { ...successEnvelope(data, { request_id: requestId }), ...(context ? { context } : {}) };
}

export type CommandHandler = (args: ParsedArgs, runtime: CliRuntime) => Promise<CommandResult>;
export type ResolvedCommandConfig = Awaited<ReturnType<typeof resolveConfig>>;

/** A service client's credentials for this invocation (SCREENRIG_CLIENT_ID mode). */
const serviceCredentials = new WeakMap<CliRuntime, ServiceClientCredentials>();

/** Commands that act as an agent installation; a service-client run has none. */
const AGENT_ONLY_COMMANDS = new Set(["login", "logout", "project token", "agent enroll", "agent disconnect", "agent revoke-identity"]);

/**
 * SCREENRIG_CLIENT_ID mode: the run authenticates as a service client. Its
 * config, lock and token live in memory for this invocation only, so the
 * stored config is neither read nor written.
 */
function withServiceClient(run: CommandHandler): CommandHandler {
  return async (args, runtime) => {
    const service = await serviceCredentialsFromEnv(runtime.env, (file) => readFile(file, "utf8"));
    if (!service) return run(args, runtime);
    const command = args.command.slice(0, 2).join(" ");
    if (AGENT_ONLY_COMMANDS.has(command) || AGENT_ONLY_COMMANDS.has(args.command[0] ?? "")) {
      throw usageError(`${command} acts as an agent installation; this run is a service client because SCREENRIG_CLIENT_ID is set. Nothing was sent.`);
    }
    const root = path.join(tmpdir(), `screenrig-service-${process.pid}-${randomBytes(8).toString("hex")}`);
    const stored = runtime.fs;
    runtime.fs = memoryConfigFs(stored, root);
    serviceCredentials.set(runtime, service);
    try {
      return await run({ ...args, flags: { ...args.flags, config: path.join(root, "config.json") } }, runtime);
    } finally {
      runtime.fs = stored;
      serviceCredentials.delete(runtime);
    }
  };
}

/** The next step for an installation without a credential: sign in, enroll, or resume a pending enrollment. */
export function missingCredentialError(resolved: ResolvedCommandConfig): CliError {
  if (resolved.signedOut) {
    return notEnrolledError("This installation is signed out.", {
      command: "screenrig login",
      reason: "Sign this installation in again; a person approves it in the dashboard.",
    });
  }
  if (resolved.lastAgent) {
    return notEnrolledError("This installation is disconnected and cannot run project commands.", {
      command: "screenrig agent enroll --email ADDRESS --organization NAME",
      reason: "Ask the user for their contact email, then create a new project agent. Use screenrig login only when the user asked to join an existing project.",
    });
  }
  return notEnrolledError("This installation is not enrolled. Enrollment is an explicit step and is never a side effect of another command.", {
    command: resolved.enrollment
      ? "screenrig agent enroll"
      : "screenrig agent enroll --email ADDRESS --organization NAME",
    reason: resolved.enrollment
      ? "Resume the exact pending enrollment before running pairing or another project command."
      : "Create the first agent with unverified contact metadata, then retry the original command.",
  });
}

/** Bind context to the selected project, or the token's sole project. */
export async function resolveProjectContext(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<ResolvedCommandConfig> {
  const projects = accessClaims(resolved.token)?.projects;
  if (projects && !resolved.projectId) {
    const ids = Object.keys(projects);
    if (ids.length !== 1) return resolved;
    resolved = { ...resolved, projectId: ids[0], projectName: undefined, organizationId: undefined, organizationName: undefined };
  }
  // clientFor must route the context read and subsequent work to this target.
  invocationTargets.set(runtime, resolved);
  if (!resolved.projectName || !resolved.organizationName) {
    const client = clientFor(runtime, args, resolved.apiUrl, resolved.token);
    const response = await client.call({ method: "GET", path: "/api/project" });
    const context = contextFromProject(response.body as Project);
    if (resolved.projectId && context.project.id !== resolved.projectId) throw configError("Project credential resolved to a different project.");
    resolved = await cacheProjectContexts(runtime, resolved, [context], { credential: resolved.token });
    invocationTargets.set(runtime, resolved);
  }
  return resolved;
}

/** Prepare configuration, logging and credential guidance once for a bound leaf. */
export function commandHandler(
  handler: (args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig) => Promise<CommandResult>,
  authenticated = true,
): CommandHandler {
  const run: CommandHandler = async (args, runtime) => {
    const repair = flagBool(args.flags, "repair-config");
    let resolved = await resolveConfig({ flags: args.flags, fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir }, repair });
    if (args.command[0] === "project" && args.command[1] === "create" && resolved.identityToken && !flagString(args.flags, "project-id")) {
      const current = await readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir });
      if (!resolved.projectId || Object.keys(current?.identity_writes ?? {}).length) {
        resolved = { ...resolved, token: resolved.identityToken, projectId: undefined, projectName: undefined,
          organizationId: undefined, organizationName: undefined, identityWriteScope: true };
      }
    }
    await attachOperationLogger(runtime, args, resolved);
    const commandName = args.command.slice(0, 2).join(" ");
    // agent enroll replaces a retired credential itself (agentEnroll).
    if (resolved.retiredCredential && commandName !== "agent enroll" && (authenticated || CREDENTIAL_COMMANDS.has(commandName)
      || STORED_CREDENTIAL_COMMANDS.has(commandName) || STORED_CREDENTIAL_COMMANDS.has(args.command[0] ?? ""))) {
      throw credentialRetiredError();
    }
    const session = oauthSessionFor(runtime, resolved);
    if (authenticated || CREDENTIAL_COMMANDS.has(commandName)) {
      try {
        resolved = await session.prepare(resolved, { identity: IDENTITY_COMMANDS.has(commandName) });
      } catch (error) {
        oauthSessions.delete(runtime);
        throw error;
      }
    }
    invocationTargets.set(runtime, resolved);
    setResultContext(runtime, resolved);
    if (authenticated && !resolved.token) {
      oauthSessions.delete(runtime);
      throw missingCredentialError(resolved);
    }
    // Specialized enrollment, generation, upload/bundle, and handoff flows own
    // their recovery. Ordinary mutations share the durable request ledger.
    const [group, action] = args.command;
    // Sign-in reset is unauthenticated but still retains a durable retry key.
    const ordinary = (group === "dashboard" && action === "reset-sign-in")
      || Boolean(authenticated && resolved.token && (
        ["kv", "card", "comment", "feedback", "support", "operations", "notes"].includes(group ?? "") ||
        (group === "app" && ["upload", "update", "rename"].includes(action ?? "")) ||
        (group === "playlist" && ["create", "update", "patch", "rename", "delete", "promote"].includes(action ?? "")) ||
        (group === "reviews" && action === "withdraw") ||
        (group === "media" && ["update", "delete", "restore", "version"].includes(action ?? "")) ||
        // A screenshot is an observation: every run requests a new capture.
        (group === "screen" && !["provision", "publish", "screenshot"].includes(action ?? "")) ||
        group === "invitations" || group === "webhooks" || group === "notifications" || group === "alerts" || group === "source" || group === "fleet-links" || group === "triggers" || group === "campaign" || (group === "project" && ["rename", "create"].includes(action ?? ""))
      ));
    let recovery: WriteRecovery | undefined;
    try {
      if (authenticated && resolved.token && args.command[0] !== "agent"
        && !(args.command[0] === "project" && ["list", "create", "use"].includes(args.command[1] ?? ""))) {
        resolved = await resolveProjectContext(args, runtime, resolved);
      }
      recovery = ordinary ? new WriteRecovery(resolved, runtime, args.command.slice(0, 2).join(" ")) : undefined;
      if (recovery) writeRecoveries.set(runtime, recovery);
      let result = await handler(args, runtime, resolved);
      const expiring = signInExpiryWarning((await readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir }).catch(() => undefined))?.oauth, runtime.now());
      if (expiring && result.output !== "stream") {
        result = { ...result, envelope: { ...result.envelope, warnings: [...(result.envelope.warnings ?? []), expiring] } };
      }
      const owner = (result.envelope.data as { project_id?: unknown } | undefined)?.project_id;
      if (typeof owner === "string" && owner !== resolved.projectId) clearResultContext(runtime);
      const context = resultContext(runtime);
      const contextual = context ? { ...result, envelope: { ...result.envelope, context }, human: result.output === "stream" ? result.human : `${formatResultContext(runtime)}${result.human ? "\n" + result.human : ""}` } : result;
      if (recovery && result.keepRecoveryUntilOutput) {
        const retainedRecovery = recovery;
        return { ...contextual, afterOutput: () => retainedRecovery.finish() };
      }
      await recovery?.finish();
      return contextual;
    } catch (caught) {
      const error = caught instanceof CliError && caught.problem.code === "insufficient_access" && serviceCredentials.get(runtime)
        ? serviceClientAccessRefusal(caught)
        : caught;
      if (recovery?.hasPending && error instanceof CliError) {
        // Only an unknown outcome (timeout, network, 5xx) keeps a replayable key.
        // A refusal or a local validation error means a rerun must start afresh.
        const status = error.problem.status;
        if (typeof status === "number" && status < 500 && status !== 408) {
          await recovery.finish();
          throw error;
        }
        throw new CliError(error.problem, error.exitCode, [...error.warnings, {
          code: "write_recovery_saved",
          message: "The outcome of this write is unknown, so its key is saved locally. Rerun the same command with unchanged input to reuse it; the server returns work that already happened instead of repeating it. screenrig recovery list shows writes still unresolved.",
        }]);
      }
      throw error;
    } finally {
      writeRecoveries.delete(runtime);
      invocationRequestIds.delete(runtime);
      invocationTargets.delete(runtime);
      oauthSessions.delete(runtime);
    }
  };
  return withServiceClient(run);
}

/**
 * 403 insufficient_access for a service client: it cannot sign in again, so
 * the login next action does not apply; its level is chosen when it is
 * created. A cap hint or a write's own hint (no login next) stays as it is.
 */
function serviceClientAccessRefusal(error: CliError): CliError {
  if (error.problem.next?.argv?.[0] !== "login") return error;
  const { next: _login, ...problem } = error.problem;
  return new CliError({ ...problem, hint: "This service client's access level cannot do this. Its access is chosen when it is created (service-client create --access manage)." }, error.exitCode, error.warnings);
}

export const handleVersion: CommandHandler = async () => {
  const distribution = cliDistribution();
  return {
    envelope: successEnvelope({ version: CLI_VERSION, protocol_adapter: TEMPORARY_PROTOCOL_VERSION, distribution }),
    exitCode: ExitCode.Success,
    human: `screenrig ${CLI_VERSION}\nDistribution: ${distribution.kind}\n${distribution.agent_setup}`,
  };

};

export function requirePrivateNoStore(headers: Record<string, string>, context: string): void {
  if (headers["cache-control"] !== "private, no-store") {
    throw usageError(`${context} did not return the required private, no-store cache policy.`);
  }
}

/** Identity is a scope of the sign-in's access token, renewed like any other. */
export async function identityForCommand(runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<ResolvedCommandConfig> {
  const session = oauthSessionFor(runtime, resolved);
  const stored = await readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir });
  if (!stored?.oauth && !session.serviceMode) throw missingCredentialError(resolved);
  const identityToken = await session.identityToken();
  if (!identityToken) {
    throw new CliError(makeProblem("insufficient_access", "Insufficient access", 403,
      session.serviceMode
        ? "A service client acts on its own project and has no identity access, so it cannot list, select or create projects."
        : "This sign-in covers one project and has no identity access, so it cannot list or create projects.", {
        next: { command: "screenrig login", reason: "Sign in again; the approval grants identity access with the project capability." },
      }), ExitCode.Auth);
  }
  return { ...resolved, identityToken };
}

export async function accessibleProjects(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<{ resolved: ResolvedCommandConfig; projects: ProjectContextList["projects"]; requestId: string }> {
  const identity = await identityForCommand(runtime, resolved);
  const client = clientFor(runtime, args, identity.apiUrl, identity.identityToken);
  const response = await client.call({ method: "GET", path: "/api/projects" });
  const body = response.body as ProjectContextList;
  if (!Array.isArray(body?.projects)) throw configError("Project list does not match the generated contract.");
  const projects = body.projects.map(item => ({ ...validateProjectContext(item), ...(typeof item.in_token === "boolean" ? { in_token: item.in_token } : {}) }));
  if (new Set(projects.map(item => item.project.id)).size !== projects.length) throw configError("Project list contains duplicate project IDs.");
  return { resolved: identity, projects, requestId: client.requestId };
}

/** One comma-separated option expanded to values; no empty entry is allowed. */
export function adsListOption(value: string | undefined, option: string): string[] {
  if (value === undefined) return [];
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => item.length === 0)) {
    throw usageError(`--${option} must be a comma-separated list without empty entries.`);
  }
  return items;
}

/** Link URLs are an explicit one-time output, never logging or recovery metadata. */
/** The scope an uploader invitation or service client carries: the folders and playlists it works in. */
export function uploadScopeFromArgs(args: ParsedArgs, subject: string, withAccess: boolean): { playlist_ids: string[]; folder_ids: string[]; access?: string } {
  const folders = adsListOption(flagString(args.flags, "folder-id"), "folder-id");
  const playlists = adsListOption(flagString(args.flags, "playlist-id"), "playlist-id");
  if (!folders.length) throw usageError(`${subject} needs at least one --folder-id MFD_ID (comma-separated): an uploader works in media folders. media folder list shows them.`);
  for (const id of folders) mediaFolderId(id, "--folder-id");
  for (const id of playlists) if (!RESOURCE_ID_PATTERNS.playlist.test(id)) throw usageError("--playlist-id takes playlist IDs (pl_...); playlist list shows them.");
  const access = withAccess ? flagString(args.flags, "access") : undefined;
  return { playlist_ids: playlists, folder_ids: folders, ...(access !== undefined ? { access } : {}) };
}

/** Name a missing or unusable input file before any tool or request runs on it. */
export async function requireInputFile(resolved: string, given: string): Promise<void> {
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw usageError(`${given} does not exist.`);
    throw usageError(`${given} cannot be read.`);
  }
  if (info.isDirectory()) throw usageError(`${given} is a directory; pass a file.`);
}

/** The report commands that also write their route's rows as a file (--format csv, xlsx or pdf), by command and file name stem. */
const REPORT_FILE_COMMANDS: Record<string, string> = {
  "project uptime": "project-uptime",
  "project health-trend": "health-trend",
  "screen uptime": "screen-uptime",
  "screen health-history": "screen-health-history",
  "playback totals": "play-totals",
  "playback completeness": "play-completeness",
};

/**
 * `--format csv|xlsx|pdf` of a report command: the server writes the file (the
 * route's format member, every page of it) and this saves it to --output, by
 * default ./<name>.<format>; - is not accepted for a binary file. json (the
 * default) stays the command envelope. nativeCsv leaves csv to a command that
 * streams its own.
 */
export async function reportFileOf(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  pathName: string,
  query: Record<string, string | undefined> | undefined,
  stem: string,
  what: string,
  nativeCsv = false,
): Promise<CommandResult | undefined> {
  requireFlagValue(args, "format", "xlsx");
  const format: ReportFormat = reportFormat(args);
  if (!wantsReportFile(format, nativeCsv)) {
    if (format === "json" && args.flags.output !== undefined) throw usageError("--output applies to --format csv, xlsx or pdf. JSON is the command envelope on stdout.");
    return undefined;
  }
  if (flagString(args.flags, "output") === "-") throw usageError("--output - writes only a CSV stream; give a file path.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const file = await downloadReportFile(client, { path: pathName, query, format, output: flagString(args.flags, "output"), stem, cwd: runtime.cwd(), what });
  const result = reportFileResult(file);
  return { envelope: result.envelope, exitCode: ExitCode.Success, human: result.human };
}

export async function simpleGet(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  pathName: string,
  title: string,
  query?: Record<string, string | undefined>,
  paged: boolean | ListAllOptions = false,
): Promise<CommandResult> {
  const stem = REPORT_FILE_COMMANDS[args.command.slice(0, 2).join(" ")];
  if (stem !== undefined) {
    const file = await reportFileOf(args, runtime, resolved, pathName, query, stem, title.toLowerCase());
    if (file) return file;
  }
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = paged
    ? await client.listAll(pathName, query, paged === true ? undefined : paged)
    : await client.call({ method: "GET", path: pathName, query });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: `${title}\n${JSON.stringify(response.body, null, 2)}`,
  };
}

/** simpleGet for a cursor-paged list: every page is read, and data holds all the items with next_cursor null. */
export function simpleList(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: ResolvedCommandConfig,
  pathName: string,
  title: string,
  query?: Record<string, string | undefined>,
  options?: ListAllOptions,
): Promise<CommandResult> {
  return simpleGet(args, runtime, resolved, pathName, title, query, options ?? true);
}
export const PLAYBACK_DAY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export function requireFlagValue(args: ParsedArgs, name: string, example: string): void {
  if (args.flags[name] === true) {
    throw usageError(`--${name} requires a value, such as --${name} ${example}.`);
  }
}

export const MEDIA_FOLDER_ID_PATTERN = /^(?:(?:stage|qa|development)_)?mfd_[A-Za-z0-9]{1,64}$/;

export function mediaFolderId(value: string | undefined, label: string): string {
  if (!value || !MEDIA_FOLDER_ID_PATTERN.test(value)) {
    throw usageError(`${label} must be a media folder ID (mfd_...); media folder list shows them.`);
  }
  return value;
}

/** json (default) or csv; --output applies to csv only. */
export function playbackFormat(args: ParsedArgs, command: string): "json" | "csv" {
  requireFlagValue(args, "format", "csv");
  const format = flagString(args.flags, "format") ?? "json";
  if (format !== "json" && format !== "csv") throw usageError("--format must be json or csv.");
  if (format === "json" && args.flags.output !== undefined) {
    throw usageError(`--output applies to ${command} --format csv. JSON is the command envelope on stdout.`);
  }
  return format;
}

/** --day-from/--day-to of the daily uptime reads. */
export function uptimeDays(args: ParsedArgs): { day_from?: string; day_to?: string } {
  for (const [name, example] of [["day-from", "2026-09-01"], ["day-to", "2026-09-30"]] as const) requireFlagValue(args, name, example);
  return aggregateDays(flagString(args.flags, "day-from"), flagString(args.flags, "day-to"), UPTIME_MAX_DAYS);
}

/** --day-from/--day-to: real UTC days, from not after to, at most `maxDays` (366 by default) inclusive. */
export function aggregateDays(from: string | undefined, to: string | undefined, maxDays = AGGREGATE_MAX_DAYS, scope = ""): { day_from?: string; day_to?: string } {
  const parse = (value: string, flag: string) => {
    const ms = PLAYBACK_DAY_PATTERN.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
      throw usageError(`${flag} must be a UTC calendar day as YYYY-MM-DD.`);
    }
    return ms;
  };
  const fromMs = from === undefined ? undefined : parse(from, "--day-from");
  const toMs = to === undefined ? undefined : parse(to, "--day-to");
  if (fromMs !== undefined && toMs !== undefined) {
    if (toMs < fromMs) throw usageError("--day-from must not be after --day-to.");
    if (toMs - fromMs >= maxDays * 86_400_000) throw usageError(`--day-from to --day-to must span at most ${maxDays} days${scope}.`);
  }
  return { ...(from !== undefined ? { day_from: from } : {}), ...(to !== undefined ? { day_to: to } : {}) };
}

/** Flags that shape the pre-upload transcode. */
export function transcodeOptionsFromArgs(args: ParsedArgs): TranscodeOptions {
  const preset = flagString(args.flags, "preset");
  if (args.flags.preset !== undefined && preset !== "signage-1080p30" && preset !== "signage-4k30") {
    throw usageError("--preset accepts signage-1080p30 or signage-4k30.");
  }
  if (args.flags["no-audio"] !== undefined && args.flags["no-audio"] !== true) throw usageError("--no-audio takes no value.");
  const noAudio = flagBool(args.flags, "no-audio");
  if (flagBool(args.flags, "no-transcode") && (preset || noAudio)) {
    throw usageError("--preset and --no-audio require transcoding; remove --no-transcode.");
  }
  for (const flag of ["max-fps", "max-edge", "webp-quality"]) {
    const raw = args.flags[flag];
    if (raw !== undefined && (typeof raw !== "string" || !Number.isFinite(Number(raw)))) {
      throw usageError(`--${flag} requires a numeric value.`);
    }
  }
  const codecFlag = flagString(args.flags, "codec")?.toLowerCase();
  let codec: TranscodeCodec = DEFAULT_CODEC;
  if (codecFlag !== undefined) {
    if (codecFlag === "hevc" || codecFlag === "h265") {
      codec = "hevc";
    } else if (codecFlag === "h264" || codecFlag === "avc") {
      codec = "h264";
    } else {
      throw usageError("--codec accepts hevc or h264.");
    }
  }

  const maxFps = flagNumber(args.flags, "max-fps") ?? DEFAULT_MAX_FPS;
  if (!(maxFps > 0) || maxFps > 240) {
    throw usageError("--max-fps must be greater than 0 and at most 240.");
  }
  const maxEdge = flagNumber(args.flags, "max-edge") ?? MAX_EDGE;
  if (!Number.isInteger(maxEdge) || maxEdge < 16 || maxEdge > MAX_EDGE) {
    throw usageError(`--max-edge must be a whole number between 16 and ${MAX_EDGE}.`);
  }
  const webpQuality = flagNumber(args.flags, "webp-quality") ?? DEFAULT_WEBP_QUALITY;
  if (!Number.isInteger(webpQuality) || webpQuality < 1 || webpQuality > 100) {
    throw usageError("--webp-quality must be a whole number between 1 and 100.");
  }
  return { codec, maxFps, maxEdge, webpQuality,
    preset: preset === "signage-1080p30" || preset === "signage-4k30" ? preset : undefined, noAudio };
}

export function progressReporterFor(args: ParsedArgs, runtime: CliRuntime): ProgressReporter {
  if (flagBool(args.flags, "no-progress")) {
    return silentProgressReporter();
  }
  const json = !flagBool(args.flags, "human");
  return createProgressReporter({
    stderr: runtime.stderr,
    json,
    tty: !json && runtime.isStderrTty?.() === true,
    now: () => runtime.now().getTime(),
  });
}

const SCREEN_ID_PATTERN = RESOURCE_ID_PATTERNS.screen;

export async function readFeedbackBody(args: ParsedArgs, runtime: CliRuntime): Promise<string> {
  const inline = flagString(args.flags, "body");
  const file = flagString(args.flags, "body-file");
  if (inline !== undefined && file !== undefined) {
    throw usageError("Pass either --body or --body-file, not both.");
  }
  if (inline !== undefined) {
    return inline;
  }
  if (file === undefined) {
    throw usageError("feedback requires --body TEXT or --body-file FILE.");
  }
  try {
    return await readFile(path.resolve(runtime.cwd(), file), "utf8");
  } catch (error) {
    throw usageError(`Cannot read --body-file: ${error instanceof Error ? error.message : "read failed"}`);
  }
}

export function scheduleZoneError(screenId: string): CliError {
  return usageError(
    `Screen ${screenId} has no timezone, and the playlist has civil-time visibility bounds. Set the screen's IANA timezone before assigning it.`,
    {
      command: `screenrig screen set-timezone ${screenId} --timezone America/Los_Angeles --expect-rev REVISION`,
      reason: "Set the screen timezone first, then assign the playlist. Read the current revision from screen show.",
    },
  );
}

/**
 * `screen show` and `playlist show`: open notes about that resource, one extra
 * read. The envelope gains a notes_about_resource warning naming them, data
 * stays the resource, and human output lists them. A failed read adds nothing.
 */
export async function resourceNotes(runtime: CliRuntime, client: ApiClient, type: NoteAboutType, id: string): Promise<{ warnings: Warning[]; lines: string[] }> {
  try {
    const response = await new NotesApi(client).list({ aboutId: id, limit: "5" });
    const list = (response.body ?? {}) as NoteList;
    const warning = resourceNotesWarning(list, type, id);
    const lines = resourceNoteLines(list, runtime.now(), id);
    return { warnings: warning ? [warning] : [], lines: lines.length ? ["", ...lines] : [] };
  } catch {
    return { warnings: [], lines: [] };
  }
}

export function isScreenId(value: string): boolean {
  return SCREEN_ID_PATTERN.test(value);
}

/** `--output` is a file path, never a directory; the default is relative to cwd. */
export async function resolveDownloadOutput(cwd: string, defaultRelative: string, flags: ParsedArgs["flags"]): Promise<string> {
  if (flags.output === true) {
    throw usageError("--output requires a file path.");
  }
  const specified = flagString(flags, "output");
  const relative = specified ?? defaultRelative;
  if (relative.endsWith("/") || relative.endsWith("\\")) {
    throw usageError("--output must be a file path, not a directory.");
  }
  const outputPath = path.resolve(cwd, relative);
  try {
    const existing = await stat(outputPath);
    if (existing.isDirectory()) {
      throw usageError("--output must be a file path, not a directory.");
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw usageError("--output must be a file path, not a directory.");
    }
  }
  return outputPath;
}

/** First reconnect wait after a disconnect. Tests inject `runtime.sleep`. */
export const EVENT_STREAM_BACKOFF_MS = 250;
export const EVENT_STREAM_BACKOFF_CAP_MS = 15_000;

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** 401/403/404 and other non-transient 4xx. 408/429/5xx/network retry. */
export function isHardFollowError(err: unknown): boolean {
  if (!(err instanceof CliError)) {
    return false;
  }
  if (err.problem.code === "transport_error") {
    return false;
  }
  const status = err.problem.status;
  if (status === 408 || status === 429 || status >= 500 || status < 400) {
    return false;
  }
  return true;
}

export async function sleepWhileOpen(
  ms: number,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Warnings 30 and 7 days before the session ends: an installation that only enrolled cannot sign in unattended. */
function signInExpiryWarning(grant: ScreenRigConfig["oauth"], now: Date): Warning | undefined {
  const days = refreshExpiryDays(grant, now);
  if (days === undefined) return undefined;
  return {
    code: "sign_in_expiring",
    message: `This installation's session ends in ${days} day${days === 1 ? "" : "s"}. Run screenrig login before then; a person approves it in the dashboard.`,
  };
}

export type { Operation };

export function webhookRevisionHeaders(args: ParsedArgs): Record<string, string> | undefined {
  const revision = flagString(args.flags, "expect-rev");
  return revision ? { "if-match": quotedRevision(revision) } : undefined;
}
