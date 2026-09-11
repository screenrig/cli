import { createHash } from "node:crypto";
import { ApiClient } from "./client.js";
import { editablePlaylist } from "./playlist-authoring.js";
import { assertPlaylistValid } from "./playlist-validate.js";
import { quotedRevision } from "./if-match.js";
import { CliError, makeProblem, usageError } from "./problems.js";
import type { Screen } from "./adapters/protocol.js";

/** Review is a snapshot; the existing API atomically guards playlist revision only. */
export async function replacePlaylistRelease(options: {
  client: ApiClient; apiUrl: string; playlistId: string; pageId: string;
  primitiveId: string; releaseId: string; apply: boolean;
  revision?: string; impact?: string;
}) {
  const { client, playlistId, pageId, primitiveId, releaseId } = options;
  if (options.apply ? !options.revision || !options.impact : options.revision || options.impact) {
    throw usageError("Preview without write flags first. Apply requires --apply, --expect-rev and --expect-impact from that preview.");
  }
  const response = await client.call({ method: "GET", path: `/api/v1/playlists/${playlistId}` });
  const resource = response.body as { id: string; revision: number };
  if (resource?.id !== playlistId || !Number.isSafeInteger(resource.revision) || resource.revision < 1) throw usageError("Playlist response has invalid identity or revision.");
  if (options.apply && options.revision !== String(resource.revision)) {
    throw new CliError(makeProblem("revision_conflict", "Playlist changed", 409, "Preview the replacement again before applying.", { current_revision: resource.revision }));
  }
  const document = editablePlaylist(response.body);
  const pages = document.pages.filter((page: { id: string }) => page.id === pageId);
  if (pages.length !== 1) throw usageError("Page ID must identify exactly one page in this playlist.");
  const primitives = pages[0].primitives.filter((primitive: { id: string }) => primitive.id === primitiveId);
  if (primitives.length !== 1 || primitives[0].primitive !== "application") throw usageError("Primitive ID must identify exactly one application on the selected page.");
  const primitive = primitives[0];
  const previousRelease = primitive.release_id;
  if (previousRelease === releaseId) throw usageError("The selected primitive already pins this release.");
  primitive.release_id = releaseId;
  assertPlaylistValid(document);
  const screens: Pick<Screen, "id" | "label" | "state" | "revision">[] = [];
  for (const query of [undefined, { state: "archived" }]) {
    const listed = await client.call({ method: "GET", path: "/api/v1/screens", query });
    const items = (listed.body as { items?: Screen[] })?.items;
    if (!Array.isArray(items)) throw usageError("Cannot determine affected screens: invalid screen list.");
    for (const screen of items) {
      if (screen.playlist_id !== playlistId) continue;
      if (typeof screen.id !== "string" || !Number.isSafeInteger(screen.revision) || screen.revision < 1 || !["active", "pairing_pending", "archived"].includes(screen.state)) throw usageError("Cannot determine affected screens: invalid screen identity, state or revision.");
      if (screens.some(item => item.id === screen.id)) throw usageError("Screen state changed while listing impact. Preview again.");
      screens.push({ id: screen.id, label: screen.label, state: screen.state, revision: screen.revision });
    }
  }
  screens.sort((a, b) => a.id.localeCompare(b.id));
  const review = {
    playlist_id: playlistId, playlist_name: document.name, revision: resource.revision,
    page_id: pageId, primitive_id: primitiveId,
    previous_release_id: previousRelease, release_id: releaseId,
    affected_screens: screens,
    consequence: "Every assigned screen uses this shared playlist. Archived screens retain the new pin for later use. Screen assignments may change after this snapshot; only the playlist revision is checked atomically. Release availability and ownership are checked by the server on apply.",
  };
  const impact = createHash("sha256").update(JSON.stringify({ api_url: options.apiUrl, review, document })).digest("hex");
  if (!options.apply) return { ...review, impact, applied: false };
  if (options.impact !== impact) throw usageError("Replacement or affected screens changed. Preview again and review the new impact before applying.");
  const updated = await client.call({ method: "PUT", path: `/api/v1/playlists/${playlistId}`, idempotent: true,
    headers: { "if-match": quotedRevision(options.revision!) }, body: document });
  return { ...review, impact, applied: true, playlist: updated.body };
}
