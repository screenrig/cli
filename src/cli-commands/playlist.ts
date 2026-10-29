import { NOTE_HELP, positiveInteger, reviewNoteOption, revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handlePlaylistReplaceRelease, handlePlaylistInit, handlePlaylistValidate, handlePlaylistCreate, handlePlaylistUpdate, handlePlaylistPatch, handlePlaylistExport, handlePlaylistImport, handlePlaylistShow, handlePlaylistList, handlePlaylistDelete } from "../handlers/playlist.js";
import { type Command, Option } from "commander";
import { addCommandNotes, addCommandExamples, requireOptionGroup } from "./notes.js";
import { handlePlaylistPromote, handlePlaylistRevisions, handlePlaylistRevisionShow } from "../playlist-revisions.js";
import { handlePlaylistPageAdd, handlePlaylistPageRemove, handlePlaylistPageReplace } from "../playlist-page.js";
import { handlePlaylistFields, handlePlaylistInstances, templateClearOption, templateSetOption } from "../playlist-fields.js";

export function registerPlaylistCommands(root: Command, bind: CommandActionBinder): void {
  const playlist = root.command("playlist").description("Author, validate, and manage playlists");

  const init = playlist.command("init").description("Prepare an editable playlist from files, ready media, application releases, or http(s) URLs")
    .argument("<inputs...>", "Local image/video/audio files, med_ IDs, rel_ IDs, http(s) URLs or pasted <iframe> embed codes (iframe pages) in playback order; audio becomes the soundtrack")
    .requiredOption("--name <NAME>", "Playlist name")
    .requiredOption("--output <FILE>", "Write an editable playlist file")
    .option("--overwrite", "Replace an existing output file atomically with a document built from these inputs")
    .option("--target-width <PX>", "Override canvas width", positiveInteger("target-width"))
    .option("--target-height <PX>", "Override canvas height", positiveInteger("target-height"))
    .addOption(new Option("--duration-ms <MS>", "Non-video page duration (default 8000; 86400000 for application pages)").argParser(positiveInteger("duration-ms")))
    .addOption(new Option("--fit <FIT>", "Content fit").choices(["contain", "cover", "fill"]).default("contain"))
    .option("--no-transcode", "Upload accepted file bytes unchanged")
    .option("--no-progress", "Suppress upload progress on stderr")
    .option("--poll-ms <MS>", "Upload polling interval", positiveInteger("poll-ms"))
    .option("--screen-id <ID>", "Use this screen’s identity, revision, and reported dimensions (a video wall’s canvas and format when it has one)")
    .action(bind(handlePlaylistInit));
  requireOptionGroup(init, "together", ["--target-width", "--target-height"]);
  addCommandNotes(init, "Provide --screen-id for target identity, revision, and reported dimensions, or both target dimensions. Files upload up to four at a time and wait for readiness; data.uploads reports each file's media_id, reused and per-stage timing. Nothing is written until every upload is ready, so an interrupted run leaves no output; rerun the same command and files already uploaded return their existing media IDs. Release IDs are pinned; server validation checks availability, and data.release_ids and data.media_ids report what the document holds. An existing non-empty --output file fails with usage_error (exit 2) and is left untouched; choose a new path or pass --overwrite to rebuild it from these inputs, never publish the old file. Application pages hold for 24 hours (86400000 ms, the contract maximum) unless --duration-ms is given, because an app that rotates internally restarts each time its page advances; an application page set under 60 seconds earns an application_page_short warning here, in playlist validate and in screen publish. Audio inputs become the playlist soundtrack (tracks in input order) instead of pages. A screen with a video wall (screen wall set) uses the wall's canvas and the document carries the matching format {displays, arrangement, orientation, columns for a grid}: each tile is 1920x1080, or 1080x1920 for rotation 90 and 270, a row is that many tiles wide, a column that many tiles high and a grid its columns wide (data.format reports it). Explicit --target-width and --target-height instead make an ordinary playlist that every display mirrors. Inspect the document before publishing. A pasted <iframe> embed code (from Google's Publish to web or Microsoft's Embed dialog) is read for its src and becomes an iframe page; Google Slides, Docs and Sheets and Microsoft 365 Embed links are rebuilt for the screen when the playlist is written, and a Slides deck advances on its link's delay held to --duration-ms (give the page the time of the whole deck).");
  addCommandExamples(init, 'screenrig playlist init med_IMAGE --name Lobby --screen-id scr_SCREEN --output lobby.json',
    'screenrig playlist init med_IMAGE med_VIDEO --name Lobby --target-width 1920 --target-height 1080 --output lobby.json');

  playlist.command("validate").description("Validate a playlist file")
    .argument("<file>", "Playlist JSON file, or - for stdin")
    .action(bind(handlePlaylistValidate));

  const create = playlist.command("create").description("Create a playlist from a file, from a template, or the built-in Urgent notice template")
    .argument("[file]", "Playlist JSON file, or - for stdin")
    .option("--from-template <ID>", "Make the playlist from this template: its current pages with the --set values filled in")
    .option("--starter <KEY>", "Add a built-in template: urgent-notice (a headline and a message)")
    .option("--name <NAME>", "The new playlist's name (required with --from-template)")
    .option("--set <NAME=VALUE>", "With --from-template: a field's value, a media ID for a media field (repeatable)", templateSetOption)
    .option("--dry-run", "With --from-template: check the values and print the page count without creating anything")
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handlePlaylistCreate));
  requireOptionGroup(create, "atMostOne", ["--from-template", "--starter"]);
  requireOptionGroup(create, "requires", ["--set", "--from-template"]);
  requireOptionGroup(create, "requires", ["--dry-run", "--from-template"]);

  const fields = playlist.command("fields").description("Show a template's fields or a copy's values, or change the values and bring the copy up to date")
    .argument("<id>", "Playlist identifier: a template, or a playlist made from one")
    .option("--set <NAME=VALUE>", "Set a field's value (repeatable)", templateSetOption)
    .option("--clear <NAME>", "Clear an optional field's value (repeatable)", templateClearOption)
    .option("--refresh", "Build the pages again from the template's current revision, whatever the values")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handlePlaylistFields));
  addCommandExamples(fields, "screenrig playlist fields pl_TEMPLATE", 'screenrig playlist fields pl_COPY --set headline=Closed');

  playlist.command("instances").description("List the playlists made from a template and the template revision each was built from")
    .argument("<id>", "Template playlist identifier")
    .action(bind(handlePlaylistInstances));

  playlist.command("update").description("Update a playlist")
    .argument("<id>", "Playlist identifier")
    .argument("<file>", "Playlist JSON file, or - for stdin")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handlePlaylistUpdate));

  const patch = playlist.command("patch").description("Change only supplied playlist fields; preserve everything omitted")
    .argument("<id>", "Playlist identifier")
    .argument("[file]", "Partial JSON object containing name, pages, audio or format; - for stdin")
    .option("--name <NAME>", "Set the playlist name without resubmitting its content")
    .option("--clear-audio", "Remove the soundtrack; pages must not retain audio cues")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handlePlaylistPatch));
  addCommandNotes(patch, "Supply a partial JSON file, --name, or --clear-audio. Omitted fields stay unchanged; supplied pages and audio replace the complete value, and audio null clears it. Arrays are not merged. Name-only changes do not revalidate existing content. Page/audio changes are checked together by the server. Review policy and Propose access work as for playlist update; pending_review waits for a person's approval. Use --expect-rev to refuse intervening edits. An interrupted retry uses the same saved write key.");
  addCommandExamples(patch, 'screenrig playlist patch pl_PLAYLIST --name "Cello recordings — 36 tracks" --expect-rev 7',
    'screenrig playlist patch pl_PLAYLIST changes.json --expect-rev 7');

  playlist.command("rename").description("Change a playlist's name without resubmitting its content")
    .argument("<id>", "Playlist identifier")
    .requiredOption("--name <NAME>", "New playlist name")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handlePlaylistPatch));

  const replaceRelease = playlist.command("replace-release").description("Preview or apply one application release replacement and its shared-screen impact")
    .argument("<id>", "Playlist identifier")
    .requiredOption("--page <ID>", "Exact page identifier")
    .requiredOption("--primitive <ID>", "Exact application primitive identifier within the page")
    .requiredOption("--release-id <ID>", "New immutable release identifier")
    .option("--apply", "Apply the reviewed replacement")
    .option("--expect-rev <REVISION>", "Playlist revision from the preview", revision)
    .option("--expect-impact <TOKEN>", "Impact token from the preview")
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handlePlaylistReplaceRelease));
  requireOptionGroup(replaceRelease, "requires", ["--expect-impact", "--apply"]);
  requireOptionGroup(replaceRelease, "requires", ["--expect-rev", "--apply"]);
  requireOptionGroup(replaceRelease, "requires", ["--note", "--apply"]);
  addCommandNotes(replaceRelease, "Defaults to a read-only preview including active and archived assigned screens. Apply writes directly; --expect-impact and --expect-rev are optional guards. Changed impact requires a fresh review. Screen assignments are a snapshot; a supplied playlist revision is checked atomically. Server validates release availability and ownership on apply.");
  addCommandExamples(replaceRelease, 'screenrig playlist replace-release pl_PLAYLIST --page board-page --primitive board --release-id rel_NEW',
    'screenrig playlist replace-release pl_PLAYLIST --page board-page --primitive board --release-id rel_NEW --apply');

  const exportCommand = playlist.command("export").description("Export a playlist bundle")
    .argument("<id>", "Playlist identifier")
    .requiredOption("--output <PATH>", "Write the exported bundle to this directory (required)")
    .option("--skip-applications", "Drop applications and empty or application-controlled pages; report what was skipped")
    .action(bind(handlePlaylistExport));
  addCommandNotes(exportCommand, "Bundles image and video media, soundtrack audio and iframe URLs with their reload_s, fallback_src and navigation_allowlist; dynamic media selectors are snapshotted. Cards, streams and adslot pages stop the export. Applications stop it by default; --skip-applications drops them and empty or application-controlled pages, reports skipped ids, and requires at least one remaining page. For an editable document retaining card and application references in the same project, use playlist show <id> --output playlist.json. Referenced resources stay in that project.");

  const importCommand = playlist.command("import").description("Import a playlist bundle")
    .argument("<directory>", "Local directory")
    .option("--name <NAME>", "Set the imported playlist name")
    .option("--update <ID>", "Update this playlist when importing")
    .option("--expect-rev <REVISION>", "Require the current resource revision", revision)
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handlePlaylistImport));
  requireOptionGroup(importCommand, "requires", ["--expect-rev", "--update"]);

  const show = playlist.command("show").description("Inspect a playlist or write an editable document")
    .option("--output <FILE>", "Create an editable playlist file; report its revision on stdout")
    .option("--editable", "Return an editable document and revision in the JSON envelope")
    .option("--overwrite", "Replace an existing output file atomically")
    .argument("<id>", "Playlist identifier")
    .action(bind(handlePlaylistShow));
  addCommandExamples(show, 'screenrig playlist show pl_PLAYLIST --output playlist.json',
    'screenrig playlist show pl_PLAYLIST --editable');

  playlist.command("list").description("List playlists")
    .option("--templates", "Only templates: playlists that declare fields")
    .action(bind(handlePlaylistList));

  playlist.command("revisions").description("List a playlist's revisions, newest first, one page at a time")
    .argument("<id>", "Playlist identifier")
    .option("--after <CURSOR>", "Continue from the data.next_cursor of the previous page")
    .action(bind(handlePlaylistRevisions));

  const revisionGroup = playlist.command("revision").description("Inspect one stored revision of a playlist");
  revisionGroup.command("show").description("Show one revision and the playlist as it stood at that revision")
    .argument("<id>", "Playlist identifier")
    .requiredOption("--revision <N>", "Revision to show, as playlist revisions numbers it (required)", positiveInteger("revision"))
    .action(bind(handlePlaylistRevisionShow));

  playlist.command("promote").description("Make an earlier revision current again by copying it forward as a new revision")
    .argument("<id>", "Playlist identifier")
    .requiredOption("--revision <N>", "Revision to copy forward, as playlist revisions numbers it (required)", positiveInteger("revision"))
    .requiredOption("--expect-rev <REVISION>", "The playlist's current revision, from playlist show or the current row of playlist revisions (If-Match; required)", revision)
    .action(bind(handlePlaylistPromote));

  const page = playlist.command("page").description("Add, replace or remove one page of a playlist without resending the others");
  const pageAdd = page.command("add").description("Add a page: an uploaded image or video, or a page file")
    .argument("<playlist-id>", "Playlist identifier")
    .option("--file <PAGE.json>", "A page object to add, or - for stdin")
    .option("--media <MED_ID>", "Show this image or video full-canvas, built on the playlist's canvas")
    .option("--seconds <N>", "How long an image shows (default 10); a video plays to its end", positiveInteger("seconds"))
    .addOption(new Option("--fit <FIT>", "How the media fits the canvas (default contain)").choices(["contain", "cover"]))
    .option("--from <WHEN>", "First time the page is shown: YYYY-MM-DDTHH:MM or YYYY-MM-DD (00:00), in each screen's timezone")
    .option("--until <WHEN>", "End of the page's showing: YYYY-MM-DDTHH:MM, or YYYY-MM-DD for the end of that day")
    .option("--before <PAGE_ID>", "Put the page in front of this page (default: at the end)")
    .option("--page-id <ID>", "The new page's id (default: up- and eight letters or digits)")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handlePlaylistPageAdd));
  requireOptionGroup(pageAdd, "exactlyOne", ["--file", "--media"]);
  const pageReplace = page.command("replace").description("Replace one page, keeping its place and id")
    .argument("<playlist-id>", "Playlist identifier")
    .argument("<page-id>", "The page to replace")
    .option("--file <PAGE.json>", "The complete new page, or - for stdin")
    .option("--media <MED_ID>", "Swap the page's media; everything else, dates included, stays as stored. Without --file or --media, only the dates (and --seconds, --fit) change")
    .option("--seconds <N>", "How long an image shows", positiveInteger("seconds"))
    .addOption(new Option("--fit <FIT>", "How the media fits the canvas").choices(["contain", "cover"]))
    .option("--from <WHEN>", "First time the page is shown: YYYY-MM-DDTHH:MM or YYYY-MM-DD (00:00), in each screen's timezone")
    .option("--until <WHEN>", "End of the page's showing: YYYY-MM-DDTHH:MM, or YYYY-MM-DD for the end of that day")
    .option("--always", "Remove the page's dates (from and until); a switch-off or weekly windows the project set stay")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handlePlaylistPageReplace));
  requireOptionGroup(pageReplace, "atMostOne", ["--file", "--media"]);
  requireOptionGroup(pageReplace, "atLeastOne", ["--file", "--media", "--from", "--until", "--always"]);
  const pageRemove = page.command("remove").description("Remove one page")
    .argument("<playlist-id>", "Playlist identifier")
    .argument("<page-id>", "The page to remove")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .option("--note <TEXT>", NOTE_HELP, reviewNoteOption)
    .action(bind(handlePlaylistPageRemove));

  playlist.command("delete").description("Delete a playlist")
    .argument("<id>", "Playlist identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handlePlaylistDelete));
}
