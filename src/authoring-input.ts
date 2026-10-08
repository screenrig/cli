import { open, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CliRuntime } from "./runtime.js";
import { CliError, usageError } from "./problems.js";

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
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (file !== "-" && code === "ENOENT") throw usageError(`${file} does not exist.`);
    if (file !== "-" && code === "EISDIR") throw usageError(`${file} is a directory; pass a file.`);
    if (file !== "-" && code === "EACCES") throw usageError(`${file} cannot be read (permission denied).`);
    throw usageError(`Cannot read ${file === "-" ? "stdin" : file}; provide a readable file or pipe, within the size limit.`);
  }
}
export async function readAuthoringJson(file: string, runtime: CliRuntime): Promise<any> {
  const text = await readAuthoringText(file, runtime);
  try { return JSON.parse(text); } catch { throw usageError("Input is not valid JSON."); }
}
const OUTPUT_EXISTS = "Output file already exists; choose a new file or use --overwrite to replace it.";

/** An empty file is what an interrupted earlier run leaves behind, never a prepared document. */
async function holdsContent(output: string): Promise<boolean> {
  try { return (await stat(output)).size > 0; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Refuse a prepared document up front, before any slow or billed work. */
export async function assertOutputAvailable(output: string, overwrite: boolean): Promise<void> {
  if (!overwrite && await holdsContent(output)) throw usageError(OUTPUT_EXISTS);
}

/**
 * Write the whole file beside the target, then move it into place, so an
 * interrupt never leaves a partial or empty output behind.
 */
export async function writeOutputFile(output: string, text: string, overwrite: boolean): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  await assertOutputAvailable(output, overwrite);
  const temporary = `${output}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text); } finally { await handle.close(); }
    await rename(temporary, output);
  } catch {
    throw usageError("Cannot create output; check that the directory is writable.");
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeAuthoringJson(file: string, document: unknown, runtime: CliRuntime, overwrite = false): Promise<string> {
  const output = path.resolve(runtime.cwd(), file);
  await writeOutputFile(output, JSON.stringify(document, null, 2) + "\n", overwrite);
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
