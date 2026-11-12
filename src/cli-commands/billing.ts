import type { CommandActionBinder } from "./types.js";
import { handleBillingBalance, handleBillingStatement, handleBillingUsage } from "../handlers/billing.js";
import type { Command } from "commander";
import { addCommandNotes } from "./notes.js";
import { positiveInteger } from "./options.js";
import { LIMITS_HELP } from "../help-text.js";

/**
 * Project billing reads: the plan's limits, and this project's own advertising
 * amounts and posted ledger, in US dollars. No command here pays out or changes
 * a payment destination; those belong to the verified dashboard financial flow.
 */
export function registerBillingCommands(root: Command, bind: CommandActionBinder): void {
  const billing = root.command("billing").description("Read plan limits and advertising amounts in dollars");

  const usage = billing.command("usage").description("Read the plan's storage and agent request limits")
    .action(bind(handleBillingUsage));
  addCommandNotes(usage, LIMITS_HELP);

  billing.command("balance").description("Read advertising amounts in dollars: remaining, reserved, available and payable earnings")
    .action(bind(handleBillingBalance));
  billing.command("statement").description("Read posted ledger entries")
    .option("--cursor <CURSOR>", "Continue from the next_cursor of a previous statement")
    .option("--limit <COUNT>", "Maximum entries to return", positiveInteger("limit"))
    .action(bind(handleBillingStatement));
  addCommandNotes(billing.commands.find((command) => command.name() === "balance")!, "Requests, storage, playback and everything else a project does are never charged; these amounts are advertising only. Advertisers pay by card or x402 machine payment, prices and earnings are US dollars, and payouts start 1 January 2027. Human output shows dollars; JSON keeps the decimal mcr members (10,000,000 mcr is $1).");
  addCommandNotes(billing.commands.find((command) => command.name() === "statement")!, "Entries are posted ledger rows in US dollars, ordered by a stable sequence (JSON keeps decimal mcr members, 10,000,000 mcr is $1). Reservations are shown as holds, not posted earnings or spend, and corrections link to the original entry instead of rewriting it. An advertising charge is visible to the buyer; a seller's gross, serving fee, and net are visible to the seller.");
}
