import { type Command, Option } from "commander";
import type { CommandActionBinder } from "./types.js";
import { handleInvitationsCreate, handleInvitationsList, handleInvitationsRevoke } from "../commands.js";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { INVITATION_HELP } from "../help-text.js";

export function registerInvitationCommands(root: Command, bind: CommandActionBinder): void {
  const invitations = root.command("invitations").description("Invite project members and advertising buyers");
  const create = invitations.command("create").description("Create member or ad-buyer invitations")
    .addOption(new Option("--email <ADDRESS[,ADDRESS]>", "Comma-separated recipient addresses to email").conflicts("link"))
    .addOption(new Option("--kind <KIND>", "Invitation kind").choices(["member", "ad-buyer"]).default("member"))
    .addOption(new Option("--link", "Print one member invitation URL instead of emailing; it names no recipient, so deliver it only to the intended person").conflicts("email"))
    .option("--screen-id <ID>", "Comma-separated screen identifiers allowed for an ad-buyer")
    .option("--slot-id <ID>", "Comma-separated slot identifiers allowed for an ad-buyer")
    .addOption(new Option("--policy <POLICY>", "Ad-buyer creative review policy").choices(["trusted", "review_required"]))
    .action(bind(handleInvitationsCreate));
  addCommandNotes(create, INVITATION_HELP);
  requireOptionGroup(create, "exactlyOne", ["--email", "--link"]);
  invitations.command("list").description("List this project's invitations")
    .addOption(new Option("--kind <KIND>", "Filter invitation kind").choices(["member", "ad-buyer"]))
    .addOption(new Option("--status <STATUS>", "Filter invitation status").choices(["queued", "sent", "issued", "accepted", "revoked", "expired", "failed"]))
    .action(bind(handleInvitationsList));
  invitations.command("revoke").description("Revoke an outstanding invitation")
    .argument("<ID>", "Invitation identifier")
    .action(bind(handleInvitationsRevoke));
}
