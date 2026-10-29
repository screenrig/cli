// The migrate commands: registered only when an invocation needs them.
import type { Command } from "commander";
import type { CommandActionBinder } from "../cli-commands/types.js";
import { registerMigrateCommands } from "../cli-commands/migrate.js";

export function register(root: Command, bind: CommandActionBinder): void {
  registerMigrateCommands(root, bind);
}
