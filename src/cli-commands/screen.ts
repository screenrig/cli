import { addValueAlias } from "./aliases.js";
import { addCommandExamples, addCommandNotes, requireOptionGroup } from "./notes.js";
import { positiveInteger, revision, screenTagOption, screenTagListOption, toastDuration } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleScreenPublish, handleScreenPair, handleScreenProvision, handleScreenUpdate, handleScreenList, handleScreenShow, handleScreenStorageForecast, handleScreenAssign, handleScreenSetTimezone, handleScreenArchive, handleScreenUnarchive, handleScreenDelete, handleScreenRotatePublicId, handleScreenRecover, handleScreenReload, handleScreenToast, handleScreenScreenshot, handleScreenTag } from "../commands.js";
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
  for (const name of ["pair", "provision"]) addValueAlias(screen.commands.find(command => command.name() === name)!, "--name", "--label", "Set the screen name");
  requireOptionGroup(screen.commands.find(command => command.name() === "update")!, "atLeastOne", ["--name", "--playlist-id", "--timezone"]);
}
