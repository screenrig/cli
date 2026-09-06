import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { composeBatch, COMPOSE_BATCH_CHUNK_SIZE, COMPOSE_BATCH_MAX_PAGES } from "./batch.js";
import { composeCatalog, formatComposeCatalog } from "./catalog.js";
import { composeSpec, resolveFontFamily } from "./compose.js";
import { installedIconFamily } from "./icons.js";
import { DISPLAY_XL_FONT_SCALE, REFERENCE_CANVAS, ROLE_FONT_SCALE, displayXlWish, rampRoot, typeRamp } from "./tokens.js";
import { testTemp } from "../test-temp.js";
import { validateSpec } from "./validate.js";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertUsage(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal((err as { code?: string }).code, "usage_error");
    assert.match(err.message, pattern);
    return true;
  });
}

test("catalog lists fail-closed types, roles, spaces, and pins", () => {
  const catalog = composeCatalog();
  assert.deepEqual(catalog.types, ["Frame", "Column", "Row", "Box", "Spacer", "Text", "Image", "Icon", "Divider", "Pill"]);
  assert.deepEqual(catalog.roles, ["display", "title", "body", "caption", "label"]);
  assert.deepEqual(catalog.scales, ["display-xl"]);
  assert.deepEqual(catalog.spaces, ["xs", "s", "m", "l", "xl"]);
  assert.deepEqual(catalog.pins, ["top", "bottom", "left", "right"]);
  assert.equal(catalog.rules.fontSize, false);
  assert.match(catalog.rules.authoring_xy, /Frame canvas only/);
  assert.match(catalog.rules.authoring_xy, /width, height, pin, flex/);
  assert.match(catalog.rules.child_size, /Image, Box, Row, Column, and Spacer honor width and height/);
  assert.match(catalog.rules.pin_stretch, /pin top\|bottom stretches the full width/);
  assert.match(catalog.rules.pin_stretch, /Size a wordmark with width and height, not pin/);
  assert.equal(catalog.rules.envelope, "structured JSON, not pixels");
  assert.equal(
    catalog.rules.textShadow,
    "optional Text object { x, y, blur?, color }; omitted paints without a shadow",
  );
  assert.match(catalog.rules.effects, /every effect is off by default/);
  assert.equal(
    catalog.rules.effects_guidance,
    "Use text effects sparingly, when the design calls for them (a headline, a badge); body copy and prices stay plain for readability.",
  );
  const formatted = formatComposeCatalog(catalog);
  assert.match(formatted, /fontSize: not authorable/);
  assert.doesNotMatch(formatted, /fontSize: true/);
  assert.match(formatted, /scales: display-xl/);
  assert.match(formatted, /scale: optional Text "display-xl"/);
  assert.match(formatted, /textShadow: optional Text object \{ x, y, blur\?, color \}/);
  assert.match(
    formatted,
    /^effects_guidance: Use text effects sparingly, when the design calls for them \(a headline, a badge\); body copy and prices stay plain for readability\.$/m,
  );
  assert.match(catalog.rules.plate, /auto samples pixels behind the ink box/);
  assert.match(catalog.rules.focal, /Positions the cover crop so the focal point stays visible/);
  assert.match(formatted, /^plate: optional Text "auto"\|"none"/m);
  assert.match(formatted, /^focal: optional Image \{ x, y \} in 0\.\.1/m);
  assert.match(formatted, /child_size: Image, Box, Row, Column, and Spacer honor width and height/);
  assert.match(formatted, /pin_stretch: pin top\|bottom stretches the full width/);
  assert.match(formatted, /^themes:$/m);
  assert.match(formatted, /^theme_guidance: Pick one theme per deck; use accent for one element per page\.$/m);
  assert.match(
    formatted,
    /^recipe_guidance: Alternate variants or recipes on adjacent pages; a deck that repeats one layout reads as a slideshow, not signage\.$/m,
  );
  assert.equal(
    catalog.rules.recipe_guidance,
    "Alternate variants or recipes on adjacent pages; a deck that repeats one layout reads as a slideshow, not signage.",
  );
  assert.equal(Object.keys(catalog.themes).length, 16);
  assert.deepEqual(Object.keys(catalog.recipes), [
    "title", "split-image", "cards", "table", "overlay",
    "hero", "price-list", "menu-board", "promo", "event", "quote", "schedule",
  ]);
  for (const name of ["hero", "price-list", "menu-board", "promo", "event", "quote", "schedule"]) {
    const entry = catalog.recipes[name] as { fields: string[]; variants: string[]; example: { recipe: string } };
    assert.ok(entry.fields.includes("theme"));
    assert.ok(entry.fields.includes("variant"));
    assert.deepEqual(entry.variants, ["a", "b", "c"]);
    assert.equal(entry.example.recipe, name);
  }
});

test("unknown keys, fontSize, and child x,y are usage_error", () => {
  assertUsage(
    () => validateSpec({ type: "Frame", width: 320, height: 180, fontSize: 48 }),
    /must not set fontSize/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 320,
      height: 180,
      children: [{ type: "Text", text: "Hi", role: "title", x: 10, y: 10 }],
    }),
    /must not set x/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 320,
      height: 180,
      children: [{ type: "Image", src: "mark.png", width: 400, height: 80, x: 1424, y: 946 }],
    }),
    /must not set x/,
  );
  assertUsage(
    () => validateSpec({ type: "Frame", width: 320, height: 180, mystery: true }),
    /unknown keys: mystery/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 320,
      height: 180,
      children: [{ type: "Text", text: "Hi", role: "display", scale: "display" }],
    }),
    /scale must be display-xl/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 320,
      height: 180,
      scale: "display-xl",
      children: [{ type: "Text", text: "Hi", role: "display" }],
    }),
    /unknown keys: scale/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 320,
      height: 180,
      children: [{ type: "Image", src: "mark.png", width: 0, height: 80 }],
    }),
    /width must be a finite number greater than 0/,
  );
});

test("composeSpec writes a PNG and layout dump without returning pixels in the layout", async () => {
  const dir = await testTemp("compose-");
  const outPath = path.join(dir, "still.png");
  const layoutOutPath = `${outPath}.layout.json`;
  const result = await composeSpec(
    {
      type: "Frame",
      width: 320,
      height: 180,
      background: "#1B2632",
      children: [{ type: "Text", text: "Hello", role: "title" }],
    },
    { baseDir: dir, outPath, layoutOutPath },
  );
  const png = await readFile(outPath);
  assert.ok(png.subarray(0, 8).equals(PNG_HEADER));
  assert.ok(result.png.subarray(0, 8).equals(PNG_HEADER));
  const layoutText = await readFile(layoutOutPath, "utf8");
  const layout = JSON.parse(layoutText) as {
    tree: { type: string };
    ramp: { title: { wish: number } };
    ramp_root: number;
    ramp_at_1080: { title: { wish: number } };
  };
  assert.equal(layout.tree.type, "Frame");
  assert.equal(layout.ramp_root, 180);
  assert.equal(layout.ramp_at_1080.title.wish, 86);
  assert.equal(layout.ramp.title.wish, typeRamp(320, 180).title.wish);
  assert.equal(result.width, 320);
  assert.equal(result.height, 180);
  assert.equal(result.truncated, false);
  assert.ok(result.font_family.length > 0);
  assert.doesNotMatch(layoutText, /\u0089PNG/);
  await rm(dir, { recursive: true, force: true });
});

test("Frame backgrounds preserve authored alpha and paint translucent child plates once", async () => {
  const alphaOf = async (spec: unknown): Promise<number | undefined> => {
    const result = await composeSpec(spec, { baseDir: process.cwd() });
    const image = await loadImage(result.png);
    const ctx = createCanvas(8, 8).getContext("2d");
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, 1, 1).data[3];
  };
  for (const [background, alpha] of [["#2A3547E6", 230], ["#2A354780", 128], ["#00000000", 0], ["#2A3547FF", 255]] as const) {
    assert.equal(await alphaOf({ type: "Frame", width: 8, height: 8, background }), alpha, background);
  }
  assert.equal(await alphaOf({ type: "Frame", width: 8, height: 8 }), 255, "default Frame remains opaque");
  assert.equal(await alphaOf({
    type: "Frame", width: 8, height: 8, background: "#00000000",
    children: [{ type: "Box", width: 8, height: 8, background: "#2A3547E6" }],
  }), 230, "transparent Frame preserves child plate alpha");
});

test("Image.src rejects URLs and missing local files", async () => {
  const dir = await testTemp("compose-img-");
  await assert.rejects(
    () => composeSpec(
      {
        type: "Frame",
        width: 64,
        height: 64,
        children: [{ type: "Image", src: "https://example.com/x.png", flex: 1 }],
      },
      { baseDir: dir },
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, "usage_error");
      assert.match(err.message, /local filesystem path/);
      return true;
    },
  );
  await assert.rejects(
    () => composeSpec(
      {
        type: "Frame",
        width: 64,
        height: 64,
        children: [{ type: "Image", src: "missing.png", flex: 1 }],
      },
      { baseDir: dir },
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, "usage_error");
      return true;
    },
  );
  await rm(dir, { recursive: true, force: true });
});

test("an explicit missing fontFamily is usage_error; omitted walks fallbacks", () => {
  assert.throws(
    () => resolveFontFamily("ScreenRigMissingFace"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, "usage_error");
      assert.match(err.message, /font family not installed: ScreenRigMissingFace/);
      return true;
    },
  );
  const family = resolveFontFamily(undefined);
  assert.ok(family.length > 0);
});

test("Image.src relative to the spec directory is painted", async () => {
  const dir = await testTemp("compose-rel-");
  const specDir = path.join(dir, "specs");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(specDir, { recursive: true });
  const tile = await composeSpec(
    { type: "Frame", width: 8, height: 8, background: "#ff0000" },
    { baseDir: specDir, outPath: path.join(specDir, "tile.png") },
  );
  assert.ok(tile.png.subarray(0, 8).equals(PNG_HEADER));
  const outPath = path.join(dir, "with-image.png");
  const result = await composeSpec(
    {
      type: "Frame",
      width: 32,
      height: 32,
      children: [{ type: "Image", src: "tile.png", flex: 1 }],
    },
    { baseDir: specDir, outPath },
  );
  assert.ok(result.png.subarray(0, 8).equals(PNG_HEADER));
  await rm(dir, { recursive: true, force: true });
});

test("child Image, Box, and Spacer honor width and height; pin still stretches", async () => {
  const dir = await testTemp("compose-size-");
  const tile = await composeSpec(
    { type: "Frame", width: 8, height: 8, background: "#ff0000" },
    { baseDir: dir, outPath: path.join(dir, "tile.png") },
  );
  assert.ok(tile.png.subarray(0, 8).equals(PNG_HEADER));

  const sized = await composeSpec(
    {
      type: "Frame",
      width: 200,
      height: 100,
      children: [
        { type: "Box", width: 40, height: 20, background: "#00ff00" },
        { type: "Image", src: "tile.png", width: 16, height: 8 },
        { type: "Spacer", height: 12 },
      ],
    },
    { baseDir: dir },
  );
  const box = sized.layout.children?.[0]?.box;
  const image = sized.layout.children?.[1]?.box;
  const spacer = sized.layout.children?.[2]?.box;
  assert.equal(box?.width, 40);
  assert.equal(box?.height, 20);
  assert.equal(image?.width, 16);
  assert.equal(image?.height, 8);
  assert.equal(spacer?.width, 200);
  assert.equal(spacer?.height, 12);
  assert.equal(validateSpec({
    type: "Frame",
    width: 200,
    height: 100,
    children: [{ type: "Spacer", height: 12, flex: 0 }],
  }).children?.[0]?.height, 12);

  const pinned = await composeSpec(
    {
      type: "Frame",
      width: 200,
      height: 100,
      children: [{ type: "Box", pin: "bottom", height: 24, background: "#000000E8" }],
    },
    { baseDir: dir },
  );
  const plate = pinned.layout.children?.[0]?.box;
  assert.equal(plate?.width, 200);
  assert.equal(plate?.height, 24);
  assert.equal(plate?.y, 76);

  const unsizedImage = await composeSpec(
    {
      type: "Frame",
      width: 64,
      height: 64,
      children: [{ type: "Image", src: "tile.png" }],
    },
    { baseDir: dir },
  );
  assert.equal(unsizedImage.layout.children?.[0]?.box?.width, 64);
  assert.equal(unsizedImage.layout.children?.[0]?.box?.height, 0);

  await rm(dir, { recursive: true, force: true });
});

test("typeRamp uses min(width, height); a 1920×400 strip is not the 1080 reference", () => {
  assert.equal(rampRoot(1920, 400), 400);
  assert.equal(rampRoot(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height), 1080);
  const strip = typeRamp(1920, 400);
  const at1080 = typeRamp(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height);
  assert.equal(strip.title.wish, 48);
  assert.equal(at1080.title.wish, 86);
});

test("display-xl exceeds the 12% cap only for a single-Text Frame", async () => {
  const cap = typeRamp(1920, 1080).display.wish;
  assert.equal(cap, Math.max(64, Math.round(1080 * ROLE_FONT_SCALE)));
  const xlWish = displayXlWish(1920, 1080);
  assert.equal(xlWish, Math.max(64, Math.round(1080 * DISPLAY_XL_FONT_SCALE)));
  assert.ok(xlWish > cap);
  const dir = await testTemp("compose-display-xl-");
  const headline = await composeSpec(
    {
      type: "Frame",
      width: 1920,
      height: 1080,
      children: [{ type: "Text", text: "HI", role: "display", scale: "display-xl" }],
    },
    { baseDir: dir },
  );
  const xlSize = headline.layout.children?.[0]?.fit?.fontSize ?? 0;
  assert.ok(xlSize > cap, `display-xl font ${xlSize} should exceed the 12% cap ${cap}`);
  assert.ok(xlSize <= xlWish, `display-xl font ${xlSize} should not exceed ${xlWish}`);
  assert.equal(headline.ramp.display.wish, xlWish);
  const ordinary = await composeSpec(
    {
      type: "Frame",
      width: 1920,
      height: 1080,
      children: [{ type: "Text", text: "HI", role: "display" }],
    },
    { baseDir: dir },
  );
  assert.ok((ordinary.layout.children?.[0]?.fit?.fontSize ?? 0) <= cap);
  assert.equal(ordinary.ramp.display.wish, cap);
  const nested = await composeSpec(
    {
      type: "Frame",
      width: 1920,
      height: 1080,
      children: [{
        type: "Box",
        flex: 1,
        children: [{ type: "Text", text: "HI", role: "display", scale: "display-xl" }],
      }],
    },
    { baseDir: dir },
  );
  const nestedSize = nested.layout.children?.[0]?.children?.[0]?.fit?.fontSize ?? 0;
  assert.ok(nestedSize <= cap, `nested display-xl font ${nestedSize} must keep the 12% cap ${cap}`);
  assert.equal(nested.ramp.display.wish, cap);
  const sibling = await composeSpec(
    {
      type: "Frame",
      width: 1920,
      height: 1080,
      children: [
        { type: "Text", text: "HI", role: "display", scale: "display-xl" },
        { type: "Spacer", height: 1 },
      ],
    },
    { baseDir: dir },
  );
  const siblingSize = sibling.layout.children?.[0]?.fit?.fontSize ?? 0;
  assert.ok(siblingSize <= cap, `sibling display-xl font ${siblingSize} must keep the 12% cap ${cap}`);
  await rm(dir, { recursive: true, force: true });
});

test("a 1920×400 Frame writes ramp_root 400 and a 48 px title next to ramp_at_1080 86", async () => {
  const dir = await testTemp("compose-strip-");
  const layoutOutPath = path.join(dir, "strip.png.layout.json");
  const result = await composeSpec(
    {
      type: "Frame",
      width: 1920,
      height: 400,
      children: [{ type: "Text", text: "Lower third", role: "title" }],
    },
    { baseDir: dir, layoutOutPath },
  );
  assert.equal(result.ramp_root, 400);
  assert.equal(result.ramp.title.wish, 48);
  assert.equal(result.ramp_at_1080.title.wish, 86);
  const layout = JSON.parse(await readFile(layoutOutPath, "utf8")) as {
    ramp_root: number;
    ramp: { title: { wish: number } };
    ramp_at_1080: { title: { wish: number } };
    tree: { type: string };
  };
  assert.equal(layout.ramp_root, 400);
  assert.equal(layout.ramp.title.wish, 48);
  assert.equal(layout.ramp_at_1080.title.wish, 86);
  assert.equal(layout.tree.type, "Frame");
  await rm(dir, { recursive: true, force: true });
});

test("a layout dump records fitted text without image bytes", async () => {
  const dir = await testTemp("compose-fit-");
  await writeFile(path.join(dir, "unused.json"), "{}");
  const result = await composeSpec(
    {
      type: "Frame",
      width: 1920,
      height: 1080,
      padding: "l",
      children: [{ type: "Text", text: "Welcome", role: "display" }],
    },
    { baseDir: dir },
  );
  assert.equal(result.layout.type, "Frame");
  assert.equal(result.layout.children?.[0]?.fit?.truncated, false);
  assert.ok((result.layout.children?.[0]?.fit?.fontSize ?? 0) > 0);
  assert.equal(JSON.stringify(result.layout).includes(result.png.toString("base64")), false);
  await rm(dir, { recursive: true, force: true });
});

function textFrame(extra: Record<string, unknown> = {}) {
  return {
    type: "Frame",
    width: 320,
    height: 180,
    children: [{ type: "Text", text: "Hello", role: "title", ...extra }],
  };
}

test("omitted textShadow still validates and renders", async () => {
  const spec = textFrame();
  assert.equal(validateSpec(spec).children?.[0]?.textShadow, undefined);
  const dir = await testTemp("compose-noshadow-");
  const result = await composeSpec(spec, { baseDir: dir, outPath: path.join(dir, "still.png") });
  const png = await readFile(path.join(dir, "still.png"));
  assert.ok(png.subarray(0, 8).equals(PNG_HEADER));
  assert.ok(result.png.subarray(0, 8).equals(PNG_HEADER));
  await rm(dir, { recursive: true, force: true });
});

test("valid textShadow validates and writes a PNG without changing layout metrics", async () => {
  const dir = await testTemp("compose-shadow-");
  const shadow = { x: 2, y: 2, blur: 4, color: "#00000080" };
  assert.equal(validateSpec(textFrame({ textShadow: shadow })).children?.[0]?.textShadow?.blur, 4);
  const none = await composeSpec(textFrame(), { baseDir: dir });
  const withShadow = await composeSpec(textFrame({ textShadow: shadow }), {
    baseDir: dir,
    outPath: path.join(dir, "still.png"),
  });
  assert.ok(withShadow.png.subarray(0, 8).equals(PNG_HEADER));
  const png = await readFile(path.join(dir, "still.png"));
  assert.ok(png.subarray(0, 8).equals(PNG_HEADER));
  assert.deepEqual(withShadow.layout.children?.[0]?.box, none.layout.children?.[0]?.box);
  assert.deepEqual(withShadow.layout.children?.[0]?.fit, none.layout.children?.[0]?.fit);
  const zeroBlur = { x: -3, y: 0, color: "#000" };
  assert.equal(validateSpec(textFrame({ textShadow: zeroBlur })).children?.[0]?.textShadow?.x, -3);
  await rm(dir, { recursive: true, force: true });
});

test("invalid textShadow shapes are usage_error", () => {
  assertUsage(
    () => validateSpec(textFrame({ textShadow: "2px 2px 4px #000" })),
    /textShadow must be an object/,
  );
  assertUsage(
    () => validateSpec(textFrame({ textShadow: [{ x: 1, y: 1, color: "#000" }] })),
    /textShadow must be an object/,
  );
  assertUsage(
    () => validateSpec(textFrame({ textShadow: { y: 2, blur: 4, color: "#00000080" } })),
    /textShadow\.x required/,
  );
  assertUsage(
    () => validateSpec(textFrame({ textShadow: { x: 2, blur: 4, color: "#00000080" } })),
    /textShadow\.y required/,
  );
  assertUsage(
    () => validateSpec(textFrame({ textShadow: { x: 2, y: 2, blur: 4 } })),
    /textShadow\.color required/,
  );
  assertUsage(
    () => validateSpec(textFrame({ textShadow: { x: 2, y: 2, color: "not-a-color" } })),
    /textShadow\.color is not a hex color/,
  );
  assertUsage(
    () => validateSpec(textFrame({ textShadow: { x: 2, y: 2, blur: 4, color: "#00000080", spread: 1 } })),
    /textShadow unknown keys: spread/,
  );
  assertUsage(
    () => validateSpec(textFrame({ textShadow: { x: 2, y: 2, blur: -1, color: "#00000080" } })),
    /textShadow\.blur must be a finite number >= 0/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 64,
      height: 64,
      textShadow: { x: 1, y: 1, color: "#000" },
    }),
    /unknown keys: textShadow/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 64,
      height: 64,
      children: [{ type: "Box", textShadow: { x: 1, y: 1, color: "#000" } }],
    }),
    /unknown keys: textShadow/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 64,
      height: 64,
      children: [{ type: "Column", textShadow: { x: 1, y: 1, color: "#000" } }],
    }),
    /unknown keys: textShadow/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 64,
      height: 64,
      children: [{ type: "Row", textShadow: { x: 1, y: 1, color: "#000" } }],
    }),
    /unknown keys: textShadow/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 64,
      height: 64,
      children: [{ type: "Image", src: "tile.png", textShadow: { x: 1, y: 1, color: "#000" } }],
    }),
    /unknown keys: textShadow/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 64,
      height: 64,
      children: [{ type: "Spacer", textShadow: { x: 1, y: 1, color: "#000" } }],
    }),
    /unknown keys: textShadow/,
  );
  assertUsage(
    () => validateSpec(textFrame({ textShadow: { x: 2, y: 2, color: "#000" }, x: 10 })),
    /must not set x/,
  );
});

test("quality warnings measure actual contain, cover and fill paint without leaking paths", async () => {
  const dir = await testTemp("compose-quality-");
  await composeSpec({ type: "Frame", width: 100, height: 50, background: "#f00" }, { baseDir: dir, outPath: path.join(dir, "private-source.png") });
  for (const fit of ["contain", "cover", "fill"] as const) {
    const result = await composeSpec({ type: "Frame", width: 200, height: 200, children: [{ type: "Image", src: "private-source.png", flex: 1, objectFit: fit }] }, { baseDir: dir, target: { width: 400, height: 400 } });
    const q = result.quality.images[0]!;
    assert.deepEqual(q.source, { width: 100, height: 50 });
    assert.deepEqual(q.painted, fit === "contain" ? { width: 200, height: 100 } : fit === "cover" ? { width: 400, height: 200 } : { width: 200, height: 200 });
    assert.equal(result.warnings.filter((w) => w.code === "image_upscaled").length, 1);
    assert.equal(result.warnings.some((w) => w.code === "image_aspect_stretched"), fit === "fill");
    assert.ok(result.warnings.some((w) => w.code === "compose_output_upscaled"));
    assert.doesNotMatch(JSON.stringify({ quality: result.quality, warnings: result.warnings }), /private-source|compose-quality|data:|base64/);
  }
  const atThreshold = await composeSpec({ type: "Frame", width: 125, height: 50, children: [{ type: "Image", src: "private-source.png", flex: 1 }] }, { baseDir: dir, target: { width: 125, height: 50 } });
  assert.deepEqual(atThreshold.warnings, []);
  const unknown = await composeSpec({ type: "Frame", width: 100, height: 50 }, { baseDir: dir });
  assert.equal(unknown.quality.target_status, "unknown");
  assert.equal(unknown.quality.target, undefined);
  await assert.rejects(composeSpec({ type: "Frame", width: 100, height: 50 }, { baseDir: dir, target: { width: NaN, height: 50 } }), /positive integers/);
  await rm(dir, { recursive: true, force: true });
});

test("TV safe-area warnings are opt-in and catalog examples are valid renderable specs", async () => {
  const spec = { type: "Frame", width: 320, height: 180, children: [{ type: "Text", role: "title", text: "Edge" }] };
  assert.deepEqual((await composeSpec(spec, { baseDir: process.cwd() })).warnings, []);
  assert.ok((await composeSpec(spec, { baseDir: process.cwd(), safeArea: true })).warnings.some((w) => w.code === "text_outside_safe_area"));
  const catalog = composeCatalog();
  assert.ok(catalog.installed_fonts.length > 0);
  for (const example of Object.values(catalog.examples)) {
    validateSpec(example);
    const usesIcon = JSON.stringify(example).includes('"type":"Icon"');
    if (usesIcon && !installedIconFamily()) continue;
    assert.ok((await composeSpec(example, { baseDir: process.cwd() })).png.length > 0);
  }
  assert.ok(catalog.attributes.Frame?.includes("theme"));
  assert.ok(catalog.attributes.Frame?.includes("viewing"));
  assert.deepEqual(catalog.attributes.Text, ["type", "text", "role", "scale", "color", "align", "flex", "fontFamily", "textShadow", "effects", "plate", "letterSpacing"]);
  assert.ok(catalog.attributes.Image?.includes("focal"));
  assert.deepEqual(catalog.attributes.Icon, ["type", "name", "size", "color", "flex", "pin"]);
  assert.deepEqual(catalog.attributes.Divider, ["type", "thickness", "color", "length", "flex", "pin", "style"]);
  assert.deepEqual(catalog.attributes.Pill, ["type", "text", "role", "color", "background", "radius", "flex", "pin", "align"]);
});

test("measured diagnostics expose long-word overflow and distinguish intentional media overlays", async () => {
  const dir = await testTemp("measured-layout-");
  await composeSpec({ type: "Frame", width: 100, height: 100, background: "#123456" }, { baseDir: dir, outPath: path.join(dir, "image.png") });
  const result = await composeSpec({ type: "Frame", width: 400, height: 200, children: [
    { type: "Image", src: "image.png", flex: 1 },
    { type: "Box", pin: "bottom", height: 120, background: "#000000E3", children: [{ type: "Text", text: "Supercalifragilisticexpialidocious".repeat(5), role: "title" }] },
  ] }, { baseDir: dir });
  assert.ok(result.warnings.some((warning) => warning.code === "text_overflow" && warning.message.includes("Frame.children[1].children[0]")));
  assert.ok(result.warnings.some((warning) => warning.code === "image_upscaled"));
  assert.ok(result.quality.overlaps.some((overlap) => overlap.kind === "text_media"));
  assert.equal(result.warnings.some((warning) => warning.code === "text_overlap"), false);
  assert.ok(result.quality.text[0]!.ink.width > result.quality.text[0]!.box.width);
  await rm(dir, { recursive: true, force: true });
});

test("recipes retain native measured text at 1080p and 4K with safe geometry and plate alpha", async () => {
  for (const [width, height] of [[1920, 1080], [3840, 2160]]) {
    const overlay = await composeSpec({ recipe: "overlay", width, height, title: "Prepare, activate, observe", body: "Keep the current experience visible until the replacement is ready." }, { baseDir: process.cwd(), safeArea: true });
    assert.equal(overlay.quality.text.length, 2);
    assert.deepEqual(overlay.warnings, []);
    const picture = await loadImage(overlay.png), ctx = createCanvas(width!, height!).getContext("2d"); ctx.drawImage(picture, 0, 0);
    assert.equal(ctx.getImageData(0, height! - 1, 1, 1).data[3], 227);
    assert.equal(ctx.getImageData(0, 0, 1, 1).data[3], 0);
    const ink = overlay.quality.text[0]!.ink;
    const pixels = ctx.getImageData(Math.floor(ink.x), Math.floor(ink.y), Math.ceil(ink.width), Math.ceil(ink.height)).data;
    assert.ok(pixels.some((value, index) => index % 4 === 3 && value === 255), "text remains opaque on translucent plate");
  }
});


test("ink-tight output size equals measured ink plus 2×padding", async () => {
  const dir = await testTemp("compose-ink-tight-");
  const spec = {
    type: "Frame",
    width: 320,
    height: 180,
    background: "#00000000",
    children: [{ type: "Text", text: "Hello", role: "title" }],
  };
  const padded = await composeSpec(spec, { baseDir: dir, inkTight: true, inkPadding: 8 });
  const ink = padded.ink_tight?.ink;
  assert.ok(ink);
  assert.equal(padded.ink_tight?.padding, 8);
  assert.deepEqual(padded.ink_tight?.frame, { width: 320, height: 180 });
  assert.equal(padded.width, ink.width + 16);
  assert.equal(padded.height, ink.height + 16);
  assert.deepEqual(padded.ink_tight?.output, { width: padded.width, height: padded.height });
  const image = await loadImage(padded.png);
  assert.equal(image.width, ink.width + 16);
  assert.equal(image.height, ink.height + 16);
  const zero = await composeSpec(spec, { baseDir: dir, inkTight: true });
  assert.equal(zero.width, zero.ink_tight!.ink.width);
  assert.equal(zero.height, zero.ink_tight!.ink.height);
  await assert.rejects(
    () => composeSpec(spec, { baseDir: dir, inkPadding: 8 }),
    /--ink-padding requires --ink-tight/,
  );
  await rm(dir, { recursive: true, force: true });
});

test("ink-tight distinguishes retained overhang from clipped ink on an overflowing frame", async () => {
  const dir = await testTemp("compose-ink-overhang-");
  const result = await composeSpec(
    {
      type: "Frame",
      width: 64,
      height: 32,
      background: "#00000000",
      children: [{ type: "Text", text: "WWWWWWWWWW", role: "title" }],
    },
    { baseDir: dir, inkTight: true },
  );
  const report = result.ink_tight;
  assert.ok(report);
  assert.ok(result.warnings.some((warning) => warning.code === "text_overflow"));
  assert.ok(
    report.overhang.left + report.overhang.right + report.overhang.top + report.overhang.bottom > 0,
    "overflowing measured ink must be retained as overhang",
  );
  const clipped = report.clipped.left + report.clipped.right + report.clipped.top + report.clipped.bottom;
  const overhang = report.overhang.left + report.overhang.right + report.overhang.top + report.overhang.bottom;
  assert.ok(clipped < overhang, `clipped ${clipped} must be distinguished from retained overhang ${overhang}`);
  assert.ok(report.output.width >= report.ink.width);
  assert.ok(report.output.height >= report.ink.height);
  assert.ok(report.ink.width > 64 || report.ink.height > 32);
  const image = await loadImage(result.png);
  assert.equal(image.width, result.width);
  assert.equal(image.height, result.height);
  await rm(dir, { recursive: true, force: true });
});

test("compose batch applies ink-tight per page", async () => {
  const dir = await testTemp("batch-ink-tight-");
  const input = path.join(dir, "batch.json");
  const output = path.join(dir, "rendered");
  await writeFile(input, JSON.stringify({
    pages: [
      { id: "tight", spec: { type: "Frame", width: 160, height: 90, background: "#00000000", children: [{ type: "Text", text: "Hi", role: "label" }] } },
      { id: "wide", spec: { type: "Frame", width: 160, height: 90, background: "#00000000", children: [{ type: "Text", text: "Hello there", role: "label" }] } },
    ],
  }));
  const result = await composeBatch(input, output, { inkTight: true, inkPadding: 4 });
  assert.equal(result.rendered, 2);
  for (const page of result.pages) {
    assert.equal(page.status, "rendered");
    assert.ok(page.ink_tight);
    assert.equal(page.width, page.ink_tight.ink.width + 8);
    assert.equal(page.height, page.ink_tight.ink.height + 8);
    assert.deepEqual(page.ink_tight.frame, { width: 160, height: 90 });
  }
  assert.ok((result.pages[0]!.width ?? 0) !== (result.pages[1]!.width ?? 0) || (result.pages[0]!.height ?? 0) !== (result.pages[1]!.height ?? 0));
  await rm(dir, { recursive: true, force: true });
});

test("missing glyphs produce node-specific diagnostics even when geometric text fits", async () => {
  const result = await composeSpec({ type: "Frame", width: 1920, height: 1080, children: [{ type: "Text", text: "A \u{10ffff}", role: "title" }] }, { baseDir: process.cwd() });
  assert.ok(result.warnings.some((warning) => warning.code === "font_glyph_missing" && warning.message.includes("Frame.children[0]") && warning.message.includes("U+10FFFF")));
});

test("Agave bold missing arrow falls back before layout and paints the selected complete font", async (context) => {
  resolveFontFamily(undefined);
  if (!GlobalFonts.has("Agave Nerd Font")) { context.skip("Agave UAT regression requires its installed font"); return; }
  const spec = { type: "Frame", width: 1920, height: 1080, fontFamily: "Agave Nerd Font", children: [{ type: "Text", text: "Prepare → activate → observe", role: "title" }] };
  const result = await composeSpec(spec, { baseDir: process.cwd() });
  const font = result.quality.fonts[0]!;
  assert.equal(font.fallback_from, "Agave Nerd Font");
  assert.deepEqual(font.missing_codepoints, ["U+2192"]);
  assert.ok(result.warnings.some((warning) => warning.code === "font_glyph_fallback"));
  const explicit = await composeSpec({ ...spec, fontFamily: font.family }, { baseDir: process.cwd() });
  assert.deepEqual(result.png, explicit.png, "both measurement and painting use the complete fallback at the requested weight");
});

const TINY_FRAME = { type: "Frame", width: 32, height: 18, background: "#112233" };
const LARGE_BATCH_PAGES = 284;

function syntheticBatchPages(count: number, patch: Record<number, unknown> = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${String(index).padStart(3, "0")}`,
    spec: patch[index] ?? TINY_FRAME,
  }));
}

test("compose batch rejects more than 2000 pages without rendering", async () => {
  const dir = await testTemp("batch-limit-");
  const input = path.join(dir, "batch.json");
  await writeFile(input, JSON.stringify({ pages: syntheticBatchPages(COMPOSE_BATCH_MAX_PAGES + 1) }));
  await assert.rejects(
    () => composeBatch(input, path.join(dir, "rendered")),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "usage_error");
      assert.match(error.message, /1 to 2000 pages/);
      assert.doesNotMatch(error.message, /1 to 100 pages/);
      return true;
    },
  );
  await rm(dir, { recursive: true, force: true });
});

test("284 synthetic pages render in input order with stable ids and three chunks", { timeout: 120000 }, async () => {
  const dir = await testTemp("batch-284-");
  const input = path.join(dir, "batch.json"), output = path.join(dir, "rendered");
  await writeFile(input, JSON.stringify({ pages: syntheticBatchPages(LARGE_BATCH_PAGES) }));
  const result = await composeBatch(input, output);
  assert.equal(result.pages.length, LARGE_BATCH_PAGES);
  assert.equal(result.rendered, LARGE_BATCH_PAGES);
  assert.equal(result.failed, 0);
  assert.equal(result.not_selected, 0);
  assert.equal(result.chunks, 3);
  assert.deepEqual(result.chunk_timings.map((chunk) => chunk.pages), [COMPOSE_BATCH_CHUNK_SIZE, COMPOSE_BATCH_CHUNK_SIZE, 84]);
  assert.deepEqual(result.chunk_timings.map((chunk) => chunk.index), [0, 1, 2]);
  for (const timing of result.chunk_timings) {
    assert.equal(typeof timing.duration_ms, "number");
    assert.ok(timing.duration_ms >= 0);
  }
  for (let index = 0; index < LARGE_BATCH_PAGES; index++) {
    const id = `p${String(index).padStart(3, "0")}`;
    const page = result.pages[index]!;
    assert.equal(page.id, id);
    assert.equal(page.status, "rendered");
    assert.equal(page.output, path.join(output, `${id}.png`));
    assert.ok((await readFile(page.output!)).subarray(0, 8).equals(PNG_HEADER));
  }
  assert.equal(result.preview, path.join(output, "preview.png"));
  assert.ok((await readFile(result.preview)).subarray(0, 8).equals(PNG_HEADER));
  await access(path.join(output, "preview-2.png"));
  await access(path.join(output, "preview-3.png"));
  const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
  assert.equal(manifest.chunks, 3);
  assert.deepEqual(manifest.pages.map((page: { id: string }) => page.id), result.pages.map((page) => page.id));
  await rm(dir, { recursive: true, force: true });
});

test("--only of an id in the third chunk renders only that page", { timeout: 30000 }, async () => {
  const dir = await testTemp("batch-only-chunk3-");
  const input = path.join(dir, "batch.json"), output = path.join(dir, "rendered");
  await writeFile(input, JSON.stringify({ pages: syntheticBatchPages(LARGE_BATCH_PAGES) }));
  const result = await composeBatch(input, output, { only: "p200" });
  assert.equal(result.pages.length, LARGE_BATCH_PAGES);
  assert.equal(result.rendered, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.not_selected, LARGE_BATCH_PAGES - 1);
  assert.equal(result.chunks, 3);
  assert.deepEqual(result.pages.map((page) => page.status), [
    ...Array(200).fill("not_selected"),
    "rendered",
    ...Array(83).fill("not_selected"),
  ]);
  assert.equal(result.pages[200]!.id, "p200");
  assert.equal(result.pages[200]!.output, path.join(output, "p200.png"));
  assert.ok((await readFile(path.join(output, "p200.png"))).subarray(0, 8).equals(PNG_HEADER));
  await assert.rejects(() => access(path.join(output, "p199.png")));
  await assert.rejects(() => access(path.join(output, "p201.png")));
  assert.equal(result.preview, path.join(output, "preview-p200.png"));
  assert.ok((await readFile(result.preview)).subarray(0, 8).equals(PNG_HEADER));
  await rm(dir, { recursive: true, force: true });
});

test("a bad spec in chunk 2 fails only that page", { timeout: 120000 }, async () => {
  const dir = await testTemp("batch-fail-chunk2-");
  const input = path.join(dir, "batch.json"), output = path.join(dir, "rendered");
  await writeFile(input, JSON.stringify({
    pages: syntheticBatchPages(LARGE_BATCH_PAGES, { 150: { type: "Frame", width: 32, height: 18, extra: true } }),
  }));
  const result = await composeBatch(input, output);
  assert.equal(result.pages.length, LARGE_BATCH_PAGES);
  assert.equal(result.rendered, LARGE_BATCH_PAGES - 1);
  assert.equal(result.failed, 1);
  assert.equal(result.chunks, 3);
  assert.equal(result.pages[150]!.id, "p150");
  assert.equal(result.pages[150]!.status, "failed");
  assert.equal(result.pages[150]!.error?.code, "usage_error");
  assert.match(result.pages[150]!.error?.message ?? "", /unknown keys: extra/);
  assert.equal(result.pages[149]!.status, "rendered");
  assert.equal(result.pages[151]!.status, "rendered");
  assert.ok((await readFile(path.join(output, "p149.png"))).subarray(0, 8).equals(PNG_HEADER));
  assert.ok((await readFile(path.join(output, "p151.png"))).subarray(0, 8).equals(PNG_HEADER));
  await assert.rejects(() => access(path.join(output, "p150.png")));
  await rm(dir, { recursive: true, force: true });
});

async function writeCheckerboard(dir: string, name: string, size: number): Promise<void> {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const cell = 8;
  for (let y = 0; y < size; y += cell) {
    for (let x = 0; x < size; x += cell) {
      ctx.fillStyle = ((x + y) / cell) % 2 === 0 ? "#FFFFFF" : "#000000";
      ctx.fillRect(x, y, cell, cell);
    }
  }
  await writeFile(path.join(dir, name), canvas.toBuffer("image/png"));
}

test("auto plate applies over a busy background and skips a flat one", async () => {
  const dir = await testTemp("compose-plate-auto-");
  await writeCheckerboard(dir, "busy.png", 240);
  const busy = await composeSpec({
    type: "Frame",
    width: 240,
    height: 240,
    children: [
      { type: "Image", src: "busy.png", flex: 1, objectFit: "cover" },
      {
        type: "Box",
        pin: "bottom",
        height: 80,
        children: [{ type: "Text", text: "HELLO WORLD", role: "title", color: "#FFFFFF", plate: "auto", align: "center" }],
      },
    ],
  }, { baseDir: dir });
  const busyPlate = busy.quality.text[0]?.plate;
  assert.equal(busyPlate?.code, "plate_applied");
  assert.ok((busyPlate?.contrast_ratio ?? 99) < 4.5);
  const flat = await composeSpec({
    type: "Frame",
    width: 240,
    height: 240,
    background: "#102018",
    children: [{ type: "Text", text: "HELLO WORLD", role: "title", color: "#F7F7F2", plate: "auto" }],
  }, { baseDir: dir });
  const flatPlate = flat.quality.text[0]?.plate;
  assert.equal(flatPlate?.code, "plate_skipped");
  assert.ok((flatPlate?.contrast_ratio ?? 0) >= 4.5);
  await rm(dir, { recursive: true, force: true });
});

test("cover focal 0.9,0.5 shifts the crop window", async () => {
  const dir = await testTemp("compose-focal-");
  await composeSpec(
    { type: "Frame", width: 100, height: 50, background: "#336699" },
    { baseDir: dir, outPath: path.join(dir, "wide.png") },
  );
  const centered = await composeSpec({
    type: "Frame",
    width: 200,
    height: 200,
    children: [{ type: "Image", src: "wide.png", flex: 1, objectFit: "cover" }],
  }, { baseDir: dir });
  const shifted = await composeSpec({
    type: "Frame",
    width: 200,
    height: 200,
    children: [{ type: "Image", src: "wide.png", flex: 1, objectFit: "cover", focal: { x: 0.9, y: 0.5 } }],
  }, { baseDir: dir });
  const centerCrop = centered.quality.images[0]?.crop;
  const shiftedCrop = shifted.quality.images[0]?.crop;
  assert.ok(centerCrop);
  assert.ok(shiftedCrop);
  assert.equal(centerCrop.width, shiftedCrop.width);
  assert.equal(centerCrop.height, shiftedCrop.height);
  assert.ok(shiftedCrop.x > centerCrop.x, `focal crop x ${shiftedCrop.x} should exceed centered ${centerCrop.x}`);
  assert.equal(shiftedCrop.y, centerCrop.y);
  await rm(dir, { recursive: true, force: true });
});

test("low_contrast fires when plated text still fails 3.0", async () => {
  const dir = await testTemp("compose-low-contrast-");
  const result = await composeSpec({
    type: "Frame",
    width: 240,
    height: 120,
    background: "#F2F2F2",
    children: [{ type: "Text", text: "HELLO WORLD", role: "title", color: "#FFFFFF", plate: { color: "#FFFFFF" } }],
  }, { baseDir: dir });
  assert.equal(result.quality.text[0]?.plate?.code, "plate_applied");
  const warning = result.warnings.find((item) => item.code === "low_contrast");
  assert.ok(warning, "low_contrast should fire");
  assert.match(warning.message, /Frame\.children\[0\]/);
  await rm(dir, { recursive: true, force: true });
});

test("plate.color resolves theme tokens", async () => {
  const result = await composeSpec({
    type: "Frame",
    theme: "warm-cafe",
    width: 400,
    height: 200,
    padding: "l",
    children: [{ type: "Text", role: "title", text: "Hello", color: "ink", plate: { color: "surface" } }],
  }, { baseDir: process.cwd() });
  assert.equal(result.quality.text[0]?.plate?.code, "plate_applied");
  assertUsage(
    () => validateSpec({ type: "Frame", width: 100, height: 100, children: [{ type: "Text", text: "Hi", plate: { color: "surface" } }] }),
    /requires Frame.theme/,
  );
});

test("Frame.viewing raises the fit-text floor at layout time", async () => {
  const result = await composeSpec({
    type: "Frame",
    width: 1920,
    height: 1080,
    viewing: "far",
    padding: "xl",
    background: "#1B2632",
    children: [{ type: "Text", role: "caption", text: "Hours", color: "#F7F7F2" }],
  }, { baseDir: process.cwd() });
  const floor = Math.ceil(1080 * 0.02 / 0.52);
  assert.ok((result.quality.text[0]?.font_size ?? 0) >= floor, JSON.stringify(result.quality.text[0]));
  assertUsage(
    () => validateSpec({ type: "Frame", width: 100, height: 100, viewing: "close", children: [{ type: "Text", text: "Hi" }] }),
    /viewing must be near\|mid\|far/,
  );
});

test("invalid plate and focal shapes are usage_error", () => {
  assertUsage(
    () => validateSpec({ type: "Frame", width: 100, height: 100, children: [{ type: "Text", text: "Hi", plate: "maybe" }] }),
    /plate must be auto, none, or an object/,
  );
  assertUsage(
    () => validateSpec({ type: "Frame", width: 100, height: 100, children: [{ type: "Text", text: "Hi", plate: { color: "red" } }] }),
    /plate\.color must be a hex color or accent\|ink\|inkMuted\|surface\|accentInk\|background/,
  );
  assertUsage(
    () => validateSpec({ type: "Frame", width: 100, height: 100, children: [{ type: "Image", src: "a.png", focal: { x: 2, y: 0.5 } }] }),
    /focal\.x must be a finite number from 0 to 1/,
  );
  assertUsage(
    () => validateSpec({ type: "Frame", width: 100, height: 100, children: [{ type: "Image", src: "a.png", focal: { x: 0.5 } }] }),
    /focal\.y must be a finite number from 0 to 1/,
  );
});

