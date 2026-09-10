import { Command, Option } from "commander";
import type { ParsedArgs } from "./command-input.js";
import type { CommandHandler } from "./commands.js";
import { commandError } from "./cli-errors.js";
import { commandPath, findCommand, invocationFlags } from "./command-path.js";
import { registerCommands } from "./cli-commands/index.js";
import { usageError } from "./problems.js";
import { CLI_VERSION } from "./version.js";

export { commandPath, findCommand, invocationFlags } from "./command-path.js";

export interface CommandTree {
  root: Command;
  selected: () => Command;
  helpRequested: () => boolean;
  versionRequested: () => boolean;
}

export function commandInput(command: Command): ParsedArgs {
  const positionals = [...commandPath(command), ...command.args];
  return { command: positionals.slice(0, 2), positionals, flags: invocationFlags(command) };
}

/** Shared transport safeguards, independent of the individual command definitions. */
function protectOption(command: Command, option: Option, argv: readonly string[], seen: Set<string>): void {
  const name = option.long!.slice(2);
  if (option.required || option.optional) {
    const parser = option.parseArg;
    option.argParser((value: string, previous: unknown) => {
      // An option-looking token is usually a missing value. Explicit '=' permits it.
      if ((!value.length && name !== "value-base64") ||
          (value.startsWith("-") && !/^-\d/.test(value) && !argv.includes(`--${name}=${value}`))) {
        throw usageError(`--${name} requires a value. Use --${name}=VALUE for a value starting with a dash.`);
      }
      return parser ? parser(value, previous) : value;
    });
  }
  command.on(`option:${option.name()}`, () => {
    if (seen.has(name)) throw usageError(`--${name} may be supplied only once.`);
    seen.add(name);
  });
}

/** Fresh native commands per invocation; actions return their asynchronous work. */
export function createCommandTree(
  argv: readonly string[] = [],
  execute?: (handler: CommandHandler, args: ParsedArgs) => Promise<void>,
): CommandTree {
  const end = argv.indexOf("--");
  const tokens = end < 0 ? argv : argv.slice(0, end);
  for (const spellings of [["--help", "-h"], ["--version", "-V"]]) {
    if (tokens.filter((arg) => spellings.includes(arg)).length > 1) throw usageError(`${spellings[0]} may be supplied only once.`);
  }
  const root = new Command("screenrig")
    .description("Signage and kiosk infrastructure for agents")
    .version(CLI_VERSION, "-V, --version", "Show CLI and protocol versions");
  let selected = root;
  let helpRequested = false;
  let versionRequested = false;
  const seen = new Set<string>();

  registerCommands(root, (handler) => (...values: unknown[]) => {
    selected = values[values.length - 1] as Command;
    return execute?.(handler, commandInput(selected));
  });
  root.command("help [command...]")
    .description("Discover commands and their options")
    .action((path: string[]) => {
      const target = findCommand(root, path);
      if (!target) throw usageError("Unknown help topic.");
      target.help();
    });

  const configure = (command: Command): void => {
    command.allowExcessArguments(false)
      .addHelpCommand(false)
      .showSuggestionAfterError(false)
      .configureOutput({ writeOut() {}, writeErr() {}, outputError() {} })
      .configureHelp({ helpWidth: 100, showGlobalOptions: true })
      .exitOverride((error) => {
        selected = command;
        if (error.code === "commander.helpDisplayed" || error.code === "commander.help") helpRequested = true;
        else if (error.code === "commander.version") versionRequested = true;
        else commandError(error, command);
        throw error;
      });
    for (const option of command.options) {
      // Commander handles the built-in version option before emitting option events.
      if (option.long !== "--version") protectOption(command, option, tokens, seen);
    }
    if (command.commands.length) command.action(() => command.help());
    command.commands.forEach(configure);
  };
  configure(root);
  return { root, selected: () => selected, helpRequested: () => helpRequested, versionRequested: () => versionRequested };
}
