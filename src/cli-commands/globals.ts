import { type Command, Option } from "commander";
import { nonnegativeInteger } from "./options.js";

export function registerGlobalOptions(root: Command): void {
  root
    .option("--json", "Return a JSON envelope")
    .option("--api-url <URL>", "Override the API origin")
    .option("--config <PATH>", "Use this credential/configuration file")
    .option("--request-id <ID>", "Use a request correlation ID")
    .option("--idempotency-key <KEY>", "Reuse a key when retrying the same write")
    .option("--timeout <MS>", "Set the command timeout in milliseconds", nonnegativeInteger("timeout"))
    .option("--beta-key <KEY>", "Supply an enrollment beta key")
    .addOption(new Option("--token <TOKEN>", "Unsupported credential override; use agent enrollment or connection").hideHelp());
}
