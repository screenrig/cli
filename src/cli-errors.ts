import type { Command, CommanderError } from "commander";
import { commandPath } from "./command-path.js";
import { usageError } from "./problems.js";

/** Commander diagnostics can contain raw option names/values. Never expose them. */
export function commandError(error: CommanderError, command: Command): never {
  const path = commandPath(command).join(" ");
  // Preserve actionable migration hints using only known command/flag names.
  const has = (flag: string) => command.args.some((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`));
  if (path === "screen" && command.args[0] === "revoke-credential") throw usageError("screen revoke-credential is retired. Archive the screen instead.", { command: "screenrig --json screen archive <id> --if-match REVISION", reason: "Archive hides the screen; it does not unbind the player." });
  if (path.startsWith("comment ")) {
    if (command.commands.length) throw usageError("comment commands require screen <id> or playlist <id>.");
    if (has("if-match")) throw usageError("comment commands do not take --if-match; last write wins and does not bump revision.");
    if (has("page") && command.name() === "screen") throw usageError("comment screen commands do not take --page; use comment playlist <id> --page PAGE_ID.");
    if (has("value-base64")) throw usageError("comment set requires --json-value or --file.");
    if (error.code === "commander.conflictingOption") throw usageError("comment set requires exactly one of --json-value or --file.");
  }
  if (path === "media list" && has("kind")) throw usageError("media list uses --primitive image|video, not --kind.");
  switch (error.code) {
    case "commander.missingArgument":
      if (path === "screen set-timezone") throw usageError("screen set-timezone requires <id> --timezone --if-match.");
      throw usageError(`${path} requires ${command.registeredArguments.filter((arg) => arg.required).map((arg) => `<${arg.name()}>`).join(" ")}.`);
    case "commander.excessArguments":
      throw usageError(`${path || "screenrig"} does not accept ${command.registeredArguments.length ? "extra" : "positional"} arguments.`);
    case "commander.conflictingOption":
      throw usageError("Conflicting options. See command help.");
    case "commander.missingMandatoryOptionValue": {
      if (path === "screen set-timezone") throw usageError("screen set-timezone requires <id> --timezone --if-match.");
      const required = command.options.filter((option) => option.mandatory && command.getOptionValue(option.attributeName()) === undefined);
      const positional = command.registeredArguments.filter((arg, index) => arg.required && index >= command.args.length).map((arg) => `<${arg.name()}>`);
      throw usageError(`${path} requires ${[...positional, ...required.map((option) => option.long)].join(" ")}.`);
    }
    case "commander.optionMissingArgument": {
      const option = command.options.find((candidate) => error.message.includes(`option '${candidate.flags}'`));
      throw usageError(option ? `${option.long} requires a value.` : "An option requires a value. See command help for its arguments.");
    }
    default:
      throw usageError("Unknown command or unsupported option. See command help for supported arguments.", { command: `screenrig${path ? ` ${path}` : ""} --help`, reason: "List supported commands, arguments, and options." });
  }
}

