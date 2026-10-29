import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleKvGet, handleKvSet, handleKvDelete, handleKvList, handleKvWebhookCreate, handleKvWebhookDelete, handleKvWebhookDeliveries, handleKvWebhookList, handleKvWebhookRotateSecret, handleKvWebhookUpdate } from "../handlers/kv.js";
import { kvWebhookDeliveriesLimit, kvWebhookDescription } from "../kv-webhooks.js";
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
  for (const command of kv.commands) command.requiredOption("--app-id <ID>", "Select the application's K/V namespace");
  const set = kv.commands.find(command => command.name() === "set")!;
  requireOptionGroup(set, "exactlyOne", ["--json-value", "--file", "--value-base64"]);

  const webhook = kv.command("webhook").description("Let an outside system write one key, or a card's data document, with an HTTP POST");
  addCommandNotes(webhook, "K/V webhooks:\n  A K/V webhook is a URL with its own srkw_ secret. An outside system (Zapier, Make,\n  a point of sale, a cron job, curl) posts to it with Authorization: Bearer <secret>,\n  or HTTP Basic with the webhook id and the secret. With --app-id the raw body\n  becomes the value of one application key and its Content-Type the content type;\n  apps read the key with screenrig.kv.get and see each change with\n  screenrig.kv.onChange. With --card the JSON or form body becomes the data\n  document of a card, as it is or through a --map template, and the card's own\n  validation decides whether it is shown. An application or a card has at most 20\n  webhooks.");

  webhook.command("create").description("Create a K/V or card webhook and print its URL and secret")
    .argument("[key]", "With --app-id: the key every post writes; it need not exist yet")
    .option("--description <TEXT>", "Say what sends to it, at most 200 bytes", descriptionOption)
    .option("--map <FILE>", "With --card: the template that builds the card's data document from the posted body, a JSON file or - for stdin")
    .option("--signing", "With --card: also require a ScreenRig-Signature header on every post, and print the signing secret once")
    .action(bind(handleKvWebhookCreate));

  webhook.command("list").description("List the webhooks of an application or a card")
    .action(bind(handleKvWebhookList));

  webhook.command("rotate-secret").description("Replace a webhook's secret; the old one stops working at once")
    .argument("<webhook_id>", "K/V webhook identifier")
    .option("--signing", "With --card: replace the signing secret instead of the webhook secret")
    .action(bind(handleKvWebhookRotateSecret));

  webhook.command("delete").description("Delete a webhook; its URL stops working and the key or card keeps its value")
    .argument("<webhook_id>", "K/V webhook identifier")
    .action(bind(handleKvWebhookDelete));
  for (const command of webhook.commands) {
    command.option("--app-id <ID>", "Select the application whose key the webhook writes");
    command.option("--card <CARD_ID>", "Select the card whose data document the webhook writes");
    requireOptionGroup(command, "exactlyOne", ["--app-id", "--card"]);
  }

  webhook.command("update").description("Change a card webhook: description, mapping, enabled state or signing")
    .argument("<webhook_id>", "K/V webhook identifier")
    .requiredOption("--card <CARD_ID>", "Select the card the webhook writes")
    .option("--description <TEXT>", "Say what sends to it, at most 200 bytes", descriptionOption)
    .addOption(new Option("--map <FILE>", "Replace the template that builds the card's data document, a JSON file or - for stdin").conflicts(["clearMap"]))
    .addOption(new Option("--clear-map", "Remove the template: the posted object becomes the document").conflicts(["map"]))
    .addOption(new Option("--enable", "Accept posts again").conflicts(["disable"]))
    .addOption(new Option("--disable", "Answer every post like a wrong secret until enabled again").conflicts(["enable"]))
    .option("--signing", "Require a ScreenRig-Signature header and print the new signing secret once")
    .option("--no-signing", "Stop requiring a ScreenRig-Signature header")
    .action(bind(handleKvWebhookUpdate));
  requireOptionGroup(webhook.commands.find(command => command.name() === "update")!, "atLeastOne",
    ["--description", "--map", "--clear-map", "--enable", "--disable", "--signing", "--no-signing"]);

  webhook.command("deliveries").description("Read a card webhook's delivery log: why each post was written, unchanged or refused")
    .argument("<webhook_id>", "K/V webhook identifier")
    .requiredOption("--card <CARD_ID>", "Select the card the webhook writes")
    .option("--limit <N>", "How many deliveries, newest first (1 to 100)", kvWebhookDeliveriesLimit)
    .action(bind(handleKvWebhookDeliveries));
}
