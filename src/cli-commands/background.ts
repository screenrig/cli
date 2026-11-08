import { type Command, Option } from "commander";
import { BACKGROUND_ORIENTATIONS, backgroundColor, backgroundId, backgroundOrSetId } from "../backgrounds.js";
import { isResourceID } from "../generated/resource-ids.js";
import {
  handleBackgroundApply, handleBackgroundCategories, handleBackgroundClear, handleBackgroundSets, handleBackgroundShow,
} from "../handlers/background.js";
import { PAGE_ID_PATTERN } from "../playlist-page.js";
import { usageError } from "../problems.js";
import { NOTE_HELP, reviewNoteOption, revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";

function playlistIdOption(value: string): string {
  if (!isResourceID(value, "playlist")) {
    throw usageError("--playlist-id must be a playlist id (pl_...).", { command: "screenrig playlist list", reason: "List this project's playlists and their ids." });
  }
  return value;
}

function pageIdOption(value: string): string {
  if (!PAGE_ID_PATTERN.test(value)) throw usageError("--page-id takes a page id: a letter, then letters, digits, - or _ (at most 64).");
  return value;
}

const COLOR_HELP = "Colour under the image, #RRGGBBAA";

/** A page write's guards: the revision the playlist was read at unless named, and a note for the person who reviews it. */
function pageWriteOptions(command: Command): Command {
  return command
    .option("--expect-rev <REVISION>", "Require this playlist revision (If-Match); without it the write is held to the revision just read", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption);
}

export function registerBackgroundCommands(root: Command, bind: CommandActionBinder): void {
  const background = root.command("background").description("Browse the page background catalog and set a page's background image");
  background.command("categories").description("List the background categories and how many sets each holds")
    .action(bind(handleBackgroundCategories));
  background.command("sets").description("List background sets, by category, search words or orientation")
    .option("--category <ID>", "Only the sets of this category (background categories lists the ids)")
    .option("--search <TEXT>", "Only sets whose name, style or category match every word")
    .addOption(new Option("--orientation <ORIENTATION>", "Only sets with at least one image in this orientation").choices(BACKGROUND_ORIENTATIONS))
    .action(bind(handleBackgroundSets));
  background.command("show").description("Show a set with each of its images, or one background image")
    .argument("<id>", "A set id from background sets, or a background id (bg_...)", backgroundOrSetId)
    .action(bind(handleBackgroundShow));
  pageWriteOptions(background.command("apply").description("Set a page's canvas background to a catalog image")
    .argument("<background-id>", "The background image (bg_...) from background show", backgroundId)
    .requiredOption("--playlist-id <ID>", "The playlist (pl_...) that holds the page", playlistIdOption)
    .requiredOption("--page-id <ID>", "The page to change", pageIdOption)
    .option("--color <RRGGBBAA>", `${COLOR_HELP} (default: the page's current image colour, else the set's first colour, else #000000FF)`, backgroundColor))
    .action(bind(handleBackgroundApply));
  pageWriteOptions(background.command("clear").description("Replace a page's background image with a solid colour")
    .requiredOption("--playlist-id <ID>", "The playlist (pl_...) that holds the page", playlistIdOption)
    .requiredOption("--page-id <ID>", "The page to change", pageIdOption)
    .option("--color <RRGGBBAA>", "The solid colour, #RRGGBBAA (default: the image's colour)", backgroundColor))
    .action(bind(handleBackgroundClear));
}
