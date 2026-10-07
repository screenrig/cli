import { RESOURCE_ID_PATTERNS } from "./generated/resource-ids.js";
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import type {
  Agent,
  AgentConnection,
  AgentConnectionStart,
  AgentCredentialCollection,
  AgentSelfStatus,
  X25519PublicJWK,
} from "./adapters/protocol.js";
import type { ScreenRigConfig } from "./config.js";
import { configError, usageError } from "./problems.js";
import { validateIdentityToken } from "./identity-credential.js";

const CONNECTION_ID = RESOURCE_ID_PATTERNS.connection;
const AGENT_ID = RESOURCE_ID_PATTERNS.agent;
const CONNECTION_TOKEN = /^sac_[A-Za-z0-9_-]{43}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const CONNECTION_FIELDS = new Set([
  "connection_id",
  "name",
  "agent_type",
  "capabilities",
  "platform",
  "version",
  "status",
  "expires_at",
  "created_at",
]);

export type AgentConnectionConfig = NonNullable<ScreenRigConfig["agent_connection"]>;

export interface DecryptedAgentCredential {
  token: string;
  agentId: string;
  identityToken?: string;
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function decodeBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw configError(`Agent connection ${label} is not unpadded base64url.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw configError(`Agent connection ${label} is not canonical unpadded base64url.`);
  }
  return decoded;
}

function validatePublicJwk(value: unknown, label: string): asserts value is X25519PublicJWK {
  const jwk = value as Partial<X25519PublicJWK> | undefined;
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "X25519" || typeof jwk.x !== "string" || !BASE64URL_32.test(jwk.x)) {
    throw configError(`Agent connection ${label} is not a valid X25519 public JWK.`);
  }
}

export function generateAgentConnectionKey(): AgentConnectionConfig["private_jwk"] {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "X25519" || typeof jwk.x !== "string" || typeof jwk.d !== "string"
    || !BASE64URL_32.test(jwk.x) || !BASE64URL_32.test(jwk.d)) {
    throw configError("Node.js did not produce a valid X25519 connection key.");
  }
  return { kty: "OKP", crv: "X25519", x: jwk.x, d: jwk.d };
}

export function publicAgentConnectionKey(privateJwk: AgentConnectionConfig["private_jwk"]): X25519PublicJWK {
  if (privateJwk.kty !== "OKP" || privateJwk.crv !== "X25519" || !BASE64URL_32.test(privateJwk.x)
    || !BASE64URL_32.test(privateJwk.d)) {
    throw configError("Pending agent connection key is invalid.");
  }
  return { kty: "OKP", crv: "X25519", x: privateJwk.x };
}

export function agentPlatform(): string {
  return `${process.platform}/${process.arch}`;
}

export function validateAgent(value: unknown, expectedState?: Agent["state"]): Agent {
  const agent = value as Partial<Agent> | undefined;
  if (!agent || typeof agent.id !== "string" || !AGENT_ID.test(agent.id)
    || typeof agent.name !== "string" || agent.name.length === 0
    || typeof agent.agent_type !== "string" || agent.agent_type.length === 0
    || !["pending", "active", "revoked", "cancelled", "expired"].includes(agent.state ?? "")
    || typeof agent.authenticated_requests !== "number" || typeof agent.metered_credits !== "number"
    || !Array.isArray(agent.capabilities) || agent.capabilities.length === 0
    || agent.capabilities.some((name) => typeof name !== "string")
    || !isDateTime(agent.created_at) || (expectedState !== undefined && agent.state !== expectedState)) {
    throw usageError("Agent response does not match the generated Agent contract.");
  }
  return agent as Agent;
}

export function validateAgentSelfStatus(value: unknown, expectedState?: Agent["state"]): AgentSelfStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw usageError("Agent self status does not match the generated AgentSelfStatus contract.");
  }
  const status = value as Partial<AgentSelfStatus>;
  if (typeof status.connection_ready !== "boolean") {
    throw usageError("Agent self status does not match the generated AgentSelfStatus contract.");
  }
  return { agent: validateAgent(status.agent, expectedState), connection_ready: status.connection_ready };
}

function expectedDashboardOrigin(apiUrl: string): string {
  const api = new URL(apiUrl);
  let hostname: string;
  if (api.hostname === "api.screenrig.ai") hostname = "screenrig.ai";
  else if (api.hostname === "api.screenrig.localhost") hostname = "screenrig.localhost";
  else if (api.hostname.startsWith("api.")) hostname = api.hostname.slice(4);
  else throw configError("Agent connection approval URL cannot be bound to this API hostname.");
  return `${api.protocol}//${hostname}${api.port ? `:${api.port}` : ""}`;
}

export function validateAgentApprovalUrl(value: string, apiUrl: string, connectionId: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configError("Agent connection returned an invalid dashboard approval URL.");
  }
  if (parsed.origin !== expectedDashboardOrigin(apiUrl) || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== `/dashboard/agents/connect/${connectionId}`) {
    throw configError("Agent connection returned an unsafe or off-origin dashboard approval URL.");
  }
  return parsed.href;
}

export function validateAgentConnectionStart(value: unknown, apiUrl: string): AgentConnectionStart {
  const start = value as Partial<AgentConnectionStart> | undefined;
  if (!start || typeof start.connection_id !== "string" || !CONNECTION_ID.test(start.connection_id)
    || typeof start.connection_token !== "string" || !CONNECTION_TOKEN.test(start.connection_token)
    || typeof start.approval_url !== "string" || !isDateTime(start.expires_at)) {
    throw configError("Agent connection start response does not match the generated contract.");
  }
  return {
    connection_id: start.connection_id,
    connection_token: start.connection_token,
    approval_url: validateAgentApprovalUrl(start.approval_url, apiUrl, start.connection_id),
    expires_at: start.expires_at,
  };
}

export function validateAgentConnectionEvent(value: unknown, connectionId: string): AgentConnection {
  const event = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Partial<AgentConnection>;
  if (event.connection_id !== connectionId || typeof event.name !== "string" || event.name.length === 0
    || typeof event.agent_type !== "string" || event.agent_type.length === 0
    || !["pending", "approved", "connected", "denied", "expired", "cancelled"].includes(event.status ?? "")
    || !Array.isArray(event.capabilities) || event.capabilities.length === 0
    || event.capabilities.some((name) => typeof name !== "string")
    || !isDateTime(event.expires_at) || !isDateTime(event.created_at)) {
    throw configError("Agent connection SSE did not match the generated status contract.");
  }
  // Fields a newer server adds are dropped, not refused, so an additive change never breaks a shipped CLI.
  return Object.fromEntries(Object.entries(event).filter(([key]) => CONNECTION_FIELDS.has(key))) as unknown as AgentConnection;
}

export function decryptAgentCredential(
  collection: AgentCredentialCollection,
  connection: AgentConnectionConfig,
): DecryptedAgentCredential {
  if (!connection.connection_id || !CONNECTION_ID.test(connection.connection_id)) {
    throw configError("Pending agent connection identifier is invalid.");
  }
  const agent = validateAgent(collection.agent, "pending");
  const token = openCredentialEnvelope(collection.credential_envelope, connection, connection.connection_id, agent.id);
  if (/^sr_live_idt_/.test(token)) throw configError("A project credential envelope delivered an identity credential.");
  const identityToken = collection.identity_credential_envelope
    ? validateIdentityToken(openCredentialEnvelope(collection.identity_credential_envelope, connection, connection.connection_id + ":identity", agent.id))
    : undefined;
  return { token, agentId: agent.id, ...(identityToken ? { identityToken } : {}) };
}

function openCredentialEnvelope(
  envelope: AgentCredentialCollection["credential_envelope"],
  connection: AgentConnectionConfig,
  binding: string,
  agentId: string,
): string {
  if (!envelope || envelope.algorithm !== "X25519-HKDF-SHA256-A256GCM") {
    throw configError("Agent credential envelope uses an unsupported algorithm.");
  }
  validatePublicJwk(envelope.ephemeral_public_key, "ephemeral key");
  const nonce = decodeBase64Url(envelope.nonce, "nonce");
  const sealed = decodeBase64Url(envelope.ciphertext, "ciphertext");
  if (nonce.length !== 12 || sealed.length <= 16) {
    throw configError("Agent credential envelope has invalid AES-GCM lengths.");
  }

  let plaintext: Buffer;
  try {
    const privateKey = createPrivateKey({ key: connection.private_jwk, format: "jwk" });
    const ephemeralKey = createPublicKey({ key: envelope.ephemeral_public_key as unknown as JsonWebKey, format: "jwk" });
    const shared = diffieHellman({ privateKey, publicKey: ephemeralKey });
    const salt = createHash("sha256")
      .update(`screenrig/agent-credential-envelope/salt/v1\0${binding}`)
      .digest();
    const key = Buffer.from(hkdfSync(
      "sha256",
      shared,
      salt,
      Buffer.from("screenrig/agent-credential-envelope/key/v1"),
      32,
    ));
    const ciphertext = sealed.subarray(0, sealed.length - 16);
    const tag = sealed.subarray(sealed.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(`screenrig/agent-credential-envelope/aad/v1\0${binding}\0${agentId}`));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw configError("Agent credential envelope could not be authenticated by this installation.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    throw configError("Agent credential envelope plaintext is invalid.");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw configError("Agent credential envelope plaintext is invalid.");
  }
  const record = decoded as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "agent_id,connection_id,token"
    || record.agent_id !== agentId || record.connection_id !== binding
    || typeof record.token !== "string" || !/^sr_live_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/.test(record.token)) {
    throw configError("Agent credential envelope is not bound to this connection and agent.");
  }
  return record.token;
}
