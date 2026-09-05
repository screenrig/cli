import { loggingRunProcess, loggerOf } from "../log/logger.js";
import { usageError } from "../problems.js";
import { redactText } from "../redact.js";
import type { CliRuntime, RunProcess, RunProcessResult } from "../runtime.js";

/** Resolved external media toolchain plus the capabilities the planner needs. */
export interface FfmpegToolchain {
  ffmpeg: string;
  ffprobe: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
  encoders: ReadonlySet<string>;
  filters: ReadonlySet<string>;
}

export interface FfmpegLookup {
  ffmpeg: string;
  ffprobe: string;
  ffmpegFromEnv: boolean;
  ffprobeFromEnv: boolean;
}

/** Resolved `cwebp` binary used when ffmpeg has no libwebp encoder. */
export interface CwebpToolchain {
  cwebp: string;
  version: string;
  fromEnv: boolean;
}

export interface CwebpLookup {
  cwebp: string;
  cwebpFromEnv: boolean;
}

const INSTALL_HINT =
  "Install ffmpeg 6.0 or newer and make ffmpeg and ffprobe reachable on PATH, " +
  "or set SCREENRIG_FFMPEG and SCREENRIG_FFPROBE to their absolute paths.";

const VERSION_TIMEOUT_MS = 15_000;

/** Where the CLI will look for the toolchain, without running anything. */
export function ffmpegLookup(env: NodeJS.Dict<string>): FfmpegLookup {
  const ffmpegEnv = trimmed(env.SCREENRIG_FFMPEG);
  const ffprobeEnv = trimmed(env.SCREENRIG_FFPROBE);
  return {
    ffmpeg: ffmpegEnv ?? "ffmpeg",
    ffprobe: ffprobeEnv ?? "ffprobe",
    ffmpegFromEnv: ffmpegEnv !== undefined,
    ffprobeFromEnv: ffprobeEnv !== undefined,
  };
}

/** Where the CLI will look for `cwebp`, without running anything. */
export function cwebpLookup(env: NodeJS.Dict<string>): CwebpLookup {
  const cwebpEnv = trimmed(env.SCREENRIG_CWEBP);
  return {
    cwebp: cwebpEnv ?? "cwebp",
    cwebpFromEnv: cwebpEnv !== undefined,
  };
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

/** First dotted version token in `cwebp -version` output, else `unknown`. */
export function parseCwebpVersion(output: string): string {
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(output);
  return match?.[1] ?? "unknown";
}

export function runProcessFor(runtime: CliRuntime): RunProcess {
  const run = runtime.runProcess;
  if (!run) {
    throw usageError("This runtime cannot start the ffmpeg toolchain.");
  }
  return loggingRunProcess(run, loggerOf(runtime));
}

function missingToolError(binary: string, result: RunProcessResult): never {
  const reason = result.spawnError
    ? redactText(result.spawnError)
    : result.timedOut
      ? "the version probe timed out"
      : `it exited with status ${result.code ?? "unknown"}`;
  throw usageError(`Cannot run ${binary}: ${reason}. ${INSTALL_HINT}`, {
    command: "screenrig doctor",
    reason: "Report which part of the required ffmpeg toolchain is missing or unusable.",
  });
}

function parseVersion(output: string): string {
  const match = /^ff(?:mpeg|probe) version (\S+)/m.exec(output);
  return match?.[1] ?? "unknown";
}

/** Rows look like " V....D libx265   libx265 H.265 / HEVC (codec hevc)". */
export function parseEncoderNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^\s[A-Za-z.]{6}\s+([A-Za-z0-9_.-]+)\s+\S/.exec(line);
    const name = match?.[1];
    if (name && name !== "=") {
      names.add(name);
    }
  }
  return names;
}

/**
 * Rows look like " .S zscale   V->V   Apply resizing...". The flag column width
 * has changed between ffmpeg releases, so the stable anchor is the "V->V"
 * signature rather than a fixed number of leading flag characters.
 */
export function parseFilterNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^\s*\S{2,4}\s+([A-Za-z0-9_]+)\s+[AVN|]+(?:->|→)[AVN|]+/.exec(line);
    const name = match?.[1];
    if (name) {
      names.add(name);
    }
  }
  return names;
}

let cached: Promise<FfmpegToolchain> | undefined;
let cwebpCached: Promise<CwebpToolchain | undefined> | undefined;

/** Test seam: forget the memoized ffmpeg and cwebp probes. */
export function resetFfmpegToolchainCache(): void {
  cached = undefined;
  cwebpCached = undefined;
}

export async function resolveFfmpegToolchain(runtime: CliRuntime): Promise<FfmpegToolchain> {
  cached ??= probeToolchain(runtime);
  try {
    return await cached;
  } catch (error) {
    cached = undefined;
    throw error;
  }
}

async function probeToolchain(runtime: CliRuntime): Promise<FfmpegToolchain> {
  const run = runProcessFor(runtime);
  const lookup = ffmpegLookup(runtime.env);

  const ffmpegVersionResult = await run({
    command: lookup.ffmpeg,
    args: ["-hide_banner", "-version"],
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (ffmpegVersionResult.spawnError || ffmpegVersionResult.code !== 0) {
    missingToolError(lookup.ffmpeg, ffmpegVersionResult);
  }

  const ffprobeVersionResult = await run({
    command: lookup.ffprobe,
    args: ["-hide_banner", "-version"],
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (ffprobeVersionResult.spawnError || ffprobeVersionResult.code !== 0) {
    missingToolError(lookup.ffprobe, ffprobeVersionResult);
  }

  // A build that answered -version but cannot list its own capabilities is
  // unusable. Failing here keeps the diagnosis honest, because an empty
  // capability set would otherwise be reported as "no libx265 encoder".
  const encodersResult = await run({
    command: lookup.ffmpeg,
    args: ["-hide_banner", "-encoders"],
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (encodersResult.spawnError || encodersResult.code !== 0) {
    missingToolError(lookup.ffmpeg, encodersResult);
  }
  const filtersResult = await run({
    command: lookup.ffmpeg,
    args: ["-hide_banner", "-filters"],
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (filtersResult.spawnError || filtersResult.code !== 0) {
    missingToolError(lookup.ffmpeg, filtersResult);
  }

  return {
    ffmpeg: lookup.ffmpeg,
    ffprobe: lookup.ffprobe,
    ffmpegVersion: parseVersion(ffmpegVersionResult.stdout),
    ffprobeVersion: parseVersion(ffprobeVersionResult.stdout),
    encoders: parseEncoderNames(encodersResult.stdout),
    filters: parseFilterNames(filtersResult.stdout),
  };
}

/**
 * Probe `cwebp` the same way ffmpeg is probed. A missing binary is `undefined`,
 * not an exception, so the image planner can name both missing pieces together.
 */
export async function resolveCwebpToolchain(runtime: CliRuntime): Promise<CwebpToolchain | undefined> {
  cwebpCached ??= probeCwebp(runtime);
  try {
    return await cwebpCached;
  } catch (error) {
    cwebpCached = undefined;
    throw error;
  }
}

async function probeCwebp(runtime: CliRuntime): Promise<CwebpToolchain | undefined> {
  const run = runProcessFor(runtime);
  const lookup = cwebpLookup(runtime.env);
  const result = await run({
    command: lookup.cwebp,
    args: ["-version"],
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (result.spawnError || result.code !== 0 || result.timedOut) {
    return undefined;
  }
  const version = parseCwebpVersion(`${result.stdout}\n${result.stderrTail}`);
  return {
    cwebp: lookup.cwebp,
    version,
    fromEnv: lookup.cwebpFromEnv,
  };
}

/** The single video stream and container facts the transcode planner uses. */
export interface MediaProbe {
  hasVideo: boolean;
  hasAudio: boolean;
  codec: string;
  codecTag: string;
  profile: string;
  level: number;
  fieldOrder: string;
  colorRange: string;
  videoStreams: number;
  audioStreams: number;
  audioCodec: string;
  audioSampleRate: number;
  audioChannels: number;
  formatNames: readonly string[];
  pixelFormat: string;
  /** Coded dimensions, before any display-matrix rotation. */
  codedWidth: number;
  codedHeight: number;
  /** Dimensions after display-matrix rotation, which is what ffmpeg filters see. */
  displayWidth: number;
  displayHeight: number;
  rotationDegrees: number;
  fps: number;
  frameCount: number;
  durationSeconds: number;
  colorTransfer: string;
  colorPrimaries: string;
  colorSpace: string;
  hasAlpha: boolean;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  profile?: string;
  level?: number;
  field_order?: string;
  color_range?: string;
  sample_rate?: string;
  channels?: number;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbePayload {
  streams?: ProbeStream[];
  format?: { duration?: string; format_name?: string };
}

const ALPHA_PIXEL_MARKERS = ["rgba", "bgra", "argb", "abgr", "yuva", "gbrap", "pal8"] as const;

export function pixelFormatHasAlpha(pixelFormat: string): boolean {
  if (pixelFormat.length === 0) {
    return false;
  }
  if (/^ya\d/.test(pixelFormat)) {
    return true;
  }
  return ALPHA_PIXEL_MARKERS.some((marker) => pixelFormat.includes(marker));
}

export function parseProbePayload(raw: string): MediaProbe {
  let payload: ProbePayload;
  try {
    payload = JSON.parse(raw) as ProbePayload;
  } catch {
    throw usageError("ffprobe returned output the CLI could not parse.");
  }
  const streams = payload.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");

  const codedWidth = video?.width ?? 0;
  const codedHeight = video?.height ?? 0;
  const rotationDegrees = normalizeRotation(video);
  const swapped = rotationDegrees === 90 || rotationDegrees === 270;

  const fps = parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate);
  const frameCount = Number.parseInt(video?.nb_frames ?? "", 10);
  const duration =
    Number.parseFloat(payload.format?.duration ?? "") || Number.parseFloat(video?.duration ?? "") || 0;
  const pixelFormat = normalizeField(video?.pix_fmt);

  return {
    hasVideo: video !== undefined && codedWidth > 0 && codedHeight > 0,
    hasAudio: audio !== undefined,
    codec: normalizeField(video?.codec_name),
    codecTag: normalizeField(video?.codec_tag_string),
    profile: normalizeField(video?.profile),
    level: video?.level ?? 0,
    fieldOrder: normalizeField(video?.field_order),
    colorRange: normalizeField(video?.color_range),
    videoStreams: streams.filter((stream) => stream.codec_type === "video").length,
    audioStreams: streams.filter((stream) => stream.codec_type === "audio").length,
    audioCodec: normalizeField(audio?.codec_name),
    audioSampleRate: Number(audio?.sample_rate ?? 0),
    audioChannels: audio?.channels ?? 0,
    formatNames: (payload.format?.format_name ?? "").split(",").filter((name) => name.length > 0),
    pixelFormat,
    codedWidth,
    codedHeight,
    displayWidth: swapped ? codedHeight : codedWidth,
    displayHeight: swapped ? codedWidth : codedHeight,
    rotationDegrees,
    fps: Number.isFinite(fps) ? fps : 0,
    frameCount: Number.isInteger(frameCount) && frameCount > 0 ? frameCount : 0,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0,
    colorTransfer: normalizeField(video?.color_transfer),
    colorPrimaries: normalizeField(video?.color_primaries),
    colorSpace: normalizeField(video?.color_space),
    hasAlpha: pixelFormatHasAlpha(pixelFormat),
  };
}

function normalizeRotation(video: ProbeStream | undefined): number {
  const fromSideData = video?.side_data_list?.find((entry) => typeof entry.rotation === "number")?.rotation;
  const fromTag = Number.parseFloat(video?.tags?.rotate ?? "");
  const raw = typeof fromSideData === "number" ? fromSideData : fromTag;
  if (!Number.isFinite(raw)) {
    return 0;
  }
  const normalized = ((Math.round(raw) % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

function normalizeField(value: string | undefined): string {
  const text = (value ?? "").trim().toLowerCase();
  return text === "unknown" || text === "n/a" ? "" : text;
}

export function parseRate(rate: string | undefined): number {
  if (!rate) {
    return 0;
  }
  const [numerator, denominator] = rate.split("/", 2);
  const num = Number.parseFloat(numerator ?? "");
  if (!Number.isFinite(num)) {
    return 0;
  }
  if (denominator === undefined) {
    return num;
  }
  const den = Number.parseFloat(denominator);
  return Number.isFinite(den) && den !== 0 ? num / den : 0;
}

export async function probeMedia(
  runtime: CliRuntime,
  toolchain: FfmpegToolchain,
  filePath: string,
): Promise<MediaProbe> {
  const run = runProcessFor(runtime);
  const result = await run({
    command: toolchain.ffprobe,
    args: [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      filePath,
    ],
    timeoutMs: 120_000,
  });
  if (result.spawnError || result.code !== 0) {
    throw usageError(
      `ffprobe could not read the media file: ${
        result.spawnError ? redactText(result.spawnError) : `exit status ${result.code ?? "unknown"}`
      }.`,
    );
  }
  return parseProbePayload(result.stdout);
}
