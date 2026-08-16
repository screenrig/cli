import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { usageError } from "../problems.js";
import { redactText } from "../redact.js";
import type { CliRuntime } from "../runtime.js";
import {
  probeMedia,
  resolveFfmpegToolchain,
  runProcessFor,
  type FfmpegToolchain,
  type MediaProbe,
} from "./ffmpeg.js";
import { silentProgressReporter, type ProgressReporter } from "./progress.js";
import { readWebpContainer } from "./webp.js";

/**
 * Delivery targets for signage and kiosk playback.
 *
 * Both dimensions are bounded by MAX_EDGE, so a portrait source is capped the
 * same way a landscape source is. Aspect ratio is preserved and sources smaller
 * than the bound are never upscaled.
 */
export const MAX_EDGE = 3840;
export const DEFAULT_MAX_FPS = 30;
export const DEFAULT_WEBP_QUALITY = 90;

export type TranscodeCodec = "hevc" | "h264";

export interface TranscodeOptions {
  codec: TranscodeCodec;
  maxFps: number;
  webpQuality: number;
  maxEdge: number;
}

/**
 * H.264 High is the default because ScreenRig stores exactly one rendition per
 * media object and the layout contract carries no codec parameter, so there is
 * no per-client fallback. A browser that cannot decode H.265 does not fall back
 * to anything; it stalls. H.265 stays available through `--codec hevc` for
 * fleets known to be native-only.
 */
export const DEFAULT_CODEC: TranscodeCodec = "h264";

export function defaultTranscodeOptions(): TranscodeOptions {
  return {
    codec: DEFAULT_CODEC,
    maxFps: DEFAULT_MAX_FPS,
    webpQuality: DEFAULT_WEBP_QUALITY,
    maxEdge: MAX_EDGE,
  };
}

/** Source families the CLI recognizes before it decides what to run. */
const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpg", ".mpeg", ".ts", ".m2ts", ".wmv", ".flv", ".ogv", ".3gp",
]);
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".heif",
]);

export type SourceKind = "video" | "image";

export function classifySource(filePath: string, explicitContentType?: string): SourceKind {
  if (explicitContentType?.startsWith("video/")) return "video";
  if (explicitContentType?.startsWith("image/")) return "image";
  const extension = path.extname(filePath).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  throw usageError(
    `Cannot tell whether ${path.basename(filePath)} is video or image from its extension. ` +
      "Pass --content-type with the source type, or pass --no-transcode to upload the bytes unchanged.",
  );
}

export interface TranscodeResult {
  /** Absolute path to the bytes that should be uploaded. */
  filePath: string;
  /** Upload filename, which keeps the source stem and takes the target extension. */
  filename: string;
  contentType: "video/mp4" | "image/webp";
  /** True when the source already met the target and was passed through unchanged. */
  passthrough: boolean;
  reason: string;
  stage: SourceKind;
  sourceBytes: number;
  outputBytes: number;
  durationMs: number;
  width: number;
  height: number;
  /** True when width/height were read back from the produced file. */
  dimensionsMeasured: boolean;
  warnings: string[];
  /** Directory the caller must remove once the upload completes. */
  cleanupDir?: string;
}

export interface TranscodeRequest {
  runtime: CliRuntime;
  filePath: string;
  explicitContentType?: string;
  options: TranscodeOptions;
  reporter?: ProgressReporter;
}

export async function transcodeForUpload(request: TranscodeRequest): Promise<TranscodeResult> {
  const { runtime, filePath, options } = request;
  const reporter = request.reporter ?? silentProgressReporter();
  const kind = classifySource(filePath, request.explicitContentType);
  const toolchain = await resolveFfmpegToolchain(runtime);
  const probe = await probeMedia(runtime, toolchain, filePath);
  const sourceBytes = (await stat(filePath)).size;

  if (!probe.hasVideo) {
    // ffmpeg has no animated-WebP demuxer, so a valid animated WebP probes empty.
    const container = kind === "image" ? readWebpContainer(await readFile(filePath, { flag: "r" })) : undefined;
    if (container?.animated) {
      if (container.width > options.maxEdge || container.height > options.maxEdge) {
        throw usageError(
          `${path.basename(filePath)} is an animated WebP of ${container.width}x${container.height}, ` +
            `which exceeds the ${options.maxEdge}px bound, and ffmpeg cannot decode animated WebP to resize it. ` +
            "Supply the original source, or pass --no-transcode to upload it unchanged.",
        );
      }
      return {
        filePath,
        filename: path.basename(filePath),
        contentType: "image/webp",
        passthrough: true,
        reason: `source is already an animated WebP within ${options.maxEdge}px on both edges`,
        stage: "image",
        sourceBytes,
        outputBytes: sourceBytes,
        durationMs: 0,
        width: container.width,
        height: container.height,
        // Read from the RIFF header of the exact bytes being uploaded.
        dimensionsMeasured: true,
        warnings: [],
      };
    }
    throw usageError(
      `ffprobe found no decodable ${kind} stream in ${path.basename(filePath)}. ` +
        "Pass --no-transcode to upload the bytes unchanged.",
    );
  }

  const passthrough = passthroughReason(kind, probe, options);
  if (passthrough) {
    return {
      filePath,
      filename: path.basename(filePath),
      contentType: kind === "video" ? "video/mp4" : "image/webp",
      passthrough: true,
      reason: passthrough,
      stage: kind,
      sourceBytes,
      outputBytes: sourceBytes,
      durationMs: 0,
      width: probe.displayWidth,
      height: probe.displayHeight,
      // A passthrough uploads the probed source verbatim, so this is measured.
      dimensionsMeasured: true,
      warnings: [],
    };
  }

  const extension = kind === "video" ? ".mp4" : ".webp";
  const stem = path.basename(filePath, path.extname(filePath));
  const filename = `${stem || "media"}${extension}`;
  const cleanupDir = await mkdtemp(path.join(tmpdir(), "screenrig-transcode-"));
  const outputPath = path.join(cleanupDir, filename);

  // Every failure after mkdtemp must remove the directory, including planning
  // failures such as an ffmpeg build without the encoder the profile needs.
  try {
    const plan =
      kind === "video"
        ? planVideo(toolchain, probe, options, filePath, outputPath)
        : planImage(toolchain, probe, options, filePath, outputPath);

    reporter.start({
      stage: kind,
      target: plan.target,
      sourceBytes,
      durationSeconds: plan.progressDurationSeconds,
      width: probe.displayWidth,
      height: probe.displayHeight,
    });

    const startedAt = runtime.now().getTime();
    await runEncode(runtime, toolchain, plan.args, plan.progressDurationSeconds, reporter);

    let outputBytes: number;
    try {
      outputBytes = (await stat(outputPath)).size;
    } catch {
      throw usageError("ffmpeg reported success but wrote no output file.");
    }
    if (outputBytes < 1) {
      throw usageError("ffmpeg wrote an empty output file.");
    }

    const durationMs = runtime.now().getTime() - startedAt;
    reporter.finish({ outputBytes, elapsedMs: durationMs });

    const measured = await measureOutput(runtime, toolchain, outputPath, kind);
    const warnings = [...plan.warnings];
    if (!measured) {
      warnings.push(
        "The CLI could not measure the transcoded file, so the reported width and height are the " +
          "planned values and may differ from the delivered file by a pixel or two.",
      );
    }

    return {
      filePath: outputPath,
      filename,
      contentType: kind === "video" ? "video/mp4" : "image/webp",
      passthrough: false,
      reason: plan.reason,
      stage: kind,
      sourceBytes,
      outputBytes,
      durationMs,
      width: measured?.width ?? plan.outputWidth,
      height: measured?.height ?? plan.outputHeight,
      dimensionsMeasured: measured !== undefined,
      warnings,
      cleanupDir,
    };
  } catch (error) {
    reporter.failed();
    await rm(cleanupDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Report what was actually produced, not what was planned.
 *
 * `boundedSize` predicts the output, but ffmpeg's own rounding differs: the
 * image path passes no `force_divisible_by`, and the video path floors to a
 * multiple of two rather than rounding to the nearest. Measuring closes that
 * gap so the envelope carries a fact.
 *
 * An animated WebP cannot be probed, because ffmpeg has no animated-WebP
 * demuxer, so the RIFF header answers instead. When neither source works the
 * caller says so rather than presenting a guess as a measurement.
 */
async function measureOutput(
  runtime: CliRuntime,
  toolchain: FfmpegToolchain,
  outputPath: string,
  kind: SourceKind,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const probe = await probeMedia(runtime, toolchain, outputPath);
    if (probe.hasVideo && probe.displayWidth > 0 && probe.displayHeight > 0) {
      return { width: probe.displayWidth, height: probe.displayHeight };
    }
  } catch {
    // Fall through to the container reader below.
  }
  if (kind === "image") {
    try {
      const container = readWebpContainer(await readFile(outputPath, { flag: "r" }));
      if (container && container.width > 0 && container.height > 0) {
        return { width: container.width, height: container.height };
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Video is always re-encoded so every upload has the same codec, colour space,
 * and faststart layout. Only an already-conforming WebP still is passed through,
 * because re-encoding it would lose quality for no delivery benefit.
 */
function passthroughReason(kind: SourceKind, probe: MediaProbe, options: TranscodeOptions): string | undefined {
  if (kind !== "image") {
    return undefined;
  }
  if (probe.codec !== "webp") {
    return undefined;
  }
  if (probe.displayWidth > options.maxEdge || probe.displayHeight > options.maxEdge) {
    return undefined;
  }
  return `source is already WebP within ${options.maxEdge}px on both edges`;
}

interface EncodePlan {
  args: string[];
  target: string;
  reason: string;
  progressDurationSeconds: number;
  outputWidth: number;
  outputHeight: number;
  warnings: string[];
}

/** Fit within a maxEdge x maxEdge box, preserving aspect and never upscaling. */
export function boundedSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    return { width, height };
  }
  const scale = Math.min(1, maxEdge / width, maxEdge / height);
  if (scale >= 1) {
    return { width, height };
  }
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

export function boundedScaleFilter(maxEdge: number): string {
  return (
    `scale=w='min(${maxEdge},iw)':h='min(${maxEdge},ih)'` +
    ":force_original_aspect_ratio=decrease:force_divisible_by=2"
  );
}

export function isHdr(probe: MediaProbe): boolean {
  if (probe.colorTransfer === "smpte2084" || probe.colorTransfer === "arib-std-b67") {
    return true;
  }
  return (
    probe.colorPrimaries === "bt2020" || probe.colorSpace === "bt2020nc" || probe.colorSpace === "bt2020c"
  );
}

function zscaleInputOptions(probe: MediaProbe): string[] {
  let primaries = probe.colorPrimaries;
  let transfer = probe.colorTransfer;
  let matrix = probe.colorSpace;
  if (primaries === "" && (matrix === "bt2020nc" || matrix === "bt2020c")) {
    primaries = "bt2020";
  }
  if (matrix === "" && primaries === "bt2020") {
    matrix = "bt2020nc";
  }
  if (transfer === "" && (primaries === "bt2020" || matrix === "bt2020nc" || matrix === "bt2020c")) {
    transfer = "bt709";
  }
  const options: string[] = [];
  if (primaries) options.push(`pin=${primaries}`);
  if (transfer) options.push(`tin=${transfer}`);
  if (matrix) options.push(`min=${matrix}`);
  return options;
}

/**
 * HDR sources are tone mapped down to Rec. 709 so a signage panel does not show
 * a washed-out picture. zscale and tonemap come from libzimg, which some ffmpeg
 * builds omit; without them the CLI falls back to a plain conversion and warns.
 */
export function videoFilterChain(
  toolchain: FfmpegToolchain,
  probe: MediaProbe,
  maxEdge: number,
): { filter: string; warnings: string[] } {
  const scale = boundedScaleFilter(maxEdge);
  if (!isHdr(probe)) {
    return { filter: scale, warnings: [] };
  }
  if (!toolchain.filters.has("zscale") || !toolchain.filters.has("tonemap")) {
    return {
      filter: `${scale},format=yuv420p`,
      warnings: [
        "This ffmpeg build has no zscale or tonemap filter, so the HDR source was converted without tone mapping. " +
          "Colours may look washed out. Rebuild ffmpeg with libzimg for a tone-mapped result.",
      ],
    };
  }
  const inputColor = zscaleInputOptions(probe);
  const hdrTransfer = probe.colorTransfer === "smpte2084" || probe.colorTransfer === "arib-std-b67";
  if (hdrTransfer) {
    return {
      filter:
        `${scale}` +
        `,zscale=${[...inputColor, "t=linear", "npl=100"].join(":")}` +
        ",format=gbrpf32le" +
        ",zscale=p=bt709" +
        ",tonemap=tonemap=hable:desat=0" +
        ",zscale=t=bt709:m=bt709:r=tv" +
        ",format=yuv420p",
      warnings: [],
    };
  }
  return {
    filter:
      `${scale}` +
      `,zscale=${[...inputColor, "p=bt709", "t=bt709", "m=bt709", "r=tv"].join(":")}` +
      ",format=yuv420p",
    warnings: [],
  };
}

export function encodeTiming(probe: MediaProbe, maxFps: number): { rate: string; gop: number } {
  const sourceFps = probe.fps > 0 ? probe.fps : maxFps;
  const targetFps = Math.min(sourceFps, maxFps);
  const gop = Math.max(1, Math.round(targetFps * 2));
  return { rate: formatRate(targetFps), gop };
}

function formatRate(fps: number): string {
  const rounded = Math.round(fps);
  return Math.abs(fps - rounded) < 1e-6 ? String(rounded) : fps.toFixed(6).replace(/0+$/, "");
}

const REC709_OUTPUT = [
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
  "-colorspace", "bt709",
  "-color_range", "tv",
];

function planVideo(
  toolchain: FfmpegToolchain,
  probe: MediaProbe,
  options: TranscodeOptions,
  input: string,
  output: string,
): EncodePlan {
  const encoder = options.codec === "hevc" ? "libx265" : "libx264";
  const alternate = options.codec === "hevc" ? "--codec h264" : "--codec hevc";
  if (!toolchain.encoders.has(encoder)) {
    throw usageError(
      `This ffmpeg build has no ${encoder} encoder, so it cannot produce ${
        options.codec === "hevc" ? "H.265" : "H.264"
      }. Install an ffmpeg built with ${encoder}, or pass ${alternate}.`,
      {
        command: "screenrig doctor",
        reason: "Report which encoders the resolved ffmpeg build provides.",
      },
    );
  }

  const { filter, warnings } = videoFilterChain(toolchain, probe, options.maxEdge);
  const { rate, gop } = encodeTiming(probe, options.maxFps);
  const size = boundedSize(probe.displayWidth, probe.displayHeight, options.maxEdge);

  const args = [
    "-i", input,
    "-f", "mp4",
    "-vf", filter,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", encoder,
  ];

  if (options.codec === "hevc") {
    args.push(
      "-tag:v", "hvc1",
      "-profile:v", "main",
      "-level:v", "5.1",
      "-preset", "fast",
      "-crf", "28",
      "-maxrate", "8M",
      "-bufsize", "16M",
      "-pix_fmt", "yuv420p",
      ...REC709_OUTPUT,
      "-bf", "2",
      "-r", rate,
      "-g", String(gop),
      "-x265-params", `output-depth=8:min-keyint=${gop}:scenecut=0:log-level=error`,
    );
  } else {
    args.push(
      "-profile:v", "high",
      "-level:v", "4.2",
      "-preset", "fast",
      "-crf", "23",
      "-maxrate", "8M",
      "-bufsize", "16M",
      "-pix_fmt", "yuv420p",
      ...REC709_OUTPUT,
      "-bf", "2",
      "-r", rate,
      "-g", String(gop),
      "-keyint_min", String(gop),
      "-sc_threshold", "0",
    );
  }

  args.push(
    "-avoid_negative_ts", "make_zero",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart",
    "-write_tmcd", "0",
    "-threads", "0",
    "-progress", "pipe:1",
    "-nostdin",
    "-y",
    output,
  );

  return {
    args,
    target: options.codec === "hevc" ? "H.265 MP4" : "H.264 MP4",
    reason:
      `re-encoded to ${options.codec === "hevc" ? "H.265" : "H.264"} MP4, bounded to ${options.maxEdge}px ` +
      `on both edges, capped at ${options.maxFps} fps, faststart`,
    progressDurationSeconds: probe.durationSeconds,
    outputWidth: size.width,
    outputHeight: size.height,
    warnings,
  };
}

/** An input is animated when it carries more than one frame with a timeline. */
export function isAnimated(probe: MediaProbe): boolean {
  if (probe.frameCount > 1) {
    return true;
  }
  return probe.frameCount === 0 && probe.durationSeconds > 0 && probe.fps > 0 && probe.durationSeconds * probe.fps > 1.5;
}

function planImage(
  toolchain: FfmpegToolchain,
  probe: MediaProbe,
  options: TranscodeOptions,
  input: string,
  output: string,
): EncodePlan {
  if (!toolchain.encoders.has("libwebp") && !toolchain.encoders.has("libwebp_anim")) {
    throw usageError(
      "This ffmpeg build has no libwebp encoder, so it cannot produce WebP. " +
        "Install an ffmpeg built with libwebp, or pass --no-transcode to upload the source unchanged.",
      {
        command: "screenrig doctor",
        reason: "Report which encoders the resolved ffmpeg build provides.",
      },
    );
  }

  const animated = isAnimated(probe);
  const size = boundedSize(probe.displayWidth, probe.displayHeight, options.maxEdge);
  const scale =
    `scale=w='min(${options.maxEdge},iw)':h='min(${options.maxEdge},ih)'` +
    ":force_original_aspect_ratio=decrease";

  // libwebp_anim writes inter-frame differences, so an animation encoded with it
  // is markedly smaller than the same animation encoded frame by frame.
  const encoder = animated && toolchain.encoders.has("libwebp_anim") ? "libwebp_anim" : "libwebp";

  const args = ["-i", input, "-f", "webp", "-vf", scale];
  if (!animated) {
    args.push("-frames:v", "1");
  } else {
    args.push("-loop", "0");
  }
  args.push(
    "-c:v", encoder,
    "-pix_fmt", probe.hasAlpha ? "yuva420p" : "yuv420p",
    "-quality", String(options.webpQuality),
    "-preset", "picture",
    "-compression_level", "6",
    "-progress", "pipe:1",
    "-nostdin",
    "-y",
    output,
  );

  return {
    args,
    target: animated ? "animated WebP" : "WebP",
    reason: `converted to ${animated ? "animated " : ""}WebP quality ${options.webpQuality}, bounded to ${
      options.maxEdge
    }px on both edges`,
    progressDurationSeconds: animated ? probe.durationSeconds : 0,
    outputWidth: size.width,
    outputHeight: size.height,
    warnings: [],
  };
}

/**
 * ffmpeg writes `-progress pipe:1` records as key=value lines. `out_time_ms` is
 * historically microseconds, matching `out_time_us`; both are read that way.
 */
async function runEncode(
  runtime: CliRuntime,
  toolchain: FfmpegToolchain,
  args: string[],
  durationSeconds: number,
  reporter: ProgressReporter,
): Promise<void> {
  const run = runProcessFor(runtime);
  let sawEnd = false;
  const result = await run({
    command: toolchain.ffmpeg,
    args,
    onStdoutLine: (line) => {
      const separator = line.indexOf("=");
      if (separator < 0) {
        return;
      }
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key === "out_time_ms" || key === "out_time_us") {
        const micros = Number.parseFloat(value);
        if (durationSeconds > 0 && Number.isFinite(micros) && micros > 0) {
          reporter.update(micros / 1_000_000 / durationSeconds);
        }
        return;
      }
      if (key === "progress" && value === "end") {
        sawEnd = true;
        reporter.update(1);
      }
    },
  });

  if (result.spawnError) {
    throw usageError(`ffmpeg could not start: ${redactText(result.spawnError)}.`);
  }
  if (result.code !== 0) {
    throw usageError(
      `ffmpeg exited with status ${result.code ?? "unknown"}: ${summarizeFfmpegError(result.stderrTail)}`,
    );
  }
  if (!sawEnd) {
    reporter.update(1);
  }
}

/** Keep the last few ffmpeg diagnostic lines, redacted and length bounded. */
export function summarizeFfmpegError(stderrTail: string): string {
  const lines = redactText(stderrTail)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-4).join(" | ");
  return tail.length > 600 ? `${tail.slice(0, 600)}...` : tail || "no diagnostic output";
}
