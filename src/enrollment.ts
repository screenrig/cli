import type { EnrollmentIntent } from "./adapters/protocol.js";
import {
  preserveLogSocket,
  readConfigFile,
  withConfigLock,
  writeConfigAtomic,
  type ConfigFs,
  type ResolvedConfig,
  type ScreenRigConfig,
} from "./config.js";
import { isValidIdempotencyKey, newIdempotencyKey, randomPrefixedId } from "./ids.js";
import { CliError, configError } from "./problems.js";

/** Refusals a resume cannot fix; 408, 409, 410 and 429 keep the pending enrollment. */
const DEFINITE_ENROLL_REFUSALS = new Set([400, 403, 404, 422]);

export interface EnrollmentCredential {
  token: string;
  projectId?: string;
  projectName?: string;
  agentId?: string;
  identityToken?: string;
  organizationId?: string;
  organizationName?: string;
}

export interface EnrollmentState {
  clientId: string;
  idempotencyKey: string;
  /** Exactly one of `email` or `agentidClaim` is set. */
  email?: string;
  /** AgentID claim code redeemed in place of a contact email. */
  agentidClaim?: string;
  projectName?: string;
  organization?: string;
  /** Enrollment purpose, fixed for the lifetime of one pending enrollment. */
  intent?: EnrollmentIntent;
}

export interface EnrollmentRuntime {
  fs: ConfigFs;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Resolve a durable credential exactly once across concurrent CLI processes.
 * The callback owns the wire contract and is supplied by the command layer.
 */
export async function ensureCredential(options: {
  resolved: ResolvedConfig;
  runtime: EnrollmentRuntime;
  enroll: (state: EnrollmentState) => Promise<EnrollmentCredential>;
  verify: (token: string, projectId?: string) => Promise<void>;
  /** Exact validated, trimmed contact address for a new or pending enrollment. */
  enrollmentEmail?: string;
  /** Exact AgentID claim code redeemed in place of a contact email. */
  enrollmentAgentIdClaim?: string;
  /** Project name fixed for the lifetime of one pending enrollment. */
  enrollmentProjectName?: string;
  enrollmentOrganization?: string;
  /**
   * Enrollment purpose for a new enrollment; a pending enrollment keeps the
   * intent it was created with, and a changed one is rejected rather than
   * silently mutating the request behind the same idempotency key.
   */
  enrollmentIntent?: EnrollmentIntent;
  generateClientId?: () => string;
  generateIdempotencyKey?: () => string;
}): Promise<ResolvedConfig> {
  const { runtime, resolved } = options;
  if (resolved.token && !resolved.enrollment) {
    return resolved;
  }
  const enrolled = await withConfigLock(
    resolved.configPath,
    runtime.fs,
    { sleep: runtime.sleep, now: () => runtime.now().getTime() },
    async () => {
      const current = await readConfigFile(resolved.configPath, runtime.fs);
      if (current?.token) {
        return {
          ...resolved,
          token: current.token,
          projectId: current.project_id,
          projectName: current.project_name,
          organizationId: current.organization_id,
          organizationName: current.organization_name,
          identityToken: current.identity_token,
          agentId: current.agent_id,
          enrollment: current.enrollment,
          agentConnection: current.agent_connection,
          lastAgent: current.last_agent,
          source: { ...resolved.source, token: "config" as const },
        };
      }
      if (current?.enrollment && current.api_url.replace(/\/+$/, "") !== resolved.apiUrl) {
        throw configError("Pending enrollment is bound to a different API URL.");
      }
      const existingEnrollment = current?.enrollment;
      if (existingEnrollment?.email && options.enrollmentEmail && existingEnrollment.email !== options.enrollmentEmail) {
        throw configError("Pending enrollment is bound to a different contact email. Resume it without changing --email.");
      }
      if (existingEnrollment?.agentid_claim && options.enrollmentAgentIdClaim
        && existingEnrollment.agentid_claim !== options.enrollmentAgentIdClaim) {
        throw configError("Pending enrollment is bound to a different AgentID claim. Resume it without changing --agentid-claim, or discard it with agent enroll --force.");
      }
      if (existingEnrollment?.email && options.enrollmentAgentIdClaim) {
        throw configError("Pending enrollment redeems a contact email, not an AgentID claim. Resume it without --agentid-claim, or discard it with agent enroll --force.");
      }
      if (existingEnrollment?.agentid_claim && options.enrollmentEmail) {
        throw configError("Pending enrollment redeems an AgentID claim, not a contact email. Resume it without --email, or discard it with agent enroll --force.");
      }
      if (existingEnrollment?.intent && options.enrollmentIntent && existingEnrollment.intent !== options.enrollmentIntent) {
        throw configError("Pending enrollment is bound to a different purpose. Resume it without changing --intent, or discard it with agent enroll --force.");
      }
      if (existingEnrollment && options.enrollmentProjectName !== undefined
        && existingEnrollment.project_name !== options.enrollmentProjectName) {
        throw configError("Pending enrollment is bound to a different project name. Resume it without changing --project-name, or discard it with agent enroll --force.");
      }
      const email = existingEnrollment?.email ?? options.enrollmentEmail;
      const agentidClaim = existingEnrollment?.agentid_claim ?? options.enrollmentAgentIdClaim;
      if (existingEnrollment && options.enrollmentOrganization !== undefined && existingEnrollment.organization !== options.enrollmentOrganization) {
        throw configError("Pending enrollment is bound to a different organization. Resume without changing --organization.");
      }
      if ((email === undefined) === (agentidClaim === undefined)) {
        throw configError("Enrollment requires exactly one of --email ADDRESS or --agentid-claim CODE. Run screenrig agent enroll --email ADDRESS --organization NAME or screenrig agent enroll --agentid-claim CODE --organization NAME.");
      }
      const intent = existingEnrollment?.intent ?? options.enrollmentIntent;
      const projectName = existingEnrollment ? existingEnrollment.project_name : options.enrollmentProjectName;
      const organization = existingEnrollment ? existingEnrollment.organization : options.enrollmentOrganization;
      const enrollment = {
        ...(existingEnrollment ?? {
          client_id: (options.generateClientId ?? (() => randomPrefixedId("cli", 32)))(),
          idempotency_key: (options.generateIdempotencyKey ?? newIdempotencyKey)(),
        }),
        ...(email !== undefined ? { email } : {}),
        ...(agentidClaim !== undefined ? { agentid_claim: agentidClaim } : {}),
        ...(projectName !== undefined ? { project_name: projectName } : {}),
        ...(organization !== undefined ? { organization } : {}),
        ...(intent ? { intent } : {}),
      };
      if (!/^cli_[A-Za-z0-9_-]{43}$/.test(enrollment.client_id)) {
        throw configError("Enrollment client state is invalid.");
      }
      if (!isValidIdempotencyKey(enrollment.idempotency_key)) {
        throw configError("Enrollment idempotency state is invalid.");
      }
      const pending: ScreenRigConfig = preserveLogSocket(current, {
        api_url: resolved.apiUrl,
        enrollment,
        updated_at: runtime.now().toISOString(),
      });
      await writeConfigAtomic(resolved.configPath, pending, runtime.fs);
      let credential: Awaited<ReturnType<typeof options.enroll>>;
      try {
        credential = await options.enroll({
        clientId: enrollment.client_id,
        idempotencyKey: enrollment.idempotency_key,
        ...(enrollment.email !== undefined ? { email: enrollment.email } : {}),
        ...(enrollment.agentid_claim !== undefined ? { agentidClaim: enrollment.agentid_claim } : {}),
        ...(enrollment.project_name !== undefined ? { projectName: enrollment.project_name } : {}),
        ...(enrollment.organization !== undefined ? { organization: enrollment.organization } : {}),
        ...(enrollment.intent ? { intent: enrollment.intent } : {}),
        });
      } catch (error) {
        // A definite refusal (the feature is off, the claim or input is invalid)
        // cannot succeed on a resume, so leave no pending claim or address behind.
        if (error instanceof CliError && (error.problem.code === "feature_unavailable" || DEFINITE_ENROLL_REFUSALS.has(error.problem.status))) {
          const { enrollment: _refused, ...rest } = current ?? { api_url: resolved.apiUrl };
          await writeConfigAtomic(resolved.configPath, { ...rest, api_url: resolved.apiUrl }, runtime.fs);
        }
        throw error;
      }
      if (!credential.token || credential.token.trim() !== credential.token) {
        throw configError("Enrollment returned an invalid credential.");
      }
      const config: ScreenRigConfig = preserveLogSocket(current, {
        api_url: resolved.apiUrl,
        token: credential.token,
        ...(credential.projectId ? { project_id: credential.projectId } : {}),
        ...(credential.projectName ? { project_name: credential.projectName } : {}),
        ...(credential.agentId ? { agent_id: credential.agentId } : {}),
        ...(credential.identityToken ? { identity_token: credential.identityToken } : {}),
        ...(credential.organizationId ? { organization_id: credential.organizationId } : {}),
        ...(credential.organizationName ? { organization_name: credential.organizationName } : {}),
        ...(credential.projectId && credential.projectName === "Screens" && credential.agentId
          ? { enrollment_project: { project_id: credential.projectId, agent_id: credential.agentId } } : {}),
        enrollment,
        updated_at: runtime.now().toISOString(),
      });
      await writeConfigAtomic(resolved.configPath, config, runtime.fs);
      return {
        ...resolved,
        token: credential.token,
        projectId: credential.projectId,
        projectName: credential.projectName,
        agentId: credential.agentId,
        identityToken: credential.identityToken,
        organizationId: credential.organizationId,
        organizationName: credential.organizationName,
        enrollment,
        source: { ...resolved.source, token: "config" as const },
      };
    },
  );

  if (!enrolled.token || !enrolled.enrollment) {
    return enrolled;
  }
  await options.verify(enrolled.token, enrolled.projectId);
  return withConfigLock(
    enrolled.configPath,
    runtime.fs,
    { sleep: runtime.sleep, now: () => runtime.now().getTime() },
    async () => {
      const current = await readConfigFile(enrolled.configPath, runtime.fs);
      if (!current?.token || !current.enrollment) {
        return enrolled;
      }
      if (current.token !== enrolled.token || current.enrollment.idempotency_key !== enrolled.enrollment?.idempotency_key) {
        throw configError("Enrollment state changed before verification cleanup.");
      }
      const { enrollment: _verified, ...verified } = current;
      await writeConfigAtomic(enrolled.configPath, verified, runtime.fs);
      const { enrollment: _cleared, ...complete } = enrolled;
      return complete;
    },
  );
}
