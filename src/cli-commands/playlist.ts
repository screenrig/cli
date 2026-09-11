import { addValueAlias } from "./aliases.js";
import { nonnegativeInteger, positiveInteger, revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handlePlaylistReplaceRelease, handlePlaylistInit, handlePlaylistValidate, handlePlaylistPreview, handlePlaylistTemplates, handlePlaylistCreate, handlePlaylistUpdate, handlePlaylistExport, handlePlaylistImport, handlePlaylistShow, handlePlaylistList, handlePlaylistDelete } from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes, addCommandExamples, requireOptionGroup } from "./notes.js";
import { LOOK_AT_THE_CONTACT_SHEET } from "../playlist-preview.js";

export function registerPlaylistCommands(root: Command, bind: CommandActionBinder): void {
  const playlist = root.command("playlist").description("Author, validate, preview, and manage playlists");

  const init = playlist.command("init").description("Prepare an editable playlist from files, ready media, application releases, or HTTPS URLs")
    .argument("<inputs...>", "Local image/video files, med_ IDs, rel_ IDs, or HTTPS URLs in playback order")
    .requiredOption("--name <NAME>", "Playlist name")
    .requiredOption("--output <FILE>", "Create an editable playlist file")
    .option("--target-width <PX>", "Override canvas width", positiveInteger("target-width"))
    .option("--target-height <PX>", "Override canvas height", positiveInteger("target-height"))
    .addOption(new Option("--duration-ms <MS>", "Non-video page duration").argParser(positiveInteger("duration-ms")).default(8000))
    .addOption(new Option("--fit <FIT>", "Content fit").choices(["contain", "cover", "fill"]).default("contain"))
    .option("--no-transcode", "Upload accepted file bytes unchanged")
    .option("--no-progress", "Suppress upload progress on stderr")
    .option("--poll-ms <MS>", "Upload polling interval", positiveInteger("poll-ms"))
    .action(bind(handlePlaylistInit));
  addValueAlias(init, "--screen-id", "--screen", "Use this screen’s identity, revision, and reported dimensions");
  requireOptionGroup(init, "together", ["--target-width", "--target-height"]);
  addCommandNotes(init, "Provide --screen-id for target identity, revision, and reported dimensions, or both target dimensions. Files upload and wait for readiness. Release IDs are pinned; preview/server validation checks availability. Inspect the document and preview before publishing.");
  addCommandExamples(init, 'screenrig playlist init med_IMAGE --name Lobby --screen-id scr_SCREEN --output lobby.json',
    'screenrig playlist init med_IMAGE med_VIDEO --name Lobby --target-width 1920 --target-height 1080 --output lobby.json');

  playlist.command("validate").description("Validate a playlist file")
    .argument("<file>", "Playlist JSON file, or - for stdin")
    .option("--lint-only", "Run the command's local validation/lint mode")
    .action(bind(handlePlaylistValidate));

  addCommandNotes(playlist.command("preview").description("Render playlist previews and a contact sheet")
    .argument("<file|id>", "Playlist JSON file, playlist identifier, or - for stdin")
    .requiredOption("--output <PATH>", "Write preview files to this directory (required)")
    .option("--frame-ms <MS>", "Select the preview frame time", nonnegativeInteger("frame-ms"))
    .option("--contact-sheet", "Include a contact sheet")
    .option("--lint-only", "Run the command's local validation/lint mode")
    .action(bind(handlePlaylistPreview)), LOOK_AT_THE_CONTACT_SHEET);

  playlist.command("templates").description("Browse playlist templates")
    .action(bind(handlePlaylistTemplates));

  playlist.command("create").description("Create a playlist from a file")
    .argument("<file>", "Playlist JSON file, or - for stdin")
    .action(bind(handlePlaylistCreate));

  playlist.command("update").description("Update a playlist")
    .argument("<id>", "Playlist identifier")
    .argument("<file>", "Playlist JSON file, or - for stdin")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handlePlaylistUpdate));

  const replaceRelease = playlist.command("replace-release").description("Preview or apply one application release replacement and its shared-screen impact")
    .argument("<id>", "Playlist identifier")
    .requiredOption("--page <ID>", "Exact page identifier")
    .requiredOption("--primitive <ID>", "Exact application primitive identifier within the page")
    .requiredOption("--release-id <ID>", "New immutable release identifier")
    .option("--apply", "Apply the reviewed replacement")
    .option("--expect-rev <REVISION>", "Playlist revision from the preview", revision)
    .option("--expect-impact <TOKEN>", "Impact token from the preview")
    .action(bind(handlePlaylistReplaceRelease));
  requireOptionGroup(replaceRelease, "together", ["--apply", "--expect-rev", "--expect-impact"]);
  addCommandNotes(replaceRelease, "Defaults to a read-only preview including active and archived assigned screens. Apply requires the preview revision and impact token. Changed impact requires a fresh review. Screen assignments are a snapshot; only playlist revision is checked atomically. Server validates release availability and ownership on apply.");
  addCommandExamples(replaceRelease, 'screenrig playlist replace-release pl_PLAYLIST --page board-page --primitive board --release-id rel_NEW',
    'screenrig playlist replace-release pl_PLAYLIST --page board-page --primitive board --release-id rel_NEW --apply --expect-rev 4 --expect-impact TOKEN');

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
