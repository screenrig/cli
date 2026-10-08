import type { Command, CommanderError } from "commander";
import { commandPath } from "./command-path.js";
import { usageError } from "./problems.js";

const RETIRED_ACCOUNT_COMMANDS = new Map([
  ["show", "project show"],
  ["capabilities", "project capabilities"],
  ["invite", "invitations create"],
  ["recover", "dashboard reset-sign-in"],
]);

/** Commander diagnostics can contain raw option names/values. Never expose them. */
export function commandError(error: CommanderError, command: Command): never {
  const path = commandPath(command).join(" ");
  // Preserve actionable migration hints using only known command/flag names.
  const has = (flag: string) => command.args.some((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`));
  if (path === "screen" && command.args[0] === "revoke-credential") throw usageError("screen revoke-credential is retired. Archive the screen instead.", { command: "screenrig screen archive <id> --expect-rev REVISION", reason: "Archive hides the screen; it does not unbind the player." });
  if (!path && command.args[0] === "account") {
    const replacement = RETIRED_ACCOUNT_COMMANDS.get(command.args[1] ?? "") ?? "project";
    throw usageError(`account commands are retired. Use screenrig ${replacement}.`, { command: `screenrig ${replacement} --help`, reason: "Shows the replacement's arguments and a working example." });
  }
  if (path.startsWith("comment ")) {
    if (command.commands.length) throw usageError("comment commands require screen <id> or playlist <id>.");
    if (has("expect-rev")) throw usageError("comment commands do not take --expect-rev; last write wins and does not bump revision.");
    if (has("page") && command.name() === "screen") throw usageError("comment screen commands do not take --page; use comment playlist <id> --page PAGE_ID.");
    if (has("value-base64")) throw usageError("comment set requires --json-value or --file.");
    if (error.code === "commander.conflictingOption") throw usageError("comment set requires exactly one of --json-value or --file.");
  }
  if (path === "media list" && has("kind")) throw usageError("media list uses --primitive image|video|audio, not --kind.");
  switch (error.code) {
    case "commander.invalidArgument": {
      const option = command.options.find((candidate) => candidate.argChoices && error.message.startsWith(`error: option '${candidate.flags}'`));
      if (option?.argChoices) {
        const choices = option.argChoices;
        const allowed = choices.length > 2 ? `${choices.slice(0, -1).join(", ")}, or ${choices.at(-1)}` : choices.join(" or ");
        throw usageError(`${option.long} must be ${allowed}.`);
      }
      throw usageError("Invalid argument. See command help for supported values.");
    }
    case "commander.missingArgument":
      if (path === "screen set-timezone") throw usageError("screen set-timezone requires <id> --timezone.");
      throw usageError(`${path} requires ${command.registeredArguments.filter((arg) => arg.required).map((arg) => `<${arg.name()}>`).join(" ")}.`);
    case "commander.excessArguments": {
      const word = command.commands.length && !command.registeredArguments.length && /^[a-z][a-z0-9-]{0,39}$/.test(command.args[0] ?? "") ? command.args[0] : undefined;
      if (word) throw usageError(`${path || "screenrig"} has no command ${word}. See command help for supported commands.`, { command: `screenrig${path ? ` ${path}` : ""} --help`, reason: "List supported commands, arguments, and options." });
      throw usageError(`${path || "screenrig"} does not accept ${command.registeredArguments.length ? "extra" : "positional"} arguments.`);
    }
    case "commander.conflictingOption":
      throw usageError("Conflicting options. See command help.");
    case "commander.missingMandatoryOptionValue": {
      if (path === "screen set-timezone") throw usageError("screen set-timezone requires <id> --timezone.");
      const required = command.options.filter((option) => option.mandatory && command.getOptionValue(option.attributeName()) === undefined);
      const positional = command.registeredArguments.filter((arg, index) => arg.required && index >= command.args.length).map((arg) => `<${arg.name()}>`);
      // Fleet commands take `[id...]` or `--tag TAG`; name the missing target too.
      const fleetTarget = command.registeredArguments.some((arg) => arg.variadic && !arg.required && arg.name() === "id")
        && command.options.some((option) => option.long === "--tag")
        && !command.args.length && command.getOptionValue("tag") === undefined;
      if (fleetTarget) throw usageError(`${path} requires <id> or --tag TAG, and ${required.map((option) => option.long).join(" ")}.`);
      throw usageError(`${path} requires ${[...positional, ...required.map((option) => option.long)].join(" ")}.`);
    }
    case "commander.optionMissingArgument": {
      const option = command.options.find((candidate) => error.message.includes(`option '${candidate.flags}'`));
      throw usageError(option ? `${option.long} requires a value.` : "An option requires a value. See command help for its arguments.");
    }
    case "commander.unknownOption": {
      const option = safeName(error.message, /unknown option '([^']*)'/, /^--?[A-Za-z][A-Za-z0-9-]{0,39}$/, "=");
      if (option) throw usageError(`${path || "screenrig"} does not accept ${option}. See command help for supported options.`, { command: `screenrig${path ? ` ${path}` : ""} --help`, reason: "List supported commands, arguments, and options." });
      break;
    }
    case "commander.unknownCommand": {
      const name = safeName(error.message, /unknown command '([^']*)'/, /^[a-z][a-z0-9-]{0,39}$/);
      if (name) throw usageError(`${path || "screenrig"} has no command ${name}. See command help for supported commands.`, { command: `screenrig${path ? ` ${path}` : ""} --help`, reason: "List supported commands, arguments, and options." });
      break;
    }
  }
  throw usageError("Unknown command or unsupported option. See command help for supported arguments.", { command: `screenrig${path ? ` ${path}` : ""} --help`, reason: "List supported commands, arguments, and options." });
}

/** The option or command name commander quoted, without any `=value`; only a plain name shape is ever echoed. */
function safeName(message: string, quoted: RegExp, shape: RegExp, cut?: string): string | undefined {
  const raw = quoted.exec(message)?.[1];
  const name = raw !== undefined && cut ? raw.split(cut)[0]! : raw;
  return name !== undefined && shape.test(name) ? name : undefined;
}
