import { usageError } from "../problems.js";
import { positiveInteger } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleComposeCatalog, handleComposeBatch, handleComposeRender } from "../commands.js";
import type { Command } from "commander";
import { addCommandNotes } from "./notes.js";
import { LOOK_AT_THE_CONTACT_SHEET } from "../playlist-preview.js";

export function registerComposeCommands(root: Command, bind: CommandActionBinder): void {
  const compose = root.command("compose").description("Render and inspect local page compositions");

  compose.command("catalog").description("Browse local composition capabilities and examples")
    .action(bind(handleComposeCatalog));

  addCommandNotes(compose.command("batch").description("Render a batch of compositions")
    .argument("<file>", "Local input file")
    .requiredOption("--output <PATH>", "Write rendered files to this directory (required)")
    .option("--only <ID>", "Render only this page")
    .option("--target-width <PX>", "Set the physical content width", positiveInteger("target-width"))
    .option("--target-height <PX>", "Set the physical content height", positiveInteger("target-height"))
    .option("--safe-area", "Apply the display safe area")
    .option("--lint-only", "Run the command's local validation/lint mode")
    .hook("preAction", requireTargetDimensions)
    .action(bind(handleComposeBatch)), `Render 1 to 2000 pages. ${LOOK_AT_THE_CONTACT_SHEET}`);

  addCommandNotes(compose.command("render").description("Render a composition locally")
    .argument("<file>", "Local input file")
    .option("--output <PATH>", "Write rendered files to this directory")
    .option("--combined", "Also render combined page images")
    .option("--target-width <PX>", "Set the physical content width", positiveInteger("target-width"))
    .option("--target-height <PX>", "Set the physical content height", positiveInteger("target-height"))
    .option("--safe-area", "Apply the display safe area")
    .option("--open", "Open the result in its viewer")
    .option("--lint-only", "Run the command's local validation/lint mode")
    .hook("preAction", requireTargetDimensions)
    .action(bind(handleComposeRender)), LOOK_AT_THE_CONTACT_SHEET);
}

function requireTargetDimensions(command: Command): void {
  const width = command.getOptionValueSource("targetWidth") === "cli";
  const height = command.getOptionValueSource("targetHeight") === "cli";
  if (width !== height) throw usageError("Provide both --target-width and --target-height.");
}
