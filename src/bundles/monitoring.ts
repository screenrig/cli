// The monitoring commands: registered only when an invocation needs them.
import type { Command } from "commander";
import type { CommandActionBinder } from "../cli-commands/types.js";
import { registerTriggersCommands } from "../cli-commands/triggers.js";
import { registerOperationsCommands } from "../cli-commands/operations.js";
import { registerEventsCommands } from "../cli-commands/events.js";
import { registerPlaybackCommands } from "../cli-commands/playback.js";
import { registerAlertsCommands } from "../cli-commands/alerts.js";

export function register(root: Command, bind: CommandActionBinder): void {
  registerTriggersCommands(root, bind);
  registerOperationsCommands(root, bind);
  registerEventsCommands(root, bind);
  registerPlaybackCommands(root, bind);
  registerAlertsCommands(root, bind);
}
