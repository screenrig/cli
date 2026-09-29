import { type Command, Option } from "commander";
import { nonnegativeInteger } from "./options.js";

export function registerGlobalOptions(root: Command): void {
  root
    .addOption(new Option("--json", "Return JSON (default; also enables structured help)").conflicts("human"))
    .addOption(new Option("--human", "Return human-readable output").conflicts("json"))
    .option("--api-url <URL>", "Override the API origin")
    .option("--config <PATH>", "Use this credential/configuration file")
    .option("--request-id <ID>", "Send ID (req_ + 16-64 of A-Z a-z 0-9 _ -) on the first request only")
    .option("--idempotency-key <KEY>", "Reuse a key when retrying the same write")
    .option("--timeout <MS>", "Set the command timeout in milliseconds", nonnegativeInteger("timeout"))
    .option("--beta-key <KEY>", "Supply an enrollment beta key")
    .addOption(new Option("--token <TOKEN>", "Unsupported credential override; use agent enrollment or connection").hideHelp());
}
