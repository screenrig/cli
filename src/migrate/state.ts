import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ExitCode } from "../exit-codes.js";
import { CliError, makeProblem, usageError } from "../problems.js";
import type { Report } from "./report.js";
import type { SourceCatalog, SourceMedia } from "./types.js";

export const SCAN_SCHEMA = "screenrig.migration-scan/v1";
export const MAP_SCHEMA = "screenrig.migration-map/v1";

/** What `--files` matched for a media the vendor's API cannot hand out: the path inside the folder or zip. */
export interface ScannedMedia extends SourceMedia {
  local?: string;
}

export type ScannedCatalog = Omit<SourceCatalog, "media"> & { media: ScannedMedia[] };

export interface ScanInputs {
  url?: string;
  region?: string;
  timezone?: string;
  files?: string;
}

export interface ScanFile {
  schema: typeof SCAN_SCHEMA;
  vendor: string;
  account: string;
  label: string;
  scanned_at: string;
  inputs: ScanInputs;
  catalog: ScannedCatalog;
  report: Report;
}

export interface MapItem {
  id?: string;
  at?: string;
  fleet_link_id?: string;
  screen_id?: string;
  finished?: boolean;
}

export interface MapFailure {
  code: string;
  detail: string;
  at: string;
}

export interface Binding {
  api_url: string;
  project_id: string;
  vendor: string;
  account: string;
}

export interface MigrationMap extends Binding {
  schema: typeof MAP_SCHEMA;
  seed: string;
  tags: Record<string, string>;
  items: Record<string, MapItem>;
  failed: Record<string, MapFailure>;
}

export function emptyMap(binding: Binding): MigrationMap {
  return { schema: MAP_SCHEMA, ...binding, seed: randomBytes(32).toString("hex"), tags: {}, items: {}, failed: {} };
}

/**
 * The idempotency key of one write: a hash of the map's seed, the object's key,
 * the phase, and a fingerprint of what is written. A lost map write replays the
 * same request and gets the same object back; changed content gets a new key
 * instead of a refusal.
 */
export function migrationKey(seed: string, key: string, phase: string, fingerprint = ""): string {
  return createHash("sha256")
    .update("screenrig.migration\0").update(seed).update("\0").update(key).update("\0").update(phase).update("\0").update(fingerprint)
    .digest("base64url");
}

export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function dirMismatch(dir: string, differs: string): CliError {
  return new CliError(makeProblem(
    "migration_dir_mismatch", "Migration directory belongs to another import", 400,
    `${dir} was made for another ${differs}. A migration directory is bound to one screenRIG project, API URL, vendor and source account, so reruns and resumes stay safe.`,
    { hint: "Use another --dir for this import, or the same --dir with the project and vendor account it was made for." },
  ), ExitCode.Usage);
}

/** Serial async work: the map is rewritten whole after every created object, so writes never overlap. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Not every filesystem allows syncing a directory.
  } finally {
    await handle?.close();
  }
}

/** tmp + fsync + rename, mode 0600. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await fsyncDirectory(path.dirname(file));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class MigrationDir {
  readonly scanFile: string;
  readonly mapFile: string;
  readonly lockFile: string;
  readonly stagingDir: string;

  constructor(readonly dir: string) {
    this.scanFile = path.join(dir, "scan.json");
    this.mapFile = path.join(dir, "map.json");
    this.lockFile = path.join(dir, "map.json.lock");
    this.stagingDir = path.join(dir, "staging");
  }

  /** Creates the directory, mode 0700, when it does not exist; one that does is left as it is. */
  async ensure(): Promise<void> {
    try {
      await stat(this.dir);
    } catch {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
    }
  }

  async readScan(): Promise<ScanFile> {
    let text: string;
    try {
      text = await readFile(this.scanFile, "utf8");
    } catch {
      throw usageError(`There is no scan in ${this.dir}. Run migrate scan first.`, {
        command: "screenrig migrate scan --from VENDOR",
        reason: "Reads the vendor account and writes scan.json here; migrate apply reads that file.",
      });
    }
    let parsed: ScanFile;
    try {
      parsed = JSON.parse(text) as ScanFile;
    } catch {
      throw usageError(`${this.scanFile} is not valid JSON. Run migrate scan again.`, { command: "screenrig migrate scan --from VENDOR", reason: "Writes a fresh scan.json." });
    }
    if (parsed.schema !== SCAN_SCHEMA) {
      throw usageError(`${this.scanFile} is not a ${SCAN_SCHEMA} document. Run migrate scan again.`, { command: "screenrig migrate scan --from VENDOR", reason: "Writes a fresh scan.json." });
    }
    return parsed;
  }

  async writeScan(scan: ScanFile): Promise<void> {
    await this.ensure();
    await writeFileAtomic(this.scanFile, `${JSON.stringify(scan, null, 2)}\n`);
  }

  async readMap(): Promise<MigrationMap | undefined> {
    let text: string;
    try {
      text = await readFile(this.mapFile, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(text) as MigrationMap;
      if (parsed.schema === MAP_SCHEMA) return parsed;
    } catch {
      // Falls through to the same refusal as a different schema.
    }
    throw usageError(`${this.mapFile} is not a ${MAP_SCHEMA} document, so it is not overwritten. Move it away or use another --dir.`);
  }

  async writeMap(map: MigrationMap): Promise<void> {
    await this.ensure();
    await writeFileAtomic(this.mapFile, `${JSON.stringify(map, null, 2)}\n`);
  }

  /** Throws migration_dir_mismatch when the map was made for another project, API URL, vendor or account. */
  checkBinding(map: MigrationMap | undefined, binding: Partial<Binding>): void {
    if (!map) return;
    if (binding.api_url !== undefined && map.api_url !== binding.api_url) throw dirMismatch(this.dir, "API URL");
    if (binding.project_id !== undefined && map.project_id !== binding.project_id) throw dirMismatch(this.dir, "project");
    if (binding.vendor !== undefined && map.vendor !== binding.vendor) throw dirMismatch(this.dir, "vendor");
    if (binding.account !== undefined && map.account !== binding.account) throw dirMismatch(this.dir, "source account");
  }

  /** The lock file holds the pid of the running apply or pair. A pid that is not running is taken over. */
  async lock(): Promise<() => Promise<void>> {
    await this.ensure();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(this.lockFile, "wx", 0o600);
        try {
          await handle.writeFile(String(process.pid));
        } finally {
          await handle.close();
        }
        return async () => {
          try {
            if ((await readFile(this.lockFile, "utf8")).trim() === String(process.pid)) await rm(this.lockFile, { force: true });
          } catch {
            // Already gone.
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = Number((await readFile(this.lockFile, "utf8").catch(() => "")).trim());
      if (Number.isInteger(holder) && holder > 0 && running(holder)) {
        throw usageError(`Another migrate apply or pair is running in ${this.dir} (process ${holder}). Wait for it, or use another --dir.`);
      }
      await rm(this.lockFile, { force: true });
    }
    throw usageError(`Could not take the lock in ${this.dir}; try again.`);
  }

  /** A per-object directory for downloads. The file inside carries the upload's own name. */
  stagingFor(key: string): string {
    return path.join(this.stagingDir, createHash("sha256").update(key).digest("hex"));
  }

  async makeStaging(key: string): Promise<string> {
    const directory = this.stagingFor(key);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  /** Downloads an interrupted run left behind; only called while the lock is held. */
  async clearStaging(): Promise<void> {
    await rm(this.stagingDir, { recursive: true, force: true });
  }

  async removeStaging(key: string): Promise<void> {
    await rm(this.stagingFor(key), { recursive: true, force: true });
  }
}
