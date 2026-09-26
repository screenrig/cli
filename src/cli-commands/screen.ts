import { addValueAlias } from "./aliases.js";
import { addCommandExamples, addCommandNotes, requireOptionGroup } from "./notes.js";
import { positiveInteger, revision, screenTagOption, screenTagListOption, toastDuration } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleScreenPublish, handleScreenPair, handleScreenProvision, handleScreenUpdate, handleScreenList, handleScreenShow, handleScreenStorageForecast, handleScreenAssign, handleScreenSetTimezone, handleScreenArchive, handleScreenUnarchive, handleScreenDelete, handleScreenRotatePublicId, handleScreenRecover, handleScreenReload, handleScreenToast, handleScreenScreenshot, handleScreenTag, handleScreenScheduleShow, handleScreenScheduleSet, handleScreenScheduleClear, handleScreenTakeover, handleScreenTakeoverClear, handleScreenReboot, handleScreenDisplay, handleScreenDisplayClear, handleScreenDisplayScheduleShow, handleScreenDisplayScheduleSet, handleScreenDisplayScheduleClear } from "../commands.js";
import { durationOption, takeoverReason, takeoverUntilOption } from "../screen-control.js";
import { untilOption } from "../screen-display.js";
import { type Command, Option } from "commander";

export function registerScreenCommands(root: Command, bind: CommandActionBinder): void {
  const screen = root.command("screen").description("Pair, configure, and inspect screens");

  screen.command("publish").description("Create a new playlist from a prepared file and assign it to a screen")
    .argument("<id>", "Screen identifier")
    .argument("<file>", "Prepared playlist file, or - for stdin")
    .option("--expect-rev <REVISION>", "Expected screen revision", revision)
    .action(bind(handleScreenPublish));

  screen.command("pair").description("Claim a Player pairing code")
    .argument("<code>", "Player pairing code")
    .action(bind(handleScreenPair));

  screen.command("provision").description("Create a screen and browser handoff")
    .addOption(new Option("--open", "Open the browser Player handoff").conflicts(["printUrl"]))
    .option("--print-url", "Return the browser handoff URL")
    .action(bind(handleScreenProvision));

  screen.command("update").description("Update a screen")
    .argument("<id>", "Screen identifier")
    .option("--name <NAME>", "Set the screen name")
    .option("--playlist-id <ID>", "Select the playlist to assign")
    .option("--timezone <ZONE>", "Set an IANA timezone")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenUpdate));

  screen.command("list").description("List screens")
    .addOption(new Option("--state <STATE>", "List archived screens; omitted lists active screens").choices(["archived"]))
    .option("--tag <TAG>", "List only screens carrying this exact tag", screenTagOption)
    .action(bind(handleScreenList));

  screen.command("show").description("Inspect a screen")
    .argument("<id>", "Screen identifier")
    .action(bind(handleScreenShow));

  screen.command("storage-forecast").description("Dry-run whether a playlist fits a screen's reported storage")
    .argument("<id>", "Screen identifier")
    .requiredOption("--playlist-id <ID>", "Select the playlist to forecast (required)")
    .option("--playlist-rev <REVISION>", "Optionally require the playlist to be at this revision", positiveInteger("playlist-rev"))
    .action(bind(handleScreenStorageForecast));

  screen.command("assign").description("Assign a playlist to a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .requiredOption("--playlist-id <ID>", "Select the playlist to assign (required)")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenAssign));

  screen.command("set-timezone").description("Set a screen's timezone")
    .argument("<id>", "Screen identifier")
    .requiredOption("--timezone <ZONE>", "Set an IANA timezone (required)")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenSetTimezone));

  screen.command("archive").description("Archive a screen")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenArchive));

  screen.command("unarchive").description("Restore an archived screen")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenUnarchive));

  screen.command("delete").description("Delete a screen")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenDelete));

  screen.command("rotate-public-id").description("Rotate a screen's public identifier")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenRotatePublicId));

  const recover = screen.command("recover").description("Reconnect a display that reports this screen's identifiers")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Require the current resource revision", revision)
    .action(bind(handleScreenRecover));
  addCommandNotes(recover, "Recovery reconnects a display that lost its stored identity and now reports this screen's hardware identifiers while pairing. Nothing is rebound until this command confirms it: the screen keeps its label, playlist, timezone, schedules, and history; the display's new key replaces the previous one, which retires after a fifteen-minute grace window. screen show reports the offer as recovery_pending with its deadline and, when the server reports it, the platform, model, firmware, and manufacturer of the display asking to reconnect. Compare the reported model and firmware with the display you expect before confirming: a display's identifiers can be read by any application running on it, so the offer alone does not prove which display is asking. The service refuses offers while the screen's current player is still online and limits how many offers each screen receives. Recovery never crosses projects.");
  addCommandExamples(recover, "screenrig screen show scr_LOBBY", "screenrig screen recover scr_LOBBY");

  screen.command("reload").description("Ask a screen's player, or a fleet's players, to reload")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleScreenReload));

  screen.command("toast").description("Show a temporary message on a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .requiredOption("--text <TEXT>", "Set the screen message (required)")
    .addOption(new Option("--level <LEVEL>", "Set toast level").choices(["error", "alert", "info"]).default("info"))
    .option("--duration-ms <MS>", "Show the message for 2000–60000 milliseconds", toastDuration)
    .action(bind(handleScreenToast));

  screen.command("screenshot").description("Capture and download screenshots from a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids capture each screen")
    .option("--tag <TAG>", "Capture every active screen carrying this tag", screenTagOption)
    .option("--output <PATH>", "Write the screenshot to this file; with several ids or --tag, a directory")
    .option("--concurrency <N>", "Captures in flight at once with several ids or --tag (1-8, default 4)", positiveInteger("concurrency"))
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .action(bind(handleScreenScreenshot));

  const tag = screen.command("tag").description("Set, add, remove, or clear screen tags on a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .option("--set <TAGS>", "Replace the tag set with these comma-separated tags", screenTagListOption("--set"))
    .option("--add <TAGS>", "Add these comma-separated tags", screenTagListOption("--add"))
    .option("--remove <TAGS>", "Remove these comma-separated tags", screenTagListOption("--remove"))
    .option("--clear", "Remove every tag")
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenTag));
  requireOptionGroup(tag, "exactlyOne", ["--set", "--add", "--remove", "--clear"]);

  const schedule = screen.command("schedule").description("Show, set, or clear a screen's server-evaluated playlist schedule");
  schedule.command("show").description("Show a screen's playlist schedule and the playlist it currently selects")
    .argument("<id>", "Screen identifier")
    .action(bind(handleScreenScheduleShow));
  schedule.command("set").description("Replace the playlist schedule on a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .requiredOption("--file <FILE>", "Schedule JSON {\"entries\": [...]}, or - for stdin (required)")
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenScheduleSet));
  schedule.command("clear").description("Remove the playlist schedule from a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenScheduleClear));

  const takeover = screen.command("takeover").description("Put a playlist ahead of the schedule and assignment, or clear it");
  takeover.command("set", { isDefault: true }).description("Take over a screen or a fleet with one playlist (default: screen takeover ID ...)")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .requiredOption("--playlist-id <ID>", "Playlist to show (required)")
    .addOption(new Option("--until <TIME>", "End at this RFC 3339 instant (at most 7 days ahead), or none to hold until cleared").argParser(takeoverUntilOption).conflicts(["for"]))
    .addOption(new Option("--for <DURATION>", "End after this duration, such as 30m, 2h, or 3d (at most 7d)").argParser(durationOption).conflicts(["until"]))
    .option("--reason <TEXT>", "Operator note carried on the takeover and its events (at most 120 characters)", takeoverReason)
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenTakeover));
  takeover.command("clear").description("End the takeover on a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenTakeoverClear));
  addCommandExamples(schedule.commands.find((command) => command.name() === "show")!, "screenrig screen schedule show scr_LOBBY");
  addCommandExamples(schedule.commands.find((command) => command.name() === "set")!,
    "screenrig screen schedule set scr_LOBBY --file dayparts.json --expect-rev 4",
    "screenrig screen schedule set --tag Cafe --file dayparts.json");
  addCommandExamples(schedule.commands.find((command) => command.name() === "clear")!, "screenrig screen schedule clear scr_LOBBY", "screenrig screen schedule clear --tag Cafe");
  addCommandExamples(takeover.commands.find((command) => command.name() === "set")!,
    'screenrig screen takeover scr_LOBBY --playlist-id pl_DRILL --for 30m --reason "Fire drill"',
    "screenrig screen takeover --tag Lobby --playlist-id pl_LAUNCH --until 2026-10-01T18:00:00Z",
    "screenrig screen takeover scr_A scr_B --playlist-id pl_NOTICE --until none");
  addCommandExamples(takeover.commands.find((command) => command.name() === "clear")!,
    "screenrig screen takeover clear scr_LOBBY", "screenrig screen takeover clear --tag Lobby");
  const reboot = screen.command("reboot").description("Reboot a screen's device, or a fleet's devices")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .option("--yes", "Confirm a reboot of several screens or --tag (required for a fleet)")
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenReboot));
  addCommandNotes(reboot, "Reboot:\n  The Player reboots the device, not just itself. Only a Player that declares\n  the reboot capability in its host report receives it; any other screen is\n  refused with reboot_unsupported (exit 5) and nothing is sent. The request\n  expires after ten minutes, and each screen accepts at most 2 reboots per 10\n  minutes; a refused or failed request and an exact replay spend none. A\n  fleet (several ids or --tag) requires --yes: the CLI never prompts.");
  addCommandExamples(reboot, "screenrig screen reboot scr_LOBBY", "screenrig screen reboot --tag Lobby --yes");

  const displayGroup = screen.command("display").description("Turn a screen's display on or off now, or clear that override");
  const display = displayGroup.command("set", { isDefault: true }).description("Turn a screen's display, or a fleet's displays, on or off now (default: screen display ID --power on|off)")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request; a trailing on|off sets the power")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .addOption(new Option("--power <POWER>", "on or off").choices(["on", "off"]))
    .addOption(new Option("--until <TIME>", "End at this RFC 3339 instant (strictly future, at most 7 days ahead)").argParser(untilOption).conflicts(["for"]))
    .addOption(new Option("--for <DURATION>", "End after this duration, such as 30m, 2h, or 3d (at most 6d23h59m)").argParser(durationOption).conflicts(["until"]))
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenDisplay));
  addCommandNotes(display, "Display power:\n  A manual override of the display schedule. Without --until or --for it ends\n  at the display schedule's next boundary; a later display-schedule change or\n  timezone change moves that end to the new next boundary. With no schedule\n  boundary in the next eight days (no enabled schedule) it holds until\n  screen display clear or a replacement. The Player applies it at once and\n  reports what it achieved (screen show: Display reported). At most 10\n  display changes per screen per minute; refusals and replays spend none.");
  addCommandExamples(display, "screenrig screen display scr_LOBBY --power off --for 2h", "screenrig screen display --tag Lobby --power on", "screenrig screen display scr_A scr_B --power off --until 2026-10-01T07:00:00Z");
  const displayClear = displayGroup.command("clear").description("End the manual display override on a screen or a fleet; the schedule (else on) applies again")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
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
    .requiredOption("--file <FILE>", "Display schedule JSON {\"enabled\": true, \"windows\": [...]}, or - for stdin (required)")
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenDisplayScheduleSet));
  displaySchedule.command("clear").description("Remove the display schedule from a screen or a fleet of screens")
    .argument("[id...]", "Screen identifier; several ids target those screens in one fleet request")
    .option("--tag <TAG>", "Target every active screen carrying this tag", screenTagOption)
    .option("--expect-rev <REVISION>", "Optionally require this screen revision (one screen id only)", revision)
    .action(bind(handleScreenDisplayScheduleClear));
  addCommandNotes(displaySchedule, "Display schedule:\n  1 to 16 windows when the display is ON, in the screen timezone (required):\n  {\"enabled\": true, \"windows\": [{\"days\": [\"mon\",\"tue\"], \"start\": \"07:00\", \"end\": \"19:00\"}]}.\n  end <= start crosses midnight; omit start and end for the whole day. Outside\n  every window the display goes to standby. enabled false keeps the windows and\n  leaves the display on. The device evaluates it offline.");
  addCommandExamples(displaySchedule.commands.find((command) => command.name() === "show")!, "screenrig screen display-schedule show scr_LOBBY");
  addCommandExamples(displaySchedule.commands.find((command) => command.name() === "set")!,
    "screenrig screen display-schedule set scr_LOBBY --file hours.json", "screenrig screen display-schedule set --tag Cafe --file hours.json");
  addCommandExamples(displaySchedule.commands.find((command) => command.name() === "clear")!,
    "screenrig screen display-schedule clear scr_LOBBY", "screenrig screen display-schedule clear --tag Cafe");
  for (const name of ["pair", "provision"]) addValueAlias(screen.commands.find(command => command.name() === name)!, "--name", "--label", "Set the screen name");
  requireOptionGroup(screen.commands.find(command => command.name() === "update")!, "atLeastOne", ["--name", "--playlist-id", "--timezone"]);
}
