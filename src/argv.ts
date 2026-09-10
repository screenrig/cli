import { CommanderError } from "commander";
import { commandPath, createCommandTree, invocationFlags } from "./command-tree.js";
import { describeHelp, type HelpDocument } from "./help.js";
import { usageError } from "./problems.js";

export interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
  positionals: string[];
  help?: HelpDocument;
}

export function parseArgv(argv: string[]): ParsedArgs {
  // Commander handles tokenization, option scope, command paths, aliases,
  // positional arity, and option conflicts. It must never exit this process.
  const end = argv.indexOf("--");
  const options = end < 0 ? argv : argv.slice(0, end);
  for (const spellings of [["--help", "-h"], ["--version", "-V"]]) {
    if (options.filter((arg) => spellings.includes(arg)).length > 1) throw usageError(`${spellings[0]} may be supplied only once.`);
  }
  const tree = createCommandTree(options);
  try {
    tree.root.parse(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError) || !(tree.helpRequested() || tree.versionRequested())) throw error;
  }
  const selected = tree.selected();
  const flags = invocationFlags(selected);
  if (tree.versionRequested()) flags.version = true;
  if (tree.helpRequested()) {
    flags.help = true;
    const help = describeHelp(selected);
    return { command: help.path.slice(0, 2), positionals: help.path, flags, help };
  }
  // These paired inputs are domain requirements, not parser syntax.
  const has = (name: string) => Object.hasOwn(flags, name);
  if (has("target-width") !== has("target-height")) throw usageError("Provide both --target-width and --target-height.");
  const path = commandPath(selected);
  if (path.join(" ") === "playlist import" && has("update") !== has("if-match")) throw usageError("playlist import --update and --if-match must be supplied together.");
  const positionals = [...path, ...selected.args];
  return { command: positionals.slice(0, 2), positionals, flags };
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
