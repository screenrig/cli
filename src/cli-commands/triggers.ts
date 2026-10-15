import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import {
  handleTriggersClear, handleTriggersCreate, handleTriggersDelete, handleTriggersList, handleTriggersRotateSecret, handleTriggersShow, handleTriggersTest,
} from "../commands.js";
import { triggerHoldOption, triggerName, triggerScreenIds, triggerTag } from "../triggers.js";

const nameOption = (value: string): string => { triggerName(value); return value; };

export function registerTriggersCommands(root: Command, bind: CommandActionBinder): void {
  const triggers = root.command("triggers").description("Take screens over with emergency CAP alerts");
  addCommandNotes(triggers, "CAP alert triggers:\n  A trigger is a URL with its own HTTP Basic username and password that an\n  emergency notification system (Everbridge, Rave, Alertus, an IPAWS relay) posts\n  CAP 1.2 alerts to. An Alert takes the target screens (a tag, or up to 500 screen\n  ids) over with a full-screen alert card coloured by severity until the alert's\n  <expires>, else --for; an Update redraws it, and a Cancel or AllClear gives the\n  screens back. Test, System and Draft messages are ignored. A project has at\n  most 20 triggers.");

  const create = triggers.command("create").description("Create a CAP trigger and print its URL, username and password")
    .requiredOption("--name <NAME>", "Name the trigger, 1 to 80 characters (required)", nameOption)
    .addOption(new Option("--tag <TAG>", "Target every active screen with this tag when an alert arrives").argParser(triggerTag).conflicts(["screenId"]))
    .addOption(new Option("--screen-id <ID>", "Target this screen (repeatable, or comma-separated; at most 500)").argParser(triggerScreenIds).conflicts(["tag"]))
    .option("--for <DURATION>", "Hold an alert that has no <expires> this long, 1m to 7d (default: 1h)", triggerHoldOption)
    .action(bind(handleTriggersCreate));
  requireOptionGroup(create, "exactlyOne", ["--tag", "--screen-id"]);

  triggers.command("list").description("List this project's triggers and their latest alerts")
    .action(bind(handleTriggersList));

  triggers.command("show").description("Inspect a trigger and its latest alert")
    .argument("<id>", "Trigger identifier")
    .action(bind(handleTriggersShow));

  triggers.command("test").description("Show a 60-second exercise alert on the trigger's screens")
    .argument("<id>", "Trigger identifier")
    .action(bind(handleTriggersTest));

  triggers.command("clear").description("End the trigger's alert now and give its screens back")
    .argument("<id>", "Trigger identifier")
    .action(bind(handleTriggersClear));

  triggers.command("rotate-secret").description("Replace a trigger's password; the old one stops working at once")
    .argument("<id>", "Trigger identifier")
    .option("--expect-rev <REVISION>", "Optionally require this trigger revision", revision)
    .action(bind(handleTriggersRotateSecret));

  triggers.command("delete").description("Delete a trigger; its URL stops accepting alerts")
    .argument("<id>", "Trigger identifier")
    .option("--expect-rev <REVISION>", "Optionally require this trigger revision", revision)
    .action(bind(handleTriggersDelete));
}
