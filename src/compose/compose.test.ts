import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { composeCatalog, formatComposeCatalog } from "./catalog.js";
import { composeSpec, resolveFontFamily } from "./compose.js";
import { REFERENCE_CANVAS, rampRoot, typeRamp } from "./tokens.js";
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
  assert.deepEqual(catalog.types, ["Frame", "Column", "Row", "Box", "Spacer", "Text", "Image"]);
  assert.deepEqual(catalog.roles, ["display", "title", "body", "caption", "label"]);
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
  const formatted = formatComposeCatalog(catalog);
  assert.match(formatted, /fontSize: not authorable/);
  assert.doesNotMatch(formatted, /fontSize: true/);
  assert.match(formatted, /textShadow: optional Text object \{ x, y, blur\?, color \}/);
  assert.match(formatted, /child_size: Image, Box, Row, Column, and Spacer honor width and height/);
  assert.match(formatted, /pin_stretch: pin top\|bottom stretches the full width/);
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
