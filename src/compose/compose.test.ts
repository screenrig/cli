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
  const formatted = formatComposeCatalog(catalog);
  assert.match(formatted, /regions: fullpage\|left\|right/);
  assert.match(formatted, /fontSize: not authorable/);
  assert.doesNotMatch(formatted, /Frame/);
  assert.doesNotMatch(formatted, /warm-cafe/);
  assert.doesNotMatch(formatted, /recipe_guidance/);
  assert.doesNotMatch(formatted, /\bColumn\b/);
  assert.ok(catalog.region_fields.includes("shadow"));
  assert.ok(catalog.region_fields.includes("outline"));
  assert.ok(catalog.region_fields.includes("card"));
  assert.ok(catalog.region_fields.includes("color"));
  assert.ok(catalog.page_keys.includes("logo"));
  assert.deepEqual(catalog.card_fits, ["region", "ink"]);
  assert.ok(catalog.card_plate_fields.includes("fit"));
  assert.match(formatted, /1px unblurred drop shadow/);
  assert.match(formatted, /\*\*bold\*\*/);
  assert.match(formatted, /card_fits: region\|ink/);
  assert.match(formatted, /32 px inset/);
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
  assert.equal(wishOf("title", 1080), 86);
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
    width: 64,
    height: 36,
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

test("region title and card-item title default to brand; color overrides the box", async () => {
  const dir = await testTemp("compose-title-color-");
  const base = { width: 640, height: 360, background: "#111111", brand: "#FF0000", text: "#0000FF" };
  const brandTitle = await composeDocument({ ...base, left: { title: "HELLO" } }, { baseDir: dir });
  const otherBrand = await composeDocument({ ...base, brand: "#00FF00", left: { title: "HELLO" } }, { baseDir: dir });
  const otherText = await composeDocument({ ...base, text: "#00FFFF", left: { title: "HELLO" } }, { baseDir: dir });
  const brandPng = brandTitle.pages[0]!.painted.find((item) => item.id === "left")!.png!;
  const otherBrandPng = otherBrand.pages[0]!.painted.find((item) => item.id === "left")!.png!;
  const otherTextPng = otherText.pages[0]!.painted.find((item) => item.id === "left")!.png!;
  assert.equal(brandPng.equals(otherBrandPng), false);
  assert.equal(brandPng.equals(otherTextPng), true);
  const overridden = await composeDocument({
    ...base,
    left: { title: "HELLO", color: "#FFFFFF" },
  }, { baseDir: dir });
  const rebranded = await composeDocument({
    ...base,
    brand: "#00FF00",
    left: { title: "HELLO", color: "#FFFFFF" },
  }, { baseDir: dir });
  assert.equal(
    overridden.pages[0]!.painted.find((item) => item.id === "left")!.png!.equals(
      rebranded.pages[0]!.painted.find((item) => item.id === "left")!.png!,
    ),
    true,
  );
  await rm(dir, { recursive: true, force: true });
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

test("a packed region that cannot fit at scale 1 renders below 1 and warns text_overflow", async () => {
  const dir = await testTemp("compose-overflow-");
  const result = await composeDocument({
    width: 640,
    height: 200,
    background: "#1C1410",
    text: "#F3E6D0",
    left: {
      title: "A packed title that will not fit",
      text: Array.from({ length: 40 }, (_, i) => `Course ${i + 1} with a descriptive line of copy.`),
    },
  }, { baseDir: dir });
  const left = result.pages[0]!.painted.find((item) => item.id === "left");
  assert.ok(left);
  assert.ok(left.scale < 1, `expected scale < 1, got ${left.scale}`);
  assert.ok(left.scale <= SCALE_MIN + 0.01, `expected min scale, got ${left.scale}`);
  assert.equal(left.overflow, true);
  assert.ok(result.pages[0]!.warnings.some((warning) => warning.code === "text_overflow"));
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
  assertUsage(
    () => parseComposeSpec({ width: 64, height: 64, left: { title: "Hi", shadow: { blur: 4, color: "#000000" } } }),
    /shadow unknown keys/,
  );
  await rm(dir, { recursive: true, force: true });
});
