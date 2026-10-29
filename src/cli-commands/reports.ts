import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { reportFormatOption, reportOutputOption, revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import {
  handleReportSubscriptionsCreate, handleReportSubscriptionsDelete, handleReportSubscriptionsList, handleReportSubscriptionsSend,
  handleReportSubscriptionsShow, handleReportSubscriptionsUpdate, handleReportsList, handleReportsShow,
} from "../commands.js";
import { REPORT_CADENCES, REPORT_GROUPINGS, REPORT_SUBSCRIPTION_FORMATS, REPORT_WEEKDAYS, reportDay, reportFilter } from "../reports.js";

const scheduleOptions = (command: Command, cadenceRequired: boolean): Command => command
  .addOption(cadenceRequired
    ? new Option("--cadence <CADENCE>", "daily, weekly or monthly").choices(REPORT_CADENCES).makeOptionMandatory()
    : new Option("--cadence <CADENCE>", "daily, weekly or monthly").choices(REPORT_CADENCES))
  .addOption(new Option("--weekday <DAY>", "Weekly runs: monday (default) to sunday").choices(REPORT_WEEKDAYS))
  .option("--day-of-month <N>", "Monthly runs: the day, 1 to 28 (default 1)", (value) => {
    if (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 28) throw new Error("--day-of-month must be 1 to 28.");
    return value;
  })
  .option("--hour <N>", "Hour of the day in the time zone, 0 to 23 (default 0)", (value) => {
    if (!/^\d{1,2}$/.test(value) || Number(value) > 23) throw new Error("--hour must be 0 to 23.");
    return value;
  })
  .option("--timezone <ZONE>", "IANA time zone such as America/Los_Angeles (default UTC)");

export function registerReportsCommands(root: Command, bind: CommandActionBinder): void {
  const reports = root.command("reports").description("Build reports from the project's aggregates, write them as CSV, XLSX or PDF, and email them on a schedule");
  addCommandNotes(reports, [
    "Reports:",
    "  fleet_health, uptime, publishing and alerts roll the fleet up by folder",
    "  (every folder includes the folders inside it; the first row is the whole",
    "  project), by screen or by tag: availability and recorded coverage, alerts",
    "  open now and begun in the period by condition, hot, display-disconnected and",
    "  crashing screens, and content status (current, updating, needs attention).",
    "  alert_log lists every alert begun in the period. proof_of_play totals the",
    "  plays of the project's direct campaigns per campaign, media and screen for a",
    "  sponsor or advertiser, as a statement ready to send. Days are UTC days. Reports",
    "  read aggregates, never raw events. reports show --format csv, xlsx or pdf",
    "  writes a file; the report, alert, uptime, health, play and ad report",
    "  commands write the same formats. reports subscriptions email a report to",
    "  project members daily, weekly or monthly; recipients are members only.",
  ].join("\n"));

  reports.command("list").description("List the report kinds and the filters each takes").action(bind(handleReportsList));

  reports.command("show").description("Build one report, as rows or as a CSV, XLSX or PDF file")
    .argument("<kind>", "fleet_health, uptime, publishing, alerts, alert_log or proof_of_play")
    .option("--from <YYYY-MM-DD>", "First UTC day, inclusive (default 29 days before --to)", reportDay("--from"))
    .option("--to <YYYY-MM-DD>", "Last UTC day, inclusive (default today); at most 366 days after --from", reportDay("--to"))
    .addOption(new Option("--group-by <GROUPING>", "What a row is: folder (default), screen or tag").choices(REPORT_GROUPINGS))
    .option("--folder-id <ID>", "Only this screen folder and everything inside it")
    .option("--direct", "With --folder-id: only the screens directly in the folder (--group-by screen), or the folder and its child folders")
    .option("--tag <TAG>", "Only screens carrying this tag")
    .option("--campaign-id <ID>", "proof_of_play: one direct campaign")
    .option("--advertiser <NAME>", "proof_of_play: the campaigns of this advertiser or sponsor (exact name, any case)")
    .addOption(reportFormatOption())
    .addOption(reportOutputOption("KIND-DAY.FORMAT"))
    .action(bind(handleReportsShow));

  const subscriptions = reports.command("subscriptions").description("Email a report to project members on a schedule");
  addCommandNotes(subscriptions, [
    "Report subscriptions:",
    "  A subscription mails one report as a PDF, XLSX or CSV attachment, daily,",
    "  weekly (--weekday) or monthly (--day-of-month, 1 to 28), at --hour in",
    "  --timezone. Each run covers the period before it in UTC days: yesterday,",
    "  the seven days before, or last month. Recipients are members of the project,",
    "  named by user id or by the email address of the member; anyone else is",
    "  refused, and a member who leaves stops receiving it. A failed run is retried",
    "  and shows in the subscription as last_status failed with last_error. A project",
    "  has at most 50 subscriptions. Reading needs the project capability.",
  ].join("\n"));

  subscriptions.command("list").description("List this project's report subscriptions").action(bind(handleReportSubscriptionsList));
  subscriptions.command("show").description("Inspect a report subscription and its last run")
    .argument("<id>", "Report subscription identifier").action(bind(handleReportSubscriptionsShow));

  const create = subscriptions.command("create").description("Schedule a report email to project members")
    .requiredOption("--name <NAME>", "Name, at most 100 characters")
    .addOption(new Option("--kind <KIND>", "fleet_health, uptime, publishing, alerts, alert_log or proof_of_play").makeOptionMandatory())
    .addOption(new Option("--format <FORMAT>", "Attachment: pdf, xlsx or csv").choices(REPORT_SUBSCRIPTION_FORMATS).makeOptionMandatory())
    .requiredOption("--recipients <MEMBERS>", "Project members, comma-separated: a user id or a member's email address (at most 25)")
    .option("--filter <NAME=VALUE>", "A report filter such as group_by=screen, folder_id=sfd_ID, tag=Lobby, advertiser=Acme (repeatable)", reportFilter);
  scheduleOptions(create, true);
  create.action(bind(handleReportSubscriptionsCreate));

  const update = subscriptions.command("update").description("Change a report subscription; the report kind never changes")
    .argument("<id>", "Report subscription identifier")
    .option("--name <NAME>", "Name, at most 100 characters")
    .addOption(new Option("--format <FORMAT>", "Attachment: pdf, xlsx or csv").choices(REPORT_SUBSCRIPTION_FORMATS))
    .option("--recipients <MEMBERS>", "Replace the recipients: user ids or members' email addresses, comma-separated")
    .option("--filter <NAME=VALUE>", "Replace the filters with these (repeatable)", reportFilter)
    .option("--pause", "Send nothing until resumed")
    .option("--resume", "Send again from the next occurrence")
    .option("--expect-rev <REVISION>", "Fail unless the subscription is at this revision", revision);
  scheduleOptions(update, false);
  update.action(bind(handleReportSubscriptionsUpdate));
  requireOptionGroup(update, "atMostOne", ["--pause", "--resume"]);

  subscriptions.command("delete").description("Delete a report subscription")
    .argument("<id>", "Report subscription identifier").action(bind(handleReportSubscriptionsDelete));
  subscriptions.command("send").description("Email a report now to its recipients, without moving its schedule")
    .argument("<id>", "Report subscription identifier").action(bind(handleReportSubscriptionsSend));
}
