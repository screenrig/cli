import { addCommandExamples, addCommandNotes, requireOptionGroup } from "./notes.js";
import { NOTE_HELP, positiveInteger, reportFormatOption, reportOutputOption, reviewNoteOption, revision, screenTagOption, screenTagListOption, toastDuration } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleScreenPublish, handleScreenPair, handleScreenProvision, handleScreenUpdate, handleScreenList, handleScreenShow, handleScreenStorageForecast, handleScreenAssign, handleScreenSetTimezone, handleScreenWallSet, handleScreenWallClear, handleScreenArchive, handleScreenUnarchive, handleScreenDelete, handleScreenRotatePublicId, handleScreenRecover, handleScreenReload, handleScreenToast, handleScreenPlayPage, handleScreenScreenshot, handleScreenTag, handleScreenScheduleShow, handleScreenScheduleSet, handleScreenScheduleClear, handleScreenTakeover, handleScreenTakeoverClear, handleScreenReboot, handleScreenDisplay, handleScreenDisplayClear, handleScreenDisplayScheduleShow, handleScreenDisplayScheduleSet, handleScreenDisplayScheduleClear, handleScreenUptime, handleScreenPresence, handleScreenHealthHistory, handleScreenIdentify, handleScreenSuspend, handleScreenResume, handleScreenReplace, handleScreenCommandCancel, handleScreenLiveStart, handleScreenLiveStatus, handleScreenLiveStop, handleScreenLiveFrame } from "../commands.js";
import { durationOption, takeoverReason, takeoverUntilOption } from "../screen-control.js";
import { expiresInOption, identifyDurationOption, suspendMessageOption } from "../screen-commands.js";
import { liveDurationOption, liveWaitOption } from "../screen-live.js";
import { liveFrameIntervalOption } from "../screen-live-frame.js";
import { untilOption } from "../screen-display.js";
import { WALL_ARRANGEMENTS, WALL_ROTATIONS, wallOutputsOption } from "../screen-wall.js";
import { playsInstantOption } from "../playback-export.js";
import { handleScreenLinkCreate, handleScreenLinkDelete, handleScreenLinkShow } from "../screen-link.js";
import { handleScreenFolderCreate, handleScreenFolderDelete, handleScreenFolderList, handleScreenFolderShow, handleScreenFolderUpdate, handleScreenMove, screenFolderIdOption, screenFolderName, screenFolderPlaylistOption, screenListFolderOption } from "../screen-folders.js";
import { screenAddressOption, screenFieldFilterOption, screenFieldSetOption, screenLocationNameOption, screenLocationOption, screenNearOption, screenUnsetFieldOption } from "../screen-facts.js";
import { type Command, Option } from "commander";

/** --folder on a fleet command: the same fleet as --tag, chosen by screen folder (with every folder inside it). */
function folderSelector(verb: "Target" | "Capture" = "Target"): Option {
  return new Option("--folder <ID>", `${verb} every active screen in this screen folder (sfd_...) and the folders inside it`)
    .argParser(screenFolderIdOption("--folder")).conflicts("tag");
}

export function registerScreenCommands(root: Command, bind: CommandActionBinder): void {
  const screen = root.command("screen").description("Pair, configure, and inspect screens");

  screen.command("publish").description("Publish a prepared playlist after rendering and inspecting its local preview")
    .argument("<id>", "Screen identifier")
    .argument("<file>", "Prepared playlist file, or - for stdin")
    .option("--expect-rev <REVISION>", "Expected screen revision", revision)
    .option("--no-wait", "Return after assignment without waiting for the Player to show the playlist")
    .option("--poll-ms <MS>", "Set the screen polling interval while waiting", positiveInteger("poll-ms"))
    .option("--no-progress", "Suppress stderr progress")
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handleScreenPublish));

  screen.command("pair").description("Claim a Player pairing code")
    .argument("<code...>", "Player pairing code as shown; spaces and dashes are ignored")
    .option("--name <NAME>", "Set the screen name")
    .action(bind(handleScreenPair));

  screen.command("provision").description("Create a screen and browser handoff")
    .addOption(new Option("--open", "Open the browser Player handoff").conflicts(["printUrl"]))
    .option("--print-url", "Return the browser handoff URL")
    .option("--name <NAME>", "Set the screen name")
    .action(bind(handleScreenProvision));

  screen.command("update").description("Update a screen")
    .argument("<id>", "Screen identifier")
    .option("--name <NAME>", "Set the screen name")
    .option("--playlist-id <ID>", "Select the playlist to assign")
    .option("--timezone <ZONE>", "Set an IANA timezone")
    .addOption(new Option("--field <NAME=VALUE>", "Set a field: NAME is 1 to 32 lower case letters, digits or underscores, VALUE 1 to 200 characters (repeatable; at most 32 fields)").argParser(screenFieldSetOption).conflicts(["clearFields"]))
    .addOption(new Option("--unset-field <NAME>", "Remove a field (repeatable)").argParser(screenUnsetFieldOption).conflicts(["clearFields"]))
    .addOption(new Option("--clear-fields", "Remove every field").conflicts(["field", "unsetField"]))
    .addOption(new Option("--location <LAT,LON>", "Set where the screen is, in decimal degrees; replaces the whole location").argParser(screenLocationOption).conflicts(["clearLocation"]))
    .option("--location-name <NAME>", "Name the location, at most 40 characters: the place name a card shows (with --location)", screenLocationNameOption)
    .option("--address <TEXT>", "Give the location an address, at most 200 characters (with --location)", screenAddressOption)
    .addOption(new Option("--clear-location", "Remove the location").conflicts(["location"]))
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenUpdate));

  screen.command("list").description("List screens")
    .addOption(new Option("--state <STATE>", "List archived screens; omitted lists active screens").choices(["archived"]))
    .option("--tag <TAG>", "List only screens carrying this exact tag", screenTagOption)
    .option("--folder <ID|root>", "List only the screens directly in this screen folder (sfd_...), not those of the folders inside it; root lists the screens outside every folder", screenListFolderOption)
    .addOption(new Option("--field <NAME=VALUE>", "List only screens whose field NAME holds exactly VALUE (repeatable; every one must match)").argParser(screenFieldFilterOption))
    .addOption(new Option("--near <LAT,LON,KM>", "List only screens located within KM kilometres of the point; screens with no location are left out").argParser(screenNearOption))
    .action(bind(handleScreenList));

  screen.command("show").description("Inspect a screen")
    .argument("<id>", "Screen identifier")
    .action(bind(handleScreenShow));

  screen.command("uptime").description("Read a screen's daily availability over UTC days")
    .argument("<id>", "Screen identifier")
    .option("--day-from <YYYY-MM-DD>", "First UTC day, inclusive (default 29 days before --day-to)")
    .option("--day-to <YYYY-MM-DD>", "Last UTC day, inclusive (default today); at most 366 days after --day-from")
    .addOption(reportFormatOption())
    .addOption(reportOutputOption("screen-uptime.FORMAT"))
    .action(bind(handleScreenUptime));

  screen.command("presence").description("List a screen's online and offline transitions, newest first")
    .argument("<id>", "Screen identifier")
    .option("--since <TIME>", "Inclusive start of the transition time: RFC 3339, now, or an age such as 7d, 12h, 30m (default 30 days before --until)", playsInstantOption("--since"))
    .option("--until <TIME>", "Exclusive end of the transition time: RFC 3339, now, or an age (default now); at most 366 days after --since", playsInstantOption("--until"))
    .action(bind(handleScreenPresence));

  screen.command("health-history").description("List the health a screen reported over time, each report or one summary per hour")
    .argument("<id>", "Screen identifier")
    .option("--from <TIME>", "Inclusive start of the report time: RFC 3339, now, or an age such as 7d, 12h, 30m (default 24 hours before --to)", playsInstantOption("--from"))
    .option("--to <TIME>", "Exclusive end of the report time: RFC 3339, now, or an age (default now); at most 31 days after --from, 93 with --resolution hour", playsInstantOption("--to"))
    .addOption(new Option("--resolution <RESOLUTION>", "raw (default) lists each report; hour summarizes each UTC hour").choices(["raw", "hour"]))
    .addOption(reportFormatOption())
    .addOption(reportOutputOption("screen-health-history.FORMAT"))
    .action(bind(handleScreenHealthHistory));

  screen.command("storage-forecast").description("Dry-run whether a playlist fits a screen's reported storage")
    .argument("<id>", "Screen identifier")
    .requiredOption("--playlist-id <ID>", "Select the playlist to forecast (required)")
    .option("--playlist-rev <REVISION>", "Optionally require the playlist to be at this revision", positiveInteger("playlist-rev"))
    .action(bind(handleScreenStorageForecast));

  screen.command("assign").description("Assign a playlist to a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .requiredOption("--playlist-id <ID>", "Select the playlist to assign (required)")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handleScreenAssign));

  addCommandNotes(screen.command("set-timezone").description("Set a screen's timezone")
    .argument("<id>", "Screen identifier")
    .requiredOption("--timezone <ZONE>", "Set an IANA timezone name, such as Europe/London (required)")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenSetTimezone)), "Timezone:\n  ZONE is an IANA timezone name: Area/City such as America/New_York,\n  Europe/London or Asia/Tokyo, or UTC. Playlist schedules, takeovers and\n  display schedules read their civil times in this zone. Page visibility\n  needs it for from, until or windows; data-only visibility needs no zone.");

  const wall = screen.command("wall").description("Set or clear a screen's video wall: one Player driving two to twelve displays as one canvas");
  wall.command("set").description("Set a screen's video wall")
    .argument("<id>", "Screen identifier")
    .requiredOption("--outputs <NAMES>", "Two to twelve comma-separated output names in physical order (left to right, then top to bottom), as screen show lists them under observation.surfaces (required)", wallOutputsOption)
    .addOption(new Option("--arrangement <ARRANGEMENT>", "row (one row, left to right), column (one column, top to bottom) or grid (rows of --columns outputs, top to bottom) (required)").choices([...WALL_ARRANGEMENTS]).makeOptionMandatory())
    .option("--columns <N>", "Outputs per row of a grid (required for grid, not allowed for row or column); at least 2, dividing the outputs into at least 2 rows", positiveInteger("columns"))
    .addOption(new Option("--rotation <DEGREES>", "Clockwise rotation of every output (default 0); 90 and 270 are portrait panels").choices([...WALL_ROTATIONS]))
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenWallSet));
  wall.command("clear").description("Remove a screen's video wall")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenWallClear));

  screen.command("archive").description("Archive a screen")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenArchive));

  screen.command("unarchive").description("Restore an archived screen")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenUnarchive));

  screen.command("suspend").description("Show a notice on a screen instead of its content, until screen resume")
    .argument("<id>", "Screen identifier")
    .requiredOption("--message <TEXT>", "Set the notice the screen shows, 1 to 280 characters; line feeds are kept (required)", suspendMessageOption)
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenSuspend));

  screen.command("resume").description("End a screen's suspension so it shows its own content again")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenResume));

  screen.command("delete").description("Delete a screen")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenDelete));

  screen.command("rotate-public-id").description("Rotate a screen's public identifier")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenRotatePublicId));

  const link = screen.command("link").description("Give a screen a Player URL for a browser that keeps no storage, such as a vMix or OBS browser source");
  addCommandNotes(link, "Screen links:\n  A screen link is the Player URL (https://play.<domain>/player/#screen=...) that\n  opens one screen in a browser that keeps no storage. Pair the screen once with\n  its code, create the link, paste it into the browser source. The URL is a\n  credential: open it in one place, and replace it when it leaks.");
  link.command("create").description("Create the screen's link, or replace it, and print its Player URL (the old URL stops working at once)")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this screen revision", revision)
    .action(bind(handleScreenLinkCreate));
  link.command("show").description("Print the screen's link and its Player URL")
    .argument("<id>", "Screen identifier")
    .action(bind(handleScreenLinkShow));
  link.command("delete").description("Turn the screen's link off; its URL stops working at once")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this screen revision", revision)
    .action(bind(handleScreenLinkDelete));

  const recover = screen.command("recover").description("Reconnect a display that reports this screen's identifiers")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Require the current resource revision", revision)
    .action(bind(handleScreenRecover));
  addCommandNotes(recover, "Recovery reconnects a display that lost its stored identity and now reports this screen's hardware identifiers while pairing. Nothing is rebound until this command confirms it: the screen keeps its label, playlist, timezone, schedules, and history; the display's new key replaces the previous one, which retires after a fifteen-minute grace window. screen show reports the offer as recovery_pending with its deadline and, when the server reports it, the platform, model, firmware, and manufacturer of the display asking to reconnect. Compare the reported model and firmware with the display you expect before confirming: a display's identifiers can be read by any application running on it, so the offer alone does not prove which display is asking. The service refuses offers while the screen's current player is still online and limits how many offers each screen receives. Recovery never crosses projects.");
  addCommandExamples(recover, "screenrig screen show scr_LOBBY", "screenrig screen recover scr_LOBBY");

  screen.command("replace").description("Move the device paired as another screen onto this screen, keeping its settings and history")
    .argument("<id>", "Screen to keep: it keeps its name, playlist, schedules and history")
    .requiredOption("--with <ID>", "Screen whose paired device takes over this screen; it is archived (required)")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision of the screen to keep", revision)
    .action(bind(handleScreenReplace));

  screen.command("reload").description("Ask a screen's player, or a fleet's players, to reload")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .option("--expires-in <DURATION>", "How long the reload waits for an offline screen to come online: 60s to 24h, such as 30m or 2h (default 24h)", expiresInOption)
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenReload));

  screen.command("toast").description("Show a temporary message on a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .requiredOption("--text <TEXT>", "Set the screen message (required)")
    .addOption(new Option("--level <LEVEL>", "Set toast level").choices(["error", "alert", "info"]).default("info"))
    .option("--duration-ms <MS>", "Show the message for 2000–60000 milliseconds", toastDuration)
    .action(bind(handleScreenToast));

  screen.command("identify").description("Show a screen's name over its content for a while, to find it on site")
    .argument("<id>", "Screen identifier")
    .option("--duration <DURATION>", "How long the overlay stays up: 2s to 10m, such as 30s or 1m30s (default 60s)", identifyDurationOption)
    .action(bind(handleScreenIdentify));

  screen.command("play-page").description("Start a page of the playlist a screen is playing now, for checking that page with screen screenshot")
    .argument("<id>", "Screen identifier")
    .requiredOption("--page-id <ID>", "Page of the playlist the screen is playing (required)")
    .action(bind(handleScreenPlayPage));

  const live = screen.command("live").description("Watch what a screen plays, live: start, read and stop a live view session");
  live.command("start").description("Start live view of a screen, or renew it, and print the dashboard page that shows it")
    .argument("<id>", "Screen identifier")
    .option("--duration <DURATION>", "How long the session lasts unless renewed: 30s to 5m, such as 90s or 5m (default 5m); a session ends after five minutes at most", liveDurationOption)
    .option("--wait <DURATION>", "How long to wait for the Player to start publishing: 1s to 10m, or 0 to return at once (default 30s)", liveWaitOption)
    .action(bind(handleScreenLiveStart));
  live.command("status").description("Read a screen's live view session")
    .argument("<id>", "Screen identifier")
    .action(bind(handleScreenLiveStatus));
  live.command("stop").description("End a screen's live view session")
    .argument("<id>", "Screen identifier")
    .action(bind(handleScreenLiveStop));
  live.command("frame").description("Save JPEG frames of what a screen plays, from its live stream, to check playback and motion")
    .argument("<id>", "Screen identifier")
    .option("--output <PATH>", "Write one frame to this file, or the frames into this directory as frame-<captured_at>.jpg (default: the working directory)")
    .option("--count <N>", "Save this many new frames (default 1)", positiveInteger("count"))
    .option("--interval <DURATION>", "Pause between frames: 1s to 5m, or 0 to take each frame as it arrives (default 1s)", liveFrameIntervalOption)
    .option("--duration <DURATION>", "Lease of the live session this command starts, at least long enough for the frames: 30s to 5m, such as 90s or 5m (default 2m)", liveDurationOption)
    .option("--wait <DURATION>", "How long to wait for the Player to start publishing, and for each frame: 1s to 10m, or 0 to try once (default 30s)", liveWaitOption)
    .option("--stop", "End the live session when done, also when a frame failed")
    .action(bind(handleScreenLiveFrame));

  screen.command("screenshot").description("Capture and download screenshots from a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids capture each screen")
    .option("--tag <TAG>", "Capture every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector("Capture"))
    .option("--output <PATH>", "Write the screenshot to this file; with several ids or --tag, a directory")
    .option("--concurrency <N>", "Captures in flight at once with several ids or --tag (1-8, default 4)", positiveInteger("concurrency"))
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .action(bind(handleScreenScreenshot));

  const tag = screen.command("tag").description("Set, add, remove, or clear screen tags on a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .option("--set <TAGS>", "Replace the tag set with these comma-separated tags", screenTagListOption("--set"))
    .option("--add <TAGS>", "Add these comma-separated tags", screenTagListOption("--add"))
    .option("--remove <TAGS>", "Remove these comma-separated tags", screenTagListOption("--remove"))
    .option("--clear", "Remove every tag")
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenTag));
  requireOptionGroup(tag, "exactlyOne", ["--set", "--add", "--remove", "--clear"]);

  const move = screen.command("move").description("Move screens and screen folders into a screen folder, or back to the project root")
    .argument("<ids...>", "Screen (scr_...) and screen folder (sfd_...) identifiers, at most 1000")
    .option("--folder <ID>", "Destination screen folder (sfd_...)", screenFolderIdOption("--folder"))
    .option("--root", "Move to the project root, outside every folder")
    .action(bind(handleScreenMove));
  requireOptionGroup(move, "exactlyOne", ["--folder", "--root"]);

  const folder = screen.command("folder").description("List, create, rename, move, and delete screen folders; a folder targets its screens and sets their default playlist");
  folder.command("list").description("List the project's screen folders as a tree, with the live screens directly in each and its default playlist")
    .action(bind(handleScreenFolderList));
  folder.command("show").description("Inspect a screen folder")
    .argument("<id>", "Screen folder identifier (sfd_...)")
    .action(bind(handleScreenFolderShow));
  folder.command("create").description("Create a screen folder at the project root or inside another folder")
    .requiredOption("--name <NAME>", "Folder name, 1 to 100 characters, unique among its siblings (required)", screenFolderName)
    .option("--parent <ID>", "Create it inside this screen folder (sfd_...); omitted creates it at the project root", screenFolderIdOption("--parent"))
    .option("--default-playlist-id <ID>", "The approved playlist its screens show when they have none of their own", screenFolderPlaylistOption)
    .action(bind(handleScreenFolderCreate));
  const folderUpdate = folder.command("update").description("Rename a screen folder, move it with everything inside, or set or clear its default playlist")
    .argument("<id>", "Screen folder identifier (sfd_...)")
    .option("--name <NAME>", "New folder name, 1 to 100 characters, unique among its siblings", screenFolderName)
    .addOption(new Option("--parent <ID>", "Move it inside this screen folder (sfd_...)").argParser(screenFolderIdOption("--parent")).conflicts("root"))
    .addOption(new Option("--root", "Move it to the project root").conflicts("parent"))
    .addOption(new Option("--default-playlist-id <ID>", "The approved playlist its screens show when they have none of their own").argParser(screenFolderPlaylistOption).conflicts("clearDefault"))
    .addOption(new Option("--clear-default", "Remove its default playlist").conflicts("defaultPlaylistId"))
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenFolderUpdate));
  requireOptionGroup(folderUpdate, "atLeastOne", ["--name", "--parent", "--root", "--default-playlist-id", "--clear-default"]);
  folder.command("delete").description("Delete a screen folder; its screens and folders move up one level")
    .argument("<id>", "Screen folder identifier (sfd_...)")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenFolderDelete));

  const schedule = screen.command("schedule").description("Show, set, or clear a screen's server-evaluated playlist schedule");
  schedule.command("show").description("Show a screen's playlist schedule and the playlist it currently selects")
    .argument("<id>", "Screen identifier")
    .action(bind(handleScreenScheduleShow));
  schedule.command("set").description("Replace the playlist schedule on a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .requiredOption("--file <FILE>", "Schedule JSON {\"entries\": [...]}, or - for stdin (required)")
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handleScreenScheduleSet));
  schedule.command("clear").description("Remove the playlist schedule from a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handleScreenScheduleClear));

  const takeover = screen.command("takeover").description("Put a playlist ahead of campaigns, the schedule and assignment, or clear it");
  takeover.command("set", { isDefault: true }).description("Take over a screen or a fleet with one playlist (default: screen takeover ID ...)")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .requiredOption("--playlist-id <ID>", "Playlist to show (required)")
    .addOption(new Option("--until <TIME>", "End at this RFC 3339 instant (at most 7 days ahead), or none to hold until cleared").argParser(takeoverUntilOption).conflicts(["for"]))
    .addOption(new Option("--for <DURATION>", "End after this duration, such as 30m, 2h, or 3d (at most 7d)").argParser(durationOption).conflicts(["until"]))
    .option("--reason <TEXT>", "Operator note carried on the takeover and its events (at most 120 characters)", takeoverReason)
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handleScreenTakeover));
  takeover.command("clear").description("End the takeover on a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handleScreenTakeoverClear));
  addCommandExamples(schedule.commands.find((command) => command.name() === "show")!, "screenrig screen schedule show scr_LOBBY");
  addCommandExamples(schedule.commands.find((command) => command.name() === "set")!,
    "screenrig screen schedule set scr_LOBBY --file dayparts.json --expect-rev 4",
    "screenrig screen schedule set --tag Cafe --file dayparts.json");
  addCommandExamples(schedule.commands.find((command) => command.name() === "clear")!, "screenrig screen schedule clear scr_LOBBY", "screenrig screen schedule clear --tag Cafe");
  addCommandExamples(takeover.commands.find((command) => command.name() === "set")!,
    'screenrig screen takeover scr_LOBBY --playlist-id pl_DRILL --for 30m --reason "Fire drill"',
    "screenrig screen takeover --tag Lobby --playlist-id pl_LAUNCH --for 2h",
    "screenrig screen takeover scr_A scr_B --playlist-id pl_NOTICE --until none");
  addCommandExamples(takeover.commands.find((command) => command.name() === "clear")!,
    "screenrig screen takeover clear scr_LOBBY", "screenrig screen takeover clear --tag Lobby");
  const reboot = screen.command("reboot").description("Reboot a screen's device, or a fleet's devices")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .option("--yes", "Confirm a reboot of several screens or --tag (required for a fleet)")
    .option("--expires-in <DURATION>", "How long the reboot waits for an offline screen to come online: 60s to 24h, such as 30m or 2h (default 24h)", expiresInOption)
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenReboot));
  addCommandNotes(reboot, "Reboot:\n  The Player reboots the device, not just itself. Only a Player that declares\n  the reboot capability in its host report receives it; any other screen is\n  refused with reboot_unsupported (exit 5) and nothing is sent. A screen that\n  is online is sent the request at once (state sent); an offline screen holds\n  it queued (state queued) and is sent it when it comes online, for 24 hours by\n  default; --expires-in changes that, from 60s to 24h. A newer reboot\n  supersedes one still queued. screen show lists the screen's commands (a sent\n  reboot is done once the device reports it booted), and screen command cancel\n  ID COMMAND_ID cancels one still queued. Each screen accepts at most 2 reboots\n  per 10 minutes; a refused or failed request and an exact replay spend none. A\n  fleet (several ids or --tag) requires --yes: the CLI never prompts.");
  addCommandExamples(reboot, "screenrig screen reboot scr_LOBBY", "screenrig screen reboot scr_LOBBY --expires-in 2h", "screenrig screen reboot --tag Lobby --yes");

  const commandGroup = screen.command("command").description("Manage the reboots and reloads asked of a screen");
  commandGroup.command("cancel").description("Cancel a reboot or reload still queued for an offline screen")
    .argument("<id>", "Screen identifier")
    .argument("<command_id>", "Command id: an entry of commands in screen show, or the reboot_id or reload_id of the request's answer")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenCommandCancel));

  const displayGroup = screen.command("display").description("Turn a screen's display on or off now, or clear that override");
  const display = displayGroup.command("set", { isDefault: true }).description("Turn a screen's display, or a fleet's displays, on or off now (default: screen display ID --power on|off)")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request; a trailing on|off sets the power")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .addOption(new Option("--power <POWER>", "on or off").choices(["on", "off"]))
    .addOption(new Option("--until <TIME>", "End at this RFC 3339 instant (strictly future, at most 7 days ahead)").argParser(untilOption).conflicts(["for"]))
    .addOption(new Option("--for <DURATION>", "End after this duration, such as 30m, 2h, or 3d (at most 6d23h59m)").argParser(durationOption).conflicts(["until"]))
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenDisplay));
  addCommandNotes(display, "Display power:\n  A manual override of the display schedule. Without --until or --for it ends\n  at the display schedule's next boundary; a later display-schedule change or\n  timezone change moves that end to the new next boundary. With no schedule\n  boundary in the next eight days (no enabled schedule) it holds until\n  screen display clear or a replacement. The Player applies it at once and\n  reports what it achieved (screen show: Display reported). At most 10\n  display changes per screen per minute; refusals and replays spend none.");
  addCommandExamples(display, "screenrig screen display scr_LOBBY --power off --for 2h", "screenrig screen display --tag Lobby --power on", "screenrig screen display scr_A scr_B --power off --for 8h");
  const displayClear = displayGroup.command("clear").description("End the manual display override on a screen or a fleet; the schedule (else on) applies again")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenDisplayClear));
  addCommandExamples(displayClear, "screenrig screen display clear scr_LOBBY", "screenrig screen display clear --tag Lobby");

  const displaySchedule = screen.command("display-schedule").description("Show, set, or clear when a screen's display is on");
  displaySchedule.command("show").description("Show a screen's display schedule and its display state")
    .argument("<id>", "Screen identifier")
    .action(bind(handleScreenDisplayScheduleShow));
  displaySchedule.command("set").description("Replace the display schedule on a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .requiredOption("--file <FILE>", "Display schedule JSON {\"enabled\": true, \"windows\": [...]}, or - for stdin (required)")
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenDisplayScheduleSet));
  displaySchedule.command("clear").description("Remove the display schedule from a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(folderSelector())
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenDisplayScheduleClear));
  addCommandNotes(displaySchedule, "Display schedule:\n  The screen needs a timezone first (screen set-timezone ID --timezone ZONE).\n  1 to 16 windows when the display is ON, in the screen timezone (required):\n  {\"enabled\": true, \"windows\": [{\"days\": [\"mon\",\"tue\"], \"start\": \"07:00\", \"end\": \"19:00\"}]}.\n  end <= start crosses midnight; omit start and end for the whole day. Outside\n  every window the display goes to standby. enabled false keeps the windows and\n  leaves the display on. The device evaluates it offline.");
  addCommandExamples(displaySchedule.commands.find((command) => command.name() === "show")!, "screenrig screen display-schedule show scr_LOBBY");
  addCommandExamples(displaySchedule.commands.find((command) => command.name() === "set")!,
    "screenrig screen display-schedule set scr_LOBBY --file hours.json", "screenrig screen display-schedule set --tag Cafe --file hours.json");
  addCommandExamples(displaySchedule.commands.find((command) => command.name() === "clear")!,
    "screenrig screen display-schedule clear scr_LOBBY", "screenrig screen display-schedule clear --tag Cafe");
  const update = screen.commands.find(command => command.name() === "update")!;
  // The dependency checks run first, so a lone --address is told it needs --location rather than that nothing was asked.
  requireOptionGroup(update, "requires", ["--location-name", "--location"]);
  requireOptionGroup(update, "requires", ["--address", "--location"]);
  requireOptionGroup(update, "atLeastOne", ["--name", "--playlist-id", "--timezone", "--field", "--unset-field", "--clear-fields", "--location", "--clear-location"]);
}
