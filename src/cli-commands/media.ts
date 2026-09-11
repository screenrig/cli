import { positiveInteger, positiveNumber, revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleMediaGenerate, handleMediaUpload, handleMediaUploadBatch, handleMediaShow, handleMediaDownload, handleMediaList, handleMediaUpdate, handleMediaDelete } from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes, addCommandExamples, requireOptionGroup } from "./notes.js";
import { CREDIT_HELP } from "../help-text.js";

export function registerMediaCommands(root: Command, bind: CommandActionBinder): void {
  const media = root.command("media").description("Generate, upload, and manage images and videos");

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

  media.command("upload").description("Upload an image or video")
    .argument("<file>", "Local input file")
    .option("--content-type <TYPE>", "Declare the content MIME type")
    .option("--tag <TAG>", "Set the media tag")
    .option("--no-wait", "Return after acceptance without waiting for processing")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .addOption(new Option("--no-transcode", "Upload accepted source bytes unchanged").conflicts(["codec", "maxFps", "maxEdge", "webpQuality", "preset", "audio"]))
    .addOption(new Option("--codec <h264|hevc>", "Choose the video codec").choices(["h264", "hevc"]).default("h264").conflicts(["transcode"]))
    .addOption(new Option("--max-fps <N>", "Limit video frames per second").argParser(positiveNumber("max-fps")).conflicts(["transcode"]))
    .addOption(new Option("--max-edge <PIXELS>", "Limit the longest video edge").argParser(positiveInteger("max-edge")).conflicts(["transcode"]))
    .addOption(new Option("--webp-quality <1-100>", "Set WebP quality").argParser(positiveInteger("webp-quality")).conflicts(["transcode"]))
    .option("--no-progress", "Suppress stderr progress")
    .addOption(new Option("--preset <PRESET>", "Choose a transcoding preset").choices(["signage-1080p30", "signage-4k30"]).conflicts(["transcode"]))
    .addOption(new Option("--no-audio", "Remove the audio track when transcoding").conflicts(["transcode"]))
    .action(bind(handleMediaUpload));

  media.command("upload-batch").description("Upload a manifest with resumable state")
    .argument("<manifest.json>", "Upload manifest file")
    .requiredOption("--state <FILE>", "Persist resumable upload state in this file (required)")
    .option("--concurrency <N>", "Set concurrent batch uploads", positiveInteger("concurrency"))
    .addOption(new Option("--no-transcode", "Upload accepted source bytes unchanged").conflicts(["codec", "maxFps", "maxEdge", "webpQuality", "preset", "audio"]))
    .option("--tag <TAG>", "Set the media tag")
    .option("--no-progress", "Suppress stderr progress")
    .option("--poll-ms <MS>", "Set the operation polling interval", positiveInteger("poll-ms"))
    .addOption(new Option("--codec <h264|hevc>", "Choose the video codec").choices(["h264", "hevc"]).default("h264").conflicts(["transcode"]))
    .addOption(new Option("--max-fps <N>", "Limit video frames per second").argParser(positiveNumber("max-fps")).conflicts(["transcode"]))
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
    .addOption(new Option("--primitive <image|video>", "Filter by media primitive").choices(["image", "video"]))
    .action(bind(handleMediaList));

  media.command("update").description("Update a media tag")
    .argument("<id>", "Media identifier")
    .addOption(new Option("--tag <TAG>", "Set the media tag").conflicts(["clearTag"]))
    .addOption(new Option("--clear-tag", "Remove the media tag").conflicts(["tag"]))
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handleMediaUpdate));

  media.command("delete").description("Delete media")
    .argument("<id>", "Media identifier")
    .requiredOption("--expect-rev <REVISION>", "Require the current resource revision (required)", revision)
    .action(bind(handleMediaDelete));
  requireOptionGroup(media.commands.find(command => command.name() === "update")!, "exactlyOne", ["--tag", "--clear-tag"]);
}
