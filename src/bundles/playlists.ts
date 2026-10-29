// The playlists commands: registered only when an invocation needs them.
import type { Command } from "commander";
import type { CommandActionBinder } from "../cli-commands/types.js";
import { registerPlaylistCommands } from "../cli-commands/playlist.js";
import { registerReviewsCommands } from "../cli-commands/reviews.js";
import { registerCardsCommands } from "../cli-commands/cards.js";
import { registerCommentCommands } from "../cli-commands/comment.js";
import { registerScheduleImportCommands } from "../cli-commands/schedule-import.js";

export function register(root: Command, bind: CommandActionBinder): void {
  registerPlaylistCommands(root, bind);
  registerReviewsCommands(root, bind);
  registerCardsCommands(root, bind);
  registerCommentCommands(root, bind);
  registerScheduleImportCommands(root, bind);
}
