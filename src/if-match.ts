import { usageError } from "./problems.js";

const POSITIVE_INTEGER = /^(?:"([1-9]\d*)"|([1-9]\d*))$/;

export function quotedRevision(raw: string): string {
  const match = POSITIVE_INTEGER.exec(raw);
  const digits = match?.[1] ?? match?.[2];
  if (!digits) {
    throw usageError("--if-match must be a positive integer, optionally wrapped in double quotes.");
  }
  return `"${digits}"`;
}
