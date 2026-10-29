import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import type { CommandActionBinder } from "./types.js";
import { handleScheduleImport, handleScheduleTemplate, scheduleImportCodeField, scheduleImportName, scheduleImportTimezone } from "../schedule-import.js";

export function registerScheduleImportCommands(root: Command, bind: CommandActionBinder): void {
  const schedule = root.command("schedule").description("Import schedules in bulk from a spreadsheet");
  addCommandNotes(schedule, "Schedule import:\n  schedule import checks a sheet of rows (screen, file, start, end) against the\n  project, previews the levels it makes and the calendar effect, and with\n  --commit applies all of it or none. schedule template saves a sheet to start\n  from. A single screen's own schedule is screen schedule; a campaign\n  schedules an audience.");

  schedule.command("import").description("Check a spreadsheet of schedule rows and preview what it does; --commit applies it")
    .argument("<file>", "A .csv, .xlsx or .json sheet (JSON: an array of row objects or {\"rows\": [...]}), or - to read JSON rows or CSV text from stdin")
    .option("--name <NAME>", "Name the import, 1 to 80 characters; importing again under the same name updates the levels it made (default: the file name without its extension)", scheduleImportName)
    .option("--timezone <ZONE>", "IANA zone the times are written in when a row has no timezone, such as America/New_York (default: each screen's own clock)", scheduleImportTimezone)
    .option("--code-field <FIELD>", "Read the screen code only from this screen field, such as code or room_id (default: a code matches any field)", scheduleImportCodeField)
    .option("--commit", "Apply the import when the preview is valid; with row errors nothing is written")
    .action(bind(handleScheduleImport));

  const template = schedule.command("template").description("Save a sheet with the columns a schedule import reads and three example rows")
    .addOption(new Option("--format <FORMAT>", "Sheet format (default: csv)").choices(["csv", "xlsx"]))
    .option("--output <FILE>", "Write the sheet to this file (required for xlsx); without it the CSV is printed")
    .option("--overwrite", "Replace --output if it exists")
    .action(bind(handleScheduleTemplate));
  requireOptionGroup(template, "requires", ["--overwrite", "--output"]);
}
