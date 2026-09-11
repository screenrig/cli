import { positiveInteger } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleOperationsGet, handleOperationsWait, handleOperationsCancel } from "../commands.js";
import type { Command } from "commander";

export function registerOperationsCommands(root: Command, bind: CommandActionBinder): void {
  const operations = root.command("operations").description("Inspect, wait for, or cancel operations");

  operations.command("show").alias("get").description("Inspect an operation")
    .argument("<id>", "Operation identifier")
    .action(bind(handleOperationsGet));

  operations.command("wait").description("Wait for an operation to finish")
    .argument("<id>", "Operation identifier")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .action(bind(handleOperationsWait));

  operations.command("cancel").description("Cancel an operation")
    .argument("<id>", "Operation identifier")
    .action(bind(handleOperationsCancel));
}
