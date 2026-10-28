import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LiveFrames, LiveSession } from "./adapters/protocol.js";
import { CliError, makeProblem, unexpectedResponseError, usageError } from "./problems.js";
import { boundedSeconds } from "./screen-commands.js";
import { LIVE_DURATION_MAX_S, LIVE_POLL_MS, liveEndedError, liveProblem, liveSessionBody } from "./screen-live.js";
import { removeOnSignal, tempPathFor } from "./temp-file.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

/**
 * `screen live frame`: JPEG frames of what a screen plays, from the live
 * session's stream, for an agent with HTTPS and nothing else (backend
 * docs/player-compatibility.md section 6.10 and the frames routes of the
 * OpenAPI). The command starts the session, waits for the Player to publish,
 * asks for frames, then reads each new frame with `after` set to the previous
 * frame's ScreenRig-Captured-At so no frame comes twice. A frame is the video
 * as the Player's encoder sent it, scaled and lossy, about once a second: it
 * shows motion and what is on glass now; it is not a screenshot.
 */
export const LIVE_FRAME_DURATION_DEFAULT_S = 120;
export const LIVE_FRAME_LEASE_MARGIN_S = 30;
export const LIVE_FRAME_INTERVAL_DEFAULT_MS = 1_000;
export const LIVE_FRAME_INTERVAL_MAX_S = 300;
/** The relay delivers about one frame a second, so a frame costs at least this much lease. */
const LIVE_FRAME_MIN_STEP_MS = 1_000;
const LIVE_FRAME_STATES = new Set(["starting", "streaming", "silent"]);

/** `--interval`: the pause between two frames. 0 takes each frame as it arrives. */
export function liveFrameIntervalMs(value: string): number {
  const text = value.trim();
  if (/^0[smhd]?$/.test(text)) return 0;
  return boundedSeconds("--interval", text, 1, LIVE_FRAME_INTERVAL_MAX_S, "1s or 30s", "1s to 5m, or 0 to take each frame as it arrives") * 1000;
}

export function liveFrameIntervalOption(value: string): string {
  liveFrameIntervalMs(value);
  return value;
}

/**
 * The lease to ask for: the longer of --duration and the time the frames take
 * plus a margin. A run that needs a longer session than the server allows is
 * refused here, before the session is started.
 */
export function liveFrameLeaseSeconds(durationSeconds: number | undefined, count: number, intervalMs: number): number {
  const stepMs = Math.max(intervalMs, LIVE_FRAME_MIN_STEP_MS);
  const needed = Math.ceil((count * stepMs) / 1000) + LIVE_FRAME_LEASE_MARGIN_S;
  if (needed > LIVE_DURATION_MAX_S) {
    throw usageError(`--count ${count} at --interval ${Math.round(intervalMs / 1000)}s needs a live session of ${needed}s, longer than the ${LIVE_DURATION_MAX_S}s a session can last. Lower --count or --interval.`);
  }
  return Math.max(durationSeconds ?? LIVE_FRAME_DURATION_DEFAULT_S, needed);
}

export interface LiveFrameOutput {
  /** Where frames are written. */
  directory: string;
  /** Set for one frame saved to a named file. */
  file?: string;
}

/**
 * `--output`: a directory (existing, or spelled with a trailing slash) gets
 * frame-<captured_at>.jpg files; for one frame a file path names the frame.
 * Without it frames go to the working directory.
 */
export async function resolveFrameOutput(cwd: string, output: string | undefined, count: number): Promise<LiveFrameOutput> {
  if (output === undefined) return { directory: path.resolve(cwd) };
  const resolved = path.resolve(cwd, output);
  const spelledAsDirectory = output.endsWith("/") || output.endsWith("\\");
  let isDirectory = spelledAsDirectory;
  try {
    isDirectory = (await stat(resolved)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw usageError("Cannot read the --output path.");
  }
  if (isDirectory) return { directory: resolved };
  if (count > 1) throw usageError("--output must be a directory with --count above 1.");
  return { directory: path.dirname(resolved), file: resolved };
}

/** frame-<captured_at>.jpg, with the colons of the time spelled as hyphens so the name is valid everywhere. */
export function liveFrameFileName(capturedAt: string): string {
  return `frame-${capturedAt.replaceAll(":", "-")}.jpg`;
}

export interface SavedLiveFrame {
  path: string;
  captured_at: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface LiveFramesResult {
  screen_id: string;
  live_id: string;
  frames: SavedLiveFrame[];
  /** True only when --stop ended the session. */
  stopped?: true;
}

/** The adapter a frames route answered; anything else is not the generated LiveFrames contract. */
export function liveFramesBody(body: unknown): LiveFrames | undefined {
  if (!body || typeof body !== "object") return undefined;
  const view = body as Partial<LiveFrames>;
  if (typeof view.live_id !== "string" || typeof view.state !== "string" || !LIVE_FRAME_STATES.has(view.state)) return undefined;
  return view as LiveFrames;
}

export interface LiveFrameBytes {
  live_id: string;
  captured_at: string;
  width: number;
  height: number;
  jpeg: Uint8Array;
  sha256: string;
}

/**
 * One frame from the route's answer, checked against its own headers: a JPEG,
 * with the time, size and ETag (the SHA-256 of the bytes) it says. A frame that
 * does not match is an unexpected response, never saved.
 */
export function readLiveFrame(response: TransportResponse): LiveFrameBytes {
  const jpeg = response.body;
  const contentType = response.headers["content-type"] ?? "";
  if (!(jpeg instanceof Uint8Array) || !contentType.toLowerCase().startsWith("image/jpeg") || jpeg.byteLength < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw unexpectedResponseError("Live frame response is not a JPEG image.");
  }
  const capturedAt = response.headers["screenrig-captured-at"];
  const width = Number(response.headers["screenrig-frame-width"]);
  const height = Number(response.headers["screenrig-frame-height"]);
  const liveId = response.headers["screenrig-live-id"];
  if (capturedAt === undefined || !Number.isFinite(Date.parse(capturedAt)) || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || !liveId) {
    throw unexpectedResponseError("Live frame response does not carry ScreenRig-Captured-At, ScreenRig-Frame-Width, ScreenRig-Frame-Height and ScreenRig-Live-Id.");
  }
  const sha256 = createHash("sha256").update(jpeg).digest("hex");
  const etag = response.headers.etag?.replace(/^W\//, "").replaceAll('"', "");
  if (etag !== undefined && etag !== sha256) {
    throw unexpectedResponseError("Live frame download did not match its ETag.");
  }
  return { live_id: liveId, captured_at: capturedAt, width, height, jpeg, sha256 };
}

/** Write one frame atomically beside its final name. */
async function writeFrame(file: string, jpeg: Uint8Array): Promise<void> {
  const temp = tempPathFor(file);
  const release = removeOnSignal(temp);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temp, jpeg, { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true });
    throw usageError("Cannot write the frame to the output path.");
  } finally {
    release();
  }
}

/** Guidance on the refusals a frames call can meet; the live view ones are liveProblem's. */
export function liveFrameProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  const guided = (next: { command: string; reason: string }): CliError => new CliError({ ...error.problem, next }, error.exitCode, error.warnings);
  switch (error.problem.code) {
    case "feature_unavailable":
      return guided({ command: `screenrig screen screenshot ${id}`, reason: "Live frames are not available on this server. A screenshot shows what the screen plays." });
    case "live_unavailable":
      return guided({ command: `screenrig screen live status ${id}`, reason: "Read why the live session ended or went silent, then start it again. A screenshot shows the screen meanwhile." });
    default:
      return liveProblem(error, id);
  }
}

/** live_not_ready for a run that gave up waiting. */
function notReady(detail: string, id: string): CliError {
  return new CliError(makeProblem("live_not_ready", "The screen is not publishing yet", 409, detail, {
    next: { command: `screenrig screen live status ${id}`, reason: "Read the session, and retry when the Player is publishing." },
  }));
}

export interface LiveFramePlan {
  screenId: string;
  count: number;
  intervalMs: number;
  /** The lease to ask for, in seconds (liveFrameLeaseSeconds). */
  leaseSeconds: number;
  /** How long to wait for the Player to publish and for each frame; 0 tries once. */
  waitMs: number;
  stop: boolean;
  output: LiveFrameOutput;
}

export interface LiveFrameApi {
  call(request: Omit<TransportRequest, "headers"> & { headers?: Record<string, string> }): Promise<TransportResponse>;
}

export interface LiveFrameClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Start the screen's live session, wait for it to publish, start frames, and
 * save `count` new frames, `interval` apart. The session is left to its lease
 * unless the plan stops it, and a plan that stops it does so on failure too.
 */
export async function captureLiveFrames(plan: LiveFramePlan, api: LiveFrameApi, clock: LiveFrameClock): Promise<LiveFramesResult> {
  const id = plan.screenId;
  const base = `/api/screens/${encodeURIComponent(id)}`;
  const frames: SavedLiveFrame[] = [];
  let liveId = "";
  let failure: unknown;
  try {
    liveId = await publishing(plan, api, clock, `${base}/live`);
    await startFrames(plan, api, clock, `${base}/live/frames`);
    let after: string | undefined;
    for (let index = 0; index < plan.count; index += 1) {
      if (index > 0 && plan.intervalMs > 0) await clock.sleep(plan.intervalMs);
      const frame = await nextFrame(plan, api, clock, base, after);
      liveId = frame.live_id;
      const file = plan.output.file ?? path.join(plan.output.directory, liveFrameFileName(frame.captured_at));
      await writeFrame(file, frame.jpeg);
      frames.push({ path: file, captured_at: frame.captured_at, width: frame.width, height: frame.height, bytes: frame.jpeg.byteLength, sha256: frame.sha256 });
      after = frame.captured_at;
    }
  } catch (error) {
    failure = error;
  }
  let stopped = false;
  if (plan.stop) {
    try {
      await api.call({ method: "DELETE", path: `${base}/live` });
      stopped = true;
    } catch (error) {
      // The run's own failure is the one to report.
      failure ??= liveProblem(error, id);
    }
  }
  if (failure !== undefined) throw failure;
  return { screen_id: id, live_id: liveId, frames, ...(stopped ? { stopped: true as const } : {}) };
}

/** POST the session and read it every second until the relay holds the Player's video. Returns the live_id. */
async function publishing(plan: LiveFramePlan, api: LiveFrameApi, clock: LiveFrameClock, route: string): Promise<string> {
  let session: LiveSession | undefined;
  try {
    const started = await api.call({ method: "POST", path: route, body: { duration_s: plan.leaseSeconds } });
    session = liveSessionBody(started.body);
    if (!session) throw unexpectedResponseError("Screen live start response does not match the generated LiveSession contract.");
  } catch (error) {
    throw liveFrameProblem(error, plan.screenId);
  }
  const deadline = clock.now() + plan.waitMs;
  while (session.state !== "publishing") {
    if (session.state === "ended" || session.state === "idle") throw liveEndedError(session);
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      throw notReady(`The Player has not started publishing${plan.waitMs > 0 ? ` within ${Math.round(plan.waitMs / 1000)}s` : ""}. On Android, someone at the screen allows screen capture once each time the Player starts.`, plan.screenId);
    }
    await clock.sleep(Math.min(LIVE_POLL_MS, remaining));
    try {
      const read = liveSessionBody((await api.call({ method: "GET", path: route })).body);
      if (!read) throw unexpectedResponseError("Screen live status response does not match the generated LiveSession contract.");
      session = read;
    } catch (error) {
      throw liveFrameProblem(error, plan.screenId);
    }
  }
  if (!session.live_id) throw unexpectedResponseError("Screen live status response has no live_id.");
  return session.live_id;
}

/** POST frames. A publisher that was replaced between the wait and this call answers live_not_ready; try again within the wait. */
async function startFrames(plan: LiveFramePlan, api: LiveFrameApi, clock: LiveFrameClock, route: string): Promise<void> {
  const deadline = clock.now() + plan.waitMs;
  while (true) {
    try {
      const response = await api.call({ method: "POST", path: route });
      if (!liveFramesBody(response.body)) throw unexpectedResponseError("Screen live frames response does not match the generated LiveFrames contract.");
      return;
    } catch (error) {
      if (error instanceof CliError && error.problem.code === "live_not_ready" && clock.now() < deadline) {
        await clock.sleep(Math.min(LIVE_POLL_MS, deadline - clock.now()));
        continue;
      }
      throw liveFrameProblem(error, plan.screenId);
    }
  }
}

/**
 * The first frame captured after `after` (any frame without it). The server
 * waits a few seconds per call and answers live_not_ready when none came: ask
 * again until --wait is spent. resource_conflict means frames were not started
 * (the Player reconnected, which ends the frames of its old connection): start
 * them again.
 */
async function nextFrame(plan: LiveFramePlan, api: LiveFrameApi, clock: LiveFrameClock, base: string, after: string | undefined): Promise<LiveFrameBytes> {
  const deadline = clock.now() + plan.waitMs;
  while (true) {
    try {
      const response = await api.call({
        method: "GET",
        path: `${base}/live/frame`,
        ...(after === undefined ? {} : { query: { after } }),
        headers: { accept: "image/jpeg" },
        binary: true,
      });
      return readLiveFrame(response);
    } catch (error) {
      const code = error instanceof CliError ? error.problem.code : undefined;
      if (code !== "live_not_ready" && code !== "resource_conflict") throw liveFrameProblem(error, plan.screenId);
      if (clock.now() >= deadline) {
        throw notReady(`No new frame arrived${plan.waitMs > 0 ? ` within ${Math.round(plan.waitMs / 1000)}s` : ""}.`, plan.screenId);
      }
      await clock.sleep(Math.min(LIVE_POLL_MS, Math.max(deadline - clock.now(), 1)));
      if (code === "resource_conflict") await startFrames(plan, api, clock, `${base}/live/frames`);
    }
  }
}

export function liveFramesHumanLines(result: LiveFramesResult): string {
  const lines = [`Saved ${result.frames.length} live frame${result.frames.length === 1 ? "" : "s"} of ${result.screen_id}`, `live_id: ${result.live_id}`];
  for (const frame of result.frames) lines.push(`${frame.path}  ${frame.width}x${frame.height}  ${frame.bytes} bytes  ${frame.captured_at}`);
  lines.push(result.stopped ? "The live session was stopped." : "The live session ends by itself when its lease runs out; screen live stop ends it now.");
  return lines.join("\n");
}
