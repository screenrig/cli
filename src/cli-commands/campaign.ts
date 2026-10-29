import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import {
  handleCampaignCreate, handleCampaignDelete, handleCampaignExplain, handleCampaignList, handleCampaignPause, handleCampaignResume,
  handleCampaignScreens, handleCampaignShow, handleCampaignUpdate,
} from "../commands.js";
import {
  campaignAnyTags, campaignAudienceOption, campaignExplainTime, campaignFolder, campaignInstant, campaignName, campaignPlaylistId, campaignPriority, campaignScreenIds,
  campaignScreensCursor, campaignScreensLimit, campaignTags, campaignWindows,
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

const AUDIENCE_FLAGS = ["--tag", "--any-tag", "--screen-id", "--folder", "--all-screens", "--audience"];

export function registerCampaignCommands(root: Command, bind: CommandActionBinder): void {
  const campaign = root.command("campaign").description("Schedule your screens; ads campaigns buy ad time on other screens");
  addCommandNotes(campaign, "Campaigns:\n  A campaign switches every screen in its audience to one playlist while its\n  from and until dates and weekly windows hold, and back when they stop; with\n  none of them it holds always. It schedules your own screens: ads campaigns\n  buy ad time on other screens and are a different resource. The audience is a\n  rule over screen tags, ids or screen folders. from, until and windows are civil times read in\n  each screen's own timezone. Per screen, a takeover wins, then the first\n  campaign that holds (priority 0 to 100, higher first, then the newest), then\n  the screen's playlist schedule, then its default playlist. Screens switch\n  within a minute. campaign screens shows each screen's standing and campaign\n  explain says why a campaign plays on a screen or not. A project has at most\n  100 campaigns.");

  campaign.command("list").description("List this project's campaigns in the order screens read them")
    .action(bind(handleCampaignList));

  campaign.command("show").description("Inspect a campaign")
    .argument("<id>", "Campaign identifier")
    .action(bind(handleCampaignShow));

  const create = campaign.command("create").description("Switch the screens of an audience to a playlist, always or while dates and weekly windows hold")
    .requiredOption("--name <NAME>", "Name the campaign, 1 to 120 characters (required)", nameOption)
    .requiredOption("--playlist-id <ID>", "Playlist the audience shows while the campaign holds; it must be approved (required)", campaignPlaylistId);
  audienceOptions(create, "Audience");
  create
    .addOption(new Option("--from <TIME>", "Start at this civil time in each screen's timezone, YYYY-MM-DDTHH:MM (default: no start)").argParser(campaignInstant("--from")))
    .addOption(new Option("--until <TIME>", "End before this civil time in each screen's timezone, YYYY-MM-DDTHH:MM, later than --from (default: no end)").argParser(campaignInstant("--until")))
    .addOption(new Option("--window <SPEC>", "Hold only in this weekly window, DAYS or DAYS@HH:MM-HH:MM, such as mon-fri@09:00-17:00 or sat,sun (repeatable, at most 16)").argParser(campaignWindows))
    .option("--priority <N>", "Priority 0 to 100; the higher wins when two campaigns hold on one screen (default: 0)", campaignPriority)
    .option("--paused", "Create it paused: no screen changes until campaign resume")
    .action(bind(handleCampaignCreate));
  requireOptionGroup(create, "exactlyOne", AUDIENCE_FLAGS);

  const update = campaign.command("update").description("Change a campaign; the screens of its old and new audience re-resolve within a minute")
    .argument("<id>", "Campaign identifier")
    .option("--name <NAME>", "Rename the campaign, 1 to 120 characters", nameOption)
    .option("--playlist-id <ID>", "Show this playlist instead; it must be approved", campaignPlaylistId);
  audienceOptions(update, "Replace the audience");
  update
    .addOption(new Option("--from <TIME>", "Start at this civil time in each screen's timezone, YYYY-MM-DDTHH:MM").argParser(campaignInstant("--from")).conflicts(["clearFrom"]))
    .addOption(new Option("--clear-from", "Remove the start").conflicts(["from"]))
    .addOption(new Option("--until <TIME>", "End before this civil time in each screen's timezone, YYYY-MM-DDTHH:MM, later than from").argParser(campaignInstant("--until")).conflicts(["clearUntil"]))
    .addOption(new Option("--clear-until", "Remove the end").conflicts(["until"]))
    .addOption(new Option("--window <SPEC>", "Replace every window with this one, DAYS or DAYS@HH:MM-HH:MM, such as mon-fri@09:00-17:00 or sat,sun (repeatable, at most 16)").argParser(campaignWindows).conflicts(["clearWindows"]))
    .addOption(new Option("--clear-windows", "Remove every window").conflicts(["window"]))
    .option("--priority <N>", "Priority 0 to 100; the higher wins when two campaigns hold on one screen", campaignPriority)
    .option("--expect-rev <REVISION>", "Optionally require this campaign revision", revision)
    .action(bind(handleCampaignUpdate));
  requireOptionGroup(update, "atLeastOne", ["--name", "--playlist-id", ...AUDIENCE_FLAGS, "--from", "--clear-from", "--until", "--clear-until", "--window", "--clear-windows", "--priority"]);
  requireOptionGroup(update, "atMostOne", AUDIENCE_FLAGS);

  campaign.command("pause").description("Stop a campaign on every screen without deleting it")
    .argument("<id>", "Campaign identifier")
    .option("--expect-rev <REVISION>", "Optionally require this campaign revision", revision)
    .action(bind(handleCampaignPause));

  campaign.command("resume").description("Start a paused campaign again")
    .argument("<id>", "Campaign identifier")
    .option("--expect-rev <REVISION>", "Optionally require this campaign revision", revision)
    .action(bind(handleCampaignResume));

  campaign.command("delete").description("Delete a campaign; its screens return to what they would show without it")
    .argument("<id>", "Campaign identifier")
    .option("--expect-rev <REVISION>", "Optionally require this campaign revision", revision)
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
