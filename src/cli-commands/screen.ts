import { addCommandExamples, addCommandNotes } from "./notes.js";
import { positiveInteger, revision, toastDuration } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleScreenPublish, handleScreenPair, handleScreenProvision, handleScreenUpdate, handleScreenList, handleScreenShow, handleScreenAssign, handleScreenSetTimezone, handleScreenArchive, handleScreenUnarchive, handleScreenDelete, handleScreenRotatePublicId, handleScreenRecover, handleScreenToast, handleScreenScreenshot } from "../commands.js";
import type { Command } from "commander";

export function registerScreenCommands(root: Command, bind: CommandActionBinder): void {
  const screen = root.command("screen").description("Pair, configure, and inspect screens");

  screen.command("publish").description("Create a prepared playlist and assign it, with resumable recovery")
    .argument("<id>", "Screen identifier")
    .argument("<file>", "Prepared playlist file, or - for stdin")
    .requiredOption("--expect-rev <REVISION>", "Expected screen revision", revision)
    .action(bind(handleScreenPublish));

  screen.command("pair").description("Claim a Player pairing code")
    .argument("<code>", "Player pairing code")
    .option("--label <LABEL>", "Set the screen label")
    .action(bind(handleScreenPair));

  screen.command("provision").description("Create a screen and browser handoff")
    .option("--open", "Open the browser Player handoff")
    .option("--print-url", "Return the browser handoff URL")
    .option("--label <LABEL>", "Set the screen label")
    .action(bind(handleScreenProvision));

  screen.command("update").description("Update a screen")
    .argument("<id>", "Screen identifier")
    .option("--name <NAME>", "Set the screen name")
    .option("--playlist-id <ID>", "Select the playlist to assign")
    .option("--timezone <ZONE>", "Set an IANA timezone")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handleScreenUpdate));

  screen.command("list").description("List screens")
    .option("--state <archived>", "List archived screens")
    .action(bind(handleScreenList));

  screen.command("show").description("Inspect a screen")
    .argument("<id>", "Screen identifier")
    .action(bind(handleScreenShow));

  screen.command("assign").description("Assign a playlist to a screen")
    .argument("<id>", "Screen identifier")
    .requiredOption("--playlist-id <ID>", "Select the playlist to assign (required)")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handleScreenAssign));

  screen.command("set-timezone").description("Set a screen's timezone")
    .argument("<id>", "Screen identifier")
    .requiredOption("--timezone <ZONE>", "Set an IANA timezone (required)")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handleScreenSetTimezone));

  screen.command("archive").description("Archive a screen")
    .argument("<id>", "Screen identifier")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handleScreenArchive));

  screen.command("unarchive").description("Restore an archived screen")
    .argument("<id>", "Screen identifier")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handleScreenUnarchive));

  screen.command("delete").description("Delete a screen")
    .argument("<id>", "Screen identifier")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handleScreenDelete));

  screen.command("rotate-public-id").description("Rotate a screen's public identifier")
    .argument("<id>", "Screen identifier")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handleScreenRotatePublicId));

  const recover = screen.command("recover").description("Reconnect a display that reports this screen's identifiers")
    .argument("<id>", "Screen identifier")
    .option("--expect-rev <REVISION>", "Require the current resource revision", revision)
    .action(bind(handleScreenRecover));
  addCommandNotes(recover, "Recovery reconnects a display that lost its stored identity and now reports this screen's hardware identifiers while pairing. Nothing is rebound until this command confirms it: the screen keeps its label, playlist, timezone, schedules, and history; the display's new key replaces the previous one, which retires after a fifteen-minute grace window. screen show reports the offer as recovery_pending with its deadline and, when the server reports it, the platform, model, firmware, and manufacturer of the display asking to reconnect. Compare the reported model and firmware with the display you expect before confirming: a display's identifiers can be read by any application running on it, so the offer alone does not prove which display is asking. The service refuses offers while the screen's current player is still online and limits how many offers each screen receives. Recovery never crosses accounts.");
  addCommandExamples(recover, "screenrig screen show scr_LOBBY", "screenrig screen recover scr_LOBBY");

  screen.command("toast").description("Show a temporary screen message")
    .argument("<id>", "Screen identifier")
    .requiredOption("--text <TEXT>", "Set the screen message (required)")
    .option("--level <LEVEL>", "Set toast level (default: info)")
    .option("--duration-ms <MS>", "Show the message for 2000–60000 milliseconds", toastDuration)
    .action(bind(handleScreenToast));

  screen.command("screenshot").description("Capture and download a screen screenshot")
    .argument("<id>", "Screen identifier")
    .option("--output <PATH>", "Write the screenshot to this file")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .action(bind(handleScreenScreenshot));
}
