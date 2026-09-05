import assert from "node:assert/strict";
import { mkdir, open, readFile, rename, chmod, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ExitCode } from "../exit-codes.js";
import { run, type CliRuntime } from "../main.js";
import { testTemp } from "../test-temp.js";
import type { ConfigFs } from "../config.js";
import { FakeTransport } from "../transport/fake.js";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function withRuntime(
  argv: string[],
  extra?: Partial<CliRuntime> & { cwdDir?: string },
): Promise<{ code: number; stdout: string; stderr: string; cwdDir: string }> {
  const cwdDir = extra?.cwdDir ?? await testTemp("compose-cli-");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const fsLike: ConfigFs = extra?.fs ?? {
    mkdir,
    open,
    rename,
    rm,
    chmod,
    stat,
    homedir: () => cwdDir,
    env: { XDG_CONFIG_HOME: cwdDir },
  };
  const { cwdDir: _cwdDir, ...runtimeExtra } = extra ?? {};
  const runtime: CliRuntime = {
    argv,
    env: runtimeExtra.env ?? fsLike.env,
    stdout,
    stderr,
    now: () => new Date("2026-08-14T17:00:00.000Z"),
    sleep: async () => undefined,
    homedir: fsLike.homedir,
    cwd: runtimeExtra.cwd ?? (() => cwdDir),
    fs: fsLike,
    transport: runtimeExtra.transport ?? new FakeTransport(),
    ...runtimeExtra,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: await outP, stderr: await errP, cwdDir };
}

test("compose catalog does not enroll", async () => {
  const transport = new FakeTransport();
  const { code, stdout, cwdDir } = await withRuntime(["--json", "compose", "catalog"], { transport });
  assert.equal(code, ExitCode.Success, stdout);
  const envelope = JSON.parse(stdout) as {
    ok: true;
    data: {
      types: string[];
      rules: { fontSize: boolean; textShadow: string; child_size: string; pin_stretch: string };
    };
  };
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.types, ["Frame", "Column", "Row", "Box", "Spacer", "Text", "Image"]);
  assert.equal(envelope.data.rules.fontSize, false);
  assert.match(envelope.data.rules.textShadow, /optional Text object \{ x, y, blur\?, color \}/);
  assert.match(envelope.data.rules.child_size, /honor width and height/);
  assert.match(envelope.data.rules.pin_stretch, /Size a wordmark with width and height, not pin/);
  assert.equal(transport.calls.length, 0);
  assert.doesNotMatch(stdout, /\u0089PNG/);
  await rm(cwdDir, { recursive: true, force: true });
});

test("compose render writes a PNG and layout.json; envelope has paths and no image bytes", async () => {
  const cwdDir = await testTemp("compose-render-");
  const specPath = path.join(cwdDir, "spec.json");
  await writeFile(specPath, JSON.stringify({
    type: "Frame",
    width: 320,
    height: 180,
    children: [{ type: "Text", text: "Hello", role: "title" }],
  }));
  const { code, stdout } = await withRuntime(["--json", "compose", "render", specPath], { cwdDir });
  assert.equal(code, ExitCode.Success, stdout);
  const envelope = JSON.parse(stdout) as {
    ok: true;
    data: {
      output: string;
      layout_output: string;
      width: number;
      height: number;
      font_family: string;
      truncated: boolean;
      opened?: boolean;
    };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.width, 320);
  assert.equal(envelope.data.height, 180);
  assert.equal(envelope.data.truncated, false);
  assert.equal(envelope.data.opened, undefined);
  assert.equal(envelope.data.output, path.join(cwdDir, "spec.png"));
  assert.equal(envelope.data.layout_output, `${envelope.data.output}.layout.json`);
  const png = await readFile(envelope.data.output);
  assert.ok(png.subarray(0, 8).equals(PNG_HEADER));
  const layout = JSON.parse(await readFile(envelope.data.layout_output, "utf8")) as {
    tree: { type: string };
    ramp_root: number;
    ramp: { title: { wish: number } };
    ramp_at_1080: { title: { wish: number } };
  };
  assert.equal(layout.tree.type, "Frame");
  assert.equal(layout.ramp_root, 180);
  assert.equal(layout.ramp_at_1080.title.wish, 86);
  assert.equal(typeof layout.ramp.title.wish, "number");
  const envelopeData = envelope.data as typeof envelope.data & {
    ramp_root: number;
    ramp_at_1080: { title: { wish: number } };
  };
  assert.equal(envelopeData.ramp_root, 180);
  assert.equal(envelopeData.ramp_at_1080.title.wish, 86);
  assert.doesNotMatch(stdout, /\u0089PNG/);
  assert.equal(stdout.includes(png.toString("base64")), false);
  await rm(cwdDir, { recursive: true, force: true });
});

test("compose render unknown key and fontSize are usage_error", async () => {
  const cwdDir = await testTemp("compose-bad-");
  await writeFile(path.join(cwdDir, "mystery.json"), JSON.stringify({
    type: "Frame", width: 64, height: 64, mystery: true,
  }));
  await writeFile(path.join(cwdDir, "font.json"), JSON.stringify({
    type: "Frame", width: 64, height: 64, fontSize: 48,
  }));
  await writeFile(path.join(cwdDir, "xy.json"), JSON.stringify({
    type: "Frame",
    width: 64,
    height: 64,
    children: [{ type: "Text", text: "Hi", role: "title", x: 1, y: 2 }],
  }));
  const mystery = await withRuntime(["--json", "compose", "render", "mystery.json"], { cwdDir });
  assert.equal(mystery.code, ExitCode.Usage, mystery.stdout);
  assert.match(JSON.parse(mystery.stdout).error.detail, /unknown keys: mystery/);
  const font = await withRuntime(["--json", "compose", "render", "font.json"], { cwdDir });
  assert.equal(font.code, ExitCode.Usage, font.stdout);
  assert.match(JSON.parse(font.stdout).error.detail, /fontSize/);
  const xy = await withRuntime(["--json", "compose", "render", "xy.json"], { cwdDir });
  assert.equal(xy.code, ExitCode.Usage, xy.stdout);
  assert.match(JSON.parse(xy.stdout).error.detail, /must not set x/);
  await rm(cwdDir, { recursive: true, force: true });
});

test("compose render --open calls the stubbed opener with the output path", async () => {
  const cwdDir = await testTemp("compose-open-");
  await writeFile(path.join(cwdDir, "spec.json"), JSON.stringify({
    type: "Frame",
    width: 64,
    height: 64,
    children: [{ type: "Text", text: "Hi", role: "label" }],
  }));
  const opened: string[] = [];
  const { code, stdout } = await withRuntime(
    ["--json", "compose", "render", "spec.json", "--output", "still.png", "--open"],
    {
      cwdDir,
      openPath: async (filePath) => {
        opened.push(filePath);
        return true;
      },
    },
  );
  assert.equal(code, ExitCode.Success, stdout);
  const envelope = JSON.parse(stdout) as { data: { output: string; opened: boolean } };
  assert.equal(envelope.data.opened, true);
  assert.deepEqual(opened, [path.join(cwdDir, "still.png")]);
  await rm(cwdDir, { recursive: true, force: true });
});

test("compose target flags dispatch separately and return nonblocking warnings without resizing", async () => {
  const cwdDir = await testTemp("compose-target-cli-");
  const spec = path.join(cwdDir, "spec.json");
  await writeFile(spec, JSON.stringify({ type: "Frame", width: 320, height: 180, children: [{ type: "Text", text: "Edge" }] }));
  const result = await withRuntime(["--json", "compose", "render", spec, "--target-width", "640", "--target-height", "360", "--safe-area"], { cwdDir });
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.data.width, 320);
  assert.deepEqual(envelope.data.quality.target, { width: 640, height: 360 });
  assert.ok(envelope.warnings.some((w: { code: string }) => w.code === "compose_output_upscaled"));
  assert.ok(envelope.warnings.some((w: { code: string }) => w.code === "text_outside_safe_area"));
  for (const flags of [["--target-width", "640"], ["--target-width", "wrong", "--target-height", "wrong"], ["--target-width", "0", "--target-height", "360"], ["--target-width", "--target-height", "360"]]) {
    const invalid = await withRuntime(["--json", "compose", "render", spec, ...flags], { cwdDir });
    assert.equal(invalid.code, ExitCode.Usage, invalid.stdout);
  }
  await rm(cwdDir, { recursive: true, force: true });
});

test("batch render returns ordered results, preview and supports one-page correction", async () => {
  const cwdDir = await testTemp("batch-compose-");
  const input = path.join(cwdDir, "batch.json"), output = path.join(cwdDir, "rendered");
  const pages = [{ id: "title", spec: { recipe: "title", title: "A clear point", body: "A useful explanation." } }, { id: "bad", spec: { recipe: "title", title: "Fix me", body: "A useful explanation.", extra: true } }];
  await writeFile(input, JSON.stringify({ pages }));
  const first = await withRuntime(["--json", "compose", "batch", input, "--output", output], { cwdDir });
  assert.equal(first.code, ExitCode.Usage, first.stdout);
  const manifest = JSON.parse(await readFile(path.join(output, "compose-batch.json"), "utf8"));
  assert.deepEqual(manifest.pages.map((page: { status: string }) => page.status), ["rendered", "failed"]);
  assert.ok((await readFile(manifest.preview)).subarray(0, 8).equals(PNG_HEADER));
  const unchanged = await readFile(path.join(output, "title.png"));
  delete (pages[1]!.spec as Record<string, unknown>).extra;
  await writeFile(input, JSON.stringify({ pages }));
  const retry = await withRuntime(["--json", "compose", "batch", input, "--output", output, "--only", "bad"], { cwdDir });
  assert.equal(retry.code, ExitCode.Success, retry.stdout);
  const result = JSON.parse(retry.stdout).data;
  assert.equal(result.rendered, 1); assert.equal(result.not_selected, 1);
  assert.deepEqual(await readFile(path.join(output, "title.png")), unchanged);
  await rm(cwdDir, { recursive: true, force: true });
});

test("offline playlist validate rejects unknown entry fields without HTTP", async () => {
  const cwdDir = await testTemp("playlist-offline-");
  const transport = new FakeTransport();
  const input = path.join(cwdDir, "playlist.json");
  await writeFile(input, JSON.stringify({ name: "Intro", pages: [{ id: "page", canvas: { width: 1920, height: 1080, background: "#000000FF" }, transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "duration", after_ms: 8000 }, primitives: [{ id: "image", primitive: "image", selector: { by: "all", one_at_a_time: true }, rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "contain", enter: { type: "fade-left", duration_ms: 500 } }] }] }));
  const result = await withRuntime(["--json", "playlist", "validate", input], { cwdDir, transport });
  assert.equal(result.code, ExitCode.Usage, result.stdout);
  assert.equal(JSON.parse(result.stdout).error.errors[0].path, "/pages/0/primitives/0/enter/duration_ms");
  assert.deepEqual(transport.calls, []);
  await rm(cwdDir, { recursive: true, force: true });
});
