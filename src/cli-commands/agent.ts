import type { CommandActionBinder } from "./types.js";
import { handleAgentEnroll, handleAgentConnect, handleAgentStatus, handleAgentDisconnect, handleAgentRevokeIdentity, handleLogin, handleLogout } from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { AGENT_CAPABILITIES } from "../adapters/protocol.js";
import { usageError } from "../problems.js";

export function registerAgentCommands(root: Command, bind: CommandActionBinder): void {
  addCommandNotes(root.command("login").description("Sign this installation in with a person's approval in the dashboard")
    .option("--project <ID>", "Suggest the project the person approves")
    .addOption(new Option("--access <LEVEL>", "Ask for Read only or Manage access (default manage)").choices(["read", "manage"]))
    .option("--name <NAME>", "Set this agent installation name")
    .option("--no-wait", "Print the sign-in URL and code with a resume handle, and return")
    .option("--resume <ID>", "Continue a pending sign-in by the login_ handle --no-wait printed")
    .action(bind(handleLogin)), "Prints a dashboard URL and a code. A person signed in to the dashboard opens it, checks that the code matches, chooses the project and Read only or Manage, and approves; the CLI then stores the session and selects that project. The code lasts 10 minutes. An installation that already holds identity access adds the approved project to its sign-in, which is also how a Read only project is raised to Manage. Read only lists and reads; it cannot change, publish or buy, and metered reads still bill. --no-wait returns at once with a login_ handle that holds no secret; screenrig login --resume ID waits for the approval later.");

  addCommandNotes(root.command("logout").description("End this installation's sign-in and remove its tokens")
    .action(bind(handleLogout)), "Revokes the sign-in on the server, then removes the stored session and access tokens. A failure that might not have reached the server keeps them, so rerunning logout is safe. Run screenrig login to sign in again.");

  const agent = root.command("agent").description("Enroll and manage this agent");

  const enroll = agent.command("enroll").description("Create a new project and its first agent")
    .option("--email <ADDRESS>", "Set the project contact email")
    .option("--agentid-claim <CODE>", "Redeem an AgentID sign-in claim code instead of a contact email")
    .option("--organization <NAME>", "Create the organization containing Screens")
    .addOption(new Option("--project-name <NAME>", "Resume a retained enrollment's exact project name").hideHelp())
    .addOption(new Option("--intent <INTENT>", "Choose the project's purpose: signage (default) or advertising").choices(["signage", "advertising"]))
    .option("--name <NAME>", "Set this agent installation name")
    .option("--force", "Discard a pending enrollment before enrolling")
    .action(bind(handleAgentEnroll));
  // Mutually exclusive credential sources. A new enrollment must supply exactly
  // one; a pending enrollment resumes without either flag.
  requireOptionGroup(enroll, "atMostOne", ["--email", "--agentid-claim"]);

  addCommandNotes(agent.command("connect").description("Alias of screenrig login, kept for one release")
    .option("--target-project-id <ID>", "Suggest the project the person approves (screenrig login --project)")
    .option("--name <NAME>", "Set this agent installation name")
    .addOption(new Option("--capability <NAME>", "Not sent: the person approving the sign-in chooses capabilities")
      .choices([...AGENT_CAPABILITIES])
      .argParser((value: string, previous?: string) => {
        if (!AGENT_CAPABILITIES.some((name) => name === value)) {
          throw usageError(`Unknown capability ${value}. Choose from: ${AGENT_CAPABILITIES.join(", ")}.`);
        }
        const requested = previous ? previous.split(",") : [];
        if (requested.includes(value)) throw usageError(`Capability ${value} was supplied more than once.`);
        return [...requested, value].join(",");
      }))
    .addOption(new Option("--print-url", "Return the sign-in URL in the pending result").hideHelp())
    .option("--wait", "Wait for dashboard approval")
    .option("--no-wait", "Print the sign-in URL and code with a resume handle, and return (default)")
    .addOption(new Option("--cancel", "Clear this installation's pending sign-in")
      .conflicts(["targetProjectId", "name", "capability", "printUrl", "wait"]))
    .action(bind(handleAgentConnect)), "Runs screenrig login and adds a command_renamed warning naming it. Without --wait it returns pending with a login_ resume handle; screenrig login --resume ID finishes it. The person approving the sign-in in the dashboard chooses the project, Read only or Manage, and the capabilities.");

  agent.command("status").description("Inspect this agent's connection")
    .action(bind(handleAgentStatus));

  agent.command("disconnect").description("Revoke this agent's membership in the current project")
    .option("--yes", "Confirm this project's membership revocation")
    .option("--allow-lockout", "Allow disconnecting the last agent")
    .action(bind(handleAgentDisconnect));
  agent.command("revoke-identity").description("Revoke this identity and all its project memberships")
    .option("--yes", "Confirm revocation across every project").action(bind(handleAgentRevokeIdentity));
}
