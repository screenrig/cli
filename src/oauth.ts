import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { ExitCode, OAUTH_PROBLEMS } from "./exit-codes.js";
import { CliError, makeProblem, parseRetryAfter, withRetryAfter } from "./problems.js";
import { redactText } from "./redact.js";
import type { Transport, TransportResponse } from "./transport/types.js";

/** The first-party CLI and the plugin's bundled CLI: a public client. */
export const OAUTH_CLIENT_ID = "screenrig-cli";
export const GRANT_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
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
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
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

/** The server offers no agent OAuth (no discovery document, or one this CLI must not use). */
export function oauthUnavailable(detail: string, status = 404): CliError {
  return new CliError(makeProblem("oauth_unavailable", "Sign-in unavailable", status, detail), ExitCode.Unexpected);
}

/** An RFC 6749 §5.2 error body, or undefined for an answer that is not one. */
function errorBody(body: unknown): { error: string; error_description?: string } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const { error, error_description: description } = body as { error?: unknown; error_description?: unknown };
  return typeof error === "string" && error ? { error, ...(typeof description === "string" ? { error_description: description } : {}) } : undefined;
}

function jsonObject(response: TransportResponse): Record<string, unknown> | undefined {
  let body = response.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body) as unknown; } catch { return undefined; }
  }
  return body && typeof body === "object" && !Array.isArray(body) && !(body instanceof Uint8Array) ? body as Record<string, unknown> : undefined;
}

function unexpected(status: number, detail: string): CliError {
  return new CliError(makeProblem("unexpected_response", "Unexpected response", status, redactText(detail)), status >= 500 ? ExitCode.Server : ExitCode.Unexpected);
}

/** The refusal an answer that is not a success carries: an RFC 6749 error by code, else by status. */
function refusal(response: TransportResponse, what: string): CliError {
  const body = errorBody(jsonObject(response));
  const retryAfter = response.headers["retry-after"];
  if (body) {
    if (body.error === "authorization_pending" || body.error === "slow_down") {
      return new CliError(makeProblem(body.error, body.error, response.status, body.error_description ?? body.error));
    }
    return oauthProblem(body.error, response.status, body.error_description, retryAfter);
  }
  if (response.status === 429) return oauthProblem("rate_limited", 429, undefined, retryAfter);
  return unexpected(response.status, `The authorization server answered ${what} with HTTP ${response.status} and no OAuth error.`);
}

function tokenSet(response: TransportResponse): TokenSet {
  const body = jsonObject(response);
  const accessToken = body?.access_token;
  const refreshToken = body?.refresh_token;
  if (!body || typeof accessToken !== "string" || !isSessionJwt(accessToken) || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer"
    || (refreshToken !== undefined && (typeof refreshToken !== "string" || !isSessionJwt(refreshToken)))) {
    throw unexpected(response.status, "The token response does not carry a bearer session JWT.");
  }
  const refreshExpiresAt = body.refresh_expires_at;
  return {
    accessToken,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
    ...(typeof refreshToken === "string" ? { refreshToken } : {}),
    ...(typeof refreshExpiresAt === "number" ? { refreshExpiresAt } : {}),
    scope: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : accessClaims(accessToken)?.scope ?? [],
  };
}

interface Metadata {
  issuer: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  device_authorization_endpoint?: string;
}

/** RFC 6749 §2.3.1: client_id and secret are form-encoded before HTTP Basic. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

/**
 * The OAuth client of one API origin. Every request goes through the CLI's
 * transport as a credential request: no redirect is ever followed, and the
 * discovery document must name this exact origin before anything is sent.
 */
export class OAuthClient {
  private metadata?: Promise<Metadata>;

  constructor(
    private readonly apiUrl: string,
    private readonly transport: Transport,
    /** A service client authenticates itself; the CLI is a public client. */
    private readonly service?: ServiceClientCredentials,
  ) {}

  get issuer(): string {
    return new URL(this.apiUrl).origin;
  }

  /** One request to the authorization server, never redirected. */
  private async send(method: "GET" | "POST", endpoint: string, form?: URLSearchParams, headers: Record<string, string> = {}): Promise<TransportResponse> {
    const target = new URL(endpoint);
    if (target.origin !== this.issuer) {
      throw oauthUnavailable(`The authorization server named ${target.origin}, not ${this.issuer}. Nothing was sent.`, 400);
    }
    const response = await this.transport.request({
      method,
      path: target.pathname,
      headers: { accept: "application/json", ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...headers },
      ...(form ? { body: form.toString() } : {}),
      credential: true,
      timeout_ms: OAUTH_TIMEOUT_MS,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new CliError(makeProblem("credential_redirect_refused", "Redirect refused", response.status,
        `The authorization server answered ${target.pathname} with a redirect (HTTP ${response.status}). Nothing was sent onward.`), ExitCode.Unexpected);
    }
    return response;
  }

  private discover(): Promise<Metadata> {
    this.metadata ??= this.discoverOnce();
    return this.metadata;
  }

  /** Fetch and validate the discovery document, so no lock is held for it. */
  async ready(): Promise<void> {
    await this.discover();
  }

  /** RFC 8414 metadata, accepted only when it names this exact origin and serves every endpoint from it. */
  private async discoverOnce(): Promise<Metadata> {
    const server = new URL(this.issuer);
    if (server.protocol !== "https:" && !loopbackOrigin(server)) {
      throw oauthUnavailable(`${server.origin} is not HTTPS. Nothing was sent.`, 400);
    }
    const response = await this.send("GET", `${server.origin}/.well-known/oauth-authorization-server`);
    const metadata = response.status === 200 ? jsonObject(response) : undefined;
    if (!metadata) throw oauthUnavailable(`${server.origin} has no authorization server metadata (HTTP ${response.status}).`, response.status === 200 ? 502 : response.status);
    if (metadata.issuer !== server.origin) {
      throw oauthUnavailable(`The authorization server metadata names issuer ${JSON.stringify(metadata.issuer)}, not ${server.origin}. Nothing was sent.`, 400);
    }
    for (const name of ["token_endpoint", "revocation_endpoint", "device_authorization_endpoint"] as const) {
      const value = metadata[name];
      if (value === undefined) continue;
      let endpoint: URL;
      try { endpoint = new URL(String(value)); } catch { throw oauthUnavailable(`The authorization server metadata has an invalid ${name}. Nothing was sent.`, 400); }
      if (typeof value !== "string" || endpoint.origin !== server.origin || (endpoint.protocol !== "https:" && !loopbackOrigin(endpoint))) {
        throw oauthUnavailable(`The authorization server metadata puts ${name} at ${endpoint.origin}, not ${server.origin}. Nothing was sent.`, 400);
      }
    }
    if (typeof metadata.token_endpoint !== "string") throw oauthUnavailable("The authorization server metadata has no token endpoint. Nothing was sent.");
    return metadata as unknown as Metadata;
  }

  /** Client authentication: a service client by HTTP Basic or a signed assertion, the CLI by its public client_id. */
  private authenticate(form: URLSearchParams, metadata: Metadata): Record<string, string> {
    const service = this.service;
    if (!service) {
      form.set("client_id", OAUTH_CLIENT_ID);
      return {};
    }
    if (service.method === "client_secret_basic") {
      return { authorization: `Basic ${Buffer.from(`${formEncode(service.clientId)}:${formEncode(service.secret)}`).toString("base64")}` };
    }
    form.set("client_id", service.clientId);
    form.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
    form.set("client_assertion", clientAssertion(service, metadata.issuer));
    return {};
  }

  private async grant(params: Record<string, string>): Promise<TokenSet> {
    const metadata = await this.discover();
    const form = new URLSearchParams(params);
    const headers = this.authenticate(form, metadata);
    const response = await this.send("POST", metadata.token_endpoint, form, headers);
    if (response.status !== 200) throw refusal(response, "the token request");
    return tokenSet(response);
  }

  refresh(refreshToken: string, options: { requestId: string; projectId?: string }): Promise<TokenSet> {
    return this.grant({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      request_id: options.requestId,
      ...(options.projectId ? { project_id: options.projectId } : {}),
    });
  }

  async startDevice(options: { access: AccessLevel; projectId?: string; name?: string; platform?: string; version?: string; bearer?: string }): Promise<DeviceStart> {
    const metadata = await this.discover();
    if (!metadata.device_authorization_endpoint) throw oauthUnavailable("The authorization server offers no device sign-in.");
    const form = new URLSearchParams({
      scope: `access:${options.access}`,
      agent_type: "cli",
      ...(options.projectId ? { project_id: options.projectId } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.version ? { version: options.version } : {}),
    });
    const headers = { ...this.authenticate(form, metadata), ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}) };
    const response = await this.send("POST", metadata.device_authorization_endpoint, form, headers);
    if (response.status !== 200) throw refusal(response, "the device sign-in");
    const body = jsonObject(response);
    if (!body || typeof body.device_code !== "string" || typeof body.user_code !== "string" || typeof body.verification_uri !== "string"
      || typeof body.verification_uri_complete !== "string" || typeof body.expires_in !== "number") {
      throw unexpected(200, "The device sign-in answer is incomplete.");
    }
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      verificationUriComplete: body.verification_uri_complete,
      expiresIn: body.expires_in,
      interval: typeof body.interval === "number" && body.interval >= 5 ? body.interval : 5,
    };
  }

  /** A service client's token: 15 minutes, its project, no refresh token. */
  clientCredentials(options: { resource?: string } = {}): Promise<TokenSet> {
    if (!this.service) throw new CliError(makeProblem("client_not_allowed", "Client not allowed", 400, "Only a service client uses client credentials."), ExitCode.Auth);
    return this.grant({ grant_type: "client_credentials", ...(options.resource ? { resource: options.resource } : {}) });
  }

  /** One poll of a device login. Pending and slow_down are states, not errors. */
  async pollDevice(deviceCode: string): Promise<DevicePoll> {
    try {
      return { status: "approved", tokens: await this.grant({ grant_type: GRANT_DEVICE_CODE, device_code: deviceCode }) };
    } catch (err) {
      if (err instanceof CliError && err.problem.code === "authorization_pending") return { status: "pending" };
      if (err instanceof CliError && err.problem.code === "slow_down") return { status: "slow_down" };
      throw err;
    }
  }

  /** RFC 7009. The server answers 200 for an unknown or expired token too. */
  async revoke(token: string): Promise<void> {
    const metadata = await this.discover();
    if (!metadata.revocation_endpoint) throw oauthUnavailable("The authorization server offers no revocation endpoint.");
    const form = new URLSearchParams({ token, token_type_hint: "refresh_token" });
    const headers = this.authenticate(form, metadata);
    const response = await this.send("POST", metadata.revocation_endpoint, form, headers);
    if (response.status !== 200) throw refusal(response, "the revocation");
  }
}

const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** An assertion is good for 60 s; the server allows at most 5 minutes. */
const ASSERTION_LIFETIME_S = 60;

/** RFC 7523 client assertion: iss = sub = client_id, aud the issuer as one string, a fresh jti, the key's kid. */
export function clientAssertion(service: Extract<ServiceClientCredentials, { method: "private_key_jwt" }>, issuer: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${part({ alg: service.alg, kid: service.kid, typ: "JWT" })}.${part({
    iss: service.clientId, sub: service.clientId, aud: issuer, iat, nbf: iat, exp: iat + ASSERTION_LIFETIME_S, jti: randomBytes(16).toString("base64url"),
  })}`;
  const data = Buffer.from(input);
  const signature = service.alg === "EdDSA" ? sign(null, data, service.key)
    : service.alg === "ES256" ? sign("sha256", data, { key: service.key, dsaEncoding: "ieee-p1363" })
      : sign("sha256", data, service.key);
  return `${input}.${signature.toString("base64url")}`;
}

/** How a service client authenticates at the token endpoint. Never printed. */
export type ServiceClientCredentials =
  | { clientId: string; method: "client_secret_basic"; secret: string }
  | { clientId: string; method: "private_key_jwt"; key: KeyObject; kid: string; alg: "EdDSA" | "ES256" | "RS256" };

/** A JSON Web Key, as read from a key file or sent for registration. */
export interface Jwk {
  kty: string;
  kid?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  d?: string;
  [member: string]: unknown;
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
function algorithmOf(jwk: Jwk): "EdDSA" | "ES256" | "RS256" {
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return "EdDSA";
  if (jwk.kty === "EC" && jwk.crv === "P-256") return "ES256";
  if (jwk.kty === "RSA" && typeof jwk.n === "string" && Buffer.from(jwk.n, "base64url").length * 8 >= 2048) return "RS256";
  throw credentialsError("The key must be Ed25519, EC P-256 or RSA of at least 2048 bits.");
}

/** The public half of a JWK, without private members. */
export function publicJwk(jwk: Jwk): Jwk {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, oth: _oth, k: _k, key_ops: _ops, ext: _ext, ...rest } = jwk;
  return rest as Jwk;
}

/** RFC 7638 SHA-256 thumbprint: the required members in lexicographic order, no whitespace. */
export function jwkThumbprint(jwk: Jwk): string {
  const required = jwk.kty === "RSA" ? { e: jwk.e, kty: jwk.kty, n: jwk.n }
    : jwk.kty === "EC" ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
      : { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  return createHash("sha256").update(JSON.stringify(required)).digest("base64url");
}

/**
 * Read a key file: a JWK (JSON) or a PEM key. A private key yields its public
 * half too, for registration. A key without a kid takes its RFC 7638
 * thumbprint, as the server does when it registers one.
 */
export function readKeyFile(text: string): { publicKey: Jwk; privateKey?: KeyObject; kid: string; alg: "EdDSA" | "ES256" | "RS256" } {
  const trimmed = text.trim();
  let jwk: Jwk;
  let privateKey: KeyObject | undefined;
  try {
    if (trimmed.startsWith("{")) {
      jwk = JSON.parse(trimmed) as Jwk;
      if (typeof jwk.d === "string") privateKey = createPrivateKey({ key: jwk as never, format: "jwk" });
    } else if (trimmed.includes("PRIVATE KEY")) {
      privateKey = createPrivateKey(trimmed);
      jwk = privateKey.export({ format: "jwk" }) as Jwk;
    } else {
      jwk = createPublicKey(trimmed).export({ format: "jwk" }) as Jwk;
    }
  } catch {
    throw credentialsError("The key file is not a JWK or a PEM key.");
  }
  if (!jwk || typeof jwk !== "object" || typeof jwk.kty !== "string") throw credentialsError("The key file is not a JWK or a PEM key.");
  const alg = algorithmOf(jwk);
  const publicKey = publicJwk(jwk);
  const kid = typeof jwk.kid === "string" && jwk.kid ? jwk.kid : jwkThumbprint(publicKey);
  return { publicKey: { ...publicKey, kid }, ...(privateKey ? { privateKey } : {}), kid, alg };
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
  if (secret) return { clientId, method: "client_secret_basic", secret };
  let text: string;
  try {
    text = await readText(keyFile!);
  } catch {
    throw credentialsError("SCREENRIG_CLIENT_KEY_FILE cannot be read.");
  }
  const key = readKeyFile(text);
  if (!key.privateKey) throw credentialsError("SCREENRIG_CLIENT_KEY_FILE must hold the private key; the server keeps only the public one.");
  return { clientId, method: "private_key_jwt", key: key.privateKey, kid: key.kid, alg: key.alg };
}
