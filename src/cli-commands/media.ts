import { positiveInteger, positiveNumber, revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleSelectorPreview, handleMediaGenerate, handleMediaUpload, handleMediaUploadBatch, handleMediaShow, handleMediaDownload, handleMediaList, handleMediaUpdate, handleMediaDelete, handleMediaMove, handleMediaFolderList, handleMediaFolderShow, handleMediaFolderCreate, handleMediaFolderUpdate, handleMediaFolderDelete } from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes, addCommandExamples, requireOptionGroup } from "./notes.js";
import { CREDIT_HELP } from "../help-text.js";

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
    .option("--folder <ID>", "Move the uploaded media into this folder (mfd_...) once it is ready")
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

  media.command("upload-batch").description("Upload a manifest with resumable state")
    .argument("<manifest.json>", "Upload manifest file")
    .option("--state <FILE>", "Override the automatic private resumable state file")
    .option("--concurrency <N>", "Set concurrent batch uploads", positiveInteger("concurrency"))
    .addOption(new Option("--no-transcode", "Upload accepted source bytes unchanged").conflicts(["codec", "maxFps", "maxEdge", "webpQuality", "preset", "audio"]))
    .option("--tag <TAG>", "Set the media tag")
    .option("--folder <ID>", "Move every uploaded item into this folder (mfd_...)")
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
    .action(bind(handleSelectorPreview));
  addCommandExamples(selectorPreview, 'screenrig media selector-preview selector.json --primitive video');
  addCommandNotes(selectorPreview, "The file holds one playlist media selector: {\"by\": \"all\"}, {\"by\": \"tag\", \"tag\": \"Lobby\"}, {\"by\": \"id\", \"media_id\": \"med_...\"} or {\"by\": \"ids\", \"media_ids\": [\"med_...\"]}; all and tag also take order (filename or random), batch_size and one_at_a_time. Reads current project-owned ready matches in filename order. Does not advance a Player cursor. Random order is a per-pass playback policy; see the returned normalized selector. Catalog changes take effect at the next loop refresh.");

  media.command("update").description("Replace media tags")
    .argument("<id>", "Media identifier")
    .addOption(new Option("--tag <TAG>", "Set the media tag").conflicts(["clearTag", "tags"]))
    .addOption(new Option("--clear-tag", "Remove the media tag").conflicts(["tag", "tags"]))
    .addOption(new Option("--tags <TAGS>", "Replace the tag set with comma-separated tags").conflicts(["tag", "clearTag"]))
    .option("--expect-rev <REVISION>", "Optionally require this resource revision", revision)
    .action(bind(handleMediaUpdate));

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
}
