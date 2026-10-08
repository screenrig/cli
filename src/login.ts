import { randomBytes } from "node:crypto";
import { readConfigFile, withConfigLock, writeConfigAtomic, type PendingLogin, type ScreenRigConfig } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { accessClaims, OAUTH_CLIENT_ID, SCOPE_IDENTITY, type AccessLevel, type TokenSet } from "./oauth.js";
import { placeAccessToken, withoutSession, type OAuthSession, type SessionRuntime } from "./oauth-session.js";
import { CliError, configError, makeProblem, usageError } from "./problems.js";
import { selectProject } from "./project-state.js";

/** RFC 8628 §3.5: on network errors and timeouts the interval doubles, up to this. */
export const LOGIN_MAX_INTERVAL_S = 60;
const LOGIN_ID_RE = /^login_[A-Za-z0-9_-]{22}$/;

export interface LoginRequest {
  access: AccessLevel;
  project?: string;
  name?: string;
  platform?: string;
  version?: string;
  wait: boolean;
  resume?: string;
}

export type LoginOutcome =
  | { status: "pending"; login: PendingLogin; resumed: boolean }
  | { status: "signed_in"; login: PendingLogin; projectId?: string; agentId?: string; scope: string[]; extended: boolean };

function loginProblem(code: "login_expired" | "login_not_found", detail: string): CliError {
  return code === "login_expired"
    ? new CliError(makeProblem(code, "Sign-in expired", 400, detail, { next: { command: "screenrig login", reason: "Start a new sign-in; each code lasts 10 minutes." } }), ExitCode.Timeout)
    : new CliError(makeProblem(code, "No pending sign-in", 404, detail, { next: { command: "screenrig login", reason: "Start a new sign-in." } }), ExitCode.Usage);
}

/** Transport failures and dependency answers that leave the sign-in pending: poll again, more slowly. */
function retriable(err: unknown): boolean {
  return err instanceof CliError && ["transport_error", "timeout", "service_unavailable", "rate_limited", "unexpected_response"].includes(err.problem.code);
}

/**
 * `screenrig login`: the OAuth device grant. The device code is kept in the
 * config's pending-login slot (0600, written under the lock) and polled
 * outside the lock; the lock is taken again only to store the tokens.
 */
export class DeviceLogin {
  constructor(
    private readonly session: OAuthSession,
    private readonly configPath: string,
    private readonly runtime: SessionRuntime,
  ) {}

  private read(): Promise<ScreenRigConfig | undefined> {
    return readConfigFile(this.configPath, this.runtime.fs);
  }

  private locked<T>(action: () => Promise<T>): Promise<T> {
    return withConfigLock(this.configPath, this.runtime.fs, { sleep: this.runtime.sleep, now: () => this.runtime.now().getTime() }, action);
  }

  private write(config: ScreenRigConfig): Promise<void> {
    return writeConfigAtomic(this.configPath, { ...config, updated_at: this.runtime.now().toISOString() }, this.runtime.fs);
  }

  private expired(login: PendingLogin): boolean {
    return Date.parse(login.expires_at) <= this.runtime.now().getTime();
  }

  /** Drop the pending-login slot, only when it is still this sign-in. */
  async clear(id: string): Promise<void> {
    await this.locked(async () => {
      const current = await this.read();
      if (current?.login?.id !== id) return;
      const { login: _ended, ...rest } = current;
      await this.write(rest);
    });
  }

  /** The pending sign-in to continue: the one --resume names, or one started with the same request. */
  private async pending(request: LoginRequest): Promise<PendingLogin | undefined> {
    const file = await this.read();
    const login = file?.login;
    if (request.resume !== undefined) {
      if (!LOGIN_ID_RE.test(request.resume)) throw usageError("login --resume takes the login_ handle a pending sign-in printed.");
      if (!login || login.id !== request.resume) throw loginProblem("login_not_found", `No pending sign-in ${request.resume} is stored in this config.`);
      if (this.expired(login)) {
        await this.clear(login.id);
        throw loginProblem("login_expired", "The pending sign-in expired before it was approved.");
      }
      return login;
    }
    if (login && !this.expired(login) && login.access === request.access && login.project_id === request.project) return login;
    return undefined;
  }

  async run(request: LoginRequest, onPending: (login: PendingLogin, resumed: boolean) => void): Promise<LoginOutcome> {
    let login = await this.pending(request);
    const resumed = login !== undefined;
    if (!login) login = await this.start(request);
    if (!request.wait) return { status: "pending", login, resumed };
    onPending(login, resumed);
    const tokens = await this.poll(login);
    return this.store(login, tokens);
  }

  private async start(request: LoginRequest): Promise<PendingLogin> {
    // An installation that already holds identity access extends its grant; anything else starts a new installation.
    const bearer = await this.session.identityToken();
    const started = await this.session.oauth.startDevice({
      access: request.access,
      ...(request.project ? { projectId: request.project } : {}),
      ...(request.name ? { name: request.name } : {}),
      ...(request.platform ? { platform: request.platform } : {}),
      ...(request.version ? { version: request.version } : {}),
      ...(bearer ? { bearer } : {}),
    });
    const login: PendingLogin = {
      id: `login_${randomBytes(16).toString("base64url")}`,
      issuer: this.session.oauth.issuer,
      device_code: started.deviceCode,
      user_code: started.userCode,
      verification_uri: started.verificationUri,
      verification_uri_complete: started.verificationUriComplete,
      expires_at: new Date(this.runtime.now().getTime() + started.expiresIn * 1000).toISOString(),
      interval: started.interval,
      access: request.access,
      ...(request.project ? { project_id: request.project } : {}),
      ...(bearer ? { extends_grant: true } : {}),
    };
    await this.locked(async () => {
      const current = await this.read();
      await this.write({ ...(current ?? { api_url: this.session.oauth.issuer }), login });
    });
    return login;
  }

  /** Poll outside the lock until approval, denial or expiry. */
  private async poll(login: PendingLogin): Promise<TokenSet> {
    let interval = Math.max(login.interval, 5);
    // A fixed clock in a harness never reaches expires_at; the poll count bounds it too.
    const budget = Math.ceil((Date.parse(login.expires_at) - this.runtime.now().getTime()) / 5000) + 2;
    for (let attempt = 0; attempt < budget; attempt += 1) {
      if (this.expired(login)) break;
      await this.runtime.sleep(interval * 1000);
      let result;
      try {
        result = await this.session.oauth.pollDevice(login.device_code);
      } catch (err) {
        if (retriable(err)) {
          interval = Math.min(interval * 2, LOGIN_MAX_INTERVAL_S);
          continue;
        }
        if (err instanceof CliError && ["login_denied", "login_expired", "session_ended"].includes(err.problem.code)) {
          await this.clear(login.id);
        }
        throw err;
      }
      if (result.status === "approved") return result.tokens;
      if (result.status === "slow_down") interval += 5;
    }
    await this.clear(login.id);
    throw loginProblem("login_expired", "Nobody approved the sign-in before its code expired.");
  }

  /** Store the tokens under the lock and select the approved project. */
  private async store(login: PendingLogin, tokens: TokenSet): Promise<LoginOutcome> {
    const claims = accessClaims(tokens.accessToken);
    const agentId = claims?.sub?.startsWith("agent:") ? claims.sub.slice("agent:".length) : undefined;
    const extended = tokens.refreshToken === undefined;
    await this.locked(async () => {
      const current = await this.read();
      if (!current || current.login?.id !== login.id) throw configError("The pending sign-in changed before its tokens were stored. Run screenrig login again.");
      const { login: _done, signed_out_at: _signedOut, ...rest } = current;
      let next: ScreenRigConfig;
      if (extended) {
        if (!rest.oauth) throw configError("The sign-in extended a grant this config no longer holds. Run screenrig login again.");
        next = placeAccessToken(rest, tokens.accessToken, tokens.scope);
      } else {
        // A new installation: nothing of a previous credential or its projects carries over.
        const cleared = withoutSession(rest);
        const { token: _t, identity_token: _i, identity_exchange: _x, identity_writes: _w, projects: _p, project_id: _id, project_name: _n,
          organization_id: _o, organization_name: _on, agent_connection: _c, enrollment: _e, enrollment_project: _ep, enrollment_cleanup: _ec,
          last_agent: _la, oauth_unavailable_until: _u, screen_provision: _sp, browser_setup: _bs, media_generate: _mg, pending_writes: _pw, ...kept } = cleared;
        next = placeAccessToken({ ...kept, api_url: rest.api_url ?? this.session.oauth.issuer }, tokens.accessToken, tokens.scope);
        next.oauth = {
          issuer: login.issuer,
          client_id: OAUTH_CLIENT_ID,
          refresh_token: tokens.refreshToken!,
          ...(tokens.refreshExpiresAt !== undefined ? { refresh_expires_at: tokens.refreshExpiresAt } : {}),
          identity: tokens.scope.includes(SCOPE_IDENTITY),
        };
        if (agentId) next.agent_id = agentId;
      }
      if (claims?.prj && next.project_id !== claims.prj) next = selectProject(next, claims.prj);
      await this.write(next);
    });
    return { status: "signed_in", login, ...(claims?.prj ? { projectId: claims.prj } : {}), ...(agentId ? { agentId } : {}), scope: tokens.scope, extended };
  }
}
