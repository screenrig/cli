import { readFile } from "node:fs/promises";
import { usageError } from "../problems.js";
import type { VendorAdapter } from "./types.js";

/**
 * `NAME=VALUE` lines: `#` comments, blank lines, an optional `export ` prefix,
 * and one pair of single or double quotes around the value. A line that is not a
 * pair is skipped; nothing about a value is ever echoed.
 */
export function parseCredentialFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
    values[match[1]!] = value;
  }
  return values;
}

/**
 * The vendor credentials an adapter declares, read from the `--credentials FILE`
 * and only from it. Names the adapter does not declare are ignored. Every
 * message names a credential, never a value.
 */
export async function loadCredentials(
  adapter: Pick<VendorAdapter, "id" | "name" | "credentials">,
  options: { file?: string; read?: (file: string) => Promise<string> },
): Promise<Record<string, string>> {
  let source: Record<string, string> = {};
  if (options.file !== undefined) {
    let text: string;
    try {
      text = await (options.read ?? ((file: string) => readFile(file, "utf8")))(options.file);
    } catch {
      throw usageError("Cannot read the --credentials file. It holds NAME=VALUE lines.");
    }
    source = parseCredentialFile(text);
  }
  const values: Record<string, string> = {};
  for (const declared of adapter.credentials) {
    const value = source[declared.name];
    if (value !== undefined && value !== "") {
      values[declared.name] = value;
    } else if (declared.required) {
      throw usageError(
        `${adapter.name} needs a ${declared.name} line in ${options.file !== undefined ? "the --credentials file" : "a file given with --credentials FILE"}. ${declared.help}`,
        { command: `screenrig migrate vendors ${adapter.id}`, reason: `Shows how to make a read-only key for ${adapter.name} and what the file holds.` },
      );
    }
  }
  return values;
}

/** Replaces every credential value in `text`, so an error from vendor code can never echo one. */
export function scrubSecrets(text: string, secrets: Iterable<string>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[redacted]");
  }
  return result;
}
