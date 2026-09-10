import type { CommandActionBinder } from "./types.js";
import { handleAgentEnroll, handleAgentConnect, handleAgentStatus, handleAgentDisconnect } from "../commands.js";
import type { Command } from "commander";
import { addCommandNotes } from "./notes.js";

export function registerAgentCommands(root: Command, bind: CommandActionBinder): void {
  const agent = root.command("agent").description("Enroll, connect, and manage this agent");

  agent.command("enroll").description("Create the first agent with an email address")
    .option("--email <ADDRESS>", "Set the account contact email")
    .option("--name <NAME>", "Set this agent installation name")
    .option("--open-dashboard", "Open the dashboard after enrolling")
    .action(bind(handleAgentEnroll));

  addCommandNotes(agent.command("connect").description("Connect this installation with approval")
    .option("--name <NAME>", "Set this agent installation name")
    .option("--print-url", "Return the browser handoff URL")
    .action(bind(handleAgentConnect)), "Approval expires after 24 hours; --timeout defaults to 86400000 ms. Retry agent connect to resume after an interrupted wait.");

  agent.command("status").description("Inspect this agent's connection")
    .action(bind(handleAgentStatus));

  agent.command("disconnect").description("Disconnect this agent")
    .option("--yes", "Confirm this agent's disconnection")
    .option("--allow-lockout", "Allow disconnecting the last agent")
    .action(bind(handleAgentDisconnect));
}
