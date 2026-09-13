import { addValueAlias } from "./aliases.js";
import { requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleKvGet, handleKvSet, handleKvDelete, handleKvList } from "../commands.js";
import { type Command, Option } from "commander";

export function registerKvCommands(root: Command, bind: CommandActionBinder): void {
  const kv = root.command("kv").description("Read and write application key-value data");

  kv.command("get").description("Read an application key")
    .argument("<key>", "Application key")
    .action(bind(handleKvGet));

  kv.command("set").description("Write a value")
    .argument("<key>", "Application key")
    .addOption(new Option("--json-value <JSON>", "Supply a JSON value").conflicts(["file", "valueBase64"]))
    .addOption(new Option("--file <FILE>", "Read the value from a file, or - for stdin").conflicts(["jsonValue", "valueBase64"]))
    .addOption(new Option("--value-base64 <BASE64>", "Supply canonical base64 bytes (may be empty)").conflicts(["jsonValue", "file"]))
    .addOption(new Option("--content-type <TYPE>", "Content MIME type; defaults to application/octet-stream for bytes"))
    .option("--expect-rev <REVISION>", "Require the current resource revision", revision)
    .action(bind(handleKvSet));

  kv.command("delete").description("Delete an application key")
    .argument("<key>", "Application key")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleKvDelete));

  kv.command("list").description("List application keys")
    .action(bind(handleKvList));
  for (const command of kv.commands) addValueAlias(command, "--app-id", "--application-id", "Select the application's K/V namespace", true);
  const set = kv.commands.find(command => command.name() === "set")!;
  requireOptionGroup(set, "exactlyOne", ["--json-value", "--file", "--value-base64"]);
}
