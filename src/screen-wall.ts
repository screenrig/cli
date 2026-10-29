import type { PlaylistFormat, ScreenWall, ScreenWallArrangement, ScreenWallRotation } from "./adapters/protocol.js";
import { CliError, usageError } from "./problems.js";

/**
 * Video walls (backend docs/player-compatibility.md §6.8): one Player drives
 * two to twelve outputs as one canvas. Local checks mirror ScreenWall; the
 * server stays authoritative, including whether the Player can lay out a wall.
 */
export const WALL_ARRANGEMENTS: readonly ScreenWallArrangement[] = ["row", "column", "grid"];
export const WALL_ROTATIONS: readonly string[] = ["0", "90", "180", "270"];
const MAX_OUTPUTS = 12;

/** ScreenWall.outputs items: the Player's own output names (observation surface ids). */
const OUTPUT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** A comma-separated list of 2 to 12 unique output names, in physical order. */
export function wallOutputs(value: string, flag = "--outputs"): string[] {
  const names = value.split(",").map((name) => name.trim());
  if (names.length < 2 || names.length > MAX_OUTPUTS) {
    throw usageError(`${flag} takes 2 to ${MAX_OUTPUTS} comma-separated output names in physical order, left to right then top to bottom, for example ${flag} HDMI-A-1,HDMI-A-2.`);
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

/**
 * The ScreenWall the flags describe; rotation is left out when it was not given (the server default is 0).
 * columns is sent when given and the server decides where it belongs: a grid needs it, a row or column refuses it.
 */
export function wallFromFlags(outputs: string, arrangement: string, rotation: string | undefined, columns?: string): ScreenWall {
  if (!WALL_ARRANGEMENTS.includes(arrangement as ScreenWallArrangement)) throw usageError("--arrangement must be row, column, or grid.");
  if (rotation !== undefined && !WALL_ROTATIONS.includes(rotation)) throw usageError("--rotation must be 0, 90, 180, or 270.");
  return {
    outputs: wallOutputs(outputs),
    arrangement: arrangement as ScreenWallArrangement,
    ...(columns === undefined ? {} : { columns: Number(columns) }),
    ...(rotation === undefined ? {} : { rotation: Number(rotation) as ScreenWallRotation }),
  };
}

export function wallLine(wall: ScreenWall): string {
  const shape = wall.arrangement === "grid" && wall.columns !== undefined ? `grid, ${wall.columns} columns` : wall.arrangement;
  return `${wall.outputs.join(", ")} (${shape}, rotation ${wall.rotation ?? 0})`;
}

/** The wall's canvas and the playlist format that is authored for it. */
export interface WallCanvas { width: number; height: number; format: PlaylistFormat }

/**
 * The canvas of displays tiles: a tile is 1920 x 1080 landscape or 1080 x 1920
 * portrait. A row is displays tiles wide, a column one tile wide, a grid
 * columns wide, and the rest of the displays fill the rows below.
 */
export function wallSize(displays: number, arrangement: ScreenWallArrangement, portrait: boolean, columns?: number): { width: number; height: number } {
  const [tileWidth, tileHeight] = portrait ? [1080, 1920] : [1920, 1080];
  const across = arrangement === "column" ? 1 : arrangement === "grid" ? columns! : displays;
  return { width: tileWidth * across, height: tileHeight * (displays / across) };
}

/** The canvas of a screen's wall and the format authored for it. Undefined when the screen has no wall. */
export function wallCanvas(screen: unknown): WallCanvas | undefined {
  const wall = (screen as { wall?: unknown } | null | undefined)?.wall;
  if (wall === undefined || wall === null) return undefined;
  const { outputs, arrangement, rotation, columns } = wall as Partial<ScreenWall>;
  const count = Array.isArray(outputs) ? outputs.length : 0;
  const grid = arrangement === "grid";
  if (count < 2 || count > MAX_OUTPUTS || !WALL_ARRANGEMENTS.includes(arrangement as ScreenWallArrangement)
    || (grid && !(Number.isInteger(columns) && columns! >= 2 && count % columns! === 0 && count / columns! >= 2))
    || (rotation !== undefined && ![0, 90, 180, 270].includes(rotation))) {
    throw usageError("Screen response has an invalid video wall.");
  }
  const portrait = rotation === 90 || rotation === 270;
  return {
    ...wallSize(count, arrangement as ScreenWallArrangement, portrait, columns),
    format: { displays: count, arrangement: arrangement as ScreenWallArrangement, orientation: portrait ? "portrait" : "landscape", ...(grid ? { columns } : {}) },
  };
}

/** 409 wall_unsupported, explained: the Player must declare the display.wall capability. */
export function wallProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next || error.problem.code !== "wall_unsupported") return error;
  return new CliError({
    ...error.problem,
    detail: `${error.problem.detail} Nothing was changed. A video wall needs the Linux Player's kiosk install (cage and wlr-randr) or the Windows Player, which declare the display.wall capability in their host report (screen show lists host.capabilities); this screen's Player did not.`,
    next: { command: `screenrig screen show ${id}`, reason: "Check host.capabilities for display.wall and observation.surfaces for the Player's output names." },
  }, error.exitCode, error.warnings);
}
