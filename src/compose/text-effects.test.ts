import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { composeSpec } from "./compose.js";
import { familyHasFace } from "./fonts.js";
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

function textFrame(extra: Record<string, unknown> = {}) {
  return {
    type: "Frame",
    width: 320,
    height: 180,
    children: [{ type: "Text", text: "Hello", role: "title", ...extra }],
  };
}

test("outline grows ink-tight bounds", async () => {
  const dir = await testTemp("compose-outline-");
  const none = await composeSpec(textFrame(), { baseDir: dir });
  const outlined = await composeSpec(
    textFrame({ effects: { outline: { width: 8, color: "#000000" } } }),
    { baseDir: dir },
  );
  const plainInk = none.layout.children?.[0]?.text_bounds;
  const outlineInk = outlined.layout.children?.[0]?.text_bounds;
  assert.ok(plainInk && outlineInk);
  assert.ok(outlineInk.width > plainInk.width, "outline should widen ink");
  assert.ok(outlineInk.height > plainInk.height, "outline should heighten ink");
  assert.ok(outlined.png.subarray(0, 8).equals(PNG_HEADER));
  await rm(dir, { recursive: true, force: true });
});

test("arc rejects multi-line text as arc_single_line", () => {
  assertUsage(
    () => validateSpec(textFrame({ text: "Hello\nWorld", effects: { arc: { degrees: 40 } } })),
    /arc_single_line/,
  );
  assertUsage(
    () => validateSpec(textFrame({ text: "Hello\nWorld", effects: { arc: { degrees: -20 } } })),
    /Frame\.children\[0\] arc_single_line/,
  );
});

test("texture src resolves relative to the spec and rejects URLs", async () => {
  const dir = await testTemp("compose-texture-");
  const tile = await composeSpec(
    { type: "Frame", width: 8, height: 8, background: "#ff0000" },
    { baseDir: dir, outPath: path.join(dir, "paper.png") },
  );
  assert.ok(tile.png.subarray(0, 8).equals(PNG_HEADER));
  const filled = await composeSpec(
    textFrame({ effects: { texture: { src: "paper.png", objectFit: "cover" } } }),
    { baseDir: dir },
  );
  assert.ok(filled.png.subarray(0, 8).equals(PNG_HEADER));
  assert.ok(filled.png.length > 32);
  await assert.rejects(
    () => composeSpec(
      textFrame({ effects: { texture: { src: "https://example.com/paper.png" } } }),
      { baseDir: dir },
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, "usage_error");
      assert.match(err.message, /effects\.texture\.src must be a local filesystem path/);
      return true;
    },
  );
  await assert.rejects(
    () => composeSpec(
      textFrame({ effects: { texture: { src: "missing-paper.png" } } }),
      { baseDir: dir },
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, "usage_error");
      assert.match(err.message, /effects\.texture\.src could not be read/);
      return true;
    },
  );
  await rm(dir, { recursive: true, force: true });
});

test("weight fallback warns synthetic_face when the family has no bold face", async (context) => {
  const family = GlobalFonts.families.find((entry) => {
    const regular = familyHasFace(entry.family, 400, false);
    const bold = familyHasFace(entry.family, 700, false);
    return regular && !bold;
  })?.family;
  if (!family) {
    context.skip("no installed family lacks a bold face");
    return;
  }
  const dir = await testTemp("compose-synthetic-");
  const result = await composeSpec(
    {
      type: "Frame",
      width: 320,
      height: 180,
      fontFamily: family,
      children: [{ type: "Text", text: "Hi", role: "body", effects: { weight: "bold" } }],
    },
    { baseDir: dir },
  );
  assert.ok(result.warnings.some((warning) => warning.code === "synthetic_face" && warning.message.includes("Frame.children[0]")));
  await rm(dir, { recursive: true, force: true });
});

test("textShadow maps onto effects.shadow and both paint without changing layout metrics", async () => {
  const dir = await testTemp("compose-shadow-map-");
  const shadow = { x: 2, y: 2, blur: 4, color: "#00000080" };
  const none = await composeSpec(textFrame(), { baseDir: dir });
  const legacy = await composeSpec(textFrame({ textShadow: shadow }), { baseDir: dir });
  const modern = await composeSpec(textFrame({ effects: { shadow } }), { baseDir: dir });
  assert.deepEqual(legacy.layout.children?.[0]?.box, none.layout.children?.[0]?.box);
  assert.deepEqual(modern.layout.children?.[0]?.box, none.layout.children?.[0]?.box);
  assert.deepEqual(legacy.layout.children?.[0]?.fit, none.layout.children?.[0]?.fit);
  assert.deepEqual(modern.layout.children?.[0]?.fit, none.layout.children?.[0]?.fit);
  await rm(dir, { recursive: true, force: true });
});

test("invalid effects shapes are usage_error at the node path", () => {
  assertUsage(
    () => validateSpec(textFrame({ effects: "bold" })),
    /Frame\.children\[0\]\.effects must be an object/,
  );
  assertUsage(
    () => validateSpec(textFrame({ effects: { weight: "700" } })),
    /effects\.weight must be regular\|bold/,
  );
  assertUsage(
    () => validateSpec(textFrame({ effects: { italic: "yes" } })),
    /effects\.italic must be a boolean/,
  );
  assertUsage(
    () => validateSpec(textFrame({ effects: { outline: { width: 0.2, color: "#000" } } })),
    /effects\.outline\.width must be a finite number from 0\.5 to 12/,
  );
  assertUsage(
    () => validateSpec(textFrame({ effects: { outline: { width: 13, color: "#000" } } })),
    /effects\.outline\.width must be a finite number from 0\.5 to 12/,
  );
  assertUsage(
    () => validateSpec(textFrame({ effects: { arc: { degrees: 200 } } })),
    /effects\.arc\.degrees must be a finite number from -180 to 180/,
  );
  assertUsage(
    () => validateSpec(textFrame({ effects: { glow: true } })),
    /effects unknown keys: glow/,
  );
  assertUsage(
    () => validateSpec(textFrame({ effects: { texture: { src: "" } } })),
    /effects\.texture\.src required/,
  );
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 64,
      height: 64,
      children: [{ type: "Box", effects: { italic: true } }],
    }),
    /unknown keys: effects/,
  );
});

test("a Frame using every text effect writes a non-empty PNG", async () => {
  const dir = await testTemp("compose-all-effects-");
  await composeSpec(
    { type: "Frame", width: 16, height: 16, background: "#c4a574" },
    { baseDir: dir, outPath: path.join(dir, "paper.png") },
  );
  const result = await composeSpec(
    {
      type: "Frame",
      width: 640,
      height: 360,
      children: [{
        type: "Text",
        text: "SHOWTIME",
        role: "display",
        align: "center",
        color: "#FFC857",
        effects: {
          weight: "bold",
          italic: true,
          underline: true,
          outline: { width: 3, color: "#000000" },
          shadow: { x: 2, y: 2, blur: 4, color: "#00000080" },
          arc: { degrees: 40 },
          texture: { src: "paper.png", objectFit: "cover" },
        },
      }],
    },
    { baseDir: dir },
  );
  assert.ok(result.png.subarray(0, 8).equals(PNG_HEADER));
  assert.ok(result.png.length > 256);
  const image = await loadImage(result.png);
  assert.equal(image.width, 640);
  assert.equal(image.height, 360);
  const ctx = createCanvas(image.width, image.height).getContext("2d");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  assert.ok(pixels.some((value, index) => index % 4 === 3 && value > 0));
  await rm(dir, { recursive: true, force: true });
});
