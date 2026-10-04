import type { Command } from "commander";
import { handleOrganizationList, handleOrganizationRename } from "../commands.js";
import type { CommandActionBinder } from "./types.js";

export function registerOrganizationCommands(root: Command, bind: CommandActionBinder): void {
  const organization = root.command("organization").description("List organizations and administer their names");
  organization.command("list").description("List visible organizations without granting project access").action(bind(handleOrganizationList));
  organization.command("rename").description("Rename an organization you administer")
    .argument("<ID>", "Organization ID from organization list")
    .argument("<NAME>", "New display name").action(bind(handleOrganizationRename));
}
