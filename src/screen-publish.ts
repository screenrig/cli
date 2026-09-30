import { RESOURCE_ID_PATTERNS, isResourceID, type ResourceIDKind } from "./generated/resource-ids.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireCapability } from "./project-capabilities.js";
import { ApiClient } from "./client.js";
import { newIdempotencyKey } from "./ids.js";
import { quotedRevision } from "./if-match.js";
import { playlistApiVersion } from "./playlist-authoring.js";
import { CliError, makeProblem, usageError } from "./problems.js";
import { manifestUpgradeOf } from "./screen-manifest-upgrade.js";
import type { CliRuntime } from "./runtime.js";

type Resource = { id: string; revision: number; playlist_id?: string; timezone?: string };
interface Journal { version: 1; created_at: number; fingerprint: string; create_key: string; assign_key: string; playlist?: Resource; assigned?: boolean }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function resource(value: unknown, kind: ResourceIDKind): Resource {
  const item = value as Resource;
  if (!item || typeof item.id !== "string" || !isResourceID(item.id, kind) || !Number.isSafeInteger(item.revision) || item.revision < 1) throw usageError("Server response has invalid resource identity or revision.");
  return item;
}
function conflict(detail: string, revision?: number): never {
  throw new CliError(makeProblem("revision_conflict", "Publish needs reconciliation", 409, detail, { current_revision: revision }));
}

type PlaybackReason = "not_waited" | "screen_offline" | "playlist_not_effective" | "playback_failed" | "playback_pending";
export interface PlaybackResult {
  /** The Player acknowledged this playlist revision as the one on glass. */
  playing: boolean;
  reason?: PlaybackReason;
  online: boolean;
  /** Manifest upgrade state from the screen read model. */
  state?: string;
  code?: string;
  missing_page_count?: number;
  effective_playlist_id?: string;
  waited_ms: number;
}

/**
 * Where playback stands for one freshly assigned playlist. It is playing once
 * the Player acknowledges the desired manifest and that manifest is this
 * playlist. Offline screens, another effective playlist (takeover or schedule)
 * and a failed upgrade cannot change within a short wait, so they end it.
 */
function playbackOf(screen: any, playlist: Resource): Omit<PlaybackResult, "waited_ms"> & { final: boolean } {
  const upgrade = manifestUpgradeOf(screen);
  const online = screen?.online === true;
  const effective = typeof screen?.effective_playlist?.id === "string" ? screen.effective_playlist.id as string : undefined;
  const detail = {
    online,
    ...(upgrade ? { state: upgrade.state } : {}),
    ...(typeof upgrade?.code === "string" ? { code: upgrade.code } : {}),
    ...(typeof upgrade?.missing_page_count === "number" ? { missing_page_count: upgrade.missing_page_count } : {}),
    ...(effective ? { effective_playlist_id: effective } : {}),
  };
  const active = upgrade?.active_playlist;
  if (upgrade?.desired_revision && upgrade.active_revision === upgrade.desired_revision
    && active?.id === playlist.id && active.revision >= playlist.revision) return { playing: true, final: true, ...detail };
  if (effective && effective !== playlist.id) return { playing: false, final: true, reason: "playlist_not_effective", ...detail };
  if (!online) return { playing: false, final: true, reason: "screen_offline", ...detail };
  if (upgrade?.state === "failed") return { playing: false, final: true, reason: "playback_failed", ...detail };
  return { playing: false, final: false, reason: "playback_pending", ...detail };
}

async function awaitPlayback(options: {
  client: ApiClient; runtime: CliRuntime; screenId: string; playlist: Resource; screen: unknown;
  wait: { timeoutMs: number; pollMs: number }; progress?: (stage: string, state?: string) => void;
}): Promise<PlaybackResult> {
  const started = options.runtime.now().getTime();
  let screen = options.screen;
  let reported: string | undefined | null = null;
  for (;;) {
    const { final, ...playback } = playbackOf(screen, options.playlist);
    const waited_ms = options.runtime.now().getTime() - started;
    if (!playback.playing && playback.state !== reported) options.progress?.("assigned", reported = playback.state);
    if (final || waited_ms + options.wait.pollMs > options.wait.timeoutMs) return { ...playback, waited_ms };
    await options.runtime.sleep(options.wait.pollMs);
    screen = (await options.client.call({ method: "GET", path: `/api/v1/screens/${options.screenId}` })).body;
  }
}

/** Multi-request publishing is resumable, not atomic. The journal contains no authored content. */
export async function publishScreen(options: {
  client: ApiClient; runtime: CliRuntime; configPath: string; apiUrl: string;
  screenId: string; revision?: string; document: any; requestedKey?: string;
  /** Wait for the Player to show the playlist; omit to return after assignment. */
  wait?: { timeoutMs: number; pollMs: number };
  progress?: (stage: string, state?: string) => void;
}) {
  const { client, screenId, document } = options;
  const expected = options.revision === undefined ? undefined : Number(options.revision.replaceAll('"', ''));
  const project = (await client.call({ method: "GET", path: "/api/v1/project" })).body as { id?: string } | undefined;
  if (typeof project?.id !== "string" || project.id.length === 0) throw usageError("Project identity is missing.");
  // An ad-bearing document is published under the v2 union, and only a
  // signage/publish-capable project may place adslot pages at all.
  const playlistVersion = playlistApiVersion(document.pages);
  if (playlistVersion === "v2") {
    await requireCapability(client, "signage.publish", "screen publish with adslot pages", {
      command: "screenrig project capabilities",
      reason: "Read the project's effective capabilities before publishing an ad-bearing playlist; an advertising-only project cannot publish playlists.",
    });
  }
  const fingerprint = digest(JSON.stringify([options.apiUrl, project.id, screenId, expected, document, options.requestedKey ?? ""]));
  const directory = path.join(path.dirname(options.configPath), "publishes");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const journalPath = path.join(directory, `${fingerprint}.json`);
  // A dead local process can be recovered without expiring an active publisher's lock.
  const lockPath = `${journalPath}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(path.join(lockPath, "pid"), String(process.pid), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let dead = false;
      try {
        const pid = Number(await readFile(path.join(lockPath, "pid"), "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (probe) { dead = (probe as NodeJS.ErrnoException).code === "ESRCH"; }
        }
      } catch { /* An initializing or incomplete lock is never stolen. */ }
      if (!dead || attempt > 0) throw usageError(`Publish is already running or has an incomplete lock at ${lockPath}. Confirm no publisher is running before removing an incomplete lock.`);
      const abandoned = `${lockPath}.${randomUUID()}.stale`;
      try { await rename(lockPath, abandoned); await rm(abandoned, { recursive: true, force: true }); }
      catch { throw usageError("Publish lock changed; retry the same command."); }
    }
  }
  let state: Journal | undefined;
  const save = async () => {
    const temporary = `${journalPath}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(state) + "\n"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, journalPath);
  };
  try {
    try {
      const info = await stat(journalPath);
      if ((info.mode & 0o077) !== 0) throw usageError("Publish journal must be private.");
      state = JSON.parse(await readFile(journalPath, "utf8"));
      if (state?.version !== 1 || state.fingerprint !== fingerprint || !Number.isFinite(state.created_at) || !state.create_key || !state.assign_key) throw usageError("Publish journal is invalid.");
      if (state.playlist) resource(state.playlist, "playlist");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!state) {
      const screen = resource((await client.call({ method: "GET", path: `/api/v1/screens/${screenId}` })).body, "screen");
      if (screen.id !== screenId) throw usageError("Screen response identity did not match.");
      if (expected !== undefined && screen.revision !== expected) conflict("Screen changed before publishing. Inspect it and retry with its intended revision.", screen.revision);
      if (document.pages.some((page: any) => page.visibility !== undefined) && !screen.timezone) throw usageError("Set the screen timezone before publishing a scheduled playlist.");
      state = { version: 1, created_at: options.runtime.now().getTime(), fingerprint, create_key: newIdempotencyKey(), assign_key: newIdempotencyKey() };
      await save();
    }
    if (!state.assigned && options.runtime.now().getTime() - state.created_at >= 24 * 60 * 60 * 1000) {
      throw usageError("The publish replay window has expired. Inspect the project and screen before reconciling; this command will not repeat an ambiguous write after server idempotency expiry.");
    }
    if (!state.playlist) {
      const response = await client.call({ method: "POST", path: `/api/${playlistVersion}/playlists`, body: document, idempotent: true, idempotencyKey: state.create_key });
      state.playlist = resource(response.body, "playlist");
      // Persist identity only, never the returned playlist or resolved media.
      state.playlist = { id: state.playlist.id, revision: state.playlist.revision };
      await save();
    }
    if (!state.assigned) {
      await client.call({ method: "PATCH", path: `/api/v1/screens/${screenId}`, body: { playlist_id: state.playlist.id }, headers: options.revision ? { "if-match": quotedRevision(options.revision) } : undefined, idempotent: true, idempotencyKey: state.assign_key });
      state.assigned = true;
      await save();
    }
    const screen = resource((await client.call({ method: "GET", path: `/api/v1/screens/${screenId}` })).body, "screen");
    if (screen.id !== screenId || screen.playlist_id !== state.playlist.id) conflict("The screen no longer has this playlist assigned. Inspect it before making another change.", screen.revision);
    const playback: PlaybackResult = options.wait
      ? await awaitPlayback({ client, runtime: options.runtime, screenId, playlist: state.playlist, screen, wait: options.wait, progress: options.progress })
      : { playing: false, reason: "not_waited", online: (screen as { online?: unknown }).online === true, waited_ms: 0 };
    if (playback.playing) options.progress?.("playing", playback.state);
    return { playlist_id: state.playlist.id, playlist_revision: state.playlist.revision, screen_id: screenId, screen_revision: screen.revision,
      stage: playback.playing ? "playing" : "assigned", assignment_verified: true, playback_verified: playback.playing, playback, journal: journalPath };
  } catch (error) {
    if (error instanceof CliError) {
      error.problem.errors.push({ stage: state?.assigned ? "verify" : state?.playlist ? "assign" : "create", playlist_id: state?.playlist?.id, journal: journalPath });
      // Preserve the selected destination without copying credentials or URL parameters.
      const api = new URL(options.apiUrl);
      api.username = ""; api.password = ""; api.search = ""; api.hash = "";
      const context = ["--config", options.configPath, "--api-url", api.toString().replace(/\/+$/, "")];
      if (!error.problem.next) error.problem.next = {
        command: `screenrig screen show ${screenId}`,
        argv: ["screen", "show", screenId, ...context],
        reason: "Inspect the target using argv to preserve the selected configuration and API. After a transport failure, repeat the identical publish command to resume; revision conflicts require reconciliation. The journal records any playlist already created.",
      };
      if (error.problem.code === "revision_conflict" && state?.playlist && !state.assigned) {
        error.problem.next = {
          command: `screenrig screen show ${screenId}`,
          argv: ["screen", "show", screenId, ...context],
          reason: "Inspect the current screen and reconcile concurrent changes before assigning the playlist already created. Do not rerun publish with a new revision: that starts a new publish and can create another playlist.",
          after_inspection: {
            command: `screenrig screen assign ${screenId} --playlist-id ${state.playlist.id} --expect-rev <REVIEWED_REVISION>`,
            argv: ["screen", "assign", screenId, "--playlist-id", state.playlist.id, "--expect-rev", "<REVIEWED_REVISION>", ...context],
            reason: "Only if this assignment is still intended, replace <REVIEWED_REVISION> with the revision from the inspected screen. Use argv to preserve the configuration and API. The conflict response revision is not approval to overwrite concurrent changes.",
          },
        };
      }
    }
    throw error;
  } finally { await rm(lockPath, { recursive: true, force: true }); }
}
