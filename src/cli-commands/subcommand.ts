import type { Command, CommandOptions } from "commander";

/**
 * Register a subcommand. Use it for the names that are also shell builtins
 * (set, export): the Claude plugin directory reads a call whose sole argument
 * is such a word as that builtin dumping the environment, and holds the bundle.
 * scripts/directory-scan.mjs keeps the release free of the pattern.
 */
export function subcommand(parent: Command, name: string, options?: CommandOptions): Command {
  return parent.command(name, options);
}
