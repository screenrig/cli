// The screens commands: registered only when an invocation needs them.
import type { Command } from "commander";
import type { CommandActionBinder } from "../cli-commands/types.js";
import { registerScreenCommands } from "../cli-commands/screen.js";
import { registerFleetLinksCommands } from "../cli-commands/fleet-links.js";

export function register(root: Command, bind: CommandActionBinder): void {
  registerScreenCommands(root, bind);
  registerFleetLinksCommands(root, bind);
}
