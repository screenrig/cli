import type { LiveSession } from "./adapters/protocol.js";
import type { Warning } from "./envelope.js";
import { isResourceID } from "./generated/resource-ids.js";
import { CliError, makeProblem, usageError } from "./problems.js";
import { boundedSeconds } from "./screen-commands.js";

/**
 * Live view of a screen (backend docs/player-compatibility.md section 6.10):
 * `screen live start|status|stop`. Local checks mirror LiveStartRequest so a bad
 * value fails before any request; the server stays authoritative. The CLI only
 * starts, reads and stops the session and prints the dashboard page that shows
 * it: the video itself is watched there.
 */
export const LIVE_DURATION_MIN_S = 30;
export const LIVE_DURATION_MAX_S = 300;
export const LIVE_WAIT_DEFAULT_MS = 30_000;
export const LIVE_WAIT_MAX_MS = 600_000;
export const LIVE_POLL_MS = 1_000;

const LIVE_STATES = new Set(["idle", "requested", "publishing", "ended"]);

export function liveScreenId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`screen live ${command} requires <id>.`);
  if (!isResourceID(value, "screen")) {
    throw usageError("A screen id looks like scr_ followed by letters, digits, - or _.", {
      command: "screenrig screen list",
      reason: "List this project's screens and their ids.",
    });
  }
  return value;
}

/** `--duration` of screen live start, as duration_s (30 to 300): a session lasts five minutes at most. */
export function liveDurationSeconds(value: string): number {
  return boundedSeconds("--duration", value, LIVE_DURATION_MIN_S, LIVE_DURATION_MAX_S, "90s or 5m", "30s to 5m");
}

export function liveDurationOption(value: string): string {
  liveDurationSeconds(value);
  return value;
}

/** `--wait` of screen live start, in milliseconds: 0 returns at once, otherwise up to 10m. */
export function liveWaitMs(value: string): number {
  const text = value.trim();
  if (/^0[smhd]?$/.test(text)) return 0;
  return boundedSeconds("--wait", text, 1, LIVE_WAIT_MAX_MS / 1000, "30s or 1m", "1s to 10m, or 0 to return at once") * 1000;
}

export function liveWaitOption(value: string): string {
  liveWaitMs(value);
  return value;
}

/** The session a live route answered; anything else is not the generated LiveSession contract. */
export function liveSessionBody(body: unknown): LiveSession | undefined {
  if (!body || typeof body !== "object") return undefined;
  const session = body as Partial<LiveSession>;
  if (typeof session.state !== "string" || !LIVE_STATES.has(session.state) || typeof session.screen_id !== "string" || typeof session.viewer_url !== "string") return undefined;
  return session as LiveSession;
}

/** Nothing more to wait for: the Player reported connected, or there is no session to wait on. */
export function liveSettled(session: LiveSession): boolean {
  return session.publisher?.connected === true || session.state === "ended" || session.state === "idle";
}

export interface LiveWaitOptions {
  waitMs: number;
  pollMs?: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Read the session every second until the Player reports connected, the session
 * ends, or the wait is over. The last session read is the answer: a session
 * still requested at the end is a warning, not a failure.
 */
export async function settleLive(first: LiveSession, read: () => Promise<LiveSession>, options: LiveWaitOptions): Promise<LiveSession> {
  const pollMs = options.pollMs ?? LIVE_POLL_MS;
  const deadline = options.now() + options.waitMs;
  let session = first;
  while (!liveSettled(session)) {
    const remaining = deadline - options.now();
    if (remaining <= 0) break;
    await options.sleep(Math.min(pollMs, remaining));
    session = await read();
  }
  return session;
}

const ENDED_SENTENCES: Record<string, string> = {
  stopped: "The session was stopped.",
  expired: "Nobody renewed the session, or it reached its five minutes.",
  consent_denied: "Someone at the screen declined to allow screen capture.",
  consent_timeout: "Nobody at the screen allowed screen capture in time. On Android, someone at the screen allows capture once each time the Player starts.",
  capture_failed: "The Player could not capture or encode the screen.",
  connection_failed: "The Player could not connect to the media relay.",
  player_stopped: "The Player stopped publishing.",
};

/** live_unavailable for a session that ended (or vanished) while the command waited for it. */
export function liveEndedError(session: LiveSession): CliError {
  const reason = session.ended_reason;
  const detail = session.state === "ended"
    ? `The live session ended${reason ? ` (ended_reason ${reason})` : ""}. ${(reason && ENDED_SENTENCES[reason]) ?? "The Player stopped publishing."}`
    : "The live session is gone.";
  return new CliError(makeProblem("live_unavailable", "Live view is not available for this screen", 409, detail, {
    next: { command: `screenrig screen live start ${session.screen_id}`, reason: "Start live view again; use screen screenshot for a still meanwhile." },
  }));
}

/** The warning for a start that returned before the Player connected. */
export function liveNotReadyWarning(session: LiveSession): Warning {
  return {
    code: "live_not_ready",
    message: session.state === "requested"
      ? "The Player has not started publishing yet. On Android, someone at the screen allows screen capture once each time the Player starts. Read screen live status again, or open viewer_url."
      : "The Player is publishing but has not reported connected yet. Read screen live status again, or open viewer_url.",
  };
}

/** Guidance on the refusals a start can meet. */
export function liveProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  const guided = (next: { command: string; reason: string }, detail?: string): CliError =>
    new CliError({ ...error.problem, ...(detail === undefined ? {} : { detail }), next }, error.exitCode, error.warnings);
  switch (error.problem.code) {
    case "live_unsupported":
      return guided({ command: `screenrig screen screenshot ${id}`, reason: "This Player cannot publish live video. Update it to its current version; a screenshot shows the screen meanwhile." });
    case "live_unavailable":
      return guided({ command: `screenrig screen show ${id}`, reason: "Check the screen is online, then start live view again." });
    case "feature_unavailable":
      return guided({ command: `screenrig screen screenshot ${id}`, reason: "Live view is not configured on this server. A screenshot shows what the screen plays." });
    case "screen_archived":
      return guided({ command: `screenrig screen unarchive ${id}`, reason: "An archived screen shows nothing. Unarchive it first if it should play again." });
    default:
      return error;
  }
}

export function liveHumanLines(session: LiveSession): string {
  const lines = [`Live view of ${session.screen_id}: ${session.state}`];
  if (session.live_id) lines.push(`live_id: ${session.live_id}`);
  const publisher = session.publisher;
  if (publisher) {
    const size = publisher.width && publisher.height ? ` ${publisher.width}x${publisher.height}${publisher.fps ? ` at ${publisher.fps} fps` : ""}` : "";
    lines.push(`publisher: ${publisher.connected ? "connected" : publisher.connection}${size}`);
  }
  if (session.lease_until) lines.push(`lease_until: ${session.lease_until}`);
  if (session.max_until) lines.push(`max_until: ${session.max_until}`);
  if (session.ended_reason) lines.push(`ended_reason: ${session.ended_reason}`);
  if (session.state !== "ended" && session.state !== "idle") lines.push(`Watch it in the dashboard: ${session.viewer_url}`);
  return lines.join("\n");
}
