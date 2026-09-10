import type { CommandActionBinder } from "./types.js";
import { handlePlaybackList } from "../commands.js";
import type { Command } from "commander";

export function registerPlaybackCommands(root: Command, bind: CommandActionBinder): void {
  const playback = root.command("playback").description("Inspect playback records");

  playback.command("list").description("List playback records")
    .option("--screen-id <ID>", "Filter playback by screen")
    .option("--media-id <ID>", "Filter playback by media")
    .option("--day <YYYY-MM-DD>", "Filter playback by UTC day")
    .action(bind(handlePlaybackList));
}
