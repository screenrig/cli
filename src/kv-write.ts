import { readFile } from "node:fs/promises";
import path from "node:path";
import type { KVWrite } from "./adapters/protocol.js";
import type { ParsedArgs } from "./argv.js";
import { usageError } from "./problems.js";

export const KV_VALUE_BASE64_MAX_LENGTH = 1_398_104;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) result[key] = canonicalize(source[key]);
    return result;
  }
  return value;
}

export function canonicalJson(input: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw usageError("--json-value must contain valid JSON.");
  }
  return JSON.stringify(canonicalize(parsed));
}

export function canonicalBase64(input: string): string {
  if (input.length > KV_VALUE_BASE64_MAX_LENGTH) {
    throw usageError(`K/V value_base64 exceeds the OpenAPI limit of ${KV_VALUE_BASE64_MAX_LENGTH} characters.`);
  }
  const standard = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!standard.test(input)) throw usageError("--value-base64 must be canonical padded standard base64 without whitespace.");
  const decoded = Buffer.from(input, "base64");
  if (decoded.toString("base64") !== input) {
    throw usageError("--value-base64 must be canonical padded standard base64 without whitespace.");
  }
  return input;
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

function checkedContentType(args: ParsedArgs): string {
  const contentType = stringFlag(args, "content-type");
  if (!contentType || contentType.length > 127) {
    throw usageError("--file and --value-base64 require --content-type with 1 to 127 characters.");
  }
  return contentType;
}

function checkedLength(valueBase64: string): string {
  if (valueBase64.length > KV_VALUE_BASE64_MAX_LENGTH) {
    throw usageError(`K/V value_base64 exceeds the OpenAPI limit of ${KV_VALUE_BASE64_MAX_LENGTH} characters.`);
  }
  return valueBase64;
}

export async function kvWriteFromArgs(args: ParsedArgs, cwd: string): Promise<KVWrite> {
  if (Object.hasOwn(args.flags, "value")) {
    throw usageError("--value used the retired JSON-unsafe contract; use --json-value, --file, or --value-base64.");
  }
  const modeNames = ["json-value", "file", "value-base64"] as const;
  const selected = modeNames.filter((name) => Object.hasOwn(args.flags, name));
  if (selected.length !== 1) {
    throw usageError("kv set requires exactly one of --json-value, --file, or --value-base64.");
  }
  const mode = selected[0];
  if (mode === "json-value") {
    const input = stringFlag(args, mode);
    if (input === undefined || input.length === 0) throw usageError("--json-value requires a JSON value.");
    if (Object.hasOwn(args.flags, "content-type")) {
      throw usageError("--json-value always uses application/json; omit --content-type.");
    }
    const valueBase64 = Buffer.from(canonicalJson(input), "utf8").toString("base64");
    return { value_base64: checkedLength(valueBase64), content_type: "application/json" };
  }

  const contentType = checkedContentType(args);
  if (mode === "value-base64") {
    const input = stringFlag(args, mode);
    if (input === undefined) throw usageError("--value-base64 requires a value.");
    return { value_base64: canonicalBase64(input), content_type: contentType };
  }

  const file = stringFlag(args, "file");
  if (!file) throw usageError("--file requires a path.");
  let bytes: Buffer;
  try {
    bytes = await readFile(path.resolve(cwd, file));
  } catch (error) {
    throw usageError(`Cannot read K/V file: ${error instanceof Error ? error.message : "read failed"}`);
  }
  return { value_base64: checkedLength(bytes.toString("base64")), content_type: contentType };
}
