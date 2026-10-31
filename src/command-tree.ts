import { FEED_REPEATABLE_FLAGS } from "./cards.js";
import { Command, Option } from "commander";
import type { ParsedArgs } from "./command-input.js";
import type { CommandHandler } from "./commands.js";
import { commandError } from "./cli-errors.js";
import { commandPath, findCommand, flagName, invocationFlags } from "./command-path.js";
import { registerCommands, type CommandRegistrar } from "./cli-commands/index.js";
import { usageError } from "./problems.js";
import { CLI_VERSION } from "./version.js";

export { commandFromArgv, commandPath, findCommand, invocationFlags } from "./command-path.js";

export interface CommandTree {
  root: Command;
  selected: () => Command;
  helpRequested: () => boolean;
  versionRequested: () => boolean;
  inventoryRequested: () => boolean;
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
      // An option-looking token is usually a missing value. Explicit '=' permits it,
      // and a lone - is stdin where the help documents it, or stdout for the playback and direct report CSV --output.
      const csvOutput = name === "output" && (command.parent?.name() === "playback" || (command.name() === "report" && command.parent?.name() === "direct"));
      const dash = value === "-" && (/\bstdin\b/.test(option.description) || csvOutput);
      if ((!value.length && name !== "value-base64") ||
          (value.startsWith("-") && !dash && !/^-\d/.test(value) && !argv.includes(`--${name}=${value}`))) {
        throw usageError(`--${name} requires a value. Use --${name}=VALUE for a value starting with a dash.`);
      }
      return parser ? parser(value, previous) : value;
    });
  }
  command.on(`option:${option.name()}`, () => {
    const repeatable = (name === "capability" && command.name() === "create" && command.parent?.name() === "service-client")
      || (name === "tag" && ["fleet-links", "notifications"].includes(command.parent?.name() ?? "") && ["create", "update"].includes(command.name()))
      || (["any-tag", "all-tags", "severity", "active-hours"].includes(name) && command.parent?.name() === "notifications" && ["create", "update"].includes(command.name()))
      || (name === "window" && command.parent?.name() === "reboot-schedule" && command.name() === "set")
      || (name === "field" && command.parent?.name() === "fleet-links" && ["create", "update"].includes(command.name()))
      || (["set", "clear"].includes(name) && command.parent?.name() === "playlist" && ["create", "fields"].includes(command.name()))
      || (["var", "page"].includes(name) && command.parent?.name() === "view" && ["create", "update"].includes(command.name()))
      || (name === "screen-id" && command.parent?.name() === "triggers" && ["create", "update"].includes(command.name()))
      || (["set", "secret", "unset-secret"].includes(name) && command.parent?.name() === "source" && ["create", "update", "test"].includes(command.name()))
      || (["screen-id", "tag"].includes(name) && command.parent?.name() === "alerts" && command.name() === "mute")
      || (name === "filter" && command.parent?.name() === "subscriptions" && ["create", "update"].includes(command.name()))
      || (command.parent?.name() === "screen" && ((command.name() === "update" && (name === "field" || name === "unset-field")) || (command.name() === "list" && name === "field")))
      || (["tag", "any-tag", "screen-id", "window", "monthly", "date", "except"].includes(name) && command.parent?.name() === "campaign" && ["create", "update", "preview"].includes(command.name()))
      || (command.parent?.name() === "feeds" && command.name() === "get" && (FEED_REPEATABLE_FLAGS as readonly string[]).includes(name));
    if (seen.has(flagName(option)) && !repeatable) throw usageError(`--${name} may be supplied only once.`);
    seen.add(flagName(option));
  });
}

/** Fresh native commands per invocation; actions return their asynchronous work. */
export function createCommandTree(
  argv: readonly string[],
  execute: ((handler: CommandHandler, args: ParsedArgs) => Promise<void>) | undefined,
  registrars: readonly CommandRegistrar[],
): CommandTree {
  const end = argv.indexOf("--");
  const tokens = end < 0 ? argv : argv.slice(0, end);
  if (tokens.includes("--json") && tokens.includes("--human")) {
    throw usageError("--json and --human are mutually exclusive.");
  }
  for (const spellings of [["--help", "-h"], ["--version", "-V"]]) {
    if (tokens.filter((arg) => spellings.includes(arg)).length > 1) throw usageError(`${spellings[0]} may be supplied only once.`);
  }
  const root = new Command("screenrig")
    .description("Signage and kiosk infrastructure for agents")
    .version(CLI_VERSION, "-V, --version", "Show CLI and protocol versions");
  let selected = root;
  let helpRequested = false;
  let versionRequested = false;
  let inventoryRequested = false;
  const seen = new Set<string>();

  registerCommands(root, (handler) => (...values: unknown[]) => {
    selected = values[values.length - 1] as Command;
    return execute?.(handler, commandInput(selected));
  }, registrars);
  root.command("help [command...]")
    .description("Discover commands; --all lists every command")
    .option("--all", "Include all descendant command paths")
    .action((path: string[], options: { all?: boolean }) => {
      inventoryRequested = options.all === true;
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
  return { root, selected: () => selected, helpRequested: () => helpRequested, versionRequested: () => versionRequested, inventoryRequested: () => inventoryRequested };
}
