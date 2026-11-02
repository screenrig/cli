import { readAuthoringText } from "./authoring-input.js";
import { usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";

const KEY_FILE_MAX_BYTES = 20 * 1024;

/**
 * A Google service account's JSON key file from a file or stdin, sent whole and
 * compacted to one line, at most maxCharacters long. The server checks it again
 * at save and never returns it. No message quotes the file.
 */
export async function readServiceAccountKey(file: string, runtime: CliRuntime, maxCharacters: number): Promise<string> {
  const where = file === "-" ? "stdin" : file;
  const text = await readAuthoringText(file, runtime, KEY_FILE_MAX_BYTES);
  let key: unknown;
  try {
    key = JSON.parse(text);
  } catch {
    key = undefined;
  }
  const object = key && typeof key === "object" && !Array.isArray(key) ? key as Record<string, unknown> : undefined;
  if (!object || object.type !== "service_account" || typeof object.client_email !== "string" || typeof object.private_key !== "string") {
    throw usageError(`${where} must be the service account's JSON key file (Google Cloud console: IAM and admin, Service accounts, Keys, Add key, JSON).`);
  }
  const compact = JSON.stringify(object);
  if ([...compact].length > maxCharacters) throw usageError(`The key file in ${where} is larger than ${maxCharacters} characters.`);
  return compact;
}
