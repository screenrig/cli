import { requireOptionGroup } from "./notes.js";
import type { CommandActionBinder } from "./types.js";
import { handleCommentShowScreen, handleCommentShowPlaylist, handleCommentSetScreen, handleCommentSetPlaylist, handleCommentDeleteScreen, handleCommentDeletePlaylist } from "../commands.js";
import { type Command, Option } from "commander";

export function registerCommentCommands(root: Command, bind: CommandActionBinder): void {
  const comment = root.command("comment").description("Read and manage screen and playlist comments");

  const commentShow = comment.command("show").description("Read screen or playlist comments");

  commentShow.command("screen").description("Read screen comments")
    .argument("<id>", "Screen or playlist identifier")
    .action(bind(handleCommentShowScreen));

  commentShow.command("playlist").description("Read playlist comments")
    .argument("<id>", "Screen or playlist identifier")
    .option("--page <PAGE_ID>", "Select playlist page comments")
    .action(bind(handleCommentShowPlaylist));

  const commentSet = comment.command("set").description("Replace screen or playlist comments");

  commentSet.command("screen").description("Replace screen comments")
    .argument("<id>", "Screen or playlist identifier")
    .addOption(new Option("--json-value <JSON>", "Supply a JSON value").conflicts(["file"]))
    .addOption(new Option("--file <FILE>", "Read the value from a file").conflicts(["jsonValue"]))
    .action(bind(handleCommentSetScreen));

  commentSet.command("playlist").description("Replace playlist comments")
    .argument("<id>", "Screen or playlist identifier")
    .option("--page <PAGE_ID>", "Select playlist page comments")
    .addOption(new Option("--json-value <JSON>", "Supply a JSON value").conflicts(["file"]))
    .addOption(new Option("--file <FILE>", "Read the value from a file").conflicts(["jsonValue"]))
    .action(bind(handleCommentSetPlaylist));

  const commentDelete = comment.command("delete").description("Delete screen or playlist comments");

  commentDelete.command("screen").description("Delete screen comments")
    .argument("<id>", "Screen or playlist identifier")
    .action(bind(handleCommentDeleteScreen));

  commentDelete.command("playlist").description("Delete playlist comments")
    .argument("<id>", "Screen or playlist identifier")
    .option("--page <PAGE_ID>", "Select playlist page comments")
    .action(bind(handleCommentDeletePlaylist));
  for (const command of commentSet.commands) requireOptionGroup(command, "exactlyOne", ["--json-value", "--file"]);
  for (const action of comment.commands) for (const command of action.commands) command.registeredArguments[0]!.description = command.name() === "screen" ? "Screen identifier" : "Playlist identifier";
}
