import assert from "node:assert/strict";
import { mkdir, open, readFile, rename, chmod, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { commandHelp } from "./help.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import {
  CONTACT_SHEET_COLUMNS,
  CONTACT_SHEET_LABEL_HEIGHT,
  CONTACT_SHEET_TILE_HEIGHT,
  CONTACT_SHEET_TILE_WIDTH,
  LOOK_AT_THE_CONTACT_SHEET,
  PREVIEW_STATES,
  contactSheetSize,
  previewPlaylist,
} from "./playlist-preview.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

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
  const cwdDir = extra?.cwdDir ?? await testTemp("preview-cli-");
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

function iframePage(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    canvas: { width: 1920, height: 1080, background: "#1B2632FF", viewport_fit: "contain" },
    transition: { type: "crossfade", duration_ms: 200 },
    advance: { mode: "duration", after_ms: 8000 },
    primitives: [{
      id: "web",
      primitive: "iframe",
      src: "https://example.com/",
      title: "Example",
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      layer: 0,
      content_fit: "fill",
      ...extra,
    }],
  };
}

test("USAGE and README sentence is printed verbatim", () => {
  const help = commandHelp(["playlist", "preview"]);
  assert.match(help.synopsis[0]!, /playlist preview \[options\] <file\|id>/);
  assert.ok(help.usage.includes(LOOK_AT_THE_CONTACT_SHEET));
  for (const [name, type] of [["--output", "value"], ["--frame-ms", "value"], ["--contact-sheet", "boolean"], ["--lint-only", "boolean"]]) {
    assert.equal(help.options.find((option) => option.name === name)?.type, type);
  }
});

test("playlist preview writes N*3 stable files and a 6-column contact sheet", async () => {
  const cwdDir = await testTemp("preview-files-");
  const output = path.join(cwdDir, "out");
  const playlist = { name: "Preview", pages: [iframePage("one", { enter: { type: "fade-in" } }), iframePage("two")] };
  const result = await previewPlaylist({ playlist, outputDirectory: output, contactSheet: true });
  assert.equal(result.pages.length, 2);
  for (const page of result.pages) {
    for (const state of PREVIEW_STATES) {
      const file = path.join(output, `${page.id}.${state}.png`);
      assert.equal(page.files[state], file);
      const png = await readFile(file);
      assert.ok(png.subarray(0, 8).equals(PNG_HEADER));
      const image = await loadImage(png);
      assert.equal(image.width, 1920);
      assert.equal(image.height, 1080);
    }
  }
  assert.equal(typeof result.contact_sheet, "string");
  const sheet = await loadImage(await readFile(result.contact_sheet as string));
  const expected = contactSheetSize(2);
  assert.equal(expected.width, CONTACT_SHEET_COLUMNS * CONTACT_SHEET_TILE_WIDTH);
  assert.equal(expected.height, CONTACT_SHEET_TILE_HEIGHT + CONTACT_SHEET_LABEL_HEIGHT);
  assert.equal(sheet.width, expected.width);
  assert.equal(sheet.height, expected.height);
  const seven = contactSheetSize(7);
  assert.equal(seven.width, 1920);
  assert.equal(seven.height, 2 * (CONTACT_SHEET_TILE_HEIGHT + CONTACT_SHEET_LABEL_HEIGHT));
  await rm(cwdDir, { recursive: true, force: true });
});

test("playlist preview command writes files, lint, and the contact-sheet sentence", async () => {
  const cwdDir = await testTemp("preview-cli-cmd-");
  const file = path.join(cwdDir, "playlist.json");
  const output = path.join(cwdDir, "frames");
  await writeFile(file, JSON.stringify({ name: "Preview", pages: [iframePage("alpha"), iframePage("beta")] }));
  const { code, stdout } = await withRuntime(
    ["--json", "playlist", "preview", file, "--output", output, "--contact-sheet"],
    { cwdDir },
  );
  assert.equal(code, ExitCode.Success, stdout);
  const envelope = JSON.parse(stdout) as {
    ok: true;
    data: {
      pages: Array<{ id: string; files: Record<string, string>; lint_count: number }>;
      contact_sheet: string;
      lint: unknown[];
    };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.pages.length, 2);
  assert.equal(Object.keys(envelope.data.pages[0]!.files).length, 3);
  assert.ok(envelope.data.contact_sheet.endsWith("contact-sheet.png"));
  assert.ok(Array.isArray(envelope.data.lint));
  for (const page of envelope.data.pages) {
    for (const state of PREVIEW_STATES) {
      const filePath = page.files[state];
      assert.equal(typeof filePath, "string");
      assert.ok((await readFile(filePath as string)).subarray(0, 8).equals(PNG_HEADER));
    }
  }
  const human = await withRuntime(
    ["--human", "playlist", "preview", file, "--output", path.join(cwdDir, "human")],
    { cwdDir },
  );
  assert.equal(human.code, ExitCode.Success, human.stdout);
  assert.ok(human.stdout.includes(LOOK_AT_THE_CONTACT_SHEET));
  await rm(cwdDir, { recursive: true, force: true });
});


test("stream preview paints the cached fallback exactly like an ordinary image", async () => {
  const directory = await testTemp("stream-preview-");
  const canvas = createCanvas(32, 24);
  const context = canvas.getContext("2d");
  context.fillStyle = "#cc3300";
  context.fillRect(0, 0, 32, 24);
  await writeFile(path.join(directory, "med_fallback.png"), canvas.toBuffer("image/png"));
  const geometry = { id: "live", rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "contain" };
  const stream = { ...geometry, primitive: "stream", fallback_media_id: "med_fallback", sources: [{ protocol: "hls", url: "https://example.com/live.m3u8" }] };
  const image = { ...geometry, primitive: "image", selector: { by: "id", media_id: "med_fallback" } };
  const outputs: Buffer[] = [];
  for (const primitive of [stream, image]) {
    const playlist = { name: "Preview", pages: [{ ...iframePage("page"), primitives: [primitive] }] };
    const result = await previewPlaylist({ playlist, searchDirs: [directory], outputDirectory: path.join(directory, primitive.primitive) });
    outputs.push(await readFile(result.pages[0]!.files.rest));
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

function redPng(): Buffer {
  const canvas = createCanvas(32, 24);
  const context = canvas.getContext("2d");
  context.fillStyle = "#cc3300";
  context.fillRect(0, 0, 32, 24);
  return canvas.toBuffer("image/png");
}

function imagePlaylist(mediaId: string): Record<string, unknown> {
  return {
    name: "Menu",
    pages: [{
      ...iframePage("page_1"),
      primitives: [{
        id: "content",
        primitive: "image",
        selector: { by: "id", media_id: mediaId },
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "contain",
      }],
    }],
  };
}

async function centerPixel(file: string): Promise<number[]> {
  const image = await loadImage(await readFile(file));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return Array.from(context.getImageData(960, 540, 1, 1).data);
}

test("file preview fetches uploaded media from the project when logged in", async () => {
  const cwdDir = await testTemp("preview-fetch-");
  const fsLike: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => cwdDir, env: { XDG_CONFIG_HOME: cwdDir } };
  await writeConfigAtomic(path.join(cwdDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fsLike);
  const file = path.join(cwdDir, "menu-playlist.json");
  await writeFile(file, JSON.stringify(imagePlaylist("med_MENU")));
  const png = redPng();
  const transport = new FakeTransport()
    .on("GET", "/api/media/med_MENU", () => ({ status: 200, headers: {}, body: { id: "med_MENU", content_type: "image/png" } }))
    .onDownload("GET", "/api/media/med_MENU/content", () => ({
      status: 200,
      headers: { "content-type": "image/png" },
      body: { async *[Symbol.asyncIterator]() { yield png; } },
    }));
  const { code, stdout } = await withRuntime(["--json", "playlist", "preview", file, "--output", path.join(cwdDir, "out")], { cwdDir, fs: fsLike, transport });
  assert.equal(code, ExitCode.Success, stdout);
  const envelope = JSON.parse(stdout) as { data: { pages: Array<{ files: Record<string, string> }>; placeholders: unknown[] }; warnings: unknown[] };
  assert.deepEqual(envelope.data.placeholders, []);
  assert.deepEqual(envelope.warnings, []);
  assert.deepEqual(await centerPixel(envelope.data.pages[0]!.files.rest!), [0xcc, 0x33, 0x00, 255]);
  await rm(cwdDir, { recursive: true, force: true });
});

test("file preview without local media or login names every placeholder", async () => {
  const cwdDir = await testTemp("preview-placeholder-");
  const file = path.join(cwdDir, "menu-playlist.json");
  await writeFile(file, JSON.stringify(imagePlaylist("med_MENU")));
  const transport = new FakeTransport();
  const { code, stdout } = await withRuntime(["--json", "playlist", "preview", file, "--output", path.join(cwdDir, "out")], { cwdDir, transport });
  assert.equal(code, ExitCode.Success, stdout);
  const envelope = JSON.parse(stdout) as { data: { placeholders: unknown[] }; warnings: Array<{ code: string; message: string }> };
  assert.deepEqual(envelope.data.placeholders, [{ page_id: "page_1", primitive_id: "content", primitive: "image", media_id: "med_MENU" }]);
  assert.equal(envelope.warnings[0]?.code, "preview_media_placeholder");
  assert.match(envelope.warnings[0]!.message, /med_MENU/);
  assert.equal(transport.calls.length, 0);

  await writeFile(path.join(cwdDir, "med_MENU.png"), redPng());
  const local = await withRuntime(["--json", "playlist", "preview", file, "--output", path.join(cwdDir, "local")], { cwdDir, transport });
  const localEnvelope = JSON.parse(local.stdout) as { data: { pages: Array<{ files: Record<string, string> }>; placeholders: unknown[] }; warnings: unknown[] };
  assert.deepEqual(localEnvelope.data.placeholders, []);
  assert.deepEqual(localEnvelope.warnings, []);
  assert.deepEqual(await centerPixel(localEnvelope.data.pages[0]!.files.rest!), [0xcc, 0x33, 0x00, 255]);
  await rm(cwdDir, { recursive: true, force: true });
});
