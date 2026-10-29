import type { Command } from "commander";
import { findCommand } from "../command-path.js";
import { addCommandExamples, addCommandNotes, commandExamples } from "./notes.js";
import { GUIDANCE_EXAMPLES, GUIDANCE_NOTES } from "./guidance.js";

/** Attach the help-only examples and notes of guidance.ts to their commands. */
export function registerGuidance(root: Command): void {
  for (const [path, suffixes] of Object.entries(GUIDANCE_EXAMPLES)) {
    const command = findCommand(root, path.split(" "));
    if (!command) throw new Error(`Unknown example command ${path}`);
    if (!commandExamples(command).length) addCommandExamples(command, ...suffixes.map(suffix => `screenrig ${path}${suffix ? ` ${suffix}` : ""}`));
  }
  for (const [path, note] of Object.entries(GUIDANCE_NOTES)) {
    const command = findCommand(root, path.split(" "));
    if (!command) throw new Error(`Unknown guidance command ${path}`);
    addCommandNotes(command, note);
    if (path === "comment set") for (const child of command.commands) addCommandNotes(child, note);
  }
}
