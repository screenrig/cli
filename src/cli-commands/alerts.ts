import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import type { CommandActionBinder } from "./types.js";
import {
  handleAlertsAck, handleAlertsList, handleAlertsMute, handleAlertsMutes, handleAlertsShow, handleAlertsSnooze, handleAlertsUnmute,
} from "../commands.js";
import {
  ALERT_STATES, alertForOption, alertMuteScreenIds, alertMuteTags, alertNote, alertScreenId, alertUntilOption, alertsCursor, alertsLimit,
} from "../alerts.js";

export function registerAlertsCommands(root: Command, bind: CommandActionBinder): void {
  const alerts = root.command("alerts").description("Triage open screen alerts: acknowledge, snooze or mute them");
  addCommandNotes(alerts, [
    "Alerts:",
    "  An alert is one screen and one condition while it lasts: it opens when the",
    "  condition begins (screen_offline, display_disconnected, running_hot,",
    "  storage_full, content_stuck, not_playing or loop_stalled) and resolves when it clears. A",
    "  screen has at most one open alert per condition; crashing is a notice, never",
    "  an alert. Resolved alerts stay for the plan's event retention. attention is",
    "  true for an open alert that is not acknowledged, snoozed or muted, the count",
    "  the dashboard shows. ack marks an open alert as handled until it resolves;",
    "  snooze does so until a time at most 30 days ahead, when it needs attention",
    "  again if it is still open. mute covers screens by id or tag until a time at",
    "  most 30 days ahead, for maintenance: their alerts still open and resolve,",
    "  marked muted, and never need attention. A notification (screenrig",
    "  notifications) skips a notice whose alert is acknowledged or snoozed while",
    "  the notice is in its hold, and every notice about a muted screen. A project",
    "  has at most 50 current mutes.",
  ].join("\n"));

  alerts.command("list").description("List this project's screen alerts, open first, with the counts the dashboard shows")
    .addOption(new Option("--state <STATE>", "Which alerts: open, resolved (kept for the plan's event retention) or all").choices(ALERT_STATES).default("open"))
    .option("--screen-id <ID>", "Only this screen's alerts", alertScreenId)
    .option("--before <CURSOR>", "Continue from the data.next_cursor of the previous page", alertsCursor)
    .option("--limit <N>", "Alerts per page, 1 to 200 (server default 100)", alertsLimit)
    .action(bind(handleAlertsList));

  alerts.command("show").description("Inspect one alert")
    .argument("<id>", "Alert identifier")
    .action(bind(handleAlertsShow));

  alerts.command("ack").description("Acknowledge an open alert until it resolves")
    .argument("<id>", "Alert identifier")
    .action(bind(handleAlertsAck));

  const snooze = alerts.command("snooze").description("Acknowledge an open alert until a time, when it needs attention again if still open")
    .argument("<id>", "Alert identifier")
    .addOption(new Option("--for <DURATION>", "Snooze this long from now, such as 30m, 4h or 2d (at most 29d23h59m)").argParser(alertForOption).conflicts(["until"]))
    .addOption(new Option("--until <TIME>", "Snooze until this RFC 3339 instant, with seconds and an offset (at most 30 days ahead)").argParser(alertUntilOption).conflicts(["for"]))
    .action(bind(handleAlertsSnooze));
  requireOptionGroup(snooze, "exactlyOne", ["--for", "--until"]);

  const mute = alerts.command("mute").description("Mute screens by id or tag for maintenance until a time")
    .option("--screen-id <ID>", "Mute this screen (repeatable, or comma-separated; at most 100)", alertMuteScreenIds)
    .option("--tag <TAG>", "Mute every screen carrying this tag when a notice falls due (repeatable, or comma-separated; at most 16)", alertMuteTags)
    .addOption(new Option("--for <DURATION>", "Mute this long from now, such as 4h, 2d or 7d (at most 29d23h59m)").argParser(alertForOption).conflicts(["until"]))
    .addOption(new Option("--until <TIME>", "Mute until this RFC 3339 instant, with seconds and an offset (at most 30 days ahead)").argParser(alertUntilOption).conflicts(["for"]))
    .option("--note <TEXT>", "Say why, for the people who see the mute (at most 200 characters)", alertNote)
    .action(bind(handleAlertsMute));
  requireOptionGroup(mute, "atLeastOne", ["--screen-id", "--tag"]);
  requireOptionGroup(mute, "exactlyOne", ["--for", "--until"]);

  alerts.command("mutes").description("List the current mutes, soonest end first")
    .action(bind(handleAlertsMutes));

  alerts.command("unmute").description("End a mute now")
    .argument("<mute-id>", "Mute identifier")
    .action(bind(handleAlertsUnmute));
}
