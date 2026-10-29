import { eventTypeOption, positiveInteger } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleEventsList, handleEventsFollow } from "../commands.js";
import { type Command, Option } from "commander";

export function registerEventsCommands(root: Command, bind: CommandActionBinder): void {
  const events = root.command("events").description("List or follow project events");

  events.command("list").description("List project events")
    .option("--after <CURSOR>", "Read events after this cursor")
    .option("--limit <N>", "Limit returned events", positiveInteger("limit"))
    .option("--type <TYPE>", "Only this event type, or a family by a prefix ending in a dot (note.)", eventTypeOption)
    .addOption(new Option("--source <SOURCE>", "project (default) lists project events; log lists Player log records").choices(["project", "log"]))
    .option("--screen-id <ID>", "Only the events of this screen (with --source log, its Player log records)")
    .option("--playlist-id <ID>", "Only the project events of this playlist (not with --source log)")
    .option("--app-id <ID>", "Only application resource, release and K/V events (not SDK emits or --source log)")
    .action(bind(handleEventsList));

  events.command("follow").description("Stream project events")
    .option("--after <CURSOR>", "Read events after this cursor")
    .option("--type <TYPE>", "Only this event type, or a family by a prefix ending in a dot (note.)", eventTypeOption)
    .action(bind(handleEventsFollow));
}
