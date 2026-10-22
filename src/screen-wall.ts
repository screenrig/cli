import type { PlaylistFormat, ScreenWall, ScreenWallArrangement, ScreenWallRotation } from "./adapters/protocol.js";
import { CliError, usageError } from "./problems.js";

/**
 * Video walls (backend docs/player-compatibility.md §6.8): one Player drives
 * two or three outputs as one canvas. Local checks mirror ScreenWall; the
 * server stays authoritative, including whether the Player can lay out a wall.
 */
export const WALL_ARRANGEMENTS: readonly ScreenWallArrangement[] = ["row", "column"];
export const WALL_ROTATIONS: readonly string[] = ["0", "90", "180", "270"];

/** ScreenWall.outputs items: the Player's own output names (observation surface ids). */
const OUTPUT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** A comma-separated list of 2 or 3 unique output names, in physical order. */
export function wallOutputs(value: string, flag = "--outputs"): string[] {
  const names = value.split(",").map((name) => name.trim());
  if (names.length < 2 || names.length > 3) {
    throw usageError(`${flag} takes 2 or 3 comma-separated output names in physical order, for example ${flag} HDMI-A-1,HDMI-A-2.`);
  }
  if (names.some((name) => !OUTPUT_NAME.test(name))) {
    throw usageError(`${flag} names are 1 to 64 letters, digits, dots, underscores or dashes: the output names screen show lists as observation.surfaces[].id.`);
  }
  if (new Set(names).size !== names.length) throw usageError(`${flag} lists an output more than once.`);
  return names;
}

/** Commander parser: validate now, keep the string for the handler. */
export function wallOutputsOption(value: string): string {
  wallOutputs(value);
  return value;
}

/** The ScreenWall the flags describe; rotation is left out when it was not given (the server default is 0). */
export function wallFromFlags(outputs: string, arrangement: string, rotation: string | undefined): ScreenWall {
  if (!WALL_ARRANGEMENTS.includes(arrangement as ScreenWallArrangement)) throw usageError("--arrangement must be row or column.");
  if (rotation !== undefined && !WALL_ROTATIONS.includes(rotation)) throw usageError("--rotation must be 0, 90, 180, or 270.");
  return {
    outputs: wallOutputs(outputs),
    arrangement: arrangement as ScreenWallArrangement,
    ...(rotation === undefined ? {} : { rotation: Number(rotation) as ScreenWallRotation }),
  };
}

export function wallLine(wall: ScreenWall): string {
  return `${wall.outputs.join(", ")} (${wall.arrangement}, rotation ${wall.rotation ?? 0})`;
}

/** The wall's canvas and the playlist format that is authored for it. */
export interface WallCanvas { width: number; height: number; format: PlaylistFormat }

/**
 * The canvas of a wall: a tile is 1920 x 1080 landscape or 1080 x 1920
 * portrait (rotation 90 or 270), and a row is that many tiles wide, a column
 * that many tiles high. Undefined when the screen has no wall.
 */
export function wallCanvas(screen: unknown): WallCanvas | undefined {
  const wall = (screen as { wall?: unknown } | null | undefined)?.wall;
  if (wall === undefined || wall === null) return undefined;
  const { outputs, arrangement, rotation } = wall as Partial<ScreenWall>;
  const count = Array.isArray(outputs) ? outputs.length : 0;
  if ((count !== 2 && count !== 3) || !WALL_ARRANGEMENTS.includes(arrangement as ScreenWallArrangement)
    || (rotation !== undefined && ![0, 90, 180, 270].includes(rotation))) {
    throw usageError("Screen response has an invalid video wall.");
  }
  const portrait = rotation === 90 || rotation === 270;
  const [tileWidth, tileHeight] = portrait ? [1080, 1920] : [1920, 1080];
  const column = arrangement === "column";
  return {
    width: column ? tileWidth : tileWidth * count,
    height: column ? tileHeight * count : tileHeight,
    format: { displays: count as 2 | 3, arrangement: arrangement as ScreenWallArrangement, orientation: portrait ? "portrait" : "landscape" },
  };
}

/** 409 wall_unsupported, explained: the Player must declare the display.wall capability. */
export function wallProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next || error.problem.code !== "wall_unsupported") return error;
  return new CliError({
    ...error.problem,
    detail: `${error.problem.detail} Nothing was changed. A video wall needs the Linux Player kiosk install with wlr-randr, which declares the display.wall capability in its host report (screen show lists host.capabilities); this screen's Player did not.`,
    next: { command: `screenrig screen show ${id}`, reason: "Check host.capabilities for display.wall and observation.surfaces for the Player's output names." },
  }, error.exitCode, error.warnings);
}
