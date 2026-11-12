import type { CommandActionBinder } from "./types.js";
import { handleBillingBalance, handleBillingStatement, handleBillingUsage } from "../handlers/billing.js";
import type { Command } from "commander";
import { addCommandNotes } from "./notes.js";
import { positiveInteger } from "./options.js";
import { LIMITS_HELP } from "../help-text.js";

/**
 * Project billing reads: the plan's limits, and this project's own advertising
 * balance and posted journal. No command here grants credits, pays out, or
 * changes a payment destination; those belong to the verified dashboard
 * financial flow.
 */
export function registerBillingCommands(root: Command, bind: CommandActionBinder): void {
  const billing = root.command("billing").description("Read this plan's limits, and the advertising balance and ledger statement");

  const usage = billing.command("usage").description("Read the plan's storage and agent request limits")
    .action(bind(handleBillingUsage));
  addCommandNotes(usage, LIMITS_HELP);

  billing.command("balance").description("Read the advertising balance: remaining, reserved, and available, with source eligibility")
    .action(bind(handleBillingBalance));
  billing.command("statement").description("Read posted ledger entries")
    .option("--cursor <CURSOR>", "Continue from the next_cursor of a previous statement")
    .option("--limit <COUNT>", "Maximum entries to return", positiveInteger("limit"))
    .action(bind(handleBillingStatement));
  addCommandNotes(billing.commands.find((command) => command.name() === "balance")!, "Requests, storage, playback and everything else a project does never spend this balance; it pays for advertising. Sources explain eligibility, not separate wallets: purchased credits cannot be withdrawn, promotional and included grants cannot fund paid ad spend, and only unspent, matured ad-earned credits can be withdrawn.");
  addCommandNotes(billing.commands.find((command) => command.name() === "statement")!, "Entries are posted journal rows, ordered by a stable sequence. Reservations are shown as holds, not posted revenue or spend, and corrections link to the original entry instead of rewriting it. An advertising debit is visible to the buyer; a seller's gross, serving fee, and net are visible to the seller.");
}
