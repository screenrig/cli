import { usageError } from "./problems.js";

export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/**
 * The six-character code a Player or browser handoff displays, as the server
 * expects it. Players show it grouped ("ABC 234", "ABC-234"), so spaces and
 * dashes anywhere are separators, and case does not matter. Anything else is
 * refused rather than guessed.
 */
export function canonicalPairingCode(input: string, subject: string): string {
  const code = input.replace(/[\s-]+/g, "").toUpperCase();
  if (!CODE_PATTERN.test(code)) {
    throw usageError(`${subject} must be six characters from ${PAIRING_CODE_ALPHABET}; spaces and dashes between them are ignored.`);
  }
  return code;
}
