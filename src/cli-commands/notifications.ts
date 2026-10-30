import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleNotificationsCreate, handleNotificationsDeliveries, handleNotificationsDelete, handleNotificationsList, handleNotificationsResubscribe, handleNotificationsRotateSecret, handleNotificationsShow, handleNotificationsTest, handleNotificationsUpdate } from "../handlers/notifications.js";
import { NOTIFICATION_CONDITIONS, NOTIFICATION_SEVERITIES, notificationAllTags, notificationAnyTags, notificationAudienceOption, notificationSeverityOverride, notificationTelegramChat, notificationConditions, notificationDeliveryCursor, notificationHold, notificationRecipients, notificationReachDropPercent, notificationReachDropScreens, notificationSnooze, notificationTags, notificationTimezone, notificationUserId } from "../notifications.js";
import { weeklyWindows } from "../campaigns.js";
import { webhookDeliveriesLimit, webhookDescription, webhookEventTypes, webhookUrl } from "../webhooks.js";

const conditionsOption = (value: string): string => { notificationConditions(value); return value; };
const recipientsOption = (value: string): string => { notificationRecipients(value); return value; };
const eventsOption = (value: string): string => { webhookEventTypes(value, "--events"); return value; };
const webhookOption = (value: string): string => webhookUrl(value, "--webhook");
const urlOption = (value: string): string => webhookUrl(value);
const cursorOption = (value: string): string => notificationDeliveryCursor(value);

const chatOption = (value: string): string => notificationTelegramChat(value);

const CHANNEL_FLAGS = ["email", "webhook", "slack", "teams", "pagerduty", "telegram"] as const;
/** The channel flags a channel flag cannot be given with, as option attribute names. */
const otherChannels = (flag: (typeof CHANNEL_FLAGS)[number]): string[] => CHANNEL_FLAGS.filter((name) => name !== flag);

const activeHoursOption = weeklyWindows("--active-hours");

const REACH_DROP_SCREENS_HELP = "With the reach_dropped condition: send a notice only when a campaign loses at least N screens (default 1)";
const REACH_DROP_PERCENT_HELP = "With the reach_dropped condition: send a notice only when the loss is at least P percent (1 to 100) of the screens the campaign reached when it was published; a drop must meet both thresholds";
const CONDITIONS = NOTIFICATION_CONDITIONS.join(", ");
const SEVERITIES = NOTIFICATION_SEVERITIES.join(", ");
const SEVERITY_HELP = `Override a condition's severity for this notification, CONDITION=LEVEL such as not_playing=error (repeatable; conditions: ${CONDITIONS}; levels: ${SEVERITIES}). The default is error for screen_offline and warning for every other condition. It counts for --min-severity and is the severity every channel shows`;
const HOURS_HELP = 'Send opened notices only in this weekly window, DAYS HH:MM-HH:MM such as "Mon-Fri 08:00-22:00" (repeatable, at most 16; needs --timezone)';
const AUDIENCE_HELP = 'The screens it covers, as a campaign audience rule in JSON such as {"all":[{"tag":"level2"},{"tag":"overhead"}]} (inline, a FILE, or - for stdin); instead of --tag';
const RECIPIENTS = "comma-separated, at most 20: owner (whoever owns the project when a notice sends) and project members' user ids";
const EVENTS = "exact event types (screen.online) or prefixes (screen.*), comma-separated, at most 32";

export function registerNotificationsCommands(root: Command, bind: CommandActionBinder): void {
  const notifications = root.command("notifications").description("Email, webhook, chat or pager alerts for screen changes");
  addCommandNotes(notifications, [
    "Notifications:",
    "  A notification sends an email, a signed webhook POST, or a message in Slack,",
    "  Teams, PagerDuty or Telegram when a screen changes",
    "  state: screen_offline, display_disconnected, running_hot, storage_full,",
    "  content_stuck, not_playing, loop_stalled, glass_blank, glass_frozen or crashing,",
    "  or when a data source fails to refresh or goes stale (source_failed,",
    "  source_stale; --tag never matches a source), or when a content campaign (the",
    "  shared level of the schedule stack) stops reaching screens: reach_dropped when",
    "  it reaches fewer screens than when it was last published (--reach-drop-screens",
    "  and --reach-drop-percent set the smallest drop that notifies), group_empty when",
    "  a tag or folder its audience names matches no screen. Neither is limited by",
    "  --tag or --audience. A condition notifies once it has lasted",
    "  --hold minutes (default 10), and a resolved notice follows when it clears after",
    "  a notice went out; crashing is sent at once. A notice sends nothing when the",
    "  screen's alert is acknowledged or snoozed during the hold, or a mute covers the",
    "  screen (screenrig alerts). --tag limits a notification to screens carrying one",
    "  of those tags, --any-tag and --all-tags to screens carrying at least one or",
    "  every one of them, and --audience takes any campaign audience rule.",
    "  --min-severity (info, warning, error) creates no opened notice below that level",
    "  and --severity CONDITION=LEVEL sets a condition's level: error for",
    "  screen_offline and warning for every other condition unless overridden;",
    "  email, Slack and Telegram text show the severity, Teams and PagerDuty use it,",
    "  and a signed webhook body carries severity. --active-hours \"Mon-Fri",
    "  08:00-22:00\" --timezone ZONE sends opened notices only in those windows: a",
    "  notice that falls due outside them is held until the next window opens (and",
    "  sent if its condition still holds) or, with --outside-hours drop, skipped; a",
    "  resolved notice for a sent notice and a test always go out. Email goes to each recipient's verified address, one email per",
    "  recipient for everything that falls due within about two minutes, and is free.",
    "  Every email has an unsubscribe link for its recipient alone (the",
    "  List-Unsubscribe button of mail apps, and the footer): it stops that",
    "  notification's email to that person without a sign-in, and the page it opens",
    "  can resubscribe; notifications show lists who unsubscribed. A",
    "  webhook is signed with ScreenRig-Signature t=<unix>,v1=<hex HMAC-SHA256 over",
    "  \"<t>.<raw body>\">; its secret is printed only by create and rotate-secret.",
    "  Slack, Teams, PagerDuty and Telegram post one message per outage and screen and",
    "  a recovery after it; their credential is sealed, never shown again (only a",
    "  masked destination_hint), and a - value reads it from stdin. A",
    "  project has at most 20 notifications of every channel, and a new",
    "  project starts with one email to its owner for screens that go offline.",
  ].join("\n"));

  const create = notifications.command("create").description("Create an email, webhook, Slack, Teams, PagerDuty or Telegram notification for screen state changes")
    .addOption(new Option("--email <RECIPIENTS>", `Email these recipients, ${RECIPIENTS}`).argParser(recipientsOption).conflicts(otherChannels("email")))
    .addOption(new Option("--webhook <URL>", "POST signed notices to this https URL on a public Internet host, port 443 or 8443").argParser(webhookOption).conflicts(otherChannels("webhook")))
    .addOption(new Option("--slack <URL>", "Post to a Slack channel through its incoming webhook URL (https://hooks.slack.com/services/...), or - to read the URL from one line of stdin").conflicts(otherChannels("slack")))
    .addOption(new Option("--teams <URL>", "Post to a Teams channel through a Workflows webhook URL (the trigger \"When a Teams webhook request is received\"), or - to read the URL from one line of stdin").conflicts(otherChannels("teams")))
    .addOption(new Option("--pagerduty <KEY>", "Trigger and resolve PagerDuty incidents with this Events API v2 routing key (32 characters), or - to read the key from one line of stdin").conflicts(otherChannels("pagerduty")))
    .addOption(new Option("--telegram <TOKEN>", "Post to Telegram with this bot token (needs --telegram-chat), or - to read the token from one line of stdin").conflicts(otherChannels("telegram")))
    .addOption(new Option("--telegram-chat <CHAT_ID>", "With --telegram: the chat to post to, its numeric id (-1001234567890) or @channelname").argParser(chatOption))
    .option("--conditions <LIST>", `Notify on these screen state changes, comma-separated: ${CONDITIONS}`, conditionsOption)
    .option("--events <TYPES>", `Webhook only: also POST these raw project events as they happen, ${EVENTS}`, eventsOption)
    .addOption(new Option("--tag <TAG>", "Only screens carrying any of these tags (repeatable, or comma-separated; at most 16). Without a screen option, every screen").argParser(notificationTags).conflicts(["anyTag", "allTags", "audience"]))
    .addOption(new Option("--any-tag <TAG>", "Only screens carrying at least one of these tags (repeatable, or comma-separated), as a campaign any rule").argParser(notificationAnyTags).conflicts(["tag", "allTags", "audience"]))
    .addOption(new Option("--all-tags <TAG>", "Only screens carrying every one of these tags (repeatable, or comma-separated), as a campaign all rule").argParser(notificationAllTags).conflicts(["tag", "anyTag", "audience"]))
    .addOption(new Option("--audience <FILE|->", AUDIENCE_HELP).argParser(notificationAudienceOption).conflicts(["tag", "anyTag", "allTags"]))
    .addOption(new Option("--min-severity <LEVEL>", "Create no opened notice below this severity (a resolved notice follows its opened one); info, warning or error").choices([...NOTIFICATION_SEVERITIES]))
    .addOption(new Option("--severity <CONDITION=LEVEL>", SEVERITY_HELP).argParser(notificationSeverityOverride))
    .addOption(new Option("--active-hours <SPEC>", HOURS_HELP).argParser(activeHoursOption))
    .addOption(new Option("--timezone <ZONE>", "With --active-hours: the IANA timezone its windows are read in, such as America/Los_Angeles").argParser(notificationTimezone))
    .addOption(new Option("--outside-hours <WHEN>", "With --active-hours: hold (default) keeps a notice until the next window opens and sends it if its condition still holds; drop skips it").choices(["hold", "drop"]))
    .addOption(new Option("--reach-drop-screens <N>", REACH_DROP_SCREENS_HELP).argParser(notificationReachDropScreens))
    .addOption(new Option("--reach-drop-percent <P>", REACH_DROP_PERCENT_HELP).argParser(notificationReachDropPercent))
    .option("--hold <MINUTES>", "Minutes a condition must last before it notifies, 0 to 1440 (default 10); crashing is never held", notificationHold)
    .option("--description <TEXT>", "Describe the notification (at most 200 characters)", webhookDescription)
    .option("--disabled", "Create it disabled; nothing is sent until notifications update --enable")
    .action(bind(handleNotificationsCreate));
  requireOptionGroup(create, "exactlyOne", ["--email", "--webhook", "--slack", "--teams", "--pagerduty", "--telegram"]);
  requireOptionGroup(create, "atLeastOne", ["--conditions", "--events"]);
  requireOptionGroup(create, "requires", ["--email", "--conditions"]);
  requireOptionGroup(create, "requires", ["--events", "--webhook"]);
  requireOptionGroup(create, "together", ["--telegram", "--telegram-chat"]);
  requireOptionGroup(create, "requires", ["--active-hours", "--timezone"]);
  requireOptionGroup(create, "requires", ["--timezone", "--active-hours"]);
  requireOptionGroup(create, "requires", ["--outside-hours", "--active-hours"]);

  notifications.command("list").description("List this project's notifications (never their secrets)")
    .action(bind(handleNotificationsList));

  notifications.command("show").description("Inspect a notification and its delivery health")
    .argument("<id>", "Notification identifier")
    .action(bind(handleNotificationsShow));

  const update = notifications.command("update").description("Change a notification's recipients, URL, destination, conditions, screens, severity, active hours, hold, snooze or enabled state")
    .argument("<id>", "Notification identifier")
    .addOption(new Option("--email <RECIPIENTS>", `Email notifications: replace the recipients, ${RECIPIENTS}`).argParser(recipientsOption).conflicts(["url", "destination"]))
    .addOption(new Option("--url <URL>", "Webhook notifications: replace the https URL; checked like create").argParser(urlOption).conflicts(["email", "destination"]))
    .addOption(new Option("--destination <VALUE>", "Slack, Teams, PagerDuty and Telegram notifications: replace the webhook URL, routing key or bot token; checked like create. - reads it from one line of stdin").conflicts(["email", "url"]))
    .addOption(new Option("--telegram-chat <CHAT_ID>", "Telegram notifications: replace the chat").argParser(chatOption))
    .addOption(new Option("--conditions <LIST>", `Replace the conditions with these, comma-separated: ${CONDITIONS}`).argParser(conditionsOption).conflicts(["clearConditions"]))
    .addOption(new Option("--clear-conditions", "Remove every condition (a webhook then needs --events)").conflicts(["conditions"]))
    .addOption(new Option("--events <TYPES>", `Webhook notifications: replace the raw project events, ${EVENTS}`).argParser(eventsOption).conflicts(["clearEvents"]))
    .addOption(new Option("--clear-events", "Webhook notifications: stop POSTing raw project events (it then needs conditions)").conflicts(["events"]))
    .addOption(new Option("--tag <TAG>", "Replace the screens with any of these tags (repeatable, or comma-separated; at most 16); replaces an audience too").argParser(notificationTags).conflicts(["allScreens", "anyTag", "allTags", "audience"]))
    .addOption(new Option("--any-tag <TAG>", "Replace the screens with those carrying at least one of these tags (repeatable, or comma-separated), as a campaign any rule").argParser(notificationAnyTags).conflicts(["allScreens", "tag", "allTags", "audience"]))
    .addOption(new Option("--all-tags <TAG>", "Replace the screens with those carrying every one of these tags (repeatable, or comma-separated), as a campaign all rule").argParser(notificationAllTags).conflicts(["allScreens", "tag", "anyTag", "audience"]))
    .addOption(new Option("--audience <FILE|->", `Replace the screens with ${AUDIENCE_HELP.replace(/^The screens it covers, as/, "")}`).argParser(notificationAudienceOption).conflicts(["allScreens", "tag", "anyTag", "allTags"]))
    .addOption(new Option("--all-screens", "Remove the screen tags and the audience; the notification covers every screen").conflicts(["tag", "anyTag", "allTags", "audience"]))
    .addOption(new Option("--min-severity <LEVEL>", "Create no opened notice below this severity; info, warning or error").choices([...NOTIFICATION_SEVERITIES]).conflicts(["clearMinSeverity"]))
    .addOption(new Option("--clear-min-severity", "Remove the severity filter; every opened notice is created").conflicts(["minSeverity"]))
    .addOption(new Option("--severity <CONDITION=LEVEL>", `Replace every override with these. ${SEVERITY_HELP}`).argParser(notificationSeverityOverride).conflicts(["clearSeverity"]))
    .addOption(new Option("--clear-severity", "Remove every severity override; each condition has its default severity again").conflicts(["severity"]))
    .addOption(new Option("--active-hours <SPEC>", `Replace the active hours with these windows. ${HOURS_HELP.replace("; needs --timezone", "; --timezone defaults to the zone the notification has")}`).argParser(activeHoursOption).conflicts(["clearActiveHours"]))
    .addOption(new Option("--timezone <ZONE>", "The IANA timezone the active hours are read in; alone it keeps the current windows").argParser(notificationTimezone).conflicts(["clearActiveHours"]))
    .addOption(new Option("--outside-hours <WHEN>", "hold keeps a notice until the next window opens, drop skips it; alone it keeps the current windows").choices(["hold", "drop"]).conflicts(["clearActiveHours"]))
    .addOption(new Option("--clear-active-hours", "Remove the active hours; notices go out at any time").conflicts(["activeHours", "timezone", "outsideHours"]))
    .addOption(new Option("--reach-drop-screens <N>", `Replace the reach-drop threshold. ${REACH_DROP_SCREENS_HELP}`).argParser(notificationReachDropScreens).conflicts(["clearReachDrop"]))
    .addOption(new Option("--reach-drop-percent <P>", `Replace the reach-drop threshold. ${REACH_DROP_PERCENT_HELP}`).argParser(notificationReachDropPercent).conflicts(["clearReachDrop"]))
    .addOption(new Option("--clear-reach-drop", "Remove the reach-drop threshold; any drop notifies").conflicts(["reachDropScreens", "reachDropPercent"]))
    .option("--hold <MINUTES>", "Minutes a condition must last before it notifies, 0 to 1440", notificationHold)
    .addOption(new Option("--description <TEXT>", "Replace the description (at most 200 characters)").argParser(webhookDescription).conflicts(["clearDescription"]))
    .addOption(new Option("--clear-description", "Remove the description").conflicts(["description"]))
    .addOption(new Option("--enable", "Enable the notification; clears failure state and starts at the event that records the change").conflicts(["disable"]))
    .addOption(new Option("--disable", "Disable the notification; pending notices fail with webhook_disabled").conflicts(["enable"]))
    .option("--snooze <WHEN>", "Send nothing until then: a duration (30m, 1h, 4h, 2d; at most 30 days), an RFC 3339 instant with seconds and an offset, or off to end the snooze", notificationSnooze)
    .option("--expect-rev <REVISION>", "Optionally require this notification revision", revision)
    .action(bind(handleNotificationsUpdate));
  requireOptionGroup(update, "atLeastOne", [
    "--email", "--url", "--destination", "--telegram-chat", "--conditions", "--clear-conditions", "--events", "--clear-events", "--tag", "--any-tag", "--all-tags", "--audience", "--all-screens",
    "--min-severity", "--clear-min-severity", "--severity", "--clear-severity", "--active-hours", "--timezone", "--outside-hours", "--clear-active-hours", "--reach-drop-screens", "--reach-drop-percent", "--clear-reach-drop",
    "--hold", "--description", "--clear-description", "--enable", "--disable", "--snooze",
  ]);
  requireOptionGroup(update, "atMostOne", ["--email", "--url", "--destination"]);

  notifications.command("delete").description("Delete a notification; its pending notices fail")
    .argument("<id>", "Notification identifier")
    .option("--expect-rev <REVISION>", "Optionally require this notification revision", revision)
    .action(bind(handleNotificationsDelete));

  notifications.command("rotate-secret").description("Replace a webhook notification's signing secret and print the new one once")
    .argument("<id>", "Notification identifier")
    .option("--expect-rev <REVISION>", "Optionally require this notification revision", revision)
    .action(bind(handleNotificationsRotateSecret));

  notifications.command("test").description("Send one test email, signed test POST or chat message to this notification only")
    .argument("<id>", "Notification identifier")
    .action(bind(handleNotificationsTest));

  notifications.command("resubscribe").description("Email a person again who unsubscribed from a notification's email")
    .argument("<id>", "Notification identifier")
    .addOption(new Option("--user <USER_ID>", "The person's user id, as notifications show lists it under unsubscribed").argParser(notificationUserId).makeOptionMandatory())
    .action(bind(handleNotificationsResubscribe));

  notifications.command("deliveries").description("Read a notification's delivery log, newest first")
    .argument("<id>", "Notification identifier")
    .option("--before <CURSOR>", "Continue from the next_cursor of the previous page", cursorOption)
    .option("--limit <N>", "Rows per page, 1 to 200 (server default 50)", webhookDeliveriesLimit)
    .action(bind(handleNotificationsDeliveries));
}
