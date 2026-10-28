import path from "node:path";
import type { Campaign, FleetLink, Screen } from "../adapters/protocol.js";
import type { ApiClient } from "../client.js";
import { ExitCode } from "../exit-codes.js";
import { cleanupPreparedMediaFile, prepareMediaFileForUpload, submitPreparedMedia, type MediaFileUploadInput } from "../media-upload.js";
import { computeBackoffMs, UPLOAD_BATCH_MAX_ATTEMPTS } from "../media-upload-batch.js";
import type { ProgressReporter } from "../media/progress.js";
import type { TranscodeOptions } from "../media/transcode.js";
import { CliError, makeProblem, usageError } from "../problems.js";
import type { ProblemNext, Warning } from "../envelope.js";
import { pendingReviewOf } from "../reviews.js";
import type { CliRuntime } from "../runtime.js";
import { scrubSecrets } from "./credentials.js";
import type { LocalFiles } from "./local-files.js";
import { allocateTags, cleanName, DEFAULT_CANVAS, tagAudience, truncate, uploadName, type BuildContext, type Built, type MediaRef, buildLayout, buildPlaylist } from "./map.js";
import { classify, placeholderFor, screenContent, type ContentKey } from "./report.js";
import { emptyMap, fingerprintOf, migrationKey, Serial, type MapItem, type MigrationDir, type MigrationMap, type ScanFile, type ScannedMedia } from "./state.js";
import type { SourceItem, SourceLayout, SourcePlaylist, SourceScreen, VendorSession } from "./types.js";

export const FLEET_LINK_CAP = 50;
export const CAMPAIGN_CAP = 100;

export type OnlyKind = "media" | "playlists" | "screens" | "schedules";
export const ONLY_KINDS: readonly OnlyKind[] = ["media", "playlists", "screens", "schedules"];

type ResultKind = "media" | "playlists" | "layouts" | "screens" | "schedules";
export interface Tally {
  create: number;
  reuse: number;
  recreate: number;
  waiting: number;
  fail: number;
}

const tally = (): Tally => ({ create: 0, reuse: 0, recreate: 0, waiting: 0, fail: 0 });

export interface PlanItem {
  key: string;
  action: keyof Tally;
  name: string;
  reason?: string;
}

export interface PlaceholderState {
  source_id: string;
  name: string;
  fleet_link_id?: string;
  screen_id?: string;
  state: "linked" | "unlinked" | "paired" | "finished" | "waiting" | "failed";
}

export interface FailedItem {
  key: string;
  name: string;
  code: string;
  status: number;
  detail: string;
  next?: ProblemNext;
}

export interface Stopped {
  code: string;
  detail: string;
  next: { command: string; reason: string };
}

export interface ApplyOptions {
  dryRun: boolean;
  only: ReadonlySet<OnlyKind>;
  /** An existing media folder (mfd_...) to put the media in. */
  folder?: string;
  canvas: { width: number; height: number };
  concurrency: number;
  noTranscode: boolean;
  transcodeOptions: TranscodeOptions;
  timeoutMs?: number;
  pollMs?: number;
}

export interface ApplyDeps {
  runtime: CliRuntime;
  client: ApiClient;
  dir: MigrationDir;
  scan: ScanFile;
  /** The vendor's display name, for the default media folder. */
  vendorName: string;
  apiUrl: string;
  projectId: string;
  /** Opens the vendor session, needing its credentials; called only when a download from the vendor is due. */
  openSession: () => Promise<VendorSession>;
  /** Opens the --files path the scan used. */
  openFiles: () => Promise<LocalFiles>;
  reporter: ProgressReporter;
  /** The same apply command, for `stopped.next`. */
  rerun: string;
  /** Progress lines on stderr: JSON unless human output was asked for. */
  progress?: (event: Record<string, unknown>) => void;
  /** Secrets to scrub from messages that came from vendor code. */
  secrets?: readonly string[];
}

export interface ApplyData {
  dir: string;
  vendor: string;
  dry_run: boolean;
  plan?: Record<ResultKind, Tally>;
  applied?: Record<ResultKind, Tally>;
  bytes?: number;
  items?: PlanItem[];
  failed?: FailedItem[];
  waiting?: Array<{ key: string; name: string; reason: string }>;
  placeholders: PlaceholderState[] | Record<"linked" | "unlinked" | "paired" | "finished", number>;
  project?: { fleet_links: { used: number; max: number }; campaigns: { used: number; max: number } };
  tags: Record<string, string>;
  folder_id?: string;
  stopped?: Stopped;
}

export interface ApplyResult {
  data: ApplyData;
  warnings: Warning[];
  exitCode: ExitCode;
  human: string;
}

const STOP_CODES = new Set([
  "payment_required", "quota_exceeded", "vendor_refused", "vendor_rate_limited", "vendor_unavailable", "campaign_limit_reached",
  "insufficient_access", "pending_review", "transport_error", "timeout", "not_enrolled", "unauthenticated", "session_ended", "credential_retired",
]);

/**
 * Vendor errors that belong to one file or one answer: the item fails and the run goes on.
 * A refusal of the key, a rate limit and a lost connection repeat for every item and stay stops.
 */
const ITEM_CODES = new Set(["vendor_bad_response", "vendor_file_gone", "vendor_file_stalled"]);

/** An error that will repeat for every item, so the run ends instead of failing each one. */
export function isStop(error: unknown): error is CliError {
  if (!(error instanceof CliError)) return false;
  const { status, code } = error.problem;
  if (ITEM_CODES.has(code)) return false;
  return STOP_CODES.has(code) || status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

function stopNext(error: CliError, rerun: string): Stopped["next"] {
  const code = error.problem.code;
  if (code === "pending_review" || code === "insufficient_access") {
    return { command: "screenrig login --access manage", reason: "migrate apply writes media, playlists, screens and campaigns, which needs Manage access that a person approves in the dashboard. Then run the same apply again." };
  }
  if (code === "payment_required" || code === "quota_exceeded") {
    return { command: rerun, reason: "Add credit or free storage first (screenrig billing balance, screenrig project show), then run the same apply again: it continues where it stopped." };
  }
  if (code === "campaign_limit_reached") {
    return { command: rerun, reason: "Delete campaigns the project no longer needs (screenrig campaign list, campaign delete), then run the same apply again: only the campaigns still missing are made." };
  }
  return { command: rerun, reason: "Fix the cause named in detail, then run the same apply again: it continues where this one stopped." };
}

function problemOf(error: unknown, secrets: readonly string[]): { code: string; status: number; detail: string; next?: ProblemNext; exit: ExitCode } {
  if (error instanceof CliError) {
    return {
      code: error.problem.code,
      status: error.problem.status,
      detail: truncate(error.problem.detail, 300).text,
      ...(error.problem.next ? { next: error.problem.next } : {}),
      exit: error.exitCode,
    };
  }
  return {
    code: "unexpected_error",
    status: 500,
    detail: truncate(scrubSecrets(error instanceof Error ? error.message : "unknown error", secrets), 300).text,
    exit: ExitCode.Unexpected,
  };
}

function exitForFailures(failed: readonly FailedItem[]): ExitCode {
  const last = failed[failed.length - 1];
  if (!last) return ExitCode.Success;
  if (last.status === 429) return ExitCode.RateLimited;
  if (last.status >= 500) return ExitCode.Server;
  if (last.code === "usage_error") return ExitCode.Usage;
  return ExitCode.Client;
}

/** `vendor:id`, the value of the migrated_from field: a label naming the source. It carries no account, so it never identifies a screen. */
export function sourceRef(vendor: string, id: string): string {
  return `${vendor}:${id}`;
}

export function placeholderKey(id: string): string {
  return `screen:${id}`;
}

async function mapPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}

async function listItems<T>(client: ApiClient, route: string): Promise<T[]> {
  const response = await client.listAll(route, undefined, { uncapped: true });
  const items = (response.body as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

interface Snapshot {
  media: Map<string, Record<string, unknown>>;
  playlists: Set<string>;
  links: Map<string, FleetLink>;
  campaigns: Map<string, Campaign>;
  screens: Screen[];
  folders: Set<string>;
}

async function readProject(client: ApiClient): Promise<Snapshot> {
  const [media, playlists, links, campaigns, screens, folders] = await Promise.all([
    listItems<Record<string, unknown>>(client, "/api/media"),
    listItems<{ id: string }>(client, "/api/playlists"),
    listItems<FleetLink>(client, "/api/fleet-links"),
    listItems<Campaign>(client, "/api/campaigns"),
    listItems<Screen>(client, "/api/screens"),
    listItems<{ id: string }>(client, "/api/media-folders"),
  ]);
  return {
    media: new Map(media.map((item) => [String(item.id), item])),
    playlists: new Set(playlists.map((item) => item.id)),
    links: new Map(links.map((item) => [item.id, item])),
    campaigns: new Map(campaigns.map((item) => [item.id, item])),
    screens,
    folders: new Set(folders.map((item) => item.id)),
  };
}

/** The source media a playlist or layout draws on, through nested playlists. */
function mediaOf(root: SourcePlaylist | SourceLayout, playlists: ReadonlyMap<string, SourcePlaylist>, layouts: ReadonlyMap<string, SourceLayout>): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (items: readonly SourceItem[]): void => {
    for (const item of items) {
      if ("media_id" in item) found.add(item.media_id);
      else if ("playlist_id" in item) {
        const nested = playlists.get(item.playlist_id);
        if (nested && !seen.has(`p:${nested.id}`)) {
          seen.add(`p:${nested.id}`);
          visit(nested.items);
        }
      } else if ("layout_id" in item) {
        const nested = layouts.get(item.layout_id);
        if (nested && !seen.has(`l:${nested.id}`)) {
          seen.add(`l:${nested.id}`);
          for (const zone of nested.zones) visit(zone.items);
        }
      }
    }
  };
  if ("zones" in root) for (const zone of root.zones) visit(zone.items);
  else visit(root.items);
  return found;
}

const TERMINAL = /terminal|upload already finished/i;

function terminalConflict(error: unknown): boolean {
  return error instanceof CliError && error.problem.code === "resource_conflict" && error.problem.status === 409 && TERMINAL.test(error.problem.detail);
}

function retryable(error: unknown): error is CliError {
  return error instanceof CliError && (error.problem.status === 429 || error.problem.status >= 500);
}

export async function runApply(deps: ApplyDeps, options: ApplyOptions): Promise<ApplyResult> {
  const { runtime, client, dir, scan } = deps;
  const dry = options.dryRun;
  const secrets = deps.secrets ?? [];
  const catalog = scan.catalog;
  const vendor = scan.vendor;
  const release = dry ? undefined : await dir.lock();
  try {
    if (!dry) await dir.clearStaging();
    let map = await dir.readMap();
    dir.checkBinding(map, { api_url: deps.apiUrl, project_id: deps.projectId, vendor, account: scan.account });
    const fresh = map === undefined;
    map ??= emptyMap({ api_url: deps.apiUrl, project_id: deps.projectId, vendor, account: scan.account });
    const state = map;
    const saves = new Serial();
    const save = (): Promise<void> => (dry ? Promise.resolve() : saves.run(() => dir.writeMap(state)));
    if (fresh) await save();

    const snapshot = await readProject(client);
    const classified = classify(catalog, options.canvas);
    const planned = new Set<string>();
    const known = new Map<string, string>();
    const mediaRefs = new Map<string, MediaRef>();
    const results: Record<ResultKind, Tally> = { media: tally(), playlists: tally(), layouts: tally(), screens: tally(), schedules: tally() };
    const items: PlanItem[] = [];
    const failed: FailedItem[] = [];
    const waiting: Array<{ key: string; name: string; reason: string }> = [];
    const placeholders: PlaceholderState[] = [];
    let stopped: CliError | undefined;
    const halted = (): CliError | undefined => stopped;
    let bytes = 0;
    let folderId: string | undefined;
    let sessionPromise: Promise<VendorSession> | undefined;
    let filesPromise: Promise<LocalFiles> | undefined;
    const session = (): Promise<VendorSession> => (sessionPromise ??= deps.openSession());
    const localFiles = (): Promise<LocalFiles> => (filesPromise ??= deps.openFiles());
    const stamp = (): string => runtime.now().toISOString();
    const progress = (phase: string, done: number, total: number): void => deps.progress?.({ event: "migrate_progress", phase, done, total });

    const note = (kind: ResultKind, item: PlanItem): void => {
      items.push(item);
      results[kind][item.action] += 1;
      if (item.action === "waiting") waiting.push({ key: item.key, name: item.name, reason: item.reason ?? "" });
    };
    const fail = (kind: ResultKind, key: string, name: string, error: unknown): void => {
      const problem = problemOf(error, secrets);
      results[kind].fail += 1;
      failed.push({ key, name, code: problem.code, status: problem.status, detail: problem.detail, ...(problem.next ? { next: problem.next } : {}) });
      state.failed[key] = { code: problem.code, detail: problem.detail, at: stamp() };
    };
    const succeeded = (key: string): void => {
      delete state.failed[key];
    };
    const request = async <T = unknown>(call: Parameters<ApiClient["call"]>[0]): Promise<{ body: T; status: number }> => {
      const response = await client.call(call);
      if (pendingReviewOf(response)) {
        throw new CliError(makeProblem("pending_review", "Changes wait for review", 202,
          "This sign-in proposes changes for a person to approve, so the write became a review and nothing was applied.", {
            hint: "Sign in again with Manage access, then run the same apply again.",
          }), ExitCode.Auth);
      }
      return { body: response.body as T, status: response.status };
    };
    const guard = async (work: () => Promise<void>, kind: ResultKind, key: string, name: string): Promise<void> => {
      if (halted()) return;
      try {
        await work();
      } catch (error) {
        if (isStop(error)) {
          stopped = error;
          return;
        }
        fail(kind, key, name, error);
        await save();
      }
    };
    const stopWaiting = (kind: ResultKind, key: string, name: string): void => {
      note(kind, { key, action: "waiting", name, reason: `The run stopped (${halted()?.problem.code ?? "stopped"}) before this was reached.` });
    };

    // The vendor's key is needed only when a download is due; a missing or refused one ends the command before anything is written.
    if (!dry && options.only.has("media")) {
      const due = catalog.media.some((media) => {
        const mapped = state.items[`media:${media.id}`]?.id;
        return media.local === undefined && !(mapped !== undefined && snapshot.media.has(mapped));
      });
      if (due) await session();
    }

    // ---- tags -------------------------------------------------------------------------------
    // Only the screens and links this map made may share its tags. Every other one, including another
    // import's, keeps its tags: a campaign on a shared tag would switch screens this import does not own.
    const ownLinks = new Set(Object.values(state.items).flatMap((item) => (item.fleet_link_id !== undefined ? [item.fleet_link_id] : [])));
    const ownScreens = new Set(Object.values(state.items).flatMap((item) => (item.screen_id !== undefined ? [item.screen_id] : [])));
    const taken: string[] = [];
    for (const screen of snapshot.screens) {
      if (ownScreens.has(screen.id) || (screen.fleet_link_id !== undefined && ownLinks.has(screen.fleet_link_id))) continue;
      taken.push(...(screen.tags ?? []));
    }
    for (const link of snapshot.links.values()) if (!ownLinks.has(link.id)) taken.push(...(link.tags ?? []));
    Object.assign(state.tags, allocateTags(classified.wants, taken, state.tags));
    await save();

    // ---- folder -----------------------------------------------------------------------------
    if (options.only.has("media") && catalog.media.length > 0) {
      if (options.folder !== undefined) {
        if (!snapshot.folders.has(options.folder)) await client.call({ method: "GET", path: `/api/media-folders/${options.folder}` });
        folderId = options.folder;
      } else {
        const mapped = state.items["folder:root"]?.id;
        if (mapped !== undefined && snapshot.folders.has(mapped)) folderId = mapped;
        else if (dry) folderId = "(planned)";
        else {
          const name = truncate(`Imported from ${deps.vendorName}`, 100).text;
          try {
            const made = await request<{ id: string }>({
              method: "POST", path: "/api/media-folders", idempotent: true,
              idempotencyKey: migrationKey(state.seed, "folder:root", "create", `${name}\0${mapped ?? ""}`), body: { name },
            });
            folderId = made.body.id;
            state.items["folder:root"] = { id: folderId, at: stamp() };
            await save();
          } catch (error) {
            if (isStop(error)) stopped = error;
            else throw error;
          }
        }
      }
    }

    // ---- media ------------------------------------------------------------------------------
    const importMedia = async (media: ScannedMedia): Promise<void> => {
      const key = `media:${media.id}`;
      const staging = await dir.makeStaging(key);
      const file = path.join(staging, uploadName(media));
      try {
        if (media.local !== undefined) {
          const files = await localFiles();
          const entry = files.entries().find((candidate) => candidate.path === media.local);
          if (!entry) throw usageError(`${media.filename} is no longer in --files. Put it back and run the same command again.`);
          await files.extract(entry, file);
        } else {
          await (await session()).fetchMedia(media, file);
        }
        const input: MediaFileUploadInput = {
          runtime, client, sourcePath: file, transcodeOptions: options.transcodeOptions, noTranscode: options.noTranscode,
          reporter: deps.reporter, resumable: true, timeoutMs: options.timeoutMs ?? 120_000, pollMs: options.pollMs ?? 1000,
        };
        const prepared = await prepareMediaFileForUpload(input);
        let mediaId: string | undefined;
        try {
          let attempt = 0;
          for (let loop = 0; mediaId === undefined; loop += 1) {
            const idempotencyKey = migrationKey(state.seed, key, "upload", `${prepared.prepared.declaration.sha256}\0${attempt}\0${state.items[key]?.id ?? ""}`);
            try {
              mediaId = (await submitPreparedMedia({ ...input, idempotencyKey }, prepared)).mediaId;
              if (mediaId === undefined) throw usageError("The upload finished without a media id.");
            } catch (error) {
              if (terminalConflict(error)) {
                const found = await findBySha(client, prepared.prepared.declaration.sha256);
                if (found) {
                  mediaId = found;
                  break;
                }
                if (loop + 1 >= UPLOAD_BATCH_MAX_ATTEMPTS) throw error;
                attempt += 1;
                continue;
              }
              if (!retryable(error) || loop + 1 >= UPLOAD_BATCH_MAX_ATTEMPTS) throw error;
              await runtime.sleep(computeBackoffMs({ attemptIndex: loop, ...(error.problem.retry_after_seconds !== undefined ? { retryAfterSeconds: error.problem.retry_after_seconds } : {}) }));
            }
          }
        } finally {
          await cleanupPreparedMediaFile(prepared);
        }
        if (folderId !== undefined) {
          await request({
            method: "POST", path: "/api/media/move", idempotent: true,
            idempotencyKey: migrationKey(state.seed, key, "move", `${mediaId}\0${folderId}`), body: { folder_id: folderId, media_ids: [mediaId] },
          });
        }
        state.items[key] = { id: mediaId, at: stamp() };
        succeeded(key);
        await save();
        known.set(key, mediaId);
        const ref: MediaRef = { id: mediaId, kind: media.kind };
        if (media.kind === "video") {
          const read = await client.call({ method: "GET", path: `/api/media/${mediaId}` });
          const duration = (read.body as { duration_ms?: unknown } | undefined)?.duration_ms;
          if (typeof duration === "number") ref.duration_ms = duration;
        }
        mediaRefs.set(media.id, ref);
      } finally {
        await dir.removeStaging(key);
      }
    };

    if (options.only.has("media")) {
      const pending: Array<{ media: ScannedMedia; action: "create" | "recreate" }> = [];
      for (const media of catalog.media) {
        const key = `media:${media.id}`;
        const mapped = state.items[key]?.id;
        const record = mapped === undefined ? undefined : snapshot.media.get(mapped);
        if (mapped !== undefined && record) {
          known.set(key, mapped);
          mediaRefs.set(media.id, { id: mapped, kind: media.kind, ...(typeof record.duration_ms === "number" ? { duration_ms: record.duration_ms } : {}) });
          note("media", { key, action: "reuse", name: media.name });
        } else {
          pending.push({ media, action: mapped === undefined ? "create" : "recreate" });
        }
      }
      if (dry) {
        for (const { media, action } of pending) {
          planned.add(`media:${media.id}`);
          mediaRefs.set(media.id, { id: "(planned)", kind: media.kind });
          note("media", { key: `media:${media.id}`, action, name: media.name });
          if (media.bytes !== undefined) bytes += media.bytes;
        }
      } else {
        let done = 0;
        await mapPool(pending, options.concurrency, async ({ media, action }) => {
          const key = `media:${media.id}`;
          if (halted()) {
            stopWaiting("media", key, media.name);
            return;
          }
          await guard(async () => {
            await importMedia(media);
            note("media", { key, action, name: media.name });
          }, "media", key, media.name);
          if (halted() && !items.some((item) => item.key === key) && !failed.some((entry) => entry.key === key)) stopWaiting("media", key, media.name);
          done += 1;
          progress("media", done, pending.length);
        });
      }
    } else {
      for (const media of catalog.media) {
        const key = `media:${media.id}`;
        const mapped = state.items[key]?.id;
        const record = mapped === undefined ? undefined : snapshot.media.get(mapped);
        if (mapped !== undefined && record) {
          known.set(key, mapped);
          mediaRefs.set(media.id, { id: mapped, kind: media.kind, ...(typeof record.duration_ms === "number" ? { duration_ms: record.duration_ms } : {}) });
        }
      }
    }

    // ---- playlists and layouts ---------------------------------------------------------------
    const playlistsBySource = new Map<string, SourcePlaylist>(catalog.playlists.map((playlist) => [playlist.id, playlist]));
    const layoutsBySource = new Map<string, SourceLayout>(catalog.layouts.map((layout) => [layout.id, layout]));
    const context = (): BuildContext => ({ media: mediaRefs, playlists: playlistsBySource, layouts: layoutsBySource, canvas: options.canvas });
    const contentName = (key: ContentKey): string => (key.startsWith("playlist:") ? playlistsBySource.get(key.slice(9)) : layoutsBySource.get(key.slice(7)))?.name ?? key;

    const importContent = async (key: ContentKey, source: SourcePlaylist | SourceLayout, kind: "playlists" | "layouts"): Promise<void> => {
      const mapped = state.items[key]?.id;
      if (mapped !== undefined && snapshot.playlists.has(mapped)) {
        known.set(key, mapped);
        note(kind, { key, action: "reuse", name: source.name });
        return;
      }
      const action = mapped === undefined ? "create" : "recreate";
      const missing = [...mediaOf(source, playlistsBySource, layoutsBySource)].filter((id) => catalog.media.some((media) => media.id === id) && !mediaRefs.has(id));
      if (missing.length > 0) {
        const first = catalog.media.find((media) => media.id === missing[0])!;
        note(kind, { key, action: "waiting", name: source.name, reason: `Its media has not been imported (${first.name}${missing.length > 1 ? ` and ${missing.length - 1} more` : ""}).` });
        return;
      }
      if (dry) {
        planned.add(key);
        note(kind, { key, action, name: source.name });
        return;
      }
      await guard(async () => {
        const built: Built = "zones" in source ? buildLayout(source, context()) : buildPlaylist(source, context());
        if (!built.ok) throw usageError(built.reason);
        const made = await request<{ id: string }>({
          method: "POST", path: "/api/playlists", idempotent: true,
          idempotencyKey: migrationKey(state.seed, key, "create", fingerprintOf([built.document, mapped ?? null])), body: built.document,
        });
        state.items[key] = { id: made.body.id, at: stamp() };
        succeeded(key);
        await save();
        known.set(key, made.body.id);
        snapshot.playlists.add(made.body.id);
        note(kind, { key, action, name: source.name });
      }, kind, key, source.name);
      if (halted() && !items.some((item) => item.key === key) && !failed.some((entry) => entry.key === key)) stopWaiting(kind, key, source.name);
    };

    if (options.only.has("playlists")) {
      const work: Array<[ContentKey, SourcePlaylist | SourceLayout, "playlists" | "layouts"]> = [];
      for (const playlist of catalog.playlists) if (classified.content.get(`playlist:${playlist.id}`)?.ok) work.push([`playlist:${playlist.id}`, playlist, "playlists"]);
      for (const layout of catalog.layouts) if (classified.content.get(`layout:${layout.id}`)?.ok) work.push([`layout:${layout.id}`, layout, "layouts"]);
      let done = 0;
      for (const [key, source, kind] of work) {
        if (halted()) stopWaiting(kind, key, source.name);
        else await importContent(key, source, kind);
        done += 1;
        progress("playlists", done, work.length);
      }
    } else {
      for (const key of classified.content.keys()) {
        const mapped = state.items[key]?.id;
        if (mapped !== undefined && snapshot.playlists.has(mapped)) known.set(key, mapped);
      }
    }
    const contentReady = (key: ContentKey): boolean => known.has(key) || planned.has(key);

    // ---- screens: fleet-link placeholders ------------------------------------------------------
    /**
     * The screen a device made by opening this placeholder's link. The link id is the identity: it is
     * read-only on the screen and stays after the link is deleted. The migrated_from field names a source
     * but not the account, so two imports of one vendor can share a value and it never identifies a screen.
     */
    const findScreen = (linkId: string | undefined): Screen | undefined =>
      linkId === undefined ? undefined : snapshot.screens.find((screen) => screen.fleet_link_id === linkId);
    let linkSlots = FLEET_LINK_CAP - snapshot.links.size;
    let linkCapReached = false;
    const counts = { linked: 0, unlinked: 0, paired: 0, finished: 0 };

    if (options.only.has("screens")) {
      let done = 0;
      for (const source of catalog.screens) {
        const key = placeholderKey(source.id);
        const entry = state.items[key];
        const place = (status: PlaceholderState["state"], extra: Partial<PlaceholderState> = {}): void => {
          placeholders.push({ source_id: source.id, name: source.name, state: status, ...extra });
          if (status in counts) counts[status as keyof typeof counts] += 1;
        };
        done += 1;
        progress("screens", done, catalog.screens.length);
        if (entry?.finished) {
          note("screens", { key, action: "reuse", name: source.name });
          place("finished", { ...(entry.screen_id ? { screen_id: entry.screen_id } : {}) });
          continue;
        }
        if (halted()) {
          stopWaiting("screens", key, source.name);
          place("waiting");
          continue;
        }
        const content = screenContent(source, classified);
        if (content !== undefined && !contentReady(content)) {
          note("screens", { key, action: "waiting", name: source.name, reason: `Its playlist has not been imported (${contentName(content)}).` });
          place("waiting");
          continue;
        }
        const body = placeholderFor(source, state.tags, classified);
        const linkId = entry?.fleet_link_id;
        const screen = entry?.screen_id === undefined ? findScreen(linkId) : undefined;
        if (entry?.screen_id !== undefined) {
          // A migrate pair claimed a code and stopped before it set the screen up: only migrate pair finishes that.
          note("screens", { key, action: "reuse", name: source.name });
          place("paired", { screen_id: entry.screen_id, ...(linkId ? { fleet_link_id: linkId } : {}) });
          continue;
        }
        const linkExists = linkId !== undefined && snapshot.links.has(linkId);
        if (screen) {
          // Paired by opening the link: finish it once, with the old name and time zone.
          note("screens", { key, action: "reuse", name: source.name });
          place("paired", { screen_id: screen.id, ...(linkId ? { fleet_link_id: linkId } : {}) });
          if (!dry) {
            await guard(async () => {
              await finishScreen({ client, request, state, seed: state.seed, vendor, source, screen, ...(linkExists ? { linkId } : {}), timezone: source.timezone ?? scan.inputs.timezone, stamp });
              const last = placeholders[placeholders.length - 1]!;
              last.state = "finished";
              counts.paired -= 1;
              counts.finished += 1;
              await save();
            }, "screens", key, source.name);
          }
          continue;
        }
        if (linkExists) {
          note("screens", { key, action: "reuse", name: source.name });
          place("linked", { fleet_link_id: linkId! });
          continue;
        }
        const action = entry?.fleet_link_id === undefined ? "create" : "recreate";
        if (linkCapReached || linkSlots <= 0) {
          note("screens", { key, action, name: source.name, reason: "The project is at its fleet link limit, so this screen waits for a Player code." });
          place("unlinked");
          continue;
        }
        if (dry) {
          linkSlots -= 1;
          note("screens", { key, action, name: source.name });
          place("linked");
          continue;
        }
        await guard(async () => {
          const link: Record<string, unknown> = {
            label: body.label,
            tags: body.tags,
            ...(content !== undefined ? { playlist_id: known.get(content)! } : {}),
            max_screens: 1,
            fields: { migrated_from: sourceRef(vendor, source.id) },
          };
          try {
            const made = await request<FleetLink>({
              method: "POST", path: "/api/fleet-links", idempotent: true,
              idempotencyKey: migrationKey(state.seed, key, "link", fingerprintOf([link, entry?.fleet_link_id ?? null])), body: link,
            });
            state.items[key] = { ...entry, fleet_link_id: made.body.id, at: stamp() };
            succeeded(key);
            await save();
            snapshot.links.set(made.body.id, made.body);
            linkSlots -= 1;
            note("screens", { key, action, name: source.name });
            place("linked", { fleet_link_id: made.body.id });
          } catch (error) {
            if (error instanceof CliError && error.problem.code === "fleet_link_limit_reached") {
              linkCapReached = true;
              note("screens", { key, action, name: source.name, reason: "The project is at its fleet link limit, so this screen waits for a Player code." });
              place("unlinked");
              return;
            }
            throw error;
          }
        }, "screens", key, source.name);
        if (halted() && !items.some((item) => item.key === key) && !failed.some((entry2) => entry2.key === key)) {
          stopWaiting("screens", key, source.name);
          place("waiting");
        }
      }
    }

    // ---- schedules: campaigns -----------------------------------------------------------------
    if (options.only.has("schedules")) {
      let done = 0;
      for (const schedule of catalog.schedules) {
        const key = `schedule:${schedule.id}`;
        const verdict = classified.schedules.get(schedule.id);
        done += 1;
        progress("schedules", done, catalog.schedules.length);
        if (!verdict || "reason" in verdict) continue;
        const mapped = state.items[key]?.id;
        if (mapped !== undefined && snapshot.campaigns.has(mapped)) {
          note("schedules", { key, action: "reuse", name: schedule.name });
          continue;
        }
        if (halted()) {
          stopWaiting("schedules", key, schedule.name);
          continue;
        }
        const action = mapped === undefined ? "create" : "recreate";
        if (!contentReady(verdict.content)) {
          note("schedules", { key, action: "waiting", name: schedule.name, reason: `The playlist it plays has not been imported (${contentName(verdict.content)}).` });
          continue;
        }
        if (dry) {
          note("schedules", { key, action, name: schedule.name });
          continue;
        }
        await guard(async () => {
          const tags = [
            ...verdict.targets.groups.map((id) => state.tags[`group:${id}`]),
            ...verdict.targets.screens.map((id) => state.tags[`screen:${id}`]),
          ].filter((tag): tag is string => tag !== undefined);
          const body = {
            name: truncate(cleanName(schedule.name) || "Imported schedule", 120).text,
            playlist_id: known.get(verdict.content)!,
            audience: tagAudience([...new Set(tags)]),
            ...(verdict.timing.from !== undefined ? { from: verdict.timing.from } : {}),
            ...(verdict.timing.until !== undefined ? { until: verdict.timing.until } : {}),
            ...(verdict.timing.windows !== undefined ? { windows: verdict.timing.windows } : {}),
            priority: Math.min(100, Math.max(0, Math.round(schedule.priority))),
          };
          const made = await request<Campaign>({
            method: "POST", path: "/api/campaigns", idempotent: true,
            idempotencyKey: migrationKey(state.seed, key, "create", fingerprintOf([body, mapped ?? null])), body,
          });
          state.items[key] = { id: made.body.id, at: stamp() };
          succeeded(key);
          await save();
          snapshot.campaigns.set(made.body.id, made.body);
          note("schedules", { key, action, name: schedule.name });
        }, "schedules", key, schedule.name);
        if (halted() && !items.some((item) => item.key === key) && !failed.some((entry) => entry.key === key)) stopWaiting("schedules", key, schedule.name);
      }
    }

    await save();
    return finishResult({ deps, options, dry, results, items, failed, waiting, placeholders, counts, bytes, snapshot, tags: state.tags, ...(folderId !== undefined && folderId !== "(planned)" ? { folderId } : {}), stopped: halted() });
  } finally {
    await release?.();
  }
}

async function findBySha(client: ApiClient, sha256: string): Promise<string | undefined> {
  try {
    const response = await client.listAll("/api/media", undefined, { uncapped: true });
    const rows = (response.body as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
    return rows.find((row) => row.sha256 === sha256 && typeof row.id === "string")?.id as string | undefined;
  } catch {
    return undefined;
  }
}

/** Gives a screen its old name and time zone, records it, and deletes the link it came through. Once. */
export async function finishScreen(input: {
  client: ApiClient;
  request: <T = unknown>(call: Parameters<ApiClient["call"]>[0]) => Promise<{ body: T; status: number }>;
  state: MigrationMap;
  seed: string;
  vendor: string;
  source: SourceScreen;
  screen: Screen;
  linkId?: string;
  timezone?: string;
  stamp: () => string;
}): Promise<void> {
  const { state, source, screen } = input;
  const key = placeholderKey(source.id);
  const label = truncate(cleanName(source.name) || "Imported screen", 80).text;
  const patch: Record<string, unknown> = {};
  if (screen.label !== label) patch.name = label;
  if (input.timezone !== undefined && screen.timezone !== input.timezone) patch.timezone = input.timezone;
  if (Object.keys(patch).length > 0) {
    await input.request({
      method: "PATCH", path: `/api/screens/${screen.id}`, idempotent: true,
      idempotencyKey: migrationKey(input.seed, key, "finish", fingerprintOf(patch)), body: patch,
    });
  }
  if (input.linkId !== undefined) {
    try {
      await input.client.call({ method: "DELETE", path: `/api/fleet-links/${input.linkId}`, idempotent: true, idempotencyKey: migrationKey(input.seed, key, "unlink", input.linkId) });
    } catch (error) {
      if (!(error instanceof CliError && error.problem.status === 404)) throw error;
    }
  }
  state.items[key] = { ...state.items[key], screen_id: screen.id, finished: true, at: input.stamp() };
}

function finishResult(input: {
  deps: ApplyDeps;
  options: ApplyOptions;
  dry: boolean;
  results: Record<ResultKind, Tally>;
  items: PlanItem[];
  failed: FailedItem[];
  waiting: Array<{ key: string; name: string; reason: string }>;
  placeholders: PlaceholderState[];
  counts: Record<"linked" | "unlinked" | "paired" | "finished", number>;
  bytes: number;
  snapshot: Snapshot;
  tags: Record<string, string>;
  folderId?: string;
  stopped: CliError | undefined;
}): ApplyResult {
  const { deps, dry, results, failed, waiting, snapshot } = input;
  const warnings: Warning[] = [];
  const base = { dir: deps.dir.dir, vendor: deps.scan.vendor, dry_run: dry, tags: input.tags, ...(input.folderId !== undefined ? { folder_id: input.folderId } : {}) };
  if (dry) {
    const creating = results.schedules.create + results.schedules.recreate;
    const data: ApplyData = {
      ...base,
      plan: results,
      bytes: input.bytes,
      items: input.items,
      placeholders: input.counts,
      project: {
        fleet_links: { used: snapshot.links.size, max: FLEET_LINK_CAP },
        campaigns: { used: snapshot.campaigns.size, max: CAMPAIGN_CAP },
      },
    };
    const lines = [
      `Plan for ${deps.scan.label} (${deps.scan.vendor}); nothing was written`,
      ...(Object.entries(results) as Array<[ResultKind, Tally]>).filter(([, row]) => Object.values(row).some(Boolean)).map(([kind, row]) => `  ${kind}: ${row.create} to create, ${row.recreate} to recreate, ${row.reuse} already there, ${row.waiting} waiting`),
      `  screens waiting for a Player: ${input.counts.linked} with a link, ${input.counts.unlinked} to pair by code, ${input.counts.paired} paired, ${input.counts.finished} finished`,
      `  project: fleet links ${snapshot.links.size}/${FLEET_LINK_CAP}, campaigns ${snapshot.campaigns.size}/${CAMPAIGN_CAP} (${creating} to create)`,
      ...(input.bytes > 0 ? [`  to download: ${input.bytes} bytes`] : []),
    ];
    return { data, warnings, exitCode: ExitCode.Success, human: lines.join("\n") };
  }
  const stoppedData: Stopped | undefined = input.stopped
    ? { code: input.stopped.problem.code, detail: truncate(input.stopped.problem.detail, 300).text, next: stopNext(input.stopped, deps.rerun) }
    : undefined;
  const data: ApplyData = {
    ...base,
    applied: results,
    failed,
    waiting,
    placeholders: input.placeholders,
    ...(stoppedData ? { stopped: stoppedData } : {}),
  };
  if (failed.length > 0) {
    warnings.push({ code: "migration_items_failed", message: `${failed.length} item${failed.length === 1 ? "" : "s"} failed; run the same apply again to retry ${failed.length === 1 ? "it" : "them"}.` });
  }
  const lines = [
    `Applied ${deps.scan.label} (${deps.scan.vendor})`,
    ...(Object.entries(results) as Array<[ResultKind, Tally]>).filter(([, row]) => Object.values(row).some(Boolean)).map(([kind, row]) => `  ${kind}: ${row.create} created, ${row.recreate} recreated, ${row.reuse} already there, ${row.waiting} waiting, ${row.fail} failed`),
    ...(input.placeholders.length > 0 ? [`  screens: ${input.counts.linked} wait on a link, ${input.counts.unlinked} wait for a Player code (migrate pair), ${input.counts.finished} finished`] : []),
    ...(stoppedData ? [`stopped: ${stoppedData.code}: ${stoppedData.detail}`, `next: ${stoppedData.next.command}`] : []),
    ...failed.map((item) => `failed: ${item.key} ${item.code}`),
  ];
  const exitCode = input.stopped ? input.stopped.exitCode : exitForFailures(failed);
  return { data, warnings, exitCode, human: lines.join("\n") };
}
