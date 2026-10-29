// The ads commands: registered only when an invocation needs them.
import type { Command } from "commander";
import type { CommandActionBinder } from "../cli-commands/types.js";
import { registerAdsCommands } from "../cli-commands/ads.js";
import { registerCampaignCommands } from "../cli-commands/campaign.js";

export function register(root: Command, bind: CommandActionBinder): void {
  registerAdsCommands(root, bind);
  registerCampaignCommands(root, bind);
}
