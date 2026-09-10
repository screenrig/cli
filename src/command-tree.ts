import { Command, CommanderError, Option } from "commander";
import { COMMAND_SPECS, GLOBAL_FLAGS } from "./command-spec.js";
import { ACTION_SUMMARIES, SUMMARIES } from "./help-text.js";
import { quotedRevision } from "./if-match.js";
import { usageError } from "./problems.js";
import { CLI_VERSION } from "./version.js";

const OPTION_HELP: Record<string, [string, string]> = {
  json: ["", "Return a JSON envelope"],
  "api-url": ["URL", "Override the API origin"], config: ["PATH", "Use this credential/configuration file"],
  "request-id": ["ID", "Use a request correlation ID"], "idempotency-key": ["KEY", "Reuse a key when retrying the same write"],
  timeout: ["MS", "Set the command timeout in milliseconds"], "beta-key": ["KEY", "Supply an enrollment beta key"], token: ["TOKEN", "Override the stored credential"],
  email: ["ADDRESS", "Set the account contact email"], name: ["NAME", "Set the resource or agent name"],
  "open-dashboard": ["", "Open the dashboard after enrolling"], "print-url": ["", "Return the browser handoff URL"],
  yes: ["", "Confirm this agent's disconnection"], "allow-lockout": ["", "Allow disconnecting the last agent"],
  output: ["PATH", "Write the result to this file or directory"], "no-wait": ["", "Return after acceptance without waiting for processing"],
  "poll-ms": ["MS", "Set the operation polling interval"], "if-match": ["REVISION", "Require the current resource revision"],
  prompt: ["TEXT", "Describe the complete image to generate"], "aspect-ratio": ["RATIO", "Choose the generated image aspect ratio"],
  quality: ["low|medium|high", "Choose generation quality"], tag: ["TAG", "Set or filter by a media tag"],
  "content-type": ["TYPE", "Declare the content MIME type"], "no-transcode": ["", "Upload accepted source bytes unchanged"],
  codec: ["h264|hevc", "Choose the video codec (default: h264)"], "max-fps": ["N", "Limit video frames per second"],
  "max-edge": ["PIXELS", "Limit the longest video edge"], "webp-quality": ["1-100", "Set WebP quality"],
  "no-progress": ["", "Suppress stderr progress"], preset: ["PRESET", "Use signage-1080p30 or signage-4k30"], "no-audio": ["", "Remove the audio track when transcoding"],
  state: ["VALUE", "Select archived screens or an upload-batch state file"], concurrency: ["N", "Set concurrent batch uploads"],
  primitive: ["image|video", "Filter by media primitive"], "clear-tag": ["", "Remove the media tag"],
  only: ["ID", "Render only this page"], "target-width": ["PX", "Set the physical content width"], "target-height": ["PX", "Set the physical content height"],
  "safe-area": ["", "Apply the display safe area"], "lint-only": ["", "Run the command's local validation/lint mode"], combined: ["", "Also render combined page images"], open: ["", "Open the result in its viewer"],
  "frame-ms": ["MS", "Select the preview frame time"], "contact-sheet": ["", "Include a contact sheet"], update: ["ID", "Update this playlist when importing"],
  label: ["LABEL", "Set the screen label"], code: ["CODE", "Use the browser setup code"], "playlist-id": ["ID", "Select the playlist to assign"], timezone: ["ZONE", "Set an IANA timezone"],
  text: ["TEXT", "Set the screen message"], level: ["LEVEL", "Set toast level (default: info)"], "duration-ms": ["MS", "Show the message for 2000–60000 milliseconds"],
  "application-id": ["ID", "Select the application's K/V namespace"], "json-value": ["JSON", "Supply a JSON value"], file: ["FILE", "Read the value from a file"], "value-base64": ["BASE64", "Supply canonical base64 bytes (may be empty)"],
  page: ["PAGE_ID", "Select playlist page comments"], after: ["CURSOR", "Read events after this cursor"], cursor: ["CURSOR", "Alias for --after"], limit: ["N", "Limit returned events"],
  "screen-id": ["ID", "Filter playback by screen"], "media-id": ["ID", "Filter playback by media"], day: ["YYYY-MM-DD", "Filter playback by UTC day"],
  body: ["TEXT", "Supply feedback details"], "body-file": ["FILE", "Read feedback details from a file"], command: ["GROUP ACTION", "Identify the command involved"], "no-context": ["", "Omit diagnostic context"], kind: ["bug|feature", "Filter feedback by kind"],
  "repair-config": ["", "Repair configuration permissions"],
};
const NUMERIC_FLAGS = new Set(["timeout", "poll-ms", "target-width", "target-height", "limit", "max-fps", "max-edge", "webp-quality", "duration-ms", "concurrency", "frame-ms"]);
const CONFLICTS: readonly (readonly string[])[] = [
  ["after", "cursor"], ["tag", "clear-tag"], ["body", "body-file"], ["json-value", "file", "value-base64"], ["json-value", "content-type"],
  ...["codec", "max-fps", "max-edge", "webp-quality", "preset", "no-audio"].map((flag) => ["no-transcode", flag]),
];

/** Canonical command names, excluding the executable and any supplied values. */
export function commandPath(command: Command): string[] {
  return command.parent ? [...commandPath(command.parent), command.name()] : [];
}

export function findCommand(root: Command, path: readonly string[]): Command | undefined {
  let command = root;
  for (const word of path) {
    const child = command.commands.find((candidate) => candidate.name() === word || candidate.aliases().includes(word));
    if (!child) return undefined;
    command = child;
  }
  return command;
}

/** Read explicit CLI options only; Commander defaults must not become write flags. */
export function invocationFlags(command: Command): Record<string, string | boolean> {
  const flags = Object.create(null) as Record<string, string | boolean>;
  for (let current: Command | null = command; current; current = current.parent) {
    for (const option of current.options) {
      if (current.getOptionValueSource(option.attributeName()) !== "cli") continue;
      flags[option.long!.slice(2)] = option.negate ? true : current.getOptionValue(option.attributeName());
    }
  }
  return flags;
}

function optionValue(name: string, value: string, argv: readonly string[]): string {
  if ((!value.length && name !== "value-base64") ||
      (value.startsWith("-") && !/^-\d/.test(value) && !argv.includes(`--${name}=${value}`))) {
    throw usageError(`--${name} requires a value. Use --${name}=VALUE for a value starting with a dash.`);
  }
  if (NUMERIC_FLAGS.has(name)) {
    const number = Number(value);
    if (name === "duration-ms" && (!Number.isInteger(number) || number < 2000 || number > 60000)) throw usageError("--duration-ms must be a whole number between 2000 and 60000.");
    if (!value.trim() || !Number.isFinite(number) || number < 0 || (name !== "max-fps" && !Number.isSafeInteger(number))) throw usageError(`--${name} requires a nonnegative ${name === "max-fps" ? "number" : "whole number"}.`);
    if (!["timeout", "frame-ms"].includes(name) && number === 0) throw usageError(`--${name} must be greater than zero.`);
  }
  if (name === "if-match") quotedRevision(value);
  return value;
}

/** Commander diagnostics can contain raw option names/values. Never expose them. */
function commandError(error: CommanderError, command: Command): never {
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
    case "commander.conflictingOption": {
      const supplied = command.options.filter((option) => command.getOptionValueSource(option.attributeName()) === "cli");
      const pair = CONFLICTS.map((group) => supplied.filter((option) => group.includes(option.long!.slice(2)))).find((options) => options.length > 1);
      const [first, second] = pair ?? [];
      throw usageError(first && second ? `Use only one of ${first.long}, ${second.long}.` : "Conflicting options. See command help.");
    }
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

export interface CommandTree {
  root: Command;
  selected: () => Command;
  helpRequested: () => boolean;
  versionRequested: () => boolean;
}

/** Build fresh commands per invocation: no shared parsed values or process exits. */
export function createCommandTree(argv: readonly string[] = []): CommandTree {
  let selected: Command;
  let helpRequested = false;
  let versionRequested = false;
  const seen = new Set<string>();
  const configure = (command: Command): Command => command
    .allowExcessArguments(false)
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
  const root = configure(new Command("screenrig")).description("Signage and kiosk infrastructure for agents");
  selected = root;
  root.version(CLI_VERSION, "-V, --version", "Show CLI and protocol versions");
  const addOption = (command: Command, name: string): void => {
    const entry = OPTION_HELP[name];
    if (!entry) throw new Error(`Missing option definition: ${name}`);
    const [placeholder, description] = entry;
    const option = new Option(`--${name}${placeholder ? ` <${placeholder}>` : ""}`, description);
    if (placeholder) option.argParser((value: string) => optionValue(name, value, argv));
    if (name === "token") option.hideHelp();
    command.addOption(option);
    command.on(`option:${option.name()}`, () => {
      if (seen.has(name)) throw usageError(`--${name} may be supplied only once.`);
      seen.add(name);
    });
  };
  for (const name of GLOBAL_FLAGS) addOption(root, name);
  for (const spec of COMMAND_SPECS) {
    let command = root;
    for (const word of spec.path) {
      let child = command.commands.find((candidate) => candidate.name() === word);
      if (!child) {
        child = configure(command.createCommand(word));
        command.addCommand(child);
        child.description(SUMMARIES[commandPath(child).join(" ")] ?? ACTION_SUMMARIES[word] ?? `Manage ${word} comments`);
      }
      command = child;
    }
    if (spec.arguments) command.arguments(spec.arguments);
    for (const alias of spec.aliases ?? []) command.alias(alias[alias.length - 1]!);
    for (const name of spec.flags) addOption(command, name);
    for (const name of spec.requiredFlags ?? []) {
      const option = command.options.find((option) => option.long === `--${name}`)!;
      option.makeOptionMandatory();
      option.description += " (required)";
    }
    for (const group of CONFLICTS) {
      const options = command.options.filter((option) => group.includes(option.long!.slice(2)));
      for (const option of options) option.conflicts(options.filter((other) => other !== option).map((other) => other.attributeName()));
    }
    command.action(() => { selected = command; });
  }
  const help = configure(new Command("help")).description("Discover commands and their options").argument("[command...]", "Command path to inspect");
  root.addCommand(help);
  help.action((path: string[]) => {
    const target = findCommand(root, path);
    if (!target) throw usageError("Unknown help topic.");
    target.help();
  });
  const groups = (command: Command): void => {
    if (command.commands.length) command.action(() => command.help());
    command.commands.forEach(groups);
  };
  groups(root);
  return { root, selected: () => selected, helpRequested: () => helpRequested, versionRequested: () => versionRequested };
}
