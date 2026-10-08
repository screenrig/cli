import { randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import * as oidc from "openid-client";
import { ExitCode, OAUTH_PROBLEMS } from "./exit-codes.js";
import { CliError, makeProblem, parseRetryAfter, withRetryAfter } from "./problems.js";
import type { Transport, TransportResponse } from "./transport/types.js";

/** The first-party CLI and the plugin's bundled CLI: a public client. */
export const OAUTH_CLIENT_ID = "screenrig-cli";
export const GRANT_TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const GRANT_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
export const TOKEN_TYPE_IDENTITY_CREDENTIAL = "urn:screenrig:token-type:identity-credential";
export const TOKEN_TYPE_PROJECT_TOKEN = "urn:screenrig:token-type:project-token";
export const SCOPE_IDENTITY = "identity";
/** One HTTP attempt. A refresh holds the config lock for at most 15 s: this plus I/O. */
export const OAUTH_TIMEOUT_MS = 10_000;

export type AccessLevel = "read" | "manage";

export interface TokenSet {
  accessToken: string;
  expiresIn: number;
  /** Absent when a device login extends an existing grant: the family does not rotate. */
  refreshToken?: string;
  /** Unix seconds when the refresh family ends at the latest. */
  refreshExpiresAt?: number;
  scope: string[];
}

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type DevicePoll = { status: "pending" } | { status: "slow_down" } | { status: "approved"; tokens: TokenSet };

/** The claims the CLI reads from its own access token. They are never trusted for authorization. */
export interface AccessClaims {
  exp: number;
  prj?: string;
  sid?: string;
  sub?: string;
  scope: string[];
}

export function isSessionJwt(token: string | undefined): token is string {
  return typeof token === "string" && /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

export function accessClaims(token: string | undefined): AccessClaims | undefined {
  if (!isSessionJwt(token)) return undefined;
  try {
    const payload = decodeJwt(token);
    if (typeof payload.exp !== "number") return undefined;
    const scope = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
    return {
      exp: payload.exp,
      ...(typeof payload.prj === "string" && payload.prj ? { prj: payload.prj } : {}),
      ...(typeof payload.sid === "string" && payload.sid ? { sid: payload.sid } : {}),
      ...(typeof payload.sub === "string" ? { sub: payload.sub } : {}),
      scope,
    };
  } catch {
    return undefined;
  }
}

/** A random request_id (256 bits): the token endpoint's replay binding. Never logged. */
export function newOAuthRequestId(): string {
  return randomBytes(32).toString("base64url");
}

/** Plain http is allowed only to this machine, as for every other API request. */
export function loopbackOrigin(url: URL): boolean {
  const host = url.hostname;
  return url.protocol === "http:" && (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]");
}

function oauthProblem(error: string, status: number, description: string | undefined, retryAfter?: string): CliError {
  const row = OAUTH_PROBLEMS[error];
  const detail = description ? `${description} (${error})` : `The authorization server answered ${error}.`;
  if (!row) {
    return new CliError(makeProblem(error.replace(/[^a-z0-9_]/gi, "_") || "oauth_error", "Authorization failed", status, detail));
  }
  const problem = withRetryAfter(makeProblem(row.code, row.title, status, detail, row.next ? { next: row.next } : undefined),
    parseRetryAfter(retryAfter, Date.now()));
  return new CliError(problem, row.exitCode);
}

/** The server offers no agent OAuth (no discovery document, or one this CLI must not use). Callers fall back silently. */
export function oauthUnavailable(detail: string, status = 404): CliError {
  return new CliError(makeProblem("oauth_unavailable", "Sign-in unavailable", status, detail), ExitCode.Unexpected);
}

export function isOAuthUnavailable(err: unknown): boolean {
  return err instanceof CliError && (err.problem.code === "oauth_unavailable" || err.problem.code === "service_unavailable"
    || err.problem.code === "client_not_allowed");
}

function headerRecord(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
  return out;
}

function responseText(response: TransportResponse): string {
  if (typeof response.rawText === "string") return response.rawText;
  if (response.body === undefined || response.body === null) return "";
  if (typeof response.body === "string") return response.body;
  return JSON.stringify(response.body);
}

/**
 * The OAuth client of one API origin. Every request goes through the CLI's
 * transport as a credential request: no redirect is ever followed, and the
 * discovery document must name this exact origin before anything is sent.
 */
export class OAuthClient {
  private configuration?: Promise<oidc.Configuration>;
  /** Set for one device authorization start: the existing identity's access token. */
  private bearer?: string;

  constructor(private readonly apiUrl: string, private readonly transport: Transport) {}

  get issuer(): string {
    return new URL(this.apiUrl).origin;
  }

  private fetch = async (url: string, options: oidc.CustomFetchOptions): Promise<Response> => {
    const target = new URL(url);
    const origin = new URL(this.apiUrl);
    if (target.origin !== origin.origin) {
      throw oauthUnavailable(`The authorization server named ${target.origin}, not ${origin.origin}. Nothing was sent.`, 400);
    }
    const headers = headerRecord(options.headers);
    const body = options.body === undefined ? undefined : String(options.body);
    if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    if (this.bearer && options.method === "POST" && target.pathname.endsWith("/device_authorization")) {
      headers.authorization = `Bearer ${this.bearer}`;
    }
    const response = await this.transport.request({
      method: options.method === "POST" ? "POST" : "GET",
      path: target.pathname,
      headers,
      ...(body !== undefined ? { body } : {}),
      credential: true,
      timeout_ms: OAUTH_TIMEOUT_MS,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new CliError(makeProblem("credential_redirect_refused", "Redirect refused", response.status,
        `The authorization server answered ${target.pathname} with a redirect (HTTP ${response.status}). Nothing was sent onward.`), ExitCode.Unexpected);
    }
    return new Response(response.status === 204 ? null : responseText(response), { status: response.status, headers: response.headers });
  };

  private discover(): Promise<oidc.Configuration> {
    this.configuration ??= this.discoverOnce();
    return this.configuration;
  }

  /** Fetch and validate the discovery document, so no lock is held for it. */
  async ready(): Promise<void> {
    await this.discover();
  }

  private async discoverOnce(): Promise<oidc.Configuration> {
    const server = new URL(this.issuer);
    if (server.protocol !== "https:" && !loopbackOrigin(server)) {
      throw oauthUnavailable(`${server.origin} is not HTTPS. Nothing was sent.`, 400);
    }
    let configuration: oidc.Configuration;
    try {
      configuration = await oidc.discovery(server, OAUTH_CLIENT_ID, undefined, oidc.None(), {
        algorithm: "oauth2",
        [oidc.customFetch]: this.fetch,
        timeout: OAUTH_TIMEOUT_MS / 1000,
        ...(loopbackOrigin(server) ? { execute: [oidc.allowInsecureRequests] } : {}),
      });
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw oauthUnavailable(`${server.origin} has no usable authorization server metadata: ${(err as Error).message}`);
    }
    const metadata = configuration.serverMetadata();
    if (metadata.issuer !== server.origin) {
      throw oauthUnavailable(`The authorization server metadata names issuer ${JSON.stringify(metadata.issuer)}, not ${server.origin}. Nothing was sent.`, 400);
    }
    for (const name of ["token_endpoint", "revocation_endpoint", "device_authorization_endpoint"] as const) {
      const value = metadata[name];
      if (value === undefined) continue;
      let endpoint: URL;
      try { endpoint = new URL(value); } catch { throw oauthUnavailable(`The authorization server metadata has an invalid ${name}. Nothing was sent.`, 400); }
      if (endpoint.origin !== server.origin || (endpoint.protocol !== "https:" && !loopbackOrigin(endpoint))) {
        throw oauthUnavailable(`The authorization server metadata puts ${name} at ${endpoint.origin}, not ${server.origin}. Nothing was sent.`, 400);
      }
    }
    if (!metadata.token_endpoint) throw oauthUnavailable("The authorization server metadata has no token endpoint. Nothing was sent.");
    configuration[oidc.customFetch] = this.fetch;
    configuration.timeout = OAUTH_TIMEOUT_MS / 1000;
    if (loopbackOrigin(server)) oidc.allowInsecureRequests(configuration);
    return configuration;
  }

  private async grant(run: (configuration: oidc.Configuration) => Promise<oidc.TokenEndpointResponse>): Promise<TokenSet> {
    const configuration = await this.discover();
    let response: oidc.TokenEndpointResponse;
    try {
      response = await run(configuration);
    } catch (err) {
      throw await translate(err);
    }
    return tokenSet(response);
  }

  refresh(refreshToken: string, options: { requestId: string; projectId?: string }): Promise<TokenSet> {
    return this.grant((configuration) => oidc.refreshTokenGrant(configuration, refreshToken, {
      request_id: options.requestId,
      ...(options.projectId ? { project_id: options.projectId } : {}),
    }));
  }

  exchange(subjectToken: string, options: { subjectTokenType: string; requestId: string; identity?: boolean; clientVersion: string }): Promise<TokenSet> {
    return this.grant((configuration) => oidc.genericGrantRequest(configuration, GRANT_TOKEN_EXCHANGE, {
      subject_token: subjectToken,
      subject_token_type: options.subjectTokenType,
      request_id: options.requestId,
      client_version: options.clientVersion,
      ...(options.identity ? { scope: SCOPE_IDENTITY } : {}),
    }));
  }

  async startDevice(options: { access: AccessLevel; projectId?: string; name?: string; platform?: string; version?: string; bearer?: string }): Promise<DeviceStart> {
    const configuration = await this.discover();
    if (!configuration.serverMetadata().device_authorization_endpoint) {
      throw oauthUnavailable("The authorization server offers no device sign-in.");
    }
    this.bearer = options.bearer;
    let response: oidc.DeviceAuthorizationResponse;
    try {
      response = await oidc.initiateDeviceAuthorization(configuration, {
        scope: `access:${options.access}`,
        agent_type: "cli",
        ...(options.projectId ? { project_id: options.projectId } : {}),
        ...(options.name ? { name: options.name } : {}),
        ...(options.platform ? { platform: options.platform } : {}),
        ...(options.version ? { version: options.version } : {}),
      });
    } catch (err) {
      throw await translate(err);
    } finally {
      this.bearer = undefined;
    }
    const interval = typeof response.interval === "number" && response.interval >= 5 ? response.interval : 5;
    if (typeof response.verification_uri_complete !== "string") {
      throw new CliError(makeProblem("unexpected_response", "Unexpected response", 200, "The device sign-in answer has no verification_uri_complete."), ExitCode.Unexpected);
    }
    return {
      deviceCode: response.device_code,
      userCode: response.user_code,
      verificationUri: response.verification_uri,
      verificationUriComplete: response.verification_uri_complete,
      expiresIn: response.expires_in,
      interval,
    };
  }

  /** One poll of a device login. Pending and slow_down are states, not errors. */
  async pollDevice(deviceCode: string): Promise<DevicePoll> {
    try {
      return { status: "approved", tokens: await this.grant((configuration) => oidc.genericGrantRequest(configuration, GRANT_DEVICE_CODE, { device_code: deviceCode })) };
    } catch (err) {
      if (err instanceof CliError && err.problem.code === "authorization_pending") return { status: "pending" };
      if (err instanceof CliError && err.problem.code === "slow_down") return { status: "slow_down" };
      throw err;
    }
  }

  /** RFC 7009. The server answers 200 for an unknown or expired token too. */
  async revoke(token: string): Promise<void> {
    const configuration = await this.discover();
    if (!configuration.serverMetadata().revocation_endpoint) throw oauthUnavailable("The authorization server offers no revocation endpoint.");
    try {
      await oidc.tokenRevocation(configuration, token, { token_type_hint: "refresh_token" });
    } catch (err) {
      throw await translate(err);
    }
  }
}

async function translate(err: unknown): Promise<CliError> {
  if (err instanceof CliError) return err;
  if (err instanceof oidc.ResponseBodyError) {
    if (err.error === "authorization_pending" || err.error === "slow_down") {
      return new CliError(makeProblem(err.error, err.error, err.status, err.error_description ?? err.error));
    }
    return oauthProblem(err.error, err.status, err.error_description, err.response.headers.get("retry-after") ?? undefined);
  }
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof CliError) return cause;
  const response = cause instanceof Response ? cause : undefined;
  const status = response?.status ?? 502;
  // oauth4webapi reads an RFC 6749 error body only from a 4xx; a 503
  // temporarily_unavailable arrives here with its body unread.
  if (response && !response.bodyUsed) {
    const body = await response.clone().json().catch(() => undefined) as { error?: unknown; error_description?: unknown } | undefined;
    if (body && typeof body.error === "string") {
      return oauthProblem(body.error, status, typeof body.error_description === "string" ? body.error_description : undefined,
        response.headers.get("retry-after") ?? undefined);
    }
  }
  if (status === 429) return oauthProblem("rate_limited", 429, undefined, response?.headers.get("retry-after") ?? undefined);
  return new CliError(makeProblem("unexpected_response", "Unexpected response", status,
    `The authorization server's answer could not be used: ${(err as Error)?.message ?? String(err)}`), status >= 500 ? ExitCode.Server : ExitCode.Unexpected);
}

function tokenSet(response: oidc.TokenEndpointResponse): TokenSet {
  if (!isSessionJwt(response.access_token) || (response.refresh_token !== undefined && !isSessionJwt(response.refresh_token))) {
    throw new CliError(makeProblem("unexpected_response", "Unexpected response", 200, "The token response does not carry session JWTs."), ExitCode.Unexpected);
  }
  const refreshExpiresAt = (response as { refresh_expires_at?: unknown }).refresh_expires_at;
  return {
    accessToken: response.access_token,
    expiresIn: typeof response.expires_in === "number" ? response.expires_in : 900,
    ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
    ...(typeof refreshExpiresAt === "number" ? { refreshExpiresAt } : {}),
    scope: typeof response.scope === "string" ? response.scope.split(" ").filter(Boolean) : accessClaims(response.access_token)?.scope ?? [],
  };
}
