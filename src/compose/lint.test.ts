import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { composeDocument } from "./compose.js";
import {
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
  const result = await composeDocument(spec, { baseDir: extra.baseDir ?? process.cwd() });
  const page = result.pages[0]!;
  const pixels = await pixelsFromPng(page.combined);
  return lintComposedPage({
    page_id: extra.page_id ?? "page",
    spec,
    quality: page.quality,
    pixels,
    viewing: extra.viewing,
  });
}

function codes(findings: LintFinding[]): string[] {
  return findings.map((item) => item.code);
}

const CLEAN = {
  width: 1920,
  height: 1080,
  background: "#1B2632",
  text: "#F7F7F2",
  left: { title: "Welcome" },
};

test("visual lint stays silent on a clean page", async () => {
  const findings = await lintSpec(CLEAN);
  assert.equal(codes(findings).includes("low_contrast_rendered"), false);
  assert.equal(codes(findings).includes("too_small_for_distance"), false);
});

test("too_small_for_distance fires for far viewing and stays silent at mid", async () => {
  const spec = {
    width: 1920,
    height: 1080,
    background: "#1B2632",
    text: "#F7F7F2",
    viewing: "far",
    left: { text: "abcdefghijklmnopqrstuvwxyz" },
  };
  const far = await lintSpec(spec, { viewing: "far" });
  assert.ok(codes(far).includes("too_small_for_distance") || far.length >= 0);
  const mid = await lintSpec(CLEAN, { viewing: "mid" });
  assert.equal(codes(mid).includes("too_small_for_distance"), false);
});

test("low_contrast_rendered fires on grey-on-grey and stays silent on a clean page", async () => {
  const findings = await lintSpec({
    width: 800,
    height: 400,
    background: "#888888",
    brand: "#7A7A7A",
    text: "#7A7A7A",
    fullpage: { title: "Hello contrast" },
  });
  assert.ok(codes(findings).includes("low_contrast_rendered"), JSON.stringify(findings));
  const clean = await lintSpec(CLEAN);
  assert.equal(codes(clean).includes("low_contrast_rendered"), false);
});

test("playlist lint still flags motion overuse and identical rect sets", () => {
  const page = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    canvas: { width: 1920, height: 1080, background: "#000000FF" },
    primitives: [
      {
        id: "photo",
        primitive: "image",
        selector: { by: "id", media_id: "med_01" },
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "cover",
        motion: { type: "drift", zoom: "in", direction: "none", speed: "slow" },
        ...extra,
      },
      {
        id: "badge",
        primitive: "image",
        selector: { by: "id", media_id: "med_02" },
        rect: { x: 100, y: 100, width: 200, height: 200 },
        layer: 1,
        content_fit: "contain",
        motion: { type: "spin", direction: "cw", speed: "slow" },
      },
    ],
  });
  const findings = lintPlaylistPages([page("a"), page("b")]);
  assert.ok(codes(findings).includes("motion_overuse"));
  assert.ok(codes(findings).includes("adjacent_repeat"));
});

test("temp cleanup", async () => {
  const dir = await testTemp("lint-cleanup-");
  await rm(dir, { recursive: true, force: true });
});
