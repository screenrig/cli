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

