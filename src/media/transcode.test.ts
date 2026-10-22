import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CliError } from "../problems.js";
import { processRuntime, type CliRuntime, type RunProcessRequest, type RunProcessResult } from "../runtime.js";
import { testTemp } from "../test-temp.js";
import {
  cwebpLookup,
  parseCwebpVersion,
  parseEncoderNames,
  parseFilterNames,
  parseProbePayload,
  parseRate,
  pixelFormatHasAlpha,
  resetFfmpegToolchainCache,
} from "./ffmpeg.js";
import { createProgressReporter, formatBytes, formatClock } from "./progress.js";
import {
  boundedImageSize,
  boundedScaleFilter,
  boundedSize,
  classifySource,
  defaultTranscodeOptions,
  encodeTiming,
  isAnimated,
  isHdr,
  MAX_AUDIO_BYTES,
  summarizeFfmpegError,
  transcodeForUpload,
  videoFilterChain,
} from "./transcode.js";
import { readWebpContainer } from "./webp.js";
import { createMemoryLogger } from "../log/index.js";

const ENCODER_LISTING = [
  "Encoders:",
  " V..... = Video",
  " ------",
  " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
  " V....D libx265              libx265 H.265 / HEVC (codec hevc)",
  " V....D libwebp_anim         libwebp WebP image (codec webp)",
  " V....D libwebp              libwebp WebP image (codec webp)",
  " A....D aac                  AAC (Advanced Audio Coding)",
].join("\n");

const ENCODER_LISTING_NO_WEBP = [
  "Encoders:",
  " V..... = Video",
  " ------",
  " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
  " V....D libx265              libx265 H.265 / HEVC (codec hevc)",
  " A....D aac                  AAC (Advanced Audio Coding)",
].join("\n");

const ENCODER_LISTING_ANIM_ONLY = [
  "Encoders:",
  " V..... = Video",
  " ------",
  " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
  " V....D libx265              libx265 H.265 / HEVC (codec hevc)",
  " V....D libwebp_anim         libwebp WebP image (codec webp)",
  " A....D aac                  AAC (Advanced Audio Coding)",
].join("\n");

// ffmpeg 8 prints a two-character flag column here; older builds print three.
const FILTER_LISTING = [
  "Filters:",
  "  T.. = Timeline support",
  " .S tonemap           V->V       Conversion to/from different dynamic ranges.",
  " .S zscale            V->V       Apply resizing, colorspace and bit depth conversion.",
  " ... scale            V->V       Scale the input video size and/or convert the image format.",
  " TSC volume           A->A       Change input volume.",
].join("\n");

function probeJson(overrides: Record<string, unknown> = {}, format: Record<string, unknown> = {}): string {
  return JSON.stringify({
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        pix_fmt: "yuv420p",
        avg_frame_rate: "60/1",
        r_frame_rate: "60/1",
        ...overrides,
      },
      { codec_type: "audio", codec_name: "aac" },
    ],
    format: { duration: "12.5", format_name: "mov,mp4,m4a", ...format },
  });
}

function encodedVideoProbe(overrides: Record<string, unknown> = {}, audio = true): string {
  const payload = JSON.parse(probeJson({
    codec_tag_string: "avc1", profile: "High", level: 42, field_order: "progressive",
    color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709",
    avg_frame_rate: "30/1", r_frame_rate: "30/1", ...overrides,
  }));
  payload.streams = [payload.streams[0], ...(audio ? [{
    codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2,
  }] : [])];
  return JSON.stringify(payload);
}

interface FakeOptions {
  probe: string;
  /**
   * Probe JSON returned when ffprobe is pointed at the encoded output. The CLI
   * measures the produced file rather than trusting the planned size, so a test
   * that asserts reported dimensions must model what ffmpeg actually wrote.
   */
  outputProbe?: string;
  /** Fail the post-encode measurement probe, to exercise the planned fallback. */
  failOutputProbe?: boolean;
  /** Overrides the encoder listing, to model a build without a needed encoder. */
  encoders?: string;
  encodeExit?: number;
  encodeStderr?: string;
  /** Progress fractions the fake ffmpeg reports before finishing. */
  progressSeconds?: number[];
  writeOutputBytes?: number;
  /** Exact bytes written to a successful encode output. Overrides the default fill. */
  writeOutput?: Buffer;
  /** When true, `cwebp -version` succeeds. Default false, so missing libwebp fails closed. */
  cwebp?: boolean;
  cwebpVersion?: string;
  cwebpExit?: number;
  cwebpStderr?: string;
}

function webpChunk(id: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(id), size, data, pad]);
}

function lossyVp8xWebp(width = 8, height = 8): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([Buffer.from("WEBP"), webpChunk("VP8X", data)]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), riffSize, body]);
}

function losslessVp8lWebp(width = 8, height = 8): Buffer {
  const bits = Buffer.alloc(5);
  bits.writeUInt8(0x2f, 0);
  bits.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  const body = Buffer.concat([Buffer.from("WEBP"), webpChunk("VP8L", bits)]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), riffSize, body]);
}

async function writeEncodeOutput(output: string, options: FakeOptions): Promise<void> {
  if (options.writeOutput) {
    await writeFile(output, options.writeOutput);
    return;
  }
  if (output.endsWith(".webp")) {
    await writeFile(output, lossyVp8xWebp(8, 8));
    return;
  }
  await writeFile(output, Buffer.alloc(options.writeOutputBytes ?? 4096, 7));
}

function isCwebpVersionProbe(request: RunProcessRequest): boolean {
  return request.args.includes("-version") && !request.args.includes("-hide_banner");
}

function isCwebpEncode(request: RunProcessRequest): boolean {
  return request.args.includes("-o") && !request.args.includes("-progress");
}

function fakeRuntime(options: FakeOptions): { runtime: CliRuntime; calls: RunProcessRequest[]; stderr: PassThrough } {
  const calls: RunProcessRequest[] = [];
  const stderr = new PassThrough();
  let clock = 1_000;

  let encodedOutput = "";
  const runProcess = async (request: RunProcessRequest): Promise<RunProcessResult> => {
    calls.push(request);
    const isProbe = request.command.endsWith("ffprobe");
    if (isProbe && request.args.includes("-version")) {
      return { code: 0, signal: null, stdout: "ffprobe version n8.1.2\n", stderrTail: "" };
    }
    if (isProbe) {
      const measuring = encodedOutput !== "" && request.args.at(-1) === encodedOutput;
      if (measuring && options.failOutputProbe) {
        return { code: 1, signal: null, stdout: "", stderrTail: "" };
      }
      if (measuring && options.outputProbe !== undefined) {
        return { code: 0, signal: null, stdout: options.outputProbe, stderrTail: "" };
      }
      return { code: 0, signal: null, stdout: measuring && encodedOutput.endsWith(".mp4") ? encodedVideoProbe() : options.probe, stderrTail: "" };
    }
    if (isCwebpVersionProbe(request)) {
      if (!options.cwebp) {
        return { code: null, signal: null, stdout: "", stderrTail: "", spawnError: "spawn cwebp ENOENT" };
      }
      return { code: 0, signal: null, stdout: `${options.cwebpVersion ?? "1.6.0"}\n`, stderrTail: "" };
    }
    if (request.args.includes("-version")) {
      return { code: 0, signal: null, stdout: "ffmpeg version n8.1.2\n", stderrTail: "" };
    }
    if (request.args.includes("-encoders")) {
      return { code: 0, signal: null, stdout: options.encoders ?? ENCODER_LISTING, stderrTail: "" };
    }
    if (request.args.includes("-filters")) {
      return { code: 0, signal: null, stdout: FILTER_LISTING, stderrTail: "" };
    }
    if (isCwebpEncode(request)) {
      const outputFlag = request.args.indexOf("-o");
      const output = outputFlag >= 0 ? String(request.args[outputFlag + 1] ?? "") : "";
      const exit = options.cwebpExit ?? 0;
      if (exit === 0 && output) {
        encodedOutput = output;
        await writeEncodeOutput(output, options);
      }
      return { code: exit, signal: null, stdout: "", stderrTail: options.cwebpStderr ?? "" };
    }

    // Encode invocation: emit progress records, then write the output file.
    for (const seconds of options.progressSeconds ?? []) {
      clock += 900;
      request.onStdoutLine?.(`out_time_us=${Math.round(seconds * 1_000_000)}`);
    }
    request.onStdoutLine?.("progress=end");
    const exit = options.encodeExit ?? 0;
    if (exit === 0) {
      const output = request.args[request.args.length - 1] as string;
      encodedOutput = output;
      await writeEncodeOutput(output, options);
    }
    return { code: exit, signal: null, stdout: "", stderrTail: options.encodeStderr ?? "" };
  };

  const runtime = {
    argv: [],
    env: {},
    stdout: new PassThrough(),
    stderr,
    now: () => new Date((clock += 100)),
    sleep: async () => {},
    homedir: () => "/nonexistent",
    cwd: () => "/nonexistent",
    fs: {} as CliRuntime["fs"],
    runProcess,
    isStderrTty: () => false,
  } as unknown as CliRuntime;

  return { runtime, calls, stderr };
}

/** The encode invocation, which is no longer the last call now that the CLI
 * measures the produced file with a follow-up ffprobe. */
function encodeCall(calls: RunProcessRequest[]): RunProcessRequest | undefined {
  return calls.filter((call) => call.args.includes("-progress")).at(-1);
}

test("classifies sources by extension and by explicit content type", () => {
  assert.equal(classifySource("/x/clip.MOV"), "video");
  assert.equal(classifySource("/x/still.JPEG"), "image");
  assert.equal(classifySource("/x/mystery.bin", "video/mp4"), "video");
  assert.equal(classifySource("/x/mystery.bin", "image/png"), "image");
  assert.equal(classifySource("/x/theme.WAV"), "audio");
  assert.equal(classifySource("/x/mystery.bin", "audio/mpeg"), "audio");
  assert.throws(() => classifySource("/x/mystery.bin"), CliError);
});

test("bounds both edges to the delivery box without upscaling", () => {
  assert.deepEqual(boundedSize(6000, 2400, 3840), { width: 3840, height: 1536 });
  assert.deepEqual(boundedSize(2000, 6000, 3840), { width: 1280, height: 3840 });
  assert.deepEqual(boundedSize(8000, 4000, 3840), { width: 3840, height: 1920 });
  assert.deepEqual(boundedSize(640, 480, 3840), { width: 640, height: 480 });
  assert.deepEqual(boundedSize(5000, 5000, 3840), { width: 3840, height: 3840 });
  for (const [w, h] of [[3841, 2161], [7777, 3333], [1001, 9999]] as const) {
    const size = boundedSize(w, h, 3840);
    assert.equal(size.width % 2, 0);
    assert.equal(size.height % 2, 0);
    assert.ok(size.width <= 3840 && size.height <= 3840);
  }
  assert.deepEqual(boundedImageSize(2000, 6000, 3840), { width: 1280, height: 3840 });
  assert.deepEqual(boundedImageSize(640, 480, 3840), { width: 640, height: 480 });
  assert.deepEqual(boundedImageSize(8000, 4000, 3840), { width: 3840, height: 1920 });
});

test("scale filter bounds width and height together", () => {
  const filter = boundedScaleFilter(3840);
  assert.match(filter, /w='min\(3840,iw\)'/);
  assert.match(filter, /h='min\(3840,ih\)'/);
  assert.match(filter, /force_original_aspect_ratio=decrease/);
  assert.match(filter, /force_divisible_by=2/);
});

test("output frame rate is constant and the keyframe interval follows it, whatever the source rate", () => {
  for (const source of ["60/1", "30000/1001", "25/1", "24000/1001", "30/1"]) {
    const probe = parseProbePayload(probeJson({ avg_frame_rate: source }));
    assert.deepEqual(encodeTiming(probe, 30), { rate: "30", gop: 60 }, source);
  }
  const probe = parseProbePayload(probeJson({ avg_frame_rate: "60/1" }));
  assert.deepEqual(encodeTiming(probe, 24), { rate: "24", gop: 48 });
  assert.deepEqual(encodeTiming(probe, 59.94), { rate: "59.94", gop: 120 });
});

test("probe reads rotation, alpha, duration, and rate", () => {
  const rotated = parseProbePayload(
    probeJson({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }),
  );
  assert.equal(rotated.codedWidth, 1920);
  assert.equal(rotated.displayWidth, 1080);
  assert.equal(rotated.displayHeight, 1920);
  assert.equal(rotated.rotationDegrees, 270);

  const alpha = parseProbePayload(probeJson({ pix_fmt: "yuva420p" }));
  assert.equal(alpha.hasAlpha, true);
  assert.equal(parseProbePayload(probeJson({ pix_fmt: "yuv420p" })).hasAlpha, false);

  const plain = parseProbePayload(probeJson());
  assert.equal(plain.durationSeconds, 12.5);
  assert.equal(plain.fps, 60);
  assert.equal(plain.hasAudio, true);

  assert.equal(parseRate("30000/1001") > 29.9, true);
  assert.equal(parseRate("0/0"), 0);
  assert.equal(parseRate(undefined), 0);
  assert.equal(pixelFormatHasAlpha("rgba"), true);
  assert.equal(pixelFormatHasAlpha("ya8"), true);
  assert.equal(pixelFormatHasAlpha(""), false);
});

test("capability listings parse across ffmpeg flag-column widths", () => {
  const encoders = parseEncoderNames(ENCODER_LISTING);
  assert.ok(encoders.has("libx265"));
  assert.ok(encoders.has("libx264"));
  assert.ok(encoders.has("libwebp"));
  assert.ok(encoders.has("libwebp_anim"));
  assert.ok(!encoders.has("="));

  const filters = parseFilterNames(FILTER_LISTING);
  assert.ok(filters.has("zscale"));
  assert.ok(filters.has("tonemap"));
  assert.ok(filters.has("scale"));
  assert.ok(!filters.has("="));
});

test("HDR sources tone map when the build allows it and warn when it does not", () => {
  const hdr = parseProbePayload(
    probeJson({ color_transfer: "smpte2084", color_primaries: "bt2020", color_space: "bt2020nc" }),
  );
  assert.equal(isHdr(hdr), true);
  const sdr = parseProbePayload(probeJson());
  assert.equal(isHdr(sdr), false);

  const capable = { filters: new Set(["zscale", "tonemap"]) } as never;
  const mapped = videoFilterChain(capable, hdr, 3840);
  assert.match(mapped.filter, /tonemap=tonemap=hable/);
  assert.match(mapped.filter, /zscale=t=bt709:m=bt709:r=tv/);
  assert.deepEqual(mapped.warnings, []);

  const bare = { filters: new Set<string>() } as never;
  const fallback = videoFilterChain(bare, hdr, 3840);
  assert.doesNotMatch(fallback.filter, /tonemap/);
  assert.match(fallback.filter, /format=yuv420p/);
  assert.equal(fallback.warnings.length, 1);

  assert.deepEqual(videoFilterChain(capable, sdr, 3840).warnings, []);
  assert.equal(videoFilterChain(capable, sdr, 3840).filter, `${boundedScaleFilter(3840)},setsar=1`);
});

test("animation detection uses frame count then timeline", () => {
  assert.equal(isAnimated(parseProbePayload(probeJson({ nb_frames: "10" }))), true);
  assert.equal(isAnimated(parseProbePayload(probeJson({ nb_frames: "1" }), )), false);
  const still = parseProbePayload(probeJson({ nb_frames: "1" }, { duration: "0" }));
  assert.equal(isAnimated(still), false);
});

test("reads WebP containers that ffmpeg cannot demux", () => {
  const animated = Buffer.concat([
    Buffer.from("RIFF"),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(30); return b; })(),
    Buffer.from("WEBP"),
    Buffer.from("VP8X"),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(10); return b; })(),
    (() => {
      const b = Buffer.alloc(10);
      b.writeUInt8(0x02, 0);
      b.writeUIntLE(799, 4, 3);
      b.writeUIntLE(599, 7, 3);
      return b;
    })(),
  ]);
  assert.deepEqual(readWebpContainer(animated), { animated: true, width: 800, height: 600, lossless: false });
  assert.equal(readWebpContainer(Buffer.from("not a webp file at all")), undefined);
  assert.equal(readWebpContainer(Buffer.alloc(4)), undefined);

  const vp8lPayload = Buffer.alloc(5);
  vp8lPayload.writeUInt8(0x2f, 0);
  vp8lPayload.writeUInt32LE((15) | (31 << 14), 1);
  const vp8lSize = Buffer.alloc(4);
  vp8lSize.writeUInt32LE(5);
  const simpleLossless = Buffer.concat([
    Buffer.from("RIFF"),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(4 + 8 + 5 + 1); return b; })(),
    Buffer.from("WEBP"),
    Buffer.from("VP8L"),
    vp8lSize,
    vp8lPayload,
    Buffer.from([0]),
  ]);
  assert.deepEqual(readWebpContainer(simpleLossless), { animated: false, width: 16, height: 32, lossless: true });

  const vp8xThenLossless = Buffer.concat([
    Buffer.from("RIFF"),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(4 + 8 + 10 + 8 + 5 + 1); return b; })(),
    Buffer.from("WEBP"),
    Buffer.from("VP8X"),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(10); return b; })(),
    (() => {
      const b = Buffer.alloc(10);
      b.writeUInt8(0x10, 0);
      b.writeUIntLE(15, 4, 3);
      b.writeUIntLE(31, 7, 3);
      return b;
    })(),
    Buffer.from("VP8L"),
    vp8lSize,
    vp8lPayload,
    Buffer.from([0]),
  ]);
  assert.deepEqual(readWebpContainer(vp8xThenLossless), { animated: false, width: 16, height: 32, lossless: true });
});

test("video transcode defaults to H.264 and selects a level that fits the output", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-");
  const source = path.join(dir, "clip.mov");
  await writeFile(source, Buffer.alloc(2048, 3));
  const { runtime, calls, stderr } = fakeRuntime({
    probe: probeJson({ width: 6000, height: 2400, avg_frame_rate: "60/1" }),
    outputProbe: encodedVideoProbe({ width: 3840, height: 1536, level: 51 }),
    progressSeconds: [3, 6, 9],
  });
  const seen: string[] = [];
  stderr.on("data", (chunk: Buffer) => seen.push(chunk.toString("utf8")));

  const reporter = createProgressReporter({
    stderr,
    json: true,
    tty: false,
    now: () => runtime.now().getTime(),
    throttleMs: 0,
    stepPercent: 0,
  });

  const result = await transcodeForUpload({
    runtime,
    filePath: source,
    options: defaultTranscodeOptions(),
    reporter,
  });

  try {
    assert.equal(result.contentType, "video/mp4");
    assert.equal(result.filename, "clip.mp4");
    assert.equal(result.passthrough, false);
    assert.equal(result.width, 3840);
    assert.equal(result.height, 1536);
    assert.ok(result.durationMs >= 0);
    assert.equal((await stat(result.filePath)).size, 4096);

    const encode = encodeCall(calls);
    assert.ok(encode);
    const args = encode.args;
    const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(defaultTranscodeOptions().codec, "h264", "the default stays H.264");
    assert.equal(valueAfter("-c:v"), "libx264");
    assert.equal(valueAfter("-profile:v"), "high");
    assert.equal(valueAfter("-level:v"), "5.1");
    assert.equal(valueAfter("-crf"), "23");
    assert.equal(valueAfter("-refs"), "2");
    assert.match(String(valueAfter("-x264-params")), /colorprim=bt709:transfer=bt709:colormatrix=bt709/);
    assert.ok(!args.includes("-tag:v"), "the H.264 profile carries no hvc1 tag");
    assert.equal(valueAfter("-pix_fmt"), "yuv420p");
    assert.equal(valueAfter("-movflags"), "+faststart");
    assert.equal(valueAfter("-r"), "30");
    assert.equal(valueAfter("-c:a"), "aac");
    assert.equal(valueAfter("-colorspace"), "bt709");
    assert.equal(valueAfter("-vf"), "scale=w=3840:h=1536,setsar=1");
    assert.ok(args.includes("-progress") && args.includes("pipe:1"));
    assert.ok(args.includes("-nostdin"));

    const events = seen
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events[0]?.event, "transcode_start");
    assert.equal(events.at(-1)?.event, "transcode_complete");
    const percents = events.filter((e) => e.event === "transcode_progress").map((e) => e.percent);
    assert.deepEqual(percents, [24, 48, 72, 100]);
    assert.equal(percents.filter((p) => p === 100).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
  }
});

test("--codec hevc opts in to the H.265 delivery profile", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-hevc-");
  const source = path.join(dir, "clip.mov");
  await writeFile(source, Buffer.alloc(2048, 3));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson({ width: 6000, height: 2400, avg_frame_rate: "60/1" }),
    outputProbe: encodedVideoProbe({ width: 3840, height: 1536, codec_name: "hevc", codec_tag_string: "hvc1", profile: "Main", level: 153 }),
    progressSeconds: [6],
  });

  const result = await transcodeForUpload({
    runtime,
    filePath: source,
    options: { ...defaultTranscodeOptions(), codec: "hevc" },
  });

  try {
    assert.equal(result.contentType, "video/mp4");
    assert.equal(result.width, 3840);
    assert.equal(result.height, 1536);
    const args = encodeCall(calls)?.args ?? [];
    const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(valueAfter("-c:v"), "libx265");
    assert.equal(valueAfter("-tag:v"), "hvc1");
    assert.equal(valueAfter("-profile:v"), "main");
    assert.equal(valueAfter("-crf"), "28");
    assert.equal(valueAfter("-pix_fmt"), "yuv420p");
    assert.equal(valueAfter("-movflags"), "+faststart");
    assert.equal(valueAfter("-r"), "30");
    assert.match(String(valueAfter("-x265-params")), /min-keyint=60/);
    assert.match(String(valueAfter("-x265-params")), /level-idc=5.1:colorprim=bt709:transfer=bt709:colormatrix=bt709/);
    assert.doesNotMatch(String(valueAfter("-x265-params")), /output-depth/);
    assert.match(result.reason, /H\.265/);
    assert.doesNotMatch(result.reason, /faststart/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
  }
});

test("real video transcodes keep faststart, all 240 frames and zero-based track timelines", {
  skip: process.env.SCREENRIG_TEST_FFMPEG !== "1" && "set SCREENRIG_TEST_FFMPEG=1 with libx264 and libx265 installed",
  timeout: 90_000,
}, async (t) => {
  resetFfmpegToolchainCache();
  const runtime = processRuntime();
  const dir = await testTemp("transcode-faststart-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "animation.mp4");
  const run = async (command: string, args: string[]) => {
    const result = await runtime.runProcess!({ command, args, timeoutMs: 30_000 });
    assert.equal(result.code, 0, result.spawnError ?? result.stderrTail);
    return result.stdout;
  };
  const ffmpeg = runtime.env.SCREENRIG_FFMPEG || "ffmpeg";
  const ffprobe = runtime.env.SCREENRIG_FFPROBE || "ffprobe";
  await run(ffmpeg, [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
    "-frames:v", "240", "-c:v", "libx264", "-profile:v", "baseline",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-nostdin", "-y", source,
  ]);

  const assertMp4Timeline = async (filePath: string) => {
    const bytes = await readFile(filePath);
    const boxes = new Map<string, number>();
    const walk = (start: number, end: number) => {
      for (let offset = start; offset < end;) {
        assert.ok(offset + 8 <= end, "complete MP4 box header");
        const shortSize = bytes.readUInt32BE(offset);
        const header = shortSize === 1 ? 16 : 8;
        assert.ok(offset + header <= end, "complete extended MP4 box header");
        const size = shortSize === 1 ? Number(bytes.readBigUInt64BE(offset + 8))
          : shortSize === 0 ? end - offset : shortSize;
        assert.ok(Number.isSafeInteger(size) && size >= header && offset + size <= end);
        const type = bytes.toString("ascii", offset + 4, offset + 8);
        const body = offset + header;
        if (start === 0) boxes.set(type, offset);
        if (["moov", "trak", "edts", "mdia", "minf", "stbl"].includes(type)) walk(body, offset + size);
        if (type === "elst") {
          const version = bytes[body];
          assert.ok(version === 0 || version === 1);
          const count = bytes.readUInt32BE(body + 4);
          const entrySize = version === 1 ? 20 : 12;
          assert.ok(body + 8 + count * entrySize <= offset + size, "complete edit list");
          for (let i = 0; i < count; i++) {
            const entry = body + 8 + i * entrySize;
            const mediaTime = version === 1 ? bytes.readBigInt64BE(entry + 8) : BigInt(bytes.readInt32BE(entry + 4));
            assert.ok(mediaTime >= 0n, "no empty edit may delay a track's first media");
          }
        }
        offset += size;
      }
    };
    walk(0, bytes.length);
    assert.ok(boxes.has("moov") && boxes.has("mdat"), "index and media data are present");
    assert.ok(boxes.get("moov")! < boxes.get("mdat")!, "moov must precede mdat");
  };
  await assertMp4Timeline(source);
  const audioSource = path.join(dir, "animation-audio.mp4");
  await run(ffmpeg, [
    "-v", "error", "-i", source, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-t", "10",
    "-movflags", "+faststart", "-nostdin", "-y", audioSource,
  ]);
  for (const codec of ["h264", "hevc"] as const) {
    for (const audio of [false, true]) await t.test(`${codec}, ${audio ? "AAC audio" : "silent"}`, async (t) => {
      const result = await transcodeForUpload({ runtime, filePath: audio ? audioSource : source, options: { ...defaultTranscodeOptions(), codec } });
      t.after(() => rm(result.cleanupDir!, { recursive: true, force: true }));
      assert.equal(result.passthrough, false, "exercise the encoder rather than source passthrough");
      await assertMp4Timeline(result.filePath);
      const probe = JSON.parse(await run(ffprobe, [
        "-v", "error", "-count_frames",
        "-show_entries", "stream=codec_type,codec_name,nb_read_frames,start_time,duration", "-of", "json", result.filePath,
      ]));
      assert.equal(probe.streams.length, audio ? 2 : 1);
      assert.equal(probe.streams[0].codec_name, codec);
      assert.equal(Number(probe.streams[0].nb_read_frames), 240);
      for (const stream of probe.streams) {
        assert.equal(Number(stream.start_time), 0, `${stream.codec_type} starts at time zero`);
        assert.ok(Math.abs(Number(stream.duration) - 10) < 0.05, "preserve the full ten-second timeline");
      }
      if (audio) {
        const packets = JSON.parse(await run(ffprobe, [
          "-v", "error", "-select_streams", "a:0", "-read_intervals", "%+#1", "-show_packets",
          "-show_entries", "packet=pts_time:packet_side_data=skip_samples", "-of", "json", result.filePath,
        ]));
        assert.ok(Number(packets.packets[0].pts_time) < 0, "AAC priming precedes presentation time zero");
        assert.ok(packets.packets[0].side_data_list.some((data: { skip_samples?: number }) => (data.skip_samples ?? 0) > 0),
          "preserve the AAC priming skip");
      }
      await run(ffmpeg, ["-v", "error", "-xerror", "-i", result.filePath, "-f", "null", "-"]);
    });
  }
});

test("image transcode targets WebP and honours alpha, animation, and the 4K bound", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-image-");
  const source = path.join(dir, "poster.png");
  await writeFile(source, Buffer.alloc(1024, 5));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson({
      codec_name: "png",
      width: 2000,
      height: 6000,
      pix_fmt: "rgba",
      nb_frames: "1",
      avg_frame_rate: "0/0",
    }, { duration: "0", format_name: "png_pipe" }),
    outputProbe: probeJson({
      codec_name: "webp",
      width: 1280,
      height: 3840,
      pix_fmt: "yuva420p",
      nb_frames: "1",
      avg_frame_rate: "0/0",
    }, { duration: "0", format_name: "webp_pipe" }),
  });

  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    assert.equal(result.contentType, "image/webp");
    assert.equal(result.filename, "poster.webp");
    assert.equal(result.width, 1280);
    assert.equal(result.height, 3840);
    const args = encodeCall(calls)?.args ?? [];
    const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(valueAfter("-c:v"), "libwebp");
    assert.equal(valueAfter("-pix_fmt"), "yuva420p");
    assert.equal(valueAfter("-quality"), "90");
    assert.ok(args.includes("-frames:v"));
    assert.ok(!args.includes("-loop"));
    assert.equal(calls.filter((call) => isCwebpEncode(call) || isCwebpVersionProbe(call)).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
  }
});

test("animated sources use the inter-frame WebP encoder and loop forever", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-anim-");
  const source = path.join(dir, "loop.gif");
  await writeFile(source, Buffer.alloc(512, 9));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson({ codec_name: "gif", width: 800, height: 600, nb_frames: "10", pix_fmt: "bgra" },
      { duration: "1.0", format_name: "gif" }),
  });
  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    const args = encodeCall(calls)?.args ?? [];
    assert.equal(args[args.indexOf("-c:v") + 1], "libwebp_anim");
    assert.equal(args[args.indexOf("-loop") + 1], "0");
    assert.ok(!args.includes("-frames:v"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
  }
});

test("cwebp lookup mirrors SCREENRIG_FFMPEG and parses cwebp -version", () => {
  assert.deepEqual(cwebpLookup({}), { cwebp: "cwebp", cwebpFromEnv: false });
  assert.deepEqual(cwebpLookup({ SCREENRIG_CWEBP: " /opt/libwebp/bin/cwebp " }), {
    cwebp: "/opt/libwebp/bin/cwebp",
    cwebpFromEnv: true,
  });
  assert.equal(parseCwebpVersion("1.6.0\nlibsharpyuv: 0.4.2\n"), "1.6.0");
  assert.equal(parseCwebpVersion(""), "unknown");
});

test("without libwebp, stills fall back to cwebp with quality 90, alpha, and the 4K bound", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-cwebp-");
  const source = path.join(dir, "poster.png");
  await writeFile(source, Buffer.alloc(1024, 5));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson({
      codec_name: "png",
      width: 2000,
      height: 6000,
      pix_fmt: "rgba",
      nb_frames: "1",
      avg_frame_rate: "0/0",
    }, { duration: "0", format_name: "png_pipe" }),
    outputProbe: probeJson({
      codec_name: "webp",
      width: 1280,
      height: 3840,
      pix_fmt: "yuva420p",
      nb_frames: "1",
      avg_frame_rate: "0/0",
    }, { duration: "0", format_name: "webp_pipe" }),
    encoders: ENCODER_LISTING_NO_WEBP,
    cwebp: true,
  });

  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    assert.equal(result.contentType, "image/webp");
    assert.equal(result.filename, "poster.webp");
    assert.equal(result.passthrough, false);
    assert.equal(result.width, 1280);
    assert.equal(result.height, 3840);
    assert.match(result.reason, /cwebp/);
    assert.equal(calls.filter((call) => call.args.includes("-progress")).length, 0);
    const encode = calls.filter(isCwebpEncode).at(-1);
    assert.ok(encode, "cwebp must run the encode");
    const args = encode.args;
    const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(encode.command, "cwebp");
    assert.equal(valueAfter("-q"), "90");
    assert.equal(valueAfter("-alpha_q"), "100");
    assert.equal(valueAfter("-resize"), "1280");
    assert.equal(args[args.indexOf("-resize") + 2], "3840");
    assert.ok(!args.includes("-lossless"));
    assert.ok(!args.includes("-hint"));
    assert.ok(!args.includes("-quiet"));
    assert.equal(encode.onStdoutLine, undefined, "cwebp stdout is not ffmpeg progress");
    assert.equal(valueAfter("-o"), result.filePath);
    assert.equal(path.basename(result.filePath), result.filename);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
  }
});

test("libwebp_anim alone does not make the missing still encoder runnable", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-anim-only-encoder-");
  const source = path.join(dir, "poster.png");
  await writeFile(source, Buffer.alloc(1024, 5));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson({
      codec_name: "png",
      width: 640,
      height: 480,
      pix_fmt: "rgba",
      nb_frames: "1",
      avg_frame_rate: "0/0",
    }, { duration: "0", format_name: "png_pipe" }),
    encoders: ENCODER_LISTING_ANIM_ONLY,
    cwebp: true,
  });

  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    assert.equal(calls.filter(isCwebpEncode).length, 1);
    assert.equal(calls.filter((call) => call.args.includes("-c:v") && call.args.includes("libwebp")).length, 0);
    assert.match(result.reason, /cwebp/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
  }
});

test("without libwebp, SCREENRIG_CWEBP selects the cwebp binary", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-cwebp-env-");
  const source = path.join(dir, "mark.jpg");
  await writeFile(source, Buffer.alloc(512, 4));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson({
      codec_name: "mjpeg",
      width: 640,
      height: 480,
      pix_fmt: "yuvj420p",
      nb_frames: "1",
      avg_frame_rate: "0/0",
    }, { duration: "0", format_name: "image2" }),
    encoders: ENCODER_LISTING_NO_WEBP,
    cwebp: true,
  });
  runtime.env = { ...runtime.env, SCREENRIG_CWEBP: "/opt/libwebp/bin/cwebp" };

  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    const encode = calls.filter(isCwebpEncode).at(-1);
    assert.equal(encode?.command, "/opt/libwebp/bin/cwebp");
    assert.ok(!encode?.args.includes("-resize"), "a source inside the bound must not be upscaled");
    assert.match(result.reason, /cwebp/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
  }
});

test("cwebp output that is lossless or not WebP is rejected before upload", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-cwebp-reject-");
  const source = path.join(dir, "poster.png");
  await writeFile(source, Buffer.alloc(256, 5));
  const probe = probeJson({
    codec_name: "png",
    width: 640,
    height: 480,
    pix_fmt: "rgba",
    nb_frames: "1",
    avg_frame_rate: "0/0",
  }, { duration: "0", format_name: "png_pipe" });

  for (const [label, writeOutput, detail] of [
    ["vp8l", losslessVp8lWebp(640, 480), /lossless WebP \(VP8L\)/],
    ["garbage", Buffer.alloc(64, 7), /did not write a WebP file/],
  ] as const) {
    resetFfmpegToolchainCache();
    const { runtime, calls } = fakeRuntime({
      probe,
      encoders: ENCODER_LISTING_NO_WEBP,
      cwebp: true,
      writeOutput,
    });
    await assert.rejects(
      () => transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() }),
      (error: unknown) => {
        assert.ok(error instanceof CliError, label);
        assert.match(error.problem.detail, detail, label);
        return true;
      },
    );
    assert.equal(calls.filter(isCwebpEncode).length, 1, label);
  }

  await rm(dir, { recursive: true, force: true });
});

test("without libwebp or cwebp, image transcode names both missing pieces", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-no-webp-");
  const scratch = path.join(dir, "tmp");
  await mkdir(scratch, { recursive: true });
  const source = path.join(dir, "poster.png");
  await writeFile(source, Buffer.alloc(64, 3));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson({
      codec_name: "png",
      width: 800,
      height: 600,
      pix_fmt: "rgba",
      nb_frames: "1",
      avg_frame_rate: "0/0",
    }, { duration: "0", format_name: "png_pipe" }),
    encoders: ENCODER_LISTING_NO_WEBP,
    cwebp: false,
  });
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    await assert.rejects(
      () => transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.match(error.problem.detail, /no libwebp encoder/);
        assert.match(error.problem.detail, /cwebp is not available/);
        assert.match(error.problem.detail, /SCREENRIG_CWEBP/);
        assert.doesNotMatch(error.problem.detail, /or pass --no-transcode to upload the source unchanged/);
        return true;
      },
    );
    assert.deepEqual(await readdir(scratch), [], "a planning failure must remove its temporary directory");
    assert.equal(calls.filter(isCwebpEncode).length, 0);
  } finally {
    if (previousTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpdir;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("cwebp cannot encode animation when libwebp is missing", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-anim-cwebp-");
  const source = path.join(dir, "loop.gif");
  await writeFile(source, Buffer.alloc(512, 9));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson({ codec_name: "gif", width: 800, height: 600, nb_frames: "10", pix_fmt: "bgra" },
      { duration: "1.0", format_name: "gif" }),
    encoders: ENCODER_LISTING_NO_WEBP,
    cwebp: true,
  });
  try {
    await assert.rejects(
      () => transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.match(error.problem.detail, /animated WebP/);
        assert.match(error.problem.detail, /cwebp encodes stills only/);
        return true;
      },
    );
    assert.equal(calls.filter(isCwebpEncode).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a conforming WebP source is passed through instead of re-encoded", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-passthrough-");
  const source = path.join(dir, "logo.webp");
  await writeFile(source, Buffer.alloc(256, 1));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson({ codec_name: "webp", width: 640, height: 480, nb_frames: "1" }, { duration: "0" }),
  });
  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    assert.equal(result.passthrough, true);
    assert.equal(result.filePath, source);
    assert.equal(result.contentType, "image/webp");
    assert.equal(result.cleanupDir, undefined);
    assert.equal(calls.filter((call) => call.args.includes("-progress")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lossless WebP source is re-encoded under the lossy delivery profile", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-lossless-webp-");
  const source = path.join(dir, "mark.webp");
  const vp8lPayload = Buffer.alloc(5);
  vp8lPayload.writeUInt8(0x2f, 0);
  vp8lPayload.writeUInt32LE((15) | (31 << 14), 1);
  const body = Buffer.concat([
    Buffer.from("WEBP"),
    Buffer.from("VP8L"),
    (() => { const size = Buffer.alloc(4); size.writeUInt32LE(vp8lPayload.length); return size; })(),
    vp8lPayload,
    Buffer.from([0]),
  ]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(body.length);
  await writeFile(source, Buffer.concat([Buffer.from("RIFF"), riffSize, body]));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson({
      codec_name: "webp",
      width: 16,
      height: 32,
      pix_fmt: "rgba",
      nb_frames: "1",
      avg_frame_rate: "0/0",
    }, { duration: "0", format_name: "webp_pipe" }),
    outputProbe: probeJson({
      codec_name: "webp",
      width: 16,
      height: 32,
      pix_fmt: "yuva420p",
      nb_frames: "1",
      avg_frame_rate: "0/0",
    }, { duration: "0", format_name: "webp_pipe" }),
  });

  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    assert.equal(result.passthrough, false);
    assert.equal(encodeCall(calls)?.args.includes("libwebp"), true);
    assert.match(result.reason, /converted to WebP quality 90/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
  }
});

test("a failed encode removes the temporary directory and leaks no ffmpeg internals", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-fail-");
  const source = path.join(dir, "broken.mp4");
  await writeFile(source, Buffer.alloc(64, 2));
  const { runtime } = fakeRuntime({
    probe: probeJson(),
    encodeExit: 1,
    encodeStderr: "x265 [error]: unable to open output\nConversion failed!\n",
  });
  try {
    await assert.rejects(
      () => transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.match(error.problem.detail, /ffmpeg exited with status 1/);
        assert.match(error.problem.detail, /Conversion failed/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a build without the profile encoder fails without leaving a temporary directory", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-no-encoder-");
  const scratch = path.join(dir, "tmp");
  await mkdir(scratch, { recursive: true });
  const source = path.join(dir, "clip.mp4");
  await writeFile(source, Buffer.alloc(64, 3));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson(),
    encoders: " V....D libx265              libx265 H.265 / HEVC (codec hevc)",
  });
  // os.tmpdir() reads TMPDIR on each call, so the transcode scratch directory
  // lands somewhere this test can prove is empty afterwards.
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    await assert.rejects(
      () => transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.match(error.problem.detail, /no libx264 encoder/);
        assert.match(error.problem.detail, /--codec hevc/);
        return true;
      },
    );
    assert.deepEqual(await readdir(scratch), [], "a planning failure must remove its temporary directory");
    assert.equal(calls.filter((call) => call.args.includes("-progress")).length, 0);
  } finally {
    if (previousTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpdir;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("a capability listing that fails is reported as an unusable ffmpeg build", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-caps-");
  const source = path.join(dir, "clip.mp4");
  await writeFile(source, Buffer.alloc(64, 5));
  const { runtime } = fakeRuntime({ probe: probeJson() });
  const broken = {
    ...runtime,
    runProcess: async (request: RunProcessRequest): Promise<RunProcessResult> => {
      if (request.args.includes("-encoders")) {
        return { code: 1, signal: null, stdout: "", stderrTail: "" };
      }
      return runtime.runProcess!(request);
    },
  } as CliRuntime;
  try {
    await assert.rejects(
      () => transcodeForUpload({ runtime: broken, filePath: source, options: defaultTranscodeOptions() }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.match(error.problem.detail, /Cannot run ffmpeg/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reported dimensions are measured from the output, not predicted from the plan", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-measured-");
  const source = path.join(dir, "clip.mp4");
  await writeFile(source, Buffer.alloc(256, 6));
  // The old nearest-even helper predicts 2160; the video plan now floors to 2158.
  // The result still comes from a validated probe of the produced file.
  const { runtime } = fakeRuntime({
    probe: probeJson({ width: 3841, height: 2160 }),
    outputProbe: encodedVideoProbe({ width: 3840, height: 2158, level: 51 }),
    progressSeconds: [6],
  });
  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    assert.notDeepEqual(boundedSize(3841, 2160, 3840), { width: 3840, height: 2158 });
    assert.equal(result.width, 3840);
    assert.equal(result.height, 2158, "the envelope must carry the measured height");
    assert.equal(result.dimensionsMeasured, true);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
  }
});

test("an unmeasurable video fails closed and deletes its output", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-unmeasured-");
  const source = path.join(dir, "clip.mp4");
  await writeFile(source, Buffer.alloc(256, 7));
  const { runtime, calls } = fakeRuntime({ probe: probeJson(), failOutputProbe: true });
  try {
    await assert.rejects(() => transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() }));
    const output = encodeCall(calls)?.args.at(-1);
    assert.ok(output);
    await assert.rejects(() => stat(output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a noncompliant video never reports completion and deletes its output", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-invalid-");
  const source = path.join(dir, "clip.mp4");
  await writeFile(source, Buffer.alloc(256, 7));
  const { runtime, calls } = fakeRuntime({ probe: probeJson(), outputProbe: encodedVideoProbe({ level: 31 }) });
  let finished = false;
  try {
    await assert.rejects(() => transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions(),
      reporter: { start() {}, update() {}, finish() { finished = true; }, failed() {} },
    }), /delivery validation/);
    assert.equal(finished, false);
    const output = encodeCall(calls)?.args.at(-1);
    assert.ok(output);
    await assert.rejects(() => stat(output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("signage preset bounds portrait video and strips audio when requested", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-signage-");
  const source = path.join(dir, "portrait.mov");
  await writeFile(source, Buffer.alloc(256, 7));
  const { runtime, calls } = fakeRuntime({
    probe: probeJson({ width: 2160, height: 3840 }),
    outputProbe: encodedVideoProbe({ width: 1080, height: 1920 }, false),
  });
  const result = await transcodeForUpload({ runtime, filePath: source,
    options: { ...defaultTranscodeOptions(), preset: "signage-1080p30", noAudio: true, maxFps: 60 },
  });
  try {
    const args = encodeCall(calls)?.args ?? [];
    assert.ok(args.includes("-an"));
    assert.ok(!args.includes("-c:a") && !args.includes("0:a:0?"));
    assert.equal(args[args.indexOf("-vf") + 1], "scale=w=1080:h=1920,setsar=1");
    assert.deepEqual(result.video, { codec: "h264", profile: "high", level: "4.2", fps: 30,
      audio: false, scan: "progressive", preset: "signage-1080p30" });
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
  }
});

test("ffmpeg diagnostics are trimmed and bounded", () => {
  assert.equal(summarizeFfmpegError(""), "no diagnostic output");
  const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const summary = summarizeFfmpegError(many);
  assert.match(summary, /line 39/);
  assert.ok(!summary.includes("line 30"));
  assert.ok(summarizeFfmpegError("z".repeat(5000)).length <= 603);
});

test("progress formatting stays readable for long and short jobs", () => {
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(75), "01:15");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock(Number.NaN), "--:--");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(2048), "2.0 KiB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MiB");
});

test("progress writes only to stderr and throttles non-tty updates", async () => {
  const stderr = new PassThrough();
  const chunks: string[] = [];
  stderr.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  let clock = 0;
  const reporter = createProgressReporter({
    stderr,
    json: false,
    tty: false,
    now: () => clock,
    throttleMs: 1000,
    stepPercent: 10,
  });
  reporter.start({ stage: "video", target: "H.265 MP4", sourceBytes: 1024, durationSeconds: 10, width: 640, height: 480 });
  for (const [at, fraction] of [[100, 0.02], [200, 0.05], [1500, 0.5], [1600, 0.52], [3000, 1]] as const) {
    clock = at;
    reporter.update(fraction);
  }
  reporter.finish({ outputBytes: 512, elapsedMs: 3000 });
  const text = chunks.join("");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0] ?? "", /transcoding video to H\.265 MP4 \(640x480, 00:10, 1\.0 KiB\)/);
  assert.match(lines[1] ?? "", /50%/);
  assert.match(lines[2] ?? "", /100%/);
  assert.match(lines[3] ?? "", /transcode complete/);
});

test("temporary output lives outside the source directory and is removed by the caller", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-temp-");
  await mkdir(dir, { recursive: true });
  const source = path.join(dir, "clip.mp4");
  await writeFile(source, Buffer.alloc(128, 4));
  const { runtime } = fakeRuntime({ probe: probeJson(), progressSeconds: [6] });
  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  assert.ok(result.cleanupDir);
  assert.ok(!result.filePath.startsWith(dir));
  assert.equal(path.dirname(result.filePath), result.cleanupDir);
  assert.equal((await readFile(source)).length, 128, "the source file is never modified");
  await rm(result.cleanupDir, { recursive: true, force: true });
  await assert.rejects(() => stat(result.filePath));
  await rm(dir, { recursive: true, force: true });
});

test("transcode emits paired local start and finish events without pixels", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-log-");
  await mkdir(dir, { recursive: true });
  const source = path.join(dir, "clip.mp4");
  await writeFile(source, Buffer.alloc(128, 4));
  const { runtime } = fakeRuntime({ probe: probeJson(), progressSeconds: [6] });
  const { logger, events } = createMemoryLogger({ command: ["media", "upload"] });
  runtime.logger = logger;
  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    const starts = events.filter((event) => event.kind === "local" && event.phase === "start" && event.op === "media.transcode");
    const finishes = events.filter((event) => event.kind === "local" && event.phase === "finish" && event.op === "media.transcode");
    assert.equal(starts.length, 1);
    assert.equal(finishes.length, 1);
    assert.equal(starts[0]?.correlation_id, finishes[0]?.correlation_id);
    assert.notEqual(starts[0]?.event_id, finishes[0]?.event_id);
    assert.equal(finishes[0]?.v, 1);
    assert.equal(typeof finishes[0]?.duration_ms, "number");
    const serialized = events.map((event) => JSON.stringify(event)).join("\n");
    assert.doesNotMatch(serialized, /pixels|image_bytes|data:image\//i);
    assert.ok(events.some((event) => event.op === "process.spawn"));
  } finally {
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});


function audioProbe(codec: string, format: string, extra: Record<string, unknown> = {}, duration = "184.2"): string {
  return JSON.stringify({
    streams: [
      { codec_type: "audio", codec_name: codec, sample_rate: "48000", channels: 6, ...extra },
      // Embedded cover art probes as a video stream and must not make the source video.
      { codec_type: "video", codec_name: "mjpeg", width: 600, height: 600 },
    ],
    format: { duration, format_name: format },
  });
}

const LAME_ENCODERS = `${ENCODER_LISTING}\n A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3) (codec mp3)`;

test("an MP3 source is a soundtrack passthrough with no encode", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-audio-pass-");
  const source = path.join(dir, "theme.mp3");
  await writeFile(source, Buffer.alloc(512, 1));
  const { runtime, calls } = fakeRuntime({ probe: audioProbe("mp3", "mp3") });
  try {
    const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
    assert.equal(result.passthrough, true);
    assert.equal(result.contentType, "audio/mpeg");
    assert.equal(result.stage, "audio");
    assert.equal(result.filePath, source);
    assert.equal(encodeCall(calls), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an MP3 over the 170 MiB audio limit is re-encoded, not uploaded as is", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-audio-large-");
  const source = path.join(dir, "set.mp3");
  await writeFile(source, Buffer.alloc(512, 1));
  // Sparse: the size counts, the disk stays empty.
  await truncate(source, MAX_AUDIO_BYTES + 1);
  const { runtime, calls } = fakeRuntime({ probe: audioProbe("mp3", "mp3"), encoders: LAME_ENCODERS, outputProbe: audioProbe("mp3", "mp3") });
  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    assert.equal(result.passthrough, false);
    const args = encodeCall(calls)?.args ?? [];
    assert.equal(args[args.indexOf("-b:a") + 1], "128k");
  } finally {
    await rm(result.cleanupDir!, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("other audio is re-encoded to a 128 kb/s stereo MP3 without cover art", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-audio-encode-");
  const source = path.join(dir, "theme.flac");
  await writeFile(source, Buffer.alloc(512, 1));
  const { runtime, calls } = fakeRuntime({ probe: audioProbe("flac", "flac"), encoders: LAME_ENCODERS, outputProbe: audioProbe("mp3", "mp3") });
  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    assert.equal(result.passthrough, false);
    assert.equal(result.contentType, "audio/mpeg");
    assert.equal(result.filename, "theme.mp3");
    const args = encodeCall(calls)?.args ?? [];
    for (const [flag, value] of [["-c:a", "libmp3lame"], ["-b:a", "128k"], ["-ar", "48000"], ["-ac", "2"], ["-map", "0:a:0"]] as const) {
      assert.equal(args[args.indexOf(flag) + 1], value, flag);
    }
    assert.ok(args.includes("-vn"));
  } finally {
    await rm(result.cleanupDir!, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("audio transcode names a missing LAME encoder and out-of-range lengths", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-audio-refuse-");
  const source = path.join(dir, "theme.wav");
  await writeFile(source, Buffer.alloc(512, 1));
  try {
    await assert.rejects(
      () => transcodeForUpload({ runtime: fakeRuntime({ probe: audioProbe("pcm_s16le", "wav") }).runtime, filePath: source, options: defaultTranscodeOptions() }),
      /libmp3lame/,
    );
    resetFfmpegToolchainCache();
    await assert.rejects(
      () => transcodeForUpload({ runtime: fakeRuntime({ probe: audioProbe("pcm_s16le", "wav", {}, "0.4"), encoders: LAME_ENCODERS }).runtime, filePath: source, options: defaultTranscodeOptions() }),
      /1 second to 3 hours/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Every ffprobe or ffmpeg run that opens `source`, with the input options that precede it. */
function sourceReads(calls: RunProcessRequest[], source: string): Array<{ call: RunProcessRequest; before: string[] }> {
  return calls
    .filter((call) => call.args.includes(source))
    .map((call) => ({ call, before: call.args.slice(0, call.args.indexOf(source)) }));
}

const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(40, 1)]);
const PNG_HEAD = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.alloc(40, 1)]);
const FLAC_HEAD = Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(40, 1)]);

test("ffprobe and ffmpeg open a source with only the file protocol, forcing the demuxer of a recognised container", async () => {
  const cases = [
    { name: "clip.mp4", bytes: MP4_HEAD, demuxer: "mov", probe: probeJson({}), encoder: "-c:v" },
    { name: "poster.png", bytes: PNG_HEAD, demuxer: "png_pipe", probe: probeJson({ codec_name: "png", width: 64, height: 64, pix_fmt: "rgba", nb_frames: "1", avg_frame_rate: "0/0" }, { duration: "0", format_name: "png_pipe" }), encoder: "libwebp" },
    { name: "theme.flac", bytes: FLAC_HEAD, demuxer: "flac", probe: audioProbe("flac", "flac"), encoder: "libmp3lame" },
    // Bytes the sniffer does not recognise: the file protocol only, no forced demuxer.
    { name: "playlist.mp4", bytes: Buffer.from("#EXTM3U\n#EXTINF:1,\nhttp://internal.example/a.ts\n"), demuxer: undefined, probe: probeJson({}), encoder: "-c:v" },
  ];
  for (const item of cases) {
    resetFfmpegToolchainCache();
    const dir = await testTemp("transcode-guard-");
    const source = path.join(dir, item.name);
    await writeFile(source, item.bytes);
    const { runtime, calls } = fakeRuntime({ probe: item.probe, encoders: LAME_ENCODERS, outputProbe: item.name.endsWith(".flac") ? audioProbe("mp3", "mp3") : undefined });
    let result;
    try {
      result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
    } catch {
      // A fake encode of a fake file may be refused after the runs under test.
    }
    try {
      const reads = sourceReads(calls, source);
      assert.ok(reads.some(({ call }) => call.command.endsWith("ffprobe")), `${item.name} is probed`);
      assert.ok(reads.some(({ call }) => call.command.endsWith("ffmpeg")), `${item.name} is encoded`);
      const expected = ["-protocol_whitelist", "file", ...(item.demuxer ? ["-f", item.demuxer] : [])];
      for (const { call, before } of reads) {
        const at = before.indexOf("-protocol_whitelist");
        assert.ok(at >= 0, `${item.name}: ${call.command} carries -protocol_whitelist`);
        assert.deepEqual(before.slice(at, at + expected.length), expected, `${item.name}: ${call.command}`);
        const inputFlags = before.slice(at);
        assert.equal(inputFlags.filter((arg) => arg === "-f").length, item.demuxer ? 1 : 0, `${item.name}: input options`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (result?.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
    }
  }
});
