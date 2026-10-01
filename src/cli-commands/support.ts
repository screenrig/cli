import { type Command, Option } from "commander";
import { requireOptionGroup } from "./notes.js";
import type { CommandActionBinder } from "./types.js";
import { handleSupportStatus, handleSupportSubmit, handleSupportHistory, handleSupportFollow, handleSupportRead, handleSupportClose } from "../commands.js";

export function registerSupportCommands(root: Command, bind: CommandActionBinder): void {
  const support = root.command("support").description("Premium and Enterprise support conversations");
  support.command("status").description("Show support availability and staffed hours").action(bind(handleSupportStatus));
  const submit = support.command("submit").description("Start a conversation or send a follow-up")
    .option("--conversation-id <ID>", "Reply in this conversation; omit to start a new one")
    .addOption(new Option("--body <TEXT>", "Supply the support message").conflicts("bodyFile"))
    .addOption(new Option("--body-file <FILE>", "Read the support message from a file").conflicts("body"))
    .option("--human-requested", "Ask staff to respond and pause the AI assistant")
    .action(bind(handleSupportSubmit));
  requireOptionGroup(submit, "exactlyOne", ["--body", "--body-file"]);
  support.command("history").description("List conversations or a conversation's messages")
    .option("--conversation-id <ID>", "Read messages in one conversation")
    .option("--after <SEQUENCE>", "Read messages after this support sequence")
    .option("--before <ID>", "Read older conversations using the history page's next cursor")
    .action(bind(handleSupportHistory));
  support.command("follow").description("Follow support messages as resumable SSE")
    .option("--conversation-id <ID>", "Print only this conversation; still advance the project cursor")
    .option("--after <SEQUENCE>", "Resume after this support sequence; default replays history")
    .action(bind(handleSupportFollow));
  support.command("close").description("End a conversation and preserve its history")
    .requiredOption("--conversation-id <ID>", "Conversation to end")
    .action(bind(handleSupportClose));
  support.command("read").description("Acknowledge staff replies through a message sequence")
    .requiredOption("--conversation-id <ID>", "Conversation being read")
    .requiredOption("--sequence <SEQUENCE>", "Last message you have read")
    .action(bind(handleSupportRead));
}
