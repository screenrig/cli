import { createHash } from "node:crypto";
import {
  readConfigFile,
  withConfigLock,
  writeConfigAtomic,
  type ConfigFs,
  type OAuthGrantState,
  type ResolvedConfig,
  type ScreenRigConfig,
} from "./config.js";
import type { OperationLogger } from "./log/types.js";
import {
  accessClaims,
  isSessionJwt,
  newOAuthRequestId,
  OAuthClient,
  SCOPE_IDENTITY,
  type ServiceClientCredentials,
  type TokenSet,
} from "./oauth.js";
import { ExitCode } from "./exit-codes.js";
import { CliError, configError, makeProblem } from "./problems.js";
import type { Transport } from "./transport/types.js";

/** An access token is renewed when it expires within this many seconds. */
export const ACCESS_RENEW_MARGIN_S = 120;
/** A refresh retry within this window reuses its request_id: the server replays the persisted successor. */
const REFRESH_REPLAY_MS = 60_000;
/** The CLI warns this many days before the refresh family ends. */
export const REFRESH_EXPIRY_WARNINGS_DAYS = [30, 7] as const;

export interface SessionRuntime {
  fs: ConfigFs;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  logger?: OperationLogger;
}

function digest(value: string): string {
  return createHash("sha256").update("screenrig/cli-oauth/v1\0").update(value).digest("hex");
}

function projectUnavailable(projectId: string): CliError {
  return new CliError(makeProblem("project_unavailable", "Project unavailable", 404,
    `${projectId} was deleted, or this installation no longer belongs to it. The sign-in itself is still valid.`, {
      next: { command: "screenrig project list", reason: "Lists the projects this sign-in can use; select one with screenrig project use ID." },
    }), ExitCode.NotFound);
}

/** Whether the grant ended for good, with the CLI deleting what it stored. */
export function isSessionEnded(err: unknown): boolean {
  return err instanceof CliError && err.problem.code === "session_ended";
}

/** Store an access token where the CLI reads credentials: its project's slot, and the identity slot when it carries identity. */
export function placeAccessToken(file: ScreenRigConfig, accessToken: string, scope: string[]): ScreenRigConfig {
  const claims = accessClaims(accessToken);
  const next: ScreenRigConfig = { ...file };
  const project = claims?.prj;
  if (project) {
    if (!next.project_id) next.project_id = project;
    if (next.project_id === project) next.token = accessToken;
    if (next.projects?.[project] || next.project_id !== project) {
      next.projects = { ...next.projects, [project]: { ...next.projects?.[project], token: accessToken } };
    }
  }
  if (scope.includes(SCOPE_IDENTITY)) next.identity_token = accessToken;
  return next;
}

/** Remove every access token and the grant: what logout and a session that ended leave behind. */
export function withoutSession(file: ScreenRigConfig): ScreenRigConfig {
  const { oauth: _grant, login: _login, ...rest } = file;
  const next: ScreenRigConfig = { ...rest };
  if (isSessionJwt(next.token)) delete next.token;
  if (isSessionJwt(next.identity_token)) delete next.identity_token;
  if (next.projects) {
    next.projects = Object.fromEntries(Object.entries(next.projects).map(([id, slot]) => {
      if (!isSessionJwt(slot?.token)) return [id, slot];
      const { token: _token, ...kept } = slot;
      return [id, kept];
    }));
  }
  return next;
}

/**
 * One invocation's OAuth session: renews access tokens under the config lock,
 * and mints a service client's token in memory.
 */
export class OAuthSession {
  private readonly client: OAuthClient;
  /** A service client's token lives only in memory; it is minted again rather than refreshed. */
  private serviceAccess?: string;

  constructor(
    private readonly configPath: string,
    private readonly apiUrl: string,
    transport: Transport,
    private readonly runtime: SessionRuntime,
    private readonly service?: ServiceClientCredentials,
  ) {
    this.client = new OAuthClient(apiUrl, transport, service);
  }

  get serviceMode(): boolean {
    return this.service !== undefined;
  }

  /** The service token, minted when there is none or it is about to expire, or when the API refused it. */
  private async serviceToken(rejected?: string): Promise<string> {
    const claims = accessClaims(this.serviceAccess);
    if (this.serviceAccess && this.serviceAccess !== rejected && claims && claims.exp - this.nowMs() / 1000 > ACCESS_RENEW_MARGIN_S) {
      return this.serviceAccess;
    }
    const tokens = await this.client.clientCredentials();
    this.serviceAccess = tokens.accessToken;
    await this.locked(async () => {
      const current = (await this.read()) ?? { api_url: this.apiUrl };
      await this.write(placeAccessToken(current, tokens.accessToken, []));
    });
    return tokens.accessToken;
  }

  get oauth(): OAuthClient {
    return this.client;
  }

  private nowMs(): number {
    return this.runtime.now().getTime();
  }

  private read(): Promise<ScreenRigConfig | undefined> {
    return readConfigFile(this.configPath, this.runtime.fs);
  }

  private write(config: ScreenRigConfig): Promise<void> {
    return writeConfigAtomic(this.configPath, { ...config, updated_at: this.runtime.now().toISOString() }, this.runtime.fs);
  }

  private locked<T>(action: () => Promise<T>): Promise<T> {
    return withConfigLock(this.configPath, this.runtime.fs, { sleep: this.runtime.sleep, now: () => this.nowMs() }, action);
  }

  private usable(token: string | undefined, projectId: string | undefined): token is string {
    const claims = accessClaims(token);
    if (!claims || claims.exp - this.nowMs() / 1000 <= ACCESS_RENEW_MARGIN_S) return false;
    return projectId ? claims.prj === projectId : claims.scope.includes(SCOPE_IDENTITY);
  }

  /**
   * Credentials for one command. With a grant, the target project's access
   * token (or, with no project, the identity token) is renewed when it is
   * missing or about to expire.
   */
  async prepare(resolved: ResolvedConfig, options: { identity?: boolean } = {}): Promise<ResolvedConfig> {
    if (this.service) {
      const token = await this.serviceToken();
      const project = accessClaims(token)?.prj;
      if (resolved.projectId && project !== resolved.projectId) {
        throw configError("This service client belongs to another project than --project-id names. Nothing else was sent.");
      }
      return { ...resolved, token, ...(project ? { projectId: project } : {}) };
    }
    const file = await this.read();
    if (!file?.oauth) return resolved;
    if (options.identity) {
      // Project list, use and create act on the identity: a stale selection must not block them.
      const identity = file.oauth.identity ? await this.accessFor(undefined) : undefined;
      return identity ? { ...resolved, identityToken: identity } : resolved;
    }
    if (resolved.identityWriteScope || !resolved.projectId) {
      const identity = file.oauth.identity ? await this.accessFor(undefined) : undefined;
      if (!identity) return resolved;
      return { ...resolved, identityToken: identity, ...(resolved.identityWriteScope ? { token: identity } : {}) };
    }
    const token = await this.accessFor(resolved.projectId);
    const latest = await this.read();
    return { ...resolved, token, identityToken: latest?.identity_token ?? resolved.identityToken };
  }

  /** An access token carrying identity scope, renewed when needed; undefined when the grant has no identity access. */
  async identityToken(): Promise<string | undefined> {
    if (this.service) return undefined;
    const file = await this.read();
    if (!file?.oauth?.identity) return undefined;
    return this.accessFor(undefined);
  }

  /** ApiClient hook for a 401 on an access token: an invalid_token refusal renews the token once. */
  async renewRejected(token: string, invalidToken = true): Promise<string | undefined> {
    if (this.service) return invalidToken ? this.serviceToken(token) : undefined;
    const claims = accessClaims(token);
    if (!claims?.sid) return undefined;
    return invalidToken ? this.accessFor(claims.prj, token) : undefined;
  }

  /**
   * The access token for a project (or, with none, one carrying identity),
   * renewed under the lock. The holder re-reads the config first: another
   * process may have refreshed already, and then nothing is sent.
   */
  async accessFor(projectId: string | undefined, rejected?: string): Promise<string | undefined> {
    if (this.service) return this.serviceToken(rejected);
    const stored = (file: ScreenRigConfig): string | undefined => {
      const slot = projectId
        ? (file.project_id === projectId ? file.token : file.projects?.[projectId]?.token)
        : file.identity_token;
      return [slot, file.identity_token, projectId ? undefined : file.token]
        .find((candidate) => candidate !== rejected && this.usable(candidate, projectId));
    };
    const unlocked = await this.read();
    if (!unlocked?.oauth) return undefined;
    const ready = stored(unlocked);
    if (ready) return ready;
    // Discovery happens before the lock: the lock covers one token request.
    await this.client.ready();
    return this.locked(async () => {
      const file = await this.read();
      const grant = file?.oauth;
      if (!file || !grant) return undefined;
      return stored(file) ?? this.refreshLocked(file, grant, projectId);
    });
  }

  private async refreshLocked(file: ScreenRigConfig, grant: OAuthGrantState, projectId: string | undefined): Promise<string | undefined> {
    const from = digest(grant.refresh_token);
    let pending = grant.refresh_request;
    if (!pending || pending.from !== from || this.nowMs() - Date.parse(pending.started_at) > REFRESH_REPLAY_MS) {
      // Persisted before the request: a retry after a lost answer replays the same rotation.
      pending = { request_id: newOAuthRequestId(), from, started_at: this.runtime.now().toISOString() };
      await this.write({ ...file, oauth: { ...grant, refresh_request: pending } });
    }
    let tokens: TokenSet;
    try {
      tokens = await this.client.refresh(grant.refresh_token, { requestId: pending.request_id, ...(projectId ? { projectId } : {}) });
    } catch (err) {
      if (isSessionEnded(err) && projectId) {
        // A project that was deleted or left answers invalid_grant too. One
        // refresh without it tells a dead project from a dead session.
        const latest = (await this.read()) ?? file;
        const alive = latest.oauth && await this.refreshLocked(latest, latest.oauth, undefined)
          .then(() => true, (probe: unknown) => { if (isSessionEnded(probe)) return false; throw probe; });
        if (alive) {
          await this.dropProject(projectId);
          throw projectUnavailable(projectId);
        }
        throw err;
      }
      if (isSessionEnded(err)) {
        const current = (await this.read()) ?? file;
        await this.write({ ...withoutSession(current), signed_out_at: this.runtime.now().toISOString() });
      }
      // Network, timeout, 429 and 5xx keep every credential and the pending request_id.
      throw err;
    }
    const current = (await this.read()) ?? file;
    if (current.oauth?.refresh_token !== grant.refresh_token) {
      throw configError("The stored sign-in changed during a refresh. Run the command again.");
    }
    const { refresh_request: _done, ...settled } = grant;
    const next = placeAccessToken(current, tokens.accessToken, tokens.scope);
    await this.write({
      ...next,
      oauth: {
        ...settled,
        refresh_token: tokens.refreshToken ?? grant.refresh_token,
        ...(tokens.refreshExpiresAt !== undefined ? { refresh_expires_at: tokens.refreshExpiresAt } : {}),
        identity: Boolean(grant.identity || tokens.scope.includes(SCOPE_IDENTITY)),
      },
    });
    return tokens.accessToken;
  }

  /** Forget a project the session can no longer reach; the selection stays until project use. */
  private async dropProject(projectId: string): Promise<void> {
    const current = await this.read();
    if (!current) return;
    const next: ScreenRigConfig = { ...current };
    if (next.project_id === projectId) delete next.token;
    if (next.projects?.[projectId]?.token) {
      const { token: _token, ...kept } = next.projects[projectId]!;
      next.projects = { ...next.projects, [projectId]: kept };
    }
    if (accessClaims(next.identity_token)?.prj === projectId) delete next.identity_token;
    await this.write(next);
  }

  /**
   * RFC 7009 revocation of the refresh token, which revokes the grant, then
   * the grant and its access tokens leave the config. A failure that might
   * not have reached the server keeps them.
   */
  async logout(): Promise<{ revoked: boolean }> {
    const file = await this.read();
    const grant = file?.oauth;
    if (!grant) {
      if (file?.login) await this.locked(async () => {
        const current = await this.read();
        if (current?.login) {
          const { login: _pending, ...rest } = current;
          await this.write(rest);
        }
      });
      return { revoked: false };
    }
    await this.client.revoke(grant.refresh_token);
    await this.locked(async () => {
      const current = await this.read();
      if (!current) return;
      await this.write({ ...withoutSession(current), signed_out_at: this.runtime.now().toISOString() });
    });
    return { revoked: true };
  }
}

/** Whole days until the refresh family ends, when a warning is due (30 and 7 days before). */
export function refreshExpiryDays(grant: OAuthGrantState | undefined, now: Date): number | undefined {
  if (!grant?.refresh_expires_at) return undefined;
  const days = Math.floor((grant.refresh_expires_at * 1000 - now.getTime()) / 86_400_000);
  return days <= REFRESH_EXPIRY_WARNINGS_DAYS[0] ? Math.max(days, 0) : undefined;
}
