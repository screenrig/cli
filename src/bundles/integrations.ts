// The integrations commands: registered only when an invocation needs them.
import type { Command } from "commander";
import type { CommandActionBinder } from "../cli-commands/types.js";
import { registerWebhooksCommands } from "../cli-commands/webhooks.js";
import { registerNotificationsCommands } from "../cli-commands/notifications.js";
import { registerReportsCommands } from "../cli-commands/reports.js";
import { registerBiCommands } from "../cli-commands/bi.js";

export function register(root: Command, bind: CommandActionBinder): void {
  registerWebhooksCommands(root, bind);
  registerNotificationsCommands(root, bind);
  registerReportsCommands(root, bind);
  registerBiCommands(root, bind);
}
