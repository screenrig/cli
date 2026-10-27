import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import {
  handleNotificationsCreate, handleNotificationsDeliveries, handleNotificationsDelete, handleNotificationsList,
  handleNotificationsRotateSecret, handleNotificationsShow, handleNotificationsTest, handleNotificationsUpdate,
} from "../commands.js";
import { NOTIFICATION_CONDITIONS, notificationConditions, notificationHold, notificationRecipients, notificationSnooze, notificationTags } from "../notifications.js";
import { webhookDeliveriesLimit, webhookDeliveryCursor, webhookDescription, webhookEventTypes, webhookUrl } from "../webhooks.js";

const conditionsOption = (value: string): string => { notificationConditions(value); return value; };
const recipientsOption = (value: string): string => { notificationRecipients(value); return value; };
const eventsOption = (value: string): string => { webhookEventTypes(value, "--events"); return value; };
const webhookOption = (value: string): string => webhookUrl(value, "--webhook");
const urlOption = (value: string): string => webhookUrl(value);
const cursorOption = (value: string): string => webhookDeliveryCursor(value, "notifications");

const CONDITIONS = NOTIFICATION_CONDITIONS.join(", ");
const RECIPIENTS = "comma-separated, at most 20: owner (whoever owns the project when a notice sends) and project members' user ids";
const EVENTS = "exact event types (screen.online) or prefixes (screen.*), comma-separated, at most 32";

export function registerNotificationsCommands(root: Command, bind: CommandActionBinder): void {
  const notifications = root.command("notifications").description("Email or webhook alerts when a screen changes state");
  addCommandNotes(notifications, [
    "Notifications:",
    "  A notification sends an email or a signed webhook POST when a screen changes",
    "  state: screen_offline, display_disconnected, running_hot, storage_full,",
    "  content_stuck or crashing. A condition notifies once it has lasted --hold minutes",
    "  (default 10), and a resolved notice follows when it clears after a notice went",
    "  out; crashing is sent at once. --tag limits a notification to screens carrying one",
    "  of those tags. Email goes to each recipient's verified address, one email per",
    "  recipient for everything that falls due within about two minutes, and is free. A",
    "  webhook is signed with ScreenRig-Signature t=<unix>,v1=<hex HMAC-SHA256 over",
    "  \"<t>.<raw body>\">; its secret is printed only by create and rotate-secret. A",
    "  project has at most 20 notifications, email and webhook together, and a new",
    "  project starts with one email to its owner for screens that go offline.",
  ].join("\n"));

  const create = notifications.command("create").description("Create an email or webhook notification for screen state changes")
    .addOption(new Option("--email <RECIPIENTS>", `Email these recipients, ${RECIPIENTS}`).argParser(recipientsOption).conflicts(["webhook"]))
    .addOption(new Option("--webhook <URL>", "POST signed notices to this https URL on a public Internet host, port 443 or 8443").argParser(webhookOption).conflicts(["email"]))
    .option("--conditions <LIST>", `Notify on these screen state changes, comma-separated: ${CONDITIONS}`, conditionsOption)
    .option("--events <TYPES>", `Webhook only: also POST these raw project events as they happen, ${EVENTS}`, eventsOption)
    .option("--tag <TAG>", "Only screens carrying this tag (repeatable, or comma-separated; at most 16). Without --tag, every screen", notificationTags)
    .option("--hold <MINUTES>", "Minutes a condition must last before it notifies, 0 to 1440 (default 10); crashing is never held", notificationHold)
    .option("--description <TEXT>", "Describe the notification (at most 200 characters)", webhookDescription)
    .option("--disabled", "Create it disabled; nothing is sent until notifications update --enable")
    .action(bind(handleNotificationsCreate));
  requireOptionGroup(create, "exactlyOne", ["--email", "--webhook"]);
  requireOptionGroup(create, "atLeastOne", ["--conditions", "--events"]);
  requireOptionGroup(create, "requires", ["--email", "--conditions"]);
  requireOptionGroup(create, "requires", ["--events", "--webhook"]);

  notifications.command("list").description("List this project's notifications (never their secrets)")
    .action(bind(handleNotificationsList));

  notifications.command("show").description("Inspect a notification and its delivery health")
    .argument("<id>", "Notification identifier")
    .action(bind(handleNotificationsShow));

  const update = notifications.command("update").description("Change a notification's recipients, URL, conditions, screens, hold, snooze or enabled state")
    .argument("<id>", "Notification identifier")
    .addOption(new Option("--email <RECIPIENTS>", `Email notifications: replace the recipients, ${RECIPIENTS}`).argParser(recipientsOption).conflicts(["url"]))
    .addOption(new Option("--url <URL>", "Webhook notifications: replace the https URL; checked like create").argParser(urlOption).conflicts(["email"]))
    .addOption(new Option("--conditions <LIST>", `Replace the conditions with these, comma-separated: ${CONDITIONS}`).argParser(conditionsOption).conflicts(["clearConditions"]))
    .addOption(new Option("--clear-conditions", "Remove every condition (a webhook then needs --events)").conflicts(["conditions"]))
    .addOption(new Option("--events <TYPES>", `Webhook notifications: replace the raw project events, ${EVENTS}`).argParser(eventsOption).conflicts(["clearEvents"]))
    .addOption(new Option("--clear-events", "Webhook notifications: stop POSTing raw project events (it then needs conditions)").conflicts(["events"]))
    .addOption(new Option("--tag <TAG>", "Replace the screen tags (repeatable, or comma-separated; at most 16)").argParser(notificationTags).conflicts(["allScreens"]))
    .addOption(new Option("--all-screens", "Remove the screen tags; the notification covers every screen").conflicts(["tag"]))
    .option("--hold <MINUTES>", "Minutes a condition must last before it notifies, 0 to 1440", notificationHold)
    .addOption(new Option("--description <TEXT>", "Replace the description (at most 200 characters)").argParser(webhookDescription).conflicts(["clearDescription"]))
    .addOption(new Option("--clear-description", "Remove the description").conflicts(["description"]))
    .addOption(new Option("--enable", "Enable the notification; clears failure state and starts at the event that records the change").conflicts(["disable"]))
    .addOption(new Option("--disable", "Disable the notification; pending notices fail with webhook_disabled").conflicts(["enable"]))
    .option("--snooze <WHEN>", "Send nothing until then: a duration (30m, 1h, 4h, 2d; at most 30 days), an RFC 3339 instant with seconds and an offset, or off to end the snooze", notificationSnooze)
    .option("--expect-rev <REVISION>", "Optionally require this notification revision", revision)
    .action(bind(handleNotificationsUpdate));
  requireOptionGroup(update, "atLeastOne", [
    "--email", "--url", "--conditions", "--clear-conditions", "--events", "--clear-events", "--tag", "--all-screens",
    "--hold", "--description", "--clear-description", "--enable", "--disable", "--snooze",
  ]);
  requireOptionGroup(update, "atMostOne", ["--email", "--url"]);

  notifications.command("delete").description("Delete a notification; its pending notices fail")
    .argument("<id>", "Notification identifier")
    .option("--expect-rev <REVISION>", "Optionally require this notification revision", revision)
    .action(bind(handleNotificationsDelete));

  notifications.command("rotate-secret").description("Replace a webhook notification's signing secret and print the new one once")
    .argument("<id>", "Notification identifier")
    .option("--expect-rev <REVISION>", "Optionally require this notification revision", revision)
    .action(bind(handleNotificationsRotateSecret));

  notifications.command("test").description("Send one test email or signed test POST to this notification only")
    .argument("<id>", "Notification identifier")
    .action(bind(handleNotificationsTest));

  notifications.command("deliveries").description("Read a notification's delivery log, newest first")
    .argument("<id>", "Notification identifier")
    .option("--before <CURSOR>", "Continue from the next_cursor of the previous page", cursorOption)
    .option("--limit <N>", "Rows per page, 1 to 200 (server default 50)", webhookDeliveriesLimit)
    .action(bind(handleNotificationsDeliveries));
}
