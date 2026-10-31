import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { NOTE_HELP, positiveInteger, reviewNoteOption, revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleCampaignCreate, handleCampaignDelete, handleCampaignExplain, handleCampaignList, handleCampaignPause, handleCampaignPreview, handleCampaignPromote, handleCampaignPublish, handleCampaignResume, handleCampaignRestore, handleCampaignRevisions, handleCampaignScreens, handleCampaignShow, handleCampaignUpdate } from "../handlers/campaign.js";
import { calendarInstantOption } from "../change-control.js";
import {
  campaignAnyTags, campaignAudienceOption, campaignDataOption, campaignDates, campaignDisplays, campaignExceptDates, campaignExplainTime, campaignFolder, campaignInstant, campaignMonthlies, campaignName,
  campaignOnTouch, campaignPlaylistId, campaignPriority, campaignScreenIds, campaignScreensCursor, campaignScreensLimit, campaignTags, campaignWindows,
} from "../campaigns.js";

const nameOption = (value: string): string => { campaignName(value); return value; };

/** The audience options, each conflicting with the others; `verb` words the help for create or update. */
function audienceOptions(command: Command, verb: "Audience" | "Replace the audience"): void {
  const others = (own: string) => ["tag", "anyTag", "screenId", "folder", "allScreens", "audience"].filter((name) => name !== own);
  command
    .addOption(new Option("--tag <TAG>", `${verb}: screens that carry this tag; repeat or comma-separate to require every listed tag`).argParser(campaignTags).conflicts(others("tag")))
    .addOption(new Option("--any-tag <TAG>", `${verb}: screens that carry at least one of these tags (repeatable, or comma-separated)`).argParser(campaignAnyTags).conflicts(others("anyTag")))
    .addOption(new Option("--screen-id <ID>", `${verb}: these screens (repeatable, or comma-separated)`).argParser(campaignScreenIds).conflicts(others("screenId")))
    .addOption(new Option("--folder <ID>", `${verb}: the screens in this screen folder (sfd_...) and every folder inside it`).argParser(campaignFolder).conflicts(others("folder")))
    .addOption(new Option("--all-screens", `${verb}: every screen in the project`).conflicts(others("allScreens")))
    .addOption(new Option("--audience <RULE>", `${verb}: a rule as JSON such as {"all":[{"tag":"North"},{"tag":"Cafe"}]}, @FILE to read it from a file, or - for stdin`).argParser(campaignAudienceOption).conflicts(others("audience")));
}

const MONTHLY_HELP = "DAY or NTH-WEEKDAY with an optional @HH:MM-HH:MM, such as 15, 1st-mon, 3rd-wed@18:00-21:00 or last-sun@09:00-14:00 (repeatable, at most 16)";
const DATE_HELP = "YYYY-MM-DD with an optional @HH:MM-HH:MM, such as 2026-12-24 or 2026-12-24@18:00-22:00 (repeatable, at most 100)";
const EXCEPT_HELP = "YYYY-MM-DD dates; an exception removes every occurrence that starts on that date (repeatable, or comma-separated, at most 100)";
const ON_TOUCH_HELP = "Hold only while someone is using the screen, until IDLE_S seconds (5 to 3600, default 60) pass without input; Players that resolve their own stack honor it";
const DATA_HELP = "Hold only while card data KEY exists, optionally at an RFC 6901 PATH or equal to VALUE (JSON scalar or bare string); missing or expired data never matches";
const DISPLAYS_HELP = "Play only on these video wall outputs, 1 to 12, comma-separated (default: every output)";
const COVERS_HELP = "Where it plays: full (the whole page, default), main (the page itself), or header, footer or side, a strip drawn over the page that needs a playlist made for that region (playlist create --format-region)";
const COVERS = ["full", "main", "header", "footer", "side"];
const START_HELP = "on-time switches at the edge, interrupting the current item; next-item waits for it to end (default)";

/** The flags that change a campaign's rules and placement, shared by campaign update and campaign preview. */
function changeOptions(command: Command): void {
  command
    .addOption(new Option("--from <TIME>", "Start at this civil time in each screen's timezone, YYYY-MM-DDTHH:MM").argParser(campaignInstant("--from")).conflicts(["clearFrom"]))
    .addOption(new Option("--clear-from", "Remove the start").conflicts(["from"]))
    .addOption(new Option("--until <TIME>", "End before this civil time in each screen's timezone, YYYY-MM-DDTHH:MM, later than from").argParser(campaignInstant("--until")).conflicts(["clearUntil"]))
    .addOption(new Option("--clear-until", "Remove the end").conflicts(["until"]))
    .addOption(new Option("--window <SPEC>", "Replace every window with this one, DAYS or DAYS@HH:MM-HH:MM, such as mon-fri@09:00-17:00 or sat,sun (repeatable, at most 16)").argParser(campaignWindows).conflicts(["clearWindows"]))
    .addOption(new Option("--clear-windows", "Remove every window").conflicts(["window"]))
    .addOption(new Option("--monthly <SPEC>", `Replace every monthly rule with this one, ${MONTHLY_HELP}`).argParser(campaignMonthlies).conflicts(["clearMonthly"]))
    .addOption(new Option("--clear-monthly", "Remove every monthly rule").conflicts(["monthly"]))
    .addOption(new Option("--date <SPEC>", `Replace every date with this one, ${DATE_HELP}`).argParser(campaignDates).conflicts(["clearDates"]))
    .addOption(new Option("--clear-dates", "Remove every date").conflicts(["date"]))
    .addOption(new Option("--except <DATE>", `Replace every exception date with these, ${EXCEPT_HELP}`).argParser(campaignExceptDates).conflicts(["clearExcept"]))
    .addOption(new Option("--clear-except", "Remove every exception date").conflicts(["except"]))
    .addOption(new Option("--data <KEY[:PATH[=VALUE]]>", DATA_HELP).argParser(campaignDataOption).conflicts(["clearData"]))
    .addOption(new Option("--clear-data", "Remove the card-data condition").conflicts(["data"]))
    .addOption(new Option("--on-touch [IDLE_S]", ON_TOUCH_HELP).argParser(campaignOnTouch).conflicts(["clearOnTouch"]))
    .addOption(new Option("--clear-on-touch", "Remove the interaction condition").conflicts(["onTouch"]))
    .addOption(new Option("--covers <WHERE>", COVERS_HELP).choices(COVERS))
    .addOption(new Option("--displays <N>", DISPLAYS_HELP).argParser(campaignDisplays).conflicts(["clearDisplays"]))
    .addOption(new Option("--clear-displays", "Play on every output again").conflicts(["displays"]))
    .addOption(new Option("--start <WHEN>", START_HELP).choices(["on-time", "next-item"]))
    .option("--priority <N>", "Priority 0 to 100; the higher wins when two campaigns hold on one screen", campaignPriority);
}

const AUDIENCE_FLAGS = ["--tag", "--any-tag", "--screen-id", "--folder", "--all-screens", "--audience"];

export function registerCampaignCommands(root: Command, bind: CommandActionBinder): void {
  const campaign = root.command("campaign").description("Schedule your screens; ads campaigns buy ad time on other screens");
  addCommandNotes(campaign, "Campaigns:\n  A campaign switches every screen in its audience to one playlist while its\n  from and until dates, weekly windows, monthly rules, dates, exceptions, data and\n  touch conditions hold, and back when they stop; with none of them it holds\n  always. It schedules your own screens: ads campaigns\n  buy ad time on other screens and are a different resource. The audience is a\n  rule over screen tags, ids or screen folders. from, until, windows, monthly rules, dates and exceptions are\n  civil times read in each screen's own timezone. Per screen, a takeover wins, then the first\n  campaign that holds (priority 0 to 100, higher first, then the newest), then\n  the screen's playlist schedule, then its default playlist. Screens switch\n  within a minute. campaign screens shows each screen's standing and campaign\n  explain says why a campaign plays on a screen or not. A project has at most\n  100 campaigns. A paused campaign is a draft: it is on no screen until\n  campaign publish; publish it to a test folder or test screens first, then\n  campaign promote puts the draft's audience on it. campaign preview shows a\n  change before it is made; campaign revisions and campaign restore keep and\n  bring back earlier versions.");

  campaign.command("list").description("List this project's campaigns in the order screens read them")
    .action(bind(handleCampaignList));

  campaign.command("show").description("Inspect a campaign")
    .argument("<id>", "Campaign identifier")
    .action(bind(handleCampaignShow));

  const create = campaign.command("create").description("Switch the screens of an audience to a playlist, always or while its dates, weekly, monthly and other rules hold")
    .requiredOption("--name <NAME>", "Name the campaign, 1 to 120 characters (required)", nameOption)
    .requiredOption("--playlist-id <ID>", "Playlist the audience shows while the campaign holds; it must be approved (required)", campaignPlaylistId);
  audienceOptions(create, "Audience");
  create
    .addOption(new Option("--from <TIME>", "Start at this civil time in each screen's timezone, YYYY-MM-DDTHH:MM (default: no start)").argParser(campaignInstant("--from")))
    .addOption(new Option("--until <TIME>", "End before this civil time in each screen's timezone, YYYY-MM-DDTHH:MM, later than --from (default: no end)").argParser(campaignInstant("--until")))
    .addOption(new Option("--window <SPEC>", "Hold only in this weekly window, DAYS or DAYS@HH:MM-HH:MM, such as mon-fri@09:00-17:00 or sat,sun (repeatable, at most 16)").argParser(campaignWindows))
    .addOption(new Option("--monthly <SPEC>", `Hold only on this monthly occurrence, ${MONTHLY_HELP}`).argParser(campaignMonthlies))
    .addOption(new Option("--date <SPEC>", `Hold only on this date, ${DATE_HELP}`).argParser(campaignDates))
    .addOption(new Option("--except <DATE>", `Skip these dates, ${EXCEPT_HELP}`).argParser(campaignExceptDates))
    .addOption(new Option("--data <KEY[:PATH[=VALUE]]>", DATA_HELP).argParser(campaignDataOption))
    .addOption(new Option("--on-touch [IDLE_S]", ON_TOUCH_HELP).argParser(campaignOnTouch))
    .addOption(new Option("--covers <WHERE>", COVERS_HELP).choices(COVERS))
    .addOption(new Option("--displays <N>", DISPLAYS_HELP).argParser(campaignDisplays))
    .addOption(new Option("--start <WHEN>", START_HELP).choices(["on-time", "next-item"]))
    .option("--priority <N>", "Priority 0 to 100; the higher wins when two campaigns hold on one screen (default: 0)", campaignPriority)
    .option("--paused", "Create it paused: no screen changes until campaign resume")
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handleCampaignCreate));
  requireOptionGroup(create, "exactlyOne", AUDIENCE_FLAGS);

  const update = campaign.command("update").description("Change a campaign; the screens of its old and new audience re-resolve within a minute")
    .argument("<id>", "Campaign identifier")
    .option("--name <NAME>", "Rename the campaign, 1 to 120 characters", nameOption)
    .option("--playlist-id <ID>", "Show this playlist instead; it must be approved", campaignPlaylistId);
  audienceOptions(update, "Replace the audience");
  changeOptions(update);
  update
    .option("--expect-rev <REVISION>", "Optionally require this campaign revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handleCampaignUpdate));
  requireOptionGroup(update, "atLeastOne", ["--name", "--playlist-id", ...AUDIENCE_FLAGS, "--from", "--clear-from", "--until", "--clear-until", "--window", "--clear-windows", "--monthly", "--clear-monthly", "--date", "--clear-dates", "--except", "--clear-except", "--data", "--clear-data", "--on-touch", "--clear-on-touch", "--covers", "--displays", "--clear-displays", "--start", "--priority"]);
  requireOptionGroup(update, "atMostOne", AUDIENCE_FLAGS);

  const preview = campaign.command("preview").description("Show what creating or changing a campaign would do before making it: the screens that gain or lose it and the calendar before and after")
    .argument("[id]", "Campaign to preview a change to; omit to preview a new campaign from the create flags")
    .option("--name <NAME>", "The new name (required for a new campaign), 1 to 120 characters", nameOption)
    .option("--playlist-id <ID>", "The playlist to show (required for a new campaign); it must be approved", campaignPlaylistId);
  audienceOptions(preview, "Audience");
  changeOptions(preview);
  preview
    .addOption(new Option("--paused", "Preview it as a draft: paused, on no screen").conflicts(["publish"]))
    .addOption(new Option("--publish", "Preview unpausing the campaign (with an audience flag, publishing it to that audience)").conflicts(["paused"]))
    .addOption(new Option("--calendar-from <INSTANT>", "Start the calendars at this instant with a zone, such as 2026-12-01T00:00:00Z (default: now)").argParser(calendarInstantOption("--calendar-from")))
    .addOption(new Option("--calendar-to <INSTANT>", "End the calendars at this instant with a zone, at most 93 days after the start (default: a week after it)").argParser(calendarInstantOption("--calendar-to")))
    .action(bind(handleCampaignPreview));
  requireOptionGroup(preview, "atMostOne", AUDIENCE_FLAGS);

  campaign.command("publish").description("Unpause a draft campaign, optionally only to a test folder or a few test screens")
    .argument("<id>", "Campaign identifier")
    .addOption(new Option("--test-folder <ID>", "Publish only to the screens in this screen folder (sfd_...) and every folder inside it, instead of the campaign's audience").argParser(campaignFolder).conflicts(["testScreen"]))
    .addOption(new Option("--test-screen <ID>", "Publish only to these screens (repeatable, or comma-separated), instead of the campaign's audience").argParser(campaignScreenIds).conflicts(["testFolder"]))
    .option("--expect-rev <REVISION>", "Optionally require this campaign revision", revision)
    .action(bind(handleCampaignPublish));

  campaign.command("promote").description("Put a draft's audience on the campaign after its test: the audience of an earlier paused revision becomes the campaign's")
    .argument("<id>", "Campaign identifier")
    .requiredOption("--revision <N>", "The draft's (paused) revision whose audience the campaign takes, as campaign revisions numbers it (required)", positiveInteger("revision"))
    .option("--expect-rev <REVISION>", "Require this current campaign revision (default: the revision read just before the write)", revision)
    .action(bind(handleCampaignPromote));

  campaign.command("revisions").description("List a campaign's revisions, newest first, one page at a time")
    .argument("<id>", "Campaign identifier")
    .option("--after <CURSOR>", "Continue from the data.next_cursor of the previous page")
    .action(bind(handleCampaignRevisions));

  campaign.command("restore").description("Make an earlier revision current again by copying it forward as a new revision")
    .argument("<id>", "Campaign identifier")
    .requiredOption("--revision <N>", "Revision to copy forward, as campaign revisions numbers it (required)", positiveInteger("revision"))
    .option("--expect-rev <REVISION>", "Require this current campaign revision (default: the revision read just before the write)", revision)
    .action(bind(handleCampaignRestore));

  campaign.command("pause").description("Stop a campaign on every screen without deleting it")
    .argument("<id>", "Campaign identifier")
    .option("--expect-rev <REVISION>", "Optionally require this campaign revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handleCampaignPause));

  campaign.command("resume").description("Start a paused campaign again")
    .argument("<id>", "Campaign identifier")
    .option("--expect-rev <REVISION>", "Optionally require this campaign revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handleCampaignResume));

  campaign.command("delete").description("Delete a campaign; its screens return to what they would show without it")
    .argument("<id>", "Campaign identifier")
    .option("--expect-rev <REVISION>", "Optionally require this campaign revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handleCampaignDelete));

  campaign.command("screens").description("Show the screens a campaign reaches and how each stands")
    .argument("<id>", "Campaign identifier")
    .option("--limit <N>", "Screens per page, 1 to 500 (default: 100)", campaignScreensLimit)
    .option("--cursor <CURSOR>", "Continue after the data.next_cursor of the previous page", campaignScreensCursor)
    .action(bind(handleCampaignScreens));

  campaign.command("explain").description("Show why each campaign plays on one screen or not, now or at a chosen time")
    .argument("<screen-id>", "Screen identifier")
    .addOption(new Option("--at <TIME>", "Explain this time instead of now: an instant with a zone (2026-03-08T09:30:00Z) or a time on the screen's clock (2026-03-08T09:30)").argParser(campaignExplainTime("--at")))
    .addOption(new Option("--to <TIME>", "Also list the playlist switches from --at (default: now) to this time, in the same forms").argParser(campaignExplainTime("--to")))
    .action(bind(handleCampaignExplain));
}
