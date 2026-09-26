import type { Screen, ScreenManifestUpgrade, ScreenManifestUpgradePlaylist } from "./adapters/protocol.js";

/**
 * Consumer helpers for the screen manifest upgrade read model
 * (`Screen.manifest_upgrade`). The backend always computes it; these helpers
 * only render it. A missing or malformed object (an older backend, or a test
 * fixture without the feature) simply renders nothing, exactly like a screen
 * that never reported storage.
 *
 * User-facing presentation is playlist versions — `Target v42` / `Playing
 * v41` — scoped by playlist identity across switches; `Playing` is the last
 * server-acknowledged activation, never proof that every connected session
 * shows it. The man_ revision strings stay machine identity and diagnostics:
 * they are never the primary human display and no version is ever fabricated
 * from them.
 */

const UPGRADE_STATES: Record<string, true> = {
  none: true, pending: true, downloading: true, preparing: true, activating: true,
  retrying: true, failed: true, blocked: true, partial: true, current: true,
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const int = (value: unknown): number | undefined =>
  (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined);
const instant = (value: unknown): string | undefined =>
  (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined);

/**
 * A nested playlist the user-facing copy may trust: nonempty id and a
 * positive safe-integer revision. Unknown or malformed nested objects yield
 * no version — never a hash fallback and never v0.
 */
function validPlaylist(value: unknown): ScreenManifestUpgradePlaylist | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = str(record.id);
  const revision = int(record.revision);
  if (!id || revision === undefined || revision < 1) return undefined;
  const name = typeof record.name === "string" ? playlistName(record.name) : null;
  return { id, name, revision };
}

/** Names are literal text: CR/LF/tab become spaces, then the first 48 characters. */
function playlistName(name: string): string {
  return name.replace(/[\r\n\t]+/g, " ").trim().slice(0, 48);
}

/** Display identity: the playlist name when known, else its id. */
function playlistLabel(playlist: ScreenManifestUpgradePlaylist): string {
  return playlist.name || playlist.id;
}

/**
 * The frozen user-facing detail shapes:
 * - same playlist id: `Target v42 · Playing v41`
 * - different ids: `Target {targetName} v42 · Playing {activeName} v41`
 * - no valid active: `Target v42`
 * - invalid or missing target: `Target: unknown version`, or
 *   `Target: none (no manifest assigned)` when the screen has none at all.
 */
function upgradeDetail(desired: unknown, active: unknown): string {
  const target = validPlaylist(desired);
  const playing = validPlaylist(active);
  if (target && playing && target.id === playing.id) {
    return `Target v${target.revision} · Playing v${playing.revision}`;
  }
  if (target && playing) {
    return `Target ${playlistLabel(target)} v${target.revision} · Playing ${playlistLabel(playing)} v${playing.revision}`;
  }
  if (target) return `Target v${target.revision}`;
  return "Target: unknown version";
}

/**
 * Why a screen may be stuck, per the backend's safe static failure codes.
 * Codes are server-declared and deliberately generic; an unknown but
 * syntax-valid token prints as it is, without an invented explanation.
 */
const UPGRADE_CODE_TEXT: Record<string, string> = {
  download_failed: "the candidate download failed",
  hash_mismatch: "the downloaded candidate did not match its hash",
  storage_full: "the screen's storage cannot hold the candidate",
  manifest_invalid: "the candidate manifest was rejected as invalid",
  prepare_failed: "the candidate could not be prepared on the display",
  activate_failed: "the swap to the candidate failed",
  anchor_unavailable: "a page anchor the manifest references is unavailable",
  transition_blocked: "the transition to the new revision is blocked",
  none_fit: "no candidate fits the screen's reported storage",
  staged: "the candidate is staged; the upgrade still needs its final step",
  capacity: "the candidate exceeds the screen's capacity",
  persist_failed: "the screen could not persist the activation",
  internal: "an internal error occurred",
  unsupported_content: "the manifest carries content this player cannot show",
};

/** The read model of one screen, when it is shaped as the contract promises. */
export function manifestUpgradeOf(screen: Screen | undefined): ScreenManifestUpgrade | undefined {
  const upgrade = (screen as { manifest_upgrade?: unknown } | undefined)?.manifest_upgrade;
  if (!upgrade || typeof upgrade !== "object") return undefined;
  const record = upgrade as Record<string, unknown>;
  if (typeof record.state !== "string" || !(record.state in UPGRADE_STATES)) return undefined;
  return upgrade as ScreenManifestUpgrade;
}

/**
 * The `Manifest upgrade` block `screen show --human` prints. The primary
 * lines carry the playlist versions (Target/Playing, names when the playlist
 * identities differ); the man_ revisions appear once as a diagnostics line.
 * A `retry_at` in the past is labelled `(overdue)`; lateness is not failure.
 * Absent parts are omitted, and a screen with no upgrade story prints nothing.
 */
export function manifestUpgradeLines(screen: Screen | undefined, now: Date): string[] {
  const upgrade = manifestUpgradeOf(screen);
  if (!upgrade) return [];
  const desired = str(upgrade.desired_revision);
  const active = str(upgrade.active_revision);
  const state = upgrade.state;
  if (state === "none" && !desired && !active) return [];

  const lines: string[] = ["Manifest upgrade"];
  const target = validPlaylist(upgrade.desired_playlist);
  const playing = validPlaylist(upgrade.active_playlist);
  lines.push(upgradeDetail(upgrade.desired_playlist, upgrade.active_playlist));
  if (target && playing && target.id === playing.id) lines.push(`playlist: ${playlistLabel(target)}`);
  if (!playing && !active) lines.push("Playing: none yet");
  const diagnostics = [
    desired ? `target ${desired}` : undefined,
    active ? `acknowledged ${active}` : undefined,
  ].filter((part): part is string => part !== undefined);
  if (diagnostics.length) lines.push(`diagnostics: ${diagnostics.join(", ")}`);

  const since = instant(upgrade.state_since);
  lines.push(`state: ${state}${since ? ` (since ${since})` : ""}`);

  const code = str(upgrade.code);
  if (code) lines.push(`reason: ${code}${UPGRADE_CODE_TEXT[code] ? ` — ${UPGRADE_CODE_TEXT[code]}` : ""}`);
  const attempt = int(upgrade.attempt);
  if (attempt !== undefined) lines.push(`attempt: ${attempt}`);
  const retryAt = state === "retrying" ? instant(upgrade.retry_at) : undefined;
  if (retryAt) {
    const overdue = Date.parse(retryAt) < now.getTime();
    lines.push(`retry: ${retryAt}${overdue ? " (overdue)" : ""}`);
  }
  const missing = int(upgrade.missing_page_count);
  if (state === "partial" && missing !== undefined) lines.push(`missing pages: ${missing}`);
  const reported = instant(upgrade.reported_at);
  if (reported) lines.push(`last report: ${reported}`);
  else if (state === "pending") lines.push("no upgrade report yet");

  if (target && playing && (target.id !== playing.id || target.revision !== playing.revision)) {
    lines.push("Playing is the last activation the server confirmed; the display may still be showing it rather than the target, and it is not proof that every connected session shows it.");
  }
  if (state === "partial") {
    lines.push(missing !== undefined
      ? `Partial: the target is on the display, but ${missing} whole page(s) of authored content are excluded.`
      : "Partial: the target is on the display, but not all authored content is eligible.");
  }
  if (state === "failed") {
    lines.push("No retry is scheduled. Fix the cause, then screen reload <id> or reassign the playlist.");
  }
  if (state === "retrying") {
    lines.push("A retry is scheduled; the player reports again after it. Offline is never reported as failure.");
  }
  if (state === "blocked") {
    lines.push("Storage could not stage the candidate; the acknowledged revision keeps playing.");
  }
  return lines;
}

/**
 * The compact `UPGRADE` cell for `screen list --human`: state, the frozen
 * Target/Playing version detail, the failure code, attempt, partial page
 * count, retry and report times. Only screens with a story get a cell;
 * `state: none` stays empty so plain fleets keep their table. The cell never
 * carries the man_ hashes.
 */
export function manifestUpgradeCell(screen: Screen | undefined, now: Date): string | undefined {
  const upgrade = manifestUpgradeOf(screen);
  if (!upgrade || upgrade.state === "none") return undefined;
  const parts: string[] = [upgrade.state];
  const desired = str(upgrade.desired_revision);
  const target = validPlaylist(upgrade.desired_playlist);
  parts.push(target ? upgradeDetail(upgrade.desired_playlist, upgrade.active_playlist)
    : desired ? "Target unknown version" : "Target none yet");
  const code = str(upgrade.code);
  if (code) parts.push(code);
  const attempt = int(upgrade.attempt);
  if (attempt !== undefined) parts.push(`attempt ${attempt}`);
  const missing = int(upgrade.missing_page_count);
  if (missing !== undefined) parts.push(`${missing} pages`);
  const retryAt = instant(upgrade.retry_at);
  if (retryAt) {
    parts.push(`retry ${retryAt}`);
    if (upgrade.state === "retrying" && Date.parse(retryAt) < now.getTime()) parts.push("overdue");
  }
  const reported = instant(upgrade.reported_at);
  if (reported) parts.push(`reported ${reported}`);
  else if (upgrade.state === "pending") parts.push("no report yet");
  return parts.join(" ");
}

/** Whether any listed screen has something to show in the UPGRADE column. */
export function anyManifestUpgrade(items: Screen[], now: Date): boolean {
  return items.some((screen) => manifestUpgradeCell(screen, now) !== undefined);
}
