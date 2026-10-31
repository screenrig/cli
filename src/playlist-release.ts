import { createHash } from "node:crypto";
import { ApiClient } from "./client.js";
import { editablePlaylist } from "./playlist-authoring.js";
import { assertPlaylistValid } from "./playlist-validate.js";
import { quotedRevision } from "./if-match.js";
import { CliError, makeProblem, usageError } from "./problems.js";
import type { Screen } from "./adapters/protocol.js";
import { pendingReviewOf, reviewNoteHeaders } from "./reviews.js";
import { canonicalJson } from "./kv-write.js";

/** Inspect stored references without trying to evaluate schedule rules in the CLI. */
function playlistReferences(screen: Screen, playlistId: string) {
  const entries = screen.playlist_schedule?.entries;
  if (screen.playlist_schedule != null && (!Array.isArray(entries) || entries.some(entry =>
    !entry || typeof entry.id !== "string" || typeof entry.playlist_id !== "string"))) {
    throw usageError("Cannot determine affected screens: invalid playlist schedule.");
  }
  if (screen.takeover != null && typeof screen.takeover.playlist_id !== "string") {
    throw usageError("Cannot determine affected screens: invalid takeover.");
  }
  if (screen.effective_playlist != null && typeof screen.effective_playlist.id !== "string") {
    throw usageError("Cannot determine affected screens: invalid effective playlist.");
  }
  const scheduled = entries?.filter(entry => entry.playlist_id === playlistId) ?? [];
  return {
    default_assignment: screen.playlist_id === playlistId ? playlistId : undefined,
    schedule_entries: scheduled.length ? scheduled : undefined,
    takeover: screen.takeover?.playlist_id === playlistId ? screen.takeover : undefined,
    effective_playlist: screen.effective_playlist?.id === playlistId ? screen.effective_playlist : undefined,
  };
}

/** Review is a snapshot; the existing API atomically guards playlist revision only. */
export async function replacePlaylistRelease(options: {
  client: ApiClient; apiUrl: string; playlistId: string; pageId: string;
  primitiveId: string; releaseId: string; apply: boolean;
  revision?: string; impact?: string;
  /** The proposer's note when the write becomes a review. */
  note?: string;
}) {
  const { client, playlistId, pageId, primitiveId, releaseId } = options;
  if (!options.apply && (options.revision || options.impact)) {
    throw usageError("Preview without write flags first. Use --apply to write; revision and impact guards are optional.");
  }
  const response = await client.call({ method: "GET", path: `/api/playlists/${playlistId}` });
  const resource = response.body as { id: string; revision: number };
  if (resource?.id !== playlistId || !Number.isSafeInteger(resource.revision) || resource.revision < 1) throw usageError("Playlist response has invalid identity or revision.");
  if (options.apply && options.revision !== undefined && options.revision !== String(resource.revision)) {
    throw new CliError(makeProblem("revision_conflict", "Playlist changed", 412, "Preview the replacement again before applying.", { current_revision: resource.revision }));
  }
  const document = editablePlaylist(response.body);
  const pages = document.pages.filter((page: { id: string }) => page.id === pageId);
  if (pages.length !== 1) throw usageError("Page ID must identify exactly one page in this playlist.");
  const primitives = pages[0].primitives.filter((primitive: { id: string }) => primitive.id === primitiveId);
  if (primitives.length !== 1 || primitives[0].primitive !== "application") throw usageError("Primitive ID must identify exactly one application on the selected page.");
  const primitive = primitives[0];
  const previousRelease = primitive.release_id;
  const unchanged = previousRelease === releaseId;
  primitive.release_id = releaseId;
  assertPlaylistValid(document);
  const impactChecked = !options.apply || options.impact !== undefined;
  const screens: (Pick<Screen, "id" | "label" | "state" | "revision"> & { references: ReturnType<typeof playlistReferences> })[] = [];
  for (const query of (!options.apply || options.impact ? [undefined, { state: "archived" }] : [])) {
    const listed = await client.listAll("/api/screens", query);
    const items = (listed.body as { items?: Screen[] })?.items;
    if (!Array.isArray(items)) throw usageError("Cannot determine affected screens: invalid screen list.");
    for (const screen of items) {
      if (!screen || typeof screen !== "object") throw usageError("Cannot determine affected screens: invalid screen.");
      const references = playlistReferences(screen, playlistId);
      if (Object.values(references).every(value => value === undefined)) continue;
      if (typeof screen.id !== "string" || !Number.isSafeInteger(screen.revision) || screen.revision < 1 || !["active", "pairing_pending", "archived"].includes(screen.state)) throw usageError("Cannot determine affected screens: invalid screen identity, state or revision.");
      if (screens.some(item => item.id === screen.id)) throw usageError("Screen state changed while listing impact. Preview again.");
      screens.push({ id: screen.id, label: screen.label, state: screen.state, revision: screen.revision, references });
    }
  }
  screens.sort((a, b) => a.id.localeCompare(b.id));
  const review = {
    playlist_id: playlistId, playlist_name: document.name, revision: resource.revision,
    page_id: pageId, primitive_id: primitiveId,
    previous_release_id: previousRelease, release_id: releaseId,
    affected_screens: impactChecked ? screens.map(({ references, ...screen }) => screen) : undefined,
    consequence: "Lists screens whose default assignment, stored schedule entries, takeover or current effective playlist references this shared playlist. Archived screens retain the new pin for later use. References are a snapshot; a supplied playlist revision is checked atomically. Release availability and ownership are checked by the server on apply.",
  };
  const impact = createHash("sha256").update(canonicalJson(JSON.stringify({ api_url: options.apiUrl, review, document,
    references: screens.map(({ id, references }) => ({ id, references })),
  }))).digest("hex");
  if (!options.apply) return { ...review, impact, applied: false };
  if (options.impact !== undefined && options.impact !== impact) {
    throw new CliError(makeProblem("resource_conflict", "Replacement impact changed", 409,
      "Replacement or affected screens changed since the preview. Preview again and review the new impact before applying.", { current_revision: resource.revision }));
  }
  if (unchanged) return { ...review, impact, applied: true, unchanged: true, playlist: response.body };
  const updated = await client.call({ method: "PUT", path: `/api/playlists/${playlistId}`, idempotent: true,
    headers: { ...reviewNoteHeaders(options.note), ...(options.revision ? { "if-match": quotedRevision(options.revision) } : {}) }, body: document });
  // Under Propose access the replacement waits for a person: nothing changed on glass.
  const pending = pendingReviewOf(updated);
  if (pending) return { ...review, impact, applied: false, status: "pending_review", review: pending.review, playlist: pending.playlist,
    ...(pending.warnings ? { warnings: pending.warnings } : {}) };
  // The top-level revision is the playlist's revision now; the reviewed one stays as previous_revision.
  const written = (updated.body as { revision?: unknown } | undefined)?.revision;
  return { ...review, ...(Number.isSafeInteger(written) ? { revision: written as number, previous_revision: review.revision } : {}), impact, applied: true, playlist: updated.body };
}
