import type { CommandActionBinder } from "./types.js";
import { handleVersion } from "../commands.js";
import type { Command } from "commander";

export function registerVersionCommands(root: Command, bind: CommandActionBinder): void {
  root.command("version").description("Show CLI and protocol versions")
    .action(bind(handleVersion));
}
