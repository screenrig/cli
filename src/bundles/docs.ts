// The documentation commands: registered only when an invocation needs them.
import type { Command } from "commander";
import type { CommandActionBinder } from "../cli-commands/types.js";
import { registerDocsCommands } from "../cli-commands/docs.js";

export function register(root: Command, bind: CommandActionBinder): void {
  registerDocsCommands(root, bind);
}
