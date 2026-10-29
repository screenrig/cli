import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleWebhooksCreate, handleWebhooksDeliveries, handleWebhooksDelete, handleWebhooksList, handleWebhooksRotateSecret, handleWebhooksShow, handleWebhooksTest, handleWebhooksUpdate } from "../handlers/webhooks.js";
import { webhookDeliveriesLimit, webhookDeliveryCursor, webhookDescription, webhookEventTypes, webhookUrl } from "../webhooks.js";

const eventTypesOption = (value: string): string => { webhookEventTypes(value); return value; };
const urlOption = (value: string): string => webhookUrl(value);
const cursorOption = (value: string): string => webhookDeliveryCursor(value);

export function registerWebhooksCommands(root: Command, bind: CommandActionBinder): void {
  const webhooks = root.command("webhooks").description("Send this project's events to your HTTPS endpoints as signed POSTs");
  addCommandNotes(webhooks, "Webhooks:\n  A project has at most 20 notifications, email and webhook together. Each\n  matching project event is POSTed as the same JSON object events list returns,\n  signed with ScreenRig-Signature t=<unix>,v1=<hex HMAC-SHA256 over\n  \"<t>.<raw body>\">. The secret is printed only by create and rotate-secret.\n  Delivery is at least once and unordered; deduplicate on ScreenRig-Event-Id.\n  Email and screen alerts (offline, display disconnected, running hot, storage\n  full, content stuck, not playing, crashing) are screenrig notifications.");

  webhooks.command("create").description("Register an HTTPS endpoint and print its signing secret once")
    .requiredOption("--url <URL>", "https URL on a public Internet host, port 443 or 8443 (required)", urlOption)
    .requiredOption("--event-types <TYPES>", "Comma-separated event types (screen.online) or prefixes (screen.*) (required)", eventTypesOption)
    .option("--description <TEXT>", "Describe the endpoint (at most 200 characters)", webhookDescription)
    .option("--disabled", "Create it disabled; nothing is delivered until webhooks update --enable")
    .action(bind(handleWebhooksCreate));

  webhooks.command("list").description("List this project's webhooks (never their secrets)")
    .action(bind(handleWebhooksList));

  webhooks.command("show").description("Inspect a webhook and its delivery health")
    .argument("<id>", "Webhook identifier")
    .action(bind(handleWebhooksShow));

  const update = webhooks.command("update").description("Change a webhook's URL, event types, description, or enabled state")
    .argument("<id>", "Webhook identifier")
    .option("--url <URL>", "Replace the https URL; checked like create", urlOption)
    .option("--event-types <TYPES>", "Replace the comma-separated event types or prefixes", eventTypesOption)
    .addOption(new Option("--description <TEXT>", "Replace the description (at most 200 characters)").argParser(webhookDescription).conflicts(["clearDescription"]))
    .addOption(new Option("--clear-description", "Remove the description").conflicts(["description"]))
    .addOption(new Option("--enable", "Enable delivery; clears failure state and starts at the current event").conflicts(["disable"]))
    .addOption(new Option("--disable", "Disable delivery; pending deliveries fail with webhook_disabled").conflicts(["enable"]))
    .option("--expect-rev <REVISION>", "Optionally require this webhook revision", revision)
    .action(bind(handleWebhooksUpdate));
  requireOptionGroup(update, "atLeastOne", ["--url", "--event-types", "--description", "--clear-description", "--enable", "--disable"]);

  webhooks.command("delete").description("Delete a webhook; its pending deliveries fail")
    .argument("<id>", "Webhook identifier")
    .option("--expect-rev <REVISION>", "Optionally require this webhook revision", revision)
    .action(bind(handleWebhooksDelete));

  webhooks.command("rotate-secret").description("Replace a webhook's signing secret and print the new one once")
    .argument("<id>", "Webhook identifier")
    .option("--expect-rev <REVISION>", "Optionally require this webhook revision", revision)
    .action(bind(handleWebhooksRotateSecret));

  webhooks.command("test").description("Queue one webhook.test delivery to this webhook only")
    .argument("<id>", "Webhook identifier")
    .action(bind(handleWebhooksTest));

  webhooks.command("deliveries").description("Read a webhook's delivery log, newest event first")
    .argument("<id>", "Webhook identifier")
    .option("--before <CURSOR>", "Continue from the next_cursor of the previous page", cursorOption)
    .option("--limit <N>", "Rows per page, 1 to 200 (server default 50)", webhookDeliveriesLimit)
    .action(bind(handleWebhooksDeliveries));
}
