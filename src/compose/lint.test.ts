import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { test } from "node:test";
import { composeSpec } from "./compose.js";
import {
  lintAdjacentComposePages,
  lintComposedPage,
  lintPlaylistPages,
  pixelsFromPng,
  type LintFinding,
} from "./lint.js";
import { testTemp } from "../test-temp.js";

async function lintSpec(
  spec: unknown,
  extra: { page_id?: string; viewing?: "near" | "mid" | "far"; baseDir?: string } = {},
): Promise<LintFinding[]> {
  const result = await composeSpec(spec, { baseDir: extra.baseDir ?? process.cwd() });
  const pixels = await pixelsFromPng(result.png);
  return lintComposedPage({
    page_id: extra.page_id ?? "page",
    spec,
    layout: result.layout,
    quality: result.quality,
    pixels,
    viewing: extra.viewing,
  });
}

function codes(findings: LintFinding[]): string[] {
  return findings.map((item) => item.code);
}

const CLEAN = {
  type: "Frame",
  width: 1920,
  height: 1080,
  background: "#1B2632",
  padding: "xl",
  children: [{ type: "Text", role: "title", text: "Welcome", color: "#F7F7F2" }],
};

test("visual lint stays silent on a clean page", async () => {
  const findings = await lintSpec(CLEAN);
  assert.deepEqual(findings, []);
});

test("too_small_for_distance fires for far viewing and stays silent at mid", async () => {
  const spec = {
    type: "Frame",
    width: 1920,
    height: 1080,
    background: "#1B2632",
    padding: "xl",
    children: [{
      type: "Box",
      width: 96,
      height: 48,
      children: [{ type: "Text", role: "body", text: "abcdefghijklmnopqrstuvwxyz", color: "#F7F7F2" }],
    }],
  };
  const far = await lintSpec(spec, { viewing: "far" });
  assert.ok(codes(far).includes("too_small_for_distance"), JSON.stringify(far));
  assert.ok(far.some((item) => item.id.includes("Text") || item.id.includes("children")));
  const mid = await lintSpec(CLEAN, { viewing: "mid" });
  assert.equal(codes(mid).includes("too_small_for_distance"), false);
});

test("low_contrast_rendered fires on grey-on-grey and stays silent on a clean page", async () => {
  const findings = await lintSpec({
    type: "Frame",
    width: 800,
    height: 400,
    background: "#888888",
    padding: "xl",
    children: [{ type: "Text", role: "title", text: "Hello contrast", color: "#7A7A7A" }],
  });
  assert.ok(codes(findings).includes("low_contrast_rendered"), JSON.stringify(findings));
  assert.equal(codes(await lintSpec(CLEAN)).includes("low_contrast_rendered"), false);
});

test("text_over_busy_image fires without a plate and stays silent with one", async () => {
  const cwdDir = await testTemp("lint-busy-");
  try {
    const canvas = createCanvas(640, 360);
    const ctx = canvas.getContext("2d");
    for (let y = 0; y < 360; y += 8) {
      for (let x = 0; x < 640; x += 8) {
        ctx.fillStyle = ((x / 8 + y / 8) % 2 === 0) ? "#000000" : "#FFFFFF";
        ctx.fillRect(x, y, 8, 8);
      }
    }
    await writeFile(path.join(cwdDir, "busy.png"), canvas.toBuffer("image/png"));
    const busy = await lintSpec({
      type: "Frame",
      width: 640,
      height: 360,
      children: [
        { type: "Image", src: "busy.png", width: 640, height: 360 },
        { type: "Box", pin: "top", height: 100, children: [{ type: "Text", role: "title", text: "Tonight", color: "#FFFFFF" }] },
      ],
    }, { baseDir: cwdDir });
    assert.ok(codes(busy).includes("text_over_busy_image"), JSON.stringify(busy));
    const plated = await lintSpec({
      type: "Frame",
      width: 640,
      height: 360,
      children: [
        { type: "Image", src: "busy.png", width: 640, height: 360 },
        { type: "Box", pin: "bottom", height: 140, background: "#101820E3", padding: "l", children: [{ type: "Text", role: "title", text: "Tonight", color: "#FFFFFF" }] },
      ],
    }, { baseDir: cwdDir });
    assert.equal(codes(plated).includes("text_over_busy_image"), false, JSON.stringify(plated));
    const auto = await lintSpec({
      type: "Frame",
      width: 640,
      height: 360,
      children: [
        { type: "Image", src: "busy.png", width: 640, height: 360 },
        { type: "Box", pin: "top", height: 100, children: [{ type: "Text", role: "title", text: "Tonight", color: "#FFFFFF", plate: "auto" }] },
      ],
    }, { baseDir: cwdDir });
    assert.equal(codes(auto).includes("text_over_busy_image"), false, JSON.stringify(auto));
  } finally {
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("too_dense fires over the free-form budget and stays silent on a short page", async () => {
  const words = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
  const findings = await lintSpec({
    type: "Frame",
    width: 1920,
    height: 1080,
    background: "#1B2632",
    padding: "xl",
    children: [{ type: "Text", role: "body", text: words, color: "#F7F7F2" }],
  });
  assert.ok(codes(findings).includes("too_dense"), JSON.stringify(findings));
  assert.equal(codes(await lintSpec(CLEAN)).includes("too_dense"), false);
});

test("collision fires on overlapping opaque boxes and stays silent when they do not overlap", async () => {
  const colliding = await lintSpec({
    type: "Frame",
    width: 400,
    height: 400,
    background: "#1B2632",
    children: [
      { type: "Box", pin: "top", height: 250, background: "#C0392B" },
      { type: "Box", pin: "bottom", height: 250, background: "#2471A3" },
    ],
  });
  assert.ok(codes(colliding).includes("collision"), JSON.stringify(colliding));
  const stacked = await lintSpec({
    type: "Frame",
    width: 400,
    height: 400,
    background: "#1B2632",
    padding: "l",
    gap: "l",
    children: [
      { type: "Box", height: 80, background: "#C0392B" },
      { type: "Box", height: 80, background: "#2471A3" },
    ],
  });
  assert.equal(codes(stacked).includes("collision"), false, JSON.stringify(stacked));
});

test("effects_overuse fires for two effect families and stays silent for one", async () => {
  const overuse = await lintSpec({
    type: "Frame",
    width: 1920,
    height: 1080,
    background: "#1B2632",
    padding: "xl",
    children: [{
      type: "Text",
      role: "title",
      text: "Tonight",
      color: "#FFC857",
      effects: { outline: { width: 3, color: "#000000" }, shadow: { x: 2, y: 2, blur: 4, color: "#00000080" } },
    }],
  });
  assert.ok(codes(overuse).includes("effects_overuse"), JSON.stringify(overuse));
  const one = await lintSpec({
    type: "Frame",
    width: 1920,
    height: 1080,
    background: "#1B2632",
    padding: "xl",
    children: [{
      type: "Text",
      role: "title",
      text: "Tonight",
      color: "#FFC857",
      effects: { shadow: { x: 2, y: 2, blur: 4, color: "#00000080" } },
    }],
  });
  assert.equal(codes(one).includes("effects_overuse"), false, JSON.stringify(one));
});

test("safe_margin fires for edge ink and stays silent on an inset page", async () => {
  const edge = await lintSpec({
    type: "Frame",
    width: 800,
    height: 400,
    background: "#1B2632",
    children: [{ type: "Text", role: "title", text: "Edge", color: "#F7F7F2" }],
  });
  assert.ok(codes(edge).includes("safe_margin"), JSON.stringify(edge));
  assert.equal(codes(await lintSpec(CLEAN)).includes("safe_margin"), false);
});

test("adjacent_repeat fires for the same recipe+variant and stays silent when they differ", () => {
  const repeat = lintAdjacentComposePages([
    { id: "one", spec: { recipe: "hero", variant: "a", headline: "A" } },
    { id: "two", spec: { recipe: "hero", variant: "a", headline: "B" } },
  ]);
  assert.ok(codes(repeat).includes("adjacent_repeat"));
  const mixed = lintAdjacentComposePages([
    { id: "one", spec: { recipe: "hero", variant: "a" } },
    { id: "two", spec: { recipe: "hero", variant: "b" } },
  ]);
  assert.equal(codes(mixed).includes("adjacent_repeat"), false);
});

function playlistPage(id: string, primitives: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id,
    canvas: { width: 1920, height: 1080, background: "#000000FF", viewport_fit: "contain" },
    transition: { type: "crossfade", duration_ms: 200 },
    advance: { mode: "duration", after_ms: 8000 },
    primitives,
  };
}

function imagePrimitive(id: string, rect: { x: number; y: number; width: number; height: number }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    primitive: "image",
    selector: { by: "id", media_id: "med_example" },
    rect,
    layer: 0,
    content_fit: "contain",
    ...extra,
  };
}

test("playlist collision, motion_overuse, adjacent_repeat, and safe_margin each fire and stay silent on a clean page", () => {
  const clean = playlistPage("clean", [{
    id: "web",
    primitive: "iframe",
    src: "https://example.com/",
    title: "Example",
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
    layer: 0,
    content_fit: "fill",
  }]);
  assert.deepEqual(lintPlaylistPages([clean]), []);

  const colliding = playlistPage("hit", [
    imagePrimitive("left", { x: 0, y: 0, width: 1200, height: 1080 }),
    imagePrimitive("right", { x: 800, y: 0, width: 1120, height: 1080 }, { layer: 1 }),
  ]);
  assert.ok(codes(lintPlaylistPages([colliding])).includes("collision"));

  const motion = playlistPage("spin", [
    imagePrimitive("bg", { x: 0, y: 0, width: 1920, height: 1080 }, { motion: { type: "path", points: [{ x: -40, y: 0 }], rate: 40 } }),
    imagePrimitive("badge", { x: 1640, y: 80, width: 200, height: 200 }, { layer: 1, motion: { type: "spin", direction: "cw", speed: "slow" } }),
  ]);
  assert.ok(codes(lintPlaylistPages([motion])).includes("motion_overuse"));

  const enters = playlistPage("enter", [
    imagePrimitive("a", { x: 40, y: 40, width: 400, height: 200 }, { enter: { type: "fade-in" } }),
    imagePrimitive("b", { x: 500, y: 40, width: 400, height: 200 }, { layer: 1, enter: { type: "fade-up" } }),
    imagePrimitive("c", { x: 960, y: 40, width: 400, height: 200 }, { layer: 2, enter: { type: "fade-left" } }),
  ]);
  assert.ok(codes(lintPlaylistPages([enters])).includes("motion_overuse"));

  const edge = playlistPage("edge", [
    imagePrimitive("logo", { x: 0, y: 40, width: 200, height: 80 }),
  ]);
  assert.ok(codes(lintPlaylistPages([edge])).includes("safe_margin"));

  const repeat = lintPlaylistPages([
    playlistPage("one", [imagePrimitive("a", { x: 100, y: 100, width: 400, height: 300 })]),
    playlistPage("two", [imagePrimitive("b", { x: 100, y: 100, width: 400, height: 300 })]),
  ]);
  assert.ok(codes(repeat).includes("adjacent_repeat"));
  assert.equal(repeat[0]?.page_id, "two");
});
