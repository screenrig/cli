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
