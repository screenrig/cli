import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import {
  handleFleetLinksCreate, handleFleetLinksDelete, handleFleetLinksList, handleFleetLinksRotate, handleFleetLinksShow, handleFleetLinksUpdate,
} from "../commands.js";
import { fleetLinkMaxScreens, fleetLinkName, fleetLinkPlaylistId, fleetLinkTags } from "../fleet-links.js";

const nameOption = (value: string): string => { fleetLinkName(value); return value; };

export function registerFleetLinksCommands(root: Command, bind: CommandActionBinder): void {
  const links = root.command("fleet-links").description("Turn every device that opens one Player URL into a screen");
  addCommandNotes(links, "Fleet links:\n  A fleet link is one Player URL (https://play.<domain>/player/#fleet=...) for a\n  device manager, such as a Google Admin console kiosk app. Every device that\n  opens it becomes its own screen in this project, without a pairing code, with\n  the link's tags and playlist and a label from the device (its administrator\n  asset ID, then location). A device keeps its one screen across reloads. The\n  URL is a credential that creates screens: give it only to the device manager.\n  A project has at most 50.");

  links.command("create").description("Create a fleet link and print its Player URL")
    .requiredOption("--name <NAME>", "Name the link, 1 to 80 characters (required)", nameOption)
    .option("--tag <TAG>", "Give each new screen this tag (repeatable, or comma-separated; at most 16)", fleetLinkTags)
    .option("--playlist-id <ID>", "Assign this playlist to each new screen", fleetLinkPlaylistId)
    .option("--max-screens <N>", "Create at most N screens, 1 to 10000 (default: only the project's screen limit)", fleetLinkMaxScreens)
    .option("--disabled", "Create it disabled; devices show their pairing code until fleet-links update --enable")
    .action(bind(handleFleetLinksCreate));

  links.command("list").description("List this project's fleet links (never their URLs in human output)")
    .action(bind(handleFleetLinksList));

  links.command("show").description("Inspect a fleet link and print its Player URL")
    .argument("<id>", "Fleet link identifier")
    .action(bind(handleFleetLinksShow));

  const update = links.command("update").description("Change what a fleet link gives the screens it creates from now on")
    .argument("<id>", "Fleet link identifier")
    .option("--name <NAME>", "Rename the link, 1 to 80 characters", nameOption)
    .addOption(new Option("--enable", "Let the link create and recover screens again").conflicts(["disable"]))
    .addOption(new Option("--disable", "Stop creating and recovering screens; devices show their pairing code").conflicts(["enable"]))
    .addOption(new Option("--tag <TAG>", "Replace the tags new screens get (repeatable, or comma-separated; at most 16)").argParser(fleetLinkTags).conflicts(["clearTags"]))
    .addOption(new Option("--clear-tags", "New screens get no tags").conflicts(["tag"]))
    .addOption(new Option("--playlist-id <ID>", "Assign this playlist to each new screen").argParser(fleetLinkPlaylistId).conflicts(["clearPlaylist"]))
    .addOption(new Option("--clear-playlist", "New screens get no playlist").conflicts(["playlistId"]))
    .addOption(new Option("--max-screens <N>", "Create at most N screens in all, 1 to 10000").argParser(fleetLinkMaxScreens).conflicts(["clearMaxScreens"]))
    .addOption(new Option("--clear-max-screens", "Remove the cap; only the project's screen limit applies").conflicts(["maxScreens"]))
    .option("--expect-rev <REVISION>", "Optionally require this fleet link revision", revision)
    .action(bind(handleFleetLinksUpdate));
  requireOptionGroup(update, "atLeastOne", ["--name", "--enable", "--disable", "--tag", "--clear-tags", "--playlist-id", "--clear-playlist", "--max-screens", "--clear-max-screens"]);

  links.command("rotate").description("Replace a fleet link's URL; the old URL stops working at once")
    .argument("<id>", "Fleet link identifier")
    .option("--expect-rev <REVISION>", "Optionally require this fleet link revision", revision)
    .action(bind(handleFleetLinksRotate));

  links.command("delete").description("Delete a fleet link; its URL stops working and its screens stay")
    .argument("<id>", "Fleet link identifier")
    .option("--expect-rev <REVISION>", "Optionally require this fleet link revision", revision)
    .action(bind(handleFleetLinksDelete));
}
