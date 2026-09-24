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
import { configError } from "./problems.js";

export interface EnrollmentCredential {
  token: string;
  projectId?: string;
  projectName?: string;
  agentId?: string;
}

export interface EnrollmentState {
  clientId: string;
  idempotencyKey: string;
  email: string;
  projectName?: string;
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
  /** Project name fixed for the lifetime of one pending enrollment. */
  enrollmentProjectName?: string;
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
      if (existingEnrollment?.intent && options.enrollmentIntent && existingEnrollment.intent !== options.enrollmentIntent) {
        throw configError("Pending enrollment is bound to a different purpose. Resume it without changing --intent, or discard it with agent enroll --force.");
      }
      if (existingEnrollment && options.enrollmentProjectName !== undefined
        && existingEnrollment.project_name !== options.enrollmentProjectName) {
        throw configError("Pending enrollment is bound to a different project name. Resume it without changing --project-name, or discard it with agent enroll --force.");
      }
      const email = existingEnrollment?.email ?? options.enrollmentEmail;
      if (!email) {
        throw configError("Enrollment requires a contact email. Run screenrig agent enroll --email ADDRESS.");
      }
      const intent = existingEnrollment?.intent ?? options.enrollmentIntent;
      const projectName = existingEnrollment ? existingEnrollment.project_name : options.enrollmentProjectName;
      const enrollment = {
        ...(existingEnrollment ?? {
          client_id: (options.generateClientId ?? (() => randomPrefixedId("cli", 32)))(),
          idempotency_key: (options.generateIdempotencyKey ?? newIdempotencyKey)(),
        }),
        email,
        ...(projectName !== undefined ? { project_name: projectName } : {}),
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
      const credential = await options.enroll({
        clientId: enrollment.client_id,
        idempotencyKey: enrollment.idempotency_key,
        email: enrollment.email,
        ...(enrollment.project_name !== undefined ? { projectName: enrollment.project_name } : {}),
        ...(enrollment.intent ? { intent: enrollment.intent } : {}),
      });
      if (!credential.token || credential.token.trim() !== credential.token) {
        throw configError("Enrollment returned an invalid credential.");
      }
      const config: ScreenRigConfig = preserveLogSocket(current, {
        api_url: resolved.apiUrl,
        token: credential.token,
        ...(credential.projectId ? { project_id: credential.projectId } : {}),
        ...(credential.projectName ? { project_name: credential.projectName } : {}),
        ...(credential.agentId ? { agent_id: credential.agentId } : {}),
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
      const { enrollment: _verified, ...verified } = current;
      await writeConfigAtomic(enrolled.configPath, verified, runtime.fs);
      const { enrollment: _cleared, ...complete } = enrolled;
      return complete;
    },
  );
}
