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
