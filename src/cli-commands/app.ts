import { positiveInteger, revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleAppPack, handleAppUpload, handleAppUpdate, handleAppList, handleAppShow } from "../commands.js";
import type { Command } from "commander";

export function registerAppCommands(root: Command, bind: CommandActionBinder): void {
  const app = root.command("app").description("Pack, upload, and inspect applications");

  app.command("pack").description("Pack a local application directory")
    .argument("<directory>", "Local directory")
    .option("--output <PATH>", "Write the application package to this file")
    .action(bind(handleAppPack));

  app.command("upload").description("Upload an application directory")
    .argument("<directory>", "Local directory")
    .option("--name <NAME>", "Set the application name")
    .option("--no-wait", "Return after acceptance without waiting for processing")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .action(bind(handleAppUpload));

  app.command("update").description("Update an application")
    .argument("<id>", "Application identifier")
    .argument("<directory>", "Local directory")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .option("--no-wait", "Return after acceptance without waiting for processing")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .action(bind(handleAppUpdate));

  app.command("list").description("List applications")
    .action(bind(handleAppList));

  app.command("show").description("Inspect an application")
    .argument("<id>", "Application identifier")
    .action(bind(handleAppShow));
}
