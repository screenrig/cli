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
    .option("--wait", "Wait for dashboard approval (30000 ms default; bounded by --timeout)")
    .option("--no-wait", "Read a status snapshot for at most 1000 ms (default)")
    .action(bind(handleAgentConnect)), "Approval expires after 24 hours. By default, read one status snapshot for at most 1000 ms and return pending with a resume command, or complete an approved connection. --wait opts into a 30000 ms approval wait; --timeout bounds that wait (1–86400000 ms). Without --wait, --timeout can shorten but never extend the snapshot budget. Pending means the request was submitted, not that approval or activation completed. --print-url places the handoff URL in the pending result. Retry agent connect to resume after an interrupted wait.");

  agent.command("status").description("Inspect this agent's connection")
    .action(bind(handleAgentStatus));

  agent.command("disconnect").description("Disconnect this agent")
    .option("--yes", "Confirm this agent's disconnection")
    .option("--allow-lockout", "Allow disconnecting the last agent")
    .action(bind(handleAgentDisconnect));
}
