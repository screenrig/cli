import type { PlaylistWallFormat, ScreenWall, ScreenWallArrangement, ScreenWallRotation } from "./adapters/protocol.js";
import { CliError, usageError } from "./problems.js";

/**
 * Video walls and rotation (backend docs/player-compatibility.md §6.8): one
 * Player drives one to twelve outputs. Two or more are one canvas (a video
 * wall); one output is a single screen turned by rotation. Local checks mirror
 * ScreenWall; the server stays authoritative, including whether the Player can
 * lay out a wall (display.wall) or rotate one screen (display.rotate) and what
 * the plan includes.
 */
export const WALL_ARRANGEMENTS: readonly ScreenWallArrangement[] = ["row", "column", "grid"];
export const WALL_ROTATIONS: readonly string[] = ["0", "90", "180", "270"];
const MAX_OUTPUTS = 12;

/** ScreenWall.outputs items: the Player's own output names (observation surface ids). */
const OUTPUT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** A comma-separated list of 1 to 12 unique output names, in physical order. */
export function wallOutputs(value: string, flag = "--outputs"): string[] {
  const names = value.split(",").map((name) => name.trim());
  if (names.length < 1 || names.length > MAX_OUTPUTS) {
    throw usageError(`${flag} takes 1 to ${MAX_OUTPUTS} comma-separated output names in physical order, left to right then top to bottom, for example ${flag} HDMI-A-1,HDMI-A-2 (one name rotates a single screen).`);
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
 * The ScreenWall the flags describe; arrangement is row when it was not given and rotation is left out when it
 * was not given (the server default is 0). One output is a single rotated screen: it takes no other arrangement
 * than row and no columns. For two or more outputs, columns is sent when given and the server decides where it
 * belongs: a grid needs it, a row or column refuses it.
 */
export function wallFromFlags(outputs: string, arrangement: string | undefined, rotation: string | undefined, columns?: string): ScreenWall {
  if (arrangement !== undefined && !WALL_ARRANGEMENTS.includes(arrangement as ScreenWallArrangement)) throw usageError("--arrangement must be row, column, or grid.");
  if (rotation !== undefined && !WALL_ROTATIONS.includes(rotation)) throw usageError("--rotation must be 0, 90, 180, or 270.");
  const names = wallOutputs(outputs);
  if (names.length === 1) {
    if (arrangement !== undefined && arrangement !== "row") throw usageError(`--arrangement ${arrangement} needs two or more outputs; one output rotates a single screen, so leave --arrangement out or use row.`);
    if (columns !== undefined) throw usageError("--columns is only for a grid of two or more outputs; one output rotates a single screen.");
  }
  return {
    outputs: names,
    arrangement: (arrangement ?? "row") as ScreenWallArrangement,
    ...(columns === undefined ? {} : { columns: Number(columns) }),
    ...(rotation === undefined ? {} : { rotation: Number(rotation) as ScreenWallRotation }),
  };
}

export function wallLine(wall: ScreenWall): string {
  if (wall.outputs.length === 1) return `${wall.outputs[0]} (single screen, rotation ${wall.rotation ?? 0})`;
  const shape = wall.arrangement === "grid" && wall.columns !== undefined ? `grid, ${wall.columns} columns` : wall.arrangement;
  return `${wall.outputs.join(", ")} (${shape}, rotation ${wall.rotation ?? 0})`;
}

/** The wall's canvas and the playlist format that is authored for it; a single rotated screen has a canvas and no format. */
export interface WallCanvas { width: number; height: number; format?: PlaylistWallFormat }

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

/**
 * The canvas of a screen's wall and the format authored for it. Undefined when the screen has no wall. One output
 * is a rotated single screen: a 1920 x 1080 canvas, 1080 x 1920 at 90 or 270, and never a wall format (a format
 * has two to twelve displays and answers wall_format_mismatch on a one-output wall).
 */
export function wallCanvas(screen: unknown): WallCanvas | undefined {
  const wall = (screen as { wall?: unknown } | null | undefined)?.wall;
  if (wall === undefined || wall === null) return undefined;
  const { outputs, arrangement, rotation, columns } = wall as Partial<ScreenWall>;
  const count = Array.isArray(outputs) ? outputs.length : 0;
  const grid = arrangement === "grid";
  if (count < 1 || count > MAX_OUTPUTS || !WALL_ARRANGEMENTS.includes(arrangement as ScreenWallArrangement)
    || (grid && !(Number.isInteger(columns) && columns! >= 2 && count % columns! === 0 && count / columns! >= 2))
    || (rotation !== undefined && ![0, 90, 180, 270].includes(rotation))) {
    throw usageError("Screen response has an invalid video wall.");
  }
  const portrait = rotation === 90 || rotation === 270;
  if (count === 1) return wallSize(1, "row", portrait);
  return {
    ...wallSize(count, arrangement as ScreenWallArrangement, portrait, columns),
    format: { displays: count, arrangement: arrangement as ScreenWallArrangement, orientation: portrait ? "portrait" : "landscape", ...(grid ? { columns } : {}) },
  };
}

/** 409 wall_unsupported, explained: two or more outputs need display.wall, one rotated output display.rotate. */
export function wallProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next || error.problem.code !== "wall_unsupported") return error;
  return new CliError({
    ...error.problem,
    detail: `${error.problem.detail} Nothing was changed. A video wall of two or more displays needs the Linux Player's kiosk install (cage and wlr-randr) or the Windows Player, which declare the display.wall capability, and one rotated screen needs the Linux Player's kiosk install, which declares display.rotate. screen show lists host.capabilities; this screen's Player did not declare the one this layout needs.`,
    next: { command: `screenrig screen show ${id}`, reason: "Check host.capabilities for display.wall (two or more outputs) or display.rotate (one output) and observation.surfaces for the Player's output names." },
  }, error.exitCode, error.warnings);
}
