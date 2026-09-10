import type { CommandActionBinder } from "./types.js";
import { handleAccountShow } from "../commands.js";
import type { Command } from "commander";
import { addCommandNotes } from "./notes.js";
import { CREDIT_HELP } from "../help-text.js";

export function registerAccountCommands(root: Command, bind: CommandActionBinder): void {
  const account = root.command("account").description("Inspect your account and credits");

  addCommandNotes(account.command("show").description("Inspect your account and credits")
    .action(bind(handleAccountShow)), CREDIT_HELP);
}
