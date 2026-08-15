import { randomBytes } from "node:crypto";

/** 128 bits of CSPRNG entropy, encoded URL-safe without padding (22 chars). */
export const ENTROPY_BYTES = 16;

export function randomUrlSafe128(): string {
  return randomBytes(ENTROPY_BYTES).toString("base64url");
}

export function randomPrefixedId(prefix: string, bytes = ENTROPY_BYTES): string {
  const encoded = randomBytes(bytes).toString("base64url");
  return `${prefix}_${encoded}`;
}

export function newRequestId(): string {
  return randomPrefixedId("req");
}

export function newIdempotencyKey(): string {
  return randomUrlSafe128();
}

export function isValidRequestId(value: string): boolean {
  return /^req_[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isValidIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9._~-]{8,200}$/.test(value);
}

export function requestIdEntropyBytes(value: string): number {
  if (!isValidRequestId(value)) {
    return 0;
  }
  try {
    return Buffer.from(value.slice(4), "base64url").length;
  } catch {
    return 0;
  }
}
