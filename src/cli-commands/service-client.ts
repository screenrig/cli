import type { CommandActionBinder } from "./types.js";
import {
  handleServiceClientAddKey, handleServiceClientAddSecret, handleServiceClientCreate, handleServiceClientList,
  handleServiceClientRemoveKey, handleServiceClientRemoveSecret, handleServiceClientRevoke, handleServiceClientShow,
} from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes } from "./notes.js";
import { AGENT_CAPABILITIES } from "../adapters/protocol.js";
import { usageError } from "../problems.js";

export function registerServiceClientCommands(root: Command, bind: CommandActionBinder): void {
  const group = root.command("service-client").description("Create and manage this project's service clients");
  addCommandNotes(group,
    "A service client is a server, script or CI job owned by this project. It signs in with client credentials, not a person's approval: set SCREENRIG_CLIENT_ID with SCREENRIG_CLIENT_KEY_FILE (a private key whose public half is registered; recommended) or SCREENRIG_CLIENT_SECRET, and every screenrig command runs as that client. Such a run keeps its token in memory and never reads or writes the stored config. Managing service clients needs the project capability and Manage; a service client cannot manage clients.");

  group.command("list").description("List this project's service clients").action(bind(handleServiceClientList));
  group.command("show").description("Show one service client").argument("<id>", "Service client id (scl_...)").action(bind(handleServiceClientShow));

  addCommandNotes(group.command("create").description("Create a service client")
    .requiredOption("--name <NAME>", "Name the client")
    .addOption(new Option("--capability <NAME>", "Grant a capability (repeatable; default: all six, each within yours)")
      .choices([...AGENT_CAPABILITIES])
      .argParser((value: string, previous?: string) => {
        if (!AGENT_CAPABILITIES.some((name) => name === value)) throw usageError(`Unknown capability ${value}. Choose from: ${AGENT_CAPABILITIES.join(", ")}.`);
        const requested = previous ? previous.split(",") : [];
        if (requested.includes(value)) throw usageError(`Capability ${value} was supplied more than once.`);
        return [...requested, value].join(",");
      }))
    .addOption(new Option("--access <LEVEL>", "Read only or Manage (default read)").choices(["read", "manage"]))
    .option("--key-file <PATH>", "Register this public key (a JWK or PEM; a private key file sends only its public half)")
    .option("--secret-file <PATH>", "Generate a secret and write it to this new 0600 file")
    .action(bind(handleServiceClientCreate)),
  "Supply --key-file, --secret-file or both. Keys are Ed25519, EC P-256 or RSA of at least 2048 bits; a key without a kid is known by its RFC 7638 thumbprint. The secret is shown once, so it is written only to --secret-file, which must not exist yet. At most 50 live clients per project.");

  group.command("add-key").description("Register a second public key for rotation").argument("<id>", "Service client id")
    .requiredOption("--key-file <PATH>", "The public key (a JWK or PEM)").action(bind(handleServiceClientAddKey));
  group.command("add-secret").description("Generate a second secret for rotation").argument("<id>", "Service client id")
    .requiredOption("--secret-file <PATH>", "Write the new secret to this new 0600 file").action(bind(handleServiceClientAddSecret));
  group.command("remove-key").description("Remove a key; its tokens end within seconds").argument("<id>", "Service client id")
    .requiredOption("--kid <KID>", "The key id from service-client show").action(bind(handleServiceClientRemoveKey));
  group.command("remove-secret").description("Remove a secret; its tokens end within seconds").argument("<id>", "Service client id")
    .requiredOption("--secret-id <ID>", "The css_ secret id from service-client show").action(bind(handleServiceClientRemoveSecret));
  group.command("revoke").description("Revoke a service client permanently").argument("<id>", "Service client id")
    .option("--yes", "Confirm the permanent revocation").action(bind(handleServiceClientRevoke));
}
