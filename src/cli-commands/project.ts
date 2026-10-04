import type { CommandActionBinder } from "./types.js";
import { handleProjectShow, handleProjectCapabilities, handleProjectRename, handleProjectList, handleProjectCreate, handleProjectUse, handleProjectMoves, handleProjectMove, handleProjectOwnerTransfer, handleProjectDeletionPreview, handleProjectDelete } from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes } from "./notes.js";
import { positiveInteger } from "./options.js";
import { CREDIT_HELP } from "../help-text.js";

export function registerProjectCommands(root: Command, bind: CommandActionBinder): void {
  const project = root.command("project").description("Create, select, and manage projects");
  project.command("list").description("List this identity's accessible projects by organization").action(bind(handleProjectList));
  project.command("create").description("Create and select a named project; defaults to the current organization")
    .argument("<NAME>", "Project name, unique within its organization")
    .addOption(new Option("--organization-id <ID>", "Create in an organization you administer").conflicts("organization"))
    .option("--organization <NAME>", "Use an accessible organization by name or create it")
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
  project.command("rename").description("Rename this project")
    .argument("<NAME>", "Project display name")
    .action(bind(handleProjectRename));
}
