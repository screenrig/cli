import type { ParsedArgs } from "./argv.js";
import { BOOLEAN_FLAGS, COMMAND_SPECS, GLOBAL_FLAGS } from "./command-spec.js";
import { quotedRevision } from "./if-match.js";
import { usageError } from "./problems.js";

const NUMERIC_FLAGS = new Set(["timeout", "poll-ms", "target-width", "target-height", "limit", "max-fps", "max-edge", "webp-quality", "duration-ms", "concurrency", "frame-ms"]);

/** Validate before config reads, enrollment, local writes, or transport calls. */
export function validateInvocation(args: ParsedArgs): void {
  const flags = args.flags;
  let words = args.positionals[0] === "help" ? args.positionals.slice(1) : args.positionals;
  const alias = COMMAND_SPECS.find((candidate) => candidate.aliases?.some((path) => path.every((word, index) => words[index] === word)));
  if (alias) words = [...alias.path, ...words.slice(alias.path.length)];
  if (words[0] === "screen" && words[1] === "revoke-credential") throw usageError("screen revoke-credential is retired. Archive the screen instead.", { command: "screenrig --json screen archive <id> --if-match REVISION", reason: "Archive hides the screen; it does not unbind the player." });
  const subtree = COMMAND_SPECS.some((candidate) => words.every((word, index) => candidate.path[index] === word));
  const help = flags.help === true || args.positionals[0] === "help" || words.length === 0 || (subtree && !COMMAND_SPECS.some((candidate) => candidate.path.length === words.length && candidate.path.every((word, index) => words[index] === word)));
  const matches = COMMAND_SPECS.filter((spec) => spec.path.every((word, index) => words[index] === word));
  const spec = matches.sort((a, b) => b.path.length - a.path.length)[0];
  if (words.length === 1 && words[0] === "help" && help) words = [];
  if (!spec && !(help && (subtree || words.length === 0))) throw usageError(words[0] === "comment" ? "comment commands require screen <id> or playlist <id>." : "Unknown command. Use --help to discover supported commands.");
  const allowed = new Set<string>([...GLOBAL_FLAGS, ...(spec?.flags ?? [])]);
  for (const [name, value] of Object.entries(flags)) {
    if (!allowed.has(name)) {
      if (words[0] === "comment" && name === "value-base64") throw usageError("comment set requires --json-value or --file.");
      if (words[0] === "comment" && name === "if-match") throw usageError("comment commands do not take --if-match; last write wins and does not bump revision.");
      if (words[0] === "comment" && name === "page") throw usageError("comment screen commands do not take --page; use comment playlist <id> --page PAGE_ID.");
      if (words[0] === "media" && words[1] === "list" && name === "kind") throw usageError("media list uses --primitive image|video, not --kind.");
      throw usageError("Unsupported option for this command. Use --help to discover supported options.");
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (value !== true) throw usageError(`--${name} takes no value.`);
    } else {
      if (typeof value !== "string" || (!value.length && name !== "value-base64")) throw usageError(`--${name} requires a value.`);
      if (NUMERIC_FLAGS.has(name)) {
        const number = Number(value);
        if (name === "duration-ms" && (!Number.isInteger(number) || number < 2000 || number > 60000)) throw usageError("--duration-ms must be a whole number between 2000 and 60000.");
        if (!value.trim() || !Number.isFinite(number) || number < 0 || (name !== "max-fps" && !Number.isSafeInteger(number))) {
          throw usageError(`--${name} requires a nonnegative ${name === "max-fps" ? "number" : "whole number"}.`);
        }
        if (!["frame-ms", "timeout"].includes(name) && number === 0) throw usageError(`--${name} must be greater than zero.`);
      }
    }
  }
  if (spec && words.length > spec.path.length + spec.maxArgs) throw usageError(spec.maxArgs === 0 ? `${spec.path.join(" ")} does not accept positional arguments.` : `${spec.path.join(" ")} does not accept extra arguments; expected at most ${spec.maxArgs}.`);
  if (help) return;
  if (spec && words.length < spec.path.length + spec.minArgs) throw usageError(words[0] === "screen" && words[1] === "set-timezone" ? "screen set-timezone requires <id> --timezone --if-match." : `${spec.path.join(" ")} requires ${words[0] === "screen" || words[0] === "comment" ? "<id>" : `${spec.minArgs} positional argument(s)`}.`);
  if (typeof flags["if-match"] === "string") quotedRevision(flags["if-match"]);
  const has = (name: string): boolean => Object.hasOwn(flags, name);
  const exclusive = (names: string[]): void => {
    if (names.filter(has).length > 1) throw usageError(`Use only one of ${names.map((name) => `--${name}`).join(", ")}.`);
  };
  exclusive(["after", "cursor"]);
  exclusive(["tag", "clear-tag"]);
  exclusive(["body", "body-file"]);
  if (words[0] === "comment" && has("json-value") && has("file")) throw usageError("comment set requires exactly one of --json-value or --file.");
  exclusive(["json-value", "file", "value-base64"]);
  if (has("target-width") !== has("target-height")) throw usageError("Provide both --target-width and --target-height.");
  if (has("json-value") && has("content-type")) throw usageError("--json-value always uses application/json; omit --content-type.");
  if (has("no-transcode") && ["codec", "max-fps", "max-edge", "webp-quality", "preset", "no-audio"].some(has)) {
    throw usageError("Transcode options require transcoding; remove --no-transcode.");
  }
  if (spec?.path.join(" ") === "playlist import" && has("update") !== has("if-match")) throw usageError("playlist import --update and --if-match must be supplied together.");
}
