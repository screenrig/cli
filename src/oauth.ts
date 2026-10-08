import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { calculateJwkThumbprint, decodeJwt, importJWK, importPKCS8, type JWK } from "jose";
import * as oidc from "openid-client";
import { ExitCode, OAUTH_PROBLEMS } from "./exit-codes.js";
import { CliError, makeProblem, parseRetryAfter, withRetryAfter } from "./problems.js";
import { redactText } from "./redact.js";
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
  /** `client_id` on a service token: the service client. */
  clientId?: string;
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
      ...(typeof payload.client_id === "string" ? { clientId: payload.client_id } : {}),
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

  constructor(
    private readonly apiUrl: string,
    private readonly transport: Transport,
    /** A service client authenticates itself; the CLI is a public client. */
    private readonly service?: ServiceClientCredentials,
  ) {}

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
      configuration = await oidc.discovery(server, this.service?.clientId ?? OAUTH_CLIENT_ID, undefined, this.service?.auth ?? oidc.None(), {
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

  /** A service client's token: 15 minutes, its project, no refresh token. */
  clientCredentials(options: { resource?: string } = {}): Promise<TokenSet> {
    if (!this.service) throw new CliError(makeProblem("client_not_allowed", "Client not allowed", 400, "Only a service client uses client credentials."), ExitCode.Auth);
    return this.grant((configuration) => oidc.clientCredentialsGrant(configuration, options.resource ? { resource: options.resource } : {}));
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
  const reason = [(err as Error)?.message ?? String(err), cause instanceof Error ? cause.message : undefined].filter(Boolean).join(": ");
  return new CliError(makeProblem("unexpected_response", "Unexpected response", status,
    redactText(`The authorization server's answer could not be used: ${reason}`)), status >= 500 ? ExitCode.Server : ExitCode.Unexpected);
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

/** How a service client authenticates at the token endpoint. Never printed. */
export interface ServiceClientCredentials {
  clientId: string;
  auth: oidc.ClientAuth;
  method: "client_secret_basic" | "private_key_jwt";
}

const SERVICE_CLIENT_ID_RE = /^(?:(?:stage|qa|development)_)?scl_[A-Za-z0-9_-]+$/;

export function isServiceClientId(value: string | undefined): value is string {
  return typeof value === "string" && SERVICE_CLIENT_ID_RE.test(value);
}

function credentialsError(detail: string): CliError {
  return new CliError(makeProblem("config_error", "Service client configuration", 400, detail, {
    next: { command: "screenrig service-client --help", reason: "Shows how a service client is created and which variables a run sets." },
  }), ExitCode.Config);
}

/** The signing algorithm a key's type allows: Ed25519, P-256 or RSA of at least 2048 bits. */
function algorithmOf(jwk: JWK): "EdDSA" | "ES256" | "RS256" {
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return "EdDSA";
  if (jwk.kty === "EC" && jwk.crv === "P-256") return "ES256";
  if (jwk.kty === "RSA" && typeof jwk.n === "string" && Buffer.from(jwk.n, "base64url").length * 8 >= 2048) return "RS256";
  throw credentialsError("The key must be Ed25519, EC P-256 or RSA of at least 2048 bits.");
}

/** The public half of a JWK, without private members. */
export function publicJwk(jwk: JWK): JWK {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, oth: _oth, k: _k, key_ops: _ops, ext: _ext, ...rest } = jwk as JWK & Record<string, unknown>;
  return rest as JWK;
}

/**
 * Read a key file: a JWK (JSON) or a PEM key. A private key yields its public
 * half too, for registration. A key without a kid takes its RFC 7638
 * thumbprint, as the server does when it registers one.
 */
export async function readKeyFile(text: string): Promise<{ publicKey: JWK; privateKey?: JWK; kid: string; alg: "EdDSA" | "ES256" | "RS256" }> {
  let jwk: JWK;
  const trimmed = text.trim();
  try {
    if (trimmed.startsWith("{")) {
      jwk = JSON.parse(trimmed) as JWK;
    } else if (trimmed.includes("PRIVATE KEY")) {
      jwk = createPrivateKey(trimmed).export({ format: "jwk" }) as JWK;
    } else {
      jwk = createPublicKey(trimmed).export({ format: "jwk" }) as JWK;
    }
  } catch {
    throw credentialsError("The key file is not a JWK or a PEM key.");
  }
  if (!jwk || typeof jwk !== "object" || typeof jwk.kty !== "string") throw credentialsError("The key file is not a JWK or a PEM key.");
  const alg = algorithmOf(jwk);
  const publicKey = publicJwk(jwk);
  const kid = typeof jwk.kid === "string" && jwk.kid ? jwk.kid : await calculateJwkThumbprint(publicKey, "sha256");
  return { publicKey: { ...publicKey, kid }, ...(typeof jwk.d === "string" ? { privateKey: { ...jwk, kid } } : {}), kid, alg };
}

/**
 * Service-client mode from the environment: SCREENRIG_CLIENT_ID with
 * SCREENRIG_CLIENT_SECRET (HTTP Basic) or SCREENRIG_CLIENT_KEY_FILE
 * (private_key_jwt). Undefined when SCREENRIG_CLIENT_ID is unset.
 */
export async function serviceCredentialsFromEnv(env: NodeJS.Dict<string>, readText: (file: string) => Promise<string>): Promise<ServiceClientCredentials | undefined> {
  const clientId = env.SCREENRIG_CLIENT_ID;
  const secret = env.SCREENRIG_CLIENT_SECRET;
  const keyFile = env.SCREENRIG_CLIENT_KEY_FILE;
  if (!clientId) {
    if (secret || keyFile) throw credentialsError("SCREENRIG_CLIENT_SECRET and SCREENRIG_CLIENT_KEY_FILE need SCREENRIG_CLIENT_ID.");
    return undefined;
  }
  if (!isServiceClientId(clientId)) throw credentialsError("SCREENRIG_CLIENT_ID must be a service client id (scl_...).");
  if (Boolean(secret) === Boolean(keyFile)) throw credentialsError("Set exactly one of SCREENRIG_CLIENT_SECRET or SCREENRIG_CLIENT_KEY_FILE with SCREENRIG_CLIENT_ID.");
  if (secret) return { clientId, auth: oidc.ClientSecretBasic(secret), method: "client_secret_basic" };
  let text: string;
  try {
    text = await readText(keyFile!);
  } catch {
    throw credentialsError("SCREENRIG_CLIENT_KEY_FILE cannot be read.");
  }
  const key = await readKeyFile(text);
  if (!key.privateKey) throw credentialsError("SCREENRIG_CLIENT_KEY_FILE must hold the private key; the server keeps only the public one.");
  const privateKey = await importJWK(key.privateKey, key.alg);
  if (!(privateKey instanceof CryptoKey)) throw credentialsError("SCREENRIG_CLIENT_KEY_FILE holds no usable private key.");
  // oauth4webapi names an Ed25519 key's algorithm "Ed25519" (RFC 9864); the server accepts the identical signature as EdDSA.
  const auth = oidc.PrivateKeyJwt({ key: privateKey, kid: key.kid }, {
    [oidc.modifyAssertion]: (header) => { if (header.alg === "Ed25519") header.alg = "EdDSA"; },
  });
  return { clientId, auth, method: "private_key_jwt" };
}
