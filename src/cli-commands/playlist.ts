import { usageError } from "../problems.js";
import { nonnegativeInteger, positiveInteger, revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handlePlaylistInit, handlePlaylistValidate, handlePlaylistPreview, handlePlaylistTemplates, handlePlaylistCreate, handlePlaylistUpdate, handlePlaylistExport, handlePlaylistImport, handlePlaylistShow, handlePlaylistList, handlePlaylistDelete } from "../commands.js";
import type { Command } from "commander";
import { addCommandNotes } from "./notes.js";
import { LOOK_AT_THE_CONTACT_SHEET } from "../playlist-preview.js";

export function registerPlaylistCommands(root: Command, bind: CommandActionBinder): void {
  const playlist = root.command("playlist").description("Author, validate, preview, and manage playlists");

  playlist.command("init").description("Prepare an editable full-screen playlist from ready media")
    .argument("<media-ids...>", "Media identifiers in playback order")
    .requiredOption("--name <NAME>", "Playlist name")
    .requiredOption("--output <FILE>", "Create an editable playlist file")
    .option("--screen <ID>", "Use this screen's reported playback dimensions")
    .option("--target-width <PX>", "Override canvas width", positiveInteger("target-width"))
    .option("--target-height <PX>", "Override canvas height", positiveInteger("target-height"))
    .option("--duration-ms <MS>", "Image page duration (default: 8000)", positiveInteger("duration-ms"))
    .option("--fit <FIT>", "Content fit: contain (default), cover, or fill")
    .action(bind(handlePlaylistInit));

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

  playlist.command("import").description("Import a playlist bundle")
    .argument("<directory>", "Local directory")
    .option("--name <NAME>", "Set the imported playlist name")
    .option("--update <ID>", "Update this playlist when importing")
    .option("--expect-rev <REVISION>", "Require the current resource revision", revision)
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .hook("preAction", (command) => {
      const update = command.getOptionValueSource("update") === "cli";
      const ifMatch = command.getOptionValueSource("expectRev") === "cli";
      if (update !== ifMatch) throw usageError("playlist import --update and --expect-rev must be supplied together.");
    })
    .action(bind(handlePlaylistImport));

  playlist.command("show").description("Inspect a playlist or write an editable document")
    .option("--output <FILE>", "Create an editable playlist file; report its revision on stdout")
    .option("--editable", "Return an editable document and revision in the JSON envelope")
    .alias("get")
    .argument("<id>", "Playlist identifier")
    .action(bind(handlePlaylistShow));

  playlist.command("list").description("List playlists")
    .action(bind(handlePlaylistList));

  playlist.command("delete").description("Delete a playlist")
    .argument("<id>", "Playlist identifier")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handlePlaylistDelete));
}
