import { optionAliases } from "./cli-commands/aliases.js";
import type { Command, Option } from "commander";
import { commandPath, createCommandTree, findCommand } from "./command-tree.js";
import { commandNotes, commandExamples, commandRelationships, type OptionRelationship } from "./cli-commands/notes.js";
import { usageError } from "./problems.js";
export { CREDIT_HELP } from "./help-text.js";

export interface HelpOption {
  aliases: string[];
  name: string;
  type: "boolean" | "value";
  description: string;
  required: boolean;
  valueRequired: boolean;
  variadic: boolean;
  choices?: string[];
  default?: unknown;
  conflicts: string[];
}

export interface HelpDocument {
  path: string[];
  aliases: string[][];
  kind: "group" | "command";
  usage: string;
  synopsis: string[];
  commands: Array<{ name: string; path: string[]; kind: "group" | "command"; summary: string; help: string }>;
  arguments: Array<{ name: string; description: string; required: boolean; variadic: boolean; choices?: string[]; default?: unknown }>;
  options: HelpOption[];
  globalOptions: HelpOption[];
  relationships: OptionRelationship[];
  examples: string[];
  allCommands?: string[];
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
export function describeHelp(command: Command, all = false): HelpDocument {
  const helper = command.createHelp();
  const path = commandPath(command);
  const notes = commandNotes(command);
  const inventory = all ? commandInventory(command) : undefined;
  const examples = commandExamples(command);
  const visibleOptions = [...helper.visibleOptions(command), ...helper.visibleGlobalOptions(command)];
  const describeOption = (option: Option): HelpOption => ({
    aliases: option.long === "--expect-rev" ? ["--if-match"] : optionAliases(option),
    name: option.long!, type: (option.negate || option.isBoolean()) ? "boolean" : "value", description: option.description, required: option.mandatory,
    valueRequired: option.required, variadic: option.variadic,
    ...(option.argChoices ? { choices: option.argChoices } : {}),
    ...(option.defaultValue !== undefined ? { default: option.defaultValue } : {}),
    // Commander exposes these native conflict names at runtime but omits them from its typings.
    conflicts: ((option as Option & { conflictsWith?: string[] }).conflictsWith ?? [])
      .flatMap((name) => visibleOptions.filter((candidate) => candidate.attributeName() === name).map((candidate) => candidate.long!)),
  });
  return {
    path,
    aliases: command.aliases().map((alias) => [...path.slice(0, -1), alias]),
    kind: command.commands.length ? "group" : "command",
    usage: [command.helpInformation().trimEnd(), inventory, ...notes, ...(examples.length ? [`Examples:\n${examples.map((example) => `  ${example}`).join("\n")}`] : [])].filter((part): part is string => part !== undefined).join("\n\n"),
    synopsis: [helper.commandUsage(command)],
    commands: helper.visibleCommands(command).map((child) => ({
      name: child.name(), path: commandPath(child), kind: child.commands.length ? "group" as const : "command" as const,
      summary: child.description(), help: `screenrig ${commandPath(child).join(" ")} --help`,
    })),
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(), description: argument.description, required: argument.required, variadic: argument.variadic,
      ...(argument.argChoices ? { choices: argument.argChoices } : {}),
      ...(argument.defaultValue !== undefined ? { default: argument.defaultValue } : {}),
    })),
    relationships: commandRelationships(command),
    examples: commandExamples(command),
    ...(all ? { allCommands: leafCommandPaths(command) } : {}),
    options: helper.visibleOptions(command).map(describeOption),
    globalOptions: helper.visibleGlobalOptions(command).map(describeOption),
    notes,
  };
}

export function commandHelp(path: readonly string[] = [], all = false): HelpDocument {
  const command = findCommand(createCommandTree().root, path);
  if (!command) throw usageError("Unknown help topic.");
  return describeHelp(command, all);
}
