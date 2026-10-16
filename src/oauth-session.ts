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
import { CliError, configError } from "./problems.js";
import type { Transport } from "./transport/types.js";

/** An access token is renewed when it expires within this many seconds. */
export const ACCESS_RENEW_MARGIN_S = 120;

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

/** Whether the grant ended for good, with the CLI deleting what it stored. */
export function isSessionEnded(err: unknown): boolean {
  return err instanceof CliError && err.problem.code === "session_ended";
}

/** Store one current access token and its project subset; identity_token is a compatibility alias. */
export function placeAccessToken(file: ScreenRigConfig, accessToken: string, scope: string[]): ScreenRigConfig {
  const claims = accessClaims(accessToken);
  const next: ScreenRigConfig = { ...file, token: accessToken,
    token_projects: claims?.projects ? Object.keys(claims.projects) : claims?.prj ? [claims.prj] : [] };
  if (!next.project_id && next.token_projects?.length === 1) next.project_id = next.token_projects[0];
  // Retire per-project credentials while keeping each project's pending writes.
  if (next.projects) next.projects = Object.fromEntries(Object.entries(next.projects).map(([id, slot]) => {
    const { token: _token, ...state } = slot;
    return [id, state];
  }));
  delete next.identity_token;
  if (scope.includes(SCOPE_IDENTITY)) next.identity_token = accessToken;
  return next;
}

/** Remove every access token and the grant: what logout and a session that ended leave behind. */
export function withoutSession(file: ScreenRigConfig): ScreenRigConfig {
  const { oauth: _grant, login: _login, ...rest } = file;
  const next: ScreenRigConfig = { ...rest };
  if (isSessionJwt(next.token)) delete next.token;
  delete next.token_projects;
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

  /** Renew one current token without changing its subset for the command's selection. */
  async prepare(resolved: ResolvedConfig, _options: { identity?: boolean } = {}): Promise<ResolvedConfig> {
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
    const token = await this.accessFor(undefined);
    if (!token) return resolved;
    const claims = accessClaims(token);
    return { ...resolved, token, ...(claims?.scope.includes(SCOPE_IDENTITY) ? { identityToken: token } : {}) };
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
    return invalidToken ? this.accessFor(undefined, token) : undefined;
  }

  /**
   * The current access token, independent of project selection,
   * renewed under the lock. The holder re-reads the config first: another
   * process may have refreshed already, and then nothing is sent.
   */
  async accessFor(_projectId: string | undefined, rejected?: string): Promise<string | undefined> {
    if (this.service) return this.serviceToken(rejected);
    const stored = (file: ScreenRigConfig): string | undefined => {
      const token = file.token ?? file.identity_token;
      const claims = accessClaims(token);
      return token && token !== rejected && claims && claims.exp - this.nowMs() / 1000 > ACCESS_RENEW_MARGIN_S ? token : undefined;
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
      return stored(file) ?? this.refreshLocked(file, grant);
    });
  }

  private async refreshLocked(file: ScreenRigConfig, grant: OAuthGrantState, projects?: string[]): Promise<string | undefined> {
    if (grant.client_id !== "screenrig-cli") throw configError("The stored refresh family belongs to another client. Sign in with this CLI.");
    const from = digest(grant.refresh_token);
    let pending = grant.refresh_request;
    if (!pending || pending.from !== from) {
      // Persisted before the request: a retry after a lost answer replays the same rotation.
      const claims = accessClaims(file.token ?? file.identity_token);
      const selected = projects ?? file.token_projects ?? (claims?.projects ? Object.keys(claims.projects) : claims?.prj ? [claims.prj] : undefined);
      pending = { request_id: newOAuthRequestId(), from, started_at: this.runtime.now().toISOString(), ...(selected ? { projects: selected } : {}) };
      await this.write({ ...file, oauth: { ...grant, refresh_request: pending } });
    }
    let tokens: TokenSet;
    try {
      tokens = await this.client.refresh(grant.refresh_token, { requestId: pending.request_id, ...(pending.projects ? { projects: pending.projects } : {}) });
    } catch (err) {
      if (isSessionEnded(err)) {
        const current = (await this.read()) ?? file;
        await this.write({ ...withoutSession(current), signed_out_at: this.runtime.now().toISOString() });
      }
      if (err instanceof CliError && !isSessionEnded(err) && err.problem.status >= 400 && err.problem.status < 500 && ![408, 429].includes(err.problem.status)) {
        // A definite refusal did not rotate: allow a corrected subset on the next request.
        const { refresh_request: _refused, ...kept } = grant;
        await this.write({ ...file, oauth: kept });
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

  /** Replace the token subset explicitly; directory memberships never expand it implicitly. */
  async selectProjects(projects: string[]): Promise<string | undefined> {
    if (!projects.length || projects.length > 64 || new Set(projects).size !== projects.length) throw configError("Select 1–64 distinct project IDs.");
    await this.client.ready();
    return this.locked(async () => {
      const file = await this.read();
      if (!file?.oauth) throw configError("Sign in before selecting token projects.");
      if (file.oauth.refresh_request) {
        const pendingProjects = file.oauth.refresh_request.projects;
        const token = await this.refreshLocked(file, file.oauth);
        if (pendingProjects && JSON.stringify([...pendingProjects].sort()) === JSON.stringify([...projects].sort())) return token;
        const settled = (await this.read())!;
        return this.refreshLocked(settled, settled.oauth!, projects);
      }
      return this.refreshLocked(file, file.oauth, projects);
    });
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
