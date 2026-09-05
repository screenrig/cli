import { usageError } from "../problems.js";
import type { MediaProbe } from "./ffmpeg.js";

export type SignagePreset = "signage-1080p30" | "signage-4k30";
export interface VideoOptions {
  codec: "h264" | "hevc";
  maxFps: number;
  maxEdge: number;
  preset?: SignagePreset;
  noAudio?: boolean;
}

export interface VideoDelivery {
  width: number;
  height: number;
  fps: number;
  level: string;
  levelId: number;
  audio: boolean;
}

// Pixel/throughput limits from FFmpeg's H.264 and HEVC level tables:
// https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_levels.c
// https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h265_profile_level.c
// Keep the existing 4.2/5.1 floors, which accommodate the 8M rate / 16M VBV.
// AVC allows four DPB frames for fast preset references plus B-frame reordering.
// Higher source rates must fit 5.2 or fail.
const AVC_LEVELS = [
  { name: "4.2", id: 42, frame: 8704, rate: 522240, dpb: 34816 },
  { name: "5.1", id: 51, frame: 36864, rate: 983040, dpb: 184320 },
  { name: "5.2", id: 52, frame: 36864, rate: 2073600, dpb: 184320 },
] as const;
const HEVC_LEVELS = [
  { name: "5.1", id: 153, frame: 8912896, rate: 534773760 },
  { name: "5.2", id: 156, frame: 8912896, rate: 1069547520 },
] as const;
export const MAX_VIDEO_PIXELS = 3840 * 2160;

export function videoBounds(options: VideoOptions): { longEdge: number; shortEdge: number; pixels: number; fps: number } {
  const fullHd = options.preset === "signage-1080p30";
  return {
    longEdge: Math.min(options.maxEdge, fullHd ? 1920 : 3840),
    shortEdge: Math.min(options.maxEdge, options.preset ? (fullHd ? 1080 : 2160) : 3840),
    pixels: fullHd ? 1920 * 1080 : MAX_VIDEO_PIXELS,
    fps: Math.min(options.maxFps, options.preset ? 30 : options.maxFps),
  };
}

/** Preserve orientation/aspect; bound both axes and total pixels before encoding. */
export function boundedVideoSize(width: number, height: number, options: VideoOptions): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw usageError("Video dimensions must be at least 2 pixels on each edge.");
  }
  const bounds = videoBounds(options);
  const scale = Math.min(1, bounds.longEdge / Math.max(width, height),
    bounds.shortEdge / Math.min(width, height), Math.sqrt(bounds.pixels / width / height));
  const result = { width: Math.floor(width * scale / 2) * 2, height: Math.floor(height * scale / 2) * 2 };
  if (result.width < 2 || result.height < 2) throw usageError("Video aspect ratio cannot fit the delivery bounds without upscaling.");
  return result;
}

export function videoLevel(codec: VideoOptions["codec"], width: number, height: number, fps: number): { level: string; levelId: number } {
  if (!(fps > 0) || !Number.isFinite(fps)) throw usageError("Video frame rate must be finite and positive.");
  const mbWidth = Math.ceil(width / 16);
  const mbHeight = Math.ceil(height / 16);
  const frame = codec === "h264" ? mbWidth * mbHeight : width * height;
  const level = codec === "h264"
    ? AVC_LEVELS.find((entry) => frame <= entry.frame && frame * fps <= entry.rate &&
      mbWidth * mbWidth <= 8 * entry.frame && mbHeight * mbHeight <= 8 * entry.frame && frame * 4 <= entry.dpb)
    : HEVC_LEVELS.find((entry) => frame <= entry.frame && frame * fps <= entry.rate &&
      width * width <= 8 * entry.frame && height * height <= 8 * entry.frame);
  if (!level) throw usageError("Video dimensions and frame rate exceed the supported codec levels; lower --max-edge or --max-fps.");
  return { level: level.name, levelId: level.id };
}

export function planVideoDelivery(probe: MediaProbe, options: VideoOptions): VideoDelivery {
  const size = boundedVideoSize(probe.displayWidth, probe.displayHeight, options);
  const maxFps = videoBounds(options).fps;
  const fps = Math.min(probe.fps > 0 ? probe.fps : maxFps, maxFps);
  return { ...size, fps, ...videoLevel(options.codec, size.width, size.height, fps), audio: probe.hasAudio && !options.noAudio };
}

/** Check facts available in ffprobe; this is not a peak-bitrate or device certification. */
export function validateVideoOutput(probe: MediaProbe, delivery: VideoDelivery, options: VideoOptions): void {
  const errors: string[] = [];
  const bounds = videoBounds(options);
  if (!probe.hasVideo || probe.videoStreams !== 1 || probe.codec !== options.codec || !probe.formatNames.includes("mp4")) errors.push("codec/container");
  if (probe.profile !== (options.codec === "h264" ? "high" : "main") || probe.level !== delivery.levelId ||
    probe.codecTag !== (options.codec === "h264" ? "avc1" : "hvc1")) errors.push("profile/level");
  if (probe.pixelFormat !== "yuv420p" ||
    (probe.fieldOrder !== "progressive" && !(options.codec === "hevc" && ["", "unknown"].includes(probe.fieldOrder)))) errors.push("pixel format/progressive scan");
  const { codedWidth: width, codedHeight: height } = probe;
  if (width < 2 || height < 2 || width % 2 || height % 2 || width !== delivery.width || height !== delivery.height ||
    Math.max(width, height) > bounds.longEdge || Math.min(width, height) > bounds.shortEdge || width * height > bounds.pixels ||
    probe.rotationDegrees !== 0) errors.push("dimensions");
  if (!(probe.fps > 0) || Math.abs(probe.fps - delivery.fps) > 0.002 || probe.fps > bounds.fps + 0.002) errors.push("frame rate");
  if (probe.colorTransfer !== "bt709" || probe.colorPrimaries !== "bt709" || probe.colorSpace !== "bt709" || probe.colorRange !== "tv") errors.push("color space");
  if (delivery.audio ? (probe.audioStreams !== 1 || probe.audioCodec !== "aac" || probe.audioSampleRate !== 48000 || probe.audioChannels !== 2) : probe.hasAudio) errors.push("audio");
  if (errors.length) throw usageError(`Encoded video failed delivery validation (${errors.join(", ")}); no upload was started.`);
}
