import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import {
  handleTriggersClear, handleTriggersCreate, handleTriggersDelete, handleTriggersDeliveries, handleTriggersList, handleTriggersRotateSecret, handleTriggersShow,
  handleTriggersTest, handleTriggersUpdate,
} from "../commands.js";
import { triggerDeliveriesLimit, triggerHoldOption, triggerName, triggerScreenIds, triggerTag } from "../triggers.js";

const nameOption = (value: string): string => { triggerName(value); return value; };

export function registerTriggersCommands(root: Command, bind: CommandActionBinder): void {
  const triggers = root.command("triggers").description("Show alerts from outside systems on screens");
  addCommandNotes(triggers, "Triggers:\n  A trigger is a URL with its own secret that an outside system posts to. Two kinds.\n  CAP (the default): an emergency notification system (Everbridge, Rave, Alertus, an\n  IPAWS relay) posts CAP 1.2 alerts with HTTP Basic; an Alert takes the target screens\n  over with a full-screen card coloured by severity until the alert's <expires>, else\n  --for, and a Cancel or AllClear gives them back. Overlay (--kind overlay): Home\n  Assistant, a sensor hub or an alerting tool posts a few words (alert_id, title,\n  message, duration, clear) with Authorization: Bearer; --show bar draws a strip over\n  whatever plays, --show takeover plays the alert full screen. The same alert_id\n  updates one alert instead of stacking, a clear ends it, and every post holds its\n  alert for its duration from that post. The target is a tag or up to 500 screen ids.\n  A project has at most 20 triggers.");

  const create = triggers.command("create").description("Create a trigger and print its URL and secret")
    .requiredOption("--name <NAME>", "Name the trigger, 1 to 80 characters (required)", nameOption)
    .addOption(new Option("--kind <KIND>", "cap: emergency CAP 1.2 alerts (default). overlay: words from any sender over or instead of what plays").choices(["cap", "overlay"]))
    .addOption(new Option("--tag <TAG>", "Target every active screen with this tag when an alert arrives").argParser(triggerTag).conflicts(["screenId"]))
    .addOption(new Option("--screen-id <ID>", "Target this screen (repeatable, or comma-separated; at most 500)").argParser(triggerScreenIds).conflicts(["tag"]))
    .option("--for <DURATION>", "Hold an alert that names no end this long: 1m to 7d for CAP (default 1h), 10s to 7d for overlay (default 10m)", triggerHoldOption)
    .option("--pull <FILE>", "CAP: also read CAP alert sources the platform pulls: a JSON object (sources, location, filters) from a file, or - for stdin")
    .addOption(new Option("--show <SHOW>", "Overlay: bar draws a strip over whatever plays; takeover plays the alert full screen").choices(["bar", "takeover"]))
    .addOption(new Option("--edge <EDGE>", "Overlay bar: the edge it takes, bottom (default) or top").choices(["bottom", "top"]))
    .option("--style <FILE>", "Overlay: the text card style, a JSON object (theme, accent, background, backgroundColor, textColor, align), or - for stdin")
    .option("--map <FILE>", "Overlay: the template that builds the post from the body a sender posts, a JSON file or - for stdin")
    .option("--signing", "Overlay: also require a ScreenRig-Signature header on every post, and print the signing secret once")
    .action(bind(handleTriggersCreate));
  requireOptionGroup(create, "exactlyOne", ["--tag", "--screen-id"]);
  requireOptionGroup(create, "requires", ["--edge", "--show"]);

  const update = triggers.command("update").description("Change a trigger's name, target, hold or overlay without a new URL or secret")
    .argument("<id>", "Trigger identifier")
    .option("--name <NAME>", "Rename the trigger, 1 to 80 characters", nameOption)
    .addOption(new Option("--tag <TAG>", "Target every active screen with this tag").argParser(triggerTag).conflicts(["screenId"]))
    .addOption(new Option("--screen-id <ID>", "Target this screen (repeatable, or comma-separated; at most 500)").argParser(triggerScreenIds).conflicts(["tag"]))
    .option("--for <DURATION>", "Hold an alert that names no end this long (CAP 1m to 7d, overlay 10s to 7d)", triggerHoldOption)
    .option("--pull <FILE>", "CAP: replace the CAP alert sources, a JSON object from a file, or - for stdin")
    .option("--no-pull", "CAP: stop reading CAP alert sources")
    .addOption(new Option("--edge <EDGE>", "Overlay bar: move the bar to this edge").choices(["bottom", "top"]))
    .addOption(new Option("--style <FILE>", "Overlay: replace the whole style, a JSON object from a file, or - for stdin").conflicts(["clearStyle"]))
    .addOption(new Option("--clear-style", "Overlay: remove the style").conflicts(["style"]))
    .addOption(new Option("--map <FILE>", "Overlay: replace the template that builds the post, a JSON file or - for stdin").conflicts(["clearMap"]))
    .addOption(new Option("--clear-map", "Overlay: remove the template: the posted object is the post").conflicts(["map"]))
    .addOption(new Option("--enable", "Overlay: accept posts again").conflicts(["disable"]))
    .addOption(new Option("--disable", "Overlay: answer every post like a wrong secret until enabled again").conflicts(["enable"]))
    .option("--signing", "Overlay: require a ScreenRig-Signature header and print the signing secret once")
    .option("--no-signing", "Overlay: stop requiring a ScreenRig-Signature header")
    .option("--expect-rev <REVISION>", "Optionally require this trigger revision", revision)
    .action(bind(handleTriggersUpdate));
  requireOptionGroup(update, "atLeastOne", [
    "--name", "--tag", "--screen-id", "--for", "--pull", "--no-pull", "--edge", "--style", "--clear-style", "--map", "--clear-map", "--enable", "--disable", "--signing", "--no-signing",
  ]);

  triggers.command("list").description("List this project's triggers and their latest alerts")
    .action(bind(handleTriggersList));

  triggers.command("show").description("Inspect a trigger, its latest alert or its active overlay alerts")
    .argument("<id>", "Trigger identifier")
    .action(bind(handleTriggersShow));

  triggers.command("test").description("Show a 60-second exercise alert (CAP) or test overlay on the trigger's screens")
    .argument("<id>", "Trigger identifier")
    .action(bind(handleTriggersTest));

  triggers.command("deliveries").description("Read an overlay trigger's log of posts: why each was shown, ignored or refused")
    .argument("<id>", "Trigger identifier")
    .option("--limit <N>", "How many deliveries, newest first (1 to 100)", triggerDeliveriesLimit)
    .action(bind(handleTriggersDeliveries));

  triggers.command("clear").description("End the trigger's alert now and give its screens back")
    .argument("<id>", "Trigger identifier")
    .option("--alert-id <ID>", "Overlay: end only this alert; without it every alert ends")
    .action(bind(handleTriggersClear));

  triggers.command("rotate-secret").description("Replace a trigger's password; the old one stops working at once")
    .argument("<id>", "Trigger identifier")
    .option("--signing", "Overlay: replace the signing secret instead of the password")
    .option("--expect-rev <REVISION>", "Optionally require this trigger revision", revision)
    .action(bind(handleTriggersRotateSecret));

  triggers.command("delete").description("Delete a trigger; its URL stops accepting posts")
    .argument("<id>", "Trigger identifier")
    .option("--expect-rev <REVISION>", "Optionally require this trigger revision", revision)
    .action(bind(handleTriggersDelete));
}
