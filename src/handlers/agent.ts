// Command handlers for the agent commands, loaded on demand.
import { isResourceID } from "../generated/resource-ids.js";
import { cacheProjectContexts, contextFromProject, projectName as validateDisplayName, setResultContext } from "../project-context.js";
import { projectConfigFor, withProjectConfig, assertProjectCredential } from "../project-state.js";
import { type Project, type Agent, type AgentDisconnectRequest, type CLIEnrollmentOAuth, type CLIEnrollmentRequest, type EnrollmentIntent } from "../adapters/protocol.js";
import { flagBool, flagString, type ParsedArgs } from "../command-input.js";
import { requireToken } from "../client.js";
import { preserveLogSocket, resolveConfig, isRetiredCredential, readConfigFile, sameCredential, withConfigLock, writeConfigAtomic, type ScreenRigConfig } from "../config.js";
import { loggerOf } from "../log/index.js";
import { accessClaims, accessFromScope, ACCESS_LEVELS, isSessionJwt, SCOPE_IDENTITY, type AccessLevel } from "../oauth.js";
import { accessFields } from "../reviews.js";
import { DeviceLogin, type LoginOutcome } from "../login.js";
import { ensureCredential } from "../enrollment.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, configError, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { installSource } from "../install-source.js";
import { redactText } from "../redact.js";
import { agentPlatform, validateAgent, validateAgentSelfStatus } from "../agent-identity.js";
import { AGENT_SELF_PATH, notesHint, notesHintWarning, selfNoteCounts, selfNotesField, type NoteCounts } from "../agent-notes.js";
import { CLI_VERSION } from "../version.js";
import { clientFor, commandHandler, credentialRetiredError, humanLines, identityForCommand, isPlainContactEmail, oauthSessionFor, oauthSessions, requireFlagValue, requirePrivateNoStore, sessionRuntime, type CommandResult, type ResolvedCommandConfig } from "../commands.js";


export function enrollmentEmail(value: string | undefined): string {
  const email = value?.trim();
  if (!email) {
    throw usageError("agent enroll requires --email ADDRESS for unverified project contact metadata.");
  }
  if (!isPlainContactEmail(email)) {
    throw usageError("agent enroll --email must be one plain ASCII address with an unquoted local part and dotted DNS domain.");
  }
  return email;
}

/**
 * One AgentID claim code: `agid_` plus at least 128 bits of base32 or
 * base64url. The code is never echoed back, so errors name only the flag.
 */
export function agentidClaim(value: string | undefined): string {
  const claim = value?.trim();
  if (!claim) {
    throw usageError("agent enroll requires --agentid-claim CODE.");
  }
  if (!/^agid_[A-Za-z0-9_-]{43}$/.test(claim)) {
    throw usageError("agent enroll --agentid-claim must be an AgentID claim code: agid_ followed by 43 base64url characters.");
  }
  return claim;
}

/**
 * The AgentID sign-in route lives on the configured API host, derived from the
 * configured API URL the way the dashboard and browser-setup helpers derive
 * their origins. An unsupported origin yields no URL rather than a broken next
 * action.
 */
export function agentidSignInUrl(apiUrl: string): string | undefined {
  let api: URL;
  try {
    api = new URL(apiUrl);
  } catch {
    return undefined;
  }
  const supported = api.protocol === "https:" || (api.protocol === "http:" && api.hostname.endsWith(".localhost"));
  return supported ? `${api.origin}/agentid/start` : undefined;
}

/** agent enroll --intent names the project purpose; omitted keeps the signage default. */
export function enrollmentPurpose(value: string | undefined): EnrollmentIntent | undefined {
  const intent = value?.trim();
  if (!intent) return undefined;
  if (intent !== "signage" && intent !== "advertising") {
    throw usageError("agent enroll --intent must be signage or advertising.");
  }
  return intent;
}

/**
 * agent enroll --setup-code: the code the website shows with its setup prompt,
 * two groups of four letters and digits. It only names a website visit and
 * grants nothing, so any case and a missing hyphen are accepted and the server
 * receives upper-case XXXX-XXXX. Errors name the shape, never the input.
 */
export function enrollmentSetupCode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const code = value.trim();
  if (!/^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/.test(code)) {
    throw usageError("agent enroll --setup-code must be a setup code: two groups of four letters and digits, such as K7QX-2MPD.");
  }
  const bare = code.replace("-", "").toUpperCase();
  return `${bare.slice(0, 4)}-${bare.slice(4)}`;
}

export const handleAgentStatus = commandHandler(agentStatus, false);

export const handleLogin = commandHandler(async (args, runtime, resolved) => {
  return loggerOf(runtime).withLocal({ op: "login", message: "login" }, () => {
    const access = (flagString(args.flags, "access") ?? "manage") as AccessLevel;
    if (!ACCESS_LEVELS.includes(access)) throw usageError("login --access must be read, propose or manage.");
    return login(args, runtime, resolved, {
      project: flagString(args.flags, "project"),
      access,
      wait: !flagBool(args.flags, "no-wait"),
      resume: flagString(args.flags, "resume"),
    });
  });
}, false);

export const handleLogout = commandHandler(logout, false);

/** The device sign-in. */
export async function login(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig,
  request: { project?: string; access: AccessLevel; wait: boolean; resume?: string }): Promise<CommandResult> {
  if (request.project !== undefined && !isResourceID(request.project, "project")) throw usageError("login --project must be a project ID (prj_...).");
  const name = flagString(args.flags, "name");
  if (name && name.length > 80) throw usageError("login --name is at most 80 characters.");
  const session = oauthSessionFor(runtime, resolved);
  const device = new DeviceLogin(session, resolved.configPath, sessionRuntime(runtime));
  const source = installSource(runtime.env);
  const outcome: LoginOutcome = await device.run({
    access: request.access,
    ...(request.project ? { project: request.project } : {}),
    ...(name ? { name } : {}),
    platform: agentPlatform(),
    version: CLI_VERSION,
    ...(source ? { installSource: source } : {}),
    wait: request.wait,
    ...(request.resume !== undefined ? { resume: request.resume } : {}),
  }, (pending, resumed) => {
    runtime.stderr.write(`${resumed ? "Still waiting" : "Sign-in started"}: open ${pending.verification_uri_complete} and confirm the code ${pending.user_code}. It expires at ${pending.expires_at}.\n`);
  });
  const pending = outcome.login;
  if (outcome.status === "pending") {
    const resume = ["login", "--resume", pending.id];
    return {
      envelope: successEnvelope({
        status: "pending",
        login_id: pending.id,
        user_code: pending.user_code,
        verification_uri: pending.verification_uri,
        verification_uri_complete: pending.verification_uri_complete,
        expires_at: pending.expires_at,
        access: pending.access,
        ...(pending.project_id ? { project_id: pending.project_id } : {}),
        next: { command: `screenrig ${resume.join(" ")}`, argv: resume, reason: "After the person approves the sign-in, this stores its tokens." },
      }),
      exitCode: ExitCode.Success,
      human: humanLines(outcome.resumed ? "Sign-in pending" : "Sign-in started", [
        ["open", pending.verification_uri_complete],
        ["code", pending.user_code],
        ["expires_at", pending.expires_at],
        ["next", `screenrig ${resume.join(" ")}`],
      ]),
    };
  }
  const signedIn = await resolveConfig({ flags: { ...(typeof args.flags.config === "string" ? { config: args.flags.config } : {}), ...(typeof args.flags["api-url"] === "string" ? { "api-url": args.flags["api-url"] } : {}) },
    fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir } });
  const token = requireToken(signedIn.token);
  const client = clientFor(runtime, args, signedIn.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/project" });
  const context = contextFromProject(response.body as Project);
  await cacheProjectContexts(runtime, signedIn, [context], { credential: token });
  const access = accessFromScope(outcome.scope);
  const self = await selfStatusFor(runtime, args, signedIn.apiUrl, token);
  // The grant's scope names the level; the server reports what caps it now.
  const levels = accessFields({ access, effective_access: self?.effective_access, access_limited_by: self?.access_limited_by });
  return withNotesHint({
    envelope: successEnvelope({
      status: "signed_in",
      project: context.project,
      organization: context.organization,
      ...levels.data,
      identity: outcome.scope.includes(SCOPE_IDENTITY),
      ...(outcome.agentId ? { agent_id: outcome.agentId } : {}),
    }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Signed in", [
      ["project", `${context.organization.name} / ${context.project.name} (${context.project.id})`],
      ...levels.lines,
    ]),
  }, self ? selfNoteCounts(self) : undefined);
}

export async function logout(_args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const { revoked } = await oauthSessionFor(runtime, resolved).logout();
  return {
    envelope: successEnvelope({ status: "signed_out", revoked }),
    exitCode: ExitCode.Success,
    human: revoked ? "Signed out. The sign-in is revoked and its tokens were removed from this config." : "Already signed out.",
  };
}

export const handleAgentEnroll = commandHandler(async (args, runtime, resolved) => {
  return loggerOf(runtime).withLocal({ op: "agent.enroll", message: "agent enroll" }, () =>
    agentEnroll(args, runtime, resolved),
  );
}, false);

export const handleAgentDisconnect = commandHandler(agentDisconnect, false);
export const handleAgentRevokeIdentity = commandHandler(agentRevokeIdentity, false);

export function safeAgentSummary(agent: Agent) {
  return {
    id: agent.id,
    name: agent.name,
    agent_type: agent.agent_type,
    state: agent.state,
    capabilities: agent.capabilities,
    ...(agent.platform ? { platform: agent.platform } : {}),
    ...(agent.version ? { version: agent.version } : {}),
    ...(agent.connected_at ? { connected_at: agent.connected_at } : {}),
    ...(agent.last_used_at ? { last_used_at: agent.last_used_at } : {}),
    ...(agent.revoked_at ? { revoked_at: agent.revoked_at } : {}),
    authenticated_requests: agent.authenticated_requests,
    metered_credits: agent.metered_credits,
  };
}

/** New and due project notes: a notes_waiting warning in the envelope, and one line after human output. */
export function withNotesHint(result: CommandResult, counts: NoteCounts | undefined): CommandResult {
  const warning = notesHintWarning(counts);
  const hint = notesHint(counts);
  if (!warning || !hint) return result;
  return {
    ...result,
    envelope: { ...result.envelope, warnings: [...result.envelope.warnings, warning] },
    human: result.human ? `${result.human}\n${hint}` : hint,
  };
}

/** The calling agent's self status (note counts, access levels). Any failure means none. */
export async function selfStatusFor(runtime: CliRuntime, args: ParsedArgs, apiUrl: string, token: string | undefined): Promise<Record<string, unknown> & { access?: AccessLevel; effective_access?: AccessLevel; access_limited_by?: "project" | "person" } | undefined> {
  if (!token) return undefined;
  try {
    const response = await clientFor(runtime, args, apiUrl, token).call({ method: "GET", path: AGENT_SELF_PATH });
    const body = response.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const level = (value: unknown) => ACCESS_LEVELS.includes(value as AccessLevel) ? value as AccessLevel : undefined;
    const record = body as Record<string, unknown>;
    const limitedBy = record.access_limited_by === "project" || record.access_limited_by === "person" ? record.access_limited_by : undefined;
    return { ...record, access: level(record.access), effective_access: level(record.effective_access), access_limited_by: limitedBy };
  } catch {
    return undefined;
  }
}

export async function agentStatus(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  if (!resolved.token) {
    const local = resolved.lastAgent;
    const status = local ? "disconnected" : "not_enrolled";
    return {
      envelope: successEnvelope({ status, path: "first_run_enroll", ...(local ? { agent: local } : {}) }),
      exitCode: ExitCode.Success,
      human: humanLines("Agent", [
        ["status", status],
        ["id", local?.id],
        ["name", local?.name],
        ["capabilities", local?.capabilities.join(", ")],
      ]),
    };
  }

  const client = clientFor(runtime, args, resolved.apiUrl, resolved.token);
  try {
    const response = await client.call({ method: "GET", path: AGENT_SELF_PATH });
    requirePrivateNoStore(response.headers, "Agent status response");
    const self = validateAgentSelfStatus(response.body);
    const agent = self.agent;
    const status = agent.state === "active" ? "active" : agent.state === "revoked" ? "disconnected" : "connecting";
    const notes = selfNotesField(response.body);
    const levels = accessFields(self);
    return withNotesHint({
      envelope: successEnvelope({ status, connection_ready: self.connection_ready, ...levels.data, agent: safeAgentSummary(agent), ...(notes ? { notes } : {}) }, { request_id: client.requestId }),
      exitCode: ExitCode.Success,
      human: humanLines("Agent", [
        ["status", status],
        ["id", agent.id],
        ["name", agent.name],
        ["agent_type", agent.agent_type],
        ...levels.lines,
        ["capabilities", agent.capabilities.join(", ")],
        ["platform", agent.platform],
        ["version", agent.version],
        ["connection_ready", self.connection_ready ? "true" : "false"],
        ["last_used_at", agent.last_used_at],
      ]),
    }, selfNoteCounts(response.body));
  } catch (err) {
    if (!(err instanceof CliError) || err.problem.code !== "unauthorized") throw err;
    const next = {
      command: "screenrig agent disconnect --yes",
      reason: "The stored credential is no longer accepted. Complete local cleanup before connecting or enrolling.",
    };
    return {
      envelope: successEnvelope({
        status: "disconnected",
        credential_accepted: false,
        local_cleanup_required: true,
        next,
      }),
      exitCode: ExitCode.Success,
      human: humanLines("Agent", [
        ["status", "disconnected"],
        ["credential_accepted", "false"],
        ["next", next.command],
      ]),
    };
  }
}


export async function agentEnroll(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {

  requireFlagValue(args, "name", "Office MacBook Codex");
  const name = flagString(args.flags, "name");
  if (name && name.length > 80) throw usageError("agent enroll --name is at most 80 characters.");
  const enrollIntent = enrollmentPurpose(flagString(args.flags, "intent"));
  const setupCode = enrollmentSetupCode(flagString(args.flags, "setup-code"));
  let enrollmentConfig = resolved;
  // A stored credential the server no longer accepts has nothing left to lose:
  // with enrollment input, a new enrollment replaces it.
  let replacedCredential = false;
  if (resolved.retiredCredential) {
    if (!freshEnrollmentInput(args)) throw credentialRetiredError();
    enrollmentConfig = await dropDeadCredential(runtime, args, resolved);
    replacedCredential = true;
  } else if (resolved.enrollment && flagBool(args.flags, "force")) {
    const forceEmail = flagString(args.flags, "email");
    const forceClaim = flagString(args.flags, "agentid-claim");
    if (forceEmail !== undefined) enrollmentEmail(forceEmail);
    else if (forceClaim !== undefined) agentidClaim(forceClaim);
    else throw usageError("agent enroll --force requires --email ADDRESS or --agentid-claim CODE.");
    await clearPendingEnrollment(runtime, resolved);
    enrollmentConfig = await resolveConfig({
      flags: args.flags,
      fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir },
    });
  }
  const enrollOnce = async (config: Awaited<ReturnType<typeof resolveConfig>>) => {
    const enrolled = await enrollForCommand(args, runtime, config, {
      ...(name ? { name } : {}),
      ...(enrollIntent ? { intent: enrollIntent } : {}),
      ...(setupCode !== undefined ? { setupCode } : {}),
      explicit: true,
    });
    const token = requireToken(enrolled.token);
    setResultContext(runtime, enrolled);
    const client = clientFor(runtime, args, enrolled.apiUrl, token);
    const response = await client.call({ method: "GET", path: "/api/agents/self" });
    requirePrivateNoStore(response.headers, "Agent enrollment verification response");
    const self = validateAgentSelfStatus(response.body, "active");
    let project: Pick<Project, "id" | "name">;
    if (!config.token && enrolled.projectId && enrolled.projectName) {
      project = { id: enrolled.projectId, name: enrolled.projectName };
    } else {
      const projectResponse = await client.call({ method: "GET", path: "/api/project" });
      project = projectResponse.body as Project;
    }
    return { client, self, project };
  };
  let outcome: Awaited<ReturnType<typeof enrollOnce>>;
  try {
    outcome = await enrollOnce(enrollmentConfig);
  } catch (err) {
    // A stored credential the server refuses as dead is replaced; a live one keeps its project.
    if (!enrollmentConfig.token || enrollmentConfig.enrollment || !deadCredentialRefusal(err) || !freshEnrollmentInput(args)) throw err;
    enrollmentConfig = await dropDeadCredential(runtime, args, enrollmentConfig);
    replacedCredential = true;
    outcome = await enrollOnce(enrollmentConfig);
  }
  const { client, self, project } = outcome;
  const agent = self.agent;
  return {
    envelope: successEnvelope({
      status: "active",
      connection_ready: self.connection_ready,
      agent: safeAgentSummary(agent),
      project: { id: project.id, name: project.name },
      invitation: "emailed to the contact address",
      ...(replacedCredential ? { replaced_credential: true } : {}),
    }, { request_id: client.requestId, ...(replacedCredential ? { warnings: [CREDENTIAL_REPLACED] } : {}) }),
    exitCode: ExitCode.Success,
    human: humanLines("Agent enrolled", [
      ...(replacedCredential ? [["replaced", "the retired stored credential; this installation now uses the new project"] as [string, string]] : []),
      ["status", "active"],
      ["id", agent.id],
      ["name", agent.name],
      ["capabilities", agent.capabilities.join(", ")],
      ["connection_ready", self.connection_ready ? "true" : "false"],
      ["project_id", project.id],
      ["project_name", project.name],
      ["invitation", "emailed to the contact address"],
    ]),
  };
}

export const CREDENTIAL_REPLACED = {
  code: "credential_replaced",
  message: "The stored credential was retired (the server no longer accepts it), so this enrollment replaced it with the new project's credential.",
};

/** Whether this invocation names what a new enrollment needs: an email or AgentID claim. */
export function freshEnrollmentInput(args: ParsedArgs): boolean {
  return flagString(args.flags, "email") !== undefined || flagString(args.flags, "agentid-claim") !== undefined;
}

/**
 * A refusal that says the stored credential itself is dead, not that a request
 * lacked access: a 401 credential_retired or unauthorized, or a sign-in the
 * server ended (its refresh refused, or a renewed token refused again).
 */
export function deadCredentialRefusal(err: unknown): boolean {
  if (!(err instanceof CliError)) return false;
  return err.problem.code === "session_ended"
    || (err.problem.status === 401 && ["credential_retired", "unauthorized"].includes(err.problem.code));
}

/**
 * Drop a dead stored credential so enrollment starts a new installation, as
 * screenrig login does: nothing of it, its projects or its state carries over.
 * The enrollment input is checked first, so a usage error leaves the file as it was.
 */
export async function dropDeadCredential(
  runtime: CliRuntime,
  args: ParsedArgs,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<Awaited<ReturnType<typeof resolveConfig>>> {
  const email = flagString(args.flags, "email");
  const claim = flagString(args.flags, "agentid-claim");
  if (email !== undefined) enrollmentEmail(email);
  if (claim !== undefined) agentidClaim(claim);
  const organization = flagString(args.flags, "organization");
  if (organization === undefined) throw usageError("agent enroll requires --organization NAME.");
  validateDisplayName(organization, "Organization name");
  const fsLike = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  await withConfigLock(resolved.configPath, fsLike, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    const current = await readConfigFile(resolved.configPath, fsLike);
    if (!current) return;
    // Another process may have signed this installation in meanwhile: keep a credential that is not the dead one.
    if (current.token && !isRetiredCredential(current.token) && !sameCredential(current.token, resolved.token)) {
      throw configError("The stored credential changed during enrollment. Run the command again.");
    }
    await writeConfigAtomic(resolved.configPath, preserveLogSocket(current, {
      api_url: current.api_url,
      ...(current.enrollment ? { enrollment: current.enrollment } : {}),
      updated_at: runtime.now().toISOString(),
    }), fsLike);
  });
  oauthSessions.delete(runtime);
  const next = await resolveConfig({ flags: args.flags, fs: fsLike });
  oauthSessionFor(runtime, next);
  return next;
}

export async function clearPendingEnrollment(
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<void> {
  const fsLike = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  await withConfigLock(resolved.configPath, fsLike, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    const current = await readConfigFile(resolved.configPath, fsLike);
    if (!current?.enrollment) return;
    const { enrollment: _pending, token: _token, project_id: _project, project_name: _projectName, agent_id: _agent, ...rest } = current;
    await writeConfigAtomic(resolved.configPath, { ...rest, updated_at: runtime.now().toISOString() }, fsLike);
  });
}

export async function removeLocalAgentCredential(
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  token: string,
  agent: Agent | undefined,
): Promise<void> {
  const fsLike = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  await withConfigLock(resolved.configPath, fsLike, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    const current = await readConfigFile(resolved.configPath, fsLike);
    if (!current) {
      throw configError("The stored agent credential changed before local disconnect cleanup.");
    }
    const scoped = projectConfigFor(current, resolved);
    assertProjectCredential(scoped, { ...resolved, token });
    if (current.identity_token || current.projects) {
      const { token: _token, screen_provision: _provision, browser_setup: _browser, media_generate: _generate, pending_writes: _writes, ...withoutCredential } = scoped;
      const next = withProjectConfig(current, resolved, { ...withoutCredential, updated_at: runtime.now().toISOString() });
      if (!accessClaims(next.token)?.projects && resolved.projectId === accessClaims(next.token)?.prj) delete next.token;
      // An access token bound to the disconnected project is spent wherever it is stored.
      if (!accessClaims(next.identity_token)?.projects && resolved.projectId && accessClaims(next.identity_token)?.prj === resolved.projectId) delete next.identity_token;
      await writeConfigAtomic(resolved.configPath, next, fsLike);
      return;
    }
    const lastAgent = agent ? {
      id: agent.id,
      name: agent.name,
      agent_type: agent.agent_type,
      capabilities: agent.capabilities,
      state: "revoked" as const,
      revoked_at: runtime.now().toISOString(),
    } : current.last_agent;
    await writeConfigAtomic(resolved.configPath, preserveLogSocket(current, {
      api_url: current.api_url,
      ...(lastAgent ? { last_agent: lastAgent } : {}),
      updated_at: runtime.now().toISOString(),
    }), fsLike);
  });
}

export async function agentDisconnect(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const invokedName = "agent disconnect";

  if (!flagBool(args.flags, "yes")) {
    throw usageError(`${invokedName} requires --yes. It revokes only this agent and preserves the project, screens, content, and other agents.`, {
      command: "screenrig agent disconnect --yes",
      reason: "Run only after explicitly accepting revocation of this installation.",
    });
  }
  if (!resolved.token) throw usageError("No stored ScreenRig agent credential exists; nothing was changed.");
  const token = resolved.token;
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  let agent: Agent | undefined;
  let credentialRejected = false;
  try {
    const current = await client.call({ method: "GET", path: "/api/agents/self" });
    requirePrivateNoStore(current.headers, "Agent status response");
    agent = validateAgentSelfStatus(current.body).agent;
  } catch (err) {
    if (!(err instanceof CliError) || err.problem.code !== "unauthorized") throw err;
    credentialRejected = true;
  }
  if (!credentialRejected) {
    const request: AgentDisconnectRequest = flagBool(args.flags, "allow-lockout") ? { allow_last_agent: true } : {};
    let response;
    try {
      response = await client.call({
        method: "POST",
        path: "/api/agents/self/disconnect",
        ...(request.allow_last_agent ? { body: request } : {}),
      });
    } catch (err) {
      if (err instanceof CliError && err.problem.code === "unauthorized") {
        credentialRejected = true;
      } else if (err instanceof CliError) {
        throw new CliError({
          ...err.problem,
          next: err.problem.code === "agent_lockout_risk"
            ? {
                command: "screenrig agent disconnect --yes --allow-lockout",
                reason: "Use only after confirming a registered dashboard passkey or explicitly accepting loss of this project.",
              }
            : {
                command: "screenrig agent disconnect --yes",
                reason: "Local credential state was retained. Retrying the exact disconnect is safe after an ambiguous response.",
              },
        }, err.exitCode);
      } else {
        throw err;
      }
    }
    if (!credentialRejected) {
      if (!response || response.status !== 204 || response.body !== undefined) {
        throw configError("The agent disconnect endpoint did not return the required empty 204 response; local credential state was retained.");
      }
      requirePrivateNoStore(response.headers, "Agent disconnect response");
    }
  }

  try {
    await removeLocalAgentCredential(runtime, resolved, token, agent);
  } catch (err) {
    const prefix = credentialRejected
      ? "The stored credential is no longer accepted, but atomic local cleanup failed"
      : "The server disconnected this agent, but atomic local cleanup failed";
    throw configError(
      `${prefix}: ${redactText(err instanceof Error ? err.message : "unknown filesystem error")}. The retained credential no longer authorizes project operations.`,
      {
        command: "screenrig agent disconnect --yes",
        reason: "Retrying with the retained exact credential safely completes local cleanup.",
      },
    );
  }
  return {
    envelope: successEnvelope({
      status: "disconnected",
      local_credential_removed: true,
      project_preserved: true,
      screens_preserved: true,
      other_agents_preserved: true,
      ...(credentialRejected ? { credential_accepted: false } : {}),
    }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Agent disconnected", [
      ["local_credential", "removed"],
      ["project_screens_and_other_agents", "preserved"],
      ["next", "screenrig agent enroll --email ADDRESS --organization NAME creates a new project; screenrig login joins an existing one only when the user asks"],
    ]),
  };
}

export async function agentRevokeIdentity(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  if (!flagBool(args.flags, "yes")) throw usageError("agent revoke-identity requires --yes. It revokes this identity and all of its project memberships.");
  const identity = await identityForCommand(runtime, resolved);
  const client = clientFor(runtime, args, identity.apiUrl, identity.identityToken);
  let alreadyRejected = false;
  try {
    const response = await client.call({ method: "POST", path: "/api/agent-identity/revoke" });
    if (response.status !== 204 || response.body !== undefined) throw configError("Identity revocation did not return an empty 204; local credentials were retained.");
    requirePrivateNoStore(response.headers, "Identity revocation response");
  } catch (error) {
    if (!(error instanceof CliError) || error.problem.code !== "unauthorized") throw error;
    alreadyRejected = true;
  }
  const fs = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  await withConfigLock(resolved.configPath, fs, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    const current = await readConfigFile(resolved.configPath, fs);
    if (!current || !sameCredential(current.identity_token, identity.identityToken, "identity")) throw configError("Identity changed before revocation cleanup. Local credentials were retained.");
    const scrub = (value: ScreenRigConfig): ScreenRigConfig => {
      const { token: _token, token_projects: _subset, screen_provision: _provision, browser_setup: _browser, media_generate: _generate, pending_writes: _writes, ...rest } = value;
      return rest;
    };
    // Revoking the identity revokes every grant it holds, so the session goes too.
    const { identity_token: _identity, identity_writes: _writes, enrollment: _enrollment, oauth: _grant, login: _login, ...rest } = scrub(current);
    const projects = current.projects ? Object.fromEntries(Object.entries(current.projects).map(([id, value]) => [id, scrub({ api_url: current.api_url, ...value })])) : undefined;
    if (projects) for (const slot of Object.values(projects)) delete (slot as Partial<ScreenRigConfig>).api_url;
    await writeConfigAtomic(resolved.configPath, { ...rest, ...(projects ? { projects } : {}), updated_at: runtime.now().toISOString() }, fs);
  });
  return { envelope: successEnvelope({ status: "revoked", all_memberships_revoked: true, local_credentials_removed: true, ...(alreadyRejected ? { credential_accepted: false } : {}) }, { request_id: client.requestId }),
    exitCode: ExitCode.Success, human: "Agent identity and all project memberships revoked." };
}

export async function enrollForCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  options: { name?: string; explicit?: boolean; intent?: EnrollmentIntent; setupCode?: string } = {},
): Promise<Awaited<ReturnType<typeof resolveConfig>>> {
  const suppliedEmail = flagString(args.flags, "email");
  const suppliedClaim = flagString(args.flags, "agentid-claim");
  const alreadyEnrolled = Boolean(resolved.token && !resolved.enrollment);
  const persistedEmail = resolved.enrollment?.email;
  const persistedClaim = resolved.enrollment?.agentid_claim;
  if (persistedEmail && suppliedEmail !== undefined && enrollmentEmail(suppliedEmail) !== persistedEmail) {
    throw usageError("The pending enrollment is bound to a different contact email. Resume it without changing --email.");
  }
  if (persistedClaim && suppliedClaim !== undefined && agentidClaim(suppliedClaim) !== persistedClaim) {
    throw usageError("The pending enrollment is bound to a different AgentID claim. Resume it without changing --agentid-claim, or discard it with agent enroll --force.");
  }
  // A pending enrollment blessed exactly one credential source. Switching it
  // would mutate the request behind an unchanged idempotency key, so refuse.
  if (resolved.enrollment && suppliedEmail !== undefined && persistedClaim !== undefined) {
    throw usageError("The pending enrollment redeems an AgentID claim, not a contact email. Resume it without --email, or discard it with agent enroll --force.");
  }
  if (resolved.enrollment && suppliedClaim !== undefined && persistedEmail !== undefined) {
    throw usageError("The pending enrollment redeems a contact email, not an AgentID claim. Resume it without --agentid-claim, or discard it with agent enroll --force.");
  }
  const email = alreadyEnrolled ? undefined : persistedEmail ?? (suppliedEmail !== undefined ? enrollmentEmail(suppliedEmail) : undefined);
  const claim = alreadyEnrolled ? undefined : persistedClaim ?? (suppliedClaim !== undefined ? agentidClaim(suppliedClaim) : undefined);
  if (!alreadyEnrolled && (email === undefined) === (claim === undefined)) {
    throw usageError("agent enroll requires --email ADDRESS or --agentid-claim CODE.");
  }
    const organizationFlag = flagString(args.flags, "organization");
    const organization = organizationFlag !== undefined ? validateDisplayName(organizationFlag, "Organization name") : resolved.enrollment?.organization;
    if (!resolved.token && !resolved.enrollment && !organization) throw usageError("agent enroll requires --organization NAME.");
    return await ensureCredential({
      resolved,
      ...(email !== undefined ? { enrollmentEmail: email } : {}),
      ...(claim !== undefined ? { enrollmentAgentIdClaim: claim } : {}),
      ...(organization !== undefined ? { enrollmentOrganization: organization } : {}),
      ...(options.intent ? { enrollmentIntent: options.intent } : {}),
      ...(options.setupCode !== undefined ? { enrollmentSetupCode: options.setupCode } : {}),
      runtime: {
        fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir },
        now: runtime.now,
        sleep: runtime.sleep,
      },
      enroll: async (state) => {
        const client = clientFor(runtime, args, resolved.apiUrl);
        const source = installSource(runtime.env);
        const request: CLIEnrollmentRequest = {
          client_id: state.clientId,
          credential_format: state.credentialFormat,
          ...(state.email !== undefined ? { email: state.email } : {}),
          ...(state.agentidClaim !== undefined ? { agentid_claim: state.agentidClaim } : {}),
          ...(state.projectName !== undefined ? { project_name: state.projectName } : {}),
          ...(state.organization !== undefined ? { organization: state.organization } : {}),
          ...(state.intent ? { intent: state.intent } : {}),
          ...(state.setupCode !== undefined ? { setup_code: state.setupCode } : {}),
          ...(options.name ? { name: options.name } : {}),
          ...(options.explicit ? { agent_type: "cli", platform: agentPlatform(), version: CLI_VERSION } : {}),
          ...(source ? { install_source: source } : {}),
        };
        let response;
        try {
          response = await client.call({
            method: "POST",
            path: "/api/enrollments",
            idempotent: true,
            idempotencyKey: state.idempotencyKey,
            body: request,
          });
        } catch (err) {
          if (err instanceof CliError) {
            // The server's own next action always wins; these two are the CLI's
            // documented recovery paths when the server leaves them empty.
            if (err.problem.code === "agentid_claim_invalid" && !err.problem.next) {
              const signIn = agentidSignInUrl(resolved.apiUrl);
              throw new CliError({
                ...err.problem,
                next: {
                  command: signIn ?? "screenrig agent enroll --email ADDRESS --organization NAME",
                  reason: signIn
                    ? `The AgentID claim code is missing, already redeemed, or expired. Sign in again at ${signIn} for a new claim code, or enroll with a contact email: screenrig agent enroll --email ADDRESS --organization NAME.`
                    : "The AgentID claim code is missing, already redeemed, or expired. Enroll with a contact email instead: screenrig agent enroll --email ADDRESS --organization NAME.",
                },
              }, err.exitCode, err.warnings);
            }
            if (err.problem.code === "agentid_already_enrolled" && !err.problem.next) {
              throw new CliError({
                ...err.problem,
                next: {
                  command: "screenrig login",
                  reason: "This AgentID already holds an enrolled agent. Sign this installation in to the existing project instead of enrolling a second agent.",
                },
              }, err.exitCode, err.warnings);
            }
          }
          throw err;
        }
        requirePrivateNoStore(response.headers, "Enrollment response");
        const delivered = response.body as CLIEnrollmentOAuth;
        const agent = validateAgent(delivered.agent, "active");
        if (!delivered.project?.id || !delivered.project.name || !delivered.invitation?.id
          || delivered.connection_ready !== false || !isSessionJwt(delivered.access_token) || (typeof delivered.refresh_token !== "string" || !delivered.refresh_token)
          || delivered.token_type !== "Bearer" || typeof delivered.scope !== "string"
          || !delivered.issuance_id || !delivered.issuance_expires_at) {
          throw usageError("Enrollment response does not match the generated CLIEnrollmentOAuth contract.");
        }
        const identity = delivered.scope.split(" ").includes(SCOPE_IDENTITY);
        return {
          token: delivered.access_token,
          projectId: delivered.project.id,
          projectName: delivered.project.name,
          agentId: agent.id,
          ...(identity ? { identityToken: delivered.access_token } : {}),
          organizationId: delivered.project.organization_id,
          organizationName: delivered.project.organization_name,
          oauth: {
            refreshToken: delivered.refresh_token,
            ...(typeof delivered.refresh_expires_at === "number" ? { refreshExpiresAt: delivered.refresh_expires_at } : {}),
            identity,
          },
        };
      },
      verify: async (token, projectId) => {
        const client = clientFor(runtime, args, resolved.apiUrl, token);
        const response = await client.call({ method: "GET", path: "/api/project" });
        const project = response.body as { id?: string };
        if (!project.id || (projectId && project.id !== projectId)) {
          throw usageError("Persisted enrollment credential did not verify against its project.");
        }
      },
    });
}
