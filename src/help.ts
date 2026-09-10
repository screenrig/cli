import { BOOLEAN_FLAGS, COMMAND_SPECS, GLOBAL_FLAGS } from "./command-spec.js";
import { usageError } from "./problems.js";
import { LOOK_AT_THE_CONTACT_SHEET } from "./playlist-preview.js";

const COMMAND_USAGE: Record<string, readonly string[]> = {
  "account show": [
    "account show"
  ],
  "agent enroll": [
    "agent enroll --email ADDRESS [--name NAME] [--open-dashboard]"
  ],
  "agent connect": [
    "agent connect [--name NAME] [--print-url] [--timeout MS]"
  ],
  "agent status": [
    "agent status"
  ],
  "agent disconnect": [
    "agent disconnect --yes [--allow-lockout]"
  ],
  "dashboard": [
    "dashboard [--print-url]"
  ],
  "app pack": [
    "app pack <directory> [--output FILE]"
  ],
  "app upload": [
    "app upload <directory> [--name NAME] [--no-wait] [--poll-ms MS]"
  ],
  "app update": [
    "app update <id> <directory> --if-match REVISION [--no-wait] [--poll-ms MS]"
  ],
  "app list": [
    "app list"
  ],
  "app show": [
    "app show <id>"
  ],
  "media generate": [
    "media generate --prompt TEXT [--aspect-ratio RATIO] [--quality low|medium|high] [--tag TAG]"
  ],
  "media upload": [
    "media upload <file> [--content-type TYPE] [--tag TAG] [--no-wait] [--poll-ms MS] [--no-transcode] [--codec h264|hevc] [--max-fps N] [--max-edge PIXELS] [--webp-quality 1-100] [--no-progress] [--preset signage-1080p30|signage-4k30] [--no-audio]"
  ],
  "media upload-batch": [
    "media upload-batch <manifest.json> --state FILE [--concurrency N] [--no-transcode] [--tag TAG] [--no-progress]"
  ],
  "media show": [
    "media show <id>"
  ],
  "media download": [
    "media download <id> [--output FILE]"
  ],
  "media list": [
    "media list [--tag TAG] [--primitive image|video]"
  ],
  "media update": [
    "media update <id> (--tag TAG | --clear-tag) --if-match REVISION"
  ],
  "media delete": [
    "media delete <id> --if-match REVISION"
  ],
  "compose catalog": [
    "compose catalog (local regions, enter/motion, fonts, examples; no network)"
  ],
  "compose batch": [
    "compose batch <file> --output DIRECTORY [--only ID] [--target-width PX --target-height PX] [--safe-area] [--lint-only] (contact sheet; 1 to 2000 pages)"
  ],
  "playlist validate": [
    "playlist validate <file> [--lint-only]"
  ],
  "compose render": [
    "compose render <file> [--output DIRECTORY] [--combined] [--target-width PX --target-height PX] [--safe-area] [--open] [--lint-only]"
  ],
  "playlist preview": [
    "playlist preview <file|id> --output DIR [--frame-ms MS] [--contact-sheet] [--lint-only]"
  ],
  "playlist templates": [
    "playlist templates"
  ],
  "playlist create": [
    "playlist create <file>"
  ],
  "playlist update": [
    "playlist update <id> <file> --if-match REVISION"
  ],
  "playlist export": [
    "playlist export <id> --output DIRECTORY"
  ],
  "playlist import": [
    "playlist import <directory> [--name NAME] [--update ID --if-match REVISION]"
  ],
  "playlist show": [
    "playlist show <id>"
  ],
  "playlist list": [
    "playlist list"
  ],
  "playlist delete": [
    "playlist delete <id> --if-match REVISION"
  ],
  "screen pair": [
    "screen pair CODE [--label LABEL]"
  ],
  "screen provision": [
    "screen provision (--open | --print-url) [--label LABEL]"
  ],
  "browser setup": [
    "browser setup --code CODE [--open]"
  ],
  "screen update": [
    "screen update <id> [--name NAME] [--playlist-id ID] [--timezone ZONE] --if-match REVISION"
  ],
  "screen list": [
    "screen list [--state archived]"
  ],
  "screen show": [
    "screen show <id>"
  ],
  "screen assign": [
    "screen assign <id> --playlist-id ID --if-match REVISION"
  ],
  "screen set-timezone": [
    "screen set-timezone <id> --timezone ZONE --if-match REVISION"
  ],
  "screen archive": [
    "screen archive <id> --if-match REVISION"
  ],
  "screen unarchive": [
    "screen unarchive <id> --if-match REVISION"
  ],
  "screen delete": [
    "screen delete <id> --if-match REVISION"
  ],
  "screen rotate-public-id": [
    "screen rotate-public-id <id> --if-match REVISION"
  ],
  "screen toast": [
    "screen toast <id> --text TEXT [--level info] [--duration-ms MS]"
  ],
  "screen screenshot": [
    "screen screenshot <id> [--output FILE] [--timeout MS] [--poll-ms MS]"
  ],
  "kv get": [
    "kv get --application-id ID <key>"
  ],
  "kv set": [
    "kv set --application-id ID <key> --json-value JSON [--if-match REVISION]",
    "kv set --application-id ID <key> --file FILE --content-type TYPE [--if-match REVISION]",
    "kv set --application-id ID <key> --value-base64 BASE64 --content-type TYPE [--if-match REVISION]"
  ],
  "kv delete": [
    "kv delete --application-id ID <key> --if-match REVISION"
  ],
  "kv list": [
    "kv list --application-id ID"
  ],
  "comment show screen": [
    "comment show screen <id>"
  ],
  "comment show playlist": [
    "comment show playlist <id> [--page PAGE_ID]"
  ],
  "comment set screen": [
    "comment set screen <id> (--json-value JSON | --file FILE)"
  ],
  "comment set playlist": [
    "comment set playlist <id> [--page PAGE_ID] (--json-value JSON | --file FILE)"
  ],
  "comment delete screen": [
    "comment delete screen <id>"
  ],
  "comment delete playlist": [
    "comment delete playlist <id> [--page PAGE_ID]"
  ],
  "operations get": [
    "operations get <id>"
  ],
  "operations wait": [
    "operations wait <id> [--timeout MS] [--poll-ms MS]"
  ],
  "operations cancel": [
    "operations cancel <id>"
  ],
  "events list": [
    "events list [--after CURSOR] [--limit N]"
  ],
  "events follow": [
    "events follow [--after CURSOR] [--timeout MS]"
  ],
  "playback list": [
    "playback list [--screen-id ID] [--media-id ID] [--day YYYY-MM-DD]"
  ],
  "feedback bug": [
    "feedback bug <title> (--body TEXT | --body-file FILE) [--command \"GROUP ACTION\"] [--no-context]"
  ],
  "feedback feature": [
    "feedback feature <title> (--body TEXT | --body-file FILE) [--command \"GROUP ACTION\"] [--no-context]"
  ],
  "feedback list": [
    "feedback list [--kind bug|feature]"
  ],
  "doctor": [
    "doctor [--repair-config]"
  ],
  "version": [
    "version"
  ]
};

export const CREDIT_HELP = "Credits:\n  Remaining is a nonnegative whole number (never negative; empty remaining\n  displays 0). Below 1000 credits, authenticated responses may warn\n  credits_low. Until 1 Jan 2027 08:00 UTC (midnight PT), production fails open:\n  billed commands are not rejected for empty remaining and do not return\n  HTTP 402. After that instant, remaining below 1 credit is payment_required.\n  Empty remaining does not stop or shut off screens in this window.\n  media generate is the exception: it is billed per token.\n  Text input is $10 / 1M tokens, image input is $16 / 1M, image output is\n  $60 / 1M. Quality changes how detailed the still is and therefore how\n  many tokens it uses. Remaining that cannot cover the debit returns\n  payment_required / 402, including during this window.";

const SUMMARIES: Record<string, string> = {
  account: "Inspect your account and credits",
  agent: "Enroll, connect, and manage this agent",
  dashboard: "Open the account dashboard",
  app: "Pack, upload, and inspect applications",
  media: "Generate, upload, and manage images and videos",
  compose: "Render and inspect local page compositions",
  playlist: "Author, validate, preview, and manage playlists",
  screen: "Pair, configure, and inspect screens",
  browser: "Complete browser Player setup",
  kv: "Read and write application key-value data",
  comment: "Read and manage screen and playlist comments",
  operations: "Inspect, wait for, or cancel operations",
  events: "List or follow account events",
  playback: "Inspect playback records",
  feedback: "Submit bugs and feature requests",
  doctor: "Check this CLI installation and configuration",
  version: "Show CLI and protocol versions",
  help: "Discover commands and their options",
};

const ACTION_SUMMARIES: Record<string, string> = {
  enroll: "Create the first agent with an email address", connect: "Connect this installation with approval",
  status: "Inspect this agent's connection", disconnect: "Disconnect this agent",
  pack: "Pack a local application directory", upload: "Upload a local file or directory",
  update: "Update an existing resource", list: "List resources", show: "Inspect a resource",
  generate: "Generate an image from a prompt", download: "Download media to a file",
  "upload-batch": "Upload a manifest with resumable state", delete: "Delete a resource",
  catalog: "Browse local composition capabilities and examples", batch: "Render a batch of compositions",
  render: "Render a composition locally", validate: "Validate a playlist file",
  preview: "Render playlist previews and a contact sheet", templates: "Browse playlist templates",
  create: "Create a playlist from a file", export: "Export a playlist bundle", import: "Import a playlist bundle",
  pair: "Claim a Player pairing code", provision: "Create a screen and browser handoff",
  setup: "Complete browser setup from a code", assign: "Assign a playlist to a screen",
  "set-timezone": "Set a screen's timezone", archive: "Archive a screen", unarchive: "Restore an archived screen",
  "rotate-public-id": "Rotate a screen's public identifier", toast: "Show a temporary screen message",
  screenshot: "Capture and download a screen screenshot", get: "Read the current value or operation",
  set: "Write a value", wait: "Wait for an operation to finish", cancel: "Cancel an operation",
  follow: "Stream account events", bug: "Submit a bug report", feature: "Submit a feature request",
};

const NOTES: Record<string, string> = {
  "agent connect": "Approval expires after 24 hours; --timeout defaults to 86400000 ms. Retry agent connect to resume after an interrupted wait.",
  "media generate": CREDIT_HELP,
  "account show": CREDIT_HELP,
  "compose render": LOOK_AT_THE_CONTACT_SHEET,
  "compose batch": LOOK_AT_THE_CONTACT_SHEET,
  "playlist preview": LOOK_AT_THE_CONTACT_SHEET,
};

export interface HelpDocument {
  path: string[];
  aliases: string[][];
  kind: "group" | "command";
  usage: string;
  synopsis: string[];
  commands: Array<{ name: string; path: string[]; kind: "group" | "command"; summary: string; help: string }>;
  options: Array<{ name: string; type: "boolean" | "value" }>;
  globalOptions: Array<{ name: string; type: "boolean" | "value" }>;
  notes: string[];
}

function matches(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}

export function isHelpGroup(path: readonly string[]): boolean {
  return COMMAND_SPECS.some((spec) => spec.path.length > path.length && matches(path, spec.path));
}

/** Resolve only command path components: arbitrary extra arguments are never hidden by help. */
export function commandHelp(path: readonly string[] = [], invocation = false): HelpDocument {
  if (invocation) {
    const invoked = COMMAND_SPECS.find((spec) => [spec.path, ...(spec.aliases ?? [])].some((candidate) =>
      path.length >= candidate.length && path.length <= candidate.length + spec.maxArgs && matches(candidate, path)));
    if (invoked) return commandHelp(invoked.path);
  }
  const alias = COMMAND_SPECS.find((spec) => spec.aliases?.some((candidate) => candidate.length === path.length && matches(path, candidate)));
  if (alias) return commandHelp(alias.path);
  const leaf = COMMAND_SPECS.find((spec) => spec.path.length === path.length && matches(path, spec.path));
  const descendants = COMMAND_SPECS.filter((spec) => matches(path, spec.path));
  const helpLeaf = path.length === 1 && path[0] === "help";
  if (!leaf && !descendants.length && path.length && !helpLeaf) {
    throw usageError("Unknown help topic.", {
      command: "screenrig help",
      reason: "List command groups, then request help for a group or command.",
    });
  }
  const key = path.join(" ");
  const childNames = [...new Set(descendants.filter((spec) => spec.path.length > path.length).map((spec) => spec.path[path.length]!))];
  if (!path.length) childNames.push("help");
  const commands = childNames.map((name) => {
    const childPath = [...path, name];
    const group = isHelpGroup(childPath);
    return {
      name,
      path: childPath,
      kind: group ? "group" as const : "command" as const,
      summary: SUMMARIES[childPath.join(" ")] ?? (group ? `Discover ${name} commands` : ACTION_SUMMARIES[name] ?? `Manage ${name} comments`),
      help: `screenrig ${childPath.join(" ")} --help`,
    };
  });
  const synopsis = helpLeaf ? ["screenrig help [command [subcommand ...]]"] : leaf
    ? (COMMAND_USAGE[key] ?? [key]).map((line) => `screenrig ${line}`)
    : [`screenrig${key ? ` ${key}` : ""} <command> [args]`];
  const option = (flag: string) => ({ name: `--${flag}`, type: BOOLEAN_FLAGS.has(flag) ? "boolean" as const : "value" as const });
  const options = leaf ? [...leaf.flags].map(option) : [];
  const globalOptions = [...GLOBAL_FLAGS].filter((flag) => flag !== "token").map(option);
  const optionText = (item: {name: string; type: string}) => `${item.name}${item.type === "value" ? " VALUE" : ""}`;
  const notes = NOTES[key] ? [NOTES[key]!] : [];
  if (leaf?.aliases?.length) notes.push(`Aliases: ${leaf.aliases.map((aliasPath) => `screenrig ${aliasPath.join(" ")}`).join(", ")}`);
  const lines = [path.length ? `screenrig ${key}` : "screenrig — Signage and kiosk infrastructure for agents", "", "Usage:", ...synopsis.map((line) => `  ${line}`)];
  if (commands.length) lines.push("", "Commands:", ...commands.map((command) => `  ${command.name.padEnd(16)} ${command.summary}`));
  if (options.length) lines.push("", `Command options: ${options.map(optionText).join(" ")}`);
  lines.push("", `Global options: ${globalOptions.map(optionText).join(" ")}`, "", "Use screenrig <command> --help to explore each group or action. Add --json for structured help.");
  if (notes.length) lines.push("", ...notes);
  return { path: [...path], aliases: leaf?.aliases?.map((aliasPath) => [...aliasPath]) ?? [], kind: leaf || helpLeaf ? "command" : "group", usage: lines.join("\n"), synopsis, commands, options, globalOptions, notes };
}

export const ROOT_HELP = commandHelp().usage;
