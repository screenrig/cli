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
  isOAuthUnavailable,
  isSessionJwt,
  newOAuthRequestId,
  OAUTH_CLIENT_ID,
  OAuthClient,
  SCOPE_IDENTITY,
  TOKEN_TYPE_IDENTITY_CREDENTIAL,
  TOKEN_TYPE_PROJECT_TOKEN,
  type ServiceClientCredentials,
  type TokenSet,
} from "./oauth.js";
import { CliError, configError } from "./problems.js";
import { newRequestId } from "./ids.js";
import type { Transport } from "./transport/types.js";
import { CLI_VERSION } from "./version.js";

/** An access token is renewed when it expires within this many seconds. */
export const ACCESS_RENEW_MARGIN_S = 120;
/** A refresh retry within this window reuses its request_id: the server replays the persisted successor. */
const REFRESH_REPLAY_MS = 60_000;
/** An exchange retry within this window reuses its request_id. */
const EXCHANGE_REPLAY_MS = 10 * 60_000;
/** After the server declines to issue, the legacy credential is used without asking again for an hour. */
const UNAVAILABLE_BACKOFF_MS = 60 * 60_000;
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

function isLegacyToken(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("sr_live_");
}

/** Legacy bearers a config holds: its identity credential, and its project tokens by project. */
function legacyCredentials(file: ScreenRigConfig): { identity?: string; projects: Map<string, string> } {
  const projects = new Map<string, string>();
  if (file.project_id && isLegacyToken(file.token)) projects.set(file.project_id, file.token);
  for (const [id, slot] of Object.entries(file.projects ?? {})) {
    if (isLegacyToken(slot?.token) && !projects.has(id)) projects.set(id, slot.token);
  }
  return { ...(isLegacyToken(file.identity_token) ? { identity: file.identity_token } : {}), projects };
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
  const { oauth: _grant, login: _login, oauth_exchange: _exchange, ...rest } = file;
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

/** Put back the legacy credentials an exchange replaced, and drop the grant. */
function restoreLegacy(file: ScreenRigConfig, legacy: NonNullable<OAuthGrantState["legacy"]>): ScreenRigConfig {
  const next = withoutSession(file);
  if (legacy.identity_token) next.identity_token = legacy.identity_token;
  if (legacy.token) next.token = legacy.token;
  for (const [id, token] of Object.entries(legacy.projects ?? {})) {
    if (id === next.project_id && legacy.token) continue;
    next.projects = { ...next.projects, [id]: { ...next.projects?.[id], token } };
  }
  return next;
}

/**
 * One invocation's OAuth session: renews access tokens under the config lock,
 * exchanges a legacy credential when the server issues tokens, and drops the
 * replaced legacy secret once a new access token has authenticated a request.
 */
export class OAuthSession {
  private readonly client: OAuthClient;
  private authenticated = false;
  /** A service client's token lives only in memory; it is minted again rather than refreshed. */
  private serviceAccess?: string;

  constructor(
    private readonly configPath: string,
    private readonly apiUrl: string,
    private readonly transport: Transport,
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

  /** Report a swallowed failure to the operation log at warn, with its cause. */
  private note(op: string, err: unknown): void {
    const logger = this.runtime.logger;
    if (!logger?.enabled) return;
    logger.startLocal({ op, message: op }).error(err);
  }

  private usable(token: string | undefined, projectId: string | undefined): token is string {
    const claims = accessClaims(token);
    if (!claims || claims.exp - this.nowMs() / 1000 <= ACCESS_RENEW_MARGIN_S) return false;
    return projectId ? claims.prj === projectId : claims.scope.includes(SCOPE_IDENTITY);
  }

  /**
   * Credentials for one command. A legacy credential is exchanged first when
   * the server issues tokens; otherwise it stays in use, silently. With a
   * grant, the target project's access token (or, with no project, the
   * identity token) is renewed when it is missing or about to expire.
   */
  async prepare(resolved: ResolvedConfig): Promise<ResolvedConfig> {
    if (this.service) {
      const token = await this.serviceToken();
      const project = accessClaims(token)?.prj;
      if (resolved.projectId && project !== resolved.projectId) {
        throw configError("This service client belongs to another project than --project-id names. Nothing else was sent.");
      }
      return { ...resolved, token, ...(project ? { projectId: project } : {}) };
    }
    let file = await this.read();
    if (!file) return resolved;
    if (!file.oauth && await this.exchangeLegacy(file) && await this.confirmExchange()) file = await this.read();
    if (!file?.oauth) return resolved;
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

  /**
   * ApiClient hook for a 401 on an access token. A session an exchange just
   * created that has never authenticated a request gives way to the legacy
   * credential it replaced; otherwise an invalid_token refusal renews the
   * token once.
   */
  async renewRejected(token: string, invalidToken = true): Promise<string | undefined> {
    if (this.service) return invalidToken ? this.serviceToken(token) : undefined;
    const claims = accessClaims(token);
    if (!claims?.sid) return undefined;
    if (!this.authenticated) {
      const restored = await this.restoreLegacy(claims.prj);
      if (restored) return restored;
    }
    return invalidToken ? this.accessFor(claims.prj, token) : undefined;
  }

  /**
   * One request with the exchanged access token before any command uses it.
   * Success retires the legacy secret; a refusal restores it, so the command
   * runs on the credential that worked. A transport failure decides nothing.
   */
  private async confirmExchange(): Promise<boolean> {
    const file = await this.read();
    const token = file?.project_id && file.token && isSessionJwt(file.token) ? file.token : file?.identity_token;
    if (!isSessionJwt(token)) return true;
    const project = accessClaims(token)?.prj;
    let status: number;
    try {
      status = (await this.transport.request({
        method: "GET", path: project ? "/api/project" : "/api/projects",
        headers: { authorization: `Bearer ${token}`, "x-request-id": newRequestId() }, timeout_ms: 10_000,
      })).status;
    } catch (err) {
      this.note("oauth.exchange_check", err);
      return true;
    }
    if (status >= 200 && status < 300) {
      this.authenticated = true;
      await this.finish();
      return true;
    }
    if (status === 401) return !(await this.restoreLegacy(project));
    return true;
  }

  /** Back to the stashed legacy credential; the unused grant is revoked when the server allows. */
  private async restoreLegacy(projectId: string | undefined): Promise<string | undefined> {
    const refreshToken = await this.locked(async () => {
      const current = await this.read();
      const legacy = current?.oauth?.legacy;
      if (!current?.oauth || !legacy) return undefined;
      const restored = restoreLegacy(current, legacy);
      await this.write({ ...restored, oauth_unavailable_until: new Date(this.nowMs() + UNAVAILABLE_BACKOFF_MS).toISOString() });
      return current.oauth.refresh_token;
    });
    if (!refreshToken) return undefined;
    this.note("oauth.legacy_restored", new Error("the API refused the exchanged session before it authenticated a request"));
    await this.client.revoke(refreshToken).catch((err: unknown) => this.note("oauth.revoke", err));
    const file = await this.read();
    if (!file) return undefined;
    return projectId ? (file.project_id === projectId ? file.token : file.projects?.[projectId]?.token) ?? file.identity_token : file.identity_token;
  }

  /** ApiClient hook: a request this access token authenticated succeeded. */
  noteAuthenticated(token: string): void {
    if (isSessionJwt(token)) this.authenticated = true;
  }

  /** After the command: drop the replaced legacy secret once an access token has worked. */
  async finish(): Promise<void> {
    if (!this.authenticated) return;
    const file = await this.read();
    if (!file?.oauth?.legacy) return;
    await this.locked(async () => {
      const current = await this.read();
      if (!current?.oauth?.legacy) return;
      const { legacy: _retired, ...grant } = current.oauth;
      await this.write({ ...current, oauth: grant });
    });
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
      if (isSessionEnded(err)) {
        const current = (await this.read()) ?? file;
        if (current.oauth?.legacy) {
          // The grant never authenticated a request: go back to the credential it replaced.
          const restored = restoreLegacy(current, current.oauth.legacy);
          await this.write({ ...restored, oauth_unavailable_until: new Date(this.nowMs() + UNAVAILABLE_BACKOFF_MS).toISOString() });
          this.note("oauth.refresh", err);
          return projectId ? (restored.project_id === projectId ? restored.token : restored.projects?.[projectId]?.token) ?? restored.identity_token : restored.identity_token;
        }
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

  /**
   * RFC 8693 exchange of the legacy credential, transparent: no prompt and no
   * output. An identity credential migrates every project in one step; a lone
   * project token asks for identity too, which the server grants only with the
   * project capability. Anything short of a grant leaves the legacy credential
   * in use.
   */
  private async exchangeLegacy(file: ScreenRigConfig): Promise<boolean> {
    const until = file.oauth_unavailable_until ? Date.parse(file.oauth_unavailable_until) : NaN;
    if (Number.isFinite(until) && until > this.nowMs()) return false;
    const legacy = legacyCredentials(file);
    const subject = legacy.identity ?? (legacy.projects.size === 1 ? [...legacy.projects.values()][0] : undefined);
    if (!subject) return false;
    const subjectTokenType = legacy.identity ? TOKEN_TYPE_IDENTITY_CREDENTIAL : TOKEN_TYPE_PROJECT_TOKEN;
    try {
      await this.client.ready();
    } catch (err) {
      this.note("oauth.exchange", err);
      if (isOAuthUnavailable(err)) await this.markUnavailable().catch(() => undefined);
      return false;
    }
    try {
      return await this.locked(async () => {
        const current = await this.read();
        if (!current || current.oauth) return Boolean(current?.oauth);
        const now = legacyCredentials(current);
        if ((now.identity ?? (now.projects.size === 1 ? [...now.projects.values()][0] : undefined)) !== subject) return false;
        const source = digest(subject);
        let pending = current.oauth_exchange;
        if (!pending || pending.source !== source || this.nowMs() - Date.parse(pending.started_at) >= EXCHANGE_REPLAY_MS) {
          pending = { request_id: newOAuthRequestId(), source, started_at: this.runtime.now().toISOString() };
          await this.write({ ...current, oauth_exchange: pending });
        }
        let tokens: TokenSet;
        try {
          const exchange = (identity: boolean) => this.client.exchange(subject, {
            subjectTokenType, requestId: pending!.request_id, identity, clientVersion: CLI_VERSION,
          });
          try {
            tokens = await exchange(!legacy.identity);
          } catch (err) {
            // Identity needs the membership's project capability; without it the grant stays confined to its project.
            if (legacy.identity || !(err instanceof CliError) || err.problem.code !== "insufficient_access") throw err;
            tokens = await exchange(false);
          }
        } catch (err) {
          const latest = (await this.read()) ?? current;
          const { oauth_exchange: _pending, ...rest } = latest;
          if (isOAuthUnavailable(err) || (err instanceof CliError && ["credential_retired", "invalid_request", "credential_redirect_refused", "unexpected_response"].includes(err.problem.code))) {
            await this.write({ ...rest, oauth_unavailable_until: new Date(this.nowMs() + UNAVAILABLE_BACKOFF_MS).toISOString() });
          } else if (isSessionEnded(err)) {
            await this.write(rest);
          }
          throw err;
        }
        if (!tokens.refreshToken) throw configError("The exchange answered without a refresh token.");
        const latest = (await this.read()) ?? current;
        const stash: NonNullable<OAuthGrantState["legacy"]> = {
          ...(isLegacyToken(latest.token) ? { token: latest.token } : {}),
          ...(isLegacyToken(latest.identity_token) ? { identity_token: latest.identity_token } : {}),
        };
        const replaced: Record<string, string> = {};
        let next: ScreenRigConfig = { ...latest };
        if (isLegacyToken(next.token)) delete next.token;
        if (isLegacyToken(next.identity_token)) delete next.identity_token;
        if (next.projects) {
          next.projects = Object.fromEntries(Object.entries(next.projects).map(([id, slot]) => {
            if (!isLegacyToken(slot?.token)) return [id, slot];
            replaced[id] = slot.token;
            const { token: _token, ...kept } = slot;
            return [id, kept];
          }));
        }
        if (Object.keys(replaced).length) stash.projects = replaced;
        const { oauth_exchange: _done, oauth_unavailable_until: _until, identity_exchange: _identity, ...cleaned } = next;
        next = placeAccessToken(cleaned, tokens.accessToken, tokens.scope);
        await this.write({
          ...next,
          oauth: {
            issuer: this.client.issuer,
            client_id: OAUTH_CLIENT_ID,
            refresh_token: tokens.refreshToken,
            ...(tokens.refreshExpiresAt !== undefined ? { refresh_expires_at: tokens.refreshExpiresAt } : {}),
            identity: tokens.scope.includes(SCOPE_IDENTITY),
            legacy: stash,
          },
        });
        return true;
      });
    } catch (err) {
      // The legacy credential keeps working: the exchange never fails the command.
      this.note("oauth.exchange", err);
      return false;
    }
  }

  private async markUnavailable(): Promise<void> {
    await this.locked(async () => {
      const current = await this.read();
      if (!current || current.oauth) return;
      await this.write({ ...current, oauth_unavailable_until: new Date(this.nowMs() + UNAVAILABLE_BACKOFF_MS).toISOString() });
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
