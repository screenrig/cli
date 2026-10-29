/** Explicit command input passed from Commander to the application handlers. */
export interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

export function flagNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = flagString(flags, name);
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Normalize the legacy spelling before Commander validation; never inspect operands. */
export function normalizeRevisionArgs(argv: string[]): string[] {
  let ended = false;
  const versioned = namesVersionedMedia(argv);
  return argv.map((arg) => {
    if (arg === "--") ended = true;
    if (ended) return arg;
    if (arg === "--if-match") return "--expect-rev";
    if (arg.startsWith("--if-match=")) return "--expect-rev=" + arg.slice(11);
    // The root's own --version would swallow the version a media command names.
    if (versioned && arg === "--version") return "--number";
    if (versioned && arg.startsWith("--version=")) return "--number=" + arg.slice(10);
    return arg;
  });
}

/** True for `media restore` and `media version delete`, which take --version N as an alias of --number N. */
function namesVersionedMedia(argv: string[]): boolean {
  const words: string[] = [];
  for (const arg of argv) {
    if (arg === "--") break;
    if (!arg.startsWith("-")) words.push(arg);
    if (words.length === 3) break;
  }
  return words[0] === "media" && (words[1] === "restore" || (words[1] === "version" && words[2] === "delete"));
}
