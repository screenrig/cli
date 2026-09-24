import type { CommandActionBinder } from "./types.js";
import { handleBillingBalance, handleBillingStatement } from "../commands.js";
import type { Command } from "commander";
import { addCommandNotes } from "./notes.js";
import { positiveInteger } from "./options.js";

/**
 * Project credit reads. These are bearer-authorized reads of this project's own
 * balance and posted journal. No command here grants credits, pays out, or
 * changes a payment destination; cash top-ups and withdrawals belong to the
 * verified dashboard financial flow.
 */
export function registerBillingCommands(root: Command, bind: CommandActionBinder): void {
  const billing = root.command("billing").description("Read this project's credits and ledger statement");

  billing.command("balance").description("Read remaining, reserved, and available credits with source eligibility")
    .action(bind(handleBillingBalance));
  billing.command("statement").description("Read posted ledger entries")
    .option("--cursor <CURSOR>", "Continue from the next_cursor of a previous statement")
    .option("--limit <COUNT>", "Maximum entries to return", positiveInteger("limit"))
    .action(bind(handleBillingStatement));
  addCommandNotes(billing.commands.find((command) => command.name() === "balance")!, "One balance is shared by ordinary usage, AI generation, and advertising. Sources explain eligibility, not separate wallets: purchased credits cannot be withdrawn, promotional and included grants cannot fund paid ad spend, and only unspent, matured ad-earned credits can be withdrawn. A displayed balance never authorizes work; the server decides admission.");
  addCommandNotes(billing.commands.find((command) => command.name() === "statement")!, "Entries are posted journal rows, ordered by a stable sequence. Reservations are shown as holds, not posted revenue or spend, and corrections link to the original entry instead of rewriting it. An advertising debit is visible to the buyer; a seller's gross, serving fee, and net are visible to the seller.");
}
