import { positiveInteger, positiveNumber, revision, reviewNoteOption } from "./options.js";
import { handleMediaReplace, handleMediaRestore, handleMediaVersionDelete, handleMediaVersions } from "../media-versions.js";
import type { CommandActionBinder } from "./types.js";
import { handleSelectorPreview, handleMediaUpload, handleMediaUploadBatch, handleMediaShow, handleMediaDownload, handleMediaList, handleMediaUpdate, handleMediaAvailability, handleMediaDelete, handleMediaMove, handleMediaFolderList, handleMediaFolderShow, handleMediaFolderCreate, handleMediaFolderUpdate, handleMediaFolderDelete } from "../handlers/media.js";
import { type Command, Option } from "commander";
import { SIGNAGE_PRESETS } from "../media/video-profile.js";
import { addCommandNotes, addCommandExamples, requireOptionGroup } from "./notes.js";
import { connectionIdOption } from "../connection-ids.js";
import {
  handleMediaSyncAccountAdd, handleMediaSyncAccountAddDropbox, handleMediaSyncAccountAddGoogleDrive, handleMediaSyncAccountConnect, handleMediaSyncAccountDelete,
  handleMediaSyncAccountList, handleMediaSyncAccountShow, handleMediaSyncAccountTest, handleMediaSyncAccountUpdate, handleMediaSyncCreate,
  handleMediaSyncCreateDropbox, handleMediaSyncCreateGoogleDrive,
  handleMediaSyncDelete, handleMediaSyncList, handleMediaSyncRun, handleMediaSyncShow, handleMediaSyncUpdate,
  mediaSyncAccountOption, mediaSyncAppKey, mediaSyncClientId, mediaSyncDriveUrl, mediaSyncDropboxUrl, mediaSyncEvery, mediaSyncFolderOption, mediaSyncName, mediaSyncTenant, mediaSyncUrl,
} from "../media-sync.js";

const REPLACE_NOTE_HELP = "Note kept with the new version and shown to a person who reviews it (at most 280 characters)";
const SECRET_FILE = "Read the client secret's value from this file, or - for stdin (never an argument)";
const KEY_FILE = "Read your own Google Cloud service account's JSON key file from this file, or - for stdin (never an argument)";

/** The options every media sync create command takes after --account-id and --url. */
function syncCreateOptions(command: Command): Command {
  return command
    .option("--folder-id <ID>", "The media folder the files land in (mfd_...); omitted creates one named after the source folder", mediaSyncFolderOption)
    .option("--every <DURATION>", "How often to look for changes, 5 minutes to 24 hours (default 15m)", mediaSyncEvery)
    .option("--name <NAME>", "Name the sync, 1 to 80 characters (default: the source folder's name)", mediaSyncName);
}

export function registerMediaCommands(root: Command, bind: CommandActionBinder): void {
  const media = root.command("media").description("Upload and manage images, videos, and soundtrack audio");

  media.command("upload").description("Upload an image, video, or audio track")
    .argument("<file>", "Local input file")
    .option("--content-type <TYPE>", "Declare the content MIME type")
    .option("--tag <TAG>", "Set the media tag")
    .option("--folder <ID>", "Upload into this media folder (mfd_...): the file lands there when it is ready. An uploader must name one of its folders")
    .option("--no-wait", "Return after acceptance without waiting for processing")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .addOption(new Option("--no-transcode", "Upload accepted source bytes unchanged").conflicts(["codec", "maxFps", "maxEdge", "webpQuality", "preset", "audio"]))
    .addOption(new Option("--codec <h264|hevc>", "Choose the video codec").choices(["h264", "hevc"]).default("h264").conflicts(["transcode"]))
    .addOption(new Option("--max-fps <N>", "Constant output frame rate; every video is encoded at exactly this rate (default 30, or the preset's)").argParser(positiveNumber("max-fps")).conflicts(["transcode"]))
    .addOption(new Option("--max-edge <PIXELS>", "Fit both edges of a video or image within PIXELS, up to 3840 (default: video fits 1920x1080, images 3840; --max-edge 3840 keeps 4K video)").argParser(positiveInteger("max-edge")).conflicts(["transcode"]))
    .addOption(new Option("--webp-quality <1-100>", "Set WebP quality").argParser(positiveInteger("webp-quality")).conflicts(["transcode"]))
    .option("--no-progress", "Suppress stderr progress")
    .addOption(new Option("--preset <PRESET>", "Video size and one constant rate: signage-1080p30, signage-1080p60 or signage-4k30 (default: fit 1920x1080 at 30 fps)").choices([...SIGNAGE_PRESETS]).conflicts(["transcode"]))
    .addOption(new Option("--no-audio", "Remove the audio track when transcoding").conflicts(["transcode"]))
    .action(bind(handleMediaUpload));

  media.command("replace").description("Replace a media item's file in place; its id, playlists and schedules keep working")
    .argument("<id>", "Media identifier (med_...)")
    .argument("<file>", "Local input file, the same kind as the media (image, video or audio)")
    .option("--expect-rev <REVISION>", "Optionally require this media revision", revision)
    .option("--note <TEXT>", REPLACE_NOTE_HELP, reviewNoteOption)
    .option("--content-type <TYPE>", "Declare the content MIME type")
    .option("--no-wait", "Return after acceptance without waiting for processing")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .addOption(new Option("--no-transcode", "Upload accepted source bytes unchanged").conflicts(["codec", "maxFps", "maxEdge", "webpQuality", "preset", "audio"]))
    .addOption(new Option("--codec <h264|hevc>", "Choose the video codec").choices(["h264", "hevc"]).default("h264").conflicts(["transcode"]))
    .addOption(new Option("--max-fps <N>", "Constant output frame rate; every video is encoded at exactly this rate (default 30, or the preset's)").argParser(positiveNumber("max-fps")).conflicts(["transcode"]))
    .addOption(new Option("--max-edge <PIXELS>", "Fit both edges of a video or image within PIXELS, up to 3840 (default: video fits 1920x1080, images 3840; --max-edge 3840 keeps 4K video)").argParser(positiveInteger("max-edge")).conflicts(["transcode"]))
    .addOption(new Option("--webp-quality <1-100>", "Set WebP quality").argParser(positiveInteger("webp-quality")).conflicts(["transcode"]))
    .option("--no-progress", "Suppress stderr progress")
    .addOption(new Option("--preset <PRESET>", "Video size and one constant rate: signage-1080p30, signage-1080p60 or signage-4k30 (default: fit 1920x1080 at 30 fps)").choices([...SIGNAGE_PRESETS]).conflicts(["transcode"]))
    .addOption(new Option("--no-audio", "Remove the audio track when transcoding").conflicts(["transcode"]))
    .action(bind(handleMediaReplace));

  media.command("versions").description("List a media item's versions, the file in service first")
    .argument("<id>", "Media identifier (med_...)")
    .option("--limit <N>", "Read one page of this many versions, 1 to 100", positiveInteger("limit"))
    .option("--cursor <CURSOR>", "Read the page after the data.next_cursor of the previous page")
    .action(bind(handleMediaVersions));

  media.command("restore").description("Put a past version back in service, as a new version")
    .argument("<id>", "Media identifier (med_...)")
    .requiredOption("--number <N>", "Version number to put back, as media versions lists it (required)", positiveInteger("number"))
    .option("--expect-rev <REVISION>", "Optionally require this media revision", revision)
    .option("--note <TEXT>", REPLACE_NOTE_HELP, reviewNoteOption)
    .action(bind(handleMediaRestore));

  const version = media.command("version").description("Manage one stored version of a media item");
  version.command("delete").description("Delete a past version and its stored bytes")
    .argument("<id>", "Media identifier (med_...)")
    .requiredOption("--number <N>", "Version number to delete, as media versions lists it (required)", positiveInteger("number"))
    .action(bind(handleMediaVersionDelete));

  media.command("upload-batch").description("Upload a manifest with resumable state")
    .argument("<manifest.json>", "Upload manifest file")
    .option("--state <FILE>", "Override the automatic private resumable state file")
    .option("--concurrency <N>", "Set concurrent batch uploads", positiveInteger("concurrency"))
    .addOption(new Option("--no-transcode", "Upload accepted source bytes unchanged").conflicts(["codec", "maxFps", "maxEdge", "webpQuality", "preset", "audio"]))
    .option("--tag <TAG>", "Set the media tag")
    .option("--folder <ID>", "Upload every item into this media folder (mfd_...); an uploader must name one of its folders")
    .option("--no-progress", "Suppress stderr progress")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .addOption(new Option("--codec <h264|hevc>", "Choose the video codec").choices(["h264", "hevc"]).default("h264").conflicts(["transcode"]))
    .addOption(new Option("--max-fps <N>", "Constant output frame rate; every video is encoded at exactly this rate (default 30, or the preset's)").argParser(positiveNumber("max-fps")).conflicts(["transcode"]))
    .addOption(new Option("--max-edge <PIXELS>", "Fit both edges of a video or image within PIXELS, up to 3840 (default: video fits 1920x1080, images 3840; --max-edge 3840 keeps 4K video)").argParser(positiveInteger("max-edge")).conflicts(["transcode"]))
    .addOption(new Option("--webp-quality <1-100>", "Set WebP quality").argParser(positiveInteger("webp-quality")).conflicts(["transcode"]))
    .addOption(new Option("--preset <PRESET>", "Video size and one constant rate: signage-1080p30, signage-1080p60 or signage-4k30 (default: fit 1920x1080 at 30 fps)").choices([...SIGNAGE_PRESETS]).conflicts(["transcode"]))
    .addOption(new Option("--no-audio", "Remove the audio track when transcoding").conflicts(["transcode"]))
    .action(bind(handleMediaUploadBatch));

  media.command("show").description("Inspect media")
    .argument("<id>", "Media identifier")
    .action(bind(handleMediaShow));

  media.command("download").description("Download media to a file")
    .argument("<id>", "Media identifier")
    .option("--output <PATH>", "Write downloaded media to this file")
    .action(bind(handleMediaDownload));

  media.command("list").description("List media")
    .option("--tag <TAG>", "Filter media by tag")
    .addOption(new Option("--primitive <image|video|audio>", "Filter by media primitive").choices(["image", "video", "audio"]))
    .option("--folder <ID|root>", "Only files directly in this folder (mfd_...), or root for the library root")
    .option("--library", "List the organization Library's media instead (read-only)")
    .action(bind(handleMediaList));

  const selectorPreview = media.command("selector-preview").description("Preview current selector matches without advancing playback")
    .argument("<selector.json>", "JSON all/tag/folder selector file, or stdin (-)")
    .addOption(new Option("--primitive <image|video>", "Media primitive to match (required)").choices(["image", "video"]).makeOptionMandatory())
    .option("--rect <WxH>", "Size of the primitive's rect, for example 1080x1920; required when the selector has fit aspect")
    .option("--timezone <IANA>", "Time zone the files' availability rules are read in, for example America/New_York (default UTC)")
    .action(bind(handleSelectorPreview));
  addCommandExamples(selectorPreview, 'screenrig media selector-preview selector.json --primitive video', 'screenrig media selector-preview selector.json --primitive image --timezone America/New_York');
  addCommandNotes(selectorPreview, "The file holds one playlist media selector: {\"by\": \"all\"}, {\"by\": \"tag\", \"tag\": \"Lobby\"} or {\"by\": \"folder\", \"folder_id\": \"mfd_...\"}; each also takes order (filename, random or weighted), batch_size and one_at_a_time. Order weighted rotates one item per visit by weights, a map keyed by media id or tag:NAME to an integer 1 to 1000 (up to 64 keys; one_at_a_time or batch_size 1 is required): an item's weight is its media-id key, else the first tag:NAME key it carries (alphabetically), that weight split equally among the items sharing it, else 1. The preview returns each item's expected share of plays and the cycle length. fit aspect keeps only files whose aspect ratio is within 5% of the primitive's rect (--rect WxH); the others return in excluded with reason aspect_mismatch. A tag or tags entry may be {screen.field.NAME} or {screen.id}, which a screen fills with its own value; the server cannot fill them, so such a selector cannot be previewed. A file whose availability rule (media availability) does not hold now, read in --timezone, returns in excluded with reason outside_window. Reads current project-owned ready matches in filename order. Does not advance a Player cursor. Random order is a per-pass playback policy; see the returned normalized selector. Catalog changes take effect at the next loop refresh.");

  media.command("update").description("Replace media tags")
    .argument("<id>", "Media identifier")
    .addOption(new Option("--tag <TAG>", "Set the media tag").conflicts(["clearTag", "tags"]))
    .addOption(new Option("--clear-tag", "Remove the media tag").conflicts(["tag", "tags"]))
    .addOption(new Option("--tags <TAGS>", "Replace the tag set with comma-separated tags").conflicts(["tag", "clearTag"]))
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleMediaUpdate));

  const availability = media.command("availability").description("Set or clear when dynamic selectors may play a media file")
    .argument("<id>", "Media identifier (med_...)")
    .option("--file <RULE.json>", "Read the availability rule from this JSON file, or - for stdin")
    .option("--clear", "Remove the rule: the file is always available")
    .option("--expect-rev <REVISION>", "Require this media revision (default: the current revision, read first)", revision)
    .action(bind(handleMediaAvailability));
  requireOptionGroup(availability, "exactlyOne", ["--file", "--clear"]);

  media.command("delete").description("Delete media")
    .argument("<id>", "Media identifier")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleMediaDelete));
  requireOptionGroup(media.commands.find(command => command.name() === "update")!, "exactlyOne", ["--tag", "--tags", "--clear-tag"]);

  const move = media.command("move").description("Move media files and folders into a folder, or back to the library root")
    .argument("<ids...>", "Media (med_...) and folder (mfd_...) identifiers, at most 1000")
    .option("--folder <ID>", "Destination folder (mfd_...)")
    .option("--root", "Move to the library root")
    .action(bind(handleMediaMove));
  requireOptionGroup(move, "exactlyOne", ["--folder", "--root"]);

  const folder = media.command("folder").description("List, create, rename, move, and delete media library folders");
  folder.command("list").description("List the project's media folders; parent_id builds the tree")
    .option("--library", "List the organization Library's folders instead (read-only)")
    .action(bind(handleMediaFolderList));
  folder.command("show").description("Inspect a media folder")
    .argument("<id>", "Media folder identifier (mfd_...)")
    .action(bind(handleMediaFolderShow));
  folder.command("create").description("Create a media folder at the library root or inside another folder")
    .requiredOption("--name <NAME>", "Folder name, 1 to 100 characters")
    .option("--parent <ID>", "Create it inside this folder (mfd_...); omitted creates it at the library root")
    .action(bind(handleMediaFolderCreate));
  const update = folder.command("update").description("Rename a media folder or move it, with everything inside, into another folder")
    .argument("<id>", "Media folder identifier (mfd_...)")
    .option("--name <NAME>", "New folder name, 1 to 100 characters")
    .addOption(new Option("--parent <ID>", "Move it inside this folder (mfd_...)").conflicts("root"))
    .addOption(new Option("--root", "Move it to the library root").conflicts("parent"))
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleMediaFolderUpdate));
  requireOptionGroup(update, "atLeastOne", ["--name", "--parent", "--root"]);
  folder.command("delete").description("Delete a media folder; its files and folders move up one level")
    .argument("<id>", "Media folder identifier (mfd_...)")
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleMediaFolderDelete));

  const sync = media.command("sync").description("Keep a SharePoint, OneDrive for work, Dropbox or Google Drive folder in step with a media folder");
  addCommandNotes(sync, [
    "Media sync:",
    "  A sync imports the images, videos and audio directly inside a SharePoint,",
    "  OneDrive for work, Dropbox or Google Drive folder into a media folder,",
    "  and keeps them in step: a changed file replaces its bytes under the same media",
    "  ID, so every playlist that plays it updates, and a file removed at the source",
    "  is taken out of play. Each sync reads through an account of the project:",
    "  SharePoint and OneDrive for work read through your own Microsoft Entra app:",
    "  application permission Sites.Selected, granted on each site, or Files.Read.All,",
    "  with admin consent. The client secret is sealed on the server and never shown.",
    "  An account may instead read through a Microsoft connection of the project",
    "  (--connection-id; connection create microsoft), which holds the app once for",
    "  data sources and Power BI too, in either mode.",
    "  Dropbox reads through the Dropbox account of a person, who allows read-only",
    "  access by opening a one-time link (account add dropbox prints it, account connect",
    "  makes a new one), to screenRIG's Dropbox app or your own (--app-key).",
    "  Google Drive reads the folders shared with a service account's address (Viewer",
    "  is enough): screenRIG's, or your own with a JSON key file (--key-file; the key",
    "  is sealed on the server and never shown). account add google-drive prints the",
    "  address.",
    "  Play the media folder with a folder selector in a playlist.",
  ].join("\n"));

  const account = sync.command("account").description("Add, connect, test and manage the accounts a project's syncs read through: a Microsoft Entra app, a Dropbox account or a Google Drive service account");
  const add = account.command("add").description("Add an account a sync reads through");
  const addMicrosoft = add.command("microsoft365").description("Add a Microsoft Entra app: its tenant, application id and a client secret, or a Microsoft connection of this project")
    .requiredOption("--name <NAME>", "Name the account, 1 to 80 characters", mediaSyncName)
    .option("--tenant-id <TENANT>", "Your organization's directory (tenant) id, or its primary domain such as contoso.onmicrosoft.com", mediaSyncTenant)
    .option("--client-id <ID>", "The app registration's application (client) id", mediaSyncClientId)
    .option("--secret-file <FILE>", `${SECRET_FILE}; the file holds only the secret's Value`)
    .addOption(new Option("--connection-id <ID>", "Sign in through a Microsoft connection of this project, in either mode (pcn_..., screenrig connection list), instead of --tenant-id, --client-id and --secret-file").argParser(connectionIdOption).conflicts(["tenantId", "clientId", "secretFile"]))
    .action(bind(handleMediaSyncAccountAdd));
  requireOptionGroup(addMicrosoft, "exactlyOne", ["--connection-id", "--tenant-id"]);
  requireOptionGroup(addMicrosoft, "together", ["--tenant-id", "--client-id", "--secret-file"]);
  add.command("dropbox").description("Add a Dropbox account: prints the link the person who owns it opens, signed in to Dropbox, to connect it")
    .requiredOption("--name <NAME>", "Name the account, 1 to 80 characters", mediaSyncName)
    .option("--app-key <KEY>", "The app key of your own Dropbox app (never its app secret); omitted: screenRIG's Dropbox app", mediaSyncAppKey)
    .action(bind(handleMediaSyncAccountAddDropbox));
  add.command("google-drive").description("Add a Google Drive account: the service account address folders are shared with, screenRIG's or your own")
    .requiredOption("--name <NAME>", "Name the account, 1 to 80 characters", mediaSyncName)
    .option("--key-file <FILE>", `${KEY_FILE}; omitted: the account reads through screenRIG's service account`)
    .action(bind(handleMediaSyncAccountAddGoogleDrive));
  account.command("list").description("List this project's media sync accounts").action(bind(handleMediaSyncAccountList));
  account.command("show").description("Inspect one account and its last test")
    .argument("<id>", "Account identifier (msa_...)").action(bind(handleMediaSyncAccountShow));
  const accountUpdate = account.command("update").description("Change an account's name, tenant, application id, client secret or Google Drive key")
    .argument("<id>", "Account identifier (msa_...)")
    .option("--name <NAME>", "Rename the account", mediaSyncName)
    .option("--tenant-id <TENANT>", "The tenant's directory id or primary domain", mediaSyncTenant)
    .option("--client-id <ID>", "The app registration's application (client) id", mediaSyncClientId)
    .option("--secret-file <FILE>", `${SECRET_FILE}; it replaces the stored secret`)
    .option("--key-file <FILE>", `${KEY_FILE}; it replaces a Google Drive account's own key`)
    .option("--expect-rev <REVISION>", "Optionally require this account revision", revision)
    .action(bind(handleMediaSyncAccountUpdate));
  requireOptionGroup(accountUpdate, "atLeastOne", ["--name", "--tenant-id", "--client-id", "--secret-file", "--key-file"]);
  requireOptionGroup(accountUpdate, "atMostOne", ["--secret-file", "--key-file"]);
  account.command("connect").description("Make a new link to connect (or reconnect) a Dropbox account; send it to the person who owns the Dropbox account")
    .argument("<id>", "Account identifier (msa_...)").action(bind(handleMediaSyncAccountConnect));
  account.command("test").description("Check an account: a Microsoft app's sign-in and Graph permissions, or the connection or key of a Dropbox or Google Drive account")
    .argument("<id>", "Account identifier (msa_...)").action(bind(handleMediaSyncAccountTest));
  account.command("delete").description("Delete an account no sync uses")
    .argument("<id>", "Account identifier (msa_...)")
    .option("--expect-rev <REVISION>", "Optionally require this account revision", revision)
    .action(bind(handleMediaSyncAccountDelete));

  const create = sync.command("create").description("Start keeping a folder in step with a media folder");
  syncCreateOptions(create.command("sharepoint").description("Sync a SharePoint or OneDrive for work folder")
    .requiredOption("--account-id <ID>", "The account to read through (msa_...)", mediaSyncAccountOption)
    .requiredOption("--url <URL>", "The folder's SharePoint address, or its sharing link", mediaSyncUrl))
    .action(bind(handleMediaSyncCreate));
  syncCreateOptions(create.command("dropbox").description("Sync a Dropbox folder")
    .requiredOption("--account-id <ID>", "The connected Dropbox account to read through (msa_...)", mediaSyncAccountOption)
    .requiredOption("--url <URL|PATH>", "The folder's Dropbox address, a shared folder link the account has added to its Dropbox, or a path that starts with /", mediaSyncDropboxUrl))
    .action(bind(handleMediaSyncCreateDropbox));
  syncCreateOptions(create.command("google-drive").description("Sync a Google Drive folder shared with an account's service account")
    .requiredOption("--account-id <ID>", "The Google Drive account to read through (msa_...)", mediaSyncAccountOption)
    .requiredOption("--url <URL|ID>", "The folder's Google Drive address (https://drive.google.com/drive/folders/ID), or its id", mediaSyncDriveUrl))
    .action(bind(handleMediaSyncCreateGoogleDrive));
  sync.command("list").description("List this project's media syncs").action(bind(handleMediaSyncList));
  sync.command("show").description("Inspect one sync and what its last run did")
    .argument("<id>", "Sync identifier (msy_...)").action(bind(handleMediaSyncShow));
  const syncUpdate = sync.command("update").description("Change a sync's cadence, name or media folder, or pause and resume it")
    .argument("<id>", "Sync identifier (msy_...)")
    .option("--name <NAME>", "Rename the sync", mediaSyncName)
    .option("--every <DURATION>", "How often to look for changes, 5 minutes to 24 hours", mediaSyncEvery)
    .option("--folder-id <ID>", "Fill this media folder instead (mfd_...)", mediaSyncFolderOption)
    .addOption(new Option("--pause", "Stop running until resumed").conflicts(["resume"]))
    .addOption(new Option("--resume", "Run again; also resumes a sync an error stopped").conflicts(["pause"]))
    .option("--expect-rev <REVISION>", "Optionally require this sync revision", revision)
    .action(bind(handleMediaSyncUpdate));
  requireOptionGroup(syncUpdate, "atLeastOne", ["--name", "--every", "--folder-id", "--pause", "--resume"]);
  sync.command("run").description("Run a sync now instead of at its next time")
    .argument("<id>", "Sync identifier (msy_...)")
    .action(bind(handleMediaSyncRun));
  sync.command("delete").description("Stop a sync; its media and folder stay")
    .argument("<id>", "Sync identifier (msy_...)")
    .option("--expect-rev <REVISION>", "Optionally require this sync revision", revision)
    .action(bind(handleMediaSyncDelete));
}
