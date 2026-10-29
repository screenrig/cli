// The media commands: registered only when an invocation needs them.
import type { Command } from "commander";
import type { CommandActionBinder } from "../cli-commands/types.js";
import { registerAppCommands } from "../cli-commands/app.js";
import { registerMediaCommands } from "../cli-commands/media.js";
import { registerBrowserCommands } from "../cli-commands/browser.js";
import { registerKvCommands } from "../cli-commands/kv.js";
import { registerSourceCommands } from "../cli-commands/sources.js";

export function register(root: Command, bind: CommandActionBinder): void {
  registerAppCommands(root, bind);
  registerMediaCommands(root, bind);
  registerBrowserCommands(root, bind);
  registerKvCommands(root, bind);
  registerSourceCommands(root, bind);
}
