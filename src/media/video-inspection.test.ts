import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { testTemp } from "../test-temp.js";
import { prepareMediaUpload } from "../media-upload.js";
import type { CliRuntime, RunProcessRequest } from "../runtime.js";
import { parseProbePayload, resetFfmpegToolchainCache } from "./ffmpeg.js";
import { defaultTranscodeOptions, transcodeForUpload } from "./transcode.js";
import { H264HeaderInspection, VideoPacketInspection } from "./video-inspection.js";

function probeJson(video: Record<string, unknown> = {}, audio = false): string {
  return JSON.stringify({ streams: [{ index: 0, codec_type: "video", codec_name: "h264", codec_tag_string: "avc1",
    profile: "High", level: 41, width: 320, height: 180, pix_fmt: "yuv420p", field_order: "progressive",
    color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709",
    avg_frame_rate: "30/1", time_base: "1/15360", ...video },
    ...(audio ? [{ index: 1, codec_type: "audio", codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2 }] : [])],
    format: { format_name: "mov,mp4,m4a", duration: "0.1" } });
}
const probe = parseProbePayload(probeJson());
const prefix = "[trace_headers @ 0x1] ";
const field = (name: string, value: number) => `${prefix}0 ${name} 0 = ${value}`;
// These are the bounded fields from a real libx264 High SPS/PPS trace.
const sps = { profile_idc: 100, level_idc: 41, seq_parameter_set_id: 0, chroma_format_idc: 1,
  bit_depth_luma_minus8: 0, bit_depth_chroma_minus8: 0, max_num_ref_frames: 4,
  pic_width_in_mbs_minus1: 19, pic_height_in_map_units_minus1: 11, frame_mbs_only_flag: 1,
  frame_cropping_flag: 1, frame_crop_left_offset: 0, frame_crop_right_offset: 0, frame_crop_top_offset: 0, frame_crop_bottom_offset: 6,
  vui_parameters_present_flag: 1, video_signal_type_present_flag: 1, video_full_range_flag: 0, colour_description_present_flag: 1,
  colour_primaries: 1, transfer_characteristics: 1, matrix_coefficients: 1, bitstream_restriction_flag: 1,
  max_num_reorder_frames: 2, max_dec_frame_buffering: 4, timing_info_present_flag: 1, num_units_in_tick: 1, time_scale: 60,
  aspect_ratio_info_present_flag: 1, aspect_ratio_idc: 1, pic_order_cnt_type: 0 };
const pps = { pic_parameter_set_id: 0, seq_parameter_set_id: 0, bottom_field_pic_order_in_frame_present_flag: 0,
  num_slice_groups_minus1: 0, num_ref_idx_l0_default_active_minus1: 1, num_ref_idx_l1_default_active_minus1: 0,
  redundant_pic_cnt_present_flag: 0 };
function section(title: string, fields: Record<string, number>): string[] {
  return [prefix + title, ...Object.entries(fields).map(([name, value]) => field(name, value))];
}
function picture(index: number, type: number, idr = false, slices = 1): string[] {
  return [`${prefix}Packet: 100 bytes,${idr ? " key frame," : ""} pts ${index * 512}, dts ${(index - 2) * 512}, duration 512.`,
    ...Array.from({ length: slices }, (_, i) => section("Slice Header", { nal_unit_type: idr ? 5 : 1,
      first_mb_in_slice: i * 5, slice_type: type + 5, pic_parameter_set_id: 0 })).flat()];
}
const trace = [...section("Sequence Parameter Set", sps), ...section("Picture Parameter Set", pps),
  ...picture(0, 2, true), ...picture(1, 0), ...picture(2, 1)];
const packets = [0, 1, 2].map((i) => `stream_index=0|pts_time=${(i / 30).toFixed(6)}|dts_time=${((i - 2) / 30).toFixed(6)}|duration_time=0.033333|size=100|flags=${i ? "___" : "K__"}`);
function headersValid(lines: string[], input = probe): boolean {
  const inspection = new H264HeaderInspection(input);
  return lines.every((line) => inspection.line(line)) && inspection.finish();
}
function packetsValid(lines: string[], input = probe): boolean {
  const inspection = new VideoPacketInspection(input);
  return lines.every((line) => inspection.line(line)) && inspection.finish();
}

test("external High 4.1 headers and every packet pass the bounded inspection", () => {
  assert.equal(headersValid(trace), true);
  assert.equal(packetsValid(packets), true);
});

test("structured diagnostics do not confuse harmless filenames or title metadata with errors", () => {
  const structured = trace.map((line) => line.replace(prefix, `${prefix}[info] `));
  assert.equal(headersValid(["[info] Input #0 from error-ad.mp4", "[info] title : failed [error] [trace_headers @ metadata]", ...structured]), true);
  for (const diagnostic of ["[error] Invalid packet", "[trace_headers @ 0x1] [error] Syntax failure", "[in#0 @ 0x1] [fatal] Failed input"]) {
    assert.equal(headersValid([...structured, diagnostic]), false);
  }
});

test("SPS bounds reject missing evidence, oversized DPB, colour changes and stale levels", () => {
  for (const bad of [{ max_num_ref_frames: 5 }, { max_dec_frame_buffering: 5 }, { max_num_reorder_frames: 3 },
    { frame_mbs_only_flag: 0 }, { bit_depth_luma_minus8: 2 }, { colour_primaries: 9 }, { profile_idc: 110 },
    { level_idc: 42 }, { pic_width_in_mbs_minus1: 250 }, { frame_crop_bottom_offset: 0 }, { time_scale: 0 }]) {
    assert.equal(headersValid([...section("Sequence Parameter Set", { ...sps, ...bad }), ...trace.slice(Object.keys(sps).length + 1)]), false, JSON.stringify(bad));
  }
  for (const missing of ["time_scale", "num_units_in_tick", "max_num_reorder_frames", "max_dec_frame_buffering", "frame_cropping_flag"]) {
    assert.equal(headersValid(trace.filter((line) => !line.includes(` ${missing} `))), false, missing);
  }
  assert.equal(headersValid([...trace, ...section("Sequence Parameter Set", { ...sps, aspect_ratio_idc: 2 })]), false);
});

test("IDR boundaries and B-frame runs are counted per picture, including multiple slices", () => {
  const base = [...section("Sequence Parameter Set", sps), ...section("Picture Parameter Set", pps)];
  assert.equal(headersValid([...base, ...picture(0, 2, true), ...picture(1, 1, false, 2), ...picture(2, 1, false, 2)]), true);
  assert.equal(headersValid([...base, ...picture(0, 2, true), ...picture(1, 1), ...picture(2, 1), ...picture(3, 1)]), false);
  assert.equal(headersValid(trace.map((line) => line.includes("nal_unit_type") ? line.replace("= 5", "= 1") : line)), false);
  assert.equal(headersValid([...base, ...Array.from({ length: 61 }, (_, i) => picture(i, i === 0 ? 2 : 0, i === 0)).flat()]), false);
  assert.equal(headersValid([...base, ...Array.from({ length: 61 }, (_, i) => picture(i, i % 60 === 0 ? 2 : 0, i % 60 === 0)).flat()]), true);
});

test("fractional FPS uses the rounded two-second GOP frame count", () => {
  const fractional = parseProbePayload(probeJson({ avg_frame_rate: "24000/1001", time_base: "1/24000" }));
  const base = [...section("Sequence Parameter Set", { ...sps, num_units_in_tick: 1001, time_scale: 48000 }), ...section("Picture Parameter Set", pps)];
  assert.equal(headersValid([...base, ...Array.from({ length: 49 }, (_, i) => picture(i, i % 48 === 0 ? 2 : 0, i % 48 === 0)).flat()], fractional), true);
});

test("packet inspection rejects bursts, invalid cadence, reordered timestamps and discard video", () => {
  for (const bad of [packets.map((line) => line.replace("size=100", "size=2000001")),
    packets.map((line) => line.replace("0.033333|size", "0.066667|size")),
    [packets[0]!, packets[0]!], packets.map((line) => line.replace("flags=K__", "flags=KD_")),
    packets.map((line) => line.replace("flags=___", "flags=__C")), packets.map((line) => line.replace("stream_index=0", "stream_index=9")),
    packets.map((line) => line.replace(/pts_time=[^|]+/, "pts_time=N/A"))]) assert.equal(packetsValid(bad), false);
  const coarse = { ...probe, timeBase: 1 };
  assert.equal(packetsValid(packets.map((line) => line.replace("0.033333|size", "0.066667|size")), coarse), false);
});

test("AAC priming is allowed while excessive audio bursts and extra streams fall back", () => {
  const audioProbe = parseProbePayload(probeJson({}, true));
  const audio = "stream_index=1|pts_time=-0.021333|dts_time=-0.021333|duration_time=0.021333|size=200|flags=KD_";
  assert.equal(packetsValid([audio, ...packets], audioProbe), true);
  assert.equal(packetsValid([audio.replace("size=200", "size=48001"), ...packets], audioProbe), false);
  assert.equal(packetsValid([audio.replace("stream_index=1", "stream_index=2"), ...packets], audioProbe), false);
});

function fakeRuntime(dir: string, failure?: string): { runtime: CliRuntime; calls: RunProcessRequest[]; snapshots: string[] } {
  const calls: RunProcessRequest[] = [], snapshots: string[] = [];
  let output = "";
  const runtime: CliRuntime = { argv: [], env: {}, stdout: new PassThrough(), stderr: new PassThrough(), now: () => new Date(),
    sleep: async () => {}, homedir: () => dir, cwd: () => dir, fs: {} as CliRuntime["fs"],
    runProcess: async (request) => {
      calls.push(request);
      const ok = { code: 0, signal: null, stdout: "", stderrTail: "" };
      if (request.args.includes("-show_packets")) {
        for (const line of failure === "bad-packets" ? packets.slice(0, 1) : packets) request.onStdoutLine?.(line);
        return { ...ok, stderrTail: failure === "probe-errors" ? "error while reading packet" : "" };
      }
      if (request.args.includes("trace_headers")) {
        for (const line of failure === "no-headers" ? [] : trace) request.onStderrLine?.(line);
        return { ...ok, timedOut: failure === "timeout" };
      }
      if (request.args.includes("-version")) return { ...ok, stdout: "ffmpeg version 8.1.2" };
      if (request.args.includes("-encoders")) return { ...ok, stdout: " V....D libx264 H.264\n V....D libx265 HEVC\n" };
      if (request.args.includes("-filters")) return { ...ok, stdout: " ... scale V->V Scale\n" };
      if (request.args.includes("-show_streams")) {
        const file = request.args.at(-1)!;
        if (file.includes("screenrig-inspect-")) snapshots.push(path.dirname(file));
        return { ...ok, stdout: probeJson({ level: file === output ? 42 : 41 }) };
      }
      output = request.args.at(-1)!;
      await writeFile(output, Buffer.from("encoded output"));
      return ok;
    } };
  return { runtime, calls, snapshots };
}

test("valid input skips the encoder, snapshots original bytes, and binds the upload hash", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("video-skip-");
  const source = path.join(dir, "external.mp4"), original = Buffer.from("original compressed video bytes");
  await writeFile(source, original);
  const { runtime, calls } = fakeRuntime(dir);
  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    assert.equal(result.passthrough, true);
    assert.equal(result.video?.level, "4.1");
    assert.equal(calls.some((call) => call.args.includes("-progress")), false);
    assert.notEqual(result.filePath, source);
    await writeFile(source, Buffer.from("source changed after inspection"));
    const prepared = await prepareMediaUpload(result.filePath, result.contentType, result.verifiedSha256);
    assert.deepEqual(prepared.bytes, original);
    assert.equal(prepared.declaration.sha256, result.verifiedSha256);
    assert.deepEqual(await readFile(result.filePath), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
  }
});

for (const failure of ["bad-packets", "probe-errors", "no-headers", "timeout"]) {
  test(`uncertain inspection falls back to encoding and removes its snapshot: ${failure}`, async () => {
    resetFfmpegToolchainCache();
    const dir = await testTemp("video-fallback-");
    const source = path.join(dir, "clip.mp4"); await writeFile(source, Buffer.from("source"));
    const { runtime, calls, snapshots } = fakeRuntime(dir, failure);
    const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
    try {
      assert.equal(result.passthrough, false);
      assert.equal(calls.filter((call) => call.args.includes("-progress")).length, 1);
      for (const snapshot of snapshots) await assert.rejects(() => stat(snapshot));
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
    }
  });
}
