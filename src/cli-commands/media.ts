import { positiveInteger, positiveNumber, revision, reviewNoteOption } from "./options.js";
import { handleMediaReplace, handleMediaRestore, handleMediaVersionDelete, handleMediaVersions } from "../media-versions.js";
import type { CommandActionBinder } from "./types.js";
import { handleSelectorPreview, handleMediaGenerate, handleMediaUpload, handleMediaUploadBatch, handleMediaShow, handleMediaDownload, handleMediaList, handleMediaUpdate, handleMediaAvailability, handleMediaDelete, handleMediaMove, handleMediaFolderList, handleMediaFolderShow, handleMediaFolderCreate, handleMediaFolderUpdate, handleMediaFolderDelete } from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes, addCommandExamples, requireOptionGroup } from "./notes.js";
import { CREDIT_HELP } from "../help-text.js";
import {
  CANVA_FORMATS, handleMediaSyncAccountAdd, handleMediaSyncAccountAddCanva, handleMediaSyncAccountConnect, handleMediaSyncAccountDelete, handleMediaSyncAccountDesigns,
  handleMediaSyncAccountList, handleMediaSyncAccountShow, handleMediaSyncAccountTest, handleMediaSyncAccountUpdate, handleMediaSyncCreate, handleMediaSyncCreateCanva,
  handleMediaSyncDelete, handleMediaSyncList, handleMediaSyncRun, handleMediaSyncShow, handleMediaSyncUpdate,
  mediaSyncAccountOption, mediaSyncClientId, mediaSyncDesign, mediaSyncEvery, mediaSyncFolderOption, mediaSyncName, mediaSyncPages, mediaSyncTenant, mediaSyncUrl,
} from "../media-sync.js";

const REPLACE_NOTE_HELP = "Note kept with the new version and shown to a person who reviews it (at most 280 characters)";
const SECRET_FILE = "Read the client secret's value from this file, or - for stdin (never an argument)";

export function registerMediaCommands(root: Command, bind: CommandActionBinder): void {
  const media = root.command("media").description("Generate, upload, and manage images, videos, and soundtrack audio");

  addCommandNotes(media.command("generate").description("Generate an image from a prompt")
    .addOption(new Option("--prompt <TEXT>", "Describe the complete image to generate").conflicts("promptFile"))
    .addOption(new Option("--prompt-file <FILE>", "Read the complete prompt from a file or stdin (-)").conflicts("prompt"))
    .addOption(new Option("--aspect-ratio <RATIO>", "Choose the generated image aspect ratio").choices(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]).default("16:9"))
    .addOption(new Option("--quality <low|medium|high>", "Choose generation quality").choices(["low", "medium", "high"]).default("medium"))
    .option("--tag <TAG>", "Set the media tag")
    .option("--no-progress", "Suppress stderr progress")
    .action(bind(handleMediaGenerate)), CREDIT_HELP);
  const generate = media.commands.find((command) => command.name() === "generate")!;
  requireOptionGroup(generate, "exactlyOne", ["--prompt", "--prompt-file"]);
  addCommandExamples(generate,
    'screenrig media generate --prompt "A full-screen welcome sign"',
    'screenrig media generate --prompt-file prompt.txt --aspect-ratio 9:16');

  media.command("upload").description("Upload an image, video, or audio track")
    .argument("<file>", "Local input file")
    .option("--content-type <TYPE>", "Declare the content MIME type")
    .option("--tag <TAG>", "Set the media tag")
    .option("--folder <ID>", "Upload into this media folder (mfd_...): the file lands there when it is ready. An uploader must name one of its folders")
    .option("--no-wait", "Return after acceptance without waiting for processing")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .addOption(new Option("--no-transcode", "Upload accepted source bytes unchanged").conflicts(["codec", "maxFps", "maxEdge", "webpQuality", "preset", "audio"]))
    .addOption(new Option("--codec <h264|hevc>", "Choose the video codec").choices(["h264", "hevc"]).default("h264").conflicts(["transcode"]))
    .addOption(new Option("--max-fps <N>", "Constant output frame rate; every video is encoded at exactly this rate (default 30)").argParser(positiveNumber("max-fps")).conflicts(["transcode"]))
    .addOption(new Option("--max-edge <PIXELS>", "Limit the longest video edge").argParser(positiveInteger("max-edge")).conflicts(["transcode"]))
    .addOption(new Option("--webp-quality <1-100>", "Set WebP quality").argParser(positiveInteger("webp-quality")).conflicts(["transcode"]))
    .option("--no-progress", "Suppress stderr progress")
    .addOption(new Option("--preset <PRESET>", "Choose a transcoding preset").choices(["signage-1080p30", "signage-4k30"]).conflicts(["transcode"]))
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
    .addOption(new Option("--max-fps <N>", "Constant output frame rate; every video is encoded at exactly this rate (default 30)").argParser(positiveNumber("max-fps")).conflicts(["transcode"]))
    .addOption(new Option("--max-edge <PIXELS>", "Limit the longest video edge").argParser(positiveInteger("max-edge")).conflicts(["transcode"]))
    .addOption(new Option("--webp-quality <1-100>", "Set WebP quality").argParser(positiveInteger("webp-quality")).conflicts(["transcode"]))
    .option("--no-progress", "Suppress stderr progress")
    .addOption(new Option("--preset <PRESET>", "Choose a transcoding preset").choices(["signage-1080p30", "signage-4k30"]).conflicts(["transcode"]))
    .addOption(new Option("--no-audio", "Remove the audio track when transcoding").conflicts(["transcode"]))
    .action(bind(handleMediaReplace));

  media.command("versions").description("List a media item's versions, the file in service first")
    .argument("<id>", "Media identifier (med_...)")
    .option("--limit <N>", "Read one page of this many versions, 1 to 100", positiveInteger("limit"))
    .option("--cursor <CURSOR>", "Read the page after the data.next_cursor of the previous page")
    .action(bind(handleMediaVersions));

  media.command("restore").description("Put a past version back in service, as a new version")
    .argument("<id>", "Media identifier (med_...)")
    .requiredOption("--number <N>", "Version number to put back, as media versions lists it (required; --version N means the same)", positiveInteger("number"))
    .option("--expect-rev <REVISION>", "Optionally require this media revision", revision)
    .option("--note <TEXT>", REPLACE_NOTE_HELP, reviewNoteOption)
    .action(bind(handleMediaRestore));

  const version = media.command("version").description("Manage one stored version of a media item");
  version.command("delete").description("Delete a past version and its stored bytes")
    .argument("<id>", "Media identifier (med_...)")
    .requiredOption("--number <N>", "Version number to delete, as media versions lists it (required; --version N means the same)", positiveInteger("number"))
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
    .addOption(new Option("--max-fps <N>", "Constant output frame rate; every video is encoded at exactly this rate (default 30)").argParser(positiveNumber("max-fps")).conflicts(["transcode"]))
    .addOption(new Option("--max-edge <PIXELS>", "Limit the longest video edge").argParser(positiveInteger("max-edge")).conflicts(["transcode"]))
    .addOption(new Option("--webp-quality <1-100>", "Set WebP quality").argParser(positiveInteger("webp-quality")).conflicts(["transcode"]))
    .addOption(new Option("--preset <PRESET>", "Choose a transcoding preset").choices(["signage-1080p30", "signage-4k30"]).conflicts(["transcode"]))
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
    .action(bind(handleMediaList));

  const selectorPreview = media.command("selector-preview").description("Preview current selector matches without advancing playback")
    .argument("<selector.json>", "JSON all/tag selector file, or stdin (-)")
    .addOption(new Option("--primitive <image|video>", "Media primitive to match (required)").choices(["image", "video"]).makeOptionMandatory())
    .option("--rect <WxH>", "Size of the primitive's rect, for example 1080x1920; required when the selector has fit aspect")
    .option("--timezone <IANA>", "Time zone the files' availability rules are read in, for example America/New_York (default UTC)")
    .action(bind(handleSelectorPreview));
  addCommandExamples(selectorPreview, 'screenrig media selector-preview selector.json --primitive video', 'screenrig media selector-preview selector.json --primitive image --timezone America/New_York');
  addCommandNotes(selectorPreview, "The file holds one playlist media selector: {\"by\": \"all\"}, {\"by\": \"tag\", \"tag\": \"Lobby\"}, {\"by\": \"id\", \"media_id\": \"med_...\"} or {\"by\": \"ids\", \"media_ids\": [\"med_...\"]}; all, tag and folder also take order (filename, random or weighted), batch_size and one_at_a_time. Order weighted rotates one item per visit by weights, a map keyed by media id or tag:NAME to an integer 1 to 1000 (up to 64 keys; one_at_a_time or batch_size 1 is required): an item's weight is its media-id key, else the first tag:NAME key it carries (alphabetically), that weight split equally among the items sharing it, else 1. The preview returns each item's expected share of plays and the cycle length. fit aspect keeps only files whose aspect ratio is within 5% of the primitive's rect (--rect WxH); the others return in excluded with reason aspect_mismatch. A tag or tags entry may be {screen.field.NAME} or {screen.id}, which a screen fills with its own value; the server cannot fill them, so such a selector cannot be previewed. A file whose availability rule (media availability) does not hold now, read in --timezone, returns in excluded with reason outside_window. Reads current project-owned ready matches in filename order. Does not advance a Player cursor. Random order is a per-pass playback policy; see the returned normalized selector. Catalog changes take effect at the next loop refresh.");

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

  // Canva commands stay hidden until the platform has a Canva Connect integration (ENG-6435).
  const sync = media.command("sync").description("Keep a SharePoint or OneDrive for work folder in step with a media folder");
  addCommandNotes(sync, [
    "Media sync:",
    "  A sync imports the images, videos and audio directly inside a SharePoint or",
    "  OneDrive for work folder into a media folder,",
    "  and keeps them in step: a changed file replaces its bytes under the same media",
    "  ID, so every playlist that plays it updates, and a file removed at the source",
    "  is taken out of play.",
    "  SharePoint reads through your own Microsoft Entra app (an account):",
    "  application permission Sites.Selected, granted on each site, or Files.Read.All,",
    "  with admin consent. The client secret is sealed on the server and never shown.",
    "  Play the media folder with a folder selector in a playlist.",
  ].join("\n"));

  const account = sync.command("account").description("Add, test and manage the Microsoft Entra apps a project's syncs read through");
  const add = account.command("add").description("Add the credentials of your own app");
  add.command("microsoft365").description("Add a Microsoft Entra app: its tenant, application id and a client secret")
    .requiredOption("--name <NAME>", "Name the account, 1 to 80 characters", mediaSyncName)
    .requiredOption("--tenant-id <TENANT>", "Your organization's directory (tenant) id, or its primary domain such as contoso.onmicrosoft.com", mediaSyncTenant)
    .requiredOption("--client-id <ID>", "The app registration's application (client) id", mediaSyncClientId)
    .requiredOption("--secret-file <FILE>", `${SECRET_FILE}; the file holds only the secret's Value`)
    .action(bind(handleMediaSyncAccountAdd));
  add.command("canva", { hidden: true }).description("Add a Canva account: prints the link a person opens, signed in to Canva, to connect it")
    .requiredOption("--name <NAME>", "Name the account, 1 to 80 characters", mediaSyncName)
    .action(bind(handleMediaSyncAccountAddCanva));
  account.command("list").description("List this project's media sync accounts").action(bind(handleMediaSyncAccountList));
  account.command("show").description("Inspect one account and its last test")
    .argument("<id>", "Account identifier (msa_...)").action(bind(handleMediaSyncAccountShow));
  const accountUpdate = account.command("update").description("Change an account's name, tenant, application id or client secret")
    .argument("<id>", "Account identifier (msa_...)")
    .option("--name <NAME>", "Rename the account", mediaSyncName)
    .option("--tenant-id <TENANT>", "The tenant's directory id or primary domain", mediaSyncTenant)
    .option("--client-id <ID>", "The app registration's application (client) id", mediaSyncClientId)
    .option("--secret-file <FILE>", `${SECRET_FILE}; it replaces the stored secret`)
    .option("--expect-rev <REVISION>", "Optionally require this account revision", revision)
    .action(bind(handleMediaSyncAccountUpdate));
  requireOptionGroup(accountUpdate, "atLeastOne", ["--name", "--tenant-id", "--client-id", "--secret-file"]);
  account.command("connect", { hidden: true }).description("Make a new link to connect (or reconnect) a Canva account; send it to the person who owns the Canva account")
    .argument("<id>", "Account identifier (msa_...)").action(bind(handleMediaSyncAccountConnect));
  account.command("designs", { hidden: true }).description("List the Canva designs a connected account can see, most recently changed first")
    .argument("<id>", "Account identifier (msa_...)")
    .option("--query <TEXT>", "Only designs that match this text")
    .option("--continuation <TOKEN>", "Read the next page: the continuation of the previous answer")
    .action(bind(handleMediaSyncAccountDesigns));
  account.command("test").description("Check an account: a Microsoft app's sign-in and Graph permissions")
    .argument("<id>", "Account identifier (msa_...)").action(bind(handleMediaSyncAccountTest));
  account.command("delete").description("Delete an account no sync uses")
    .argument("<id>", "Account identifier (msa_...)")
    .option("--expect-rev <REVISION>", "Optionally require this account revision", revision)
    .action(bind(handleMediaSyncAccountDelete));

  const create = sync.command("create").description("Start keeping a folder in step with a media folder");
  create.command("sharepoint").description("Sync a SharePoint or OneDrive for work folder")
    .requiredOption("--account-id <ID>", "The account to read through (msa_...)", mediaSyncAccountOption)
    .requiredOption("--url <URL>", "The folder's SharePoint address, or its sharing link", mediaSyncUrl)
    .option("--folder-id <ID>", "The media folder the files land in (mfd_...); omitted creates one named after the source folder", mediaSyncFolderOption)
    .option("--every <DURATION>", "How often to look for changes, 5 minutes to 24 hours (default 15m)", mediaSyncEvery)
    .option("--name <NAME>", "Name the sync, 1 to 80 characters (default: the source folder's name)", mediaSyncName)
    .action(bind(handleMediaSyncCreate));
  create.command("canva", { hidden: true }).description("Sync a Canva design: its pages as images, or one video")
    .requiredOption("--account-id <ID>", "The connected Canva account (msa_...)", mediaSyncAccountOption)
    .requiredOption("--design <ID|URL>", "The design's id, or its canva.com/design/ID/... address", mediaSyncDesign)
    .option("--pages <PAGES>", "Only these pages, such as 1,3-5 (default: every page)", mediaSyncPages)
    .addOption(new Option("--format <png|mp4>", "png: one image per page. mp4: one video").choices([...CANVA_FORMATS]).default("png"))
    .option("--folder-id <ID>", "The media folder the files land in (mfd_...); omitted creates one named after the design", mediaSyncFolderOption)
    .option("--every <DURATION>", "How often to look for changes, 5 minutes to 24 hours (default 15m)", mediaSyncEvery)
    .option("--name <NAME>", "Name the sync, 1 to 80 characters (default: the design's title)", mediaSyncName)
    .action(bind(handleMediaSyncCreateCanva));
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
    .addOption(new Option("--force", "Canva only: export the design even if Canva reports it unchanged").hideHelp())
    .action(bind(handleMediaSyncRun));
  sync.command("delete").description("Stop a sync; its media and folder stay")
    .argument("<id>", "Sync identifier (msy_...)")
    .option("--expect-rev <REVISION>", "Optionally require this sync revision", revision)
    .action(bind(handleMediaSyncDelete));
}
