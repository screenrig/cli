import type { Command, Option } from "commander";
import { commandPath, createCommandTree, findCommand } from "./command-tree.js";
import { NOTES } from "./help-text.js";
import { usageError } from "./problems.js";
export { CREDIT_HELP } from "./help-text.js";

export interface HelpDocument {
  path: string[];
  aliases: string[][];
  kind: "group" | "command";
  usage: string;
  synopsis: string[];
  commands: Array<{ name: string; path: string[]; kind: "group" | "command"; summary: string; help: string }>;
  options: Array<{ name: string; type: "boolean" | "value"; description: string; required: boolean }>;
  globalOptions: Array<{ name: string; type: "boolean" | "value"; description: string; required: boolean }>;
  notes: string[];
}

/** Canonical and alias paths of every descendant leaf, in tree order. */
export function leafCommandPaths(command: Command): string[] {
  const paths: string[] = [];
  const visit = (node: Command): void => {
    if (node.commands.length) {
      node.commands.forEach(visit);
      return;
    }
    const path = commandPath(node);
    if (!path.length) return;
    paths.push(path.join(" "));
    for (const alias of node.aliases()) paths.push([...path.slice(0, -1), alias].join(" "));
  };
  command.commands.forEach(visit);
  return paths;
}

function commandInventory(command: Command): string | undefined {
  const paths = leafCommandPaths(command);
  if (!paths.length) return undefined;
  return ["All commands:", ...paths.map((path) => `  ${path}`)].join("\n");
}

/** JSON discovery and human help both read the actual Commander command tree. */
export function describeHelp(command: Command): HelpDocument {
  const helper = command.createHelp();
  const path = commandPath(command);
  const note = NOTES[path.join(" ")];
  const notes = note ? [note] : [];
  const inventory = commandInventory(command);
  const describeOption = (option: Option) => ({
    name: option.long!, type: (option.negate || option.isBoolean()) ? "boolean" as const : "value" as const, description: option.description, required: option.mandatory,
  });
  return {
    path,
    aliases: command.aliases().map((alias) => [...path.slice(0, -1), alias]),
    kind: command.commands.length ? "group" : "command",
    usage: [command.helpInformation().trimEnd(), inventory, ...notes].filter((part): part is string => part !== undefined).join("\n\n"),
    synopsis: [helper.commandUsage(command)],
    commands: helper.visibleCommands(command).map((child) => ({
      name: child.name(), path: commandPath(child), kind: child.commands.length ? "group" as const : "command" as const,
      summary: child.description(), help: `screenrig ${commandPath(child).join(" ")} --help`,
    })),
    options: helper.visibleOptions(command).map(describeOption),
    globalOptions: helper.visibleGlobalOptions(command).map(describeOption),
    notes,
  };
}

export function commandHelp(path: readonly string[] = []): HelpDocument {
  const command = findCommand(createCommandTree().root, path);
  if (!command) throw usageError("Unknown help topic.");
  return describeHelp(command);
}

export const ROOT_HELP = commandHelp().usage;
