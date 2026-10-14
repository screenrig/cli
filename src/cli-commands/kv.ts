import { addValueAlias } from "./aliases.js";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import {
  handleKvGet, handleKvSet, handleKvDelete, handleKvList,
  handleKvWebhookCreate, handleKvWebhookDelete, handleKvWebhookList, handleKvWebhookRotateSecret,
} from "../commands.js";
import { kvWebhookDescription } from "../kv-webhooks.js";
import { type Command, Option } from "commander";

const descriptionOption = (value: string): string => { kvWebhookDescription(value); return value; };

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

  const webhook = kv.command("webhook").description("Let an outside system write one key with an HTTP POST");
  addCommandNotes(webhook, "K/V webhooks:\n  A K/V webhook is a URL with its own srkw_ secret that writes one key of one\n  application. An outside system (Zapier, Make, a point of sale, a cron job, curl)\n  posts the key's new value to it with Authorization: Bearer <secret>, or HTTP\n  Basic with the webhook id and the secret; the raw body becomes the value and\n  its Content-Type the content type. Apps read the key with screenrig.kv.get and\n  see each change with screenrig.kv.onChange. An application has at most 20\n  webhooks.");

  webhook.command("create").description("Create a K/V webhook and print its URL and secret")
    .argument("<key>", "The key every post writes; it need not exist yet")
    .option("--description <TEXT>", "Say what sends to it, at most 200 bytes", descriptionOption)
    .action(bind(handleKvWebhookCreate));

  webhook.command("list").description("List this application's K/V webhooks")
    .action(bind(handleKvWebhookList));

  webhook.command("rotate-secret").description("Replace a K/V webhook's secret; the old one stops working at once")
    .argument("<webhook_id>", "K/V webhook identifier")
    .action(bind(handleKvWebhookRotateSecret));

  webhook.command("delete").description("Delete a K/V webhook; its URL stops working and the key keeps its value")
    .argument("<webhook_id>", "K/V webhook identifier")
    .action(bind(handleKvWebhookDelete));
  for (const command of webhook.commands) addValueAlias(command, "--app-id", "--application-id", "Select the application whose key the webhook writes", true);
}
