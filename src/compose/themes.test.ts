import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { composeSpec } from "./compose.js";
import { installedIconFamily } from "./icons.js";
import { contrastRatio, THEME_NAMES, THEMES } from "./tokens.js";
import { validateSpec } from "./validate.js";

function assertUsage(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal((err as { code?: string }).code, "usage_error");
    assert.match(err.message, pattern);
    return true;
  });
}

async function pixelAt(spec: unknown, x = 0, y = 0): Promise<number[]> {
  const result = await composeSpec(spec, { baseDir: process.cwd() });
  const image = await loadImage(result.png);
  const ctx = createCanvas(image.width, image.height).getContext("2d");
  ctx.drawImage(image, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data];
}

test("every shipped theme meets 4.5:1 ink/background and accentInk/accent contrast", () => {
  assert.equal(THEME_NAMES.length, 16);
  assert.deepEqual(THEME_NAMES, [
    "warm-cafe",
    "bakery-cream",
    "midnight-neon",
    "clean-corporate",
    "earthy-market",
    "ocean-calm",
    "bold-retail",
    "cinema-noir",
    "pastel-kiosk",
    "forest-lodge",
    "sunset-promo",
    "monochrome-ink",
    "sport-arena",
    "healthcare-soft",
    "festival-pop",
    "luxury-gold",
  ]);
  for (const name of THEME_NAMES) {
    const theme = THEMES[name];
    assert.ok(contrastRatio(theme.ink, theme.background) >= 4.5, `${name} ink/background`);
    assert.ok(contrastRatio(theme.accentInk, theme.accent) >= 4.5, `${name} accentInk/accent`);
  }
});

test("theme fills unset background, color, and fontFamily; explicit values win", async () => {
  const theme = THEMES["clean-corporate"];
  const filled = await composeSpec(
    { type: "Frame", theme: "clean-corporate", width: 64, height: 32, children: [{ type: "Text", text: "Hi", role: "body" }] },
    { baseDir: process.cwd() },
  );
  const [r, g, b] = await pixelAt({ type: "Frame", theme: "clean-corporate", width: 8, height: 8 });
  const bg = theme.background.replace("#", "");
  assert.equal(r, Number.parseInt(bg.slice(0, 2), 16));
  assert.equal(g, Number.parseInt(bg.slice(2, 4), 16));
  assert.equal(b, Number.parseInt(bg.slice(4, 6), 16));
  const overridden = await pixelAt({ type: "Frame", theme: "clean-corporate", width: 8, height: 8, background: "#FF0000" });
  assert.deepEqual(overridden.slice(0, 3), [255, 0, 0]);
  const explicitFont = await composeSpec(
    {
      type: "Frame",
      theme: "clean-corporate",
      width: 64,
      height: 32,
      fontFamily: filled.font_family,
      children: [{ type: "Text", text: "Hi", role: "title", color: "#00FF00" }],
    },
    { baseDir: process.cwd() },
  );
  assert.equal(explicitFont.font_family, filled.font_family);
  assert.notDeepEqual(await pixelAt({
    type: "Frame",
    theme: "clean-corporate",
    width: 64,
    height: 32,
    children: [{ type: "Box", flex: 1, background: "#00FF00" }],
  }, 32, 16).then((p) => p.slice(0, 3)), await pixelAt({
    type: "Frame",
    theme: "clean-corporate",
    width: 64,
    height: 32,
    children: [{ type: "Box", flex: 1 }],
  }, 32, 16).then((p) => p.slice(0, 3)));
});

test("Icon, Divider, and Pill render in a smoke Frame", async () => {
  const children: unknown[] = [
    { type: "Divider", thickness: 4, color: "#FF0000", length: 80 },
    { type: "Pill", text: "New", role: "label", background: "#0B5CAB", color: "#FFFFFF" },
  ];
  if (installedIconFamily()) children.unshift({ type: "Icon", name: "star", size: 24, color: "#0B5CAB" });
  const result = await composeSpec(
    { type: "Frame", width: 240, height: 120, padding: "s", gap: "s", children },
    { baseDir: process.cwd() },
  );
  assert.ok(result.png.length > 8);
  assert.equal(result.layout.children?.length, children.length);
  assert.equal(result.layout.children?.some((child) => child.type === "Divider"), true);
  assert.equal(result.layout.children?.some((child) => child.type === "Pill"), true);
  if (installedIconFamily()) {
    assert.equal(result.layout.children?.[0]?.type, "Icon");
    assert.ok((result.layout.children?.[0]?.box?.width ?? 0) >= 24);
  }
});

test("unknown icon name lists the nearest three names", () => {
  assertUsage(
    () => validateSpec({
      type: "Frame",
      width: 64,
      height: 64,
      children: [{ type: "Icon", name: "starr", size: 16 }],
    }),
    /unknown icon starr\. Nearest: .+, .+, .+/,
  );
  try {
    validateSpec({
      type: "Frame",
      width: 64,
      height: 64,
      children: [{ type: "Icon", name: "starr", size: 16 }],
    });
    assert.fail("expected usage_error");
  } catch (err) {
    assert.ok(err instanceof Error);
    const names = err.message.replace(/^.*Nearest: /, "").split(", ");
    assert.equal(names.length, 3);
    assert.ok(names.includes("star"));
  }
});

test("gradient stop validation rejects malformed linear fills", () => {
  const frame = (background: unknown) => ({ type: "Frame", width: 32, height: 32, background });
  assertUsage(() => validateSpec(frame({ type: "linear", angle: 90, stops: [{ at: 0, color: "#000" }] })), /2 to 8 stops/);
  assertUsage(() => validateSpec(frame({
    type: "linear",
    angle: 90,
    stops: Array.from({ length: 9 }, (_, i) => ({ at: i / 8, color: "#000" })),
  })), /2 to 8 stops/);
  assertUsage(() => validateSpec(frame({
    type: "linear",
    angle: 90,
    stops: [{ at: 0.2, color: "#000" }, { at: 1, color: "#fff" }],
  })), /stops\[0\]\.at must be 0/);
  assertUsage(() => validateSpec(frame({
    type: "linear",
    angle: 90,
    stops: [{ at: 0, color: "#000" }, { at: 0.4, color: "#111" }],
  })), /stops\[1\]\.at must be 1/);
  assertUsage(() => validateSpec(frame({
    type: "linear",
    angle: 90,
    stops: [{ at: 0, color: "#000" }, { at: 0.2, color: "#111" }, { at: 0.2, color: "#222" }, { at: 1, color: "#fff" }],
  })), /strictly increasing/);
  assertUsage(() => validateSpec(frame({ type: "linear", angle: 361, stops: [{ at: 0, color: "#000" }, { at: 1, color: "#fff" }] })), /0 to 360/);
  assertUsage(() => validateSpec(frame({ type: "radial", angle: 90, stops: [{ at: 0, color: "#000" }, { at: 1, color: "#fff" }] })), /must be linear/);
  assertUsage(() => validateSpec(frame({
    type: "linear",
    angle: 90,
    stops: [{ at: 0, color: "red" }, { at: 1, color: "#fff" }],
  })), /hex color or accent\|ink\|inkMuted\|surface\|accentInk\|background/);
});

test("a valid linear gradient paints on Frame and Box", async () => {
  const result = await composeSpec({
    type: "Frame",
    width: 32,
    height: 16,
    background: { type: "linear", angle: 90, stops: [{ at: 0, color: "#FF0000" }, { at: 1, color: "#0000FF" }] },
    children: [{
      type: "Box",
      width: 8,
      height: 8,
      background: { type: "linear", angle: 0, stops: [{ at: 0, color: "#00FF00" }, { at: 1, color: "#000000" }] },
    }],
  }, { baseDir: process.cwd() });
  assert.ok(result.png.length > 8);
  const left = await pixelAt({
    type: "Frame",
    width: 32,
    height: 8,
    background: { type: "linear", angle: 90, stops: [{ at: 0, color: "#FF0000" }, { at: 1, color: "#0000FF" }] },
  }, 0, 4);
  const right = await pixelAt({
    type: "Frame",
    width: 32,
    height: 8,
    background: { type: "linear", angle: 90, stops: [{ at: 0, color: "#FF0000" }, { at: 1, color: "#0000FF" }] },
  }, 31, 4);
  assert.ok(left[0]! > left[2]!);
  assert.ok(right[2]! > right[0]!);
});
