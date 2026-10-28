import { CliError, usageError } from "../problems.js";
import { loadCredentials, scrubSecrets } from "./credentials.js";
import { vendorBadResponse } from "./http.js";
import { openLocalFiles, type LocalFiles } from "./local-files.js";
import { buildReport, countsOf, type LossyEntry, type Report } from "./report.js";
import { SCAN_SCHEMA, type MigrationDir, type ScanFile, type ScannedCatalog, type ScannedMedia } from "./state.js";
import type { ReportEntry, SourceCatalog, VendorAdapter, VendorHttp } from "./types.js";

/** The flags and variables a vendor takes, as a sentence for a usage error. */
export function inputsText(adapter: VendorAdapter): string {
  const flags: string[] = [];
  if (adapter.inputs.url) flags.push(`--url ADDRESS (${adapter.inputs.url})`);
  if (adapter.inputs.regions) flags.push(`--region ${adapter.inputs.regions.join("|")} (required)`);
  if (adapter.inputs.timezone) flags.push("--timezone ZONE (optional)");
  if (adapter.inputs.files) flags.push(`--files PATH (${adapter.inputs.files})`);
  const variables = adapter.credentials.map((credential) => `${credential.env} (${credential.required ? "required" : "optional"}${credential.secret ? ", secret" : ""})`);
  return `${adapter.name} takes ${flags.length ? flags.join(", ") : "no vendor flags"}${variables.length ? `; it reads ${variables.join(", ")}` : ""}. --credentials FILE and --dir DIR work with every vendor.`;
}

function badInput(adapter: VendorAdapter, detail: string): CliError {
  return usageError(`${detail} ${inputsText(adapter)}`, { command: `screenrig migrate vendors ${adapter.id}`, reason: `Shows what ${adapter.name} takes and how to make its read-only key.` });
}

export interface ScanFlags {
  url?: string;
  region?: string;
  timezone?: string;
  files?: string;
}

/** Rejects a flag the vendor does not take and a required one that is missing, naming what the vendor takes. */
export function checkFlags(adapter: VendorAdapter, flags: ScanFlags): void {
  const { inputs } = adapter;
  if (flags.url !== undefined && !inputs.url) throw badInput(adapter, `${adapter.name} does not take --url.`);
  if (flags.url === undefined && inputs.url === "required") throw badInput(adapter, `${adapter.name} needs --url.`);
  if (flags.region !== undefined && !inputs.regions) throw badInput(adapter, `${adapter.name} does not take --region.`);
  if (inputs.regions && flags.region === undefined) throw badInput(adapter, `${adapter.name} needs --region.`);
  if (inputs.regions && flags.region !== undefined && !inputs.regions.includes(flags.region)) {
    throw badInput(adapter, `--region ${flags.region} is not one of ${inputs.regions.join(", ")}.`);
  }
  if (flags.timezone !== undefined && !inputs.timezone) throw badInput(adapter, `${adapter.name} does not take --timezone.`);
  if (flags.files !== undefined && !inputs.files) throw badInput(adapter, `${adapter.name} does not take --files.`);
  if (flags.files === undefined && inputs.files === "required") throw badInput(adapter, `${adapter.name} needs --files.`);
  if (flags.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: flags.timezone });
    } catch {
      throw usageError("--timezone must be an IANA time zone name such as America/Toronto.");
    }
  }
}

function assertCatalog(adapter: VendorAdapter, catalog: SourceCatalog): void {
  const kinds: Array<[string, ReadonlyArray<{ id: string }>]> = [
    ["media", catalog.media], ["playlist", catalog.playlists], ["layout", catalog.layouts],
    ["group", catalog.groups], ["screen", catalog.screens], ["schedule", catalog.schedules],
  ];
  for (const [kind, list] of kinds) {
    const seen = new Set<string>();
    for (const item of list) {
      if (typeof item.id !== "string" || item.id === "" || seen.has(item.id)) {
        throw vendorBadResponse(adapter.name, `two ${kind} entries have the same id, or one has none`);
      }
      seen.add(item.id);
    }
  }
}

/**
 * Settles where each media's bytes come from. A file the API hands out is
 * downloaded; one it does not (or hands out only as a derivative) is matched by
 * name in --files. What cannot be had is listed with what to do about it.
 */
export function resolveMedia(
  adapter: Pick<VendorAdapter, "name">,
  catalog: SourceCatalog,
  files: LocalFiles | undefined,
): { media: ScannedMedia[]; notImported: ReportEntry[]; lossy: LossyEntry[] } {
  const media: ScannedMedia[] = [];
  const notImported: ReportEntry[] = [];
  const lossy: LossyEntry[] = [];
  for (const item of catalog.media) {
    const wantsLocal = item.fetch === undefined || !item.original;
    let local: string | undefined;
    if (wantsLocal && files) {
      const candidates = files.match(item.filename, item.bytes).filter((entry) => !entry.unreadable);
      if (candidates.length > 1) {
        notImported.push({ kind: "media", source_id: item.id, name: item.name, reason: `There are ${candidates.length} files named ${item.filename} in --files.`, next: "Keep one of them, or rename them, and rerun migrate scan." });
        continue;
      }
      local = candidates[0]?.path;
    }
    if (local === undefined && item.fetch === undefined) {
      notImported.push({
        kind: "media", source_id: item.id, name: item.name,
        reason: `${adapter.name} does not hand out this file${files ? ", and no file of that name is in --files" : ""}.`,
        next: `Download ${item.filename} from ${adapter.name} into a folder and rerun migrate scan with --files DIR.`,
      });
      continue;
    }
    if (local === undefined && !item.original) {
      lossy.push({ kind: "media", source_id: item.id, name: item.name, change: `Only ${adapter.name}'s re-encoded copy is available, not the original. Put the original in --files and rescan to import it instead.` });
    }
    media.push({ ...item, ...(local !== undefined ? { local } : {}) });
  }
  return { media, notImported, lossy };
}

export interface ScanRequest {
  adapter: VendorAdapter;
  flags: ScanFlags;
  credentialsFile?: string;
  dir: MigrationDir;
  env: NodeJS.Dict<string>;
  now: () => Date;
  http: VendorHttp;
}

/** Reads the vendor account, writes scan.json, and returns it. Nothing is sent to screenRIG. */
export async function runScan(request: ScanRequest): Promise<{ scan: ScanFile; report: Report }> {
  const { adapter, flags } = request;
  checkFlags(adapter, flags);
  const credentials = await loadCredentials(adapter, { ...(request.credentialsFile !== undefined ? { file: request.credentialsFile } : {}), env: request.env });
  const files = flags.files !== undefined ? await openLocalFiles(flags.files) : undefined;
  let catalog: SourceCatalog;
  try {
    const session = await adapter.open({
      ...(flags.url !== undefined ? { url: flags.url } : {}),
      ...(flags.region !== undefined ? { region: flags.region } : {}),
      ...(flags.timezone !== undefined ? { timezone: flags.timezone } : {}),
      credentials,
      http: request.http,
      ...(files ? { files } : {}),
      now: request.now,
    });
    catalog = await session.scan();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw vendorBadResponse(adapter.name, `it could not be read (${scrubSecrets(error instanceof Error ? error.message : "unknown error", Object.values(credentials)).slice(0, 200)})`);
  }
  assertCatalog(adapter, catalog);
  const resolved = resolveMedia(adapter, catalog, files);
  const scanned: ScannedCatalog = { ...catalog, media: resolved.media, not_imported: [], notes: [] };
  const scannedAt = request.now().toISOString();
  const report = buildReport({
    vendor: adapter.id,
    label: catalog.label,
    scannedAt,
    catalog: scanned,
    found: countsOf(catalog),
    notImported: [...catalog.not_imported, ...resolved.notImported],
    lossy: resolved.lossy,
    notes: catalog.notes,
    ...(flags.timezone !== undefined ? { timezone: flags.timezone } : {}),
  });
  request.dir.checkBinding(await request.dir.readMap(), { vendor: adapter.id, account: catalog.account });
  const scan: ScanFile = {
    schema: SCAN_SCHEMA,
    vendor: adapter.id,
    account: catalog.account,
    label: catalog.label,
    scanned_at: scannedAt,
    inputs: {
      ...(flags.url !== undefined ? { url: flags.url } : {}),
      ...(flags.region !== undefined ? { region: flags.region } : {}),
      ...(flags.timezone !== undefined ? { timezone: flags.timezone } : {}),
      ...(flags.files !== undefined ? { files: flags.files } : {}),
    },
    catalog: scanned,
    report,
  };
  await request.dir.writeScan(scan);
  return { scan, report };
}
