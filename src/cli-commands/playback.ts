import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { positiveInteger, reportFormatOption, reportOutputOption } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handlePlaybackCompleteness, handlePlaybackList, handlePlaybackPlays, handlePlaybackTotals } from "../commands.js";
import { playsCursor, playsInstantOption, playsLimit } from "../playback-export.js";

const formatOption = () => new Option("--format <FORMAT>", "json (default), csv, xlsx or pdf").choices(["json", "csv", "xlsx", "pdf"]);
const outputOption = () => new Option("--output <FILE>", "File to write (with --format csv, xlsx or pdf); - writes a CSV to stdout instead of the envelope");

export function registerPlaybackCommands(root: Command, bind: CommandActionBinder): void {
  const playback = root.command("playback").description("Inspect playback records");
  addCommandNotes(playback, "Billing and limits:\n  Each JSON page and each CSV stream is one billed API request. playback plays\n  --all bills one request per page it follows. Every plays request and every\n  CSV export also spends the playback export budget (30 per minute per project);\n  past it the answer is rate_limited (exit 7) with retry_after_seconds.");

  playback.command("list").description("List daily playback aggregates, or export them as CSV")
    .option("--screen-id <ID>", "Filter playback by screen")
    .option("--media-id <ID>", "Filter playback by media")
    .option("--day <YYYY-MM-DD>", "Filter playback by UTC day")
    .option("--day-from <YYYY-MM-DD>", "First UTC day, inclusive (not with --day); CSV defaults to 30 days before --day-to")
    .option("--day-to <YYYY-MM-DD>", "Last UTC day, inclusive (not with --day); CSV defaults to today; at most 366 days")
    .addOption(formatOption())
    .addOption(outputOption())
    .action(bind(handlePlaybackList));

  playback.command("plays").description("List per-play records (one row per visible start), or export them as CSV")
    .option("--from <TIME>", "Inclusive start of received_at: RFC 3339, now, or an age such as 7d, 12h, 30m (default 24h before --to)", playsInstantOption("--from"))
    .option("--to <TIME>", "Exclusive end of received_at: RFC 3339, now, or an age (default now); at most 31 days after --from", playsInstantOption("--to"))
    .option("--screen-id <ID>", "Only plays on this screen")
    .option("--media-id <ID>", "Only plays of this media")
    .option("--tag <TAG>", "Only plays on screens that carried this tag when the play was received")
    .option("--cursor <CURSOR>", "Continue from data.next_cursor of the previous page (same filters)", playsCursor)
    .option("--limit <N>", "JSON rows per page, 1 to 1000 (server default 200)", playsLimit)
    .option("--all", "Follow next_cursor to the end of the range (at most 50 pages, one billed request each)")
    .addOption(formatOption())
    .addOption(outputOption())
    .action(bind(handlePlaybackPlays));

  const totals = playback.command("totals").description("Total plays per UTC day, or rank the busiest screens or media")
    .addOption(new Option("--by <GROUPING>", "day (default) one row per day; screen or media ranks the busiest; screen_day the day series of the top screens").choices(["day", "screen", "media", "screen_day"]))
    .option("--day-from <YYYY-MM-DD>", "First UTC day, inclusive (default 29 days before --day-to); at most 366 days, 92 with --screen-id, --media-id or a ranking")
    .option("--day-to <YYYY-MM-DD>", "Last UTC day, inclusive (default today)")
    .option("--screen-id <ID>", "With --by day: only this screen")
    .option("--media-id <ID>", "With --by day: only this media")
    .option("--top <N>", "Rows of a ranking, 1 to 100 (1 to 10 with --by screen_day; default 10)", positiveInteger("top"))
    .addOption(reportFormatOption())
    .addOption(reportOutputOption("play-totals.FORMAT"))
    .action(bind(handlePlaybackTotals));
  requireOptionGroup(totals, "atMostOne", ["--screen-id", "--media-id"]);
  requireOptionGroup(totals, "requires", ["--top", "--by"]);

  playback.command("completeness").description("How many numbered plays reached screenRIG per UTC day, and the gaps where plays went missing")
    .option("--day-from <YYYY-MM-DD>", "First UTC day, inclusive (default 29 days before --day-to); at most 92 days")
    .option("--day-to <YYYY-MM-DD>", "Last UTC day, inclusive (default today)")
    .option("--screen-id <ID>", "Only this screen")
    .option("--limit <N>", "Gaps to list, newest first, 1 to 500 (default 100)", positiveInteger("limit"))
    .addOption(reportFormatOption())
    .addOption(reportOutputOption("play-completeness.FORMAT"))
    .action(bind(handlePlaybackCompleteness));
}
