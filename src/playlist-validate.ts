import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validatePlaylistWriteSemantics } from "./generated/playlist-write-semantics.js";
import { ExitCode } from "./exit-codes.js";
import { CliError, makeProblem } from "./problems.js";

let validators: ReturnType<typeof buildValidators> | undefined;
function buildValidators() {
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);
const schema = JSON.parse(readFileSync(new URL("../assets/playlist-write.schema.json", import.meta.url), "utf8"));
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
export const PLAYLIST_SERVER_CHECKS = ["reference authorization and readiness", "dynamic selector cardinality", "media durations", "DNS and remote availability"];
export function playlistIssues(value: unknown): Array<{ path: string; message: string }> {
  const { validate, diagnose } = validators ??= buildValidators();
  if (!validate(value)) {
    diagnose(value);
    const errors = diagnose.errors ?? validate.errors ?? [];
    // Discriminator branches produce many irrelevant errors; retain actionable
    // leaf issues, deduplicated, while the canonical schema remains authoritative.
    const issues = errors.filter((error) => error.keyword !== "oneOf" && error.keyword !== "anyOf").map((error) => ({
      path: error.instancePath + (error.keyword === "additionalProperties" ? `/${String(error.params.additionalProperty).replaceAll("~", "~0").replaceAll("/", "~1")}` : error.keyword === "required" ? `/${String(error.params.missingProperty)}` : ""),
      message: error.keyword === "additionalProperties" && error.instancePath.endsWith("/enter") ? "unsupported entry field; keep only type (player timing is fixed)" : error.message ?? "does not match the canonical playlist schema",
    }));
    return [...new Map(issues.map((issue) => [`${issue.path}:${issue.message}`, issue])).values()];
  }
  return validatePlaylistWriteSemantics(value);
}
export function assertPlaylistValid(value: unknown): void {
  const errors = playlistIssues(value);
  if (errors.length) throw new CliError(makeProblem("usage_error", "Playlist is not valid", 400,
    `Local canonical validation found ${errors.length} issue(s). Fix the reported JSON paths before uploading or publishing.`, { errors }), ExitCode.Usage);
}
