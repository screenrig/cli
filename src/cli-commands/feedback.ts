import { requireOptionGroup } from "./notes.js";
import type { CommandActionBinder } from "./types.js";
import { handleFeedbackBug, handleFeedbackFeature, handleFeedbackList, handleFeedbackShow, handleFeedbackReply } from "../handlers/feedback.js";
import { type Command, Option } from "commander";

export function registerFeedbackCommands(root: Command, bind: CommandActionBinder): void {
  const feedback = root.command("feedback").description("Submit and discuss bugs and feature requests");

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

  feedback.command("show").description("Read a feedback report and its complete conversation")
    .argument("<id>", "Feedback ID from feedback list")
    .action(bind(handleFeedbackShow));

  feedback.command("reply").description("Append a reply to an existing feedback conversation")
    .argument("<id>", "Feedback ID from feedback list")
    .addOption(new Option("--body <TEXT>", "Supply a reply of 1 to 2000 characters").conflicts(["bodyFile"]))
    .addOption(new Option("--body-file <FILE>", "Read the reply from a file").conflicts(["body"]))
    .action(bind(handleFeedbackReply));

  feedback.command("list").description("List submitted feedback with its status and latest reply")
    .addOption(new Option("--kind <bug|feature>", "Filter feedback by kind").choices(["bug", "feature"]))
    .action(bind(handleFeedbackList));
  for (const command of feedback.commands.filter(command => ["bug", "feature", "reply"].includes(command.name()))) requireOptionGroup(command, "exactlyOne", ["--body", "--body-file"]);
}
