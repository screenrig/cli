import { readdir } from "node:fs/promises";
import path from "node:path";
import { loggerOf } from "../log/logger.js";
import { usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { createVendorHttp } from "./http.js";
import { MigrationDir } from "./state.js";
import type { VendorAdapter, VendorHttp } from "./types.js";
import { VENDORS } from "./vendors/index.js";

export const DIR_PREFIX = "screenrig-migration-";

/** The registry in display order: by id, with the files fallback last. */
export function sortedVendors(vendors: readonly VendorAdapter[] = VENDORS): VendorAdapter[] {
  return [...vendors].sort((a, b) => (a.id === "files" ? 1 : b.id === "files" ? -1 : a.id.localeCompare(b.id)));
}

export function describeVendor(adapter: VendorAdapter): Record<string, unknown> {
  return {
    id: adapter.id,
    name: adapter.name,
    inputs: {
      flags: [
        ...(adapter.inputs.url ? [{ flag: "--url", required: adapter.inputs.url === "required" }] : []),
        ...(adapter.inputs.regions ? [{ flag: "--region", required: true, values: [...adapter.inputs.regions] }] : []),
        ...(adapter.inputs.timezone ? [{ flag: "--timezone", required: false }] : []),
        ...(adapter.inputs.files ? [{ flag: "--files", required: adapter.inputs.files === "required" }] : []),
      ],
      env: adapter.credentials.map((credential) => ({ name: credential.env, secret: credential.secret, required: credential.required, help: credential.help })),
    },
    connect: [...adapter.connect],
    maps: [...adapter.maps],
    skips: [...adapter.skips],
    docs: [...adapter.docs],
    example: adapter.example,
  };
}

export function vendorLines(adapter: VendorAdapter): string[] {
  const flags = [
    ...(adapter.inputs.url ? [`--url (${adapter.inputs.url})`] : []),
    ...(adapter.inputs.regions ? [`--region ${adapter.inputs.regions.join("|")} (required)`] : []),
    ...(adapter.inputs.timezone ? ["--timezone (optional)"] : []),
    ...(adapter.inputs.files ? [`--files (${adapter.inputs.files})`] : []),
  ];
  return [
    `${adapter.id}: ${adapter.name}`,
    `  takes: ${flags.join(", ") || "no vendor flags"}`,
    ...adapter.credentials.map((credential) => `  ${credential.env}${credential.secret ? " (secret)" : ""}${credential.required ? " (required)" : ""}: ${credential.help}`),
    ...adapter.connect.map((step, index) => `  connect ${index + 1}. ${step}`),
    ...adapter.maps.map((line) => `  maps: ${line}`),
    ...adapter.skips.map((line) => `  skips: ${line}`),
    ...adapter.docs.map((line) => `  docs: ${line}`),
    `  example: ${adapter.example}`,
  ];
}

export function findVendor(id: string, vendors: readonly VendorAdapter[] = VENDORS): VendorAdapter {
  const found = vendors.find((vendor) => vendor.id === id);
  if (!found) {
    throw usageError(`${JSON.stringify(id)} is not a system migrate reads. The systems are ${sortedVendors(vendors).map((vendor) => vendor.id).join(", ")}.`, {
      command: "screenrig migrate vendors",
      reason: "Lists every system migrate reads, with what each takes.",
    });
  }
  return found;
}

/** --dir, else the one migration directory in the working directory, else the vendor's default name. */
export async function chooseDir(runtime: CliRuntime, flag: string | undefined, vendor?: string): Promise<MigrationDir> {
  if (flag !== undefined) return new MigrationDir(path.resolve(runtime.cwd(), flag));
  if (vendor !== undefined) return new MigrationDir(path.resolve(runtime.cwd(), `${DIR_PREFIX}${vendor}`));
  let found: string[] = [];
  try {
    found = (await readdir(runtime.cwd(), { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith(DIR_PREFIX)).map((entry) => entry.name).sort();
  } catch {
    // An unreadable working directory has none.
  }
  if (found.length === 1) return new MigrationDir(path.resolve(runtime.cwd(), found[0]!));
  throw usageError(found.length === 0
    ? "There is no migration directory here. Pass --dir DIR, the directory migrate scan wrote."
    : `More than one migration directory is here (${found.join(", ")}). Pass --dir DIR for the one you mean.`, {
    command: "screenrig migrate scan --from VENDOR",
    reason: "Reads the vendor account and writes a migration directory.",
  });
}

/** The vendor transport for one command: the runtime's fetch (tests inject one), logging only vendor, method, status and time. */
export function vendorHttpFor(runtime: CliRuntime, adapter: VendorAdapter): VendorHttp {
  const logger = loggerOf(runtime);
  return createVendorHttp({
    vendor: adapter.id,
    name: adapter.name,
    credentialNames: adapter.credentials.map((credential) => credential.env),
    fetch: runtime.vendorFetch ?? globalThis.fetch,
    sleep: runtime.sleep,
    now: () => runtime.now().getTime(),
    log: (request) => {
      logger.startLocal({
        op: "migrate.vendor.request",
        message: `${request.vendor} ${request.method} ${request.status}`,
        params: { vendor: request.vendor, method: request.method, status: request.status, ms: request.ms },
        quiet: true,
      }).finish();
    },
  });
}
