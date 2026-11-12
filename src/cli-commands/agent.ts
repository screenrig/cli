import type { CommandActionBinder } from "./types.js";
import { handleAgentEnroll, handleAgentStatus, handleAgentDisconnect, handleAgentRevokeIdentity, handleLogin, handleLogout } from "../handlers/agent.js";
import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { ACCESS_LEVELS } from "../oauth.js";

export function registerAgentCommands(root: Command, bind: CommandActionBinder): void {
  const login = root.command("login").description("Sign this installation in with a person's approval in the dashboard")
    .option("--project <ID>", "Suggest the project the person approves")
    .addOption(new Option("--access <LEVEL>", "Ask for Read only, Propose or Manage access (default manage)").choices([...ACCESS_LEVELS]))
    .option("--name <NAME>", "Set this agent installation name")
    .option("--no-wait", "Print the sign-in URL and code with a resume handle, and return")
    .option("--resume <ID>", "Continue a pending sign-in by the login_ handle --no-wait printed")
    .option("--client-id <ID>", "Sign this config in as a service client (scl_...) instead of an agent")
    .option("--client-key-file <PATH>", "With --client-id, the service client's private key (a JWK or PEM)")
    .option("--client-secret-file <PATH>", "With --client-id, a file holding the service client's secret")
    .action(bind(handleLogin));
  addCommandNotes(login, "A server, script or CI job signs in as a service client instead: screenrig --config PATH login --client-id scl_... --client-key-file KEY.pem (or --client-secret-file FILE) saves the client in that config without a person's approval, and every later command with that config signs in as it, reading the key or secret file each time; screenrig logout removes it. Prints a dashboard URL and a code. A person signed in to the dashboard opens the link, which carries the code and shows one screen with the code, the project, Read only, Propose or Manage, and the capabilities; they check that the code matches the one shown here and press Connect once, with no second passkey prompt when they signed in to the dashboard in the last hour; the CLI then stores the session and selects that project. The code lasts 24 hours. --access suggests a level; the person approving chooses it. An installation that already holds identity access adds the approved project to its sign-in, which is also how a project's access is raised. Read only lists and reads; it cannot change or publish. Propose also uploads media and changes its tags, which wait for review before any selector plays the change, and writes notes; every change to what plays (playlist create and update, screen assign, schedules, takeovers) becomes a review that a person approves in the dashboard before it reaches a screen. Manage applies changes directly. A project that requires review for agent changes, or a responsible person who cannot approve, holds the sign-in to Propose; agent status shows access, effective_access and access_limited_by. --no-wait returns at once with a login_ handle that holds no secret; screenrig login --resume ID waits for the approval later. When the signed-in agent has new project notes or notes due for review, warning notes_waiting names them and screenrig notes; human output prints the same line after the result.");

  requireOptionGroup(login, "atMostOne", ["--client-key-file", "--client-secret-file"]);

  addCommandNotes(root.command("logout").description("End this installation's sign-in and remove its tokens")
    .action(bind(handleLogout)), "Revokes the sign-in on the server, then removes the stored session and access tokens. In a service client's config it removes the saved client and leaves its key or secret file. A failure that might not have reached the server keeps them, so rerunning logout is safe. Run screenrig login to sign in again.");

  const agent = root.command("agent").description("Enroll and manage this agent");

  const enroll = agent.command("enroll").description("Create a new project and its first agent")
    .option("--email <ADDRESS>", "Set the project contact email")
    .option("--agentid-claim <CODE>", "Redeem an AgentID sign-in claim code instead of a contact email")
    .option("--organization <NAME>", "Create the organization containing Screens")
    .addOption(new Option("--intent <INTENT>", "Choose the project's purpose: signage (default) or advertising").choices(["signage", "advertising"]))
    .option("--setup-code <CODE>", "Link the new project to the website visit that showed this setup code, such as K7QX-2MPD")
    .option("--name <NAME>", "Set this agent installation name")
    .option("--force", "Discard a pending enrollment before enrolling")
    .action(bind(handleAgentEnroll));
  // Mutually exclusive credential sources. A new enrollment must supply exactly
  // one; a pending enrollment resumes without either flag.
  requireOptionGroup(enroll, "atMostOne", ["--email", "--agentid-claim"]);

  agent.command("status").description("Inspect this agent's connection and access")
    .action(bind(handleAgentStatus));

  agent.command("disconnect").description("Revoke this agent's membership in the current project")
    .option("--yes", "Confirm this project's membership revocation")
    .option("--allow-lockout", "Allow disconnecting the last agent")
    .action(bind(handleAgentDisconnect));
  agent.command("revoke-identity").description("Revoke this identity and all its project memberships")
    .option("--yes", "Confirm revocation across every project").action(bind(handleAgentRevokeIdentity));
}
