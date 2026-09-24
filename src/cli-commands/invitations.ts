import { type Command, Option } from "commander";
import type { CommandActionBinder } from "./types.js";
import { handleInvitationsCreate, handleInvitationsList, handleInvitationsRevoke } from "../commands.js";
import { addCommandNotes } from "./notes.js";
import { INVITATION_HELP } from "../help-text.js";

export function registerInvitationCommands(root: Command, bind: CommandActionBinder): void {
  const invitations = root.command("invitations").description("Invite project members and advertising buyers");
  addCommandNotes(invitations.command("create").description("Create member or ad-buyer invitations")
    .requiredOption("--email <ADDRESS[,ADDRESS]>", "Comma-separated intended recipient addresses")
    .addOption(new Option("--kind <KIND>", "Invitation kind").choices(["member", "ad-buyer"]).default("member"))
    .option("--link", "Print one member invitation URL instead of emailing; deliver it only to the intended person")
    .option("--screen-id <ID>", "Comma-separated screen identifiers allowed for an ad-buyer")
    .option("--slot-id <ID>", "Comma-separated slot identifiers allowed for an ad-buyer")
    .addOption(new Option("--policy <POLICY>", "Ad-buyer creative review policy").choices(["trusted", "review_required"]))
    .action(bind(handleInvitationsCreate)), INVITATION_HELP);
  invitations.command("list").description("List this project's invitations")
    .addOption(new Option("--kind <KIND>", "Filter invitation kind").choices(["member", "ad-buyer"]))
    .addOption(new Option("--status <STATUS>", "Filter invitation status").choices(["queued", "sent", "issued", "accepted", "revoked", "expired", "failed"]))
    .action(bind(handleInvitationsList));
  invitations.command("revoke").description("Revoke an outstanding invitation")
    .argument("<ID>", "Invitation identifier")
    .action(bind(handleInvitationsRevoke));
}
