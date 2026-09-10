import type { CommandActionBinder } from "./types.js";
import { handleDashboard } from "../commands.js";
import type { Command } from "commander";

export function registerDashboardCommands(root: Command, bind: CommandActionBinder): void {
  root.command("dashboard").description("Open the account dashboard")
    .option("--print-url", "Return the browser handoff URL")
    .action(bind(handleDashboard));
}
