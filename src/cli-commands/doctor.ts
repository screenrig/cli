import type { CommandActionBinder } from "./types.js";
import { handleDoctor } from "../commands.js";
import type { Command } from "commander";

export function registerDoctorCommands(root: Command, bind: CommandActionBinder): void {
  root.command("doctor").description("Check this CLI installation and configuration")
    .option("--repair-config", "Repair configuration permissions")
    .action(bind(handleDoctor));
}
