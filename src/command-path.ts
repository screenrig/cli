import { handlerOptionName } from "./cli-commands/aliases.js";
import type { Command } from "commander";

/** Canonical command names, excluding the executable and any supplied values. */
export function commandPath(command: Command): string[] {
  return command.parent ? [...commandPath(command.parent), command.name()] : [];
}

export function findCommand(root: Command, path: readonly string[]): Command | undefined {
  let command = root;
  for (const word of path) {
    const child = command.commands.find((candidate) => candidate.name() === word || candidate.aliases().includes(word));
    if (!child) return undefined;
    command = child;
  }
  return command;
}

/**
 * The deepest command an argv names, skipping options and their values. Used
 * to point a usage error at the right help even when Commander failed before
 * it selected a command.
 */
export function commandFromArgv(root: Command, argv: readonly string[]): Command {
  const end = argv.indexOf("--");
  const tokens = end < 0 ? argv : argv.slice(0, end);
  let command = root;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith("-")) {
      if (token.includes("=")) continue;
      let takesValue = false;
      for (let current: Command | null = command; current; current = current.parent) {
        const option = current.options.find((candidate) => candidate.long === token || candidate.short === token);
        if (option) {
          takesValue = option.required || option.optional;
          break;
        }
      }
      if (takesValue) index += 1;
      continue;
    }
    const child = command.commands.find((candidate) => candidate.name() === token || candidate.aliases().includes(token));
    if (!child) break;
    command = child;
  }
  return command;
}

/** Read explicit CLI options only; Commander defaults must not become write flags. */
export function invocationFlags(command: Command): Record<string, string | boolean> {
  const flags = Object.create(null) as Record<string, string | boolean>;
  for (let current: Command | null = command; current; current = current.parent) {
    for (const option of current.options) {
      if (current.getOptionValueSource(option.attributeName()) !== "cli") continue;
      const value = current.getOptionValue(option.attributeName());
      if (option.negate && value !== false) continue;
      if (!option.negate && option.isBoolean() && value === false) continue;
      flags[handlerOptionName(option)] = option.negate ? true : current.getOptionValue(option.attributeName());
    }
  }
  return flags;
}

