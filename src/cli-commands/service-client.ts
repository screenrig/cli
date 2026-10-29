import type { CommandActionBinder } from "./types.js";
import {
  handleServiceClientAddKey, handleServiceClientAddSecret, handleServiceClientCreate, handleServiceClientList,
  handleServiceClientRemoveKey, handleServiceClientRemoveSecret, handleServiceClientRevoke, handleServiceClientShow,
} from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { AGENT_CAPABILITIES } from "../adapters/protocol.js";
import { usageError } from "../problems.js";
import { ACCESS_LEVELS } from "../oauth.js";

export function registerServiceClientCommands(root: Command, bind: CommandActionBinder): void {
  const group = root.command("service-client").description("Create and manage this project's service clients");
  addCommandNotes(group,
    "A service client is a server, script or CI job owned by this project. It signs in with client credentials, not a person's approval: set SCREENRIG_CLIENT_ID with SCREENRIG_CLIENT_KEY_FILE (a private key whose public half is registered; recommended) or SCREENRIG_CLIENT_SECRET, and every screenrig command runs as that client. Such a run keeps its token in memory and never reads or writes the stored config. Changing service clients requires identity scope, this agent's Manage grant with the project capability on the project, and a live organization admin role. Reading clients requires a project grant. A service client cannot manage clients.");

  group.command("list").description("List this project's service clients").action(bind(handleServiceClientList));
  group.command("show").description("Show one service client").argument("<id>", "Service client id (scl_...)").action(bind(handleServiceClientShow));

  const create = group.command("create").description("Create a service client")
    .requiredOption("--name <NAME>", "Name the client")
    .addOption(new Option("--capability <NAME>", "Grant a capability (repeatable; default: all six, each within yours)")
      .choices([...AGENT_CAPABILITIES])
      .argParser((value: string, previous?: string) => {
        if (!AGENT_CAPABILITIES.some((name) => name === value)) throw usageError(`Unknown capability ${value}. Choose from: ${AGENT_CAPABILITIES.join(", ")}.`);
        const requested = previous ? previous.split(",") : [];
        if (requested.includes(value)) throw usageError(`Capability ${value} was supplied more than once.`);
        return [...requested, value].join(",");
      }))
    .addOption(new Option("--access <LEVEL>", "Read only, Propose or Manage (default read; propose for an uploader)").choices([...ACCESS_LEVELS]))
    .option("--uploader", "Limit the client to the playlists and media folders given with --playlist-id and --folder-id")
    .option("--folder-id <ID[,ID]>", "With --uploader, the media folders (mfd_...) it uploads into; at least one")
    .option("--playlist-id <ID[,ID]>", "With --uploader, the playlists (pl_...) it changes pages of")
    .option("--key-file <PATH>", "Register this public key (a JWK or PEM; a private key file sends only its public half)")
    .option("--secret-file <PATH>", "Generate a secret and write it to this new 0600 file")
    .action(bind(handleServiceClientCreate));
  requireOptionGroup(create, "requires", ["--folder-id", "--uploader"]);
  requireOptionGroup(create, "requires", ["--playlist-id", "--uploader"]);
  requireOptionGroup(create, "requires", ["--uploader", "--folder-id"]);
  addCommandNotes(create,
  "Propose access proposes playlist and screen changes for a person to review instead of applying them. An uploader client (--uploader) works only in the folders and playlists it is given: it uploads media into its folders (media upload --folder ID) and adds, replaces and removes pages of its playlists (playlist page add|replace|remove), holds the content and playlists capabilities, and acts at Propose unless --access says otherwise; anything else it asks is outside_upload_scope, whose upload_scope lists what it may use. Its scope is set here and replaced by the project owner; to change what a client may do beyond that, create a new client. Supply --key-file, --secret-file or both. Keys are Ed25519, EC P-256 or RSA of at least 2048 bits; a key without a kid is known by its RFC 7638 thumbprint. The secret is shown once, so it is written only to --secret-file, which must not exist yet. At most 50 live clients per project.");

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
