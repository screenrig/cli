import type { Command } from "commander";

const notes = new WeakMap<Command, string[]>();

/** Attach native help text and retain the same note for structured discovery. */
export function addCommandNotes(command: Command, note: string): void {
  command.addHelpText("after", `\n${note}`);
  notes.set(command, [...(notes.get(command) ?? []), note]);
}

export function commandNotes(command: Command): string[] {
  return [...(notes.get(command) ?? [])];
}
