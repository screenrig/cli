import { nonnegativeInteger, positiveInteger, revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handlePlaylistInit, handlePlaylistValidate, handlePlaylistPreview, handlePlaylistTemplates, handlePlaylistCreate, handlePlaylistUpdate, handlePlaylistExport, handlePlaylistImport, handlePlaylistShow, handlePlaylistList, handlePlaylistDelete } from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes, addCommandExamples, requireOptionGroup } from "./notes.js";
import { LOOK_AT_THE_CONTACT_SHEET } from "../playlist-preview.js";

export function registerPlaylistCommands(root: Command, bind: CommandActionBinder): void {
  const playlist = root.command("playlist").description("Author, validate, preview, and manage playlists");

  const init = playlist.command("init").description("Prepare an editable playlist from files, ready media, application releases, or HTTPS URLs")
    .argument("<inputs...>", "Local image/video files, med_ IDs, rel_ IDs, or HTTPS URLs in playback order")
    .requiredOption("--name <NAME>", "Playlist name")
    .requiredOption("--output <FILE>", "Create an editable playlist file")
    .option("--screen <ID>", "Use this screen's reported playback dimensions")
    .option("--target-width <PX>", "Override canvas width", positiveInteger("target-width"))
    .option("--target-height <PX>", "Override canvas height", positiveInteger("target-height"))
    .addOption(new Option("--duration-ms <MS>", "Non-video page duration").argParser(positiveInteger("duration-ms")).default(8000))
    .addOption(new Option("--fit <FIT>", "Content fit").choices(["contain", "cover", "fill"]).default("contain"))
    .option("--no-transcode", "Upload accepted file bytes unchanged")
    .option("--no-progress", "Suppress upload progress on stderr")
    .option("--poll-ms <MS>", "Upload polling interval", positiveInteger("poll-ms"))
    .action(bind(handlePlaylistInit));
  requireOptionGroup(init, "together", ["--target-width", "--target-height"]);
  addCommandNotes(init, "Provide --screen for target identity, revision, and reported dimensions, or both target dimensions. Files upload and wait for readiness. Release IDs are pinned; preview/server validation checks availability. Inspect the document and preview before publishing.");
  addCommandExamples(init, 'screenrig playlist init med_IMAGE --name Lobby --screen scr_SCREEN --output lobby.json',
    'screenrig playlist init med_IMAGE med_VIDEO --name Lobby --target-width 1920 --target-height 1080 --output lobby.json');

  playlist.command("validate").description("Validate a playlist file")
    .argument("<file>", "Local input file")
    .option("--lint-only", "Run the command's local validation/lint mode")
    .action(bind(handlePlaylistValidate));

  addCommandNotes(playlist.command("preview").description("Render playlist previews and a contact sheet")
    .argument("<file|id>", "Playlist file or playlist identifier")
    .requiredOption("--output <PATH>", "Write preview files to this directory (required)")
    .option("--frame-ms <MS>", "Select the preview frame time", nonnegativeInteger("frame-ms"))
    .option("--contact-sheet", "Include a contact sheet")
    .option("--lint-only", "Run the command's local validation/lint mode")
    .action(bind(handlePlaylistPreview)), LOOK_AT_THE_CONTACT_SHEET);

  playlist.command("templates").description("Browse playlist templates")
    .action(bind(handlePlaylistTemplates));

  playlist.command("create").description("Create a playlist from a file")
    .argument("<file>", "Local input file")
    .action(bind(handlePlaylistCreate));

  playlist.command("update").description("Update a playlist")
    .argument("<id>", "Playlist identifier")
    .argument("<file>", "Local input file")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handlePlaylistUpdate));

  playlist.command("export").description("Export a playlist bundle")
    .argument("<id>", "Playlist identifier")
    .requiredOption("--output <PATH>", "Write the exported bundle to this directory (required)")
    .action(bind(handlePlaylistExport));

  const importCommand = playlist.command("import").description("Import a playlist bundle")
    .argument("<directory>", "Local directory")
    .option("--name <NAME>", "Set the imported playlist name")
    .option("--update <ID>", "Update this playlist when importing")
    .option("--expect-rev <REVISION>", "Require the current resource revision", revision)
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .action(bind(handlePlaylistImport));
  requireOptionGroup(importCommand, "together", ["--update", "--expect-rev"]);

  const show = playlist.command("show").description("Inspect a playlist or write an editable document")
    .option("--output <FILE>", "Create an editable playlist file; report its revision on stdout")
    .option("--editable", "Return an editable document and revision in the JSON envelope")
    .alias("get")
    .argument("<id>", "Playlist identifier")
    .action(bind(handlePlaylistShow));
  addCommandExamples(show, 'screenrig playlist show pl_PLAYLIST --output playlist.json',
    'screenrig playlist show pl_PLAYLIST --editable');

  playlist.command("list").description("List playlists")
    .action(bind(handlePlaylistList));

  playlist.command("delete").description("Delete a playlist")
    .argument("<id>", "Playlist identifier")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handlePlaylistDelete));
}
