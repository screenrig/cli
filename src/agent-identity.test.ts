import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from "node:crypto";
import { test } from "node:test";
import type { AgentCredentialCollection, X25519PublicJWK } from "./adapters/protocol.js";
import { AGENT_CAPABILITIES } from "./adapters/protocol.js";
import {
  decryptAgentCredential,
  generateAgentConnectionKey,
  publicAgentConnectionKey,
  validateAgentApprovalUrl,
  validateAgentConnectionEvent,
} from "./agent-identity.js";

function sealForTest(recipient: X25519PublicJWK, connectionId: string, agentId: string, token: string): AgentCredentialCollection {
  const ephemeral = generateKeyPairSync("x25519");
  const publicJwk = ephemeral.publicKey.export({ format: "jwk" });
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({ key: recipient as unknown as import("node:crypto").JsonWebKey, format: "jwk" }),
  });
  const salt = createHash("sha256").update(`screenrig/agent-credential-envelope/salt/v1\0${connectionId}`).digest();
  const key = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from("screenrig/agent-credential-envelope/key/v1"), 32));
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`screenrig/agent-credential-envelope/aad/v1\0${connectionId}\0${agentId}`));
  const plaintext = Buffer.from(JSON.stringify({ token, agent_id: agentId, connection_id: connectionId }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    agent: {
      id: agentId,
      name: "Test agent",
      agent_type: "cli",
      capabilities: [...AGENT_CAPABILITIES],
      state: "pending",
      authenticated_requests: 0,
      metered_credits: 0,
      created_at: "2026-08-22T17:00:00.000Z",
    },
    credential_envelope: {
      algorithm: "X25519-HKDF-SHA256-A256GCM",
      ephemeral_public_key: { kty: "OKP", crv: "X25519", x: publicJwk.x! },
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    },
    issuance_expires_at: "2026-08-22T17:10:00.000Z",
  };
}

for (const prefix of ["", "development_", "qa_", "stage_"]) test(`agent credential envelope ${prefix || "production"} preserves exact ID binding`, () => {
  const privateJwk = generateAgentConnectionKey();
  const connection = {
    private_jwk: privateJwk,
    capabilities: [...AGENT_CAPABILITIES],
    connection_id: `${prefix}acn_AAAAAAAAAAAAAAAAAAAAAAAA`,
  };
  const token = `sr_live_test_${"T".repeat(43)}`;
  const collection = sealForTest(publicAgentConnectionKey(privateJwk), connection.connection_id, `${prefix}agt_AAAAAAAAAAAAAAAAAAAAAAAA`, token);
  assert.deepEqual(decryptAgentCredential(collection, connection), {
    token,
    agentId: `${prefix}agt_AAAAAAAAAAAAAAAAAAAAAAAA`,
  });
  assert.throws(
    () => decryptAgentCredential(collection, { ...connection, private_jwk: generateAgentConnectionKey() }),
    /could not be authenticated/,
  );
  assert.throws(
    () => decryptAgentCredential(collection, { ...connection, connection_id: `${prefix}acn_BBBBBBBBBBBBBBBBBBBBBBBB` }),
    /could not be authenticated/,
  );
});

test("identity delivery has its own connection binding and cannot replace a project credential", () => {
  const privateJwk = generateAgentConnectionKey();
  const connection = { private_jwk: privateJwk, capabilities: [...AGENT_CAPABILITIES], connection_id: "acn_AAAAAAAAAAAAAAAAAAAAAAAA" };
  const project = sealForTest(publicAgentConnectionKey(privateJwk), connection.connection_id, "agt_AAAAAAAAAAAAAAAAAAAAAAAA", "sr_live_project_" + "P".repeat(43));
  const identityToken = "sr_live_idt_" + "a".repeat(24) + "_" + "b".repeat(64);
  const identity = sealForTest(publicAgentConnectionKey(privateJwk), connection.connection_id + ":identity", project.agent.id, identityToken);
  assert.equal(decryptAgentCredential({ ...project, identity_credential_envelope: identity.credential_envelope }, connection).identityToken, identityToken);
  assert.throws(() => decryptAgentCredential({ ...project, identity_credential_envelope: project.credential_envelope }, connection), /could not be authenticated/);
  assert.throws(() => decryptAgentCredential(sealForTest(publicAgentConnectionKey(privateJwk), connection.connection_id, project.agent.id, identityToken), connection), /project credential envelope delivered an identity/);
});

test("agent approval URLs and SSE events stay on their closed status-only surfaces", () => {
  const id = "acn_AAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(
    validateAgentApprovalUrl(`https://dashboard.screenrig.ai/agents/connect/${id}`, "https://api.screenrig.ai", id),
    `https://dashboard.screenrig.ai/agents/connect/${id}`,
  );
  assert.throws(
    () => validateAgentApprovalUrl(`https://dashboard.screenrig.ai/agents/connect/${id}?token=no`, "https://api.screenrig.ai", id),
    /unsafe or off-origin/,
  );
  assert.equal(validateAgentConnectionEvent({
    connection_id: id,
    name: "Test agent",
    agent_type: "cli",
    capabilities: [...AGENT_CAPABILITIES],
    status: "approved",
    expires_at: "2026-08-22T17:10:00.000Z",
    created_at: "2026-08-22T17:00:00.000Z",
  }, id).status, "approved");
  assert.equal(validateAgentConnectionEvent({
    connection_id: id,
    name: "Test agent",
    agent_type: "cli",
    capabilities: [...AGENT_CAPABILITIES],
    status: "cancelled",
    expires_at: "2026-08-22T17:10:00.000Z",
    created_at: "2026-08-22T17:00:00.000Z",
  }, id).status, "cancelled");
  const status = {
    connection_id: id,
    name: "Test agent",
    agent_type: "cli",
    platform: "linux/x64",
    version: "26.09.1",
    capabilities: [...AGENT_CAPABILITIES],
    status: "approved",
    expires_at: "2026-08-22T17:10:00.000Z",
    created_at: "2026-08-22T17:00:00.000Z",
  };
  assert.deepEqual(validateAgentConnectionEvent({
    ...status,
    credential_envelope: "never returned",
    field_from_a_newer_server: true,
  }, id), status);
  assert.throws(() => validateAgentConnectionEvent({ ...status, status: undefined }, id), /generated status contract/);
  assert.throws(() => validateAgentConnectionEvent([status], id), /generated status contract/);
});
