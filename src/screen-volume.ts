import type { ScreenVolume, ScreenVolumeWrite } from "./adapters/protocol.js";
import { CliError, usageError } from "./problems.js";

/**
 * Screen volume (backend docs/player-compatibility.md §6.5): a level 0 to 100
 * and a mute, set remotely on a Player that declares the volume capability.
 * Local checks mirror ScreenVolumeWrite; the server stays authoritative.
 */
export const VOLUME_LEVEL_MAX = 100;

/** --level: a whole number from 0 to 100. */
export function volumeLevel(value: string): number {
  const text = value.trim();
  const level = /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(level) || level > VOLUME_LEVEL_MAX) {
    throw usageError(`--level takes a whole number from 0 to ${VOLUME_LEVEL_MAX}.`);
  }
  return level;
}

/** Commander parser: validate now, keep the string for the handler. */
export function volumeLevelOption(value: string): string {
  volumeLevel(value);
  return value;
}

/** The ScreenVolumeWrite the flags describe; at least one of --level, --mute and --unmute. */
export function volumeWrite(level: string | undefined, mute: boolean, unmute: boolean): ScreenVolumeWrite {
  if (mute && unmute) throw usageError("Use --mute or --unmute, not both.");
  const write: ScreenVolumeWrite = {};
  if (level !== undefined) write.level = volumeLevel(level);
  if (mute) write.muted = true;
  else if (unmute) write.muted = false;
  if (write.level === undefined && write.muted === undefined) {
    throw usageError("screen volume requires --level 0-100, --mute or --unmute.");
  }
  return write;
}

/** `level 40, muted`: the members a request carries; one it left out keeps the Player's value. */
export function volumeText(volume: { level?: number; muted?: boolean }): string {
  return [
    typeof volume.level === "number" ? `level ${volume.level}` : undefined,
    volume.muted === true ? "muted" : volume.muted === false ? "unmuted" : undefined,
  ].filter(Boolean).join(", ");
}

/** `Volume:` lines for screen show --human and screen volume; nothing when the screen has no volume state. */
export function volumeLines(volume: ScreenVolume | undefined): string[] {
  if (!volume || typeof volume !== "object") return [];
  const lines: string[] = [];
  const requested = volume.requested;
  if (requested && typeof requested === "object" && typeof requested.volume_id === "string") {
    const text = volumeText(requested);
    lines.push(`Volume requested: ${text || "no change"}${typeof requested.set_at === "string" ? ` (set ${requested.set_at})` : ""}`);
  }
  const reported = volume.reported;
  if (reported && typeof reported === "object" && typeof reported.reported_at === "string") {
    const parts = [
      volumeText(reported),
      reported.hardware === true ? "device volume" : reported.hardware === false ? "Player volume" : undefined,
    ].filter(Boolean).join(", ");
    lines.push(`Volume reported: ${parts || "no volume"} at ${reported.reported_at}${reported.stale ? " (stale: no report for over 35 minutes)" : ""}`);
  }
  return lines;
}

/**
 * Volume refusals. 409 volume_unsupported: the Player must declare the volume
 * capability, and nothing is recorded. A screen still waiting to pair has no
 * Player; an archived one must be unarchived.
 */
export function volumeProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code === "volume_unsupported") {
    return new CliError({
      ...error.problem,
      detail: `${error.problem.detail} Nothing was sent: only a Player that declares the volume capability applies a remote volume.`,
      next: { command: `screenrig screen show ${id}`, reason: "Check host.capabilities for volume. Update the Player and run the command again, or set the volume in the Player's settings menu." },
    }, error.exitCode, error.warnings);
  }
  if (error.problem.code === "resource_conflict") {
    return new CliError({
      ...error.problem,
      next: { command: `screenrig screen show ${id}`, reason: "This screen has no paired Player yet, so there is no volume to set. Pair it first." },
    }, error.exitCode, error.warnings);
  }
  if (error.problem.code === "screen_archived") {
    return new CliError({
      ...error.problem,
      next: { command: `screenrig screen unarchive ${id}`, reason: "An archived screen refuses volume control. Unarchive it first." },
    }, error.exitCode, error.warnings);
  }
  return error;
}
