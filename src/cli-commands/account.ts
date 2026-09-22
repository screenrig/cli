import type { CommandActionBinder } from "./types.js";
import { handleAccountShow, handleAccountInvite } from "../commands.js";
import type { Command } from "commander";
import { addCommandNotes } from "./notes.js";
import { CREDIT_HELP, INVITATION_HELP } from "../help-text.js";

export function registerAccountCommands(root: Command, bind: CommandActionBinder): void {
  const account = root.command("account").description("Inspect your account and invite users");

  addCommandNotes(account.command("show").description("Inspect your account and credits")
    .action(bind(handleAccountShow)), CREDIT_HELP);

  addCommandNotes(account.command("invite").description("Invite a user to this account by email")
    .requiredOption("--email <ADDRESS>", "Send the invitation to this address (required)")
    .action(bind(handleAccountInvite)), INVITATION_HELP);
}
