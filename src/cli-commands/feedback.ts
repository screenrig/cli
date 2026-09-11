import { requireOptionGroup } from "./notes.js";
import type { CommandActionBinder } from "./types.js";
import { handleFeedbackBug, handleFeedbackFeature, handleFeedbackList } from "../commands.js";
import { type Command, Option } from "commander";

export function registerFeedbackCommands(root: Command, bind: CommandActionBinder): void {
  const feedback = root.command("feedback").description("Submit bugs and feature requests");

  feedback.command("bug").description("Submit a bug report")
    .argument("<title>", "Feedback title")
    .addOption(new Option("--body <TEXT>", "Supply feedback details").conflicts(["bodyFile"]))
    .addOption(new Option("--body-file <FILE>", "Read feedback details from a file").conflicts(["body"]))
    .option("--command <GROUP ACTION>", "Identify the command involved")
    .option("--no-context", "Omit diagnostic context")
    .action(bind(handleFeedbackBug));

  feedback.command("feature").description("Submit a feature request")
    .argument("<title>", "Feedback title")
    .addOption(new Option("--body <TEXT>", "Supply feedback details").conflicts(["bodyFile"]))
    .addOption(new Option("--body-file <FILE>", "Read feedback details from a file").conflicts(["body"]))
    .option("--command <GROUP ACTION>", "Identify the command involved")
    .option("--no-context", "Omit diagnostic context")
    .action(bind(handleFeedbackFeature));

  feedback.command("list").description("List submitted feedback")
    .addOption(new Option("--kind <bug|feature>", "Filter feedback by kind").choices(["bug", "feature"]))
    .action(bind(handleFeedbackList));
  for (const command of feedback.commands.filter(command => command.name() !== "list")) requireOptionGroup(command, "exactlyOne", ["--body", "--body-file"]);
}
