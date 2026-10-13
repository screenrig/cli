import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Committed package.json placeholder. CI stamps the artifact; 0 is not a release. */
export const PLACEHOLDER_VERSION = "0.1.0";

const RELEASE_VERSION = /^(\d{2})\.(0[1-9]|1[0-2])\.([1-9]\d*)$/;
const DEV_VERSION = /^(\d{2})\.(0[1-9]|1[0-2])\.0-dev$/;
const RELEASE_TAG = /^v(\d{2})\.(0[1-9]|1[0-2])\.([1-9]\d*)$/;

export function isReleaseVersion(value: string): boolean {
  return RELEASE_VERSION.test(value);
}

export function isDevVersion(value: string): boolean {
  return DEV_VERSION.test(value);
}

export function isProductVersion(value: string): boolean {
  return isReleaseVersion(value) || isDevVersion(value);
}

export function untaggedDevVersion(now = new Date()): string {
  const year = String(now.getUTCFullYear()).slice(-2);
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}.${month}.0-dev`;
}

export function versionFromTag(tag: string): string | undefined {
  const match = RELEASE_TAG.exec(tag);
  return match ? tag.slice(1) : undefined;
}

function readPackageVersion(): string | undefined {
  try {
    const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
    if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string") {
      return parsed.version;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function resolveCliVersion(input: {
  env?: Record<string, string | undefined>;
  packageVersion?: string;
  now?: Date;
} = {}): string {
  const envSource = input.env ?? process.env;
  const env = envSource.SCREENRIG_VERSION;
  if (typeof env === "string" && isProductVersion(env)) {
    return env;
  }
  const pkg = input.packageVersion ?? readPackageVersion();
  if (typeof pkg === "string" && pkg !== PLACEHOLDER_VERSION && isProductVersion(pkg)) {
    return pkg;
  }
  return untaggedDevVersion(input.now);
}

export const CLI_VERSION = resolveCliVersion();

export const AGENT_PLUGIN_SETUP = "Agent workflows use the official screenRIG plugin from https://github.com/screenrig/plugin. Check this runtime's plugin list and install screenrig@screenrig when absent, preserving saved screenRIG credentials. Then run the installed plugin's bootstrap helper before enrollment, pairing or publishing.";

/** Package origin is diagnostic information; host registration is checked by bootstrap. */
export function cliDistribution(moduleUrl: string = import.meta.url): {
  kind: "plugin_bundle" | "standalone";
  plugin_version?: string;
  bootstrap?: string;
  agent_setup: string;
} {
  const root = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..");
  for (const relative of ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    try {
      const plugin = JSON.parse(readFileSync(path.join(root, relative), "utf8")) as { name?: string; version?: string };
      if (plugin.name === "screenrig" && typeof plugin.version === "string" && isProductVersion(plugin.version)) {
        return {
          kind: "plugin_bundle", plugin_version: plugin.version,
          bootstrap: `${path.join(root, "skills", "screenrig", "scripts", "screenrig-plugin-freshness")} --bootstrap --json`,
          agent_setup: "Run the bundled bootstrap helper to verify registration, installation and the saved connection. Its reported launcher is the executable for subsequent commands.",
        };
      }
    } catch { /* Ordinary standalone packages have no enclosing plugin manifest. */ }
  }
  return { kind: "standalone", agent_setup: AGENT_PLUGIN_SETUP };
}
