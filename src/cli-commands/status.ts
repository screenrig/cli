import { Command, Option } from "commander";
import { handleServiceStatus } from "../service-status.js";
import type { CommandActionBinder } from "./types.js";

export function registerStatusCommands(root: Command, bind: CommandActionBinder): void {
  root.command("status").description("Check production or stage service availability")
    .addOption(new Option("--environment <ENV>", "Environment to inspect").choices(["production", "stage"]).default("production"))
    .action(bind(handleServiceStatus));
}
