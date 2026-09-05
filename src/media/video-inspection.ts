import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliRuntime, RunProcessResult } from "../runtime.js";
import { probeMedia, runProcessFor, type FfmpegToolchain, type MediaProbe } from "./ffmpeg.js";
import { planVideoDelivery, validateVideoOutput, type VideoOptions } from "./video-profile.js";

// High-profile limits from FFmpeg libavcodec/h264_levels.c. All these levels
// permit the policy's 8 Mbit/s rate and 16 Mbit buffer. Encoder floors stay separate.
const LEVELS: Record<number, [number, number, number]> = {
  31: [3600, 108000, 18000], 32: [5120, 216000, 20480],
  40: [8192, 245760, 32768], 41: [8192, 245760, 32768],
  42: [8704, 522240, 34816], 50: [22080, 589824, 110400],
  51: [36864, 983040, 184320], 52: [36864, 2073600, 184320],
};
const INSPECTION_TIMEOUT_MS = 15_000;
const MAX_MEDIA_BYTES = 1_073_741_824;
const MAX_LINES = 2_000_000;
const MAX_LINE_CHARS = 16_384;

function candidate(probe: MediaProbe, options: VideoOptions): boolean {
  try {
    if (options.codec !== "h264" || !LEVELS[probe.level] || !(probe.timeBase > 0) || !Number.isFinite(probe.timeBase) ||
      probe.streamCount !== (probe.hasAudio ? 2 : 1) || (probe.hasAudio && probe.audioProfile !== "lc")) return false;
    const delivery = planVideoDelivery(probe, options);
    validateVideoOutput(probe, { ...delivery, levelId: probe.level }, options);
    return true;
  } catch { return false; }
}

interface PacketState {
  count: number; bytes: number; lastDts?: number; lastDuration?: number; bucket: number;
  pendingPts: number[]; nextPts?: number;
}
const packetState = (): PacketState => ({ count: 0, bytes: 0, bucket: 0, pendingPts: [] });

/** Full packet traversal: bounded video/AAC rate envelopes and constant video cadence. */
export class VideoPacketInspection {
  readonly video = packetState();
  readonly audio = packetState();
  private valid = true;
  private lines = 0;
  constructor(private readonly probe: MediaProbe) {}
  line(line: string): boolean {
    if (++this.lines > MAX_LINES) return this.valid = false;
    if (!line.trim()) return this.valid;
    const fields = new Map(line.split("|").map((field) => {
      const at = field.indexOf("="); return [field.slice(0, at), field.slice(at + 1)];
    }));
    const index = Number(fields.get("stream_index"));
    const video = index === this.probe.videoStreamIndex;
    if (!video && (!this.probe.hasAudio || index !== this.probe.audioStreamIndex)) return this.valid = false;
    const state = video ? this.video : this.audio;
    const dts = Number(fields.get("dts_time")), pts = Number(fields.get("pts_time"));
    const duration = Number(fields.get("duration_time")), bytes = Number(fields.get("size"));
    if (![dts, pts, duration, bytes].every(Number.isFinite) || duration <= 0 || !Number.isSafeInteger(bytes) || bytes < 1 ||
      !(video ? /^[K_]+$/ : /^[KD_]+$/).test(fields.get("flags") ?? "")) return this.valid = false;
    const delta = state.lastDts === undefined ? 0 : dts - state.lastDts;
    const tolerance = this.tolerance();
    if (state.lastDts !== undefined && (delta <= 0 || Math.abs(delta - state.lastDuration!) > tolerance)) return this.valid = false;
    const period = 1 / this.probe.fps;
    if (video && (Math.abs(duration - period) > tolerance || Math.abs(pts - dts) > period * 4 + tolerance)) return this.valid = false;
    state.bucket = Math.max(0, state.bucket - delta * (video ? 8_000_000 : 192_000)) + bytes * 8;
    if (state.bucket > (video ? 16_000_000 : 384_000)) return this.valid = false;
    state.lastDts = dts; state.lastDuration = duration; state.count++; state.bytes += bytes;
    if (state.bytes > MAX_MEDIA_BYTES) return this.valid = false;
    if (video) {
      state.nextPts ??= pts;
      if (state.pendingPts.some((value) => Math.abs(value - pts) < tolerance)) return this.valid = false;
      state.pendingPts.push(pts); state.pendingPts.sort((a, b) => a - b);
      if (state.pendingPts.length > 5 && !this.presentation()) return this.valid = false;
    }
    return this.valid;
  }
  private tolerance(): number {
    return Math.min(0.01 / this.probe.fps, Math.max(0.000002, this.probe.timeBase * 2));
  }
  private presentation(): boolean {
    const pts = this.video.pendingPts.shift();
    if (pts === undefined || Math.abs(pts - this.video.nextPts!) > this.tolerance()) return false;
    this.video.nextPts! += 1 / this.probe.fps;
    return true;
  }
  finish(): boolean {
    while (this.valid && this.video.pendingPts.length) this.valid = this.presentation();
    return this.valid && this.video.count > 0 && (!this.probe.hasAudio || this.audio.count > 0);
  }
}

const SPS_FIELDS = new Set([
  "profile_idc", "level_idc", "seq_parameter_set_id", "chroma_format_idc", "bit_depth_luma_minus8", "bit_depth_chroma_minus8",
  "max_num_ref_frames", "pic_width_in_mbs_minus1", "pic_height_in_map_units_minus1", "frame_mbs_only_flag",
  "frame_cropping_flag", "frame_crop_left_offset", "frame_crop_right_offset", "frame_crop_top_offset", "frame_crop_bottom_offset",
  "vui_parameters_present_flag", "video_signal_type_present_flag", "video_full_range_flag", "colour_description_present_flag",
  "colour_primaries", "transfer_characteristics", "matrix_coefficients", "bitstream_restriction_flag",
  "max_num_reorder_frames", "max_dec_frame_buffering", "timing_info_present_flag", "num_units_in_tick", "time_scale",
  "aspect_ratio_info_present_flag", "aspect_ratio_idc", "sar_width", "sar_height", "pic_order_cnt_type",
]);
const PPS_FIELDS = new Set(["pic_parameter_set_id", "seq_parameter_set_id", "bottom_field_pic_order_in_frame_present_flag",
  "num_slice_groups_minus1", "num_ref_idx_l0_default_active_minus1", "num_ref_idx_l1_default_active_minus1", "redundant_pic_cnt_present_flag"]);
const SLICE_FIELDS = new Set(["nal_unit_type", "first_mb_in_slice", "slice_type", "pic_parameter_set_id", "field_pic_flag",
  "num_ref_idx_l0_active_minus1", "num_ref_idx_l1_active_minus1"]);
interface TracePacket { key: boolean; slices: number; type?: number; idr?: boolean; lastMb: number }

/** Parse FFmpeg's trace_headers syntax summaries, never entropy-decode pictures. */
export class H264HeaderInspection {
  packets = 0;
  bytes = 0;
  private valid = true;
  private lines = 0;
  private section = "";
  private fields = new Map<string, number>();
  private sps = new Set<number>();
  private pps = new Set<number>();
  private signature?: string;
  private packet?: TracePacket;
  private lastIdr = -1;
  private bRun = 0;
  constructor(private readonly probe: MediaProbe) {}
  line(line: string): boolean {
    if (++this.lines > MAX_LINES || /^(?:\[[^\]]+ @ [^\]]+\]\s*)?\[(?:error|fatal|panic)\]/.test(line)) return this.valid = false;
    const match = /^\[trace_headers @ [^\]]+\]\s*(?:\[info\]\s*)?(.*)/.exec(line);
    if (!match) return this.valid;
    const text = match[1]!;
    if (/\b(error|invalid|failed|corrupt|overread)\b/i.test(text)) return this.valid = false;
    if (text.startsWith("Packet:")) {
      this.endSection(); this.endPacket();
      const packet = /^Packet: (\d+) bytes,( key frame,)? pts (-?\d+), dts (-?\d+), duration (\d+)\.$/.exec(text);
      if (!packet || !packet.slice(1).filter((_, index) => index !== 1).every((value) => Number.isSafeInteger(Number(value)))) return this.valid = false;
      const size = Number(packet[1]);
      if (size < 1 || Number(packet[5]) < 1) return this.valid = false;
      this.bytes += size;
      this.packet = { key: Boolean(packet[2]), slices: 0, lastMb: -1 };
      return this.valid;
    }
    const field = /^\d+\s+([a-zA-Z0-9_]+)(?:\[[^\]]+\])?\s+[01]+\s*=\s*(-?\d+)\s*$/.exec(text);
    if (field) {
      const key = field[1]!, value = Number(field[2]);
      if (!Number.isSafeInteger(value)) return this.valid = false;
      if (key === "nal_unit_type" && ![1, 5, 6, 7, 8, 9, 12].includes(value)) return this.valid = false;
      const allowed = this.section === "Sequence Parameter Set" ? SPS_FIELDS : this.section === "Picture Parameter Set" ? PPS_FIELDS : SLICE_FIELDS;
      if (this.section && allowed.has(key)) this.fields.set(key, value);
      return this.valid;
    }
    // Headers outside the bounded subset (SEI/AUD/filler) are not retained.
    this.endSection();
    if (["Sequence Parameter Set", "Picture Parameter Set", "Slice Header"].includes(text)) this.section = text;
    return this.valid;
  }
  private endSection(): void {
    if (!this.section) return;
    const f = this.fields, get = (key: string) => f.get(key);
    if (this.section === "Sequence Parameter Set") {
      const limits = LEVELS[this.probe.level];
      const width = (get("pic_width_in_mbs_minus1")! + 1) * 16;
      const height = (get("pic_height_in_map_units_minus1")! + 1) * 16;
      const mbs = width * height / 256, dpb = get("max_dec_frame_buffering")!, refs = get("max_num_ref_frames")!;
      const crop = (key: string) => get("frame_cropping_flag") === 0 ? 0 : get(key)!;
      const w = width - 2 * (crop("frame_crop_left_offset") + crop("frame_crop_right_offset"));
      const h = height - 2 * (crop("frame_crop_top_offset") + crop("frame_crop_bottom_offset"));
      const id = get("seq_parameter_set_id")!;
      const exact: Record<string, number> = { profile_idc: 100, level_idc: this.probe.level, chroma_format_idc: 1,
        bit_depth_luma_minus8: 0, bit_depth_chroma_minus8: 0, frame_mbs_only_flag: 1, vui_parameters_present_flag: 1,
        video_signal_type_present_flag: 1, video_full_range_flag: 0, colour_description_present_flag: 1,
        colour_primaries: 1, transfer_characteristics: 1, matrix_coefficients: 1, bitstream_restriction_flag: 1,
        timing_info_present_flag: 1, pic_order_cnt_type: 0 };
      if (!limits || Object.entries(exact).some(([key, value]) => get(key) !== value) ||
        !Number.isInteger(id) || id < 0 || id > 31 || ![0, 1].includes(get("frame_cropping_flag")!) ||
        w !== this.probe.codedWidth || h !== this.probe.codedHeight || !(refs >= 0 && refs <= dpb && dpb <= 4 && dpb >= 1) ||
        !(get("max_num_reorder_frames")! >= 0 && get("max_num_reorder_frames")! <= Math.min(2, dpb)) ||
        !(get("num_units_in_tick")! > 0) || !(get("time_scale")! > 0) || Math.abs(get("time_scale")! / (2 * get("num_units_in_tick")!) - this.probe.fps) > 0.002 ||
        mbs > limits[0] || mbs * this.probe.fps > limits[1] || mbs * dpb > limits[2] ||
        (width / 16) ** 2 > 8 * limits[0] || (height / 16) ** 2 > 8 * limits[0]) this.valid = false;
      const signature = JSON.stringify([...f].filter(([key]) => key !== "seq_parameter_set_id").sort(([a], [b]) => a.localeCompare(b)));
      if (this.signature !== undefined && signature !== this.signature) this.valid = false;
      this.signature = signature; this.sps.add(id);
    } else if (this.section === "Picture Parameter Set") {
      const id = get("pic_parameter_set_id")!;
      if (!Number.isInteger(id) || id < 0 || id > 255 || !this.sps.has(get("seq_parameter_set_id")!) ||
        get("bottom_field_pic_order_in_frame_present_flag") !== 0 || get("num_slice_groups_minus1") !== 0 ||
        get("redundant_pic_cnt_present_flag") !== 0 ||
        !["num_ref_idx_l0_default_active_minus1", "num_ref_idx_l1_default_active_minus1"].every((key) => get(key)! >= 0 && get(key)! <= 3)) this.valid = false;
      this.pps.add(id);
    } else {
      const type = get("slice_type")!, mb = get("first_mb_in_slice")!, nal = get("nal_unit_type");
      if (!this.packet || !this.pps.has(get("pic_parameter_set_id")!) || !Number.isInteger(type) || type < 0 || type > 9 || type % 5 > 2 ||
        ![1, 5].includes(nal!) || !Number.isInteger(mb) || mb <= (this.packet?.lastMb ?? -1) ||
        mb >= Math.ceil(this.probe.codedWidth / 16) * Math.ceil(this.probe.codedHeight / 16) ||
        (get("field_pic_flag") !== undefined && get("field_pic_flag") !== 0) ||
        ["num_ref_idx_l0_active_minus1", "num_ref_idx_l1_active_minus1"].some((key) => get(key) !== undefined && !(get(key)! >= 0 && get(key)! <= 3))) this.valid = false;
      if (this.packet) {
        if ((this.packet.slices === 0 && mb !== 0) || (this.packet.type !== undefined && this.packet.type !== type % 5) ||
          (this.packet.idr !== undefined && this.packet.idr !== (nal === 5))) this.valid = false;
        this.packet.slices++; this.packet.type = type % 5; this.packet.idr = nal === 5; this.packet.lastMb = mb;
      }
    }
    this.section = ""; this.fields = new Map();
  }
  private endPacket(): void {
    if (!this.packet) return;
    const p = this.packet;
    if (!p.slices || p.key !== p.idr || (p.idr && p.type !== 2)) this.valid = false;
    if (p.idr) this.lastIdr = this.packets;
    if (this.lastIdr < 0 || this.packets - this.lastIdr >= Math.max(1, Math.round(this.probe.fps * 2))) this.valid = false;
    this.bRun = p.type === 1 ? this.bRun + 1 : 0;
    if (this.bRun > 2) this.valid = false;
    this.packets++; this.packet = undefined;
  }
  finish(): boolean {
    this.endSection(); this.endPacket();
    return this.valid && this.sps.size > 0 && this.pps.size > 0 && this.packets > 0;
  }
}

function completed(result: RunProcessResult): boolean {
  return result.code === 0 && !result.signal && !result.spawnError && !result.timedOut && !result.outputTruncated && !result.stoppedEarly;
}

export async function inspectH264Passthrough(runtime: CliRuntime, toolchain: FfmpegToolchain, source: string, initialProbe: MediaProbe, options: VideoOptions):
  Promise<{ filePath: string; cleanupDir: string; sha256: string; bytes: number; probe: MediaProbe } | undefined> {
  if (!candidate(initialProbe, options)) return undefined;
  let cleanupDir: string | undefined;
  try {
    const sourceInfo = await stat(source);
    if (!sourceInfo.isFile() || sourceInfo.size < 1 || sourceInfo.size > MAX_MEDIA_BYTES) return undefined;
    cleanupDir = await mkdtemp(path.join(tmpdir(), "screenrig-inspect-"));
    const filePath = path.join(cleanupDir, `${path.basename(source, path.extname(source)) || "media"}.mp4`);
    await copyFile(source, filePath, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    const snapshot = await stat(filePath);
    if (snapshot.size < 1 || snapshot.size > MAX_MEDIA_BYTES) return undefined;
    const probe = await probeMedia(runtime, toolchain, filePath);
    if (!candidate(probe, options)) return undefined;
    const packets = new VideoPacketInspection(probe), headers = new H264HeaderInspection(probe), run = runProcessFor(runtime);
    const packetResult = await run({ command: toolchain.ffprobe,
      args: ["-v", "error", "-show_packets", "-show_entries", "packet=stream_index,pts_time,dts_time,duration_time,size,flags", "-of", "compact=p=0:nk=0", filePath],
      timeoutMs: INSPECTION_TIMEOUT_MS, maxLineChars: MAX_LINE_CHARS, onStdoutLine: (line) => packets.line(line) });
    if (!completed(packetResult) || packetResult.stderrTail.trim() !== "" || !packets.finish()) return undefined;
    const headerResult = await run({ command: toolchain.ffmpeg,
      args: ["-hide_banner", "-nostdin", "-nostats", "-xerror", "-loglevel", "level+info", "-copyts", "-i", filePath, "-map", "0:v:0", "-c:v", "copy", "-copytb", "1", "-bsf:v", "trace_headers", "-f", "null", "-"],
      timeoutMs: INSPECTION_TIMEOUT_MS, maxLineChars: MAX_LINE_CHARS,
      onStdoutLine: () => false, onStderrLine: (line) => headers.line(line) });
    if (!completed(headerResult) || !headers.finish() || headers.packets !== packets.video.count || headers.bytes !== packets.video.bytes) return undefined;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    const accepted = { filePath, cleanupDir, sha256: hash.digest("hex"), bytes: snapshot.size, probe };
    cleanupDir = undefined; // The upload caller owns this private snapshot until its PUT finishes.
    return accepted;
  } catch { return undefined; }
  finally { if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true }); }
}
