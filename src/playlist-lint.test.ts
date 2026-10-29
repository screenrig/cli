import assert from "node:assert/strict";
import { test } from "node:test";
import { lintPlaylistPages, type LintFinding } from "./playlist-lint.js";

function codes(findings: LintFinding[]): string[] {
  return findings.map((item) => item.code);
}

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
  // UAT round 1, F1: two consecutive full-bleed pages with different media are
  // a slideshow, not a repeat. Layout shape alone never fires the lint.
  const fullBleed = (id: string, mediaId: string, primitive = "image") => ({
    id,
    canvas: { width: 1920, height: 1080, background: "#000000FF" },
    primitives: [{
      id: "photo",
      primitive,
      selector: { by: "id", media_id: mediaId },
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      layer: 0,
      content_fit: "cover",
    }],
  });
  const slideshow = lintPlaylistPages([fullBleed("e2-image", "med_01"), fullBleed("e3-video", "med_02", "video")]);
  assert.equal(codes(slideshow).includes("adjacent_repeat"), false, JSON.stringify(slideshow));
  const repeat = lintPlaylistPages([fullBleed("one", "med_01"), fullBleed("two", "med_01")]);
  assert.ok(codes(repeat).includes("adjacent_repeat"), JSON.stringify(repeat));
  assert.match(repeat.find((finding) => finding.code === "adjacent_repeat")!.message, /same media at the same rects as one/);
});

test("playlist lint judges only geometry the document carries", () => {
  const page = (card: Record<string, unknown>) => ({
    id: "p1",
    canvas: { width: 1920, height: 1080, background: "#000000FF" },
    primitives: [
      { id: "photo", primitive: "image", selector: { by: "id", media_id: "med_01" }, rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "cover" },
      { id: "clock", primitive: "card", card: "crd_01", content_fit: "fill", ...card },
    ],
  });
  // Placed by layout, no rect in the document: nothing to judge.
  const placed = lintPlaylistPages([page({ layout: "corner", anchor: "top-left" })]);
  assert.equal(codes(placed).includes("safe_margin"), false, JSON.stringify(placed));
  assert.equal(codes(placed).includes("collision"), false, JSON.stringify(placed));
  // The same card with a rect against the edge still gets the finding.
  const edge = lintPlaylistPages([page({ layout: "free", layer: 5, rect: { x: 10, y: 10, width: 300, height: 100 } })]);
  assert.ok(codes(edge).includes("safe_margin"), JSON.stringify(edge));
  // A derived rect the document carries is judged like any other.
  const derived = lintPlaylistPages([page({ layout: "corner", anchor: "top-left", layer: 40, rect: { x: 0, y: 0, width: 270, height: 270 } })]);
  assert.ok(codes(derived).includes("safe_margin"), JSON.stringify(derived));
});
