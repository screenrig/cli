import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { COMPOSE_BATCH_CHUNK_SIZE, composeBatch } from "./batch.js";
import { composeCatalog, formatComposeCatalog } from "./catalog.js";
import { composeAndWrite, composeDocument, LOGO_INSET, regionRect, rejectImageLikeOutput, resolveFontFamily } from "./compose.js";
import { defaultCardFill, parseComposeSpec } from "./parse.js";
import { SCALE_MIN, wishOf } from "./type.js";
import { REGIONS } from "./types.js";
import { testTemp } from "../test-temp.js";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertUsage(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal((err as { code?: string }).code, "usage_error");
    assert.match(err.message, pattern);
    return true;
  });
}

async function assertUsageRejects(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal((err as { code?: string }).code, "usage_error");
    assert.match(err.message, pattern);
    return true;
  });
}

function page(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    width: 1920,
    height: 1080,
    background: "#1C1410",
    brand: "#C9A227",
    text: "#F3E6D0",
    left: { title: "FIRE AT THE TABLE", text: "A four-course supper cooked over live coals." },
    ...extra,
  };
}

test("catalog lists regions, not Frame or recipes", () => {
  const catalog = composeCatalog();
  assert.deepEqual(catalog.regions, [...REGIONS]);
  assert.equal(catalog.rules.fontSize, false);
  assert.equal(catalog.rules.xy, false);
  assert.ok(catalog.enter.includes("fade-up"));
  assert.deepEqual(catalog.motion.types, ["spin", "drift"]);
  assert.ok(catalog.examples.slide);
  assert.ok((catalog.examples.slide as { left: unknown }).left);
  const overlayLeft = catalog.examples["overlay-left"] as { image: string; left: { enter: string; card: { fit: string; eyebrow?: string } } };
  const overlayRight = catalog.examples["overlay-right"] as { image: string; right: { enter: string; card: { fit: string; eyebrow?: string } } };
  const overlayBottom = catalog.examples["overlay-bottom"] as { image: string; bottom: { enter: string; card: { fit: string; eyebrow?: string } } };
  const overlayTitle = catalog.examples["overlay-title"] as {
    image: string;
    left: { enter: string; valign: string; eyebrow?: string; card?: unknown };
  };
  const overlayStill = catalog.examples["overlay-still"] as {
    fullpage: { enter: string; eyebrow?: string; card?: unknown };
    image?: unknown;
  };
  assert.equal(overlayLeft.left.enter, "fade-right");
  assert.equal(overlayLeft.left.card.fit, "region");
  assert.equal(overlayRight.right.enter, "fade-left");
  assert.equal(overlayBottom.bottom.enter, "fade-up");
  assert.equal(overlayBottom.bottom.card.fit, "region");
  assert.ok(catalog.examples.overlay);
  assert.ok(catalog.examples["overlay-title"]);
  assert.ok(catalog.examples["overlay-still"]);
  assert.equal(overlayTitle.left.enter, "fade-right");
  assert.equal(overlayTitle.left.valign, "bottom");
  assert.equal(overlayTitle.left.card, undefined);
  assert.ok(overlayTitle.left.eyebrow);
  assert.ok(overlayStill.fullpage);
  assert.equal(overlayStill.fullpage.enter, "fade-in");
  assert.equal(overlayStill.fullpage.card, undefined);
  assert.ok(overlayStill.fullpage.eyebrow);
  assert.equal(overlayStill.image, undefined);
  for (const key of [
    "slide", "menu", "table", "overlay", "overlay-left", "overlay-right", "overlay-bottom",
    "overlay-title", "overlay-still", "deck",
  ]) {
    parseComposeSpec(catalog.examples[key]);
  }
  const formatted = formatComposeCatalog(catalog);
  assert.match(formatted, /regions: fullpage\|left\|right/);
  assert.match(formatted, /fontSize: not authorable/);
  assert.doesNotMatch(formatted, /Frame/);
  assert.doesNotMatch(formatted, /warm-cafe/);
  assert.doesNotMatch(formatted, /recipe_guidance/);
  assert.doesNotMatch(formatted, /\bColumn\b/);
  assert.ok(catalog.region_fields.includes("eyebrow"));
  assert.ok(catalog.region_fields.includes("shadow"));
  assert.ok(catalog.region_fields.includes("outline"));
  assert.ok(catalog.region_fields.includes("card"));
  assert.ok(catalog.region_fields.includes("color"));
  assert.ok(catalog.page_keys.includes("logo"));
  assert.deepEqual(catalog.card_fits, ["region", "ink"]);
  assert.ok(catalog.card_plate_fields.includes("fit"));
  assert.ok(catalog.card_plate_fields.includes("eyebrow"));
  assert.match(catalog.rules.title_color, /eyebrow/);
  assert.match(catalog.rules.shadow, /blur/);
  assert.equal(overlayLeft.left.card.eyebrow, "THE LOW END");
  assert.equal(overlayRight.right.card.eyebrow, "CAPABILITY");
  assert.equal(overlayBottom.bottom.card.eyebrow, "HARDWARE");
  assert.equal(overlayTitle.left.eyebrow, "AUGUST 2026");
  assert.equal(overlayStill.fullpage.eyebrow, "THE PROMISE");
  assert.match(formatted, /1px unblurred drop shadow/);
  assert.match(formatted, /\*\*bold\*\*/);
  assert.match(formatted, /card_fits: region\|ink/);
  assert.match(formatted, /32 px inset/);
});

test("exec-intro lab deck is valid named-region compose JSON", async () => {
  const spec = JSON.parse(await readFile(path.join(process.cwd(), "tools/compositor/examples/exec-intro.json"), "utf8")) as unknown;
  const document = parseComposeSpec(spec);
  assert.deepEqual(document.pages.map((page) => page.id), [
    "title", "ai-transform", "mini-pc", "prices", "low-end", "ai-smart",
    "agent-rise", "enter", "status", "platforms", "agent-how", "rendering",
    "video", "webapps", "cli", "close",
  ]);
  const titleCopy = document.pages[0]!.layers.find((layer) => layer.id === "left");
  assert.equal(titleCopy?.enter?.type, "fade-right");
  assert.equal(titleCopy?.cardFit, null);
  assert.ok(titleCopy?.blocks.some((block) => block.role === "eyebrow"));
  const stillCopy = document.pages.find((page) => page.id === "status")!.layers.find((layer) => layer.id === "fullpage");
  assert.equal(stillCopy?.enter?.type, "fade-in");
  assert.equal(stillCopy?.cardFit, null);
  assert.ok(stillCopy?.blocks.some((block) => block.role === "eyebrow"));
  const lowEnd = document.pages.find((page) => page.id === "low-end")!.layers.find((layer) => layer.id === "left");
  assert.equal(lowEnd?.enter?.type, "fade-right");
  assert.equal(lowEnd?.cardFit, "region");
  const videoCopy = document.pages.find((page) => page.id === "video")!.layers.find((layer) => layer.id === "bottom");
  assert.equal(videoCopy?.enter?.type, "fade-up");
  assert.equal(videoCopy?.cardFit, "region");
  const enterPage = document.pages.find((page) => page.id === "enter")!;
  assert.ok(enterPage.layers.some((layer) => layer.id === "logo"));
  assert.equal(enterPage.layers.find((layer) => layer.id === "background")?.enter, null);
});

test("parse fail-closed rejects Frame, recipes, unknown keys, fontSize, and x/y", () => {
  assertUsage(
    () => parseComposeSpec({ type: "Frame", width: 320, height: 180, children: [{ type: "Text", text: "Hi" }] }),
    /old Frame\/recipe language/,
  );
  assertUsage(
    () => parseComposeSpec({ recipe: "title", title: "Hi", body: "There" }),
    /old Frame\/recipe language/,
  );
  assertUsage(
    () => parseComposeSpec({ width: 320, height: 180, mystery: true, left: { title: "Hi" } }),
    /unknown key mystery/,
  );
  assertUsage(
    () => parseComposeSpec({ width: 320, height: 180, fontSize: 48, left: { title: "Hi" } }),
    /fontSize/,
  );
  assertUsage(
    () => parseComposeSpec({ width: 320, height: 180, left: { title: "Hi", x: 10, y: 20 } }),
    /unknown key x/,
  );
  assertUsage(
    () => parseComposeSpec({ pages: [{ id: "intro", spec: { type: "Frame", width: 64, height: 64 } }] }),
    /unknown key spec/,
  );
});

test("region rects cover landscape and portrait canvases", () => {
  const land = { width: 1920, height: 1080 };
  const left = regionRect("left", land.width, land.height)!;
  const right = regionRect("right", land.width, land.height)!;
  assert.equal(left.x, 0);
  assert.equal(left.w + right.w, land.width);
  assert.equal(right.x, left.w);
  const portrait = { width: 1080, height: 1920 };
  const top = regionRect("top", portrait.width, portrait.height)!;
  const bottom = regionRect("bottom", portrait.width, portrait.height)!;
  const topHalf = regionRect("top-half", portrait.width, portrait.height)!;
  const bottomHalf = regionRect("bottom-half", portrait.width, portrait.height)!;
  const full = regionRect("fullpage", portrait.width, portrait.height)!;
  assert.equal(full.w, 1080);
  assert.equal(full.h, 1920);
  assert.equal(topHalf.h + bottomHalf.h, 1920);
  assert.equal(bottom.y + bottom.h, 1920);
  assert.ok(top.h > 0 && bottom.h > 0);
  const middle = regionRect("middle-third", portrait.width, portrait.height)!;
  assert.ok(middle.w > 0 && middle.h === 1920);
});

test("compose render writes layered PNGs and a playlist-shaped manifest", async () => {
  const dir = await testTemp("compose-layers-");
  const written = await composeAndWrite(page(), {
    baseDir: dir,
    outDir: dir,
    combined: true,
  });
  assert.equal(written.canvas.width, 1920);
  assert.equal(written.canvas.height, 1080);
  assert.ok(written.files.includes("background.png"));
  assert.ok(written.files.includes("left.png"));
  assert.ok(written.files.includes("manifest.json"));
  assert.ok(written.files.includes("combined.png"));
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as {
    version: number;
    canvas: { width: number; height: number };
    layers: Array<{ id: string; file: string; z: number; rect: { x: number; y: number; width: number; height: number }; enter?: { type: string; stagger?: number } }>;
  };
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.canvas, { width: 1920, height: 1080 });
  const left = manifest.layers.find((layer) => layer.id === "left");
  assert.ok(left);
  assert.equal(left.file, "left.png");
  assert.equal(typeof left.z, "number");
  assert.ok(Number.isInteger(left.rect.x) && Number.isInteger(left.rect.y));
  assert.ok(Number.isInteger(left.rect.width) && Number.isInteger(left.rect.height));
  const png = await readFile(path.join(dir, "left.png"));
  assert.ok(png.subarray(0, 8).equals(PNG_HEADER));
  const combined = await readFile(path.join(dir, "combined.png"));
  assert.ok(combined.subarray(0, 8).equals(PNG_HEADER));
  await rm(dir, { recursive: true, force: true });
});

test("enter and motion on the manifest match playlist PrimitiveEnter / PrimitiveMotion", async () => {
  const dir = await testTemp("compose-motion-");
  const result = await composeDocument({
    ...page(),
    motion: { type: "drift", zoom: "in", direction: "none", speed: "slow" },
    left: { enter: "fade-up", stagger: 2, title: "Hello" },
    right: { motion: { type: "spin", direction: "cw", speed: "slow" }, fill: "#00000080" },
  }, { baseDir: dir });
  const manifest = result.pages[0]!.manifest;
  const background = manifest.layers.find((layer) => layer.id === "background");
  const left = manifest.layers.find((layer) => layer.id === "left");
  const right = manifest.layers.find((layer) => layer.id === "right");
  assert.deepEqual(background?.motion, { type: "drift", zoom: "in", direction: "none", speed: "slow" });
  assert.deepEqual(left?.enter, { type: "fade-up", stagger: 2 });
  assert.deepEqual(right?.motion, { type: "spin", direction: "cw", speed: "slow" });
  await rm(dir, { recursive: true, force: true });
});

test("a type-only region uses one scale for every role", async () => {
  const dir = await testTemp("compose-scale-");
  const result = await composeDocument({
    width: 1920,
    height: 1080,
    background: "#1C1410",
    text: "#F3E6D0",
    left: {
      title: "A long packed menu title that should tighten",
      text: Array.from({ length: 12 }, (_, i) => `Course ${i + 1} with a descriptive line of copy.`),
    },
  }, { baseDir: dir });
  const left = result.pages[0]!.painted.find((item) => item.id === "left");
  assert.ok(left);
  assert.ok(left.scale >= 0.65 && left.scale <= 1.35);
  const sizes = result.pages[0]!.quality.text.filter((item) => item.layer === "left");
  const title = sizes.find((item) => item.role === "title");
  const body = sizes.find((item) => item.role === "text");
  assert.ok(title && body);
  const titleWish = wishOf("title", 1080);
  const bodyWish = wishOf("text", 1080);
  const titleRatio = title.font_size / titleWish;
  const bodyRatio = body.font_size / bodyWish;
  assert.ok(Math.abs(titleRatio - left.scale) < 0.35 || title.font_size <= titleWish);
  assert.ok(Math.abs(bodyRatio - left.scale) < 0.2);
  const single = await composeDocument({
    width: 1920,
    height: 1080,
    background: "#1C1410",
    text: "#F3E6D0",
    left: { title: "Hi" },
  }, { baseDir: dir });
  assert.equal(single.pages[0]!.painted.find((item) => item.id === "left")?.scale, 1);
  await rm(dir, { recursive: true, force: true });
});

test("missing font is usage_error", async () => {
  await assertUsageRejects(
    () => composeDocument({ ...page(), font: "DefinitelyNotAInstalledFamily" }, { baseDir: process.cwd() }),
    /font family not installed/,
  );
});

test("image upscale above 1.25x warns without resizing the canvas", async () => {
  const dir = await testTemp("compose-upscale-");
  const tiny = createCanvas(32, 32);
  const ctx = tiny.getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 32, 32);
  await writeFile(path.join(dir, "tiny.png"), tiny.toBuffer("image/png"));
  const result = await composeDocument({
    width: 1920,
    height: 1080,
    background: "#000000",
    text: "#ffffff",
    right: { image: "./tiny.png" },
  }, { baseDir: dir });
  assert.equal(result.canvas.width, 1920);
  assert.ok(result.pages[0]!.warnings.some((warning) => warning.code === "image_upscaled"));
  await rm(dir, { recursive: true, force: true });
});

test("deck pages[] writes per-page directories", async () => {
  const dir = await testTemp("compose-deck-");
  const written = await composeAndWrite({
    width: 640,
    height: 360,
    background: "#111111",
    text: "#eeeeee",
    pages: [
      { id: "one", left: { title: "One" } },
      { id: "two", right: { title: "Two" } },
    ],
  }, { baseDir: dir, outDir: dir });
  assert.equal(written.pages.length, 2);
  assert.ok(written.files.includes("one/manifest.json"));
  assert.ok(written.files.includes("two/manifest.json"));
  assert.ok(written.files.includes("deck.json"));
  const deck = JSON.parse(await readFile(path.join(dir, "deck.json"), "utf8")) as { pages: Array<{ id: string }> };
  assert.deepEqual(deck.pages.map((page) => page.id), ["one", "two"]);
  await rm(dir, { recursive: true, force: true });
});

test("table with more than two columns sizes every column", async () => {
  const dir = await testTemp("compose-table-");
  const result = await composeDocument({
    width: 1920,
    height: 1080,
    background: "#0E1A2B",
    brand: "#FFB800",
    text: "#F4F7FA",
    fullpage: {
      title: "Saturday",
      table: {
        columns: ["Time", "Hall", "Event", "Seats"],
        rows: [
          ["09:00", "A", "Doors", "120"],
          ["10:30", "B", "Keynote", "80"],
          ["14:00", "A", "Labs", "40"],
        ],
      },
    },
  }, { baseDir: dir });
  const page = result.pages[0]!;
  assert.ok(page.quality.text.some((item) => item.role === "table"));
  const tableInk = page.quality.text.filter((item) => item.layer === "fullpage" && item.role === "table");
  assert.ok(tableInk.length >= 4);
  const xs = [...new Set(tableInk.map((item) => Math.round(item.ink.x)))].sort((a, b) => a - b);
  assert.ok(xs.length >= 3, `expected several column origins, got ${xs.join(",")}`);
  await rm(dir, { recursive: true, force: true });
});

test("1080p mid body wish is in the CLI ~45 px class", () => {
  assert.equal(wishOf("text", 1080), 45);
  assert.equal(wishOf("title", 1080), 130);
  assert.equal(wishOf("eyebrow", 1080), 32);
});

test("output-upscale and safe-area warnings stay nonblocking", async () => {
  const result = await composeDocument(page({
    left: { title: "Edge", align: "left" },
  }), { baseDir: process.cwd(), target: { width: 3840, height: 2160 }, safeArea: true });
  assert.equal(result.canvas.width, 1920);
  assert.ok(result.pages[0]!.warnings.some((warning) => warning.code === "compose_output_upscaled"));
  assert.ok(result.pages[0]!.warnings.some((warning) => warning.code === "text_outside_safe_area"));
  assert.deepEqual(result.pages[0]!.quality.target, { width: 3840, height: 2160 });
});

test("compose batch contact-sheet and --only use the same engine", async () => {
  const dir = await testTemp("compose-batch-");
  const input = path.join(dir, "deck.json");
  await writeFile(input, JSON.stringify({
    width: 320,
    height: 180,
    background: "#111111",
    text: "#eeeeee",
    pages: [
      { id: "one", left: { title: "One" } },
      { id: "two", left: { title: "Two" } },
    ],
  }));
  const output = path.join(dir, "rendered");
  const first = await composeBatch(input, output);
  assert.equal(first.rendered, 2);
  assert.equal(first.failed, 0);
  assert.ok((await readFile(first.preview)).subarray(0, 8).equals(PNG_HEADER));
  assert.equal(existsSync(path.join(output, "one", "manifest.json")), true);
  assert.equal(existsSync(path.join(output, "two", "manifest.json")), true);
  assert.equal(existsSync(path.join(output, "manifest.json")), false);
  const retry = await composeBatch(input, output, { only: "two" });
  assert.equal(retry.rendered, 1);
  assert.equal(retry.not_selected, 1);
  assert.equal(retry.pages.find((page) => page.id === "two")?.output, path.join(output, "two"));
  assert.equal(existsSync(path.join(output, "two", "manifest.json")), true);
  assert.equal(existsSync(path.join(output, "one", "manifest.json")), true);
  assert.equal(existsSync(path.join(output, "manifest.json")), false);
  await rm(dir, { recursive: true, force: true });
});

test("compose batch continues after one page image fails", async () => {
  const dir = await testTemp("compose-batch-fail-");
  const input = path.join(dir, "deck.json");
  await writeFile(input, JSON.stringify({
    width: 64,
    height: 36,
    background: "#111111",
    text: "#eeeeee",
    pages: [
      { id: "ok", left: { title: "Hello" } },
      { id: "bad", left: { image: "./missing.png" } },
      { id: "also", right: { title: "There" } },
    ],
  }));
  const output = path.join(dir, "rendered");
  const result = await composeBatch(input, output);
  assert.equal(result.rendered, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.pages.find((page) => page.id === "bad")?.status, "failed");
  assert.equal(result.pages.find((page) => page.id === "ok")?.status, "rendered");
  assert.equal(result.pages.find((page) => page.id === "also")?.status, "rendered");
  await rm(dir, { recursive: true, force: true });
});

test("compose batch chunk_timings has more than one chunk above 100 pages", { timeout: 120000 }, async () => {
  const dir = await testTemp("compose-batch-chunks-");
  const input = path.join(dir, "deck.json");
  const count = COMPOSE_BATCH_CHUNK_SIZE + 1;
  const pages = Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, left: { title: "Hi" } }));
  await writeFile(input, JSON.stringify({
    width: 640,
    height: 360,
    background: "#111111",
    text: "#eeeeee",
    pages,
  }));
  const output = path.join(dir, "rendered");
  const result = await composeBatch(input, output);
  assert.equal(result.rendered, count);
  assert.equal(result.failed, 0);
  assert.ok(result.chunk_timings.length > 1, `expected multiple chunks, got ${result.chunk_timings.length}`);
  assert.equal(result.chunks, result.chunk_timings.length);
  await rm(dir, { recursive: true, force: true });
});

test("image-like --output is usage_error naming a directory", () => {
  assertUsage(() => rejectImageLikeOutput("foo.png", "compose render"), /directory/);
  assertUsage(() => rejectImageLikeOutput("still.webp", "compose render"), /directory/);
  assertUsage(() => rejectImageLikeOutput("out.jpg", "compose batch"), /directory/);
  rejectImageLikeOutput("still", "compose render");
});

test("resolveFontFamily still fails closed on a missing name", () => {
  assertUsage(() => resolveFontFamily("DefinitelyNotAInstalledFamily"), /font family not installed/);
});

test("region title follows text; card-item title and eyebrow follow brand; body uses muted", async () => {
  const dir = await testTemp("compose-title-color-");
  const base = { width: 640, height: 360, background: "#111111", brand: "#FF0000", text: "#0000FF" };
  const png = async (spec: Record<string, unknown>) => {
    const result = await composeDocument(spec, { baseDir: dir });
    return result.pages[0]!.painted.find((item) => item.id === "left")!.png!;
  };
  const regionTitle = await png({ ...base, left: { title: "HELLO" } });
  const otherBrandTitle = await png({ ...base, brand: "#00FF00", left: { title: "HELLO" } });
  const otherTextTitle = await png({ ...base, text: "#00FFFF", left: { title: "HELLO" } });
  assert.equal(regionTitle.equals(otherBrandTitle), true);
  assert.equal(regionTitle.equals(otherTextTitle), false);
  const cardTitle = await png({ ...base, left: { cards: [{ title: "HELLO" }] } });
  const otherBrandCard = await png({ ...base, brand: "#00FF00", left: { cards: [{ title: "HELLO" }] } });
  const otherTextCard = await png({ ...base, text: "#00FFFF", left: { cards: [{ title: "HELLO" }] } });
  assert.equal(cardTitle.equals(otherBrandCard), false);
  assert.equal(cardTitle.equals(otherTextCard), true);
  const eyebrow = await png({ ...base, left: { eyebrow: "KICKER" } });
  const otherBrandEyebrow = await png({ ...base, brand: "#00FF00", left: { eyebrow: "KICKER" } });
  const otherTextEyebrow = await png({ ...base, text: "#00FFFF", left: { eyebrow: "KICKER" } });
  assert.equal(eyebrow.equals(otherBrandEyebrow), false);
  assert.equal(eyebrow.equals(otherTextEyebrow), true);
  const body = await png({ ...base, left: { text: "BODY COPY HERE" } });
  const otherBrandBody = await png({ ...base, brand: "#00FF00", left: { text: "BODY COPY HERE" } });
  const otherTextBody = await png({ ...base, text: "#00FFFF", left: { text: "BODY COPY HERE" } });
  const otherBgBody = await png({ ...base, background: "#FFFFFF", left: { text: "BODY COPY HERE" } });
  assert.equal(body.equals(otherBrandBody), true);
  assert.equal(body.equals(otherTextBody), false);
  assert.equal(body.equals(otherBgBody), false);
  const overridden = await png({ ...base, left: { title: "HELLO", color: "#FFFFFF" } });
  const rebranded = await png({ ...base, brand: "#00FF00", left: { title: "HELLO", color: "#FFFFFF" } });
  assert.equal(overridden.equals(rebranded), true);
  await rm(dir, { recursive: true, force: true });
});

test("eyebrow parses above title, then subtitle, then text", () => {
  const document = parseComposeSpec({
    width: 64,
    height: 64,
    left: { title: "Headline", subtitle: "Sub", eyebrow: "KICKER", text: "Body" },
  });
  const left = document.pages[0]!.layers.find((layer) => layer.id === "left");
  assert.ok(left);
  assert.deepEqual(
    left.blocks.map((block) => block.role),
    ["eyebrow", "title", "subtitle", "text"],
  );
});

async function sampleAlpha(png: Buffer, x: number, y: number): Promise<number> {
  const img = await loadImage(png);
  const ctx = createCanvas(img.width, img.height).getContext("2d");
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(x, y, 1, 1).data[3] ?? 0;
}

test("card plate fills the region with background+B3 and rejects siblings", async () => {
  const parsed = parseComposeSpec({
    width: 640,
    height: 360,
    background: "#112233",
    text: "#EEEEEE",
    left: { card: { title: "Menu" } },
  });
  const left = parsed.pages[0]!.layers.find((layer) => layer.id === "left");
  assert.ok(left);
  assert.equal(left.fill, defaultCardFill("#112233"));
  assert.equal(left.fill, "#112233B3");
  assert.equal(left.cardFit, "region");
  assert.ok(left.blocks.some((block) => block.role === "title"));
  assertUsage(
    () => parseComposeSpec({ width: 64, height: 64, left: { card: { title: "A" }, title: "B" } }),
    /cannot mix card/,
  );
  assertUsage(
    () => parseComposeSpec({ width: 64, height: 64, left: { card: { card: { title: "A" } } } }),
    /cannot nest card/,
  );
  assertUsage(
    () => parseComposeSpec({ width: 64, height: 64, left: { card: { title: "A", fit: "wide" } } }),
    /card\.fit/,
  );
  const custom = parseComposeSpec({
    width: 64,
    height: 64,
    background: "#000000",
    left: { card: { fill: "#FF00FF80", title: "Hi", color: "#FFFFFF" } },
  });
  const plate = custom.pages[0]!.layers.find((layer) => layer.id === "left");
  assert.equal(plate?.fill, "#FF00FF80");
  assert.equal(plate?.ink, "#FFFFFF");
});

test("card.fit region fills the box; ink hugs type plus pad", async () => {
  const dir = await testTemp("compose-card-fit-");
  const spec = {
    width: 1920,
    height: 1080,
    background: "#0D0D0D",
    brand: "#D4AF37",
    text: "#F2EDE4",
  };
  const region = await composeDocument({
    ...spec,
    bottom: { valign: "bottom", card: { title: "Afterimage", text: "Split Stage" } },
  }, { baseDir: dir });
  const ink = await composeDocument({
    ...spec,
    bottom: { valign: "bottom", card: { fit: "ink", title: "Afterimage", text: "Split Stage" } },
  }, { baseDir: dir });
  const regionLayer = region.pages[0]!.layers.find((layer) => layer.id === "bottom");
  const inkLayer = ink.pages[0]!.layers.find((layer) => layer.id === "bottom");
  assert.equal(regionLayer?.cardFit, "region");
  assert.equal(inkLayer?.cardFit, "ink");
  const regionPng = region.pages[0]!.painted.find((item) => item.id === "bottom")!.png!;
  const inkPng = ink.pages[0]!.painted.find((item) => item.id === "bottom")!.png!;
  const regionImg = await loadImage(regionPng);
  const farX = regionImg.width - 12;
  const midY = Math.round(regionImg.height / 2);
  assert.ok(await sampleAlpha(regionPng, farX, midY) > 80, "region fit paints a full-width plate");
  assert.equal(await sampleAlpha(inkPng, farX, midY), 0, "ink fit does not paint a full-width band");
  assert.equal(await sampleAlpha(inkPng, 0, regionImg.height - 1), 0, "ink-fit plate is not flush to x=0");
  assert.equal(await sampleAlpha(inkPng, regionImg.width - 1, regionImg.height - 1), 0, "ink-fit plate is not flush to width");
  const insetX = Math.round(regionImg.width * 0.12);
  const insetY = Math.round(regionImg.height * 0.35);
  assert.ok(await sampleAlpha(inkPng, insetX, insetY) > 80, "ink fit still paints around the type");
  const poor = await composeDocument({
    ...spec,
    left: { card: { fill: "#EEEEEE", title: "Hi", color: "#DDDDDD" } },
  }, { baseDir: dir });
  assert.ok(poor.pages[0]!.warnings.some((warning) => warning.code === "card_low_contrast"));
  await rm(dir, { recursive: true, force: true });
});

test("logo sits 32px inset, contains to 200x100, and never upscales", async () => {
  const dir = await testTemp("compose-logo-");
  const mark = createCanvas(200, 80);
  mark.getContext("2d").fillStyle = "#ff00ff";
  mark.getContext("2d").fillRect(0, 0, 200, 80);
  await writeFile(path.join(dir, "mark.png"), mark.toBuffer("image/png"));
  const fitted = await composeDocument({
    width: 1920,
    height: 1080,
    background: "#111111",
    text: "#eeeeee",
    logo: "./mark.png",
    left: { title: "Hi" },
  }, { baseDir: dir });
  const logo = fitted.pages[0]!.manifest.layers.find((layer) => layer.id === "logo");
  assert.ok(logo);
  assert.equal(logo.rect.width, 200);
  assert.equal(logo.rect.height, 80);
  assert.equal(logo.rect.x, 1920 - LOGO_INSET - 200);
  assert.equal(logo.rect.y, 1080 - LOGO_INSET - 80);
  assert.equal(logo.rect.x, 1688);
  assert.equal(logo.rect.y, 968);
  const small = createCanvas(80, 40);
  small.getContext("2d").fillStyle = "#ff00ff";
  small.getContext("2d").fillRect(0, 0, 80, 40);
  await writeFile(path.join(dir, "small.png"), small.toBuffer("image/png"));
  const native = await composeDocument({
    width: 640,
    height: 360,
    background: "#111111",
    text: "#eeeeee",
    logo: "./small.png",
    left: { title: "Hi" },
  }, { baseDir: dir });
  const nativeLogo = native.pages[0]!.manifest.layers.find((layer) => layer.id === "logo");
  assert.ok(nativeLogo);
  assert.equal(nativeLogo.rect.width, 80);
  assert.equal(nativeLogo.rect.height, 40);
  assert.equal(nativeLogo.rect.x, 640 - LOGO_INSET - 80);
  assert.equal(nativeLogo.rect.y, 360 - LOGO_INSET - 40);
  const large = createCanvas(400, 300);
  large.getContext("2d").fillStyle = "#00ffff";
  large.getContext("2d").fillRect(0, 0, 400, 300);
  await writeFile(path.join(dir, "large.png"), large.toBuffer("image/png"));
  const contained = await composeDocument({
    width: 640,
    height: 360,
    background: "#111111",
    text: "#eeeeee",
    logo: { src: "./large.png", corner: "top-left" },
    left: { title: "Hi" },
  }, { baseDir: dir });
  const top = contained.pages[0]!.manifest.layers.find((layer) => layer.id === "logo");
  assert.ok(top);
  assert.equal(top.rect.x, LOGO_INSET);
  assert.equal(top.rect.y, LOGO_INSET);
  assert.ok(top.rect.width <= 200 && top.rect.height <= 100);
  assert.ok(top.rect.width < 400);
  await rm(dir, { recursive: true, force: true });
});

test("markdown bold paints and strips markers from measured copy", async () => {
  const dir = await testTemp("compose-markdown-");
  const marked = await composeDocument({
    width: 640,
    height: 360,
    background: "#111111",
    text: "#eeeeee",
    left: { text: "Pay **£86** tonight" },
  }, { baseDir: dir });
  const plain = await composeDocument({
    width: 640,
    height: 360,
    background: "#111111",
    text: "#eeeeee",
    left: { text: "Pay £86 tonight" },
  }, { baseDir: dir });
  const markedPng = marked.pages[0]!.painted.find((item) => item.id === "left")!.png;
  const plainPng = plain.pages[0]!.painted.find((item) => item.id === "left")!.png;
  assert.ok(markedPng && plainPng);
  assert.equal(markedPng.equals(plainPng), false);
  assert.ok(marked.pages[0]!.quality.text.some((item) => item.layer === "left"));
  await rm(dir, { recursive: true, force: true });
});

test("a packed region that cannot fit at the minimum type scale is a usage_error naming the region, not a shipped PNG", async () => {
  const dir = await testTemp("compose-overflow-");
  await assertUsageRejects(() => composeDocument({
    width: 640,
    height: 200,
    background: "#1C1410",
    text: "#F3E6D0",
    left: {
      title: "A packed title that will not fit",
      text: Array.from({ length: 40 }, (_, i) => `Course ${i + 1} with a descriptive line of copy.`),
    },
  }, { baseDir: dir }), new RegExp(`^left: copy does not fit the left region at ${SCALE_MIN.toFixed(2)}× type scale \\(the minimum\\)`));
  await rm(dir, { recursive: true, force: true });
});

/**
 * UAT round 1, E10: the skill's own lower third (`fit: "ink"` with a title and
 * one line of text) sized its type to the region, then hugged only the title;
 * the body line painted below the plate and the PNG still shipped. The plate
 * must contain every measured line.
 */
test("an ink-fit card hugs every measured line and reports no overflow", async () => {
  const dir = await testTemp("compose-ink-hug-");
  const result = await composeDocument({
    width: 1920,
    height: 1080,
    font: "Noto Sans",
    background: "#00000000",
    brand: "#FFD166",
    text: "#FFFFFF",
    bottom: { valign: "bottom", card: { fit: "ink", title: "Pizza night Friday", text: "From 5pm, until the dough runs out." } },
  }, { baseDir: dir });
  const page = result.pages[0]!;
  const bottom = page.painted.find((item) => item.id === "bottom");
  assert.ok(bottom);
  assert.equal(bottom.overflow, false);
  assert.equal(page.warnings.some((warning) => warning.code === "text_overflow"), false);
  const layer = page.layers.find((item) => item.id === "bottom")!;
  const runs = page.quality.text.filter((run) => run.layer === "bottom");
  assert.equal(runs.length, 2);
  // Every measured line ends inside the region; the plate is the region's
  // fitted inner box, so the body line can no longer hang past it.
  const bottomEdge = Math.max(...runs.map((run) => run.box.y + run.box.height));
  assert.ok(bottomEdge <= layer.y + layer.h - layer.pad - 24, `type bottom ${bottomEdge} exceeds plate bottom`);
  // The painted plate is opaque where the type sits and transparent above it.
  const png = await loadImage(bottom.png!);
  const canvas = createCanvas(png.width, png.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(png, 0, 0);
  const lastRun = runs[runs.length - 1]!;
  const probeY = Math.round(lastRun.box.y + lastRun.box.height - layer.y - 1);
  const probeX = Math.round(lastRun.box.x - layer.x + 4);
  const under = ctx.getImageData(probeX, probeY, 1, 1).data;
  assert.ok(under[3]! > 0, "plate must be painted under the last line of type");
  const above = ctx.getImageData(probeX, 2, 1, 1).data;
  assert.equal(above[3], 0, "the plate hugs the type and leaves the region top transparent");
  await rm(dir, { recursive: true, force: true });
});

test("an ink-fit card whose copy cannot fit at the minimum scale is a usage_error naming the card path", async () => {
  const dir = await testTemp("compose-ink-overflow-");
  await assertUsageRejects(() => composeDocument({
    width: 640,
    height: 200,
    background: "#1C1410",
    text: "#F3E6D0",
    bottom: { card: { fit: "ink", title: "Pizza night Friday", text: Array.from({ length: 12 }, () => "From 5pm, until the dough runs out.").join(" ") } },
  }, { baseDir: dir }), /^bottom\.card: copy does not fit the bottom region at 0\.65× type scale \(the minimum\)/);
  await rm(dir, { recursive: true, force: true });
});

/**
 * UAT round 1, E7: three thirds of a menu each centred their own copy, so the
 * column titles sat at three different heights. Regions in one row share a
 * type scale and a starting line.
 */
test("regions in one row share a type scale and title baseline regardless of body length", async () => {
  const dir = await testTemp("compose-row-baseline-");
  const spec = {
    width: 1920,
    height: 1080,
    font: "Noto Sans",
    background: "#1B1B1F",
    brand: "#E9C46A",
    text: "#F1FAEE",
    "left-third": { title: "Breads", cards: [{ title: "Country white", price: "6" }, { title: "Seeded rye", price: "7" }, { title: "Olive & rosemary", price: "8" }] },
    "middle-third": { title: "Pastries", cards: [{ title: "Cardamom bun", price: "4" }, { title: "Cinnamon knot", price: "4" }, { title: "Almond croissant", price: "5" }] },
    "right-third": { title: "Drinks", cards: [{ title: "Filter coffee", price: "3.5" }] },
  };
  const result = await composeDocument(spec, { baseDir: dir });
  const page = result.pages[0]!;
  const titles = page.quality.text.filter((run) => run.role === "title");
  assert.equal(titles.length, 3);
  assert.equal(new Set(titles.map((run) => run.box.y)).size, 1, JSON.stringify(titles.map((run) => [run.layer, run.box.y])));
  assert.equal(new Set(titles.map((run) => run.font_size)).size, 1);
  const scales = page.painted.filter((item) => item.id.endsWith("-third")).map((item) => item.scale);
  assert.equal(new Set(scales).size, 1, JSON.stringify(scales));
  // The quality report holds one title per region: measurement passes do not leak.
  assert.equal(page.quality.fonts.filter((font) => font.layer === "right-third.title").length, 1);
  // An explicit valign opts a region out of the shared row.
  const explicit = await composeDocument({ ...spec, "right-third": { ...spec["right-third"], valign: "bottom" } }, { baseDir: dir });
  const right = explicit.pages[0]!.quality.text.find((run) => run.role === "title" && run.layer === "right-third")!;
  const left = explicit.pages[0]!.quality.text.find((run) => run.role === "title" && run.layer === "left-third")!;
  assert.ok(right.box.y > left.box.y);
  await rm(dir, { recursive: true, force: true });
});

test("region-only video is a hole with media.rect and no dashed placeholder PNG", async () => {
  const dir = await testTemp("compose-region-video-");
  const written = await composeAndWrite({
    width: 640,
    height: 360,
    background: "#111111",
    text: "#eeeeee",
    left: { video: "./clip.mp4" },
  }, { baseDir: dir, outDir: dir });
  const layer = written.manifest?.layers.find((item) => item.id === "left");
  assert.ok(layer);
  assert.equal(layer.file, undefined);
  assert.equal(layer.media?.type, "video");
  assert.equal(layer.media?.src, "./clip.mp4");
  assert.ok(layer.media?.rect);
  assert.equal(layer.media?.rect?.width > 0, true);
  assert.equal(written.files.includes("left.png"), false);
  const painted = written.result.pages[0]!.painted.find((item) => item.id === "left");
  assert.equal(painted?.png, null);
  await rm(dir, { recursive: true, force: true });
});

test("numeric table column keeps a gutter from the next column", async () => {
  const dir = await testTemp("compose-table-gutter-");
  const result = await composeDocument({
    width: 640,
    height: 360,
    background: "#0E1A2B",
    brand: "#FFB800",
    text: "#F4F7FA",
    fullpage: {
      table: {
        columns: ["Count", "Event"],
        rows: [
          ["4", "On time"],
          ["12", "Late"],
        ],
      },
    },
  }, { baseDir: dir });
  const cells = result.pages[0]!.quality.text.filter((item) => item.layer === "fullpage" && item.role === "table");
  assert.ok(cells.length >= 4, JSON.stringify(cells));
  const firstRow = cells.filter((item) => Math.abs(item.ink.y - cells[0]!.ink.y) < 2).sort((a, b) => a.ink.x - b.ink.x);
  assert.ok(firstRow.length >= 2);
  const left = firstRow[0]!;
  const right = firstRow[1]!;
  const gap = right.ink.x - (left.ink.x + left.ink.width);
  assert.ok(gap >= 8, `expected a gutter between columns, got ${gap} (${left.ink.x}+${left.ink.width} vs ${right.ink.x})`);
  await rm(dir, { recursive: true, force: true });
});

test("iframe is a manifest hole, not a painted PNG, and accepts a URL", async () => {
  const dir = await testTemp("compose-iframe-");
  const written = await composeAndWrite({
    width: 640,
    height: 360,
    background: "#111111",
    text: "#eeeeee",
    left: { iframe: "https://example.com/board" },
  }, { baseDir: dir, outDir: dir });
  const layer = written.manifest?.layers.find((item) => item.id === "left");
  assert.ok(layer);
  assert.equal(layer.file, undefined);
  assert.equal(layer.media?.type, "iframe");
  assert.equal(layer.media?.src, "https://example.com/board");
  assert.ok(layer.media?.rect);
  assert.equal(layer.media?.rect?.width > 0, true);
  assert.equal(written.files.includes("left.png"), false);
  await rm(dir, { recursive: true, force: true });
});

test("text over video gets an automatic drop shadow unless shadow is none", async () => {
  const dir = await testTemp("compose-shadow-");
  const spec = {
    width: 640,
    height: 360,
    background: "#0D0D0D",
    text: "#F2EDE4",
    video: "./clip.mp4",
    top: { align: "center", title: "MOTHLIGHT" },
  };
  const auto = await composeDocument(spec, { baseDir: dir });
  const none = await composeDocument({
    ...spec,
    top: { align: "center", title: "MOTHLIGHT", shadow: "none" },
  }, { baseDir: dir });
  const autoPng = auto.pages[0]!.painted.find((item) => item.id === "top")!.png;
  const nonePng = none.pages[0]!.painted.find((item) => item.id === "top")!.png;
  assert.ok(autoPng && nonePng);
  assert.equal(autoPng.equals(nonePng), false);
  const explicit = await composeDocument({
    ...spec,
    top: { align: "center", title: "MOTHLIGHT", shadow: { x: 3, y: 3, color: "#FF00FF" } },
  }, { baseDir: dir });
  const explicitPng = explicit.pages[0]!.painted.find((item) => item.id === "top")!.png;
  assert.ok(explicitPng);
  assert.equal(explicitPng.equals(autoPng), false);
  const blurred = await composeDocument({
    ...spec,
    top: { align: "center", title: "MOTHLIGHT", shadow: { x: 3, y: 3, color: "#FF00FF", blur: 8 } },
  }, { baseDir: dir });
  const blurredPng = blurred.pages[0]!.painted.find((item) => item.id === "top")!.png;
  assert.ok(blurredPng);
  assert.equal(blurredPng.equals(explicitPng), false);
  await rm(dir, { recursive: true, force: true });
});

test("outline is off unless set", async () => {
  const dir = await testTemp("compose-outline-");
  const spec = {
    width: 640,
    height: 360,
    background: "#1A1024",
    text: "#F4F0FF",
    video: "./clip.mp4",
    top: { align: "center", title: "MOTHLIGHT", shadow: "none" },
  };
  const plain = await composeDocument(spec, { baseDir: dir });
  const outlined = await composeDocument({
    ...spec,
    top: { align: "center", title: "MOTHLIGHT", shadow: "none", outline: { width: 2, color: "#1A1024" } },
  }, { baseDir: dir });
  const plainPng = plain.pages[0]!.painted.find((item) => item.id === "top")!.png;
  const outlinedPng = outlined.pages[0]!.painted.find((item) => item.id === "top")!.png;
  assert.ok(plainPng && outlinedPng);
  assert.equal(plainPng.equals(outlinedPng), false);
  assertUsage(
    () => parseComposeSpec({ width: 64, height: 64, left: { title: "Hi", outline: { width: 0.2, color: "#000000" } } }),
    /outline\.width/,
  );
  const withBlur = parseComposeSpec({
    width: 64,
    height: 64,
    left: { title: "Hi", shadow: { x: 1, y: 2, blur: 4, color: "#000000" } },
  });
  const leftShadow = withBlur.pages[0]!.layers.find((layer) => layer.id === "left")?.shadow;
  assert.deepEqual(leftShadow, { x: 1, y: 2, color: "#000000", blur: 4 });
  assertUsage(
    () => parseComposeSpec({ width: 64, height: 64, left: { title: "Hi", shadow: { x: 1, y: 1, blur: 33, color: "#000000" } } }),
    /shadow\.blur/,
  );
  await rm(dir, { recursive: true, force: true });
});
