import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleKvGet, handleKvSet, handleKvDelete, handleKvList } from "../commands.js";
import { type Command, Option } from "commander";

export function registerKvCommands(root: Command, bind: CommandActionBinder): void {
  const kv = root.command("kv").description("Read and write application key-value data");

  kv.command("get").description("Read an application key")
    .argument("<key>", "Application key")
    .requiredOption("--application-id <ID>", "Select the application's K/V namespace (required)")
    .action(bind(handleKvGet));

  kv.command("set").description("Write a value")
    .argument("<key>", "Application key")
    .requiredOption("--application-id <ID>", "Select the application's K/V namespace (required)")
    .addOption(new Option("--json-value <JSON>", "Supply a JSON value").conflicts(["file", "valueBase64", "contentType"]))
    .addOption(new Option("--file <FILE>", "Read the value from a file").conflicts(["jsonValue", "valueBase64"]))
    .addOption(new Option("--value-base64 <BASE64>", "Supply canonical base64 bytes (may be empty)").conflicts(["jsonValue", "file"]))
    .addOption(new Option("--content-type <TYPE>", "Declare the content MIME type").conflicts(["jsonValue"]))
    .option("--if-match <REVISION>", "Require the current resource revision", revision)
    .action(bind(handleKvSet));

  kv.command("delete").description("Delete an application key")
    .argument("<key>", "Application key")
    .requiredOption("--application-id <ID>", "Select the application's K/V namespace (required)")
    .requiredOption("--if-match <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handleKvDelete));

  kv.command("list").description("List application keys")
    .requiredOption("--application-id <ID>", "Select the application's K/V namespace (required)")
    .action(bind(handleKvList));
}
