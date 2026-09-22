import type { CommandActionBinder } from "./types.js";
import { handleAccountShow, handleAccountInvite, handleAccountRecover } from "../commands.js";
import type { Command } from "commander";
import { addCommandNotes } from "./notes.js";
import { CREDIT_HELP, INVITATION_HELP } from "../help-text.js";

export function registerAccountCommands(root: Command, bind: CommandActionBinder): void {
  const account = root.command("account").description("Inspect your account, invite users, and recover dashboard access");

  addCommandNotes(account.command("show").description("Inspect your account and credits")
    .action(bind(handleAccountShow)), CREDIT_HELP);

  addCommandNotes(account.command("invite").description("Invite a user to this account by email")
    .requiredOption("--email <ADDRESS>", "Send the invitation to this address (required)")
    .action(bind(handleAccountInvite)), INVITATION_HELP);

  account.command("recover").description("Email a single-use dashboard recovery link to the account owner")
    .requiredOption("--email <ADDRESS>", "Send the recovery link to this address (required)")
    .action(bind(handleAccountRecover));
}
