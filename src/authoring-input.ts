import { open, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { CliRuntime } from "./runtime.js";
import { usageError } from "./problems.js";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export async function readAuthoringText(file: string, runtime: CliRuntime, maxBytes = MAX_INPUT_BYTES): Promise<string> {
  try {
    if (file !== "-") {
      const handle = await open(path.resolve(runtime.cwd(), file), "r");
      try {
        if ((await handle.stat()).size > maxBytes) throw usageError("Input exceeds its size limit.");
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > maxBytes) throw usageError("Input exceeds its size limit.");
          chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString("utf8");
      } finally { await handle.close(); }
    }
    if (!runtime.stdin || runtime.isStdinTty?.()) throw usageError("Pipe input when using '-'.");
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of runtime.stdin) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > maxBytes) throw usageError("Input exceeds its size limit.");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch { throw usageError("Cannot read input; provide a readable file or pipe, within the size limit."); }
}
export async function readAuthoringJson(file: string, runtime: CliRuntime): Promise<any> {
  const text = await readAuthoringText(file, runtime);
  try { return JSON.parse(text); } catch { throw usageError("Input is not valid JSON."); }
}
/** Exclusive creation keeps a prepared document safe from accidental replacement. */
export async function writeAuthoringJson(file: string, document: unknown, runtime: CliRuntime, overwrite = false): Promise<string> {
  const output = path.resolve(runtime.cwd(), file);
  await mkdir(path.dirname(output), { recursive: true });
  const destination = overwrite ? `${output}.${crypto.randomUUID()}.tmp` : output;
  try {
    const handle = await open(destination, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(document, null, 2) + "\n"); } finally { await handle.close(); }
    if (overwrite) await rename(destination, output);
  } catch { if (overwrite) await rm(destination, { force: true }); throw usageError("Cannot create output; use --overwrite to replace an existing file."); }
  return output;
}

export async function readInputBytes(file: string, cwd: string, runtime: CliRuntime | undefined, maxBytes: number): Promise<Buffer> {
  if (file === "-" && (!runtime?.stdin || runtime.isStdinTty?.())) {
    throw usageError("Pipe input when using '-'.");
  }
  const handle = file === "-" ? undefined : await open(path.resolve(cwd, file), "r");
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    const input = handle ? handle.createReadStream({ autoClose: false }) : runtime!.stdin!;
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw usageError("Input exceeds its size limit.");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally {
    await handle?.close();
  }
}
