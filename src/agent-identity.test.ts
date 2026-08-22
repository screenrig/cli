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

test("agent credential envelope decrypts only for the persisted recipient key and exact binding", () => {
  const privateJwk = generateAgentConnectionKey();
  const connection = {
    private_jwk: privateJwk,
    connection_id: "acn_AAAAAAAAAAAAAAAAAAAAAAAA",
  };
  const token = `sr_live_test_${"T".repeat(43)}`;
  const collection = sealForTest(publicAgentConnectionKey(privateJwk), connection.connection_id, "agt_AAAAAAAAAAAAAAAAAAAAAAAA", token);
  assert.deepEqual(decryptAgentCredential(collection, connection), {
    token,
    agentId: "agt_AAAAAAAAAAAAAAAAAAAAAAAA",
  });
  assert.throws(
    () => decryptAgentCredential(collection, { ...connection, private_jwk: generateAgentConnectionKey() }),
    /could not be authenticated/,
  );
  assert.throws(
    () => decryptAgentCredential(collection, { ...connection, connection_id: "acn_BBBBBBBBBBBBBBBBBBBBBBBB" }),
    /could not be authenticated/,
  );
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
    status: "approved",
    expires_at: "2026-08-22T17:10:00.000Z",
    created_at: "2026-08-22T17:00:00.000Z",
  }, id).status, "approved");
  assert.equal(validateAgentConnectionEvent({
    connection_id: id,
    name: "Test agent",
    agent_type: "cli",
    status: "cancelled",
    expires_at: "2026-08-22T17:10:00.000Z",
    created_at: "2026-08-22T17:00:00.000Z",
  }, id).status, "cancelled");
  assert.throws(() => validateAgentConnectionEvent({
    connection_id: id,
    name: "Test agent",
    agent_type: "cli",
    status: "approved",
    expires_at: "2026-08-22T17:10:00.000Z",
    created_at: "2026-08-22T17:00:00.000Z",
    credential_envelope: "forbidden",
  }, id), /outside the status-only contract/);
});
