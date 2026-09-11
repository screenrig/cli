import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiClient } from "./client.js";
import { newIdempotencyKey } from "./ids.js";
import { quotedRevision } from "./if-match.js";
import { CliError, makeProblem, usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";

type Resource = { id: string; revision: number; playlist_id?: string; timezone?: string };
interface Journal { version: 1; created_at: number; fingerprint: string; create_key: string; assign_key: string; playlist?: Resource; assigned?: boolean }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function resource(value: unknown, prefix: string): Resource {
  const item = value as Resource;
  if (!item || typeof item.id !== "string" || !item.id.startsWith(prefix) || !Number.isSafeInteger(item.revision) || item.revision < 1) throw usageError("Server response has invalid resource identity or revision.");
  return item;
}
function conflict(detail: string, revision?: number): never {
  throw new CliError(makeProblem("revision_conflict", "Publish needs reconciliation", 409, detail, { current_revision: revision }));
}

/** Multi-request publishing is resumable, not atomic. The journal contains no authored content. */
export async function publishScreen(options: {
  client: ApiClient; runtime: CliRuntime; configPath: string; apiUrl: string;
  screenId: string; revision: string; document: any; requestedKey?: string;
}) {
  const { client, screenId, document } = options;
  const expected = Number(options.revision.replaceAll('"', ''));
  quotedRevision(options.revision);
  if (!/^scr_[A-Za-z0-9_-]+$/.test(screenId)) throw usageError("screen publish requires a screen identifier.");
  const account = (await client.call({ method: "GET", path: "/api/v1/account" })).body as { id: string };
  if (!account?.id?.startsWith("acc_")) throw usageError("Account identity is missing.");
  const fingerprint = digest(JSON.stringify([options.apiUrl, account.id, screenId, expected, document, options.requestedKey ?? ""]));
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
      if (state.playlist) resource(state.playlist, "pl_");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!state) {
      const screen = resource((await client.call({ method: "GET", path: `/api/v1/screens/${screenId}` })).body, "scr_");
      if (screen.id !== screenId) throw usageError("Screen response identity did not match.");
      if (screen.revision !== expected) conflict("Screen changed before publishing. Inspect it and retry with its intended revision.", screen.revision);
      if (document.pages.some((page: any) => page.visibility !== undefined) && !screen.timezone) throw usageError("Set the screen timezone before publishing a scheduled playlist.");
      state = { version: 1, created_at: options.runtime.now().getTime(), fingerprint, create_key: newIdempotencyKey(), assign_key: newIdempotencyKey() };
      await save();
    }
    if (!state.assigned && options.runtime.now().getTime() - state.created_at >= 24 * 60 * 60 * 1000) {
      throw usageError("The publish replay window has expired. Inspect the account and screen before reconciling; this command will not repeat an ambiguous write after server idempotency expiry.");
    }
    if (!state.playlist) {
      const response = await client.call({ method: "POST", path: "/api/v1/playlists", body: document, idempotent: true, idempotencyKey: state.create_key });
      state.playlist = resource(response.body, "pl_");
      // Persist identity only, never the returned playlist or resolved media.
      state.playlist = { id: state.playlist.id, revision: state.playlist.revision };
      await save();
    }
    if (!state.assigned) {
      await client.call({ method: "PATCH", path: `/api/v1/screens/${screenId}`, body: { playlist_id: state.playlist.id }, headers: { "if-match": quotedRevision(options.revision) }, idempotent: true, idempotencyKey: state.assign_key });
      state.assigned = true;
      await save();
    }
    const screen = resource((await client.call({ method: "GET", path: `/api/v1/screens/${screenId}` })).body, "scr_");
    if (screen.id !== screenId || screen.playlist_id !== state.playlist.id) conflict("The screen no longer has this playlist assigned. Inspect it before making another change.", screen.revision);
    return { playlist_id: state.playlist.id, playlist_revision: state.playlist.revision, screen_id: screenId, screen_revision: screen.revision, assignment_verified: true, playback_verified: false, journal: journalPath };
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
