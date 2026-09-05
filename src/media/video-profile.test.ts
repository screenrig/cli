import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgv } from "../argv.js";
import { transcodeOptionsFromArgs } from "../commands.js";
import { parseProbePayload } from "./ffmpeg.js";
import { boundedVideoSize, planVideoDelivery, validateVideoOutput, videoLevel, type VideoOptions } from "./video-profile.js";

const defaults: VideoOptions = { codec: "h264", maxFps: 30, maxEdge: 3840 };
function probe(video: Record<string, unknown> = {}, audio: Record<string, unknown> | false = {}) {
  return parseProbePayload(JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "h264", codec_tag_string: "avc1", profile: "High", level: 42,
      width: 1920, height: 1080, avg_frame_rate: "30/1", pix_fmt: "yuv420p", field_order: "progressive",
      color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", ...video },
      ...(audio === false ? [] : [{ codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, ...audio }])],
    format: { format_name: "mov,mp4,m4a", duration: "1" },
  }));
}

for (const [name, width, height, preset, expected] of [
  ["landscape", 3840, 2160, "signage-1080p30", [1920, 1080]],
  ["portrait", 2160, 3840, "signage-1080p30", [1080, 1920]],
  ["square 1080", 5000, 5000, "signage-1080p30", [1080, 1080]],
  ["square 4K", 5000, 5000, "signage-4k30", [2160, 2160]],
  ["ultrawide", 6000, 1000, "signage-4k30", [3840, 640]],
  ["odd aspect", 3841, 2160, "signage-4k30", [3840, 2158]],
  ["no upscale", 641, 481, "signage-1080p30", [640, 480]],
] as const) {
  test(`signage dimensions: ${name}`, () => {
    assert.deepEqual(boundedVideoSize(width, height, { ...defaults, preset }), { width: expected[0], height: expected[1] });
  });
}

test("default video pixel budget prevents a 3840-square decode surface", () => {
  const size = boundedVideoSize(3840, 3840, defaults);
  assert.equal(size.width, 2880);
  assert.equal(size.height, 2880);
  assert.ok(size.width * size.height <= 3840 * 2160);
});

test("explicit limits can tighten but never enlarge a preset", () => {
  const result = planVideoDelivery(probe({ width: 3840, height: 2160, avg_frame_rate: "60/1" }),
    { ...defaults, preset: "signage-1080p30", maxFps: 60, maxEdge: 1280 });
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal(result.fps, 30);
  assert.equal(planVideoDelivery(probe(), { ...defaults, preset: "signage-4k30", maxFps: 24 }).fps, 24);
});

test("H.264 level fits macroblocks, throughput and four DPB frames", () => {
  assert.equal(videoLevel("h264", 1920, 1080, 30).level, "4.2");
  assert.equal(videoLevel("h264", 3840, 2160, 30).level, "5.1");
  assert.equal(videoLevel("h264", 2160, 3840, 30).level, "5.1");
  assert.equal(videoLevel("h264", 3840, 2160, 60).level, "5.2");
  assert.equal(videoLevel("h264", 1920, 1080, 120).level, "5.1");
  assert.throws(() => videoLevel("h264", 3840, 2160, 120), /supported codec levels/);
  assert.throws(() => videoLevel("h264", 10000, 2, 1), /supported codec levels/);
});

test("HEVC levels retain the existing VBV-compatible floor and reject excess throughput", () => {
  assert.equal(videoLevel("hevc", 3840, 2160, 30).level, "5.1");
  assert.equal(videoLevel("hevc", 3840, 2160, 120).level, "5.2");
  assert.throws(() => videoLevel("hevc", 3840, 2160, 240), /supported codec levels/);
});

test("unusable geometry and rates fail before an encode", () => {
  for (const size of [[0, 1080], [1, 1080], [Infinity, 1080], [999999, 2]]) {
    assert.throws(() => boundedVideoSize(size[0]!, size[1]!, defaults));
  }
  for (const fps of [0, -1, Infinity, NaN]) assert.throws(() => videoLevel("h264", 1920, 1080, fps));
});

test("output read-back rejects stale levels and invalid delivery fields", () => {
  const delivery = planVideoDelivery(probe(), defaults);
  validateVideoOutput(probe(), delivery, defaults);
  for (const bad of [
    { level: 31 }, { profile: "High 10" }, { codec_name: "hevc" }, { codec_tag_string: "other" },
    { pix_fmt: "yuv420p10le" }, { field_order: "tt" }, { width: 1918 }, { width: 1921 },
    { width: 3840, height: 3840 }, { avg_frame_rate: "60/1" }, { color_transfer: "smpte2084" },
    { side_data_list: [{ rotation: 90 }] },
  ]) assert.throws(() => validateVideoOutput(probe(bad), delivery, defaults), /delivery validation/);
  assert.throws(() => validateVideoOutput(probe({}, { channels: 6 }), delivery, defaults), /audio/);
  assert.throws(() => validateVideoOutput(probe({}, false), delivery, defaults), /audio/);
});

test("silent delivery rejects unexpected audio; absent HEVC scan metadata stays unknown", () => {
  const options = { ...defaults, codec: "hevc" as const, noAudio: true };
  const source = probe({ codec_name: "hevc", codec_tag_string: "hvc1", profile: "Main", level: 153, field_order: "unknown" }, false);
  const delivery = planVideoDelivery(source, options);
  validateVideoOutput(source, delivery, options);
  assert.equal(source.fieldOrder, "", "the probe normalizes unavailable fields; the envelope reports unknown");
  assert.throws(() => validateVideoOutput({ ...source, hasAudio: true }, delivery, options), /audio/);
  assert.throws(() => validateVideoOutput({ ...source, fieldOrder: "tt" }, delivery, options), /progressive/);
});

test("signage flags parse without consuming positional files", () => {
  const args = parseArgv(["media", "upload", "clip.mov", "--preset", "signage-1080p30", "--no-audio"]);
  assert.equal(args.positionals.at(-1), "clip.mov");
  const options = transcodeOptionsFromArgs(args);
  assert.equal(options.preset, "signage-1080p30");
  assert.equal(options.noAudio, true);
  assert.equal(options.codec, "h264");
});
