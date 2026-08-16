import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CliError } from "../problems.js";
import type { CliRuntime, RunProcessRequest, RunProcessResult } from "../runtime.js";
import { testTemp } from "../test-temp.js";
import {
  parseEncoderNames,
  parseFilterNames,
  parseProbePayload,
  parseRate,
  pixelFormatHasAlpha,
  resetFfmpegToolchainCache,
} from "./ffmpeg.js";
import { createProgressReporter, formatBytes, formatClock } from "./progress.js";
import {
  boundedScaleFilter,
  boundedSize,
  classifySource,
  defaultTranscodeOptions,
  encodeTiming,
  isAnimated,
  isHdr,
  summarizeFfmpegError,
  transcodeForUpload,
  videoFilterChain,
} from "./transcode.js";
import { readWebpContainer } from "./webp.js";

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
      return { code: 0, signal: null, stdout: options.probe, stderrTail: "" };
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
      await writeFile(output, Buffer.alloc(options.writeOutputBytes ?? 4096, 7));
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
});

test("scale filter bounds width and height together", () => {
  const filter = boundedScaleFilter(3840);
  assert.match(filter, /w='min\(3840,iw\)'/);
  assert.match(filter, /h='min\(3840,ih\)'/);
  assert.match(filter, /force_original_aspect_ratio=decrease/);
  assert.match(filter, /force_divisible_by=2/);
});

test("frame rate is capped and the keyframe interval follows the capped rate", () => {
  const probe = parseProbePayload(probeJson({ avg_frame_rate: "60/1" }));
  assert.deepEqual(encodeTiming(probe, 30), { rate: "30", gop: 60 });
  assert.deepEqual(encodeTiming(probe, 120), { rate: "60", gop: 120 });
  const ntsc = parseProbePayload(probeJson({ avg_frame_rate: "30000/1001" }));
  assert.equal(encodeTiming(ntsc, 30).gop, 60);
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
  assert.equal(videoFilterChain(capable, sdr, 3840).filter, boundedScaleFilter(3840));
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
  assert.deepEqual(readWebpContainer(animated), { animated: true, width: 800, height: 600 });
  assert.equal(readWebpContainer(Buffer.from("not a webp file at all")), undefined);
  assert.equal(readWebpContainer(Buffer.alloc(4)), undefined);
});

test("video transcode defaults to the universally playable H.264 profile and reports progress", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-");
  const source = path.join(dir, "clip.mov");
  await writeFile(source, Buffer.alloc(2048, 3));
  const { runtime, calls, stderr } = fakeRuntime({
    probe: probeJson({ width: 6000, height: 2400, avg_frame_rate: "60/1" }),
    outputProbe: probeJson({ width: 3840, height: 1536, avg_frame_rate: "30/1" }),
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
    assert.equal(defaultTranscodeOptions().codec, "h264", "the default must play in every browser");
    assert.equal(valueAfter("-c:v"), "libx264");
    assert.equal(valueAfter("-profile:v"), "high");
    assert.equal(valueAfter("-level:v"), "4.2");
    assert.equal(valueAfter("-crf"), "23");
    assert.ok(!args.includes("-tag:v"), "the H.264 profile carries no hvc1 tag");
    assert.equal(valueAfter("-pix_fmt"), "yuv420p");
    assert.equal(valueAfter("-movflags"), "+faststart");
    assert.equal(valueAfter("-r"), "30");
    assert.equal(valueAfter("-c:a"), "aac");
    assert.equal(valueAfter("-colorspace"), "bt709");
    assert.match(String(valueAfter("-vf")), /min\(3840,iw\)/);
    assert.match(String(valueAfter("-vf")), /min\(3840,ih\)/);
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
    outputProbe: probeJson({ width: 3840, height: 1536, avg_frame_rate: "30/1" }),
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
    assert.match(result.reason, /H\.265/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (result.cleanupDir) await rm(result.cleanupDir, { recursive: true, force: true });
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
  // The planner predicts 3840x2160 here, but ffmpeg floors to a multiple of two
  // from a slightly different rounding, so the delivered file is 3840x2158.
  const { runtime } = fakeRuntime({
    probe: probeJson({ width: 3841, height: 2160 }),
    outputProbe: probeJson({ width: 3840, height: 2158 }),
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

test("an unmeasurable output falls back to the planned size and says so", async () => {
  resetFfmpegToolchainCache();
  const dir = await testTemp("transcode-unmeasured-");
  const source = path.join(dir, "clip.mp4");
  await writeFile(source, Buffer.alloc(256, 7));
  const { runtime } = fakeRuntime({
    probe: probeJson({ width: 6000, height: 2400 }),
    failOutputProbe: true,
    progressSeconds: [6],
  });
  const result = await transcodeForUpload({ runtime, filePath: source, options: defaultTranscodeOptions() });
  try {
    assert.equal(result.width, 3840);
    assert.equal(result.height, 1536);
    assert.equal(result.dimensionsMeasured, false, "a fallback must never claim to be measured");
    assert.equal(result.warnings.length, 1);
    assert.match(String(result.warnings[0]), /could not measure/);
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
