import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CommentsWrite } from "./adapters/protocol.js";
import type { ParsedArgs } from "./argv.js";
import { usageError } from "./problems.js";

export const COMMENTS_MAX_BYTES = 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function commentsObjectFromJson(input: string, source: "--json-value" | "comments file"): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw usageError(`${source} must contain valid JSON.`);
  }
  if (!isPlainObject(parsed)) {
    throw usageError("comments must be a JSON object.");
  }
  const compact = JSON.stringify(parsed);
  if (Buffer.byteLength(compact, "utf8") > COMMENTS_MAX_BYTES) {
    throw usageError("comments must be at most 1024 bytes of compact UTF-8 JSON.");
  }
  return parsed;
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export async function commentsWriteFromArgs(args: ParsedArgs, cwd: string): Promise<CommentsWrite> {
  if (Object.hasOwn(args.flags, "value") || Object.hasOwn(args.flags, "value-base64")) {
    throw usageError("comment set accepts --json-value or --file; it does not take --value or --value-base64.");
  }
  if (Object.hasOwn(args.flags, "content-type")) {
    throw usageError("--json-value and --file always send application/json; omit --content-type.");
  }
  const modeNames = ["json-value", "file"] as const;
  const selected = modeNames.filter((name) => Object.hasOwn(args.flags, name));
  if (selected.length !== 1) {
    throw usageError("comment set requires exactly one of --json-value or --file.");
  }
  if (selected[0] === "json-value") {
    const input = stringFlag(args, "json-value");
    if (input === undefined || input.length === 0) {
      throw usageError("--json-value requires a JSON object.");
    }
    return { comments: commentsObjectFromJson(input, "--json-value") };
  }
  const file = stringFlag(args, "file");
  if (!file) {
    throw usageError("--file requires a path.");
  }
  let text: string;
  try {
    text = await readFile(path.resolve(cwd, file), "utf8");
  } catch (error) {
    throw usageError(`Cannot read comments file: ${error instanceof Error ? error.message : "read failed"}`);
  }
  return { comments: commentsObjectFromJson(text, "comments file") };
}
