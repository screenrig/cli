import type { CommandActionBinder } from "./types.js";
import { handleBrowserSetup } from "../commands.js";
import type { Command } from "commander";

export function registerBrowserCommands(root: Command, bind: CommandActionBinder): void {
  const browser = root.command("browser").description("Complete browser Player setup");

  browser.command("setup").description("Complete browser setup from a code")
    .requiredOption("--code <CODE>", "Use the browser setup code (required)")
    .option("--open", "Open the result in its viewer")
    .action(bind(handleBrowserSetup));
}
