import type { CommandActionBinder } from "./types.js";
import { handleAgentEnroll, handleAgentConnect, handleAgentStatus, handleAgentDisconnect, handleAgentRevokeIdentity } from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { AGENT_CAPABILITIES } from "../adapters/protocol.js";
import { usageError } from "../problems.js";

export function registerAgentCommands(root: Command, bind: CommandActionBinder): void {
  const agent = root.command("agent").description("Enroll, connect, and manage this agent");

  const enroll = agent.command("enroll").description("Create a new project and its first agent")
    .option("--email <ADDRESS>", "Set the project contact email")
    .option("--agentid-claim <CODE>", "Redeem an AgentID sign-in claim code instead of a contact email")
    .option("--organization <NAME>", "Create the organization containing Screens")
    .addOption(new Option("--project-name <NAME>", "Resume a retained enrollment's exact project name").hideHelp())
    .addOption(new Option("--intent <INTENT>", "Choose the project's purpose: signage (default) or advertising").choices(["signage", "advertising"]))
    .option("--name <NAME>", "Set this agent installation name")
    .option("--force", "Discard pending enrollment or connection state before enrolling")
    .action(bind(handleAgentEnroll));
  // Mutually exclusive credential sources. A new enrollment must supply exactly
  // one; a pending enrollment resumes without either flag.
  requireOptionGroup(enroll, "atMostOne", ["--email", "--agentid-claim"]);

  addCommandNotes(agent.command("connect").description("Reconnect this installation to an existing project")
    .option("--target-project-id <ID>", "Request approval for this specific existing project; needs the identity credential that agent enroll or an earlier approved agent connect saves")
    .option("--name <NAME>", "Set this agent installation name")
    .addOption(new Option("--capability <NAME>", "Request a capability (repeatable; default: all six)")
      .choices([...AGENT_CAPABILITIES])
      .argParser((value: string, previous?: string) => {
        if (!AGENT_CAPABILITIES.some((name) => name === value)) {
          throw usageError(`Unknown capability ${value}. Choose from: ${AGENT_CAPABILITIES.join(", ")}.`);
        }
        const requested = previous ? previous.split(",") : [];
        if (requested.includes(value)) throw usageError(`Capability ${value} was supplied more than once.`);
        return [...requested, value].join(",");
      }))
    .option("--print-url", "Return the browser handoff URL")
    .option("--wait", "Wait for dashboard approval (30000 ms default; bounded by --timeout)")
    .option("--no-wait", "Read a status snapshot for at most 1000 ms (default)")
    .addOption(new Option("--cancel", "Withdraw this installation's pending connection request and clear its local state")
      .conflicts(["targetProjectId", "name", "capability", "printUrl", "wait"]))
    .action(bind(handleAgentConnect)), "Approval expires after 24 hours. By default, read one status snapshot for at most 1000 ms and return pending with a resume command, or complete an approved connection. --wait opts into a 30000 ms approval wait; --timeout bounds that wait (1–86400000 ms). Without --wait, --timeout can shorten but never extend the snapshot budget. Pending means the request was submitted, not that approval or activation completed. --print-url places the handoff URL in the pending result. Retry agent connect to resume after an interrupted wait. --cancel withdraws a pending request (a cancelled, denied or expired one is cleared the same way); an approved request cannot be cancelled: finish it with agent connect, then run agent disconnect.");

  agent.command("status").description("Inspect this agent's connection")
    .action(bind(handleAgentStatus));

  agent.command("disconnect").description("Revoke this agent's membership in the current project")
    .option("--yes", "Confirm this project's membership revocation")
    .option("--allow-lockout", "Allow disconnecting the last agent")
    .action(bind(handleAgentDisconnect));
  agent.command("revoke-identity").description("Revoke this identity and all its project memberships")
    .option("--yes", "Confirm revocation across every project").action(bind(handleAgentRevokeIdentity));
}
