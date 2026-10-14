import { noteId, parseNoteAbout, parseNoteTtl } from "../agent-notes.js";
import { isResourceID } from "../generated/resource-ids.js";
import { usageError } from "../problems.js";
import { positiveInteger } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleNotesList, handleNotesShow, handleNotesAdd, handleNotesConfirm, handleNotesResolve } from "../commands.js";
import { type Command, Option } from "commander";

function aboutOption(value: string): string {
  parseNoteAbout(value);
  return value;
}

function ttlOption(value: string): string {
  parseNoteTtl(value);
  return value;
}

function authorOption(value: string): string {
  if (!isResourceID(value, "agent")) throw usageError("--author requires an agent ID (agt_...).");
  return value;
}

function replacesOption(value: string): string {
  return noteId(value, "add --replaces");
}

/** `screenrig notes`: the project notes agents leave for each other. notes.ts is the help-note helper. */
export function registerAgentNotesCommands(root: Command, bind: CommandActionBinder): void {
  const notes = root.command("notes").description("Read and write the project notes agents leave for each other");

  notes.command("list", { isDefault: true }).description("List open project notes, newest first (default: screenrig notes)")
    .addOption(new Option("--all", "Include resolved notes").conflicts(["resolved"]))
    .addOption(new Option("--resolved", "List only resolved notes").conflicts(["all"]))
    .option("--about <ID>", "Only notes about this screen or playlist (screen:ID, playlist:ID, or the ID)", aboutOption)
    .option("--author <AGENT_ID>", "Only notes this agent wrote", authorOption)
    .option("--limit <N>", "Limit returned notes (1-200, default 50)", positiveInteger("limit"))
    .option("--after <CURSOR>", "Read the page after this cursor")
    .action(bind(handleNotesList));

  notes.command("show").description("Read one note")
    .argument("<id>", "Note identifier")
    .action(bind(handleNotesShow));

  notes.command("add").description("Write a note for the project's agents")
    .argument("[text]", "Note text, or - for stdin")
    .option("--file <FILE>", "Read the note from a file, or - for stdin")
    .option("--about <ID>", "Attach the note to a screen or playlist (screen:ID, playlist:ID, or the ID)", aboutOption)
    .option("--ttl <DURATION>", "Resolve the note automatically after this long: hours or days, such as 12h or 3d", ttlOption)
    .option("--replaces <ID>", "Resolve this open note as replaced by the new one", replacesOption)
    .action(bind(handleNotesAdd));

  notes.command("confirm").description("Confirm that an open note is still true")
    .argument("<id>", "Note identifier")
    .action(bind(handleNotesConfirm));

  notes.command("resolve").description("Resolve an open note that is wrong or no longer true")
    .argument("<id>", "Note identifier")
    .argument("<reason...>", "Why the note no longer holds")
    .action(bind(handleNotesResolve));
}
