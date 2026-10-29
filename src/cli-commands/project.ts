import type { CommandActionBinder } from "./types.js";
import { handleProjectToken, handleProjectShow, handleProjectCapabilities, handleProjectRename, handleProjectList, handleProjectCreate, handleProjectUse, handleProjectMoves, handleProjectMove, handleProjectOwnerTransfer, handleProjectDeletionPreview, handleProjectDelete, handleProjectUptime, handleProjectHealthTrend, handleProjectExport } from "../handlers/project.js";
import { type Command, Option } from "commander";
import { addCommandNotes } from "./notes.js";
import { positiveInteger, projectSubset, reportFormatOption, reportOutputOption } from "./options.js";
import { CREDIT_HELP } from "../help-text.js";
import { playsInstantOption } from "../playback-export.js";

export function registerProjectCommands(root: Command, bind: CommandActionBinder): void {
  const project = root.command("project").description("Create, select, and manage projects");
  project.command("token").description("Request one access token for a subset of consented projects")
    .requiredOption("--projects <IDS>", "Select 1–64 project IDs separated by commas or spaces", projectSubset)
    .action(bind(handleProjectToken));
  project.command("list").description("List this identity's accessible projects by organization").action(bind(handleProjectList));
  project.command("create").description("Create and select a named project; defaults to the current or administered organization")
    .argument("<NAME>", "Project name, unique within its organization")
    .addOption(new Option("--organization-id <ID>", "Create in an organization you administer").conflicts("organization"))
    .option("--organization <NAME>", "Use an accessible organization by name, or create one when you hold no free organization")
    .action(bind(handleProjectCreate));
  project.command("use").description("Select an accessible project as the last-used project")
    .argument("<ID>", "Project ID from project list").action(bind(handleProjectUse));
  project.command("moves").description("List destinations permitted for this project's owner").action(bind(handleProjectMoves));
  project.command("move").description("Move this project, carrying its screens to the destination payer")
    .requiredOption("--organization-id <ID>", "Destination from project moves").action(bind(handleProjectMove));
  project.command("transfer-owner").description("Transfer ownership to an existing verified project member")
    .requiredOption("--user-id <ID>", "Verified person's ID").action(bind(handleProjectOwnerTransfer));
  project.command("deletion-preview").description("Read deletion conditions, archived devices, name and revision").action(bind(handleProjectDeletionPreview));
  project.command("delete").description("Delete an eligible project and email its members")
    .requiredOption("--name <NAME>", "Exact name from deletion-preview")
    .requiredOption("--revision <N>", "Exact revision from deletion-preview", positiveInteger("revision"))
    .option("--yes", "Confirm deletion").action(bind(handleProjectDelete));
  addCommandNotes(project.command("show").description("Inspect your project and credits")
    .action(bind(handleProjectShow)), CREDIT_HELP);
  project.command("capabilities").description("Read this project's plan, feature flags, and effective capabilities")
    .action(bind(handleProjectCapabilities));
  project.command("uptime").description("Read the project's daily screen availability over UTC days")
    .option("--day-from <YYYY-MM-DD>", "First UTC day, inclusive (default 29 days before --day-to)")
    .option("--day-to <YYYY-MM-DD>", "Last UTC day, inclusive (default today); at most 366 days after --day-from")
    .addOption(reportFormatOption())
    .addOption(reportOutputOption("project-uptime.FORMAT"))
    .action(bind(handleProjectUptime));
  project.command("health-trend").description("List the fleet's health by UTC hour: screens reporting, hot, display disconnected, crashing")
    .option("--from <TIME>", "Inclusive start of the hour: RFC 3339, now, or an age such as 7d, 12h, 30m (default 24 hours before --to)", playsInstantOption("--from"))
    .option("--to <TIME>", "Exclusive end: RFC 3339, now, or an age (default now); at most 93 days after --from", playsInstantOption("--to"))
    .addOption(reportFormatOption())
    .addOption(reportOutputOption("health-trend.FORMAT"))
    .action(bind(handleProjectHealthTrend));
  const exportCommand = project.command("export").description("Write a complete copy of this project to a directory in open formats")
    .argument("<DIR>", "Directory to write (created if needed; a rerun continues and refreshes it)")
    .option("--no-media", "Skip the original media files (the manifest still lists them with their hashes)")
    .option("--since <YYYY-MM-DD>", "First UTC day of the plays, uptime and playback CSV and of the event log (default: as far back as the plan keeps the CSV data, and the whole log)");
  exportCommand.action(bind(handleProjectExport));
  addCommandNotes(exportCommand, [
    "Export:",
    "  DIR gets JSON for the project, screens, screen folders, tags, per-screen",
    "  schedules, playlists with every revision, campaigns, direct campaigns, cards and",
    "  their data, sources (credentials never included), notifications, webhooks (no",
    "  signing secrets or receiver URLs), mutes, applications, triggers and report",
    "  subscriptions; the original media files (media/files) with media/manifest.json",
    "  holding each file's SHA-256; CSV for plays, playback, uptime and alerts (data/);",
    "  and the project event log (log/events.jsonl). export.json lists every file with",
    "  its size and SHA-256. A rerun keeps media files that are complete and continues",
    "  partial ones. It reads through the project's own routes, so it needs the",
    "  access those reads need; a section the credential cannot read is reported as",
    "  skipped. Each request is a billed API request, and media downloads are egress.",
  ].join("\n"));
  project.command("rename").description("Rename this project")
    .argument("<NAME>", "Project display name")
    .action(bind(handleProjectRename));
}
