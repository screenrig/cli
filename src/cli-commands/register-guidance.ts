import type { Command } from "commander";
import { findCommand } from "../command-path.js";
import { addCommandExamples, addCommandNotes, commandExamples } from "./notes.js";
import { GUIDANCE_EXAMPLES, GUIDANCE_NOTES } from "./guidance.js";

/** A guidance path whose top-level command was not loaded for this invocation is skipped. */
function guidanceCommand(root: Command, path: string, kind: string): Command | undefined {
  const words = path.split(" ");
  const command = findCommand(root, words);
  if (!command && findCommand(root, words.slice(0, 1))) throw new Error(`Unknown ${kind} command ${path}`);
  return command;
}

/** Attach the help-only examples and notes of guidance.ts to their commands. */
export function registerGuidance(root: Command): void {
  for (const [path, suffixes] of Object.entries(GUIDANCE_EXAMPLES)) {
    const command = guidanceCommand(root, path, "example");
    if (!command) continue;
    if (!commandExamples(command).length) addCommandExamples(command, ...suffixes.map(suffix => `screenrig ${path}${suffix ? ` ${suffix}` : ""}`));
  }
  for (const [path, note] of Object.entries(GUIDANCE_NOTES)) {
    const command = guidanceCommand(root, path, "guidance");
    if (!command) continue;
    addCommandNotes(command, note);
    if (path === "comment set") for (const child of command.commands) addCommandNotes(child, note);
  }
}
