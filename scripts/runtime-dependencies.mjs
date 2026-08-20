import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const RUNTIME_LOCK_FILE = "runtime-dependencies.lock.json";
export const RUNTIME_LOCK_SCHEMA = "screenrig.cli-runtime-dependencies/v1";

function packageName(lockPath) {
  const parts = lockPath.split("/");
  const marker = parts.lastIndexOf("node_modules");
  if (marker < 0 || marker === parts.length - 1) throw new Error(`invalid runtime package path: ${lockPath}`);
  const first = parts[marker + 1];
  return first.startsWith("@") ? `${first}/${parts[marker + 2] ?? ""}` : first;
}

function safeLockPath(lockPath) {
  const parts = lockPath.split("/");
  return (
    parts[0] === "node_modules" &&
    parts.every((part) => part && part !== "." && part !== "..") &&
    path.posix.normalize(lockPath) === lockPath
  );
}

export async function loadRuntimeDependencyLock(root) {
  const lockPath = path.join(root, "package-lock.json");
  const bytes = await readFile(lockPath);
  const lock = JSON.parse(bytes.toString("utf8"));
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== "object" || lock.packages === null) {
    throw new Error("package-lock.json must use lockfileVersion 3 with a packages object");
  }
  const packages = Object.entries(lock.packages)
    .filter(([lockPath, entry]) => lockPath.startsWith("node_modules/") && entry?.dev !== true)
    .map(([lockPath, entry]) => {
      if (!safeLockPath(lockPath)) throw new Error(`unsafe runtime package path: ${lockPath}`);
      if (
        typeof entry.version !== "string" ||
        typeof entry.resolved !== "string" ||
        !entry.resolved.startsWith("https://registry.npmjs.org/") ||
        typeof entry.integrity !== "string" ||
        !entry.integrity.split(/\s+/).some((value) => value.startsWith("sha512-"))
      ) {
        throw new Error(`runtime package is not registry and SHA-512 pinned: ${lockPath}`);
      }
      return {
        path: lockPath,
        name: packageName(lockPath),
        version: entry.version,
        resolved: entry.resolved,
        integrity: entry.integrity,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (packages.length === 0) throw new Error("package-lock.json has no production runtime dependencies");
  return {
    schema: RUNTIME_LOCK_SCHEMA,
    package_lock_sha256: createHash("sha256").update(bytes).digest("hex"),
    packages,
  };
}

export function verifyIntegrity(bytes, integrity, label) {
  const actual = createHash("sha512").update(bytes).digest("base64");
  const accepted = integrity
    .split(/\s+/)
    .filter((value) => value.startsWith("sha512-"))
    .map((value) => value.slice("sha512-".length));
  if (!accepted.includes(actual)) throw new Error(`${label}: downloaded bytes differ from package-lock.json integrity`);
}
