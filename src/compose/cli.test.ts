import assert from "node:assert/strict";
import { mkdir, open, readFile, rename, chmod, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { commandHelp } from "../help.js";
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

test("compose catalog does not enroll and documents regions", async () => {
  const transport = new FakeTransport();
  const { code, stdout, cwdDir } = await withRuntime(["--json", "compose", "catalog"], { transport });
  assert.equal(code, ExitCode.Success, stdout);
  const envelope = JSON.parse(stdout) as {
    ok: true;
    data: { regions: string[]; rules: { fontSize: boolean; xy: boolean } };
  };
  assert.equal(envelope.ok, true);
  assert.ok(envelope.data.regions.includes("fullpage"));
  assert.ok(envelope.data.regions.includes("left"));
  assert.equal(envelope.data.rules.fontSize, false);
  assert.equal(envelope.data.rules.xy, false);
  assert.doesNotMatch(stdout, /Frame/);
  assert.doesNotMatch(stdout, /warm-cafe/);
  assert.equal(transport.calls.length, 0);
  assert.doesNotMatch(stdout, /\u0089PNG/);
  await rm(cwdDir, { recursive: true, force: true });
});

test("compose render writes layered PNGs and a manifest; envelope has paths and no image bytes", async () => {
  const cwdDir = await testTemp("compose-render-");
  const specPath = path.join(cwdDir, "spec.json");
  await writeFile(specPath, JSON.stringify({
    width: 320,
    height: 180,
    background: "#1C1410",
    text: "#F3E6D0",
    left: { title: "Hello" },
  }));
  const { code, stdout } = await withRuntime(["--json", "compose", "render", specPath], { cwdDir });
  assert.equal(code, ExitCode.Success, stdout);
  const envelope = JSON.parse(stdout) as {
    ok: true;
    data: {
      output: string;
      width: number;
      height: number;
      font_family: string;
      files: string[];
      manifest: { version: number; layers: Array<{ id: string; file: string; rect: { width: number } }> };
    };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.width, 320);
  assert.equal(envelope.data.height, 180);
  assert.equal(envelope.data.output, path.join(cwdDir, "spec"));
  assert.ok(envelope.data.files.includes("manifest.json"));
  assert.ok(envelope.data.files.includes("left.png"));
  const png = await readFile(path.join(envelope.data.output, "left.png"));
  assert.ok(png.subarray(0, 8).equals(PNG_HEADER));
  const manifest = JSON.parse(await readFile(path.join(envelope.data.output, "manifest.json"), "utf8"));
  assert.equal(manifest.version, 1);
  assert.doesNotMatch(stdout, /\u0089PNG/);
  assert.equal(stdout.includes(png.toString("base64")), false);
  await rm(cwdDir, { recursive: true, force: true });
});

test("compose render old Frame JSON is usage_error pointing at compose catalog", async () => {
  const cwdDir = await testTemp("compose-bad-");
  await writeFile(path.join(cwdDir, "frame.json"), JSON.stringify({
    type: "Frame", width: 64, height: 64, children: [{ type: "Text", text: "Hi", role: "title" }],
  }));
  await writeFile(path.join(cwdDir, "font.json"), JSON.stringify({
    width: 64, height: 64, fontSize: 48, left: { title: "Hi" },
  }));
  const frame = await withRuntime(["--json", "compose", "render", "frame.json"], { cwdDir });
  assert.equal(frame.code, ExitCode.Usage, frame.stdout);
  const body = JSON.parse(frame.stdout);
  assert.match(body.error.detail, /old Frame\/recipe language|compose catalog/);
  assert.equal(body.error.next?.command, "screenrig --json compose catalog");
  const font = await withRuntime(["--json", "compose", "render", "font.json"], { cwdDir });
  assert.equal(font.code, ExitCode.Usage, font.stdout);
  assert.match(JSON.parse(font.stdout).error.detail, /fontSize/);
  await rm(cwdDir, { recursive: true, force: true });
});

test("compose render --open calls the stubbed opener with combined.png", async () => {
  const cwdDir = await testTemp("compose-open-");
  await writeFile(path.join(cwdDir, "spec.json"), JSON.stringify({
    width: 640,
    height: 360,
    background: "#1C1410",
    text: "#F3E6D0",
    fullpage: { title: "Hi" },
  }));
  const opened: string[] = [];
  const { code, stdout } = await withRuntime(
    ["--json", "compose", "render", "spec.json", "--output", "still", "--open"],
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
  assert.deepEqual(opened, [path.join(cwdDir, "still", "combined.png")]);
  await rm(cwdDir, { recursive: true, force: true });
});

test("compose target flags dispatch separately and return nonblocking warnings without resizing", async () => {
  const cwdDir = await testTemp("compose-target-cli-");
  const spec = path.join(cwdDir, "spec.json");
  await writeFile(spec, JSON.stringify({
    width: 320, height: 180, background: "#1C1410", text: "#F3E6D0", left: { title: "Edge" },
  }));
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

test("compose render --output foo.png is usage_error naming a directory", async () => {
  const cwdDir = await testTemp("compose-output-png-");
  await writeFile(path.join(cwdDir, "spec.json"), JSON.stringify({
    width: 64, height: 64, background: "#1C1410", text: "#F3E6D0", fullpage: { title: "Hi" },
  }));
  const result = await withRuntime(["--json", "compose", "render", "spec.json", "--output", "foo.png"], { cwdDir });
  assert.equal(result.code, ExitCode.Usage, result.stdout);
  const body = JSON.parse(result.stdout);
  assert.match(body.error.detail, /directory/);
  await rm(cwdDir, { recursive: true, force: true });
});

test("USAGE documents compose batch page limit and layered render", () => {
  const batch = commandHelp(["compose", "batch"]);
  assert.match(batch.synopsis[0]!, /compose batch \[options\] <file>/);
  for (const name of ["--output", "--only"]) {
    assert.equal(batch.options.find((option) => option.name === name)?.type, "value");
  }
  assert.match(batch.usage, /1 to 2000 pages/);
  assert.doesNotMatch(batch.usage, /1 to 100 pages/);
  const render = commandHelp(["compose", "render"]);
  assert.match(render.synopsis[0]!, /compose render \[options\] <file>/);
  assert.equal(render.options.find((option) => option.name === "--output")?.type, "value");
  assert.equal(render.options.find((option) => option.name === "--combined")?.type, "boolean");
  assert.equal(render.options.some((option) => option.name === "--ink-tight"), false);
  const preview = commandHelp(["playlist", "preview"]);
  assert.match(preview.synopsis[0]!, /playlist preview \[options\] <file\|id>/);
  for (const [name, type] of [["--output", "value"], ["--frame-ms", "value"], ["--contact-sheet", "boolean"], ["--lint-only", "boolean"]]) {
    assert.equal(preview.options.find((option) => option.name === name)?.type, type);
  }
});

test("batch render returns ordered results, preview and supports one-page correction", async () => {
  const cwdDir = await testTemp("batch-compose-");
  const input = path.join(cwdDir, "batch.json");
  const output = path.join(cwdDir, "rendered");
  const pages = [
    { id: "title", left: { title: "A clear point", text: "A useful explanation." } },
    { id: "bad", left: { title: "Fix me", extra: true } },
  ];
  await writeFile(input, JSON.stringify({ width: 320, height: 180, background: "#111", text: "#eee", pages }));
  const first = await withRuntime(["--json", "compose", "batch", input, "--output", output], { cwdDir });
  assert.equal(first.code, ExitCode.Usage, first.stdout);
  const retryPages = [
    { id: "title", left: { title: "A clear point", text: "A useful explanation." } },
    { id: "bad", left: { title: "Fix me", text: "A useful explanation." } },
  ];
  await writeFile(input, JSON.stringify({ width: 320, height: 180, background: "#111", text: "#eee", pages: retryPages }));
  const retry = await withRuntime(["--json", "compose", "batch", input, "--output", output, "--only", "bad"], { cwdDir });
  assert.equal(retry.code, ExitCode.Success, retry.stdout);
  const result = JSON.parse(retry.stdout).data;
  assert.equal(result.rendered, 1);
  assert.equal(result.not_selected, 1);
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
