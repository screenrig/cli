import type { Command } from "commander";
import { usageError } from "../problems.js";

const notes = new WeakMap<Command, string[]>();

/** Attach native help text and retain the same note for structured discovery. */
export function addCommandNotes(command: Command, note: string): void {
  command.addHelpText("after", `\n${note}`);
  notes.set(command, [...(notes.get(command) ?? []), note]);
}

export function commandNotes(command: Command): string[] {
  return [...(notes.get(command) ?? [])];
}

export interface OptionRelationship {
  kind: "exactlyOne" | "together" | "atLeastOne" | "requires";
  options: string[];
}
const relationships = new WeakMap<Command, OptionRelationship[]>();
const examples = new WeakMap<Command, string[]>();

/** One definition drives both preflight validation and discovery. */
export function requireOptionGroup(command: Command, kind: OptionRelationship["kind"], names: string[]): void {
  const options = names.map((name) => {
    const option = command.options.find((candidate) => candidate.long === name);
    if (!option) throw new Error(`Unknown option ${name}`);
    return option;
  });
  relationships.set(command, [...(relationships.get(command) ?? []), { kind, options: names }]);
  const message = kind === "exactlyOne"
    ? `Provide exactly one of ${names.join(" or ")}.`
    : kind === "atLeastOne" ? `Provide at least one of ${names.join(" or ")}.`
    : kind === "requires" ? `${names[0]} requires ${names.slice(1).join(" and ")}.`
    : `Provide ${names.join(" and ")} together.`;
  addCommandNotes(command, message);
  command.hook("preAction", () => {
    const count = options.filter((option) => command.getOptionValueSource(option.attributeName()) === "cli").length;
    const supplied = (index: number) => command.getOptionValueSource(options[index]!.attributeName()) === "cli";
    const invalid = kind === "exactlyOne" ? count !== 1
      : kind === "atLeastOne" ? count === 0
      : kind === "requires" ? supplied(0) && options.slice(1).some((_, index) => !supplied(index + 1))
      : count !== 0 && count !== options.length;
    if (invalid) throw usageError(message);
  });
}

export function commandRelationships(command: Command): OptionRelationship[] {
  return relationships.get(command) ?? [];
}

export function addCommandExamples(command: Command, ...commands: string[]): void {
  examples.set(command, [...(examples.get(command) ?? []), ...commands]);
  command.addHelpText("after", `\nExamples:\n${commands.map((example) => `  ${example}`).join("\n")}`);
}

export function commandExamples(command: Command): string[] {
  return examples.get(command) ?? [];
}
