import { positiveInteger, revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleAppPack, handleAppTypes, handleAppUpload, handleAppUpdate, handleAppList, handleAppShow, handleAppRename, handleAppDelete } from "../handlers/app.js";
import { handleAppDev } from "../handlers/app-dev.js";
import { requireOptionGroup } from "./notes.js";
import type { Command } from "commander";

export function registerAppCommands(root: Command, bind: CommandActionBinder): void {
  const app = root.command("app").description("Develop, pack, upload, rename, inspect, and delete applications");

  app.command("pack").description("Pack a local application directory")
    .argument("<directory>", "Local directory")
    .option("--output <PATH>", "Write the application package to this file")
    .action(bind(handleAppPack));

  const dev = app.command("dev").description("Serve a local Player harness for developing an application")
    .argument("<directory>", "Local directory")
    .option("--port <PORT>", "Listen on this port; the runtime trusts the harness only on 18890, the default", positiveInteger("port"))
    .option("--kv <FILE>", "Keep stored values in this JSON file; default .screenrig-dev/kv.json in the directory")
    .option("--kv-from <ID>", "Read this application's real stored values through the signed-in CLI, read-only")
    .option("--open", "Open the harness in the default browser")
    .option("--no-reload", "Do not reload the application when a file changes")
    .action(bind(handleAppDev));
  requireOptionGroup(dev, "atMostOne", ["--kv", "--kv-from"]);

  app.command("types").description("Write the TypeScript types for window.screenrig into a directory")
    .argument("[directory]", "Directory to write screenrig.d.ts into; defaults to the current directory")
    .action(bind(handleAppTypes));

  app.command("upload").description("Upload an application directory")
    .argument("<directory>", "Local directory")
    .option("--name <NAME>", "Set the application name")
    .option("--no-wait", "Return after acceptance without waiting for processing")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .action(bind(handleAppUpload));

  app.command("update").description("Publish a new application release")
    .argument("<id>", "Application identifier")
    .argument("<directory>", "Local directory")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .option("--no-wait", "Return after acceptance without waiting for processing")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .action(bind(handleAppUpdate));

  app.command("list").description("List applications")
    .action(bind(handleAppList));

  app.command("rename").description("Change an application's display name")
    .argument("<id>", "Application identifier")
    .requiredOption("--name <NAME>", "New application name")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleAppRename));

  app.command("show").description("Inspect an application")
    .argument("<id>", "Application identifier")
    .action(bind(handleAppShow));

  app.command("delete").description("Delete an application and all of its releases")
    .argument("<id>", "Application identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleAppDelete));
}
