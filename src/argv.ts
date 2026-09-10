import { BOOLEAN_FLAGS, COMMAND_SPECS, GLOBAL_FLAGS } from "./command-spec.js";
import { usageError } from "./problems.js";

export interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseArgv(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
  const positionals: string[] = [];
  const known = new Set<string>([...GLOBAL_FLAGS, ...COMMAND_SPECS.flatMap((spec) => spec.flags)]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const normalized = arg === "-h" ? "--help" : arg === "-V" ? "--version" : arg;
    if (!normalized.startsWith("--")) throw usageError("Unsupported short option. Use --help to discover supported options.");
    const eq = normalized.indexOf("=");
    const name = normalized.slice(2, eq < 0 ? undefined : eq);
    // Do not echo unknown names or values: either can contain credentials.
    if (!known.has(name)) throw usageError("Unsupported option. Use --help to discover supported options.");
    if (Object.hasOwn(flags, name)) throw usageError(`--${name} may be supplied only once.`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq >= 0) throw usageError(`--${name} takes no value.`);
      flags[name] = true;
      continue;
    }
    const value = eq >= 0 ? normalized.slice(eq + 1) : argv[i + 1];
    if (value === undefined || (eq < 0 && value.startsWith("-") && !/^-\d/.test(value))) {
      throw usageError(`--${name} requires a value.`);
    }
    if (value.length === 0 && name !== "value-base64") throw usageError(`--${name} requires a value.`);
    flags[name] = value;
    if (eq < 0) i += 1;
  }
  return { command: positionals.slice(0, 2), flags, positionals };
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
