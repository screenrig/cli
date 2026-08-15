import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ARCHIVE_LIMITS,
  limitsFromCapabilities,
  type Capabilities,
} from "./protocol.js";

const GENERATED_CONTRACT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/protocol/openapi.gen.ts",
);
const OPENAPI_CONTRACT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/openapi.yaml",
);

function interfaceBody(source: string, name: string): string {
  const marker = `export interface ${name} {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `generated contract is missing ${name}`);
  let depth = 0;
  for (let i = start + "export interface ".length; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      if (depth === 1) {
        const bodyStart = i + 1;
        for (let j = bodyStart; j < source.length; j++) {
          const inner = source[j];
          if (inner === "{") depth += 1;
          else if (inner === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(bodyStart, j);
          }
        }
      }
    }
  }
  throw new Error(`unterminated generated interface ${name}`);
}

function quotedProperties(body: string): string[] {
  return [...body.matchAll(/"([A-Za-z0-9_]+)"\s*\??\s*:/g)].map((match) => {
    const name = match[1];
    assert.ok(name);
    return name;
  });
}

test("adapter shapes mirror generated OpenAPI contract fields and Capabilities literals", () => {
  const source = readFileSync(GENERATED_CONTRACT, "utf8");

  const capabilities = interfaceBody(source, "Capabilities");
  assert.deepEqual(quotedProperties(capabilities), [
    "account_content_bytes",
    "api_version",
    "application_compressed_bytes",
    "application_expanded_bytes",
    "application_file_bytes",
    "application_file_count",
    "application_package_bytes",
    "application_path_bytes",
    "application_path_depth",
    "features",
    "playlist_max_items_per_page",
    "playlist_max_pages",
    "protocol_version",
    "screens_per_account",
    "transition_max_duration_ms",
  ]);
  assert.match(capabilities, /"account_content_bytes": 1073741824/);
  assert.match(capabilities, /"application_compressed_bytes": 104857600/);
  assert.match(capabilities, /"application_expanded_bytes": 262144000/);
  assert.match(capabilities, /"application_file_bytes": 33554432/);
  assert.match(capabilities, /"application_file_count": 5000/);
  assert.match(capabilities, /"application_package_bytes": 272629760/);
  assert.match(capabilities, /"application_path_bytes": 255/);
  assert.match(capabilities, /"application_path_depth": 16/);
  assert.match(capabilities, /"playlist_max_items_per_page": 24/);
  assert.match(capabilities, /"playlist_max_pages": 100/);
  assert.match(capabilities, /"screens_per_account": 50/);
  assert.match(capabilities, /"transition_max_duration_ms": 60000/);
  assert.doesNotMatch(capabilities, /limits/);
  assert.doesNotMatch(capabilities, /application_archive_bytes/);

  assert.deepEqual(quotedProperties(interfaceBody(source, "Operation")), [
    "created_at",
    "error",
    "id",
    "kind",
    "request_id",
    "result",
    "state",
    "updated_at",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "OperationAccepted")), [
    "id",
    "operation_id",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "Media")), [
    "bytes",
    "content_type",
    "created_at",
    "duration_ms",
    "filename",
    "height",
    "id",
    "kind",
    "operation_id",
    "revision",
    "sha256",
    "state",
    "updated_at",
    "width",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "MediaUploadDeclaration")), [
    "bytes",
    "content_type",
    "filename",
    "sha256",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "MediaUploadSession")), [
    "expires_at",
    "headers",
    "id",
    "method",
    "operation",
    "upload_url",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "MediaCommit")), [
    "bytes",
    "content_type",
    "sha256",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "Account")), [
    "content_limit_bytes",
    "created_at",
    "id",
    "reserved_bytes",
    "revision",
    "screen_count",
    "screen_limit",
    "status",
    "updated_at",
    "used_bytes",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "CLIEnrollment")), [
    "account",
    "issuance_expires_at",
    "issuance_id",
    "token",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "CLIEnrollmentRequest")), ["client_id"]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "PairScreen")), ["code", "label"]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "PairingClaim")), ["public_url", "screen"]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "ProvisionScreen")), ["label"]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "ScreenProvisioning")), [
    "expires_at", "provisioning_url", "public_url", "screen",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "BrowserLinkClaimRequest")), ["code"]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "BrowserLinkClaim")), ["screen", "session_id", "status"]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "BrowserLinkClaimScreen")), ["id", "public_id", "public_url", "state"]);
  const screen = interfaceBody(source, "Screen");
  assert.deepEqual(quotedProperties(screen), [
    "content_access_generation",
    "created_at",
    "id",
    "label",
    "manifest_revision",
    "playlist_id",
    "public_id",
    "revision",
    "state",
    "updated_at",
  ]);
  assert.match(screen, /"state": "pairing_pending" \| "active"/);
  assert.doesNotMatch(source, /Bootstrap/);
  assert.deepEqual(quotedProperties(interfaceBody(source, "ScreenPatch")), [
    "name",
    "playlist_id",
  ]);
  const capabilitiesFromContract: Capabilities = {
    account_content_bytes: 1073741824,
    api_version: "0.2.0",
    application_compressed_bytes: 104857600,
    application_expanded_bytes: 262144000,
    application_file_bytes: 33554432,
    application_file_count: 5000,
    application_path_bytes: 255,
    application_path_depth: 16,
    features: {},
    playlist_max_items_per_page: 24,
    playlist_max_pages: 100,
    protocol_version: "1",
    screens_per_account: 50,
    transition_max_duration_ms: 60000,
  };
  const limits = limitsFromCapabilities(capabilitiesFromContract);
  assert.equal(limits.application_archive_bytes, capabilitiesFromContract.application_compressed_bytes);
  assert.equal(limits.application_archive_bytes, DEFAULT_ARCHIVE_LIMITS.application_archive_bytes);
  assert.deepEqual(limits, DEFAULT_ARCHIVE_LIMITS);
});

test("control-plane KV adapter follows the authoritative binary-safe OpenAPI schema", () => {
  const source = readFileSync(OPENAPI_CONTRACT, "utf8");
  assert.match(source, /KVWrite:.*required: \[value_base64, content_type\].*value_base64:.*contentEncoding: base64.*content_type:/);
  assert.match(source, /KVEntry:.*required: \[application_id, key, value_base64, content_type, bytes, sha256, revision\]/);
  assert.match(source, /KVSummary:.*required: \[application_id, key, content_type, bytes, sha256, revision\]/);
  assert.match(source, /KVList:.*maxItems: 200/);
  assert.doesNotMatch(source.match(/KVWrite:[^\n]+/)?.[0] ?? "", /value: \{\s*\}/);
});
