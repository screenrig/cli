import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validatePlaylistWriteSemantics } from "./generated/playlist-write-semantics.js";
import { lintPlaylistPages, type LintFinding } from "./compose/lint.js";
import { ExitCode } from "./exit-codes.js";
import { isAdSlotPage } from "./playlist-authoring.js";
import { CliError, makeProblem } from "./problems.js";

const validators = new Map<"v1" | "v2", ReturnType<typeof buildValidators>>();
/**
 * Local validation compiles the canonical generated schema for the document's
 * own union: ordinary documents use the closed v1 schema, and a document with
 * an adslot page uses the v2 union. Neither schema is reimplemented here.
 */
function buildValidators(version: "v1" | "v2") {
  const asset = version === "v2" ? "../assets/playlist-write-v2.schema.json" : "../assets/playlist-write.schema.json";
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);
const schema = JSON.parse(readFileSync(new URL(asset, import.meta.url), "utf8"));
const validate = ajv.compile(schema);
// Route diagnostics to the selected tagged branch. This changes only error
// presentation: the unmodified canonical validator above decides validity.
const diagnosticSchema = structuredClone(schema);
for (const definition of Object.values(diagnosticSchema.$defs) as Array<Record<string, any>>) {
  if (!Array.isArray(definition.oneOf)) continue;
  const branches = definition.oneOf.map((item: { $ref?: string }) => item.$ref?.startsWith("#/$defs/") ? diagnosticSchema.$defs[item.$ref.slice(8)] : undefined);
  if (branches.some((branch: any) => !branch?.properties)) continue;
  for (const key of Object.keys(branches[0].properties)) {
    const tags = branches.map((branch: any) => branch.required?.includes(key) && branch.properties[key]?.enum?.length === 1 ? branch.properties[key].enum[0] : undefined);
    if (tags.every((tag: unknown) => typeof tag === "string") && new Set(tags).size === branches.length) {
      definition.type = "object";
      definition.discriminator = { propertyName: key };
      break;
    }
  }
}
const diagnosticAjv = new Ajv2020({ allErrors: true, strict: true, discriminator: true });
addFormats.default(diagnosticAjv);
const diagnose = diagnosticAjv.compile(diagnosticSchema);
return { validate, diagnose };

 }
/** Compile each canonical union once per process. */
function cached(version: "v1" | "v2"): ReturnType<typeof buildValidators> {
  const existing = validators.get(version);
  if (existing) return existing;
  const built = buildValidators(version);
  validators.set(version, built);
  return built;
}
export const PLAYLIST_SERVER_CHECKS = ["reference authorization and readiness", "dynamic selector cardinality", "media durations", "DNS and remote availability"];

/**
 * The cross-field checks for an ad-bearing document that the canonical v2
 * schema cannot express, mirroring the server's own v2 rules. They run only on
 * a document that already passed that schema, and the server remains the
 * authority.
 */
function adslotPageIssues(pages: unknown[]): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const adslots = pages.reduce<number>((count, page) => count + (isAdSlotPage(page) ? 1 : 0), 0);
  if (adslots > 16) {
    issues.push({ path: "/pages", message: "must contain at most 16 adslot pages so player lookahead stays bounded" });
  }
  const ordinaryUnscheduled = pages.some((page) => !isAdSlotPage(page)
    && (typeof page !== "object" || page === null || !Object.hasOwn(page, "visibility")));
  if (!ordinaryUnscheduled) {
    issues.push({ path: "/pages", message: "must retain at least one ordinary page with no visibility rule as the ad-slot fallback" });
  }
  return issues;
}

export function playlistIssues(value: unknown): Array<{ path: string; message: string }> {
  const pages = value !== null && typeof value === "object" && !Array.isArray(value)
    && "pages" in value && Array.isArray(value.pages) ? value.pages : undefined;
  const version = pages?.some(isAdSlotPage) ? "v2" : "v1";
  const { validate, diagnose } = cached(version);
  if (!validate(value)) {
    diagnose(value);
    const errors = diagnose.errors ?? validate.errors ?? [];
    // Discriminator branches produce many irrelevant errors; retain actionable
    // leaf issues, deduplicated, while the canonical schema remains authoritative.
    const issues = errors.filter((error) => error.keyword !== "oneOf" && error.keyword !== "anyOf").map((error) => ({
      path: error.instancePath + (error.keyword === "additionalProperties" ? `/${String(error.params.additionalProperty).replaceAll("~", "~0").replaceAll("/", "~1")}` : error.keyword === "required" ? `/${String(error.params.missingProperty)}` : ""),
      message: error.keyword === "additionalProperties" && error.instancePath.endsWith("/enter") ? "unsupported entry field; keep only type and optional stagger (player timing is fixed)" : error.message ?? "does not match the canonical playlist schema",
    }));
    return [...new Map(issues.map((issue) => [`${issue.path}:${issue.message}`, issue])).values()];
  }
  return version === "v2" && pages ? [...validatePlaylistWriteSemantics(value), ...adslotPageIssues(pages)] : validatePlaylistWriteSemantics(value);
}
export function assertPlaylistValid(value: unknown): void {
  const errors = playlistIssues(value);
  if (errors.length) throw new CliError(makeProblem("usage_error", "Playlist is not valid", 400,
    `Local canonical validation found ${errors.length} issue(s). Fix the reported JSON paths before uploading or publishing.`, { errors }), ExitCode.Usage);
}
export function playlistLint(value: unknown): LintFinding[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const pages = (value as { pages?: unknown }).pages;
  return Array.isArray(pages) ? lintPlaylistPages(pages) : [];
}
