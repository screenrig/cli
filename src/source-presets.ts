import { requireToken, type ApiClient } from "./client.js";
import { clientFor, commandHandler, jsonBody } from "./commands.js";
import { ExitCode } from "./exit-codes.js";
import { CliError, usageError } from "./problems.js";
import { table } from "./webhooks.js";

// Source presets: ready-made, tested configurations of the json data source for
// one service (a Slack channel, a job board, a build board). A person picks a
// card and fills a few fields instead of writing a config and a mapping.
//
// TYPED BY HAND, NOT GENERATED. vendor/openapi.yaml carries no presets routes
// today, so this file types them itself, following the SourcePreset schema the
// backend publishes for them, and keeps to the two reads and the value rule
// below. A source made from a preset is created, previewed and changed through
// the ordinary source routes with preset and settings in place of kind and
// config (sources.ts). Replace these types with the generated ones, and check
// SOURCE_PRESETS_PATH, when the contract sync brings the routes.

export const SOURCE_PRESETS_PATH = "/api/source-presets";
export const SOURCE_PRESET_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface SourcePresetOption { value: string; label: string }
export interface SourcePresetField {
  name: string; label: string; type: "text" | "choice" | "list"; required: boolean; help: string;
  example?: string; default?: string; pattern?: string; max_length?: number;
  options?: SourcePresetOption[];
  min_items?: number; max_items?: number;
  /** The fields of each item of a list. */
  fields?: SourcePresetField[];
}
export interface SourcePresetSecret { name: string; label: string; help: string; how_to_get: string; required: boolean }
export interface SourcePreset {
  name: string; title: string; category: string; description: string;
  /** The kind of source it makes. */
  kind: string;
  /** The cards it fills, the first the one it is made for. */
  cards: Array<{ type: string; default: boolean }>;
  fields: SourcePresetField[];
  secrets: SourcePresetSecret[];
  refresh_seconds: number; min_refresh_seconds: number; stale_after_seconds: number;
  attribution: { text: string; terms?: string };
  docs: string;
}
export interface SourcePresetList { items: SourcePreset[] }

/** `source presets NAME`: a name as the backend writes one, lower-case words joined by hyphens. */
export function sourcePresetName(value: string): string {
  if (!SOURCE_PRESET_NAME_PATTERN.test(value)) {
    throw usageError("A preset name is lower-case words joined by hyphens, such as slack-channel.", { command: "screenrig source presets", reason: "List the presets and their names." });
  }
  return value;
}

/** `--preset NAME`, checked as an option is read. */
export function sourcePresetOption(value: string): string {
  return sourcePresetName(value);
}

/**
 * A `--set FIELD=VALUE` of a preset. A preset field is text, a choice (text too) or
 * a list of objects, so a value is the text as written: only a JSON array or
 * object (a list's items) and null (it removes an optional setting on update) are
 * read as JSON. 14 stays the text "14" and true the text "true", which a field
 * with a pattern would otherwise refuse as a number or a boolean.
 */
export function presetSettingValue(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  return parsed === null || typeof parsed === "object" || typeof parsed === "string" ? parsed : text;
}

/** A preset's card: the one it is made for, then the others. */
export function presetCardTypes(preset: SourcePreset): string[] {
  const cards = preset.cards ?? [];
  return [...cards.filter((card) => card.default), ...cards.filter((card) => !card.default)].map((card) => card.type);
}

function durationText(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function sourcePresetTableLines(items: SourcePreset[]): string[] {
  if (!items.length) return ["No source presets"];
  return table(["NAME", "TITLE", "CARD", "CATEGORY"], items.map((item) => [item.name, item.title, presetCardTypes(item).join(", "), item.category]));
}

function fieldLines(fields: SourcePresetField[], indent: string): string[] {
  return fields.flatMap((field) => {
    const detail = [field.example !== undefined ? `example: ${field.example}` : "", field.default !== undefined ? `default: ${field.default}` : "",
      field.pattern ? `pattern: ${field.pattern}` : "", field.max_length ? `at most ${field.max_length} characters` : ""].filter(Boolean);
    return [
      `${indent}${field.name} (${field.type}${field.required ? ", required" : ""}): ${field.label}`,
      ...(field.help ? [`${indent}  ${field.help}`] : []),
      ...(detail.length ? [`${indent}  ${detail.join("; ")}`] : []),
      ...(field.options?.length ? [`${indent}  one of: ${field.options.map((option) => option.value === option.label ? option.value : `${option.value} (${option.label})`).join(", ")}`] : []),
      ...(field.type === "list" ? [`${indent}  a JSON array of ${field.min_items ?? 0} to ${field.max_items ?? "any number of"} items, each an object with:`, ...fieldLines(field.fields ?? [], `${indent}    `)] : []),
    ];
  });
}

/** A value as one shell word: as it is when it holds nothing a shell reads, else in single quotes. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_.\/:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** `--set` for a required field, with its example: a list is a JSON array of one item that has the item's required fields. */
function exampleSet(field: SourcePresetField): string {
  if (field.type === "list") {
    const item = Object.fromEntries((field.fields ?? []).filter((member) => member.required).map((member) => [member.name, member.example ?? "VALUE"]));
    return `--set ${field.name}=${shellWord(JSON.stringify([item]))}`;
  }
  return `--set ${field.name}=${shellWord(field.example ?? "VALUE")}`;
}

/** One preset in full: what it fills, the fields to set, the credentials and where to get them. */
export function sourcePresetLines(preset: SourcePreset | undefined): string[] {
  if (!preset) return [];
  const cards = presetCardTypes(preset);
  const required = preset.fields.filter((field) => field.required);
  const neededSecrets = preset.secrets.filter((secret) => secret.required);
  return [
    `name: ${preset.name}`,
    `title: ${preset.title}`,
    `category: ${preset.category}`,
    `description: ${preset.description}`,
    `kind: ${preset.kind}`,
    `cards: ${cards.map((card, index) => (index === 0 && cards.length > 1 ? `${card} (the one it is made for)` : card)).join(", ")}; --card names an instance of ${cards.length === 1 ? "that card" : "one of them"} (card create)`,
    `refresh: every ${durationText(preset.refresh_seconds)} (at least ${durationText(preset.min_refresh_seconds)}); the card keeps its last good data for ${durationText(preset.stale_after_seconds)} when the source cannot refresh`,
    `data: ${preset.attribution?.text ?? ""}${preset.attribution?.terms ? ` Terms: ${preset.attribution.terms}` : ""}`,
    ...(preset.docs ? [`docs: https://screenrig.ai${preset.docs.startsWith("/") ? preset.docs : `/${preset.docs}`}`] : []),
    "",
    ...(preset.fields.length ? ["Fields (--set FIELD=VALUE, or --settings JSON; a list takes a JSON array):", ...fieldLines(preset.fields, "  ")] : ["Fields: none"]),
    "",
    ...(preset.secrets.length
      ? ["Secrets (--secret NAME=@FILE, or NAME=- for stdin):", ...preset.secrets.flatMap((secret) => [
        `  ${secret.name} (${secret.required ? "required" : "optional"}): ${secret.label}`,
        ...(secret.help ? [`    ${secret.help}`] : []),
        ...(secret.how_to_get ? [`    how to get it: ${secret.how_to_get}`] : []),
      ])]
      : ["Secrets: none; the data is public."]),
    "",
    `Next: screenrig source test --preset ${preset.name} --card crd_CARD${required.map((field) => ` ${exampleSet(field)}`).join("")}${neededSecrets.map((secret) => ` --secret ${secret.name}=@FILE`).join("")}`,
    "Then the same command as source create, with --name.",
  ];
}

function presetProblem(error: unknown, name?: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code === "not_found" && name !== undefined) {
    return new CliError({ ...error.problem, next: { command: "screenrig source presets", reason: "List the presets and their names." } }, error.exitCode, error.warnings);
  }
  return error;
}

async function presetCall(client: ApiClient, path: string, name?: string): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call({ method: "GET", path });
  } catch (error) {
    throw presetProblem(error, name);
  }
}

export const handleSourcePresets = commandHandler(async (args, runtime, resolved) => {
  const name = args.positionals[2] !== undefined ? sourcePresetName(args.positionals[2]) : undefined;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (name === undefined) {
    const response = await presetCall(client, SOURCE_PRESETS_PATH);
    const items = (response.body as SourcePresetList | undefined)?.items;
    const list = Array.isArray(items) ? items : [];
    return {
      envelope: jsonBody(response, client.requestId),
      exitCode: ExitCode.Success,
      human: [`Source presets (${list.length})`, ...sourcePresetTableLines(list), "", "Next: screenrig source presets NAME shows a preset's fields, its secrets and how to get them."].join("\n"),
    };
  }
  const response = await presetCall(client, `${SOURCE_PRESETS_PATH}/${name}`, name);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Source preset", ...sourcePresetLines(response.body as SourcePreset | undefined)].join("\n"),
  };
});
